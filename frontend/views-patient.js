'use strict';
/* Man hinh benh nhan */

// Bo chon ngay + khung gio, dung o dat lich va doi lich.
function slotUI(box, slots, onSelect) {
  const dates = [...new Set(slots.map((s) => s.date))]; let date = dates[0], sel = null;
  const draw = () => {
    box.innerHTML = dates.length ? `<div class="chips">${dates.map((d) => `<button type="button" class="chip ${d === date ? 'on' : ''}" data-d="${d}">${WD[new Date(`${d}T00:00`).getDay()]} ${dmy(d).slice(0, 5)}</button>`).join('')}</div><div class="slots">${slots.filter((s) => s.date === date).map((s) => `<button type="button" class="slot ${sel === s.id ? 'on' : ''}" data-s="${s.id}">${s.start}</button>`).join('')}</div>` : '<div class="empty">Bác sĩ này chưa có khung giờ trống.</div>';
    $$('[data-d]', box).forEach((b) => (b.onclick = () => { date = b.dataset.d; sel = null; onSelect(null); draw(); }));
    $$('[data-s]', box).forEach((b) => (b.onclick = () => { sel = b.dataset.s; onSelect(slots.find((s) => s.id === sel)); draw(); }));
  };
  draw();
}
// Cho hoa don san sang roi chuyen sang trang thanh toan VNPay.
async function goPay(apptId, minAttempts = 1) {
  toast('Đang chuyển đến cổng thanh toán...');
  for (let i = 0; i < 25; i++) {
    const inv = (await api(`/billing/invoices?appointmentId=${apptId}`))[0];
    if (inv && inv.payUrl && inv.attempts >= minAttempts) { location.href = inv.payUrl; return; }
    await new Promise((r) => setTimeout(r, 600));
  }
  toast('Hóa đơn chưa sẵn sàng, vui lòng thử lại sau ít giây.', true);
}

VIEWS.patient.dashboard = async (el) => {
  const [stats, appts] = await Promise.all([api('/scheduling/stats/me'), api('/scheduling/appointments/mine')]);
  const today = ymd(new Date());
  const up = appts.filter((a) => ['pending', 'confirmed', 'in_progress'].includes(a.status) && a.date >= today).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start)).slice(0, 5);
  const pct = stats.total ? (stats.completed * 100) / stats.total : 0;
  el.innerHTML = `<div class="grid">
<div class="card c8"><h3>Lịch hẹn sắp tới <span class="sp"></span><a class="btn sm" href="#/book">Đặt lịch mới</a></h3>${up.length ? `<div class="scroll"><table class="tbl"><tr><th>Bác sĩ</th><th>Chuyên khoa</th><th>Ngày</th><th>Giờ</th><th>Trạng thái</th></tr>${up.map((a) => `<tr><td>${esc(a.doctorName)}</td><td>${esc(a.specialty)}</td><td>${dmy(a.date)}</td><td>${a.start}</td><td>${badge(a.status)}</td></tr>`).join('')}</table></div>` : '<div class="empty">Bạn chưa có lịch hẹn sắp tới. Hãy đặt lịch khám đầu tiên.</div>'}</div>
<div class="card c4"><h3>Lịch đã khám</h3>${donut(pct)}<div class="legend"><span><i style="background:var(--t500)"></i>Đã khám ${stats.completed}</span><span><i style="background:var(--t100)"></i>Tổng ${stats.total}</span></div></div>
<div class="card c8"><h3>Lượt khám 7 ngày quanh hôm nay</h3>${lineChart(stats.series)}</div>
<div class="card c4"><h3>Tóm tắt</h3><div class="kv"><span>Hôm nay</span><b>${stats.today}</b></div><div class="kv"><span>Sắp tới</span><b>${stats.upcoming}</b></div><div class="kv"><span>Đã hủy hoặc hoàn tiền</span><b>${stats.cancelled}</b></div></div>
${await notifCard()}</div>`;
};

VIEWS.patient.book = async (el) => {
  const st = { spec: '', doctors: [], doc: null, slots: [], slot: null, appt: null, inv: null };
  const specs = await api('/identity/specialties');
  const loadDocs = async () => { st.doctors = await api(`/scheduling/doctors${st.spec ? `?specialty=${encodeURIComponent(st.spec)}` : ''}`); draw(); };
  const draw = () => {
    if (st.appt) return drawPay();
    el.innerHTML = `<div class="grid"><div class="card c12"><h3>Chọn bác sĩ</h3><div class="chips"><button class="chip ${st.spec ? '' : 'on'}" data-sp="">Tất cả</button>${specs.map((s) => `<button class="chip ${st.spec === s ? 'on' : ''}" data-sp="${esc(s)}">${esc(s)}</button>`).join('')}</div>
${st.doctors.length ? `<div class="docs">${st.doctors.map((d) => `<div class="doc ${st.doc && st.doc.id === d.id ? 'on' : ''}"><div class="avatar">${esc(initials(d.fullName))}</div><b>BS. ${esc(d.fullName)}</b><span style="color:var(--muted)">${esc(d.specialty)}</span><span>${d.nextSlot ? `Gần nhất: ${d.nextSlot.start} ${dmy(d.nextSlot.date).slice(0, 5)}<br>Phí khám: <b>${money(d.fee)}</b> &middot; ${d.availableCount} khung giờ` : '<span style="color:var(--muted)">Chưa có khung giờ trống</span>'}</span><button class="btn sm ${st.doc && st.doc.id === d.id ? '' : 'out'}" data-doc="${d.id}" ${d.nextSlot ? '' : 'disabled'}>Chọn bác sĩ</button></div>`).join('')}</div>` : '<div class="empty">Chưa có bác sĩ nào phù hợp. Bác sĩ cần được xác thực và đăng ký ca làm việc trước.</div>'}</div>
${st.doc ? `<div class="card c8"><h3>Chọn ngày và giờ khám với BS. ${esc(st.doc.fullName)}</h3><div id="sl"></div></div><div class="card c4"><h3>Thông tin đặt lịch</h3><div id="sumbox"></div></div>` : ''}</div>`;
    $$('[data-sp]').forEach((b) => (b.onclick = () => { st.spec = b.dataset.sp; st.doc = null; st.slot = null; loadDocs(); }));
    $$('[data-doc]').forEach((b) => (b.onclick = async () => { st.doc = st.doctors.find((d) => d.id === b.dataset.doc); st.slots = await api(`/scheduling/doctors/${st.doc.id}/slots`); st.slot = null; draw(); }));
    if (st.doc && $('#sl')) { slotUI($('#sl'), st.slots, (s) => { st.slot = s; drawSum(); }); drawSum(); }
  };
  const drawSum = () => {
    const box = $('#sumbox'); if (!box) return;
    box.innerHTML = st.slot ? `<div class="sum"><div><span>Bác sĩ</span><b>${esc(st.doc.fullName)}</b></div><div><span>Chuyên khoa</span><b>${esc(st.doc.specialty)}</b></div><div><span>Ngày</span><b>${dmy(st.slot.date)}</b></div><div><span>Giờ</span><b>${st.slot.start} - ${st.slot.endTime}</b></div><div><span>Hình thức</span><b>Khám video</b></div><div><span>Phí khám</span><b>${money(st.slot.fee)}</b></div></div><p style="color:var(--muted);margin:10px 0">Khung giờ được giữ 15 phút để bạn thanh toán.</p><button class="btn" style="width:100%" id="bk">Đặt lịch và thanh toán</button>` : '<div class="empty">Chọn một khung giờ để tiếp tục.</div>';
    if ($('#bk')) $('#bk').onclick = async () => {
      $('#bk').disabled = true;
      try { st.appt = await api('/scheduling/appointments', { method: 'POST', body: { slotId: st.slot.id } }); draw(); }
      catch (e) { fail(e); if (e.code === 'SLOT_TAKEN') { st.slots = await api(`/scheduling/doctors/${st.doc.id}/slots`); st.slot = null; draw(); } else $('#bk').disabled = false; }
    };
  };
  const drawPay = () => {
    const a = st.appt;
    el.innerHTML = `<div class="grid"><div class="card c6"><h3>Giữ chỗ thành công, hãy thanh toán</h3><div class="sum"><div><span>Bác sĩ</span><b>${esc(a.doctorName)}</b></div><div><span>Thời gian</span><b>${a.start} ngày ${dmy(a.date)}</b></div><div><span>Phí khám</span><b>${money(a.fee)}</b></div></div>
<p style="margin:14px 0 4px;color:var(--muted)">Thời gian giữ chỗ còn lại</p><div class="timer" id="tm">--:--</div>
<div class="steps2"><span class="done">Giữ chỗ</span><span id="s2">Tạo hóa đơn</span><span>Thanh toán</span><span>Xác nhận</span></div>
<div style="display:flex;gap:10px;margin-top:16px"><button class="btn" id="pay" disabled>Đang tạo hóa đơn...</button><button class="btn out danger" id="cn">Hủy giữ chỗ</button></div></div></div>`;
    const tick = () => { const s = Math.max(0, Math.round((new Date(a.expiresAt) - Date.now()) / 1000)); const t = $('#tm'); if (t) t.textContent = `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`; };
    tick(); every(1000, tick);
    const poll = async () => { const inv = (await api(`/billing/invoices?appointmentId=${a.id}`).catch(() => []))[0]; if (inv && inv.payUrl && $('#pay')) { $('#pay').disabled = false; $('#pay').textContent = 'Thanh toán qua VNPay'; $('#pay').onclick = () => { location.href = inv.payUrl; }; $('#s2').classList.add('done'); } };
    poll(); every(1200, poll);
    $('#cn').onclick = async () => { try { await api(`/scheduling/appointments/${a.id}/cancel`, { method: 'POST' }); st.appt = null; st.slot = null; st.slots = await api(`/scheduling/doctors/${st.doc.id}/slots`); toast('Đã hủy giữ chỗ.'); draw(); } catch (e) { fail(e); } };
  };
  await loadDocs();
};

VIEWS.patient.appointments = async (el) => {
  let open = null, sig = '';
  const rescheduleDlg = async (a) => {
    const slots = (await api(`/scheduling/doctors/${a.doctorId}/slots`)).filter((s) => s.id);
    const m = modal(`<h2>Đổi lịch với BS. ${esc(a.doctorName)}</h2><p style="color:var(--muted);margin-bottom:10px">Hiện tại: ${a.start} ngày ${dmy(a.date)}. Chọn khung giờ mới, lịch cũ chỉ được nhả khi giữ chỗ mới thành công và không cần thanh toán lại.</p><div id="sl"></div><div class="foot"><button class="btn out" id="x">Đóng</button><button class="btn" id="ok" disabled>Xác nhận đổi lịch</button></div>`);
    let pick = null; slotUI($('#sl', m), slots, (s) => { pick = s; $('#ok', m).disabled = !s; });
    $('#x', m).onclick = m.close;
    $('#ok', m).onclick = async () => { try { await api(`/scheduling/appointments/${a.id}/reschedule`, { method: 'POST', body: { slotId: pick.id } }); m.close(); toast('Đã đổi lịch.'); draw(true); } catch (e) { fail(e); } };
  };
  const cancelDlg = async (a) => {
    const d = await api(`/scheduling/appointments/${a.id}`);
    const paid = a.status === 'confirmed';
    const m = modal(`<h2>Hủy lịch khám?</h2><p>Lịch với BS. ${esc(a.doctorName)} lúc ${a.start} ngày ${dmy(a.date)}.</p><p style="margin-top:8px">${paid ? `Bạn sẽ được hoàn <b>${d.refundPercentIfCancelled}%</b> phí khám (${money((a.fee * d.refundPercentIfCancelled) / 100)}). Hủy từ 24 giờ trước giờ khám hoàn 100%, từ 2 đến 24 giờ hoàn 50%, trong 2 giờ cuối không hoàn phí.` : 'Lịch chưa thanh toán nên không phát sinh hoàn tiền.'}</p><div class="foot"><button class="btn out" id="x">Giữ lịch</button><button class="btn danger" id="ok">Xác nhận hủy</button></div>`);
    $('#x', m).onclick = m.close;
    $('#ok', m).onclick = async () => { try { await api(`/scheduling/appointments/${a.id}/cancel`, { method: 'POST' }); m.close(); toast('Đã hủy lịch.'); draw(true); } catch (e) { fail(e); } };
  };
  const draw = async (force) => {
    const list = await api('/scheduling/appointments/mine');
    const s = JSON.stringify(list); if (s === sig && !force) return; sig = s;
    const rowActs = (a) => {
      const b = [];
      if (a.status === 'pending') b.push(['pay', 'Thanh toán'], ['cancel', 'Hủy']);
      if (a.status === 'failed' && a.retryCount < 3 && new Date(a.expiresAt) > new Date()) b.push(['retry', 'Thử lại'], ['cancel', 'Hủy']);
      if (a.status === 'confirmed') b.push(['join', 'Vào phòng khám'], ['resch', 'Đổi lịch'], ['cancel', 'Hủy']);
      if (a.status === 'in_progress') b.push(['join', 'Vào phòng khám']);
      if (a.status === 'completed') b.push(['rec', 'Xem bệnh án']);
      b.push(['more', open === a.id ? 'Ẩn chi tiết' : 'Chi tiết']);
      return `<div class="act">${b.map(([k, t]) => `<button class="btn sm ${k === 'cancel' ? 'danger' : k === 'more' || k === 'resch' || k === 'rec' ? 'out' : ''}" data-a="${k}" data-id="${a.id}">${t}</button>`).join('')}</div>`;
    };
    let detail = ''; if (open) { const d = list.find((x) => x.id === open) && (await api(`/scheduling/appointments/${open}`).catch(() => null)); if (d) detail = d; }
    el.innerHTML = `<h2 class="pagetitle">Lịch hẹn của tôi</h2><div class="card"><div class="scroll">${list.length ? `<table class="tbl"><tr><th>Bác sĩ</th><th>Ngày</th><th>Giờ</th><th>Phí</th><th>Trạng thái</th><th>Thao tác</th></tr>${list.map((a) => `<tr><td><b>${esc(a.doctorName)}</b><br><small style="color:var(--muted)">${esc(a.specialty)}</small></td><td>${dmy(a.date)}</td><td>${a.start}</td><td>${money(a.fee)}</td><td>${badge(a.status)}${a.status === 'failed' ? `<br><small style="color:var(--muted)">Lần ${a.retryCount}/3</small>` : ''}${a.refundPercent && ['refunding', 'refunded'].includes(a.status) ? `<br><small style="color:var(--muted)">Hoàn ${a.refundPercent}%</small>` : ''}</td><td>${rowActs(a)}</td></tr>${detail && detail.id === a.id ? `<tr><td colspan="6"><b>Dòng thời gian của lịch hẹn</b><ul class="timeline">${detail.log.map((l) => `<li>${esc(l.from_status)} &rarr; <b>${esc(APPT_LABEL[l.to_status] || l.to_status)}</b> <small>${esc(l.reason || '')} &middot; ${new Date(l.at).toLocaleString('vi-VN')}</small></li>`).join('')}</ul></td></tr>` : ''}`).join('')}</table>` : '<div class="empty">Bạn chưa có lịch hẹn nào.</div>'}</div></div>`;
    $$('[data-a]', el).forEach((b) => (b.onclick = async () => {
      const a = list.find((x) => x.id === b.dataset.id); const k = b.dataset.a;
      try {
        if (k === 'more') { open = open === a.id ? null : a.id; draw(true); }
        else if (k === 'pay') goPay(a.id);
        else if (k === 'retry') { await api(`/scheduling/appointments/${a.id}/retry-payment`, { method: 'POST' }); goPay(a.id, a.retryCount + 1); }
        else if (k === 'join') { const r = await api(`/tele/sessions/${a.id}/join`, { method: 'POST' }); window.open(r.roomUrl, '_blank'); toast(r.doctorJoined && r.patientJoined ? 'Cả hai đã vào phòng, buổi khám bắt đầu.' : 'Bạn đã vào phòng. Đang chờ bác sĩ.'); draw(true); }
        else if (k === 'resch') rescheduleDlg(a);
        else if (k === 'cancel') cancelDlg(a);
        else if (k === 'rec') location.hash = '#/records';
      } catch (e) { fail(e); }
    }));
  };
  await draw(true); every(4000, () => draw().catch(() => {}));
};

VIEWS.patient.records = async (el) => {
  let sig = '';
  const draw = async () => {
    const [recs, logs] = await Promise.all([api('/records/records/mine'), api('/records/access-logs/mine')]);
    const s = JSON.stringify([recs, logs]); if (s === sig) return; sig = s;
    const rx = (p) => { const got = p.status === 'COLLECTED'; return `<div style="margin-top:12px"><b>Đơn thuốc ${esc(p.code)}</b> <span class="badge ${got ? '' : 'warn'}">${got ? 'Đã nhận thuốc' : 'Chưa nhận thuốc'}</span><div class="scroll"><table class="tbl" style="margin-top:6px"><tr><th>Thuốc</th><th>Liều dùng</th><th>Số lượng</th></tr>${p.items.map((i) => `<tr><td>${esc(i.drugName)}</td><td>${esc(i.dosage)}</td><td>${i.quantity}</td></tr>`).join('')}</table></div><div class="steps2"><span class="done">Đã kê đơn</span><span class="${got ? 'done' : ''}">Đã nhận thuốc</span></div>${got ? `<small style="color:var(--muted)">Nhận thuốc lúc ${new Date(p.collectedAt).toLocaleString('vi-VN')}</small>` : `<div class="banner" style="margin:10px 0 0">Hãy mang mã đơn <b>${esc(p.code)}</b> đến cơ sở bán thuốc gần nhất để nhận thuốc.</div><div class="act" style="margin-top:10px"><a class="btn sm" target="_blank" rel="noopener" href="https://www.google.com/maps/search/nh%C3%A0+thu%E1%BB%91c+g%E1%BA%A7n+t%C3%B4i">Tìm nhà thuốc gần nhất</a><button class="btn sm out" data-print="1">In đơn</button><button class="btn sm out" data-collect="${p.id}">Tôi đã nhận thuốc</button></div>`}</div>`; };
    el.innerHTML = `<h2 class="pagetitle">Bệnh án và đơn thuốc</h2><div class="grid"><div class="c8" style="display:grid;gap:18px;align-content:start">${recs.length ? recs.map((r) => `<div class="card"><h3>${dmy(r.date)} &middot; ${r.start} <span class="sp"></span><span class="badge">BS. ${esc(r.doctorName)}</span></h3><div class="kv"><span>Triệu chứng</span><b>${esc(r.symptoms)}</b></div><div class="kv"><span>Chẩn đoán</span><b>${esc(r.diagnosis)}</b></div>${r.notes ? `<p style="margin:6px 0;color:var(--t700)">Dặn dò: ${esc(r.notes)}</p>` : ''}${r.prescription ? rx(r.prescription) : '<p style="color:var(--muted)">Không có đơn thuốc.</p>'}<details style="margin-top:10px"><summary style="cursor:pointer;color:var(--t500);font-weight:700">Dữ liệu chuẩn FHIR (Encounter, MedicationRequest)</summary><pre class="json">${esc(JSON.stringify(r.fhir, null, 2))}</pre></details></div>`).join('') : '<div class="card"><div class="empty">Chưa có bệnh án. Bệnh án xuất hiện sau khi bạn hoàn tất một buổi khám.</div></div>'}</div>
<div class="card c4"><h3>Ai đã truy cập hồ sơ của bạn</h3>${logs.length ? `<ul class="list">${logs.map((l) => `<li><div>${esc(l.actorName)}<small>${l.action === 'VIEW_RECORDS' ? 'Đã xem hồ sơ' : 'Đã ghi bệnh án'} &middot; ${ago(l.at)}</small></div></li>`).join('')}</ul>` : '<div class="empty">Chưa có ai truy cập.</div>'}</div></div>`;
    $$('[data-print]', el).forEach((b) => (b.onclick = () => window.print()));
    $$('[data-collect]', el).forEach((b) => (b.onclick = async () => { try { await api(`/records/prescriptions/${b.dataset.collect}/collect`, { method: 'POST' }); toast('Đã ghi nhận bạn nhận thuốc.'); sig = ''; draw(); } catch (e) { fail(e); } }));
  };
  await draw(); every(4000, () => draw().catch(() => {}));
};
