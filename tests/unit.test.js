'use strict';
// Unit test logic loi (khong can MongoDB/RabbitMQ). Chay: npm run test:unit
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../common/rules');

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const NOW = new Date('2026-11-22T09:00:00').getTime(); // Chu nhat
const day = (n) => { const d = new Date(NOW); d.setDate(d.getDate() + n); return d; };
// Ca hop le mac dinh: thu 2 hang tuan, 08:00-11:00, bat dau tu ngay mai +2 de >24h
const mkShift = (over = {}) => ({ weekday: day(3).getDay(), startTime: '08:00', endTime: '11:00', startDate: ymd(day(3)), ...over });
const rule = (over = {}, ctx = {}) => R.checkShiftRules({ doctorStatus: 'active', shift: mkShift(over), sameDay: [], now: NOW, ...ctx });

// ===== 5 luat duyet ca =====
test('luat 0: ca hop le duoc duyet', () => assert.equal(rule(), null));
for (const st of ['registered', 'verifying', 'rejected', 'suspended', 'on_leave', 'deactivated', undefined]) {
  test(`DOCTOR_NOT_VERIFIED khi ho so bac si la ${st}`, () => assert.equal(rule({}, { doctorStatus: st }), 'DOCTOR_NOT_VERIFIED'));
}
test('OUT_OF_HOURS: bat dau truoc 07:00', () => assert.equal(rule({ startTime: '06:30' }), 'OUT_OF_HOURS'));
test('OUT_OF_HOURS: ket thuc sau 20:00', () => assert.equal(rule({ endTime: '20:30' }), 'OUT_OF_HOURS'));
test('OUT_OF_HOURS: gio bat dau >= gio ket thuc', () => assert.equal(rule({ startTime: '10:00', endTime: '10:00' }), 'OUT_OF_HOURS'));
test('07:00 den 20:00 nam trong gio hoat dong (nhung 13h vuot gioi han 8h)', () => assert.equal(rule({ startTime: '07:00', endTime: '20:00' }), 'OVER_LIMIT'));
test('SHIFT_OVERLAP: giao nhau voi ca cung thu', () => assert.equal(rule({ startTime: '10:00', endTime: '12:00' }, { sameDay: [{ start_time: '08:00', end_time: '11:00' }] }), 'SHIFT_OVERLAP'));
test('ca ke nhau (11:00 den 12:00) khong bi coi la trung', () => assert.equal(rule({ startTime: '11:00', endTime: '12:00' }, { sameDay: [{ start_time: '08:00', end_time: '11:00' }] }), null));
test('OVER_LIMIT: tong hon 8 gio trong ngay', () => assert.equal(rule({ startTime: '14:00', endTime: '20:00' }, { sameDay: [{ start_time: '08:00', end_time: '11:00' }] }), 'OVER_LIMIT')); // 3h + 6h = 9h
test('dung 8 gio van duoc duyet', () => assert.equal(rule({ startTime: '15:00', endTime: '20:00' }, { sameDay: [{ start_time: '08:00', end_time: '11:00' }] }), null));
test('TOO_LATE: lan dau dien ra chua toi 24 gio', () => assert.equal(rule({ weekday: day(0).getDay(), startDate: ymd(day(0)), startTime: '15:00', endTime: '17:00' }), 'TOO_LATE'));
test('dung 24 gio truoc van duoc duyet', () => assert.equal(rule({ weekday: day(1).getDay(), startDate: ymd(day(1)), startTime: '09:00', endTime: '11:00' }), null));
test('thu tu uu tien: chua xac thuc thang ca ngoai gio', () => assert.equal(rule({ startTime: '05:00' }, { doctorStatus: 'rejected' }), 'DOCTOR_NOT_VERIFIED'));
test('thu tu uu tien: ngoai gio thang trung ca', () => assert.equal(rule({ startTime: '05:00' }, { sameDay: [{ start_time: '04:00', end_time: '09:00' }] }), 'OUT_OF_HOURS'));
test('firstOccurrence tim dung thu ke tu startDate', () => {
  const s = mkShift({ startDate: ymd(day(0)), weekday: day(2).getDay() });
  assert.equal(ymd(R.firstOccurrence(s)), ymd(day(2)));
});

// ===== Ty le hoan tien =====
const H = 36e5;
test('huy truoc >= 24h hoan 100%', () => { assert.equal(R.refundPercent(NOW + 24 * H, NOW), 100); assert.equal(R.refundPercent(NOW + 72 * H, NOW), 100); });
test('huy tu 2h den duoi 24h hoan 50%', () => { assert.equal(R.refundPercent(NOW + 24 * H - 1, NOW), 50); assert.equal(R.refundPercent(NOW + 2 * H, NOW), 50); });
test('huy trong 2h cuoi khong hoan', () => { assert.equal(R.refundPercent(NOW + 2 * H - 1, NOW), 0); assert.equal(R.refundPercent(NOW + 1, NOW), 0); });
test('qua gio hen khong hoan', () => assert.equal(R.refundPercent(NOW - H, NOW), 0));
test('so tien hoan lam tron', () => { assert.equal(R.refundAmount(200000, 50), 100000); assert.equal(R.refundAmount(200001, 50), 100001); assert.equal(R.refundAmount(200000, 100), 200000); assert.equal(R.refundAmount(200000, 0), 0); });

// ===== FSM lich hen =====
test('duong di hanh phuc: pending > confirmed > in_progress > completed', () => {
  assert.ok(R.canTransition('pending', 'confirmed') && R.canTransition('confirmed', 'in_progress') && R.canTransition('in_progress', 'completed'));
});
test('Saga hoan tien: cancelled > refunding > refunded', () => {
  assert.ok(R.canTransition('confirmed', 'cancelled') && R.canTransition('cancelled', 'refunding') && R.canTransition('refunding', 'refunded'));
});
test('doi lich: confirmed > rescheduled > confirmed', () => assert.ok(R.canTransition('confirmed', 'rescheduled') && R.canTransition('rescheduled', 'confirmed')));
test('thanh toan loi roi thu lai: pending > failed > pending', () => assert.ok(R.canTransition('pending', 'failed') && R.canTransition('failed', 'pending')));
test('trang thai cuoi khong chuyen di dau duoc', () => {
  assert.deepEqual([...R.TERMINAL].sort(), ['completed', 'no_show', 'refunded']);
  for (const t of R.TERMINAL) for (const to of Object.keys(R.APPT_FSM)) assert.equal(R.canTransition(t, to), false, `${t} > ${to}`);
});
test('khong the nhay coc', () => {
  assert.equal(R.canTransition('pending', 'completed'), false);
  assert.equal(R.canTransition('pending', 'in_progress'), false);
  assert.equal(R.canTransition('completed', 'cancelled'), false);
  assert.equal(R.canTransition('refunded', 'refunding'), false);
  assert.equal(R.canTransition('in_progress', 'cancelled'), false);
});
test('moi trang thai dich deu la trang thai da khai bao', () => {
  for (const [from, tos] of Object.entries(R.APPT_FSM)) for (const to of tos) assert.ok(to in R.APPT_FSM, `${from} > ${to}`);
});

// ===== Optimistic locking: mo phong dung ngu nghia cap nhat co dieu kien nguyen tu cua MongoDB =====
function fakeSlots(initial) {
  const rows = new Map(initial.map((s) => [s.id, { ...s }]));
  return {
    rows,
    get: async (id) => ({ ...rows.get(id) }),
    update: async (f, upd) => { // doc va ghi trong cung mot buoc dong bo = nguyen tu, giong updateOne cua MongoDB tren mot document
      await Promise.resolve(); // nhuong luot de cac yeu cau dong thoi xen ke nhau
      const r = rows.get(f.id);
      if (!r || r.status !== f.status || r.version !== f.version) return 0;
      Object.assign(r, upd.$set); r.version += upd.$inc.version; return 1;
    },
  };
}
test('20 yeu cau dong thoi cung mot slot: dung 1 thanh cong', async () => {
  const slots = fakeSlots([{ id: 's1', status: 'AVAILABLE', version: 0, hold_appt: null }]);
  const snapshot = await slots.get('s1'); // ca 20 nguoi cung doc version 0
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => R.holdSlot(slots, snapshot, `a${i}`)));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(results.filter((x) => !x).length, 19);
  const row = slots.rows.get('s1');
  assert.equal(row.status, 'HELD'); assert.equal(row.version, 1); assert.match(row.hold_appt, /^a\d+$/);
});
test('slot da HELD thi nguoi den sau bi tu choi du doc dung version', async () => {
  const slots = fakeSlots([{ id: 's1', status: 'HELD', version: 3, hold_appt: 'x' }]);
  assert.equal(await R.holdSlot(slots, { id: 's1', version: 3 }, 'y'), false);
});
test('doc version cu (slot da qua tay nguoi khac roi duoc tra lai) thi bi tu choi', async () => {
  const slots = fakeSlots([{ id: 's1', status: 'AVAILABLE', version: 2, hold_appt: null }]);
  assert.equal(await R.holdSlot(slots, { id: 's1', version: 0 }, 'y'), false);
  assert.equal(await R.holdSlot(slots, { id: 's1', version: 2 }, 'y'), true);
});
test('nhieu slot khac nhau khong anh huong nhau', async () => {
  const slots = fakeSlots([0, 1, 2].map((i) => ({ id: `s${i}`, status: 'AVAILABLE', version: 0, hold_appt: null })));
  const r = await Promise.all([0, 1, 2].map((i) => R.holdSlot(slots, { id: `s${i}`, version: 0 }, `a${i}`)));
  assert.deepEqual(r, [true, true, true]);
});
