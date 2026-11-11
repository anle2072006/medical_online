'use strict';
// He thong ben ngoai gia lap: Doctor Verification, VNPay sandbox.
const C = require('../../common');
const { CONFIG, sign, wrap, HttpError, callJson, log } = C;
const app = C.createApp('mock-externals');
const revoked = new Set();
const txns = new Map(); // txnRef -> {amount, ipnUrl, status}
const FAIL_RATE = Number(process.env.VERIFY_FAIL_RATE || 0);

// ----- Doctor Verification -----
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

// ----- VNPay sandbox -----
app.post('/vnpay/create', (req, res) => {
  const { txnRef, amount, ipnUrl } = req.body;
  txns.set(txnRef, { amount, ipnUrl, status: 'CREATED' });
  res.json({ payUrl: `/ext/vnpay/pay/${txnRef}` });
});
app.get('/vnpay/pay/:txn', (req, res) => {
  const t = txns.get(req.params.txn);
  if (!t) return res.status(404).send('Không tìm thấy giao dịch');
  res.type('html').send(`<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VNPay Sandbox</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#4A9899;font-family:Inter,system-ui,sans-serif;color:#00414F}
.c{background:#fff;border-radius:24px;padding:36px;width:min(420px,92vw);box-shadow:0 20px 50px #00414f33}h1{margin:0 0 6px;font-size:22px}
p{margin:0 0 18px;color:#005162}.a{font-size:34px;font-weight:800;color:#0095A8;margin:10px 0 22px}
button{width:100%;padding:13px;border-radius:12px;border:0;font-size:16px;font-weight:700;cursor:pointer;margin-top:10px}
.ok{background:#0095A8;color:#fff}.no{background:#fff;color:#0095A8;border:2px solid #0095A8}small{display:block;margin-top:14px;color:#5b8f95}</style>
<div class="c"><h1>VNPay Sandbox</h1><p>Mã giao dịch ${req.params.txn}</p><div class="a">${Number(t.amount).toLocaleString('vi-VN')} đ</div>
<button class="ok" onclick="go('ok')">Thanh toán thành công</button><button class="no" onclick="go('fail')">Giả lập thanh toán thất bại</button>
<small>Trang giả lập cổng thanh toán, dùng cho đồ án.</small></div>
<script>async function go(r){await fetch('/ext/vnpay/complete/${req.params.txn}?result='+r,{method:'POST'});location.href='/#/appointments';}</script></html>`);
});
app.post('/vnpay/complete/:txn', wrap(async (req, res) => {
  const t = txns.get(req.params.txn);
  if (!t) throw new HttpError(404, 'NOT_FOUND');
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
