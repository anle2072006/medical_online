'use strict';
// Sinh OpenAPI 3 tu docs/api-catalog.js:   node scripts/build-openapi.js   (dau ra: docs/openapi/<service>.json + docs/api-catalog.md)
const fs = require('node:fs');
const path = require('node:path');
const { SERVICES, EVENTS } = require('../docs/api-catalog');
const out = path.join(__dirname, '..', 'docs', 'openapi');
fs.mkdirSync(out, { recursive: true });

const props = (b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, { type: 'string', description: String(v) }]));
function spec(name, s) {
  const paths = {};
  for (const e of s.endpoints) {
    if (e.auth === 'internal') continue; // duong noi bo khong lo ra ngoai gateway, khong dua vao tai lieu goi thu
    const p = `/api/${name}${e.p.replace(/:(\w+)/g, '{$1}')}`;
    const op = { summary: e.sum, tags: [s.title], operationId: `${e.m.toLowerCase()}_${name}_${e.p.replace(/[^\w]+/g, '_')}`, parameters: [...(e.p.match(/:(\w+)/g) || []).map((x) => ({ name: x.slice(1), in: 'path', required: true, schema: { type: 'string' } }))], responses: { 200: { description: e.res || 'Thanh cong' } } };
    if (e.auth !== 'public') { op.security = [{ bearerAuth: [] }]; op.description = `Vai tro: ${e.auth === 'any' ? 'moi nguoi dung da dang nhap' : e.auth}.`; op.responses[401] = { description: 'UNAUTHORIZED' }; if (e.auth !== 'any') op.responses[403] = { description: 'FORBIDDEN' }; } else op.security = [];
    if (e.body) op.requestBody = { required: true, content: { 'application/json': { schema: { type: 'object', properties: props(e.body) } } } };
    for (const x of e.err || []) op.responses[x.status] = { description: [op.responses[x.status] && op.responses[x.status].description, x.code].filter(Boolean).join(', ') };
    if (e.m === 'POST' && /^201/.test(e.res || '')) op.responses[201] = { description: e.res };
    (paths[p] = paths[p] || {})[e.m.toLowerCase()] = op;
  }
  return { openapi: '3.0.3', info: { title: `SINA Clinic - ${s.title}`, version: '1.0.0', description: s.desc + ' Moi loi tra ve dang { error: MA_LOI, message }.' }, servers: [{ url: '/' }], components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } }, paths };
}
const index = [];
for (const [name, s] of Object.entries(SERVICES)) { fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(spec(name, s), null, 2)); index.push({ name: s.title, url: `/docs/openapi/${name}.json` }); }
fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify(index, null, 2));

let md = '# Danh muc API va su kien\n\n(Sinh tu docs/api-catalog.js bang scripts/build-openapi.js)\n\n';
for (const [name, s] of Object.entries(SERVICES)) {
  md += `## ${s.title} (cong ${s.port}, qua gateway: /api/${name}/...)\n\n| Method | Duong dan | Quyen | Mo ta |\n|---|---|---|---|\n`;
  for (const e of s.endpoints) md += `| ${e.m} | ${e.p} | ${e.auth} | ${e.sum} |\n`;
  md += '\n';
}
md += '## Su kien (RabbitMQ topic exchange clinic.events)\n\n| Su kien | Phat boi | Nghe boi | Y nghia |\n|---|---|---|---|\n';
for (const [t, pub, subs, d] of EVENTS) md += `| ${t} | ${pub} | ${subs.join(', ') || '-'} | ${d} |\n`;
fs.writeFileSync(path.join(__dirname, '..', 'docs', 'api-catalog.md'), md);
console.log(`Da sinh ${index.length} dac ta OpenAPI + docs/api-catalog.md`);
