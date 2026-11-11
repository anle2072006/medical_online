'use strict';
// Billing (billing_db, MongoDB): hoa don, thanh toan VNPay sandbox, webhook idempotent, hoan tien.
const C = require('../../common');
const { CONFIG, uid, nowIso, sign, HttpError, wrap, auth, callJson, log } = C;

let bus, invoices, payments, refunds, processedIpn;

async function newPaymentAttempt(inv) {
  const attempt = inv.attempts + 1;
  const txnRef = `${inv.id.slice(0, 8)}-${attempt}`;
  const r = await callJson(`${CONFIG.urls.mock}/vnpay/create`, { method: 'POST', body: { txnRef, amount: inv.amount, ipnUrl: `${CONFIG.urls.billing}/webhooks/vnpay-ipn` } });
  await payments.insertIgnore({ id: uid(), invoice_id: inv.id, txn_ref: txnRef, status: 'CREATED', pay_url: r.payUrl, created_at: nowIso() });
  await invoices.set({ id: inv.id }, { attempts: attempt, status: 'PENDING' });
}

async function main() {
  const db = await C.openDb('billing', {
    invoices: [[{ id: 1 }, { unique: true }], [{ appointment_id: 1 }, { unique: true }], [{ patient_id: 1 }]],
    payments: [[{ txn_ref: 1 }, { unique: true }], [{ invoice_id: 1, created_at: -1 }]],
    refunds: [[{ invoice_id: 1 }]],
    processed_ipn: [[{ idempotency_key: 1 }, { unique: true }]],
  });
  invoices = db.col('invoices'); payments = db.col('payments'); refunds = db.col('refunds'); processedIpn = db.col('processed_ipn');
  bus = await C.connectBus('billing');
  const app = C.createApp('billing');

  const view = async (i) => {
    const p = await payments.get({ invoice_id: i.id }, { sort: { created_at: -1, _id: -1 } });
    return { id: i.id, appointmentId: i.appointment_id, amount: i.amount, status: i.status, attempts: i.attempts, payUrl: p && p.status === 'CREATED' ? p.pay_url : null };
  };
  app.get('/invoices', auth('patient'), wrap(async (req, res) => {
    const f = req.query.appointmentId ? { appointment_id: req.query.appointmentId, patient_id: req.user.id } : { patient_id: req.user.id };
    res.json(await Promise.all((await invoices.all(f, { sort: { created_at: -1 } })).map(view)));
  }));

  // Webhook tu cong thanh toan: xac thuc chu ky + idempotency (cong thanh toan co the goi nhieu lan).
  app.post('/webhooks/vnpay-ipn', wrap(async (req, res) => {
    const { txnRef, status, amount, signature } = req.body || {};
    if (signature !== sign(`${txnRef}|${status}|${amount}`)) throw new HttpError(401, 'BAD_SIGNATURE');
    const key = `${txnRef}:${status}`;
    if (!(await processedIpn.insertIgnore({ idempotency_key: key, at: nowIso() }))) { log('billing', `IPN trung ${key}: bo qua`); return res.json({ duplicate: true }); }
    const pay = await payments.get({ txn_ref: txnRef });
    if (!pay) throw new HttpError(404, 'TXN_NOT_FOUND');
    const inv = await invoices.get({ id: pay.invoice_id });
    if (status === '00') {
      await payments.set({ id: pay.id }, { status: 'SUCCESS' });
      await invoices.set({ id: inv.id }, { status: 'PAID' });
      bus.publish('payment.completed', { appointmentId: inv.appointment_id, invoiceId: inv.id, patientId: inv.patient_id, amount: inv.amount, txnRef });
    } else {
      await payments.set({ id: pay.id }, { status: 'FAILED' });
      await invoices.update({ id: inv.id, status: { $ne: 'PAID' } }, { $set: { status: 'FAILED' } });
      bus.publish('payment.failed', { appointmentId: inv.appointment_id, invoiceId: inv.id, patientId: inv.patient_id, attempt: inv.attempts });
    }
    res.json({ ok: true });
  }));

  // ----- Su kien -----
  bus.on('appointment.requested', async (d) => {
    await invoices.insertIgnore({ id: uid(), appointment_id: d.appointmentId, patient_id: d.patientId, amount: d.amount, status: 'PENDING', attempts: 0, created_at: nowIso() });
    const inv = await invoices.get({ appointment_id: d.appointmentId });
    if (inv.attempts === 0) await newPaymentAttempt(inv);
  });
  bus.on('payment.retry_requested', async (d) => {
    const inv = await invoices.get({ appointment_id: d.appointmentId });
    if (inv && inv.status === 'FAILED') await newPaymentAttempt(inv);
  });
  const voidInvoice = async (d) => { await invoices.update({ appointment_id: d.appointmentId, status: { $in: ['PENDING', 'FAILED'] } }, { $set: { status: 'VOID' } }); };
  bus.on('appointment.failed', voidInvoice);
  bus.on('appointment.cancelled', async (d) => { if (!d.paid) await voidInvoice(d); });
  bus.on('refund.requested', async (d) => {
    const inv = await invoices.get({ appointment_id: d.appointmentId });
    const done = (amount) => bus.publish('refund.completed', { appointmentId: d.appointmentId, patientId: inv && inv.patient_id, amount, percent: d.percent });
    if (!inv || !['PAID', 'REFUNDING'].includes(inv.status)) return done(0); // chua tra tien hoac da hoan roi
    const amount = Math.round((inv.amount * d.percent) / 100);
    const pay = await payments.get({ invoice_id: inv.id, status: 'SUCCESS' });
    await invoices.set({ id: inv.id }, { status: 'REFUNDING' });
    const r = await callJson(`${CONFIG.urls.mock}/vnpay/refund`, { method: 'POST', body: { txnRef: pay.txn_ref, amount } }); // loi -> bus thu lai, qua so lan -> dead-letter queue
    await refunds.insert({ id: uid(), invoice_id: inv.id, percent: d.percent, amount, status: 'DONE', refund_ref: r.refundRef, created_at: nowIso() });
    await invoices.set({ id: inv.id }, { status: 'REFUNDED' });
    done(amount);
  });
  await bus.start();
  C.finish(app, 'billing', 3003);
}
main().catch((e) => { console.error(e); process.exit(1); });
