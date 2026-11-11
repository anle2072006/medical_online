'use strict';
/* SINA Clinic - loi giao dien: tien ich, goi API qua gateway, router, trang chu, dang nhap/dang ky, khung ung dung. */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n || 0).toLocaleString('vi-VN') + ' đ';
const dmy = (d) => (d ? d.split('-').reverse().join('/') : '');
const WD = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const initials = (n) => String(n || '?').trim().split(/\s+/).slice(-2).map((w) => w[0]).join('').toUpperCase();
const ago = (iso) => { const m = Math.round((Date.now() - new Date(iso)) / 60000); return m < 1 ? 'vừa xong' : m < 60 ? `${m} phút trước` : m < 1440 ? `${Math.round(m / 60)} giờ trước` : new Date(iso).toLocaleDateString('vi-VN'); };

const state = { token: localStorage.getItem('sina_token'), user: JSON.parse(localStorage.getItem('sina_user') || 'null'), timers: [] };
const VIEWS = { patient: {}, doctor: {} };
const NAV = {
  patient: [['dashboard', 'Tổng quan'], ['book', 'Đặt lịch khám'], ['appointments', 'Lịch hẹn của tôi'], ['records', 'Bệnh án và đơn thuốc'], ['notifications', 'Thông báo']],
  doctor: [['dashboard', 'Tổng quan'], ['shifts', 'Ca làm việc'], ['leaves', 'Nghỉ phép'], ['appointments', 'Lịch hẹn'], ['profile', 'Hồ sơ và trạng thái'], ['notifications', 'Thông báo']],
};
const APPT_LABEL = { pending: 'Chờ thanh toán', failed: 'Thanh toán lỗi', confirmed: 'Đã xác nhận', rescheduled: 'Đang đổi lịch', in_progress: 'Đang khám', completed: 'Hoàn thành', cancelled: 'Đã hủy', refunding: 'Đang hoàn tiền', refunded: 'Đã hoàn tiền', no_show: 'Vắng mặt' };
const APPT_CLASS = { pending: 'warn', failed: 'warn', rescheduled: 'warn', refunding: 'warn', cancelled: 'bad', no_show: 'bad', refunded: 'gray' };
const DOC_LABEL = { registered: 'Đã đăng ký', verifying: 'Đang xác thực', active: 'Đang hoạt động', rejected: 'Bị từ chối', on_leave: 'Đang nghỉ phép', suspended: 'Tạm khóa', deactivated: 'Đã đóng' };
const REASON = { LICENSE_INVALID: 'Số giấy phép không hợp lệ', LICENSE_EXPIRED: 'Giấy phép đã hết hạn', LICENSE_REVOKED: 'Giấy phép đã bị thu hồi', ABSENCE: 'Vắng mặt 3 buổi hẹn trong 30 ngày', CLOSED_BY_DOCTOR: 'Bác sĩ đã đóng tài khoản', RESUBMITTED: 'Nộp lại hồ sơ' };
const badge = (s, label = APPT_LABEL) => `<span class="badge ${APPT_CLASS[s] || ''}">${esc(label[s] || s)}</span>`;

// ---------- API ----------
async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(`/api${path}`, { method, headers: { 'content-type': 'application/json', ...(state.token ? { authorization: `Bearer ${state.token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = t ? JSON.parse(t) : {}; } catch { j = {}; }
  if (r.status === 401 && state.token) { logout(); throw new Error('Phiên đăng nhập đã hết hạn.'); }
  if (!r.ok) { const e = new Error(j.message || 'Có lỗi xảy ra, vui lòng thử lại.'); e.code = j.error; e.status = r.status; throw e; }
  return j;
}
function toast(msg, bad) { const t = document.createElement('div'); t.className = 'toast' + (bad ? ' bad' : ''); t.textContent = msg; document.body.append(t); setTimeout(() => t.remove(), 3600); }
const fail = (e) => toast(e.message, true);
function modal(html) {
  const v = document.createElement('div'); v.className = 'veil'; v.innerHTML = `<div class="modal">${html}</div>`;
  v.close = () => v.remove(); v.addEventListener('mousedown', (e) => { if (e.target === v) v.close(); });
  document.body.append(v); return v;
}
function setSession(token, user) { state.token = token; state.user = user; localStorage.setItem('sina_token', token); localStorage.setItem('sina_user', JSON.stringify(user)); }
function logout() { state.token = null; state.user = null; localStorage.removeItem('sina_token'); localStorage.removeItem('sina_user'); location.hash = '#/'; route(); }
const every = (ms, fn) => state.timers.push(setInterval(fn, ms));

// ---------- Hinh minh hoa & bieu do ----------
const logo = (s = 40) => `<svg width="${s}" height="${s}" viewBox="0 0 48 48"><circle cx="24" cy="24" r="22" fill="var(--t100)" stroke="var(--t500)" stroke-width="2"/><path d="M20 12h8v8h8v8h-8v8h-8v-8h-8v-8h8z" fill="var(--t500)"/></svg>`;
const illustration = () => `<svg class="ill" viewBox="0 0 420 380" role="img" aria-label="Bác sĩ và điều dưỡng">
<defs><clipPath id="cc"><circle cx="210" cy="205" r="150"/></clipPath></defs>
<circle cx="210" cy="205" r="150" fill="var(--t500)"/>
<g clip-path="url(#cc)">
 <rect x="236" y="236" width="118" height="140" rx="40" fill="#14bcd0"/><circle cx="296" cy="205" r="25" fill="#e9b88f"/><path d="M272 200c2-26 46-30 50-2-14-10-34-12-50 2z" fill="#2b2b3a"/>
 <rect x="104" y="228" width="130" height="150" rx="44" fill="#f4f7f8"/><path d="M150 232l18 46 18-46z" fill="#00667a"/><circle cx="169" cy="196" r="28" fill="#f2c6a0"/><path d="M142 190c4-30 52-32 56 0-14-14-40-14-56 0z" fill="#2b2b3a"/>
 <circle cx="158" cy="198" r="8" fill="none" stroke="#2b2b3a" stroke-width="2"/><circle cx="180" cy="198" r="8" fill="none" stroke="#2b2b3a" stroke-width="2"/><path d="M166 198h6" stroke="#2b2b3a" stroke-width="2"/>
 <path d="M140 250c-8 30 14 54 30 40" fill="none" stroke="#2b2b3a" stroke-width="3"/>
 <g transform="rotate(-8 270 300)"><rect x="236" y="262" width="76" height="92" rx="8" fill="#2b2b3a"/><rect x="246" y="274" width="56" height="8" rx="3" fill="#7edce6"/><rect x="246" y="290" width="40" height="6" rx="3" fill="#7edce6"/></g>
</g>
<circle cx="338" cy="92" r="18" fill="#fff" stroke="var(--t500)" stroke-width="2"/><path d="M332 92h12M338 86v12" stroke="var(--t500)" stroke-width="3" stroke-linecap="round"/>
<g transform="rotate(-12 80 130)"><rect x="52" y="86" width="64" height="84" rx="6" fill="#eef9fb" stroke="#afebf0"/><rect x="64" y="104" width="40" height="5" rx="2" fill="#afebf0"/><rect x="64" y="118" width="40" height="5" rx="2" fill="#afebf0"/><rect x="64" y="132" width="26" height="5" rx="2" fill="#afebf0"/></g>
<rect x="352" y="170" width="26" height="44" rx="6" fill="#d6f4f7" stroke="#afebf0"/><rect x="356" y="162" width="18" height="10" rx="3" fill="#7edce6"/>
</svg>`;
function donut(pct, size = 120) {
  const r = size / 2 - 11, c = 2 * Math.PI * r, p = Math.max(0, Math.min(100, pct));
  return `<div class="donut" style="width:${size}px;height:${size}px"><svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--t100)" stroke-width="14"/>${p > 0 ? `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--t500)" stroke-width="14" stroke-linecap="round" stroke-dasharray="${(c * p) / 100} ${c}" transform="rotate(-90 ${size / 2} ${size / 2})"/>` : ''}</svg><b>${Math.round(p)}%</b></div>`;
}
function lineChart(series, w = 560, h = 190) {
  const max = Math.max(4, ...series.map((s) => s.count)), L = 34, B = 26, T = 18, iw = w - L - 24, ih = h - B - T;
  const pts = series.map((s, i) => [L + (i * iw) / (series.length - 1), T + ih - (s.count / max) * ih]);
  const grid = [0, 1, 2, 3, 4].map((i) => { const y = T + (ih * i) / 4; return `<line x1="${L}" x2="${w - 24}" y1="${y}" y2="${y}" stroke="var(--line)"/><text x="${L - 8}" y="${y + 4}" font-size="10" text-anchor="end" fill="var(--muted)">${Math.round(max - (max * i) / 4)}</text>`; }).join('');
  const top = pts.reduce((m, p, i) => (series[i].count > series[m].count ? i : m), 0);
  const labels = series.map((s, i) => `<text x="${pts[i][0]}" y="${h - 8}" font-size="10" text-anchor="middle" fill="var(--muted)">${s.date.slice(8)}/${s.date.slice(5, 7)}</text>`).join('');
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="Số lượt khám 7 ngày">${grid}<polyline points="${pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="var(--t500)" stroke-width="2.2"/>${pts.map((p) => `<circle cx="${p[0]}" cy="${p[1]}" r="4" fill="#fff" stroke="var(--t500)" stroke-width="2"/>`).join('')}${series[top].count > 0 ? `<g><rect x="${pts[top][0] - 15}" y="${Math.max(0, pts[top][1] - 28)}" width="30" height="20" rx="4" fill="var(--t500)"/><text x="${pts[top][0]}" y="${Math.max(14, pts[top][1] - 14)}" font-size="11" font-weight="700" text-anchor="middle" fill="#fff">${series[top].count}</text></g>` : ''}${labels}</svg>`;
}

// ---------- Trang chu, dang nhap, dang ky ----------
function frame(inner) { $('#root').innerHTML = `<div class="frame"><div class="sheet">${inner}</div></div>`; }
const navbar = (on) => `<div class="nav"><a class="brand" href="#/">${logo(38)} SINA Clinic</a><a class="l ${on === 'home' ? 'on' : ''}" href="#/">Trang chủ</a><a class="l" href="#/" onclick="document.getElementById('how')&&document.getElementById('how').scrollIntoView({behavior:'smooth'})">Cách hoạt động</a><a class="l" href="#/register">Dành cho bác sĩ</a></div>`;
function landing() {
  frame(`${navbar('home')}<div class="hero"><div>${illustration()}</div><div><h1>Chào mừng đến với <em>SINA Clinic</em></h1><p class="lead">Đặt lịch, thanh toán, khám qua video và nhận thuốc tại nhà. Tất cả trên một nền tảng, không cần xếp hàng.</p><div class="cta"><a class="btn" href="#/login">Đăng nhập</a><a class="btn out" href="#/register">Đăng ký</a></div>
<div class="steps" id="how"><div><b>1</b>Chọn bác sĩ và khung giờ</div><div><b>2</b>Thanh toán trực tuyến</div><div><b>3</b>Khám qua video</div><div><b>4</b>Nhận đơn và thuốc</div></div></div></div>`);
}
function authPage(mode) {
  let role = 'patient', specs = [];
  const draw = () => {
    frame(`${navbar()}<div class="hero"><div>${illustration()}</div><div>${mode === 'login' ? `<form class="authcard" id="f"><h2>Đăng nhập</h2><p class="sub">Chào mừng bạn quay lại SINA Clinic.</p><div id="e"></div>
<label class="field"><span>Email</span><input name="email" type="email" required autocomplete="username"></label><label class="field"><span>Mật khẩu</span><input name="password" type="password" required autocomplete="current-password"></label>
<button class="btn" style="width:100%">Đăng nhập</button><p class="sub" style="margin:14px 0 0">Chưa có tài khoản? <a href="#/register">Đăng ký</a></p></form>` : `<form class="authcard" id="f"><h2>Đăng ký</h2><p class="sub">Tạo tài khoản để bắt đầu.</p><div class="seg"><button type="button" data-r="patient" class="${role === 'patient' ? 'on' : ''}">Bệnh nhân</button><button type="button" data-r="doctor" class="${role === 'doctor' ? 'on' : ''}">Bác sĩ</button></div><div id="e"></div>
<label class="field"><span>Họ và tên</span><input name="fullName" required></label><label class="field"><span>Email</span><input name="email" type="email" required></label><label class="field"><span>Mật khẩu (ít nhất 6 ký tự)</span><input name="password" type="password" minlength="6" required></label>
${role === 'doctor' ? `<div class="row2"><label class="field"><span>Chuyên khoa</span><select name="specialty">${specs.map((s) => `<option>${esc(s)}</option>`).join('')}</select></label><label class="field"><span>Số giấy phép hành nghề</span><input name="licenseNo" required placeholder="BS12345"></label></div><p class="sub" style="margin-top:-6px">Hệ thống tự xác thực giấy phép, không cần chờ duyệt. Dùng BS12345 để thử số hợp lệ.</p>` : ''}
<button class="btn" style="width:100%">Tạo tài khoản</button><p class="sub" style="margin:14px 0 0">Đã có tài khoản? <a href="#/login">Đăng nhập</a></p></form>`}</div></div>`);
    $$('.seg button').forEach((b) => b.addEventListener('click', () => { role = b.dataset.r; draw(); }));
    $('#f').addEventListener('submit', async (ev) => {
      ev.preventDefault(); const f = Object.fromEntries(new FormData(ev.target)); const btn = $('#f .btn'); btn.disabled = true; $('#e').innerHTML = '';
      try {
        if (mode === 'register') { await api('/identity/register', { method: 'POST', body: { ...f, role } }); }
        const r = await api('/identity/login', { method: 'POST', body: { email: f.email, password: f.password } });
        setSession(r.token, r.user); location.hash = '#/dashboard'; route();
      } catch (e) { $('#e').innerHTML = `<div class="err">${esc(e.message)}</div>`; btn.disabled = false; }
    });
  };
  draw();
  if (mode === 'register') api('/identity/specialties').then((s) => { specs = s; draw(); }).catch(() => {});
}

// ---------- Khung ung dung ----------
function renderShell(role, view) {
  const u = state.user; const tag = role === 'doctor' ? 'Mã bác sĩ' : 'Mã bệnh nhân';
  $('#root').innerHTML = `<div class="frame"><div class="sheet"><div class="app"><aside class="side"><div class="avatar">${esc(initials(u.fullName))}</div><div class="logo">${logo(48)}</div>
<nav>${NAV[role].map(([k, t]) => `<a href="#/${k}" class="${k === view ? 'on' : ''}">${t}</a>`).join('')}</nav><button class="out" id="lo">Đăng xuất</button></aside>
<main class="main"><div class="top"><button class="back" title="Quay lại" onclick="history.back()">&#8592;</button><span class="idtag">${tag}: ${esc(u.id.slice(0, 6).toUpperCase())}</span><span class="sp"></span>
<button class="bell" id="bell" title="Thông báo"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0"/></svg><i id="bn" hidden></i></button><span class="who">${role === 'doctor' ? 'BS. ' : ''}${esc(u.fullName)}</span><div class="avatar sm">${esc(initials(u.fullName))}</div></div>
<div id="content"></div></main></div></div></div>`;
  $('#lo').onclick = logout; $('#bell').onclick = () => { location.hash = '#/notifications'; };
  const refreshBell = () => api('/notify/notifications/mine').then((r) => { const b = $('#bn'); if (b) { b.hidden = !r.unread; b.textContent = r.unread; } }).catch(() => {});
  refreshBell(); every(8000, refreshBell);
  VIEWS[role][view]($('#content')).catch((e) => { $('#content').innerHTML = `<div class="err">${esc(e.message)}</div>`; });
}
function route() {
  state.timers.forEach(clearInterval); state.timers = [];
  document.querySelectorAll('.veil').forEach((v) => v.remove());
  const view = location.hash.replace(/^#\/?/, '').split('?')[0];
  if (!state.token) return view === 'login' || view === 'register' ? authPage(view) : landing();
  const views = VIEWS[state.user.role];
  if (!views[view]) { if (location.hash !== '#/dashboard') { location.hash = '#/dashboard'; return; } }
  renderShell(state.user.role, views[view] ? view : 'dashboard');
}
window.addEventListener('hashchange', route);

// ---------- Man hinh dung chung ----------
VIEWS.patient.notifications = VIEWS.doctor.notifications = async (el) => {
  const draw = async () => {
    const r = await api('/notify/notifications/mine');
    el.innerHTML = `<div class="card"><h3>Thông báo <span class="sp"></span><button class="btn sm out" id="ra">Đánh dấu đã đọc</button></h3>${r.items.length ? `<ul class="list">${r.items.map((n) => `<li class="${n.read ? '' : 'unread'}"><div>${esc(n.title)}<small>${esc(n.body)}</small><small>${ago(n.createdAt)} &middot; email ${n.status === 'SENT' ? 'đã gửi' : n.status === 'FAILED' ? 'gửi lỗi' : 'đang gửi'}</small></div></li>`).join('')}</ul>` : '<div class="empty">Chưa có thông báo nào.</div>'}</div>`;
    $('#ra').onclick = async () => { await api('/notify/notifications/read-all', { method: 'POST' }); draw(); };
  };
  await draw(); every(6000, () => draw().catch(() => {}));
};
const notifCard = async () => {
  const r = await api('/notify/notifications/mine').catch(() => ({ items: [] }));
  return `<div class="card c12"><h3>Thông báo gần đây</h3>${r.items.length ? `<ul class="list">${r.items.slice(0, 4).map((n) => `<li class="${n.read ? '' : 'unread'}"><div>${esc(n.title)}<small>${esc(n.body)}</small></div></li>`).join('')}</ul>` : '<div class="empty">Chưa có thông báo nào.</div>'}</div>`;
};
