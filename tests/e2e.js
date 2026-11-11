'use strict';
// Kiem thu end-to-end qua API Gateway. Chay he thong truoc (npm run dev hoac docker compose up) roi: npm test
const BASE = process.env.BASE || 'http://localhost:8080';
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;

async function api(path, { method = 'GET', body, token } = {}) {
  const r = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
}
function check(name, cond, extra) { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`, extra !== undefined ? JSON.stringify(extra) : ''); } }
async function until(fn, ms = 15000) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(300); } return null; }
const run = Date.now().toString(36);
const mk = async (role, name, extra = {}) => { await api('/api/identity/register', { method: 'POST', body: { role, email: `${name.replace(/\s+/g, '')}.${run}@test.vn`, password: 'secret123', fullName: name, ...extra } }); const r = await api('/api/identity/login', { method: 'POST', body: { email: `${name.replace(/\s+/g, '')}.${run}@test.vn`, password: 'secret123' } }); return { token: r.body.token, id: r.body.user.id }; };

(async () => {
  const tomorrow = addDays(new Date(), 1); const dayAfter = addDays(new Date(), 2);
  console.log('1. Dang ky va xac thuc bac si');
  const docA = await mk('doctor', 'BS An', { specialty: 'Nội tổng quát', licenseNo: 'BS12345' });
  const docBad = await mk('doctor', 'BS Gia', { specialty: 'Da liễu', licenseNo: 'XX99999' });
  const docRev = await mk('doctor', 'BS Thu Hoi', { specialty: 'Mắt', licenseNo: 'BS55555' });
  const p1 = await mk('patient', 'Nguyen Van A'); const p2 = await mk('patient', 'Tran Thi B'); const p3 = await mk('patient', 'Le Van C');
  const st = async (d) => (await api('/api/identity/doctors/me/status', { token: d.token })).body;
  check('bac si hop le chuyen sang active', await until(async () => (await st(docA)).status === 'active'));
  check('bac si sai giay phep bi rejected', await until(async () => (await st(docBad)).status === 'rejected'));
  check('bac si thu hoi: active truoc', await until(async () => (await st(docRev)).status === 'active'));
  check('chua xac thuc -> REJECTED DOCTOR_NOT_VERIFIED', (await api('/api/scheduling/shifts', { method: 'POST', token: docBad.token, body: { weekday: dayAfter.getDay(), startTime: '08:00', endTime: '11:00', slotMinutes: 30, fee: 200000, startDate: ymd(dayAfter) } })).body.rejectCode === 'DOCTOR_NOT_VERIFIED');
  const resub = await api('/api/identity/doctors/me/resubmit', { method: 'POST', token: docBad.token, body: { licenseNo: 'BS77777' } });
  check('nop lai ho so duoc chap nhan', resub.status === 200);
  check('nop lai hop le -> active', await until(async () => (await st(docBad)).status === 'active'));

  console.log('2. Dang ky ca: luat tu duyet');
  const shift = { weekday: dayAfter.getDay(), startTime: '08:00', endTime: '11:00', slotMinutes: 30, fee: 200000, startDate: ymd(dayAfter) };
  check('ngoai gio hoat dong -> REJECTED OUT_OF_HOURS', (await api('/api/scheduling/shifts', { method: 'POST', token: docA.token, body: { ...shift, startTime: '05:00' } })).body.rejectCode === 'OUT_OF_HOURS');
  check('dang ky sat gio (<24h) -> TOO_LATE', (await api('/api/scheduling/shifts', { method: 'POST', token: docA.token, body: { ...shift, weekday: new Date().getDay(), startDate: ymd(new Date()) } })).body.rejectCode === 'TOO_LATE');
  const s1 = await api('/api/scheduling/shifts', { method: 'POST', token: docA.token, body: shift });
  check('ca hop le tu dong APPROVED', s1.body.status === 'APPROVED', s1.body);
  check('ca trung -> SHIFT_OVERLAP', (await api('/api/scheduling/shifts', { method: 'POST', token: docA.token, body: { ...shift, startTime: '10:00', endTime: '12:00' } })).body.rejectCode === 'SHIFT_OVERLAP');
  check('vuot 8 gio -> OVER_LIMIT', (await api('/api/scheduling/shifts', { method: 'POST', token: docA.token, body: { ...shift, startTime: '11:00', endTime: '20:00' } })).body.rejectCode === 'OVER_LIMIT');
  const shiftB = await api('/api/scheduling/shifts', { method: 'POST', token: docBad.token, body: shift });
  check('bac si khac cung ca van duoc duyet', shiftB.body.status === 'APPROVED');
  const slots = await until(async () => { const r = await api(`/api/scheduling/doctors/${docA.id}/slots`, { token: p1.token }); return r.body.length >= 6 ? r.body : null; });
  check('he thong tu sinh slot (6 slot 08:00-11:00)', !!slots && slots.length >= 6, slots && slots.length);
  const list = await api('/api/scheduling/doctors', { token: p1.token });
  check('benh nhan thay danh sach bac si co slot', list.body.some((d) => d.id === docA.id && d.availableCount >= 6));

  console.log('3. Dat lich + thanh toan (webhook idempotent)');
  const slotA = slots[0], slotB = slots[1], slotC = slots[2], slotD = slots[3], slotE = slots[4];
  const a1 = await api('/api/scheduling/appointments', { method: 'POST', token: p1.token, body: { slotId: slotA.id } });
  check('dat lich -> pending', a1.status === 201 && a1.body.status === 'pending', a1.body);
  const clash = await api('/api/scheduling/appointments', { method: 'POST', token: p2.token, body: { slotId: slotA.id } });
  check('nguoi thu hai bi SLOT_TAKEN', clash.status === 409 && clash.body.error === 'SLOT_TAKEN', clash.body);
  const inv = await until(async () => { const r = await api(`/api/billing/invoices?appointmentId=${a1.body.id}`, { token: p1.token }); return r.body[0] && r.body[0].payUrl ? r.body[0] : null; });
  check('billing tao hoa don + duong dan VNPay qua su kien', !!inv && inv.amount === 200000, inv);
  const txn = inv.payUrl.split('/').pop();
  await api(`/ext/vnpay/complete/${txn}?result=ok`, { method: 'POST' });
  check('thanh toan xong -> confirmed', await until(async () => (await api(`/api/scheduling/appointments/${a1.body.id}`, { token: p1.token })).body.status === 'confirmed'));
  const full = (await api(`/api/scheduling/appointments/${a1.body.id}`, { token: p1.token })).body;
  check('nhat ky FSM: pending -> confirmed', full.log.map((l) => l.to_status).join('>') === 'pending>confirmed', full.log);

  console.log('4. Thanh toan loi va thu lai');
  const a2 = (await api('/api/scheduling/appointments', { method: 'POST', token: p2.token, body: { slotId: slotB.id } })).body;
  const inv2 = await until(async () => { const r = await api(`/api/billing/invoices?appointmentId=${a2.id}`, { token: p2.token }); return r.body[0] && r.body[0].payUrl ? r.body[0] : null; });
  await api(`/ext/vnpay/complete/${inv2.payUrl.split('/').pop()}?result=fail`, { method: 'POST' });
  check('thanh toan loi -> failed', await until(async () => (await api(`/api/scheduling/appointments/${a2.id}`, { token: p2.token })).body.status === 'failed'));
  check('thu lai thanh toan -> pending', (await api(`/api/scheduling/appointments/${a2.id}/retry-payment`, { method: 'POST', token: p2.token })).status === 200);
  const inv2b = await until(async () => { const r = await api(`/api/billing/invoices?appointmentId=${a2.id}`, { token: p2.token }); return r.body[0] && r.body[0].payUrl && r.body[0].attempts === 2 ? r.body[0] : null; });
  check('billing tao lan thanh toan thu 2', !!inv2b);
  await api(`/ext/vnpay/complete/${inv2b.payUrl.split('/').pop()}?result=ok`, { method: 'POST' });
  check('thu lai thanh cong -> confirmed', await until(async () => (await api(`/api/scheduling/appointments/${a2.id}`, { token: p2.token })).body.status === 'confirmed'));

  console.log('5. Kham tu xa, benh an, don thuoc dien tu');
  const early = await api(`/api/records/consultations/${a1.body.id}/complete`, { method: 'POST', token: docA.token, body: { symptoms: 'ho', diagnosis: 'cam' } });
  check('chua vao phong thi khong ghi duoc benh an', early.status === 409 && early.body.error === 'NOT_IN_PROGRESS', early.body);
  const stranger = await api(`/api/tele/sessions/${a1.body.id}/join`, { method: 'POST', token: p3.token });
  check('nguoi la khong vao duoc phong', stranger.status === 403, stranger.body);
  const j1 = await until(async () => { const r = await api(`/api/tele/sessions/${a1.body.id}/join`, { method: 'POST', token: docA.token }); return r.status === 200 ? r.body : null; });
  check('bac si vao phong Jitsi', !!j1 && j1.roomUrl.includes('/sina-clinic-'), j1);
  const j2 = await api(`/api/tele/sessions/${a1.body.id}/join`, { method: 'POST', token: p1.token });
  check('benh nhan vao cung phong', j2.status === 200 && j2.body.roomUrl === j1.roomUrl, j2.body);
  check('hai ben vao phong -> in_progress', await until(async () => (await api(`/api/scheduling/appointments/${a1.body.id}`, { token: p1.token })).body.status === 'in_progress'));
  const drugs = (await api('/api/records/drugs', { token: docA.token })).body;
  const done = await until(async () => { const r = await api(`/api/records/consultations/${a1.body.id}/complete`, { method: 'POST', token: docA.token, body: { symptoms: 'Ho, sốt nhẹ', diagnosis: 'Viêm họng', notes: 'Uống nhiều nước', items: [{ drugId: drugs[0].id, dosage: '1 viên x 3 lần/ngày', quantity: 15 }] } }); return r.status === 201 ? r : null; });
  check('ghi benh an + ke don', !!done && !!done.body.prescription, done && done.body);
  check('lich -> completed', await until(async () => (await api(`/api/scheduling/appointments/${a1.body.id}`, { token: p1.token })).body.status === 'completed'));
  const rx0 = (await api('/api/records/prescriptions/mine', { token: p1.token })).body[0];
  check('don thuoc dien tu co ma va danh sach thuoc (ISSUED)', !!rx0 && rx0.status === 'ISSUED' && rx0.items.length === 1 && rx0.code.startsWith('RX-'), rx0);
  check('nguoi khac khong danh dau nhan thuoc duoc', (await api(`/api/records/prescriptions/${rx0.id}/collect`, { method: 'POST', token: p2.token })).status === 409);
  check('benh nhan tu nhan thuoc o co so gan nhat -> COLLECTED', (await api(`/api/records/prescriptions/${rx0.id}/collect`, { method: 'POST', token: p1.token })).status === 200 && (await api('/api/records/prescriptions/mine', { token: p1.token })).body[0].status === 'COLLECTED');
  check('khong danh dau nhan thuoc lan hai', (await api(`/api/records/prescriptions/${rx0.id}/collect`, { method: 'POST', token: p1.token })).status === 409);
  const recs = (await api('/api/records/records/mine', { token: p1.token })).body;
  check('benh an theo FHIR Encounter + MedicationRequest', recs[0] && recs[0].fhir.encounter.resourceType === 'Encounter' && recs[0].fhir.medicationRequests[0].resourceType === 'MedicationRequest', recs[0]);
  check('bac si khac khong xem duoc ho so', (await api(`/api/records/records/patient/${p1.id}`, { token: docBad.token })).status === 403);
  check('bac si co lich hen xem duoc ho so', (await api(`/api/records/records/patient/${p1.id}`, { token: docA.token })).status === 200);
  const logs = (await api('/api/records/access-logs/mine', { token: p1.token })).body;
  check('benh nhan thay ai da truy cap ho so', logs.some((l) => l.action === 'VIEW_RECORDS'), logs);

  console.log('6. Huy lich, hoan tien (Saga), doi lich');
  const a3 = (await api('/api/scheduling/appointments', { method: 'POST', token: p3.token, body: { slotId: slotC.id } })).body;
  const inv3 = await until(async () => { const r = await api(`/api/billing/invoices?appointmentId=${a3.id}`, { token: p3.token }); return r.body[0] && r.body[0].payUrl ? r.body[0] : null; });
  await api(`/ext/vnpay/complete/${inv3.payUrl.split('/').pop()}?result=ok`, { method: 'POST' });
  await until(async () => (await api(`/api/scheduling/appointments/${a3.id}`, { token: p3.token })).body.status === 'confirmed');
  const rs = await api(`/api/scheduling/appointments/${a3.id}/reschedule`, { method: 'POST', token: p3.token, body: { slotId: slotD.id } });
  check('doi lich sang slot moi', rs.status === 200 && rs.body.start === slotD.start && rs.body.status === 'confirmed', rs.body);
  const freed = (await api(`/api/scheduling/doctors/${docA.id}/slots`, { token: p3.token })).body;
  check('slot cu duoc tra lai', freed.some((s) => s.id === slotC.id));
  const rs2 = await api(`/api/scheduling/appointments/${a3.id}/reschedule`, { method: 'POST', token: p3.token, body: { slotId: slotA.id } });
  check('doi sang slot da co nguoi -> loi, giu lich cu', rs2.status === 409, rs2.body);
  const cancel = await api(`/api/scheduling/appointments/${a3.id}/cancel`, { method: 'POST', token: p3.token });
  check('huy truoc >24h hoan 100%', cancel.body.refundPercent === 100, cancel.body);
  check('cancelled -> refunding -> refunded', await until(async () => (await api(`/api/scheduling/appointments/${a3.id}`, { token: p3.token })).body.status === 'refunded'));
  const hist = (await api(`/api/scheduling/appointments/${a3.id}`, { token: p3.token })).body.log.map((l) => l.to_status).join('>');
  check('nhat ky Saga day du', hist === 'pending>confirmed>rescheduled>confirmed>cancelled>refunding>refunded', hist);

  console.log('7. Bac si nghi phep -> huy hang loat + hoan tien');
  const a4 = (await api('/api/scheduling/appointments', { method: 'POST', token: p3.token, body: { slotId: slotE.id } })).body;
  const inv4 = await until(async () => { const r = await api(`/api/billing/invoices?appointmentId=${a4.id}`, { token: p3.token }); return r.body[0] && r.body[0].payUrl ? r.body[0] : null; });
  await api(`/ext/vnpay/complete/${inv4.payUrl.split('/').pop()}?result=ok`, { method: 'POST' });
  await until(async () => (await api(`/api/scheduling/appointments/${a4.id}`, { token: p3.token })).body.status === 'confirmed');
  const leave = await api('/api/scheduling/leaves', { method: 'POST', token: docA.token, body: { fromDate: slotE.date, toDate: slotE.date } });
  check('nghi phep duoc tu duyet', leave.status === 201, leave.body);
  check('lich bi anh huong tu huy va hoan tien 100%', await until(async () => { const a = (await api(`/api/scheduling/appointments/${a4.id}`, { token: p3.token })).body; return a.status === 'refunded' && a.cancelledBy === 'DOCTOR' && a.refundPercent === 100; }));
  check('slot trong bi khoa', (await api(`/api/scheduling/doctors/${docA.id}/slots`, { token: p3.token })).body.every((s) => s.date !== slotE.date));
  check('trung ky nghi -> LEAVE_OVERLAP', (await api('/api/scheduling/leaves', { method: 'POST', token: docA.token, body: { fromDate: slotE.date, toDate: slotE.date } })).body.error === 'LEAVE_OVERLAP');

  console.log('8. Giay phep bi thu hoi -> khoa tu dong');
  await api('/ext/verify/revoke/BS55555', { method: 'POST' });
  check('giay phep bi thu hoi -> deactivated', await until(async () => (await st(docRev)).status === 'deactivated', 20000));

  console.log('9. Thong bao');
  const n = (await api('/api/notify/notifications/mine', { token: p1.token })).body;
  check('benh nhan nhan thong bao tu cac su kien', n.items.length >= 4 && n.items.some((i) => i.type === 'appointment.confirmed'), n.items.map((i) => i.type));
  const nd = (await api('/api/notify/notifications/mine', { token: docBad.token })).body;
  check('bac si nhan thong bao xac thuc', nd.items.some((i) => i.type === 'doctor.verified') && nd.items.some((i) => i.type === 'doctor.rejected'), nd.items.map((i) => i.type));

  console.log('10. Bao mat');
  check('khong token -> 401', (await api('/api/scheduling/doctors')).status === 401);
  check('benh nhan khong dang ky ca duoc -> 403', (await api('/api/scheduling/shifts', { method: 'POST', token: p1.token, body: shift })).status === 403);
  check('webhook/internal khong lo ra ngoai gateway', (await api('/api/billing/webhooks/vnpay-ipn', { method: 'POST', body: {} })).status === 404);

  console.log(`\nKet qua: ${pass} dat, ${fail} loi`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
