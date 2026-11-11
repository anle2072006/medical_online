'use strict';
// Identity (identity_db, MongoDB): dang ky/dang nhap, ho so benh nhan & bac si, FSM ho so bac si (tu dong xac thuc qua Doctor Verification).
const bcrypt = require('bcryptjs');
const C = require('../../common');
const { CONFIG, uid, nowIso, HttpError, wrap, auth, internalOnly, callJson, log } = C;

const SPECIALTIES = ['Nội tổng quát', 'Nhi khoa', 'Da liễu', 'Tim mạch', 'Tai mũi họng', 'Thần kinh', 'Mắt', 'Răng hàm mặt'];
let bus, users, doctors, statusLog, absences;

async function setDoctorStatus(doctorId, to, reason, event, extra = {}) {
  const d = await doctors.get({ user_id: doctorId });
  if (!d || d.status === to) return;
  await doctors.set({ user_id: doctorId }, { status: to, reason: reason || null, suspended_until: extra.suspendedUntil || null });
  await statusLog.insert({ doctor_id: doctorId, from_status: d.status, to_status: to, reason: reason || null, at: nowIso() });
  const u = await users.get({ id: doctorId });
  if (event) bus.publish(event, { doctorId, fullName: u.full_name, specialty: d.specialty, reason });
  log('identity', `bac si ${u.full_name}: ${d.status} -> ${to}`);
}

// ----- Xac thuc bac si qua he thong ngoai, co retry tang dan -----
const RETRY = [2000, 5000, 15000];
async function verifyLoop(doctorId, attempt = 0) {
  const d = await doctors.get({ user_id: doctorId });
  if (!d || d.status !== 'verifying') return;
  const u = await users.get({ id: doctorId });
  try {
    const r = await callJson(`${CONFIG.urls.mock}/verify`, { method: 'POST', body: { licenseNo: d.license_no, fullName: u.full_name }, timeout: 4000 });
    if (r.status === 'VALID') {
      await doctors.set({ user_id: doctorId }, { license_expiry: r.expiry });
      await setDoctorStatus(doctorId, 'active', null, 'doctor.verified');
    } else {
      const reason = { INVALID: 'LICENSE_INVALID', EXPIRED: 'LICENSE_EXPIRED', REVOKED: 'LICENSE_REVOKED' }[r.status] || 'LICENSE_INVALID';
      await setDoctorStatus(doctorId, 'rejected', reason, 'doctor.rejected');
    }
  } catch (e) {
    const wait = RETRY[Math.min(attempt, RETRY.length - 1)] * (attempt >= RETRY.length ? 2 : 1);
    log('identity', `Doctor Verification chua phan hoi (lan ${attempt + 1}), thu lai sau ${wait}ms`);
    setTimeout(() => verifyLoop(doctorId, attempt + 1), wait);
  }
}

// ----- Kiem tra dinh ky giay phep & het han khoa -----
async function periodicCheck() {
  for (const d of await doctors.all({ status: { $in: ['active', 'suspended', 'on_leave'] } })) {
    if (d.status === 'suspended' && d.reason === 'ABSENCE') {
      if (d.suspended_until && d.suspended_until < nowIso()) await setDoctorStatus(d.user_id, 'active', null, 'doctor.reactivated');
      continue;
    }
    try {
      const r = await callJson(`${CONFIG.urls.mock}/verify`, { method: 'POST', body: { licenseNo: d.license_no }, timeout: 4000 });
      if (r.status === 'REVOKED') await setDoctorStatus(d.user_id, 'deactivated', 'LICENSE_REVOKED', 'doctor.deactivated');
      else if (r.status === 'EXPIRED' && d.status !== 'suspended') await setDoctorStatus(d.user_id, 'suspended', 'LICENSE_EXPIRED', 'doctor.suspended');
      else if (r.status === 'VALID' && d.status === 'suspended' && d.reason === 'LICENSE_EXPIRED') await setDoctorStatus(d.user_id, 'active', null, 'doctor.reactivated');
    } catch { /* he thong ngoai tam thoi khong san sang: bo qua, lan sau kiem tra lai */ }
  }
}

const doctorView = (u, d) => ({ id: u.id, fullName: u.full_name, specialty: d.specialty, status: d.status, reason: d.reason, licenseNo: d.license_no, licenseExpiry: d.license_expiry, verifyAttempts: d.verify_attempts, final: d.status === 'rejected' && d.verify_attempts >= 3 });

async function main() {
  const db = await C.openDb('identity', {
    users: [[{ id: 1 }, { unique: true }], [{ email: 1 }, { unique: true }]],
    doctors: [[{ user_id: 1 }, { unique: true }], [{ status: 1 }]],
    doctor_absences: [[{ appointment_id: 1 }, { unique: true }]],
    doctor_status_log: [[{ doctor_id: 1 }]],
  });
  users = db.col('users'); doctors = db.col('doctors'); statusLog = db.col('doctor_status_log'); absences = db.col('doctor_absences');
  bus = await C.connectBus('identity');
  const app = C.createApp('identity');

  app.get('/specialties', (req, res) => res.json(SPECIALTIES));

  app.post('/register', wrap(async (req, res) => {
    const { role, email, password, fullName, specialty, licenseNo, phone, dob } = req.body || {};
    if (!['patient', 'doctor'].includes(role)) throw new HttpError(400, 'INVALID_ROLE', 'Vai trò không hợp lệ.');
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, 'INVALID_EMAIL', 'Email không hợp lệ.');
    if (!password || password.length < 6) throw new HttpError(400, 'WEAK_PASSWORD', 'Mật khẩu cần ít nhất 6 ký tự.');
    if (!fullName) throw new HttpError(400, 'MISSING_NAME', 'Vui lòng nhập họ tên.');
    if (role === 'doctor' && (!SPECIALTIES.includes(specialty) || !licenseNo)) throw new HttpError(400, 'MISSING_DOCTOR_INFO', 'Bác sĩ cần chọn chuyên khoa và nhập số giấy phép.');
    const id = uid();
    const ok = await users.insertIgnore({ id, email: email.toLowerCase(), password_hash: bcrypt.hashSync(password, 8), role, full_name: fullName, phone: phone || null, dob: dob || null, created_at: nowIso() });
    if (!ok) throw new HttpError(409, 'EMAIL_TAKEN', 'Email này đã được đăng ký.');
    bus.publish('user.registered', { userId: id, email: email.toLowerCase(), fullName, role });
    if (role === 'doctor') {
      await doctors.insert({ user_id: id, specialty, license_no: licenseNo, license_expiry: null, status: 'registered', reason: null, verify_attempts: 1, suspended_until: null });
      await statusLog.insert({ doctor_id: id, from_status: 'start', to_status: 'registered', reason: null, at: nowIso() });
      bus.publish('doctor.registered', { doctorId: id, fullName, specialty, licenseNo });
    }
    res.status(201).json({ id, role });
  }));

  app.post('/login', wrap(async (req, res) => {
    const { email = '', password = '' } = req.body || {};
    const u = await users.get({ email: email.toLowerCase() });
    if (!u || !bcrypt.compareSync(password, u.password_hash)) throw new HttpError(401, 'BAD_CREDENTIALS', 'Email hoặc mật khẩu chưa đúng.');
    if (u.role === 'doctor' && (await doctors.get({ user_id: u.id })).status === 'deactivated') throw new HttpError(403, 'ACCOUNT_CLOSED', 'Tài khoản bác sĩ đã đóng.');
    res.json({ token: C.signToken(u), user: { id: u.id, role: u.role, fullName: u.full_name, email: u.email } });
  }));

  app.get('/me', auth(), wrap(async (req, res) => {
    const u = await users.get({ id: req.user.id });
    if (!u) throw new HttpError(404, 'NOT_FOUND');
    const out = { id: u.id, role: u.role, fullName: u.full_name, email: u.email, phone: u.phone };
    if (u.role === 'doctor') out.doctor = doctorView(u, await doctors.get({ user_id: u.id }));
    res.json(out);
  }));

  app.get('/doctors', auth(), wrap(async (req, res) => {
    const ds = await doctors.all({ status: 'active' });
    const us = await users.all({ id: { $in: ds.map((d) => d.user_id) } });
    res.json(ds.map((d) => ({ id: d.user_id, fullName: (us.find((u) => u.id === d.user_id) || {}).full_name, specialty: d.specialty })));
  }));

  app.get('/doctors/me/status', auth('doctor'), wrap(async (req, res) => {
    const u = await users.get({ id: req.user.id });
    const d = await doctors.get({ user_id: req.user.id });
    const logs = await statusLog.all({ doctor_id: req.user.id }, { sort: { _id: 1 } });
    res.json({ ...doctorView(u, d), log: logs.map(({ from_status, to_status, reason, at }) => ({ from_status, to_status, reason, at })) });
  }));

  app.post('/doctors/me/resubmit', auth('doctor'), wrap(async (req, res) => {
    const d = await doctors.get({ user_id: req.user.id });
    if (d.status !== 'rejected') throw new HttpError(409, 'NOT_REJECTED', 'Hồ sơ không ở trạng thái bị từ chối.');
    if (d.verify_attempts >= 3) throw new HttpError(409, 'NO_RETRIES_LEFT', 'Đã hết 3 lần nộp lại.');
    const licenseNo = (req.body && req.body.licenseNo) || d.license_no;
    await doctors.update({ user_id: req.user.id }, { $set: { license_no: licenseNo }, $inc: { verify_attempts: 1 } });
    await setDoctorStatus(req.user.id, 'registered', 'RESUBMITTED', null);
    bus.publish('doctor.registered', { doctorId: req.user.id, fullName: req.user.name, specialty: d.specialty, licenseNo });
    res.json({ ok: true });
  }));

  app.post('/doctors/me/deactivate', auth('doctor'), wrap(async (req, res) => {
    const d = await doctors.get({ user_id: req.user.id });
    if (d.status !== 'active') throw new HttpError(409, 'NOT_ACTIVE', 'Chỉ đóng được tài khoản đang hoạt động.');
    const r = await callJson(`${CONFIG.urls.scheduling}/internal/doctors/${req.user.id}/future-count`, { headers: { 'x-internal-key': CONFIG.internalKey } });
    if (r.count > 0) throw new HttpError(409, 'HAS_FUTURE_APPOINTMENTS', `Bạn còn ${r.count} lịch hẹn sắp tới. Hãy hoàn tất hoặc xin nghỉ phép trước khi đóng tài khoản.`);
    await setDoctorStatus(req.user.id, 'deactivated', 'CLOSED_BY_DOCTOR', 'doctor.deactivated');
    res.json({ ok: true });
  }));

  // ----- Su kien -----
  bus.on('doctor.registered', async (d) => { await setDoctorStatus(d.doctorId, 'verifying', null, null); verifyLoop(d.doctorId); });
  bus.on('doctor.absent', async (d) => {
    await absences.insertIgnore({ doctor_id: d.doctorId, appointment_id: d.appointmentId, at: nowIso() });
    const since = new Date(Date.now() - 30 * 864e5).toISOString();
    if ((await absences.count({ doctor_id: d.doctorId, at: { $gte: since } })) >= 3) await setDoctorStatus(d.doctorId, 'suspended', 'ABSENCE', 'doctor.suspended', { suspendedUntil: new Date(Date.now() + 7 * 864e5).toISOString() });
  });
  bus.on('doctor.leave_started', async (d) => { const x = await doctors.get({ user_id: d.doctorId }); if (x && x.status === 'active') await setDoctorStatus(d.doctorId, 'on_leave', null, 'doctor.on_leave'); });
  bus.on('doctor.leave_ended', async (d) => { const x = await doctors.get({ user_id: d.doctorId }); if (x && x.status === 'on_leave') await setDoctorStatus(d.doctorId, 'active', null, 'doctor.returned'); });
  await bus.start();

  app.get('/internal/users/:id', internalOnly, wrap(async (req, res) => { const u = await users.get({ id: req.params.id }, { projection: { _id: 0, id: 1, full_name: 1, email: 1, role: 1 } }); u ? res.json(u) : res.status(404).json({}); }));

  for (const d of await doctors.all({ status: { $in: ['registered', 'verifying'] } })) { await setDoctorStatus(d.user_id, 'verifying', null, null); verifyLoop(d.user_id); }
  setInterval(() => periodicCheck().catch(() => {}), Number(process.env.LICENSE_CHECK_MS || 86400000));
  C.finish(app, 'identity', 3001);
}
main().catch((e) => { console.error(e); process.exit(1); });
