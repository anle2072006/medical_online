'use strict';
// Medical Record (records_db, MongoDB): benh an (FHIR rut gon), don thuoc dien tu, nhat ky truy cap.
// Don thuoc chi la don dien tu co ma: benh nhan tu mang don den co so ban thuoc gan nhat de nhan thuoc.
const C = require('../../common');
const { uid, nowIso, HttpError, wrap, auth, log } = C;

let bus, apptsCache, records, drugs, prescriptions, accessLogs;
const DRUGS = ['Paracetamol 500mg|viên', 'Amoxicillin 500mg|viên', 'Cetirizine 10mg|viên', 'Omeprazole 20mg|viên', 'Vitamin C 500mg|viên', 'Ibuprofen 400mg|viên', 'Loratadine 10mg|viên', 'Oresol|gói', 'Metformin 500mg|viên', 'Salbutamol|ống hít', 'Natri clorid 0,9%|chai', 'Kem bôi Hydrocortisone 1%|tuýp'];

const audit = (patientId, actor, action) => accessLogs.insert({ patient_id: patientId, actor_id: actor.id, actor_name: actor.name, action, at: nowIso() });
const rxView = (p) => ({ id: p.id, code: p.code, status: p.status, appointmentId: p.appointment_id, createdAt: p.created_at, collectedAt: p.collected_at || null, items: p.items });
async function recordView(r) {
  const a = (await apptsCache.get({ appointment_id: r.appointment_id })) || {};
  const rx = await prescriptions.get({ record_id: r.id });
  return {
    id: r.id, appointmentId: r.appointment_id, date: a.date, start: a.start, doctorName: a.doctor_name, patientName: a.patient_name, symptoms: r.symptoms, diagnosis: r.diagnosis, notes: r.notes, createdAt: r.created_at,
    fhir: { encounter: r.fhir, medicationRequests: rx ? rx.items.map((i) => ({ resourceType: 'MedicationRequest', status: 'active', intent: 'order', medicationCodeableConcept: { text: i.drugName }, subject: { reference: `Patient/${r.patient_id}` }, dosageInstruction: [{ text: i.dosage }], dispenseRequest: { quantity: { value: i.quantity } } })) : [] },
    prescription: rx ? rxView(rx) : null,
  };
}

async function main() {
  const db = await C.openDb('records', {
    appts: [[{ appointment_id: 1 }, { unique: true }], [{ doctor_id: 1, patient_id: 1 }]],
    records: [[{ id: 1 }, { unique: true }], [{ appointment_id: 1 }, { unique: true }], [{ patient_id: 1 }]],
    drugs: [[{ id: 1 }, { unique: true }]],
    prescriptions: [[{ id: 1 }, { unique: true }], [{ code: 1 }, { unique: true }], [{ patient_id: 1 }], [{ record_id: 1 }]],
    access_logs: [[{ patient_id: 1 }]],
  });
  apptsCache = db.col('appts'); records = db.col('records'); drugs = db.col('drugs'); prescriptions = db.col('prescriptions'); accessLogs = db.col('access_logs');
  if (!(await drugs.count())) for (const [i, s] of DRUGS.entries()) { const [name, unit] = s.split('|'); await drugs.insertIgnore({ id: i + 1, name, unit }); }
  bus = await C.connectBus('records');
  const app = C.createApp('records');

  app.get('/drugs', auth(), wrap(async (req, res) => res.json(await drugs.all({}, { sort: { name: 1 } }))));

  // Bac si ket thuc buoi kham: ghi benh an + ke don dien tu.
  app.post('/consultations/:appointmentId/complete', auth('doctor'), wrap(async (req, res) => {
    const a = await apptsCache.get({ appointment_id: req.params.appointmentId });
    if (!a || a.doctor_id !== req.user.id) throw new HttpError(404, 'NOT_FOUND', 'Không tìm thấy lịch hẹn của bạn.');
    if (a.status !== 'in_progress') throw new HttpError(409, 'NOT_IN_PROGRESS', 'Chỉ ghi bệnh án khi buổi khám đang diễn ra (cả hai đã vào phòng).');
    const { symptoms, diagnosis, notes, items = [] } = req.body || {};
    if (!symptoms || !diagnosis) throw new HttpError(400, 'MISSING_FIELDS', 'Cần nhập triệu chứng và chẩn đoán.');
    const ids = [...new Set(items.map((i) => Number(i.drugId)))];
    const found = ids.length ? await drugs.all({ id: { $in: ids } }) : [];
    if (found.length !== ids.length) throw new HttpError(400, 'UNKNOWN_DRUG', 'Thuốc không có trong danh mục.');
    // Chuyen in_progress -> completed nguyen tu: dam bao mot buoi kham chi duoc ghi mot lan.
    if (!(await apptsCache.claim({ appointment_id: a.appointment_id, status: 'in_progress' }, { $set: { status: 'completed' } }))) throw new HttpError(409, 'NOT_IN_PROGRESS', 'Buổi khám đã được ghi bệnh án.');
    const id = uid();
    const fhir = { resourceType: 'Encounter', status: 'finished', class: { code: 'VR', display: 'virtual' }, subject: { reference: `Patient/${a.patient_id}`, display: a.patient_name }, participant: [{ individual: { reference: `Practitioner/${a.doctor_id}`, display: a.doctor_name } }], appointment: [{ reference: `Appointment/${a.appointment_id}` }], reasonCode: [{ text: symptoms }], diagnosis: [{ condition: { display: diagnosis } }] };
    let rx = null;
    try {
      await records.insert({ id, appointment_id: a.appointment_id, patient_id: a.patient_id, doctor_id: a.doctor_id, symptoms, diagnosis, notes: notes || '', fhir, created_at: nowIso() });
      if (items.length) {
        rx = { id: uid(), code: `RX-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, record_id: id, appointment_id: a.appointment_id, patient_id: a.patient_id, doctor_id: a.doctor_id, status: 'ISSUED', created_at: nowIso(), collected_at: null,
          items: items.map((it) => { const d = found.find((x) => x.id === Number(it.drugId)); return { drugId: d.id, drugName: d.name, dosage: it.dosage || '', quantity: Number(it.quantity) || 1 }; }) };
        await prescriptions.insert(rx);
      }
    } catch (e) { await apptsCache.set({ appointment_id: a.appointment_id }, { status: 'in_progress' }); throw e; }
    await audit(a.patient_id, req.user, 'WRITE_RECORD');
    bus.publish('consultation.completed', { appointmentId: a.appointment_id, patientId: a.patient_id, doctorId: a.doctor_id, recordId: id, hasPrescription: !!rx });
    if (rx) bus.publish('prescription.issued', { prescriptionId: rx.id, code: rx.code, appointmentId: a.appointment_id, patientId: a.patient_id, doctorId: a.doctor_id, items: rx.items.map((i) => `${i.drugName} x${i.quantity}`) });
    res.status(201).json({ recordId: id, prescription: rx ? { id: rx.id, code: rx.code } : null });
  }));

  app.get('/records/mine', auth('patient'), wrap(async (req, res) => res.json(await Promise.all((await records.all({ patient_id: req.user.id }, { sort: { created_at: -1 } })).map(recordView)))));
  // Bac si chi xem benh nhan co lich hen voi minh, moi lan xem deu ghi nhat ky.
  app.get('/records/patient/:patientId', auth('doctor'), wrap(async (req, res) => {
    const ok = await apptsCache.get({ doctor_id: req.user.id, patient_id: req.params.patientId, status: { $in: ['confirmed', 'in_progress', 'completed'] } });
    if (!ok) throw new HttpError(403, 'NO_RELATIONSHIP', 'Bạn chỉ xem được hồ sơ của bệnh nhân có lịch hẹn với mình.');
    await audit(req.params.patientId, req.user, 'VIEW_RECORDS');
    res.json(await Promise.all((await records.all({ patient_id: req.params.patientId }, { sort: { created_at: -1 } })).map(recordView)));
  }));
  app.get('/access-logs/mine', auth('patient'), wrap(async (req, res) => res.json((await accessLogs.all({ patient_id: req.user.id }, { sort: { _id: -1 }, limit: 50 })).map((l) => ({ actorName: l.actor_name, action: l.action, at: l.at })))));
  app.get('/prescriptions/mine', auth('patient'), wrap(async (req, res) => res.json((await prescriptions.all({ patient_id: req.user.id }, { sort: { created_at: -1 } })).map(rxView))));
  // Benh nhan danh dau da nhan thuoc o co so ban thuoc.
  app.post('/prescriptions/:id/collect', auth('patient'), wrap(async (req, res) => {
    const p = await prescriptions.claim({ id: req.params.id, patient_id: req.user.id, status: 'ISSUED' }, { $set: { status: 'COLLECTED', collected_at: nowIso() } });
    if (!p) throw new HttpError(409, 'CANNOT_COLLECT', 'Đơn thuốc không tồn tại hoặc đã được đánh dấu đã nhận.');
    bus.publish('prescription.collected', { prescriptionId: p.id, code: p.code, patientId: p.patient_id });
    res.json({ ok: true });
  }));

  // ----- Su kien: giu ban sao toi thieu cua lich hen de kiem tra quyen -----
  const cache = (d) => apptsCache.upsert({ appointment_id: d.appointmentId }, { patient_id: d.patientId, patient_name: d.patientName, doctor_id: d.doctorId, doctor_name: d.doctorName, date: d.date, start: d.start }, { status: 'confirmed' });
  bus.on('appointment.confirmed', async (d) => cache(d));
  bus.on('appointment.rescheduled', async (d) => cache(d));
  bus.on('appointment.cancelled', async (d) => { await apptsCache.update({ appointment_id: d.appointmentId, status: { $ne: 'completed' } }, { $set: { status: 'cancelled' } }); });
  bus.on('consultation.started', async (d) => { await apptsCache.update({ appointment_id: d.appointmentId, status: 'confirmed' }, { $set: { status: 'in_progress' } }); });
  bus.on('patient.no_show', async (d) => { await apptsCache.update({ appointment_id: d.appointmentId, status: 'confirmed' }, { $set: { status: 'no_show' } }); });
  await bus.start();
  C.finish(app, 'records', 3004);
}
main().catch((e) => { console.error(e); process.exit(1); });
