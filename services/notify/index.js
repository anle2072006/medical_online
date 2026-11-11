'use strict';
// Notification (notify_db, MongoDB): nghe moi su kien, tao thong bao trong ung dung + gui email (co retry), nhac lich 24h va 1h.
const C = require('../../common');
const { uid, nowIso, sleep, localDate, wrap, auth, log } = C;

let users, notifications, reminders;
const EMAIL_FAIL = Number(process.env.EMAIL_FAIL_RATE || 0);
const money = (n) => Number(n).toLocaleString('vi-VN') + ' đ';
const REASON = { LICENSE_INVALID: 'số giấy phép không hợp lệ', LICENSE_EXPIRED: 'giấy phép đã hết hạn', LICENSE_REVOKED: 'giấy phép đã bị thu hồi', ABSENCE: 'vắng mặt 3 buổi hẹn trong 30 ngày', CLOSED_BY_DOCTOR: 'bác sĩ đã đóng tài khoản' };

async function sendEmail(n) { // gia lap SMTP; loi thi retry toi da 3 lan roi bo
  const u = await users.get({ id: n.user_id });
  if (!u) return notifications.set({ id: n.id }, { status: 'SKIPPED' });
  for (let i = 1; i <= 3; i++) {
    if (Math.random() >= EMAIL_FAIL) { await notifications.set({ id: n.id }, { status: 'SENT', retry_count: i - 1 }); log('notify', `EMAIL -> ${u.email}: ${n.title}`); return; }
    await notifications.set({ id: n.id }, { retry_count: i }); await sleep(300 * i);
  }
  await notifications.set({ id: n.id }, { status: 'FAILED' });
}
async function push(userId, type, title, body) {
  if (!userId) return;
  const id = uid();
  await notifications.insert({ id, user_id: userId, event_type: type, title, body, channel: 'email', status: 'PENDING', retry_count: 0, read: false, created_at: nowIso() });
  sendEmail({ id, user_id: userId, title }).catch(() => {});
}
const when = (d) => `${d.start} ngày ${d.date.split('-').reverse().join('/')}`;

async function main() {
  const db = await C.openDb('notify', {
    users: [[{ id: 1 }, { unique: true }]],
    notifications: [[{ id: 1 }, { unique: true }], [{ user_id: 1, created_at: -1 }]],
    reminders: [[{ appointment_id: 1 }, { unique: true }], [{ active: 1 }]],
  });
  users = db.col('users'); notifications = db.col('notifications'); reminders = db.col('reminders');
  const bus = await C.connectBus('notify');
  const app = C.createApp('notify');
  const on = (t, fn) => bus.on(t, async (d) => fn(d));

  on('user.registered', async (d) => { await users.upsert({ id: d.userId }, { email: d.email, full_name: d.fullName }); if (d.role === 'patient') await push(d.userId, 'user.registered', 'Chào mừng đến SINA Clinic', 'Tài khoản của bạn đã sẵn sàng. Hãy tìm bác sĩ và đặt lịch khám đầu tiên.'); });
  on('doctor.registered', (d) => push(d.doctorId, 'doctor.registered', 'Đang xác thực giấy phép', 'Hồ sơ của bạn đang được xác thực. Bạn sẽ nhận thông báo ngay khi có kết quả.'));
  on('doctor.verified', (d) => push(d.doctorId, 'doctor.verified', 'Hồ sơ đã được xác thực', 'Bạn có thể đăng ký ca làm việc để bệnh nhân bắt đầu đặt lịch.'));
  on('doctor.rejected', (d) => push(d.doctorId, 'doctor.rejected', 'Hồ sơ chưa được xác thực', `Lý do: ${REASON[d.reason] || d.reason}. Bạn có thể nộp lại tối đa 3 lần.`));
  on('doctor.suspended', (d) => push(d.doctorId, 'doctor.suspended', 'Hồ sơ bị tạm khóa', `Lý do: ${REASON[d.reason] || d.reason}. Slot trống bị khóa và các lịch sắp tới được hủy, hoàn tiền cho bệnh nhân.`));
  on('doctor.reactivated', (d) => push(d.doctorId, 'doctor.reactivated', 'Hồ sơ hoạt động trở lại', 'Bạn có thể tiếp tục nhận lịch khám.'));
  on('doctor.deactivated', (d) => push(d.doctorId, 'doctor.deactivated', 'Tài khoản đã đóng', `Lý do: ${REASON[d.reason] || d.reason}.`));
  on('leave.approved', (d) => push(d.doctorId, 'leave.approved', 'Đã duyệt kỳ nghỉ', `Nghỉ từ ${d.fromDate} đến ${d.toDate}. Các lịch đã đặt trong thời gian này sẽ được hủy và hoàn tiền 100%.`));
  on('appointment.confirmed', async (d) => {
    await push(d.patientId, 'appointment.confirmed', 'Đặt lịch thành công', `Lịch khám với ${d.doctorName} lúc ${when(d)} đã được xác nhận.`);
    await push(d.doctorId, 'appointment.confirmed', 'Có lịch hẹn mới', `${d.patientName} đặt khám lúc ${when(d)}.`);
    await reminders.upsert({ appointment_id: d.appointmentId }, { patient_id: d.patientId, doctor_id: d.doctorId, doctor_name: d.doctorName, date: d.date, start: d.start, sent24: false, sent1: false, active: true });
  });
  on('appointment.rescheduled', async (d) => {
    await push(d.patientId, 'appointment.rescheduled', 'Đã đổi lịch khám', `Lịch với ${d.doctorName} chuyển sang ${when(d)}.`);
    await push(d.doctorId, 'appointment.rescheduled', 'Bệnh nhân đổi lịch', `${d.patientName} chuyển sang ${when(d)}.`);
    await reminders.set({ appointment_id: d.appointmentId }, { date: d.date, start: d.start, sent24: false, sent1: false });
  });
  on('appointment.cancelled', async (d) => {
    await reminders.set({ appointment_id: d.appointmentId }, { active: false });
    if (d.cancelledBy === 'DOCTOR') await push(d.patientId, 'appointment.cancelled', 'Lịch khám bị hủy', `Rất tiếc, lịch với ${d.doctorName} lúc ${when(d)} bị hủy do bác sĩ không thể có mặt.${d.paid ? ' Bạn sẽ được hoàn tiền 100%. Hãy đặt lại với bác sĩ cùng chuyên khoa còn trống lịch.' : ''}`);
    else {
      await push(d.patientId, 'appointment.cancelled', 'Đã hủy lịch khám', `Lịch với ${d.doctorName} lúc ${when(d)} đã hủy.${d.paid ? (d.refundPercent > 0 ? ` Bạn được hoàn ${d.refundPercent}% phí khám.` : ' Hủy trong 2 giờ cuối nên không được hoàn phí.') : ''}`);
      if (d.cancelledBy === 'PATIENT') await push(d.doctorId, 'appointment.cancelled', 'Bệnh nhân hủy lịch', `${d.patientName} đã hủy lịch lúc ${when(d)}.`);
    }
  });
  on('payment.failed', (d) => push(d.patientId, 'payment.failed', 'Thanh toán chưa thành công', 'Bạn có thể thử thanh toán lại trong thời gian giữ chỗ.'));
  on('appointment.failed', (d) => push(d.patientId, 'appointment.failed', 'Giữ chỗ đã hết hạn', 'Khung giờ đã được trả lại. Hãy đặt lại nếu bạn vẫn muốn khám.'));
  on('refund.completed', (d) => d.amount > 0 && push(d.patientId, 'refund.completed', 'Đã hoàn tiền', `Hoàn ${money(d.amount)} (${d.percent}%) về phương thức thanh toán của bạn.`));
  on('consultation.completed', (d) => push(d.patientId, 'consultation.completed', 'Buổi khám đã hoàn tất', d.hasPrescription ? 'Bệnh án và đơn thuốc đã có trong mục Bệnh án và đơn thuốc.' : 'Bệnh án đã có trong mục Bệnh án và đơn thuốc.'));
  on('prescription.issued', (d) => push(d.patientId, 'prescription.issued', 'Đơn thuốc đã được kê', `Mã đơn ${d.code}: ${(d.items || []).join(', ')}. Hãy mang mã đơn này đến cơ sở bán thuốc gần nhất để nhận thuốc.`));
  on('patient.no_show', (d) => push(d.patientId, 'patient.no_show', 'Bạn đã vắng buổi khám', 'Lịch hẹn được đóng và không hoàn phí theo chính sách.'));
  on('doctor.absent', (d) => push(d.patientId, 'doctor.absent', 'Bác sĩ vắng mặt', 'Bạn được hoàn tiền 100%. Xin lỗi vì sự bất tiện này.'));
  await bus.start();

  app.get('/notifications/mine', auth(), wrap(async (req, res) => {
    const items = await notifications.all({ user_id: req.user.id }, { sort: { created_at: -1 }, limit: 50 });
    res.json({ unread: await notifications.count({ user_id: req.user.id, read: false }), items: items.map((n) => ({ id: n.id, type: n.event_type, title: n.title, body: n.body, status: n.status, retryCount: n.retry_count, read: n.read, createdAt: n.created_at })) });
  }));
  app.post('/notifications/read-all', auth(), wrap(async (req, res) => { await notifications.updateMany({ user_id: req.user.id }, { $set: { read: true } }); res.json({ ok: true }); }));

  setInterval(async () => { // nhac lich truoc 24 gio va 1 gio
    try {
      for (const r of await reminders.all({ active: true })) {
        const diff = localDate(r.date, r.start) - Date.now();
        if (diff < 0) { await reminders.set({ appointment_id: r.appointment_id }, { active: false }); continue; }
        if (!r.sent1 && diff <= 36e5) { await reminders.set({ appointment_id: r.appointment_id }, { sent1: true, sent24: true }); await push(r.patient_id, 'reminder', 'Sắp đến giờ khám', `Còn khoảng 1 giờ nữa đến lịch khám với ${r.doctor_name}.`); await push(r.doctor_id, 'reminder', 'Sắp đến giờ khám', 'Còn khoảng 1 giờ nữa đến buổi khám.'); }
        else if (!r.sent24 && diff <= 864e5) { await reminders.set({ appointment_id: r.appointment_id }, { sent24: true }); await push(r.patient_id, 'reminder', 'Nhắc lịch khám ngày mai', `Bạn có lịch khám với ${r.doctor_name} lúc ${when(r)}.`); }
      }
    } catch (e) { log('notify', 'job nhac lich loi:', e.message); }
  }, 30000);
  C.finish(app, 'notify', 3006);
}
main().catch((e) => { console.error(e); process.exit(1); });
