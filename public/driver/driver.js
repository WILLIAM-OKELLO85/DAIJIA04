(function () {
  const root = $('#root');
  let me = null, trip = null, sock = null, watchId = null, offers = new Map(), tick = null;

  const NEXT = {
    ACCEPTED: ['en-route', 'I\'m on my way'], DRIVER_EN_ROUTE: ['arrived', 'I\'ve arrived'],
    ARRIVED: ['start', 'Start trip'], IN_PROGRESS: ['complete', 'End trip'],
  };

  function boot() {
    if (!api.user) return mountLogin(root, { title: 'SafeRide Driver', sub: 'Drive customers\' cars home safely and earn.', roles: ['DRIVER'], onDone: boot });
    if (api.user.role !== 'DRIVER') return api.signOut();
    root.innerHTML = `<header class="bar"><b>🛵 Driver</b><span><button class="btn sm ghost" id="earn">Earnings</button><button class="btn sm ghost" id="out">Sign out</button></span></header><div id="view"></div><button class="sos" id="sos" hidden>SOS</button>`;
    $('#out').onclick = () => { stopGps(); api.signOut(); };
    $('#earn').onclick = guard(showEarnings);
    $('#sos').onclick = guard(sos);
    sock = api.socket();
    sock.on('trip:offer', (o) => { offers.set(o.tripId, { ...o, until: Date.now() + o.expiresInSec * 1000 }); render(); try { navigator.vibrate?.([200, 100, 200]); } catch {} });
    sock.on('trip:offer_expired', (o) => { offers.delete(o.tripId); render(); });
    sock.on('trip:update', () => refresh());
    refresh();
  }

  async function refresh() {
    [me, trip] = await Promise.all([api.get('/drivers/me'), api.get('/trips/current')]);
    if (trip) offers.clear();
    render();
  }

  function startGps() {
    if (watchId !== null || !navigator.geolocation) return;
    watchId = navigator.geolocation.watchPosition((p) => sock.emit('driver:location', { lat: p.coords.latitude, lng: p.coords.longitude }),
      () => toast('Location unavailable — enable GPS to receive trips', true), { enableHighAccuracy: true, maximumAge: 2000 });
  }
  function stopGps() { if (watchId !== null) navigator.geolocation.clearWatch(watchId); watchId = null; }

  function render() {
    const v = $('#view'); if (!v) return;
    clearInterval(tick);
    $('#sos').hidden = !trip || !NEXT[trip.status];
    if (me.verificationStatus !== 'APPROVED') return renderKyc(v);
    if (me.online || trip) startGps(); else stopGps();
    if (trip && ['COMPLETED', 'PAYMENT_FAILED'].includes(trip.status)) return renderWaitPay(v);
    if (trip) return renderTrip(v);
    renderHome(v);
  }

  // ---------- onboarding ----------
  function renderKyc(v) {
    const st = me.verificationStatus;
    if (st === 'PENDING' && me.hasDocuments) {
      v.innerHTML = `<div class="card"><h3>Under review</h3><p class="muted">We're verifying your documents. This usually takes less than a day. We'll show your status here.</p><button class="btn ghost" id="r">Check again</button></div>`;
      $('#r').onclick = guard(refresh); return;
    }
    v.innerHTML = `<div class="card"><h3>Become a SafeRide driver</h3>
      ${st === 'REJECTED' ? `<p class="pill bad">Rejected: ${esc(me.rejectionReason)}</p><p class="muted small">Fix the issue and resubmit.</p>` : ''}
      <p class="muted small">You need a valid driving licence and a Certificate of Good Conduct, and your own foldable e-scooter or e-bike.</p>
      <form id="kyc"><label>National ID number<input name="nid" inputmode="numeric" required></label>
      <label>Driving licence number<input name="dl" required></label>
      <label>Vehicle<select name="vt"><option value="E-SCOOTER">Foldable e-scooter</option><option value="E-BIKE">Foldable e-bike</option></select></label>
      <label>Photo of National ID<input type="file" accept="image/*" name="f_id" required></label>
      <label>Photo of driving licence<input type="file" accept="image/*" name="f_dl" required></label>
      <label>Photo of Certificate of Good Conduct<input type="file" accept="image/*" name="f_gc" required></label>
      <button class="btn">Submit for review</button></form></div>`;
    $('#kyc').onsubmit = guard(async (e) => {
      e.preventDefault(); const f = e.target, btn = $('button', f); btn.disabled = true;
      try {
        const up = async (name) => (await api.post('/drivers/me/upload', { image: await toDataUrl(f[name].files[0]) })).url;
        const [idUrl, licenseUrl, goodConductUrl] = [await up('f_id'), await up('f_dl'), await up('f_gc')];
        await api.post('/drivers/me/documents', { nationalId: f.nid.value, licenseNumber: f.dl.value, vehicleType: f.vt.value, idUrl, licenseUrl, goodConductUrl });
        toast('Submitted!'); refresh();
      } finally { btn.disabled = false; }
    });
  }

  // ---------- home ----------
  function renderHome(v) {
    v.innerHTML = `<div class="card"><div class="row"><div><div class="muted small">Today</div><div class="big">${kes(me.today.earned)}</div><div class="muted small">${me.today.trips} trips · ★ ${me.rating.toFixed(2)}</div></div>
      <button class="btn ${me.online ? 'bad' : ''}" id="tog" style="width:auto;padding:14px 22px">${me.online ? 'Go offline' : 'Go online'}</button></div>
      ${me.online ? '<p class="pill ok">Online — waiting for requests</p>' : '<p class="pill">Offline</p>'}</div>
      <div id="offers"></div>`;
    $('#tog').onclick = guard(async () => { await api.post('/drivers/me/online', { online: !me.online }); await refresh(); });
    drawOffers();
    tick = setInterval(drawOffers, 500);
  }

  function drawOffers() {
    const box = $('#offers'); if (!box) return;
    const now = Date.now();
    for (const [id, o] of offers) if (o.until < now) offers.delete(id);
    box.innerHTML = [...offers.values()].map((o) => {
      const left = Math.max(0, Math.ceil((o.until - now) / 1000));
      return `<div class="card offer"><div class="row"><b>New trip request</b><span class="pill warn">${left}s</span></div>
        <p>📍 ${esc(o.pickup.address || 'Pickup')} · <b>${o.pickupDistanceKm} km</b> away<br>🏠 ${esc(o.dropoff.address || 'Drop-off set on map')}<br>${o.distanceKm} km trip</p>
        <div class="row"><span class="muted small">You earn about</span><b class="big" style="font-size:1.4rem">${kes(o.driverEarning)}</b></div>
        <button class="btn" data-acc="${o.tripId}">Accept</button><button class="btn ghost" data-dec="${o.tripId}">Decline</button></div>`;
    }).join('');
    $$('[data-acc]', box).forEach((b) => (b.onclick = guard(async () => { try { await api.post(`/trips/${b.dataset.acc}/accept`); offers.clear(); await refresh(); } catch (e) { offers.delete(Number(b.dataset.acc)); toast(e.message, true); drawOffers(); } })));
    $$('[data-dec]', box).forEach((b) => (b.onclick = guard(async () => { offers.delete(Number(b.dataset.dec)); await api.post(`/trips/${b.dataset.dec}/decline`); drawOffers(); })));
  }

  // ---------- trip ----------
  function navLink(lat, lng) { return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=${trip.status === 'IN_PROGRESS' ? 'driving' : 'bicycling'}`; }

  function renderTrip(v) {
    const s = trip.status, nx = NEXT[s];
    const pre = (trip.photos || []).filter((p) => p.phase === 'PRE');
    const target = s === 'IN_PROGRESS' ? { lat: trip.dropoff_lat, lng: trip.dropoff_lng, label: trip.dropoff_address || 'Drop-off' } : { lat: trip.pickup_lat, lng: trip.pickup_lng, label: trip.pickup_address || 'Pickup' };
    v.innerHTML = `<div class="card"><div class="row"><b>Trip #${trip.id}</b><span class="pill ok">${esc(s.replace(/_/g, ' '))}</span></div>
      <p>Client: <b>${esc(trip.client_first_name || 'Client')}</b><br>Fare ${kes(trip.est_fare_kes)} · you earn ${kes(trip.driver_earning_est)}</p>
      <a class="btn ghost" style="text-align:center;text-decoration:none" target="_blank" rel="noopener" href="${navLink(target.lat, target.lng)}">🧭 Navigate to ${esc(target.label)}</a></div>
      ${s === 'ARRIVED' ? `<div class="card"><h3>Car check (${pre.length}/${me.minPrePhotos} photos)</h3><p class="muted small">Walk around the car and photograph all sides and any existing damage, before you drive. The client sees these photos.</p>
        <div class="thumbs">${pre.map((p) => `<img src="${api.imgUrl(p.photo_url)}">`).join('')}</div>
        <label>Add photo<input type="file" accept="image/*" capture="environment" id="ph"></label></div>` : ''}
      ${s === 'IN_PROGRESS' ? `<div class="card"><p class="muted small">Optional: take photos of the car at drop-off.</p><label>Add drop-off photo<input type="file" accept="image/*" capture="environment" id="ph2"></label></div>` : ''}
      <div id="act"></div>`;
    if (nx) {
      $('#act').innerHTML = `<button class="btn" id="next">${nx[1]}</button>` + (['ACCEPTED', 'DRIVER_EN_ROUTE', 'ARRIVED'].includes(s) ? '<button class="btn ghost" id="cancel">Cancel trip</button>' : '');
      $('#next').onclick = guard(async () => { $('#next').disabled = true; try { await api.post(`/trips/${trip.id}/${nx[0]}`); } finally { await refresh(); } });
      $('#cancel')?.addEventListener('click', guard(async () => { if (confirm('Cancel this trip? Frequent cancellations lower your ranking.')) { await api.post(`/trips/${trip.id}/cancel`, { reason: 'driver cancelled' }); await refresh(); } }));
    }
    const upl = (phase) => guard(async (e) => { const f = e.target.files[0]; if (!f) return; await api.post(`/trips/${trip.id}/photos`, { phase, image: await toDataUrl(f) }); toast('Photo saved'); await refresh(); });
    $('#ph')?.addEventListener('change', upl('PRE')); $('#ph2')?.addEventListener('change', upl('POST'));
  }

  function renderWaitPay(v) {
    v.innerHTML = `<div class="card"><h3>Trip complete 🎉</h3><p>Waiting for the client to pay <b>${kes(trip.final_fare_kes)}</b>. You'll earn <b>${kes(trip.driver_earning_kes)}</b>.</p><button class="btn ghost" id="r">Refresh</button></div>`;
    $('#r').onclick = guard(refresh); tick = setInterval(() => refresh().catch(() => {}), 5000);
  }

  // ---------- earnings, SOS, util ----------
  async function showEarnings() {
    const [m, e] = await Promise.all([api.get('/drivers/me'), api.get('/drivers/me/earnings')]);
    $('#view').innerHTML = `<div class="card"><div class="muted small">Wallet balance</div><div class="big">${kes(m.wallet)}</div>
      <button class="btn" id="po" ${m.wallet < 100 ? 'disabled' : ''}>Withdraw to M-Pesa</button><p class="muted small">Minimum KES 100. Paid to your registered number.</p></div>
      <div class="card"><h3>Recent trips</h3>${e.trips.length ? `<table>${e.trips.map((t) => `<tr><td>#${t.id}</td><td>${new Date(t.ended_at).toLocaleDateString('en-KE')}</td><td>${kes(t.driver_earning_kes)}</td></tr>`).join('')}</table>` : '<p class="muted">None yet.</p>'}</div>
      <div class="card"><h3>Withdrawals</h3>${e.payouts.length ? `<table>${e.payouts.map((p) => `<tr><td>${new Date(p.created_at).toLocaleDateString('en-KE')}</td><td>${kes(p.amount_kes)}</td><td>${esc(p.status)}</td></tr>`).join('')}</table>` : '<p class="muted">None yet.</p>'}</div>
      <button class="btn ghost" id="back">Back</button>`;
    $('#back').onclick = refresh;
    $('#po').onclick = guard(async () => { const r = await api.post('/drivers/me/payouts'); toast(`Sent ${kes(r.amount)} (${r.status})`); showEarnings(); });
  }

  async function sos() {
    if (!confirm('Send an emergency alert to SafeRide support?')) return;
    const pos = await new Promise((r) => navigator.geolocation.getCurrentPosition((p) => r(p.coords), () => r(null), { timeout: 4000 }));
    await api.post('/sos/trigger', { tripId: trip?.id, lat: pos?.latitude, lng: pos?.longitude }); toast('Alert sent. Support has been notified.');
  }

  // Downscale photos on the phone: keeps uploads small on mobile data.
  function toDataUrl(file, max = 1280) {
    return new Promise((res, rej) => {
      const img = new Image(), url = URL.createObjectURL(file);
      img.onload = () => {
        const k = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); res(c.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = () => rej(new Error('Could not read that image')); img.src = url;
    });
  }

  boot();
})();
