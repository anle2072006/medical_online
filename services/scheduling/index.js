'use strict';
// Scheduling (scheduling_db, MongoDB): tu duyet ca lam viec, sinh slot, nghi phep, dat/huy/doi lich, FSM lich hen.
// Khong dung giao dich da tai lieu: moi buoc la mot cap nhat nguyen tu tren mot document (claim/optimistic lock).
const C = require('../../common');
const { CONFIG, uid, nowIso, ymd, addDays, toMin, fromMin, localDate, HttpError, wrap, auth, internalOnly, log } = C;

let bus, doctorsCache, shifts, leaves, slots, appts, apptLog;
const SLOT_OPTIONS = [15, 20, 30, 45];
const ACTIVE_APPT = ['pending', 'confirmed', 'in_progress', 'failed', 'rescheduled'];

// ---------- FSM lich hen: chuyen trang thai nguyen tu, tra ve ban ghi truoc khi doi (null neu khong hop le) ----------
async function transition(id, from, to, reason, patch = {}, inc) {
  const upd = { $set: { status: to, ...patch } }; if (inc) upd.$inc = inc;
  const before = await appts.claim({ id, status: { $in: from } }, upd);
  if (!before) return null;
  await apptLog.insert({ appointment_id: id, from_status: before.status, to_status: to, reason: reason || null, at: nowIso() });
  return before;
}
const apptEvent = (a, extra = {}) => ({ appointmentId: a.id, slotId: a.slot_id, patientId: a.patient_id, patientName: a.patient_name, doctorId: a.doctor_id, doctorName: a.doctor_name, date: a.date, start: a.start, fee: a.fee, ...extra });
const apptView = (a) => ({ id: a.id, status: a.status, date: a.date, start: a.start, doctorId: a.doctor_id, doctorName: a.doctor_name, specialty: a.specialty, patientId: a.patient_id, patientName: a.patient_name, fee: a.fee, expiresAt: a.expires_at, retryCount: a.retry_count, cancelledBy: a.cancelled_by || null, refundPercent: a.refund_percent ?? null, visitType: 'ONLINE' });
const slotView = (s) => ({ id: s.id, date: s.date, start: s.start, endTime: s.end_time, fee: s.fee, version: s.version });
const refundPercentFor = (a) => { const h = (localDate(a.date, a.start) - Date.now()) / 36e5; return h >= 24 ? 100 : h >= 2 ? 50 : 0; };
const releaseSlot = (slotId, to = 'AVAILABLE', reason = null) => slots.update({ id: slotId }, { $set: { status: to, block_reason: reason, hold_appt: null }, $inc: { version: 1 } });
const upcomingFilter = (today, nowT) => ({ $or: [{ date: { $gt: today } }, { date: today, start: { $gt: nowT } }] });

// ---------- Sinh slot ----------
const approvedLeaves = (doctorId) => leaves.all({ doctor_id: doctorId, status: { $in: ['APPROVED', 'ACTIVE'] } });
async function generateForShift(s) {
  const doc = await doctorsCache.get({ id: s.doctor_id });
  if (!doc || !['active', 'on_leave'].includes(doc.status)) return 0;
  const lv = await approvedLeaves(s.doctor_id);
  const today = new Date(); const nowMin = today.getHours() * 60 + today.getMinutes(); let n = 0;
  for (let i = 0; i <= 30; i++) {
    const day = addDays(today, i); const date = ymd(day);
    if (date < s.start_date || day.getDay() !== s.weekday) continue;
    if (lv.some((l) => date >= l.from_date && date <= l.to_date)) continue;
    for (let t = toMin(s.start_time); t + s.slot_minutes <= toMin(s.end_time); t += s.slot_minutes) {
      if (i === 0 && t <= nowMin) continue;
      if (await slots.insertIgnore({ id: uid(), doctor_id: s.doctor_id, shift_id: s.id, date, start: fromMin(t), end_time: fromMin(t + s.slot_minutes), fee: s.fee, status: 'AVAILABLE', version: 0, block_reason: null, hold_appt: null })) n++;
    }
  }
  return n;
}
const generateAll = async () => { for (const s of await shifts.all({ status: 'APPROVED' })) await generateForShift(s); };

// ---------- Luat tu duyet ca (dung 5 luat, khong co admin) ----------
// Thu tu kiem tra: DOCTOR_NOT_VERIFIED, OUT_OF_HOURS, SHIFT_OVERLAP, OVER_LIMIT, TOO_LATE.
function firstOccurrence(b) { // lan dien ra dau tien cua ca (ngay >= startDate, dung thu trong tuan)
  const d = new Date(`${b.startDate}T00:00:00`);
  while (d.getDay() !== b.weekday) d.setDate(d.getDate() + 1);
  return localDate(ymd(d), b.startTime);
}
async function checkShiftRules(doctorId, b) {
  const doc = await doctorsCache.get({ id: doctorId });
  if (!doc || doc.status !== 'active') return 'DOCTOR_NOT_VERIFIED';
  if (b.startTime < '07:00' || b.endTime > '20:00' || b.startTime >= b.endTime) return 'OUT_OF_HOURS';
  const same = await shifts.all({ doctor_id: doctorId, weekday: b.weekday, status: 'APPROVED' });
  if (same.some((s) => b.startTime < s.end_time && s.start_time < b.endTime)) return 'SHIFT_OVERLAP';
  const total = same.reduce((m, s) => m + toMin(s.end_time) - toMin(s.start_time), 0) + toMin(b.endTime) - toMin(b.startTime);
  if (total > 480) return 'OVER_LIMIT';
  if (firstOccurrence(b) - Date.now() < 24 * 36e5) return 'TOO_LATE';
  return null;
}
const REJECT_TEXT = {
  DOCTOR_NOT_VERIFIED: 'Hồ sơ bác sĩ chưa được xác thực hoặc giấy phép không còn hiệu lực.', OUT_OF_HOURS: 'Ca nằm ngoài giờ hoạt động 07:00 đến 20:00.',
  SHIFT_OVERLAP: 'Ca bị trùng với ca đã đăng ký cùng thứ.', OVER_LIMIT: 'Tổng thời gian làm việc vượt 8 giờ trong một ngày.',
  TOO_LATE: 'Cần đăng ký ca trước ít nhất 24 giờ so với lần diễn ra đầu tiên.',
};

// ---------- Huy lich (dung chung cho benh nhan, bac si nghi, bac si bi khoa) ----------
async function cancelAppointment(id, { by, reason, refundPercent, slotAfter = 'AVAILABLE', slotReason = null }) {
  const a = await appts.get({ id });
  if (!a) return null;
  const paidGuess = ['confirmed', 'rescheduled'].includes(a.status);
  const before = await transition(id, ['pending', 'failed', 'confirmed', 'rescheduled'], 'cancelled', reason, { cancelled_by: by, refund_percent: paidGuess ? refundPercent : 0 });
  if (!before) return null; // da duoc xu ly (su kien den lap)
  const paid = ['confirmed', 'rescheduled'].includes(before.status);
  const s = await slots.get({ id: a.slot_id });
  if (s && s.hold_appt === id) await releaseSlot(a.slot_id, slotAfter, slotReason);
  bus.publish('appointment.cancelled', apptEvent(a, { cancelledBy: by, reason, refundPercent: paid ? refundPercent : 0, paid }));
  if (paid && refundPercent > 0) { await transition(id, ['cancelled'], 'refunding', 'REFUND_REQUESTED'); bus.publish('refund.requested', { appointmentId: id, percent: refundPercent, reason }); }
  return a;
}
async function failFinal(a, reason) {
  const rel = await slots.claim({ id: a.slot_id, hold_appt: a.id, status: 'HELD' }, { $set: { status: 'AVAILABLE', hold_appt: null, block_reason: null }, $inc: { version: 1 } });
  await appts.update({ id: a.id, status: { $in: ['pending', 'failed'] } }, { $set: { released: true } });
  if (!rel) return;
  await transition(a.id, ['pending', 'failed'], 'failed', reason);
  bus.publish('appointment.failed', { appointmentId: a.id, patientId: a.patient_id, reason });
}
async function blockFutureSlots(doctorId, reason, fromDate, toDate = '9999-12-31') {
  await slots.updateMany({ doctor_id: doctorId, status: 'AVAILABLE', date: { $gte: fromDate, $lte: toDate } }, { $set: { status: 'BLOCKED', block_reason: reason }, $inc: { version: 1 } });
  const list = await appts.all({ doctor_id: doctorId, status: { $in: ['pending', 'failed', 'confirmed'] }, date: { $gte: fromDate, $lte: toDate } });
  for (const a of list) await cancelAppointment(a.id, { by: 'DOCTOR', reason, refundPercent: 100, slotAfter: 'BLOCKED', slotReason: reason });
}

async function main() {
  const db = await C.openDb('scheduling', {
    doctors_cache: [[{ id: 1 }, { unique: true }]],
    shifts: [[{ id: 1 }, { unique: true }], [{ doctor_id: 1, status: 1 }]],
    leaves: [[{ id: 1 }, { unique: true }], [{ doctor_id: 1 }]],
    slots: [[{ id: 1 }, { unique: true }], [{ doctor_id: 1, date: 1, start: 1 }, { unique: true }], [{ doctor_id: 1, status: 1, date: 1 }], [{ shift_id: 1 }]],
    appointments: [[{ id: 1 }, { unique: true }], [{ patient_id: 1 }], [{ doctor_id: 1 }], [{ status: 1, expires_at: 1 }]],
    appointment_log: [[{ appointment_id: 1 }]],
  });
  doctorsCache = db.col('doctors_cache'); shifts = db.col('shifts'); leaves = db.col('leaves'); slots = db.col('slots'); appts = db.col('appointments'); apptLog = db.col('appointment_log');
  bus = await C.connectBus('scheduling');
  const app = C.createApp('scheduling');

  // ----- Tim bac si & slot -----
  app.get('/doctors', auth(), wrap(async (req, res) => {
    const today = ymd(new Date()); const nowT = fromMin(new Date().getHours() * 60 + new Date().getMinutes());
    const docs = (await doctorsCache.all({ status: 'active' })).filter((d) => !req.query.specialty || d.specialty === req.query.specialty);
    res.json(await Promise.all(docs.map(async (d) => {
      const f = { doctor_id: d.id, status: 'AVAILABLE', ...upcomingFilter(today, nowT) };
      const nx = await slots.get(f, { sort: { date: 1, start: 1 } });
      return { id: d.id, fullName: d.full_name, specialty: d.specialty, nextSlot: nx ? { date: nx.date, start: nx.start } : null, fee: nx ? nx.fee : null, availableCount: nx ? await slots.count(f) : 0 };
    })));
  }));
  app.get('/doctors/me/work-state', auth('doctor'), wrap(async (req, res) => {
    if (await appts.get({ doctor_id: req.user.id, status: 'in_progress' })) return res.json({ state: 'IN_CONSULTATION' });
    const now = new Date(); const m = fromMin(now.getHours() * 60 + now.getMinutes());
    const onShift = await shifts.get({ doctor_id: req.user.id, status: 'APPROVED', weekday: now.getDay(), start_time: { $lte: m }, end_time: { $gt: m } });
    const onLeave = (await approvedLeaves(req.user.id)).some((l) => ymd(now) >= l.from_date && ymd(now) <= l.to_date);
    res.json({ state: onShift && !onLeave ? 'AVAILABLE' : 'OFF_DUTY' });
  }));
  app.get('/doctors/:id/slots', auth(), wrap(async (req, res) => {
    const today = ymd(new Date()); const nowT = fromMin(new Date().getHours() * 60 + new Date().getMinutes());
    res.json((await slots.all({ doctor_id: req.params.id, status: 'AVAILABLE', ...upcomingFilter(today, nowT) }, { sort: { date: 1, start: 1 } })).map(slotView));
  }));

  // ----- Ca lam viec (tu duyet) -----
  app.post('/shifts', auth('doctor'), wrap(async (req, res) => {
    const b = req.body || {};
    b.weekday = Number(b.weekday); b.slotMinutes = Number(b.slotMinutes); b.fee = Number(b.fee);
    if (!(b.weekday >= 0 && b.weekday <= 6) || !/^\d\d:\d\d$/.test(b.startTime || '') || !/^\d\d:\d\d$/.test(b.endTime || '') || !SLOT_OPTIONS.includes(b.slotMinutes) || !/^\d{4}-\d\d-\d\d$/.test(b.startDate || '') || !Number.isFinite(b.fee) || b.fee <= 0 || b.fee > 10000000)
      throw new HttpError(400, 'INVALID_SHIFT', 'Thông tin ca chưa hợp lệ.');
    const id = uid();
    await shifts.insert({ id, doctor_id: req.user.id, weekday: b.weekday, start_time: b.startTime, end_time: b.endTime, slot_minutes: b.slotMinutes, fee: b.fee, start_date: b.startDate, status: 'SUBMITTED', reject_code: null, created_at: nowIso() });
    const code = await checkShiftRules(req.user.id, b);
    if (code) { await shifts.set({ id }, { status: 'REJECTED', reject_code: code }); return res.status(201).json({ id, status: 'REJECTED', rejectCode: code, message: REJECT_TEXT[code] }); }
    await shifts.set({ id }, { status: 'APPROVED' });
    bus.publish('shift.approved', { shiftId: id, doctorId: req.user.id });
    res.status(201).json({ id, status: 'APPROVED' });
  }));
  app.get('/shifts/mine', auth('doctor'), wrap(async (req, res) => res.json((await shifts.all({ doctor_id: req.user.id }, { sort: { created_at: -1 } })).map((s) => ({ id: s.id, weekday: s.weekday, startTime: s.start_time, endTime: s.end_time, slotMinutes: s.slot_minutes, fee: s.fee, startDate: s.start_date, status: s.status, rejectCode: s.reject_code, message: REJECT_TEXT[s.reject_code] || null })))));
  app.delete('/shifts/:id', auth('doctor'), wrap(async (req, res) => {
    const s = await shifts.get({ id: req.params.id, doctor_id: req.user.id, status: 'APPROVED' });
    if (!s) throw new HttpError(404, 'NOT_FOUND', 'Không tìm thấy ca đang áp dụng.');
    if (await slots.get({ shift_id: s.id, status: { $in: ['HELD', 'BOOKED'] } })) throw new HttpError(409, 'HAS_BOOKINGS', 'Ca đã có lịch hẹn. Hãy dùng chức năng xin nghỉ phép để hủy và hoàn tiền cho bệnh nhân.');
    await slots.del({ shift_id: s.id, status: 'AVAILABLE' });
    await shifts.set({ id: s.id }, { status: 'CANCELLED' });
    res.json({ ok: true });
  }));

  // ----- Nghi phep -----
  app.post('/leaves', auth('doctor'), wrap(async (req, res) => {
    const { fromDate, toDate } = req.body || {};
    if (!/^\d{4}-\d\d-\d\d$/.test(fromDate || '') || !/^\d{4}-\d\d-\d\d$/.test(toDate || '') || fromDate > toDate || fromDate < ymd(new Date())) throw new HttpError(400, 'INVALID_LEAVE', 'Khoảng ngày nghỉ chưa hợp lệ.');
    if ((await approvedLeaves(req.user.id)).some((l) => fromDate <= l.to_date && l.from_date <= toDate)) throw new HttpError(409, 'LEAVE_OVERLAP', 'Bị trùng với kỳ nghỉ đã đăng ký.');
    const doc = await doctorsCache.get({ id: req.user.id });
    if (!doc || doc.status !== 'active') throw new HttpError(403, 'DOCTOR_NOT_VERIFIED', 'Hồ sơ bác sĩ chưa được xác thực.');
    const id = uid();
    await leaves.insert({ id, doctor_id: req.user.id, from_date: fromDate, to_date: toDate, status: 'APPROVED', created_at: nowIso() });
    bus.publish('leave.approved', { leaveId: id, doctorId: req.user.id, fromDate, toDate });
    res.status(201).json({ id, status: 'APPROVED' });
  }));
  app.get('/leaves/mine', auth('doctor'), wrap(async (req, res) => res.json((await leaves.all({ doctor_id: req.user.id }, { sort: { from_date: -1 } })).map((l) => ({ id: l.id, fromDate: l.from_date, toDate: l.to_date, status: l.status })))));

  // ----- Dat lich -----
  app.post('/appointments', auth('patient'), wrap(async (req, res) => {
    const slot = await slots.get({ id: (req.body || {}).slotId });
    if (!slot) throw new HttpError(404, 'SLOT_NOT_FOUND', 'Không tìm thấy khung giờ này.');
    const startAt = localDate(slot.date, slot.start);
    if (startAt - Date.now() < CONFIG.leadMinutes * 6e4 || startAt < Date.now()) throw new HttpError(409, 'TOO_SOON', 'Khung giờ này đã quá gần. Hãy chọn khung giờ khác.');
    if (startAt - Date.now() > 30 * 864e5) throw new HttpError(409, 'TOO_FAR', 'Chỉ đặt trước tối đa 30 ngày.');
    if (await appts.get({ patient_id: req.user.id, date: slot.date, start: slot.start, status: { $in: ACTIVE_APPT } })) throw new HttpError(409, 'PATIENT_CLASH', 'Bạn đã có lịch khác vào đúng giờ này.');
    const doc = await doctorsCache.get({ id: slot.doctor_id });
    const id = uid(); const expires = new Date(Date.now() + CONFIG.holdMinutes * 6e4).toISOString();
    // Optimistic locking: chi giu cho khi slot con AVAILABLE dung version da doc. Nguoi den sau khong khop dieu kien nen bi tu choi.
    if (!(await slots.update({ id: slot.id, status: 'AVAILABLE', version: slot.version }, { $set: { status: 'HELD', hold_appt: id }, $inc: { version: 1 } }))) throw new HttpError(409, 'SLOT_TAKEN', 'Khung giờ này vừa có người đặt. Vui lòng chọn khung giờ khác.');
    const appt = { id, slot_id: slot.id, patient_id: req.user.id, patient_name: req.user.name, doctor_id: slot.doctor_id, doctor_name: doc.full_name, specialty: doc.specialty, date: slot.date, start: slot.start, fee: slot.fee, status: 'pending', expires_at: expires, retry_count: 0, cancelled_by: null, refund_percent: null, released: false, created_at: nowIso() };
    try { await appts.insert(appt); await apptLog.insert({ appointment_id: id, from_status: 'start', to_status: 'pending', reason: 'SLOT_HELD', at: nowIso() }); }
    catch (e) { await releaseSlot(slot.id); throw e; } // buoc bu tru: tra slot neu khong tao duoc lich
    bus.publish('appointment.requested', apptEvent(appt, { amount: appt.fee }));
    res.status(201).json(apptView(appt));
  }));

  app.get('/appointments/mine', auth(), wrap(async (req, res) => {
    const col = req.user.role === 'doctor' ? 'doctor_id' : 'patient_id';
    res.json((await appts.all({ [col]: req.user.id }, { sort: { date: -1, start: -1 } })).map(apptView));
  }));
  app.get('/appointments/:id', auth(), wrap(async (req, res) => {
    const a = await appts.get({ id: req.params.id });
    if (!a || (a.patient_id !== req.user.id && a.doctor_id !== req.user.id)) throw new HttpError(404, 'NOT_FOUND', 'Không tìm thấy lịch hẹn.');
    const logs = await apptLog.all({ appointment_id: a.id }, { sort: { _id: 1 } });
    res.json({ ...apptView(a), refundPercentIfCancelled: refundPercentFor(a), log: logs.map(({ from_status, to_status, reason, at }) => ({ from_status, to_status, reason, at })) });
  }));

  app.post('/appointments/:id/cancel', auth('patient'), wrap(async (req, res) => {
    const a = await appts.get({ id: req.params.id, patient_id: req.user.id });
    if (!a) throw new HttpError(404, 'NOT_FOUND', 'Không tìm thấy lịch hẹn.');
    if (!['pending', 'failed', 'confirmed'].includes(a.status)) throw new HttpError(409, 'CANNOT_CANCEL', 'Lịch hẹn ở trạng thái này không thể hủy.');
    const pct = refundPercentFor(a);
    await cancelAppointment(a.id, { by: 'PATIENT', reason: 'PATIENT_CANCELLED', refundPercent: pct });
    res.json({ ok: true, refundPercent: a.status === 'confirmed' ? pct : 0 });
  }));

  app.post('/appointments/:id/retry-payment', auth('patient'), wrap(async (req, res) => {
    const a = await appts.get({ id: req.params.id, patient_id: req.user.id });
    if (!a) throw new HttpError(404, 'NOT_FOUND');
    const held = await slots.get({ id: a.slot_id, hold_appt: a.id, status: 'HELD' });
    if (a.status !== 'failed' || a.retry_count >= 3 || a.expires_at < nowIso() || !held) throw new HttpError(409, 'CANNOT_RETRY', 'Không thể thử thanh toán lại: đã hết lượt hoặc hết thời gian giữ chỗ.');
    if (!(await transition(a.id, ['failed'], 'pending', 'PAYMENT_RETRY'))) throw new HttpError(409, 'CANNOT_RETRY', 'Lịch hẹn đã thay đổi trạng thái.');
    bus.publish('payment.retry_requested', { appointmentId: a.id });
    res.json({ ok: true });
  }));

  // Doi lich: giu slot moi truoc, thanh cong moi nha slot cu.
  app.post('/appointments/:id/reschedule', auth('patient'), wrap(async (req, res) => {
    const a = await appts.get({ id: req.params.id, patient_id: req.user.id });
    if (!a) throw new HttpError(404, 'NOT_FOUND');
    if (a.status !== 'confirmed') throw new HttpError(409, 'CANNOT_RESCHEDULE', 'Chỉ đổi được lịch đã xác nhận.');
    const ns = await slots.get({ id: (req.body || {}).slotId });
    if (!ns || ns.doctor_id !== a.doctor_id) throw new HttpError(404, 'SLOT_NOT_FOUND', 'Khung giờ mới phải thuộc cùng bác sĩ.');
    const at = localDate(ns.date, ns.start);
    if (at - Date.now() < CONFIG.leadMinutes * 6e4 || at < Date.now()) throw new HttpError(409, 'TOO_SOON', 'Khung giờ mới đã quá gần.');
    const old = { date: a.date, start: a.start };
    if (!(await slots.update({ id: ns.id, status: 'AVAILABLE', version: ns.version }, { $set: { status: 'BOOKED', hold_appt: a.id }, $inc: { version: 1 } }))) throw new HttpError(409, 'SLOT_TAKEN', 'Khung giờ mới vừa có người đặt. Lịch cũ của bạn được giữ nguyên.');
    if (!(await transition(a.id, ['confirmed'], 'rescheduled', 'RESCHEDULE_REQUESTED'))) { await releaseSlot(ns.id); throw new HttpError(409, 'CANNOT_RESCHEDULE', 'Lịch hẹn đã thay đổi trạng thái.'); }
    await releaseSlot(a.slot_id);
    await transition(a.id, ['rescheduled'], 'confirmed', 'SLOT_SWAPPED', { slot_id: ns.id, date: ns.date, start: ns.start, fee: ns.fee });
    const n = await appts.get({ id: a.id });
    bus.publish('appointment.rescheduled', apptEvent(n, { oldDate: old.date, oldStart: old.start }));
    res.json(apptView(n));
  }));

  // ----- Thong ke cho dashboard -----
  app.get('/stats/me', auth(), wrap(async (req, res) => {
    const col = req.user.role === 'doctor' ? 'doctor_id' : 'patient_id';
    const rows = await appts.all({ [col]: req.user.id });
    const today = ymd(new Date());
    const series = [...Array(7)].map((_, i) => { const d = ymd(addDays(new Date(), i - 3)); return { date: d, count: rows.filter((r) => r.date === d && !['cancelled', 'failed', 'refunded', 'refunding'].includes(r.status)).length }; });
    const active = rows.filter((r) => ['confirmed', 'in_progress', 'completed'].includes(r.status));
    res.json({ total: rows.length, completed: rows.filter((r) => r.status === 'completed').length, upcoming: rows.filter((r) => ['confirmed', 'pending', 'in_progress'].includes(r.status) && r.date >= today).length, today: active.filter((r) => r.date === today).length, week: series.reduce((m, s) => m + s.count, 0), cancelled: rows.filter((r) => ['cancelled', 'refunding', 'refunded'].includes(r.status)).length, series });
  }));
  app.get('/internal/doctors/:id/future-count', internalOnly, wrap(async (req, res) => res.json({ count: await appts.count({ doctor_id: req.params.id, status: { $in: ['pending', 'confirmed', 'in_progress'] }, date: { $gte: ymd(new Date()) } }) })));

  // ===== Xu ly su kien (idempotent vi RabbitMQ giao it nhat mot lan) =====
  const upsertDoc = (d, status) => doctorsCache.upsert({ id: d.doctorId }, { full_name: d.fullName, specialty: d.specialty, status });
  bus.on('doctor.verified', async (d) => upsertDoc(d, 'active'));
  bus.on('doctor.on_leave', async (d) => upsertDoc(d, 'on_leave'));
  bus.on('doctor.returned', async (d) => { await upsertDoc(d, 'active'); await generateAll(); });
  bus.on('doctor.suspended', async (d) => { await upsertDoc(d, 'suspended'); await blockFutureSlots(d.doctorId, 'DOCTOR_STATUS', ymd(new Date())); });
  bus.on('doctor.deactivated', async (d) => { await upsertDoc(d, 'deactivated'); await blockFutureSlots(d.doctorId, 'DOCTOR_STATUS', ymd(new Date())); });
  bus.on('doctor.reactivated', async (d) => { await upsertDoc(d, 'active'); await slots.updateMany({ doctor_id: d.doctorId, status: 'BLOCKED', block_reason: 'DOCTOR_STATUS', date: { $gte: ymd(new Date()) } }, { $set: { status: 'AVAILABLE', block_reason: null } }); await generateAll(); });
  bus.on('shift.approved', async (d) => { const s = await shifts.get({ id: d.shiftId }); if (s) log('scheduling', `sinh ${await generateForShift(s)} slot cho ca ${s.id.slice(0, 8)}`); });
  bus.on('leave.approved', async (d) => blockFutureSlots(d.doctorId, 'LEAVE', d.fromDate, d.toDate));

  bus.on('payment.completed', async (d) => {
    const a = await appts.get({ id: d.appointmentId });
    if (!a) return;
    const held = await slots.get({ id: a.slot_id, hold_appt: a.id, status: 'HELD' });
    if (['pending', 'failed'].includes(a.status) && held) {
      if (await transition(a.id, ['pending', 'failed'], 'confirmed', 'PAYMENT_COMPLETED')) {
        await slots.update({ id: a.slot_id }, { $set: { status: 'BOOKED' }, $inc: { version: 1 } });
        bus.publish('appointment.confirmed', apptEvent(await appts.get({ id: a.id })));
      }
    } else if (['pending', 'failed', 'cancelled'].includes(a.status)) {
      // Thanh toan den muon khi slot da duoc nha: hoan tien 100%.
      const before = await appts.claim({ id: a.id, status: { $in: ['pending', 'failed', 'cancelled'] } }, { $set: { status: 'refunding', cancelled_by: 'SYSTEM', refund_percent: 100 } });
      if (before) {
        if (before.status !== 'cancelled') await apptLog.insert({ appointment_id: a.id, from_status: before.status, to_status: 'cancelled', reason: 'LATE_PAYMENT', at: nowIso() });
        await apptLog.insert({ appointment_id: a.id, from_status: 'cancelled', to_status: 'refunding', reason: 'REFUND_REQUESTED', at: nowIso() });
        bus.publish('refund.requested', { appointmentId: a.id, percent: 100, reason: 'LATE_PAYMENT' });
      }
    }
  });
  bus.on('payment.failed', async (d) => {
    const before = await transition(d.appointmentId, ['pending'], 'failed', 'PAYMENT_FAILED', {}, { retry_count: 1 });
    if (before && before.retry_count + 1 >= 3) await failFinal(await appts.get({ id: d.appointmentId }), 'OUT_OF_RETRIES');
  });
  bus.on('consultation.started', async (d) => { await transition(d.appointmentId, ['confirmed'], 'in_progress', 'BOTH_JOINED'); });
  bus.on('consultation.completed', async (d) => { const b = await transition(d.appointmentId, ['confirmed', 'in_progress'], 'completed', 'CONSULTATION_DONE'); if (b) await slots.set({ id: b.slot_id }, { status: 'DONE', hold_appt: null }); });
  bus.on('patient.no_show', async (d) => { const b = await transition(d.appointmentId, ['confirmed'], 'no_show', 'PATIENT_ABSENT'); if (b) await slots.set({ id: b.slot_id }, { status: 'DONE', hold_appt: null }); });
  bus.on('doctor.absent', async (d) => { await cancelAppointment(d.appointmentId, { by: 'DOCTOR', reason: 'DOCTOR_ABSENT', refundPercent: 100, slotAfter: 'BLOCKED', slotReason: 'DOCTOR_ABSENT' }); });
  bus.on('refund.completed', async (d) => { await transition(d.appointmentId, ['refunding'], 'refunded', 'REFUND_COMPLETED'); });
  await bus.start();

  // ===== Tac vu nen =====
  setInterval(async () => { // het han giu cho
    try { for (const a of await appts.all({ status: { $in: ['pending', 'failed'] }, expires_at: { $lt: nowIso() }, released: { $ne: true } })) await failFinal(a, 'HOLD_EXPIRED'); } catch (e) { log('scheduling', 'job het han loi:', e.message); }
  }, 5000);
  setInterval(async () => { // bat dau / ket thuc ky nghi
    try {
      const today = ymd(new Date());
      for (const l of await leaves.all({ status: 'APPROVED', from_date: { $lte: today } })) if (await leaves.update({ id: l.id, status: 'APPROVED' }, { $set: { status: 'ACTIVE' } })) bus.publish('doctor.leave_started', { doctorId: l.doctor_id });
      for (const l of await leaves.all({ status: 'ACTIVE', to_date: { $lt: today } })) if (await leaves.update({ id: l.id, status: 'ACTIVE' }, { $set: { status: 'ENDED' } })) bus.publish('doctor.leave_ended', { doctorId: l.doctor_id });
    } catch (e) { log('scheduling', 'job nghi phep loi:', e.message); }
  }, 15000);
  generateAll().catch(() => {}); setInterval(() => generateAll().catch(() => {}), 10 * 60 * 1000);
  C.finish(app, 'scheduling', 3002);
}
main().catch((e) => { console.error(e); process.exit(1); });
