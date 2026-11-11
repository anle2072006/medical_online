'use strict';
// Teleconsultation (tele_db, MongoDB): tao phong Jitsi theo lich hen, kiem soat ai duoc vao, phat hien vang mat.
const C = require('../../common');
const { CONFIG, uid, nowIso, localDate, HttpError, wrap, auth, log } = C;

const JITSI = process.env.JITSI_URL || 'https://meet.jit.si';
let bus, sessions;

async function main() {
  const db = await C.openDb('tele', { sessions: [[{ appointment_id: 1 }, { unique: true }], [{ status: 1 }]] });
  sessions = db.col('sessions');
  bus = await C.connectBus('tele');
  const app = C.createApp('tele');

  app.get('/sessions/:appointmentId', auth(), wrap(async (req, res) => {
    const s = await sessions.get({ appointment_id: req.params.appointmentId });
    if (!s || (s.patient_id !== req.user.id && s.doctor_id !== req.user.id)) throw new HttpError(404, 'NOT_FOUND', 'Chưa có phòng khám cho lịch hẹn này.');
    res.json({ status: s.status, date: s.date, start: s.start, doctorJoined: !!s.doctor_joined_at, patientJoined: !!s.patient_joined_at });
  }));

  // Chi bac si va benh nhan cua lich hen moi duoc nhan duong dan phong.
  app.post('/sessions/:appointmentId/join', auth(), wrap(async (req, res) => {
    const s = await sessions.get({ appointment_id: req.params.appointmentId });
    if (!s || (s.patient_id !== req.user.id && s.doctor_id !== req.user.id)) throw new HttpError(403, 'NOT_PARTICIPANT', 'Bạn không thuộc buổi khám này.');
    if (['ENDED', 'MISSED', 'CANCELLED'].includes(s.status)) throw new HttpError(409, 'SESSION_CLOSED', 'Buổi khám này đã kết thúc hoặc bị hủy.');
    if (!CONFIG.demo && localDate(s.date, s.start) - Date.now() > 10 * 6e4) throw new HttpError(409, 'TOO_EARLY', 'Phòng khám mở trước giờ hẹn 10 phút.');
    const isDoctor = s.doctor_id === req.user.id; const field = isDoctor ? 'doctor_joined_at' : 'patient_joined_at';
    await sessions.update({ appointment_id: s.appointment_id, [field]: null }, { $set: { [field]: nowIso() } });
    const n = await sessions.get({ appointment_id: s.appointment_id });
    if (n.doctor_joined_at && n.patient_joined_at && await sessions.claim({ appointment_id: s.appointment_id, status: 'SCHEDULED' }, { $set: { status: 'LIVE' } })) {
      bus.publish('consultation.started', { appointmentId: s.appointment_id, patientId: s.patient_id, doctorId: s.doctor_id });
    }
    res.json({ roomUrl: `${JITSI}/${s.room}`, role: isDoctor ? 'doctor' : 'patient', doctorJoined: !!n.doctor_joined_at, patientJoined: !!n.patient_joined_at });
  }));

  bus.on('appointment.confirmed', async (d) => { await sessions.insertIgnore({ appointment_id: d.appointmentId, room: `sina-clinic-${uid()}`, patient_id: d.patientId, doctor_id: d.doctorId, date: d.date, start: d.start, status: 'SCHEDULED', doctor_joined_at: null, patient_joined_at: null }); });
  bus.on('appointment.rescheduled', async (d) => { await sessions.set({ appointment_id: d.appointmentId }, { date: d.date, start: d.start }); });
  bus.on('appointment.cancelled', async (d) => { await sessions.set({ appointment_id: d.appointmentId }, { status: 'CANCELLED' }); });
  bus.on('consultation.completed', async (d) => { await sessions.set({ appointment_id: d.appointmentId }, { status: 'ENDED' }); });
  await bus.start();

  // Phat hien vang mat sau X phut ke tu gio hen (claim nguyen tu de chi phat su kien mot lan).
  setInterval(async () => {
    try {
      for (const s of await sessions.all({ status: 'SCHEDULED' })) {
        if (Date.now() - localDate(s.date, s.start) < CONFIG.absenceMinutes * 6e4) continue;
        if (!(await sessions.claim({ appointment_id: s.appointment_id, status: 'SCHEDULED' }, { $set: { status: 'MISSED' } }))) continue;
        if (!s.doctor_joined_at) bus.publish('doctor.absent', { appointmentId: s.appointment_id, patientId: s.patient_id, doctorId: s.doctor_id });
        else bus.publish('patient.no_show', { appointmentId: s.appointment_id, patientId: s.patient_id, doctorId: s.doctor_id });
        log('tele', `vang mat o lich ${s.appointment_id.slice(0, 8)}`);
      }
    } catch (e) { log('tele', 'job vang mat loi:', e.message); }
  }, 10000);
  C.finish(app, 'tele', 3005);
}
main().catch((e) => { console.error(e); process.exit(1); });
