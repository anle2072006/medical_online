'use strict';
// Chay toan bo he thong tren may (can RabbitMQ dang chay). Dung khi khong co Docker.
const { spawn } = require('node:child_process');
const path = require('node:path');
const names = ['mock-externals', 'identity', 'scheduling', 'billing', 'records', 'tele', 'notify', 'gateway'];
const procs = names.map((n) => {
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'services', n, 'index.js')], { stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
  p.on('exit', (c) => console.log(`[run-all] ${n} thoat (${c})`));
  return p;
});
const stop = () => { procs.forEach((p) => p.kill()); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
