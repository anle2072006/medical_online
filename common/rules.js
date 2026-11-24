'use strict';
// Logic nghiep vu loi, tach khoi database de kiem thu don vi (node --test) ma khong can MongoDB/RabbitMQ.
// scheduling/index.js dung lai cac ham nay, nen test o day la test dung ma that dang chay.

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const localDate = (date, hhmm) => new Date(`${date}T${hhmm}:00`);

// ----- 5 luat duyet ca (thu tu kiem tra co y nghia: luat dau tien vi pham duoc tra ve) -----
const REJECT = { NOT_VERIFIED: 'DOCTOR_NOT_VERIFIED', OUT_OF_HOURS: 'OUT_OF_HOURS', OVERLAP: 'SHIFT_OVERLAP', OVER_LIMIT: 'OVER_LIMIT', TOO_LATE: 'TOO_LATE' };
const OPEN = '07:00', CLOSE = '20:00', MAX_DAY_MIN = 480, MIN_LEAD_MS = 24 * 36e5;

// Lan dien ra dau tien cua ca: ngay >= startDate co dung thu `weekday`.
function firstOccurrence(shift) {
  const d = new Date(`${shift.startDate}T00:00:00`);
  while (d.getDay() !== shift.weekday) d.setDate(d.getDate() + 1);
  return localDate(ymd(d), shift.startTime);
}

// doctorStatus: trang thai ho so bac si; sameDay: cac ca APPROVED cung thu cua bac si; now: moc thoi gian (ms).
function checkShiftRules({ doctorStatus, shift, sameDay = [], now = Date.now() }) {
  if (doctorStatus !== 'active') return REJECT.NOT_VERIFIED;
  if (shift.startTime < OPEN || shift.endTime > CLOSE || shift.startTime >= shift.endTime) return REJECT.OUT_OF_HOURS;
  if (sameDay.some((s) => shift.startTime < s.end_time && s.start_time < shift.endTime)) return REJECT.OVERLAP;
  const total = sameDay.reduce((m, s) => m + toMin(s.end_time) - toMin(s.start_time), 0) + toMin(shift.endTime) - toMin(shift.startTime);
  if (total > MAX_DAY_MIN) return REJECT.OVER_LIMIT;
  if (firstOccurrence(shift) - now < MIN_LEAD_MS) return REJECT.TOO_LATE;
  return null;
}

// ----- Ty le hoan tien khi huy: >=24h: 100%, tu 2h den duoi 24h: 50%, duoi 2h: 0% -----
function refundPercent(startAtMs, now = Date.now()) {
  const hours = (startAtMs - now) / 36e5;
  return hours >= 24 ? 100 : hours >= 2 ? 50 : 0;
}
const refundAmount = (amount, percent) => Math.round((amount * percent) / 100);

// ----- FSM lich hen: bang chuyen trang thai hop le (khop voi cac lenh transition() trong scheduling) -----
const APPT_FSM = {
  pending: ['confirmed', 'failed', 'cancelled', 'refunding'],
  failed: ['pending', 'failed', 'confirmed', 'cancelled', 'refunding'],
  confirmed: ['in_progress', 'completed', 'no_show', 'cancelled', 'rescheduled'],
  rescheduled: ['confirmed', 'cancelled'],
  in_progress: ['completed'],
  cancelled: ['refunding'],
  refunding: ['refunded'],
  completed: [], no_show: [], refunded: [],
};
const canTransition = (from, to) => (APPT_FSM[from] || []).includes(to);
const TERMINAL = Object.keys(APPT_FSM).filter((s) => APPT_FSM[s].length === 0);

// ----- Giu cho bang optimistic locking: chi thanh cong khi slot con AVAILABLE dung version da doc -----
// `slots` la collection co ham update(filter, update) tra ve so ban ghi khop (xem common/index.js wrapCol).
async function holdSlot(slots, slot, apptId) {
  const n = await slots.update({ id: slot.id, status: 'AVAILABLE', version: slot.version }, { $set: { status: 'HELD', hold_appt: apptId }, $inc: { version: 1 } });
  return n > 0;
}

module.exports = { REJECT, firstOccurrence, checkShiftRules, refundPercent, refundAmount, APPT_FSM, canTransition, TERMINAL, holdSlot };
