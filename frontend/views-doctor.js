'use strict';
/* Man hinh bac si, gom so do flow state (FSM) cua ho so bac si. */

const WORK_LABEL = { OFF_DUTY: 'Ngoài ca', AVAILABLE: 'Đang trong ca, rảnh', IN_CONSULTATION: 'Đang khám' };
const WEEKDAYS = [[1, 'Thứ Hai'], [2, 'Thứ Ba'], [3, 'Thứ Tư'], [4, 'Thứ Năm'], [5, 'Thứ Sáu'], [6, 'Thứ Bảy'], [0, 'Chủ nhật']];
const SHIFT_LABEL = { APPROVED: 'Đã duyệt', REJECTED: 'Bị từ chối', CANCELLED: 'Đã hủy', SUBMITTED: 'Đang kiểm tra' };

// So do FSM ho so bac si; trang thai hien tai duoc to dam.
function doctorFsmSvg(cur) {
  const S = { registered: [64, 40, 'Đã gửi số giấy phép'], verifying: [214, 40, 'Kiểm tra giấy phép'], active: [364, 40, 'Được nhận lịch'], suspended: [530, 40, 'Khóa tự động'], rejected: [214, 150, 'Giấy phép sai'], on_leave: [364, 150, 'Slot bị chặn'], deactivated: [530, 150, 'Đã đóng'] };
  const bad = ['rejected', 'suspended', 'deactivated'];
  const box = (k) => { const [x, y, sub] = S[k]; const on = k === cur; const fill = on ? 'var(--t500)' : bad.includes(k) ? 'var(--bad-bg)' : 'var(--t100)'; const stroke = on ? 'var(--t700)' : bad.includes(k) ? 'var(--bad)' : 'var(--t300)'; const tc = on ? '#fff' : bad.includes(k) ? 'var(--bad)' : 'var(--t800)';
    return `<g><rect x="${x}" y="${y}" width="116" height="48" rx="9" fill="${fill}" stroke="${stroke}" stroke-width="${on ? 2.5 : 1}"/><text x="${x + 58}" y="${y + 20}" text-anchor="middle" font-size="13" font-weight="800" fill="${tc}">${k}</text><text x="${x + 58}" y="${y + 37}" text-anchor="middle" font-size="10" fill="${on ? '#d6f4f7' : 'var(--muted)'}">${sub}</text></g>`; };
  const a = (d, extra = '') => `<path d="${d}" fill="none" stroke="var(--t600)" stroke-width="1.5" ${extra} marker-end="url(#dfa)"/>`;
  const l = (x, y, t, anchor = 'start') => `<text x="${x}" y="${y}" font-size="10.5" fill="var(--t700)" text-anchor="${anchor}">${t}</text>`;
  return `<svg viewBox="0 0 680 350" width="100%" role="img" aria-label="Luồng trạng thái hồ sơ bác sĩ"><defs><marker id="dfa" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M2 1L8 5L2 9" fill="none" stroke="var(--t600)" stroke-width="1.6" stroke-linecap="round"/></marker></defs>
<circle cx="30" cy="64" r="10" fill="var(--t200)" stroke="var(--t500)"/><text x="30" y="40" font-size="10.5" text-anchor="middle" fill="var(--t700)">Start</text>
${Object.keys(S).map(box).join('')}
<circle cx="588" cy="296" r="12" fill="none" stroke="var(--t900)" stroke-width="1.5"/><circle cx="588" cy="296" r="5" fill="var(--t900)"/><text x="616" y="300" font-size="10.5" fill="var(--t700)">End</text>
${a('M41 64L62 64')}${a('M180 64L212 64')}${a('M330 64L362 64')}
${a('M480 54L528 54')}${a('M528 74L482 74')}${a('M250 88L250 148')}${l(258, 122, 'invalid')}${a('M222 150L160 90')}${l(186, 130, 'resubmit', 'end')}
${a('M400 88L400 148')}${l(392, 122, 'leave', 'end')}${a('M444 148L444 90')}${l(452, 122, 'return')}
${a('M470 88L546 148')}${a('M588 88L588 148')}${a('M588 198L588 282')}${a('M272 198L272 296L574 296')}${l(290, 288, 'out of retries (3)')}
</svg>`;
}

VIEWS.doctor.dashboard = async (el) => {
  const [me, stats, appts, work] = await Promise.all([api('/identity/me'), api('/scheduling/stats/me'), api('/scheduling/appointments/mine'), api('/scheduling/doctors/me/work-state').catch(() => ({ state: 'OFF_DUTY' }))]);
  const d = me.doctor, today = ymd(new Date());
  const todayList = appts.filter((a) => a.date === today && ['confirmed', 'in_progress', 'completed'].includes(a.status)).sort((a, b) => a.start.localeCompare(b.start));
  const pct = stats.total ? (stats.completed * 100) / stats.total : 0;
  const msg = { registered: 'Hồ sơ vừa đăng ký, đang chờ gửi đi xác thực.', verifying: 'Đang xác thực giấy phép hành nghề. Thông thường chỉ mất vài giây.', rejected: `Hồ sơ bị từ chối: ${REASON[d.reason] || d.reason}. Vào mục Hồ sơ và trạng thái để nộp lại.`, suspended: `Hồ sơ bị tạm khóa: ${REASON[d.reason] || d.reason}. Slot trống đã bị khóa.`, deactivated: 'Tài khoản đã đóng.', on_leave: 'Bạn đang trong kỳ nghỉ phép. Bạn sẽ tự quay lại hoạt động khi hết kỳ nghỉ.' }[d.status];
  el.innerHTML = `${msg ? `<div class="banner ${['rejected', 'suspended', 'deactivated'].includes(d.status) ? 'bad' : ''}">${esc(msg)}</div>` : ''}<div class="grid">
<div class="card c8"><h3>Lịch hẹn hôm nay</h3>${todayList.length ? `<div class="scroll"><table class="tbl"><tr><th>Bệnh nhân</th><th>Giờ</th><th>Hình thức</th><th>Trạng thái</th></tr>${todayList.map((a) => `<tr><td>${esc(a.patientName)}</td><td>${a.start}</td><td>Video</td><td>${badge(a.status)}</td></tr>`).join('')}</table></div>` : '<div class="empty">Hôm nay chưa có lịch hẹn.</div>'}</div>
<div class="card c4"><h3>Tỷ lệ hoàn thành</h3>${donut(pct)}<div class="legend"><span><i style="background:var(--t500)"></i>Đã khám ${stats.completed}</span><span><i style="background:var(--t100)"></i>Tổng ${stats.total}</span></div></div>
<div class="card c8"><h3>Lượt khám 7 ngày quanh hôm nay</h3>${lineChart(stats.series)}</div>
<div class="card c4"><h3>Trạng thái của bạn</h3><div class="kv"><span>Hồ sơ</span><b>${esc(DOC_LABEL[d.status])}</b></div><div class="kv"><span>Trong ca</span><b>${esc(WORK_LABEL[work.state])}</b></div><div class="kv"><span>Lịch sắp tới</span><b>${stats.upcoming}</b></div><div class="kv"><span>Chuyên khoa</span><b>${esc(d.specialty)}</b></div></div>
${await notifCard()}</div>`;
};

VIEWS.doctor.shifts = async (el) => {
  const defStart = ymd(new Date(Date.now() + 2 * 864e5));
  let result = '';
  const draw = async () => {
    const shifts = await api('/scheduling/shifts/mine');
    el.innerHTML = `<h2 class="pagetitle">Ca làm việc</h2><div class="grid"><div class="card c4"><h3>Đăng ký ca (tự động duyệt)</h3>${result}<form id="f">
<label class="field"><span>Thứ trong tuần</span><select name="weekday">${WEEKDAYS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></label>
<div class="row2"><label class="field"><span>Bắt đầu</span><input type="time" name="startTime" value="08:00" required></label><label class="field"><span>Kết thúc</span><input type="time" name="endTime" value="11:30" required></label></div>
<div class="row2"><label class="field"><span>Mỗi lượt khám</span><select name="slotMinutes"><option>15</option><option>20</option><option selected>30</option><option>45</option></select></label><label class="field"><span>Phí khám (đ)</span><input type="number" name="fee" value="200000" step="10000" required></label></div>
<label class="field"><span>Áp dụng từ ngày</span><input type="date" name="startDate" value="${defStart}" required></label><button class="btn" style="width:100%">Gửi đăng ký ca</button></form>
<p style="color:var(--muted);margin-top:12px;font-size:12.5px">Hệ thống tự kiểm tra 5 luật: bác sĩ đã được xác thực, ca trong giờ 07:00 đến 20:00, không trùng ca khác, tối đa 8 giờ mỗi ngày, đăng ký trước ít nhất 24 giờ. Đạt thì duyệt ngay, không đạt thì từ chối kèm mã lý do.</p></div>
<div class="card c8"><h3>Các ca đã đăng ký</h3>${shifts.length ? `<div class="scroll"><table class="tbl"><tr><th>Thứ</th><th>Giờ</th><th>Mỗi lượt</th><th>Phí</th><th>Từ ngày</th><th>Trạng thái</th><th></th></tr>${shifts.map((s) => `<tr><td>${WD[s.weekday]}</td><td>${s.startTime} - ${s.endTime}</td><td>${s.slotMinutes} phút</td><td>${money(s.fee)}</td><td>${dmy(s.startDate)}</td><td><span class="badge ${s.status === 'APPROVED' ? '' : s.status === 'REJECTED' ? 'bad' : 'gray'}">${SHIFT_LABEL[s.status]}</span>${s.message ? `<br><small style="color:var(--bad)">${esc(s.message)}</small>` : ''}</td><td>${s.status === 'APPROVED' ? `<button class="btn sm danger" data-del="${s.id}">Hủy ca</button>` : ''}</td></tr>`).join('')}</table></div>` : '<div class="empty">Bạn chưa đăng ký ca nào. Sau khi ca được duyệt, hệ thống tự sinh khung giờ cho 30 ngày tới.</div>'}</div></div>`;
    $('#f').onsubmit = async (ev) => {
      ev.preventDefault(); const f = Object.fromEntries(new FormData(ev.target));
      try {
        const r = await api('/scheduling/shifts', { method: 'POST', body: f });
        result = r.status === 'APPROVED' ? '<div class="ok">Ca đã được duyệt tự động. Hệ thống đang sinh khung giờ cho 30 ngày tới.</div>' : `<div class="err">Ca bị từ chối: ${esc(r.message)} (${esc(r.rejectCode)})</div>`;
        draw();
      } catch (e) { fail(e); }
    };
    $$('[data-del]', el).forEach((b) => (b.onclick = async () => { try { await api(`/scheduling/shifts/${b.dataset.del}`, { method: 'DELETE' }); toast('Đã hủy ca.'); draw(); } catch (e) { fail(e); } }));
  };
  await draw();
};

VIEWS.doctor.leaves = async (el) => {
  let msg = '';
  const draw = async () => {
    const leaves = await api('/scheduling/leaves/mine'); const today = ymd(new Date());
    el.innerHTML = `<h2 class="pagetitle">Nghỉ phép</h2><div class="grid"><div class="card c4"><h3>Đăng ký nghỉ</h3>${msg}<form id="f"><label class="field"><span>Từ ngày</span><input type="date" name="fromDate" min="${today}" value="${today}" required></label><label class="field"><span>Đến ngày</span><input type="date" name="toDate" min="${today}" value="${today}" required></label><button class="btn" style="width:100%">Đăng ký nghỉ</button></form>
<p style="color:var(--muted);margin-top:12px;font-size:12.5px">Kỳ nghỉ được duyệt tự động nếu không trùng kỳ nghỉ khác. Slot trống được khóa. Lịch đã đặt trong kỳ nghỉ sẽ tự hủy, hoàn 100% cho bệnh nhân và có email xin lỗi.</p></div>
<div class="card c8"><h3>Các kỳ nghỉ</h3>${leaves.length ? `<table class="tbl"><tr><th>Từ ngày</th><th>Đến ngày</th><th>Trạng thái</th></tr>${leaves.map((l) => `<tr><td>${dmy(l.fromDate)}</td><td>${dmy(l.toDate)}</td><td><span class="badge ${l.status === 'ENDED' ? 'gray' : ''}">${{ APPROVED: 'Đã duyệt', ACTIVE: 'Đang nghỉ', ENDED: 'Đã kết thúc' }[l.status]}</span></td></tr>`).join('')}</table>` : '<div class="empty">Chưa có kỳ nghỉ nào.</div>'}</div></div>`;
    $('#f').onsubmit = async (ev) => { ev.preventDefault(); try { await api('/scheduling/leaves', { method: 'POST', body: Object.fromEntries(new FormData(ev.target)) }); msg = '<div class="ok">Đã duyệt kỳ nghỉ. Các lịch bị ảnh hưởng đang được hủy và hoàn tiền.</div>'; draw(); } catch (e) { msg = `<div class="err">${esc(e.message)}</div>`; draw(); } };
  };
  await draw();
};

VIEWS.doctor.appointments = async (el) => {
  let sig = '';
  const finishDlg = async (a) => {
    const drugs = await api('/records/drugs');
    const m = modal(`<h2>Kết thúc buổi khám với ${esc(a.patientName)}</h2><form id="cf"><label class="field"><span>Triệu chứng</span><textarea name="symptoms" rows="2" required></textarea></label><label class="field"><span>Chẩn đoán</span><input name="diagnosis" required></label><label class="field"><span>Dặn dò</span><input name="notes"></label>
<b>Đơn thuốc (có thể bỏ trống)</b><div id="rx" style="margin-top:8px"></div><button type="button" class="btn sm out" id="addrx">Thêm thuốc</button>
<p style="color:var(--muted);margin:10px 0 0">Bệnh nhân nhận mã đơn và tự đến cơ sở bán thuốc gần nhất để nhận thuốc.</p><div class="foot"><button type="button" class="btn out" id="x">Đóng</button><button class="btn">Lưu bệnh án</button></div></form>`);
    const addRow = () => { const r = document.createElement('div'); r.className = 'rxrow'; r.innerHTML = `<select>${drugs.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select><input placeholder="Liều dùng, ví dụ 1 viên x 3 lần/ngày"><input type="number" min="1" value="10" title="Số lượng"><button type="button" class="btn sm danger">&times;</button>`; r.lastChild.onclick = () => r.remove(); $('#rx', m).append(r); };
    $('#addrx', m).onclick = addRow; $('#x', m).onclick = m.close;
    $('#cf', m).onsubmit = async (ev) => {
      ev.preventDefault(); const f = Object.fromEntries(new FormData(ev.target));
      f.items = $$('.rxrow', m).map((r) => ({ drugId: Number(r.children[0].value), dosage: r.children[1].value, quantity: Number(r.children[2].value) }));
      try { const r = await api(`/records/consultations/${a.id}/complete`, { method: 'POST', body: f }); m.close(); toast(r.prescription ? `Đã lưu bệnh án. Đơn thuốc ${r.prescription.code} đã gửi cho bệnh nhân.` : 'Đã lưu bệnh án.'); draw(true); } catch (e) { fail(e); }
    };
  };
  const recordsDlg = async (a) => {
    const recs = await api(`/records/records/patient/${a.patientId}`);
    modal(`<h2>Hồ sơ của ${esc(a.patientName)}</h2><p style="color:var(--muted);margin-bottom:10px">Lượt xem này được ghi vào nhật ký truy cập mà bệnh nhân có thể xem.</p>${recs.length ? recs.map((r) => `<div class="sum" style="margin-bottom:10px"><div><span>${dmy(r.date)}</span><b>BS. ${esc(r.doctorName)}</b></div><div><span>Triệu chứng</span><b>${esc(r.symptoms)}</b></div><div><span>Chẩn đoán</span><b>${esc(r.diagnosis)}</b></div></div>`).join('') : '<div class="empty">Bệnh nhân chưa có bệnh án.</div>'}`);
  };
  const draw = async (force) => {
    const list = await api('/scheduling/appointments/mine'); const s = JSON.stringify(list); if (s === sig && !force) return; sig = s;
    el.innerHTML = `<h2 class="pagetitle">Lịch hẹn</h2><div class="card">${list.length ? `<div class="scroll"><table class="tbl"><tr><th>Bệnh nhân</th><th>Ngày</th><th>Giờ</th><th>Trạng thái</th><th>Thao tác</th></tr>${list.map((a) => `<tr><td><b>${esc(a.patientName)}</b></td><td>${dmy(a.date)}</td><td>${a.start}</td><td>${badge(a.status)}${a.cancelledBy === 'DOCTOR' ? '<br><small style="color:var(--muted)">Do bác sĩ</small>' : ''}</td><td><div class="act">${['confirmed', 'in_progress'].includes(a.status) ? `<button class="btn sm" data-a="join" data-id="${a.id}">Vào phòng khám</button>` : ''}${a.status === 'in_progress' ? `<button class="btn sm" data-a="finish" data-id="${a.id}">Kết thúc và ghi bệnh án</button>` : ''}${['confirmed', 'in_progress', 'completed'].includes(a.status) ? `<button class="btn sm out" data-a="rec" data-id="${a.id}">Hồ sơ bệnh nhân</button>` : ''}</div></td></tr>`).join('')}</table></div>` : '<div class="empty">Chưa có lịch hẹn nào.</div>'}</div>`;
    $$('[data-a]', el).forEach((b) => (b.onclick = async () => {
      const a = list.find((x) => x.id === b.dataset.id);
      try {
        if (b.dataset.a === 'join') { const r = await api(`/tele/sessions/${a.id}/join`, { method: 'POST' }); window.open(r.roomUrl, '_blank'); toast(r.doctorJoined && r.patientJoined ? 'Cả hai đã vào phòng, buổi khám bắt đầu.' : 'Bạn đã vào phòng. Đang chờ bệnh nhân.'); draw(true); }
        else if (b.dataset.a === 'finish') finishDlg(a); else recordsDlg(a);
      } catch (e) { fail(e); }
    }));
  };
  await draw(true); every(4000, () => draw().catch(() => {}));
};

VIEWS.doctor.profile = async (el) => {
  let sig = '';
  const draw = async () => {
    const [d, work] = await Promise.all([api('/identity/doctors/me/status'), api('/scheduling/doctors/me/work-state').catch(() => ({ state: 'OFF_DUTY' }))]);
    const s = JSON.stringify([d, work]); if (s === sig) return; sig = s;
    el.innerHTML = `<h2 class="pagetitle">Hồ sơ và trạng thái</h2><div class="grid"><div class="card c12"><h3>Luồng trạng thái hồ sơ bác sĩ <span class="sp"></span><span class="badge ${['rejected', 'suspended', 'deactivated'].includes(d.status) ? 'bad' : ''}">Hiện tại: ${esc(DOC_LABEL[d.status])}</span></h3>${doctorFsmSvg(d.status)}<p style="color:var(--muted);font-size:12.5px">Hộp được tô đậm là trạng thái hiện tại. Chỉ bác sĩ ở trạng thái <b>active</b> mới đăng ký được ca và nhận lịch. Mũi tên hai chiều giữa active và suspended là khóa tự động khi giấy phép hết hạn hoặc vắng mặt 3 buổi hẹn trong 30 ngày.</p></div>
<div class="card c4"><h3>Thông tin</h3><div class="kv"><span>Số giấy phép</span><b>${esc(d.licenseNo)}</b></div><div class="kv"><span>Chuyên khoa</span><b>${esc(d.specialty)}</b></div><div class="kv"><span>Hết hạn giấy phép</span><b>${d.licenseExpiry ? dmy(d.licenseExpiry) : 'chưa có'}</b></div><div class="kv"><span>Lần nộp hồ sơ</span><b>${d.verifyAttempts}/3</b></div><div class="kv"><span>Trong ca</span><b>${esc(WORK_LABEL[work.state])}</b></div>${d.reason ? `<div class="err">Lý do: ${esc(REASON[d.reason] || d.reason)}</div>` : ''}
${d.status === 'rejected' && !d.final ? `<form id="rs" style="margin-top:10px"><label class="field"><span>Số giấy phép mới</span><input name="licenseNo" value="${esc(d.licenseNo)}" required></label><button class="btn" style="width:100%">Nộp lại hồ sơ</button></form>` : ''}${d.status === 'rejected' && d.final ? '<div class="err">Đã hết 3 lần nộp lại.</div>' : ''}${d.status === 'active' ? '<button class="btn danger" id="dz" style="margin-top:10px;width:100%">Đóng tài khoản</button>' : ''}</div>
<div class="card c8"><h3>Lịch sử chuyển trạng thái</h3><div class="scroll"><table class="tbl"><tr><th>Từ</th><th>Sang</th><th>Lý do</th><th>Thời điểm</th></tr>${d.log.map((l) => `<tr><td>${esc(l.from_status)}</td><td><b>${esc(l.to_status)}</b></td><td>${esc(REASON[l.reason] || l.reason || '')}</td><td>${new Date(l.at).toLocaleString('vi-VN')}</td></tr>`).join('')}</table></div></div></div>`;
    if ($('#rs')) $('#rs').onsubmit = async (ev) => { ev.preventDefault(); try { await api('/identity/doctors/me/resubmit', { method: 'POST', body: Object.fromEntries(new FormData(ev.target)) }); toast('Đã nộp lại, đang xác thực.'); sig = ''; draw(); } catch (e) { fail(e); } };
    if ($('#dz')) $('#dz').onclick = () => { const m = modal('<h2>Đóng tài khoản bác sĩ?</h2><p>Thao tác này không thể hoàn tác. Bạn chỉ đóng được khi không còn lịch hẹn sắp tới.</p><div class="foot"><button class="btn out" id="x">Giữ tài khoản</button><button class="btn danger" id="ok">Đóng tài khoản</button></div>'); $('#x', m).onclick = m.close; $('#ok', m).onclick = async () => { try { await api('/identity/doctors/me/deactivate', { method: 'POST' }); m.close(); toast('Đã đóng tài khoản.'); setTimeout(logout, 1200); } catch (e) { m.close(); fail(e); } }; };
  };
  await draw(); every(3000, () => draw().catch(() => {}));
};
