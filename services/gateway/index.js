'use strict';
// API Gateway: diem vao duy nhat. Phuc vu giao dien, kiem tra JWT, dinh tuyen toi tung service, gioi han tan suat.
const path = require('node:path');
const C = require('../../common');
const { CONFIG, auth, wrap } = C;

const ROUTES = { identity: CONFIG.urls.identity, scheduling: CONFIG.urls.scheduling, billing: CONFIG.urls.billing, records: CONFIG.urls.records, tele: CONFIG.urls.tele, notify: CONFIG.urls.notify };
const PUBLIC = [['POST', '/api/identity/register'], ['POST', '/api/identity/login'], ['GET', '/api/identity/specialties']];
const hits = new Map();

const app = C.express();
app.use((req, res, next) => { // gioi han 300 yeu cau moi phut moi dia chi
  const k = req.ip; const now = Date.now(); const h = (hits.get(k) || []).filter((t) => now - t < 60000);
  h.push(now); hits.set(k, h);
  if (h.length > 300) return res.status(429).json({ error: 'RATE_LIMITED', message: 'Bạn thao tác quá nhanh, vui lòng thử lại sau ít phút.' });
  next();
});
app.use(C.express.json({ limit: '1mb' }));

async function forward(req, res, base, rest) {
  const url = `${base}${rest}`;
  const headers = { 'content-type': 'application/json' };
  if (req.headers.authorization) headers.authorization = req.headers.authorization;
  try {
    const r = await fetch(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body || {}), signal: AbortSignal.timeout(10000) });
    res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.status(502).json({ error: 'SERVICE_UNAVAILABLE', message: 'Dịch vụ đang tạm thời không phản hồi, vui lòng thử lại sau.' });
  }
}

app.get('/api/health', wrap(async (req, res) => {
  const out = {};
  await Promise.all(Object.entries({ ...ROUTES, mock: CONFIG.urls.mock }).map(async ([k, u]) => { try { const r = await fetch(`${u}/health`, { signal: AbortSignal.timeout(2000) }); out[k] = r.ok ? 'up' : 'down'; } catch { out[k] = 'down'; } }));
  res.json({ gateway: 'up', services: out });
}));

// He thong ben ngoai gia lap (trang thanh toan VNPay): khong can dang nhap.
app.all('/ext/*', (req, res) => forward(req, res, CONFIG.urls.mock, req.originalUrl.replace('/ext', '')));

app.all('/api/:service/*', (req, res, next) => {
  const base = ROUTES[req.params.service];
  if (!base) return res.status(404).json({ error: 'UNKNOWN_SERVICE' });
  const rest = req.originalUrl.replace(`/api/${req.params.service}`, '');
  if (rest.startsWith('/internal') || rest.startsWith('/webhooks')) return res.status(404).json({ error: 'NOT_FOUND' }); // khong lo ra ngoai
  const isPublic = PUBLIC.some(([m, p]) => m === req.method && req.path === p);
  if (isPublic) return forward(req, res, base, rest);
  auth()(req, res, () => forward(req, res, base, rest)); // kiem tra JWT o gateway, moi service kiem tra lai
});

app.use(C.express.static(path.join(__dirname, '..', '..', 'frontend')));
C.finish(app, 'gateway', Number(process.env.PORT || 8080));
