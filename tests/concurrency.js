'use strict';
// Kiem thu dong thoi (B5): 20 benh nhan cung dat MOT slot, dung 1 thanh cong, 19 nhan SLOT_TAKEN.
// Can he thong dang chay voi EXPOSE_DEV_OTP=true:   npm run test:concurrency
const BASE = process.env.BASE || 'http://localhost:8080';
const N = Number(process.env.N || 20);
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = Date.now().toString(36);

async function api(path, { method = 'GET', body, token } = {}) {
  const r = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
}
async function mk(role, name, extra = {}) {
  const email = `${name}.${run}@test.vn`;
  const reg = await api('/api/identity/register', { method: 'POST', body: { role, email, password: 'secret123', fullName: name, ...extra } });
  if (!reg.body.devOtp) throw new Error(`Dang ky that bai (${reg.status} ${JSON.stringify(reg.body)}). Chay he thong voi EXPOSE_DEV_OTP=true.`);
  const v = await api('/api/identity/verify-email', { method: 'POST', body: { email, otp: reg.body.devOtp } });
  return { token: v.body.token, id: v.body.user.id };
}
(async () => {
  console.log(`Chuan bi: 1 bac si, ${N} benh nhan`);
  // Gateway gioi han 20 dang ky/xac minh moi phut moi IP: tao tai khoan theo lo de khong bi 429.
  const doc = await mk('doctor', 'BSDongThoi', { specialty: 'Nội tổng quát', licenseNo: 'BS31415' });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { const s = (await api('/api/identity/doctors/me/status', { token: doc.token })).body; if (s.status === 'active') break; await sleep(300); }
  const d = new Date(); d.setDate(d.getDate() + 3);
  const shift = await api('/api/scheduling/shifts', { method: 'POST', token: doc.token, body: { weekday: d.getDay(), startTime: '08:00', endTime: '09:00', slotMinutes: 30, fee: 100000, startDate: ymd(d) } });
  if (shift.body.status !== 'APPROVED') throw new Error(`Ca khong duoc duyet: ${JSON.stringify(shift.body)}`);
  let slots = []; for (let i = 0; i < 50 && slots.length < 2; i++) { slots = (await api(`/api/scheduling/doctors/${doc.id}/slots`, { token: doc.token })).body; await sleep(300); }
  const slot = slots[0];
  const patients = [];
  for (let i = 0; i < N; i++) { patients.push(await mk('patient', `BNDongThoi${i}`)); if ((i + 1) % 9 === 0 && i + 1 < N) { console.log('  (doi 61 giay de tranh gioi han dang ky cua gateway...)'); await sleep(61000); } }

  console.log(`Ban ${N} yeu cau dat cung slot ${slot.date} ${slot.start} dong thoi...`);
  const res = await Promise.all(patients.map((p) => api('/api/scheduling/appointments', { method: 'POST', token: p.token, body: { slotId: slot.id } })));
  const ok = res.filter((r) => r.status === 201).length;
  const taken = res.filter((r) => r.status === 409 && r.body.error === 'SLOT_TAKEN').length;
  console.log(`  thanh cong: ${ok}, SLOT_TAKEN: ${taken}, khac: ${N - ok - taken}`);
  const pass = ok === 1 && taken === N - 1;
  console.log(pass ? 'DAT: dung 1 yeu cau duoc giu cho.' : 'LOI: ket qua khong dung ky vong (1 thanh cong, con lai SLOT_TAKEN).');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e.message); process.exit(1); });
