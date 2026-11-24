'use strict';
// Phat lai su kien trong dead-letter queue (B10).
//   node scripts/replay-dlq.js                 xem va phat lai tat ca <service>.dlq
//   node scripts/replay-dlq.js --service=billing   chi mot service
//   node scripts/replay-dlq.js --dry-run       chi liet ke, khong phat lai
// Su kien duoc dua thang vao hang doi cua DUNG service da loi (khong gui lai cho service khac nen khong sinh trung lap).
// Handler cua cac service deu idempotent, nen phat lai nhieu lan van an toan. Chay sau khi da sua nguyen nhan loi.
const amqp = require('amqplib');
const URL = process.env.RABBITMQ_URL || 'amqp://localhost';
const SERVICES = ['identity', 'scheduling', 'billing', 'records', 'tele', 'notify'];
const only = (process.argv.find((a) => a.startsWith('--service=')) || '').split('=')[1];
const dry = process.argv.includes('--dry-run');

(async () => {
  const conn = await amqp.connect(URL); const ch = await conn.createChannel();
  let total = 0;
  for (const svc of only ? [only] : SERVICES) {
    if (!SERVICES.includes(svc)) { console.error(`Service khong hop le: ${svc}`); process.exit(1); }
    const dlq = `${svc}.dlq`; const q = `${svc}.q`;
    const info = await ch.checkQueue(dlq).catch(() => null);
    if (!info) { console.log(`${dlq}: chua co`); continue; }
    console.log(`${dlq}: ${info.messageCount} su kien`);
    const held = [];
    for (;;) { const m = await ch.get(dlq, { noAck: false }); if (!m) break; held.push(m); }
    for (const m of held) {
      const e = JSON.parse(m.content.toString());
      console.log(`  ${dry ? '[dry-run] ' : ''}${e.type}  id=${e.id}  luc ${e.at}`);
      if (dry) { ch.nack(m, false, true); continue; }   // tra lai DLQ
      ch.sendToQueue(q, m.content, { persistent: true, contentType: 'application/json' }); // vao thang hang doi cua service
      ch.ack(m); total++;
    }
  }
  console.log(dry ? 'Che do dry-run: khong thay doi gi.' : `Da phat lai ${total} su kien.`);
  await ch.close(); await conn.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
