'use strict';
// He thong ben ngoai gia lap: Doctor Verification, VNPay sandbox.
const C = require('../../common');
const { CONFIG, sign, wrap, HttpError, callJson, log } = C;
const app = C.createApp('mock-externals');
const revoked = new Set();
const txns = new Map(); 
const FAIL_RATE = Number(process.env.VERIFY_FAIL_RATE || 0);

// Doctor Verification
// BS12345 hop le | HH12345 het han | TH12345 bi thu hoi | con lai khong hop le
app.post('/verify', (req, res) => {
  if (Math.random() < FAIL_RATE) return res.status(503).json({ error: 'UNAVAILABLE' });
  const { licenseNo = '' } = req.body || {};
  if (revoked.has(licenseNo) || /^TH\d{5}$/.test(licenseNo)) return res.json({ status: 'REVOKED' });
  if (/^HH\d{5}$/.test(licenseNo)) return res.json({ status: 'EXPIRED' });
  if (/^BS\d{5}$/.test(licenseNo)) return res.json({ status: 'VALID', expiry: '2028-12-31' });
  res.json({ status: 'INVALID' });
});
app.post('/verify/revoke/:licenseNo', (req, res) => { revoked.add(req.params.licenseNo); res.json({ revoked: req.params.licenseNo }); });

// VNPay sandbox: thanh toan can ma OTP gui ve email cua benh nhan 
const crypto = require('node:crypto');
const REQUIRE_OTP = (process.env.VNPAY_REQUIRE_OTP || 'true') === 'true';
app.post('/vnpay/create', (req, res) => {
  const { txnRef, amount, ipnUrl } = req.body;
  txns.set(txnRef, { amount, ipnUrl, status: 'CREATED' });
  res.json({ payUrl: `/ext/vnpay/pay/${txnRef}` });
});
app.get('/vnpay/pay/:txn', (req, res) => {
  const t = txns.get(req.params.txn);
  if (!t) return res.status(404).send('Không tìm thấy giao dịch');
  const tx = req.params.txn;
  res.type('html').send(`<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VNPay Sandbox</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#4A9899;font-family:Inter,system-ui,sans-serif;color:#00414F}
.c{background:#fff;border-radius:24px;padding:34px;width:min(430px,92vw);box-shadow:0 20px 50px #00414f33}h1{margin:0 0 6px;font-size:22px}
p{margin:0 0 14px;color:#005162}.a{font-size:34px;font-weight:800;color:#0095A8;margin:8px 0 18px}
button{width:100%;padding:13px;border-radius:12px;border:0;font-size:16px;font-weight:700;cursor:pointer;margin-top:10px}
.ok{background:#0095A8;color:#fff}.no{background:#fff;color:#0095A8;border:2px solid #0095A8}.ok[disabled]{opacity:.5}
input{box-sizing:border-box;width:100%;padding:14px;border:2px solid #AFEBF0;border-radius:12px;font-size:24px;letter-spacing:10px;text-align:center;outline:none}
input:focus{border-color:#0095A8}small{display:block;margin-top:14px;color:#5b8f95}.msg{margin:10px 0 0;font-weight:600;color:#0095A8}.err{color:#b4443c}#s2{display:none}</style>
<div class="c"><h1>VNPay Sandbox</h1><p>Mã giao dịch ${tx}</p><div class="a">${Number(t.amount).toLocaleString('vi-VN')} đ</div>
<div id="s1"><p>Để xác nhận thanh toán, hệ thống sẽ gửi mã OTP 6 số về email đăng ký của bạn.</p><button class="ok" id="b1" onclick="sendOtp()">Gửi mã OTP về email</button></div>
<div id="s2"><p>Nhập mã OTP vừa gửi về email của bạn (hiệu lực 5 phút).</p><input id="otp" inputmode="numeric" maxlength="6" placeholder="------" autocomplete="one-time-code">
<button class="ok" onclick="pay()">Xác nhận thanh toán</button><button class="no" onclick="sendOtp()">Gửi lại mã OTP</button></div>
<div class="msg" id="m"></div><button class="no" onclick="failPay()" style="margin-top:18px">Giả lập thanh toán thất bại</button>
<small>Trang giả lập cổng thanh toán, dùng cho đồ án.</small></div>
<script>
const T='${tx}', m=document.getElementById('m');
function say(t,bad){m.textContent=t;m.className='msg'+(bad?' err':'');}
async function post(url,body){const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});let j={};try{j=await r.json();}catch(e){}return{ok:r.ok,j};}
async function sendOtp(){const r=await post('/ext/vnpay/otp/'+T);if(!r.ok)return say(r.j.message||'Không gửi được mã OTP.',true);document.getElementById('s1').style.display='none';document.getElementById('s2').style.display='block';say('Đã gửi mã OTP về email của bạn.');document.getElementById('otp').focus();}
async function pay(){const r=await post('/ext/vnpay/complete/'+T+'?result=ok',{otp:document.getElementById('otp').value.trim()});if(!r.ok)return say(r.j.message||'Thanh toán chưa thành công.',true);say('Thanh toán thành công, đang quay lại...');setTimeout(()=>location.href='/#/appointments',700);}
async function failPay(){await post('/ext/vnpay/complete/'+T+'?result=fail');location.href='/#/appointments';}
</script></html>`);
});
// Sinh OTP, gui qua Billing (Billing phat su kien, Notification gui email). Cong thanh toan chi giu OTP de doi chieu.
app.post('/vnpay/otp/:txn', wrap(async (req, res) => {
  const t = txns.get(req.params.txn);
  if (!t) throw new HttpError(404, 'NOT_FOUND', 'Không tìm thấy giao dịch.');
  if (t.otpAt && Date.now() - t.otpAt < 15000) throw new HttpError(429, 'OTP_TOO_SOON', 'Vui lòng đợi 15 giây trước khi gửi lại mã OTP.');
  t.otp = String(crypto.randomInt(100000, 1000000)); t.otpAt = Date.now(); t.tries = 0;
  await callJson(`${CONFIG.urls.billing}/internal/otp`, { method: 'POST', headers: { 'x-internal-key': CONFIG.internalKey }, body: { txnRef: req.params.txn, otp: t.otp } });
  res.json({ sent: true });
}));
// Chi de kiem thu tu dong; tat khi chay production (Docker).
if (process.env.NODE_ENV !== 'production') app.get('/vnpay/_test/otp/:txn', (req, res) => res.json({ otp: (txns.get(req.params.txn) || {}).otp || null }));
app.post('/vnpay/complete/:txn', wrap(async (req, res) => {
  const t = txns.get(req.params.txn);
  if (!t) throw new HttpError(404, 'NOT_FOUND');
  if (req.query.result === 'ok' && REQUIRE_OTP) {
    if (!t.otp) throw new HttpError(400, 'OTP_REQUIRED', 'Hãy bấm gửi mã OTP về email trước.');
    if (Date.now() - t.otpAt > 5 * 60000) throw new HttpError(400, 'OTP_EXPIRED', 'Mã OTP đã hết hạn, hãy gửi lại mã mới.');
    if (++t.tries > 3) throw new HttpError(429, 'OTP_LOCKED', 'Nhập sai quá 3 lần. Hãy gửi lại mã OTP mới.');
    if (String((req.body || {}).otp) !== t.otp) throw new HttpError(400, 'BAD_OTP', 'Mã OTP chưa đúng.');
    t.otp = null;
  }
  const status = req.query.result === 'ok' ? '00' : '99';
  const body = { txnRef: req.params.txn, status, amount: t.amount };
  body.signature = sign(`${body.txnRef}|${body.status}|${body.amount}`);
  // Cong thanh toan that hay goi IPN nhieu lan: gui 2 lan de chung minh billing xu ly idempotent.
  for (let i = 0; i < 2; i++) { try { await callJson(t.ipnUrl, { method: 'POST', body }); } catch (e) { log('mock', 'IPN loi', e.message); } }
  t.status = status;
  res.json({ ok: true });
}));
app.post('/vnpay/refund', (req, res) => {
  const { txnRef, amount } = req.body;
  if (!txns.has(txnRef)) return res.status(404).json({ error: 'TXN_NOT_FOUND' });
  res.json({ status: 'REFUNDED', refundRef: `RF-${txnRef}`, amount });
});

C.finish(app, 'mock-externals', 4000);
