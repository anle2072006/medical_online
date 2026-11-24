'use strict';
// Nap du lieu mau: 6 bac si, 3 benh nhan (mat khau chung secret123). Chay lai nhieu lan van an toan (bo qua tai khoan da co).
//   node scripts/seed.js
// Bien moi truong: BASE (mac dinh http://localhost:8080), MONGO_URL (mac dinh mongodb://127.0.0.1:27030 = cong Mongo mo ra tu docker compose),
//                  JWT_SECRET (mac dinh doc tu file .env cung thu muc goc).
// Cach hoat dong: dang ky qua API that, dat san ma OTP da biet vao identity_db, roi goi /verify-email de he thong phat du su kien
// (chao mung, bat dau xac thuc giay phep bac si). Nhu vay du lieu mau di qua dung luong nghiep vu, khong "lach" he thong.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { MongoClient } = require('mongodb');

const BASE = process.env.BASE || 'http://localhost:8080';
const MONGO = process.env.MONGO_URL || 'mongodb://127.0.0.1:27030';
const PASSWORD = 'secret123';
const OTP = '123456';
const DOCTORS = [
  ['bs.an@sina.vn', 'BS Nguyễn Văn An', 'Nội tổng quát', 'BS10001'], ['bs.binh@sina.vn', 'BS Trần Thị Bình', 'Nhi khoa', 'BS10002'],
  ['bs.cuong@sina.vn', 'BS Lê Minh Cường', 'Da liễu', 'BS10003'], ['bs.dung@sina.vn', 'BS Phạm Thùy Dung', 'Tim mạch', 'BS10004'],
  ['bs.em@sina.vn', 'BS Hoàng Văn Em', 'Tai mũi họng', 'BS10005'], ['bs.phuong@sina.vn', 'BS Võ Thị Phương', 'Thần kinh', 'BS10006'],
];
const PATIENTS = [['bn.lan@sina.vn', 'Nguyễn Thị Lan'], ['bn.minh@sina.vn', 'Trần Quốc Minh'], ['bn.nga@sina.vn', 'Lê Thanh Nga']];

function jwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  try { const m = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').match(/^JWT_SECRET=(.+)$/m); if (m) return m[1].trim(); } catch { /* khong co .env */ }
  return null;
}
async function post(url, body) {
  const r = await fetch(`${BASE}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let j = {}; try { j = await r.json(); } catch { /* khong co noi dung */ }
  return { status: r.status, body: j };
}

(async () => {
  const secret = jwtSecret();
  if (!secret) { console.error('Khong tim thay JWT_SECRET (dat bien moi truong hoac file .env).'); process.exit(1); }
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
  if (!health) { console.error(`Khong ket noi duoc ${BASE}. Hay chay "docker compose up -d --build" truoc.`); process.exit(1); }

  const accounts = [
    ...DOCTORS.map(([email, fullName, specialty, licenseNo]) => ({ role: 'doctor', email, fullName, specialty, licenseNo })),
    ...PATIENTS.map(([email, fullName]) => ({ role: 'patient', email, fullName })),
  ];
  const client = new MongoClient(MONGO, { serverSelectionTimeoutMS: 4000 });
  try { await client.connect(); } catch (e) { console.error(`Khong ket noi duoc MongoDB ${MONGO}: ${e.message}`); process.exit(1); }
  const users = client.db('identity_db').collection('users');
  let created = 0, skipped = 0;
  try {
    for (const a of accounts) {
      const existing = await users.findOne({ email: a.email }, { projection: { verified: 1 } });
      if (existing && existing.verified !== false) { skipped++; console.log(`  =  ${a.role.padEnd(7)} ${a.email} (da co, bo qua)`); continue; }
      const r = await post('/api/identity/register', { ...a, password: PASSWORD });
      if (r.status !== 201) { console.error(`  !  ${a.email}: ${r.status} ${JSON.stringify(r.body)}`); process.exit(1); }
      const hash = crypto.createHmac('sha256', secret).update(`${r.body.id}:${OTP}`).digest('hex');
      await users.updateOne({ id: r.body.id }, { $set: { otp_hash: hash, otp_expires: new Date(Date.now() + 10 * 60000).toISOString(), otp_tries: 0 } });
      const v = await post('/api/identity/verify-email', { email: a.email, otp: OTP });
      if (v.status !== 200) { console.error(`  !  xac minh ${a.email} that bai: ${v.status} ${JSON.stringify(v.body)}`); process.exit(1); }
      created++; console.log(`  +  ${a.role.padEnd(7)} ${a.email}`);
    }
  } finally { await client.close(); }
  console.log(`\nXong: tao moi ${created}, bo qua ${skipped}. Dang nhap bang email o tren voi mat khau ${PASSWORD}.`);
  console.log('Bac si se tu chuyen sang "active" sau vai giay (giay phep BS1000x la hop le).');
})();
