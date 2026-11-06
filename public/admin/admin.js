(function () {
  const root = $('#root');
  let tab = 'overview', sock, map, markers = {}, sosBeep = 0;
  const TABS = [['overview', 'Overview'], ['live', 'Live map'], ['drivers', 'Drivers'], ['trips', 'Trips'], ['sos', 'SOS'], ['config', 'Config']];

  function boot() {
    if (!api.user) return mountLogin(root, { title: 'SafeRide Admin', sub: 'Operations console', roles: ['CLIENT'], allow: ['ADMIN'], onDone: boot });
    if (api.user.role !== 'ADMIN') { api.signOut(false); toast('Not an admin account', true); return boot(); }
    root.innerHTML = `<header class="bar"><b>SafeRide Ops</b><button class="btn sm ghost" id="out">Sign out</button></header><div class="tabs" id="tabs"></div><div id="view"></div>`;
    $('#out').onclick = () => api.signOut();
    $('#tabs').innerHTML = TABS.map(([k, l]) => `<button data-t="${k}" class="${k === tab ? 'on' : ''}">${l}<span id="b-${k}"></span></button>`).join('');
    $$('#tabs button').forEach((b) => (b.onclick = () => { tab = b.dataset.t; $$('#tabs button').forEach((x) => x.classList.toggle('on', x === b)); show(); }));
    sock = api.socket();
    sock.on('sos:alert', (a) => { toast(`🚨 SOS from ${a.name || a.phone}`, true); if (tab === 'sos') show(); else badge(); });
    sock.on('trip:update', () => { if (tab === 'live') loadLive(); });
    sock.on('driver:location', (d) => { if (tab === 'live' && map) mark('d' + d.driverId, d.lat, d.lng, '#0b7a53', 'Driver ' + d.driverId); });
    badge(); show();
  }
  async function badge() { const s = await api.get('/admin/sos').catch(() => []); const n = s.filter((x) => x.status === 'OPEN').length; $('#b-sos').textContent = n ? ` (${n})` : ''; }
  const show = guard(async () => { map = null; markers = {}; ({ overview, live, drivers, trips, sos, config })[tab](); });

  async function overview() {
    const a = await api.get('/admin/analytics');
    $('#view').innerHTML = `<div class="grid">${[['Trips (all)', a.total_trips], ['Paid trips', a.paid_trips], ['Gross', kes(a.gross_kes)], ['Platform revenue', kes(a.revenue_kes)], ['Avg fare', kes(a.avg_fare_kes)],
      ['Cancellation rate', (a.cancellationRate * 100).toFixed(1) + '%'], ['No driver found', a.no_driver], ['Drivers online', a.online_drivers], ['Drivers approved', a.approved_drivers], ['Awaiting review', a.pending_drivers], ['Open SOS', a.open_sos]]
      .map(([k, v]) => `<div class="stat"><span class="muted small">${k}</span><b>${v}</b></div>`).join('')}</div>
      <div class="card"><h3>Last 14 days</h3>${bars(a.daily)}</div>`;
  }
  function bars(d) {
    if (!d.length) return '<p class="muted">No trips yet.</p>';
    const max = Math.max(...d.map((x) => x.trips), 1);
    return `<div style="display:flex;gap:6px;align-items:flex-end;height:140px">${d.map((x) => `<div title="${x.day}: ${x.trips} trips, ${kes(x.gross_kes)}" style="flex:1;text-align:center"><div style="background:var(--brand);height:${Math.max(4, (x.trips / max) * 110)}px;border-radius:4px 4px 0 0"></div><div class="muted" style="font-size:.7rem">${x.day.slice(5)}</div></div>`).join('')}</div>`;
  }

  // ---- live map ----
  function mark(id, lat, lng, color, label) {
    if (markers[id]) markers[id].setLatLng([lat, lng]); else markers[id] = L.circleMarker([lat, lng], { radius: 7, color, fillColor: color, fillOpacity: .8 }).bindTooltip(label).addTo(map);
  }
  async function live() {
    $('#view').innerHTML = `<div class="card tall"><div id="map"></div><p class="muted small" id="lc"></p></div>`;
    map = L.map('map', { zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false }).setView([-1.2864, 36.8172], 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
    loadLive();
  }
  async function loadLive() {
    const r = await api.get('/admin/trips/live'); if (!map) return;
    Object.values(markers).forEach((m) => m.remove()); markers = {};
    r.drivers.forEach((d) => mark('d' + d.id, d.lat, d.lng, '#0b7a53', 'Driver ' + d.id));
    r.trips.forEach((t) => mark('t' + t.id, t.pickup_lat, t.pickup_lng, t.status === 'MATCHING' ? '#b7791f' : '#2563eb', `Trip #${t.id} ${t.status}`));
    $('#lc').textContent = `${r.drivers.length} drivers online · ${r.trips.length} active trips (green = drivers, amber = waiting, blue = in progress)`;
  }

  // ---- drivers ----
  async function drivers() {
    const rows = await api.get('/admin/drivers');
    $('#view').innerHTML = `<div class="card"><table><tr><th>Driver</th><th>Status</th><th>Docs</th><th>Rating</th><th></th></tr>${rows.map((d) => `<tr><td><b>${esc(d.name || '—')}</b><br><span class="muted small">${esc(d.phone)}<br>ID ${esc(d.national_id || '—')} · DL ${esc(d.license_number || '—')}</span></td>
      <td><span class="pill ${d.verification_status === 'APPROVED' ? 'ok' : d.verification_status === 'REJECTED' ? 'bad' : 'warn'}">${d.verification_status}</span>${d.status !== 'ACTIVE' ? ' <span class="pill bad">SUSPENDED</span>' : ''}${d.online ? ' <span class="pill ok">online</span>' : ''}</td>
      <td>${[d.id_url, d.license_url, d.good_conduct_url].map((u, i) => u ? `<a target="_blank" rel="noopener" href="${api.imgUrl(u)}">${['ID', 'Licence', 'Conduct'][i]}</a>` : '').join(' · ')}</td>
      <td>★ ${Number(d.rating_avg).toFixed(2)} (${d.rating_count})<br><span class="muted small">${d.trips_completed} trips</span></td>
      <td><button class="btn sm" data-ap="${d.user_id}">Approve</button><button class="btn sm bad" data-rj="${d.user_id}">Reject</button><button class="btn sm ghost" data-sp="${d.user_id}" data-s="${d.status === 'ACTIVE'}">${d.status === 'ACTIVE' ? 'Suspend' : 'Reinstate'}</button></td></tr>`).join('')}</table></div>`;
    $$('[data-ap]').forEach((b) => (b.onclick = guard(async () => { await api.post(`/admin/drivers/${b.dataset.ap}/review`, { approve: true }); drivers(); })));
    $$('[data-rj]').forEach((b) => (b.onclick = guard(async () => { const reason = prompt('Reason for rejection (shown to the driver):'); if (!reason) return; await api.post(`/admin/drivers/${b.dataset.rj}/review`, { approve: false, reason }); drivers(); })));
    $$('[data-sp]').forEach((b) => (b.onclick = guard(async () => { await api.post(`/admin/users/${b.dataset.sp}/suspend`, { suspend: b.dataset.s === 'true' }); drivers(); })));
  }

  // ---- trips ----
  async function trips() {
    const rows = await api.get('/admin/trips');
    $('#view').innerHTML = `<div class="card"><table><tr><th>#</th><th>When</th><th>Status</th><th>Fare</th><th></th></tr>${rows.map((t) => `<tr><td>${t.id}</td><td>${new Date(t.requested_at).toLocaleString('en-KE')}</td><td>${esc(t.status.replace(/_/g, ' '))}</td><td>${kes(t.final_fare_kes ?? t.est_fare_kes)}</td><td><button class="btn sm ghost" data-ev="${t.id}">Audit trail</button></td></tr>`).join('')}</table></div><div id="detail"></div>`;
    $$('[data-ev]').forEach((b) => (b.onclick = guard(() => detail(b.dataset.ev))));
  }
  async function detail(id) {
    const [d, t] = await Promise.all([api.get(`/admin/trips/${id}/events`), api.get('/admin/trips').then((r) => r.find((x) => x.id == id))]);
    $('#detail').innerHTML = `<div class="card"><h3>Trip #${id} — ${esc(t.status)}</h3>
      <div class="thumbs">${d.photos.map((p) => `<a target="_blank" rel="noopener" href="${api.imgUrl(p.photo_url)}"><img title="${p.phase}" src="${api.imgUrl(p.photo_url)}"></a>`).join('') || '<span class="muted">No photos</span>'}</div>
      <table>${d.events.filter((e) => e.type !== 'LOCATION').map((e) => `<tr><td>${new Date(e.created_at).toLocaleTimeString('en-KE')}</td><td>${esc(e.type)}</td><td class="muted small">${esc(JSON.stringify(e.payload))}</td></tr>`).join('')}</table>
      ${['PAID', 'COMPLETED', 'IN_PROGRESS', 'PAYMENT_FAILED'].includes(t.status) ? '<button class="btn sm bad" id="dsp">Mark disputed</button>' : ''}
      ${t.status === 'DISPUTED' ? '<button class="btn sm bad" id="rf">Record refund</button>' : ''}</div>`;
    $('#dsp')?.addEventListener('click', guard(async () => { const note = prompt('Dispute note:'); if (note) { await api.post(`/admin/trips/${id}/dispute`, { note }); trips(); } }));
    $('#rf')?.addEventListener('click', guard(async () => { if (confirm('Record refund? This claws back the driver\'s share.')) { const r = await api.post(`/admin/trips/${id}/refund`); toast(r.note); trips(); } }));
    $('#detail').scrollIntoView({ behavior: 'smooth' });
  }

  // ---- SOS ----
  async function sos() {
    const rows = await api.get('/admin/sos'); badge();
    $('#view').innerHTML = `<div class="card"><table><tr><th>When</th><th>Who</th><th>Where</th><th>Status</th><th></th></tr>${rows.map((s) => `<tr><td>${new Date(s.triggered_at).toLocaleString('en-KE')}</td><td>${esc(s.name || '')}<br><a href="tel:${esc(s.phone)}">${esc(s.phone)}</a><br><span class="muted small">trip ${s.trip_id ?? '—'}</span></td>
      <td>${s.lat ? `<a target="_blank" rel="noopener" href="https://maps.google.com/?q=${s.lat},${s.lng}">Open map</a>` : '—'}</td><td><span class="pill ${s.status === 'OPEN' ? 'bad' : s.status === 'ACKNOWLEDGED' ? 'warn' : 'ok'}">${s.status}</span></td>
      <td>${s.status === 'OPEN' ? `<button class="btn sm" data-st="ACKNOWLEDGED" data-id="${s.id}">Acknowledge</button>` : ''}${s.status !== 'RESOLVED' ? `<button class="btn sm ghost" data-st="RESOLVED" data-id="${s.id}">Resolve</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No alerts.</td></tr>'}</table></div>`;
    $$('[data-st]').forEach((b) => (b.onclick = guard(async () => { await api.post(`/admin/sos/${b.dataset.id}/status`, { status: b.dataset.st }); sos(); })));
  }

  // ---- config ----
  async function config() {
    const [zones, promos, venues] = await Promise.all([api.get('/admin/zones'), api.get('/admin/promos'), api.get('/admin/venues')]);
    $('#view').innerHTML = `<div class="card"><h3>Service zones & surge</h3><table><tr><th>Zone</th><th>Radius km</th><th>Surge ×</th><th>Active</th><th></th></tr>${zones.map((z) => `<tr><td>${esc(z.name)}</td><td>${z.radius_km}</td><td><input data-s="${z.id}" type="number" step="0.1" min="1" max="5" value="${z.surge_multiplier}" style="width:90px"></td><td>${z.active ? 'yes' : 'no'}</td><td><button class="btn sm" data-sv="${z.id}">Save</button><button class="btn sm ghost" data-tg="${z.id}" data-a="${z.active}">${z.active ? 'Disable' : 'Enable'}</button></td></tr>`).join('')}</table></div>
      <div class="card"><h3>Promo codes</h3><table>${promos.map((p) => `<tr><td><b>${esc(p.code)}</b></td><td>${p.percent_off}% + ${kes(p.flat_off_kes)} off</td><td>${p.used_count}/${p.max_uses ?? '∞'} used</td></tr>`).join('')}</table>
      <div class="row" style="margin-top:8px"><input id="pc" placeholder="CODE"><input id="pp" type="number" placeholder="% off"><button class="btn sm" id="pa">Add</button></div></div>
      <div class="card"><h3>Partner venues</h3><table>${venues.map((v) => `<tr><td>${esc(v.name)}</td><td>code <b>${esc(v.referral_code)}</b></td><td><a target="_blank" rel="noopener" href="/client/?venue=${esc(v.referral_code)}">client link</a></td></tr>`).join('')}</table>
      <label>Name<input id="vn"></label><div class="row"><input id="vla" placeholder="Latitude"><input id="vlo" placeholder="Longitude"></div><label>Staff phone (gets venue access)<input id="vs"></label><button class="btn" id="va">Add venue</button></div>`;
    $$('[data-sv]').forEach((b) => (b.onclick = guard(async () => { await api.put(`/admin/zones/${b.dataset.sv}`, { surgeMultiplier: Number($(`[data-s="${b.dataset.sv}"]`).value) }); toast('Saved'); })));
    $$('[data-tg]').forEach((b) => (b.onclick = guard(async () => { await api.put(`/admin/zones/${b.dataset.tg}`, { active: b.dataset.a !== 'true' }); config(); })));
    $('#pa').onclick = guard(async () => { await api.post('/admin/promos', { code: $('#pc').value, percentOff: Number($('#pp').value || 0) }); config(); });
    $('#va').onclick = guard(async () => { await api.post('/admin/venues', { name: $('#vn').value, lat: Number($('#vla').value), lng: Number($('#vlo').value), staffPhone: $('#vs').value || undefined }); config(); });
  }
  boot();
})();
