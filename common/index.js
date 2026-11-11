'use strict';
// Thu vien dung chung cho moi service: database MongoDB rieng, event bus (RabbitMQ), xac thuc JWT, tien ich HTTP.
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const amqp = require('amqplib');
const { MongoClient } = require('mongodb');

const env = process.env;
const CONFIG = {
  jwtSecret: env.JWT_SECRET || 'dev-secret-change-me',
  internalKey: env.INTERNAL_KEY || 'dev-internal-key',
  hookSecret: env.WEBHOOK_SECRET || 'dev-webhook-secret',
  demo: (env.DEMO_MODE || 'true') === 'true',
  holdMinutes: Number(env.HOLD_MINUTES || 15),
  leadMinutes: Number(env.LEAD_MINUTES || ((env.DEMO_MODE || 'true') === 'true' ? 0 : 120)),
  absenceMinutes: Number(env.ABSENCE_MINUTES || 15),
  urls: {
    identity: env.IDENTITY_URL || 'http://localhost:3001',
    scheduling: env.SCHEDULING_URL || 'http://localhost:3002',
    billing: env.BILLING_URL || 'http://localhost:3003',
    records: env.RECORDS_URL || 'http://localhost:3004',
    tele: env.TELE_URL || 'http://localhost:3005',
    notify: env.NOTIFY_URL || 'http://localhost:3006',
    mock: env.MOCK_URL || 'http://localhost:4000',
  },
};

const uid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const fromMin = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const localDate = (date, hhmm) => new Date(`${date}T${hhmm}:00`);
const sign = (text) => crypto.createHmac('sha256', CONFIG.hookSecret).update(text).digest('hex');

class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function log(service, ...a) { console.log(`[${service}]`, ...a); }

// ---------- Database rieng cho tung service (MongoDB) ----------
// Moi service mo mot database rieng `<service>_db`. Co the tro ve may chu Mongo rieng bang MONGO_URL_<SERVICE>.
function wrapCol(c) {
  const P = { projection: { _id: 0 } };
  return {
    raw: c,
    get: (f = {}, o = {}) => c.findOne(f, { ...P, ...o }),
    all: async (f = {}, { sort, limit } = {}) => { let q = c.find(f, P); if (sort) q = q.sort(sort); if (limit) q = q.limit(limit); return q.toArray(); },
    count: (f = {}) => c.countDocuments(f),
    insert: (d) => c.insertOne({ ...d }),
    insertIgnore: async (d) => { try { await c.insertOne({ ...d }); return true; } catch (e) { if (e.code === 11000) return false; throw e; } }, // trung khoa duy nhat -> false
    upsert: (f, set, onInsert) => c.updateOne(f, { $set: set, ...(onInsert ? { $setOnInsert: onInsert } : {}) }, { upsert: true }),
    set: async (f, set) => (await c.updateOne(f, { $set: set })).matchedCount,
    update: async (f, upd) => (await c.updateOne(f, upd)).matchedCount,
    updateMany: async (f, upd) => (await c.updateMany(f, upd)).modifiedCount,
    // Cap nhat nguyen tu mot document va tra ve ban ghi TRUOC khi doi (null neu khong khop): dung cho chuyen trang thai an toan khi su kien den lap.
    claim: (f, upd) => c.findOneAndUpdate(f, upd, { returnDocument: 'before', projection: { _id: 0 } }),
    del: async (f) => (await c.deleteMany(f)).deletedCount,
  };
}
async function openDb(service, indexes = {}) {
  const url = env[`MONGO_URL_${service.toUpperCase()}`] || env.MONGO_URL || 'mongodb://127.0.0.1:27017';
  let client;
  for (let i = 0; ; i++) {
    try { client = new MongoClient(url, { serverSelectionTimeoutMS: 3000 }); await client.connect(); break; }
    catch (e) { if (i > 60) throw e; log(service, 'cho MongoDB...'); await sleep(2000); }
  }
  const database = client.db(`${service}_db`);
  const cols = {};
  const db = { name: `${service}_db`, col: (n) => (cols[n] = cols[n] || wrapCol(database.collection(n))) };
  for (const [name, list] of Object.entries(indexes)) for (const [keys, opts] of list) await database.collection(name).createIndex(keys, opts || {});
  return db;
}

// ---------- Event bus (RabbitMQ topic exchange + dead-letter queue) ----------
async function connectBus(service) {
  const url = env.RABBITMQ_URL || 'amqp://localhost';
  let conn;
  for (let i = 0; ; i++) {
    try { conn = await amqp.connect(url); break; }
    catch (e) { if (i > 60) throw e; log(service, 'cho RabbitMQ...'); await sleep(2000); }
  }
  const ch = await conn.createChannel();
  await ch.assertExchange('clinic.events', 'topic', { durable: true });
  await ch.assertExchange('clinic.dlx', 'topic', { durable: true });
  const handlers = {};
  const bus = {
    publish(type, data) {
      const msg = { id: uid(), type, at: nowIso(), data };
      ch.publish('clinic.events', type, Buffer.from(JSON.stringify(msg)), { persistent: true, contentType: 'application/json' });
      log(service, '->', type);
    },
    on(type, fn) { handlers[type] = fn; },
    async start(patterns) {
      const q = `${service}.q`; const dlq = `${service}.dlq`;
      await ch.assertQueue(dlq, { durable: true });
      await ch.bindQueue(dlq, 'clinic.dlx', service);
      await ch.assertQueue(q, { durable: true, arguments: { 'x-dead-letter-exchange': 'clinic.dlx', 'x-dead-letter-routing-key': service } });
      for (const p of patterns || Object.keys(handlers)) await ch.bindQueue(q, 'clinic.events', p);
      ch.prefetch(10);
      await ch.consume(q, async (m) => {
        if (!m) return;
        const msg = JSON.parse(m.content.toString());
        const fn = handlers[msg.type] || handlers['*'];
        if (!fn) return ch.ack(m);
        for (let attempt = 1; ; attempt++) {
          try { await fn(msg.data, msg); ch.ack(m); log(service, '<-', msg.type); return; }
          catch (e) {
            log(service, `loi xu ly ${msg.type} (lan ${attempt}):`, e.message);
            if (attempt >= 3) { ch.nack(m, false, false); return; } // dua vao dead-letter queue
            await sleep(500 * attempt);
          }
        }
      });
    },
  };
  return bus;
}

// ---------- Xac thuc ----------
const signToken = (user) => jwt.sign({ id: user.id, role: user.role, name: user.full_name || user.name }, CONFIG.jwtSecret, { expiresIn: '12h' });
function auth(...roles) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    try { req.user = jwt.verify(h.startsWith('Bearer ') ? h.slice(7) : '', CONFIG.jwtSecret); }
    catch { return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Vui lòng đăng nhập lại.' }); }
    if (roles.length && !roles.includes(req.user.role)) return res.status(403).json({ error: 'FORBIDDEN', message: 'Bạn không có quyền thực hiện thao tác này.' });
    next();
  };
}
const internalOnly = (req, res, next) => (req.headers['x-internal-key'] === CONFIG.internalKey ? next() : res.status(403).json({ error: 'FORBIDDEN' }));

// ---------- Goi service khac (REST) co timeout ----------
async function callJson(url, { method = 'GET', body, headers = {}, timeout = 5000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
    const text = await r.text();
    let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!r.ok) { const e = new Error(`HTTP ${r.status} ${url}`); e.status = r.status; e.data = data; throw e; }
    return data;
  } finally { clearTimeout(t); }
}

function createApp(service) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.get('/health', (req, res) => res.json({ service, ok: true, at: nowIso() }));
  return app;
}
function finish(app, service, port) {
  app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
  app.use((err, req, res, next) => { // eslint-disable-line
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.code, message: err.message });
    log(service, 'loi:', err.stack || err.message);
    res.status(500).json({ error: 'INTERNAL', message: 'Có lỗi hệ thống, vui lòng thử lại.' });
  });
  app.listen(port, () => log(service, `dang chay o cong ${port}`));
}

module.exports = { CONFIG, uid, nowIso, sleep, pad, ymd, addDays, toMin, fromMin, localDate, sign, HttpError, wrap, log, openDb, connectBus, signToken, auth, internalOnly, callJson, createApp, finish, express };
