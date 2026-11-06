(function () {
  const root = $('#root');
  const NAIROBI = [-1.2864, 36.8172];
  let map, pickupMark, dropMark, driverMark, trip = null, sock = null, pick = { pickup: null, dropoff: null }, mode = 'pickup', quote = null;

  const STEP = { MATCHING: 1, ACCEPTED: 2, DRIVER_EN_ROUTE: 2, ARRIVED: 3, IN_PROGRESS: 4, COMPLETED: 5, PAYMENT_FAILED: 5, PAID: 6 };
  const LABEL = {
    MATCHING: 'Finding you a driver…', ACCEPTED: 'Driver accepted', DRIVER_EN_ROUTE: 'Driver is on the way', ARRIVED: 'Driver has arrived',
    IN_PROGRESS: 'On your way home', COMPLETED: 'You have arrived — payment due', PAYMENT_FAILED: 'Payment not completed', PAID: 'Paid. Thank you!',
    NO_DRIVER_FOUND: 'No driver available right now', CANCELLED_BY_CLIENT: 'Trip cancelled', CANCELLED_BY_DRIVER: 'Driver cancelled',
  };

  function boot() {
    if (!api.user) {
      mountLogin(root, { title: 'SafeRide', sub: 'Had a drink? We drive you and your car home.', roles: ['CLIENT'], onDone: boot });
      return;
    }
    if (api.user.role !== 'CLIENT') { api.signOut(); return; }
    root.innerHTML = `<header class="bar"><b>🚗 SafeRide</b><span><button class="btn sm ghost" id="hist">Trips</button><button class="btn sm ghost" id="acct">Account</button></span></header><div id="view"></div><button class="sos" id="sos" hidden>SOS</button>`;
    $('#hist').onclick = guard(showHistory); $('#acct').onclick = guard(showAccount);
    $('#sos').onclick = guard(sendSos);
    sock = api.socket();
    sock.on('trip:update', (u) => { if (u.status === 'NO_DRIVER_FOUND') { trip = { status: 'NO_DRIVER_FOUND', id: u.tripId }; render(); } else refresh(); });
    sock.on('driver:location', (d) => moveDriver(d.lat, d.lng));
    sock.on('trip:photo', () => refresh());
    refresh();
  }

  const skipped = () => { try { return localStorage.getItem('saferide.skipRate'); } catch { return null; } };
  async function refresh() {
    trip = await api.get('/trips/current');
    if (trip && trip.status === 'PAID' && String(trip.id) === skipped()) trip = null; // client chose to skip rating
    render();
  }

  function setMap(el) {
    if (map) { map.remove(); map = null; pickupMark = dropMark = driverMark = null; }
    map = L.map(el, { zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false }).setView(NAIROBI, 13);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  }
  const pin = (ll, color) => L.circleMarker(ll, { radius: 9, color, fillColor: color, fillOpacity: .8 }).addTo(map);
  // The view is re-rendered with innerHTML, which orphans the map's container; drop the dead map instead of using it.
  function dropDeadMap() {
    if (map && !document.body.contains(map.getContainer())) { try { map.remove(); } catch {} map = null; pickupMark = dropMark = driverMark = null; }
  }
  function moveDriver(lat, lng) {
    dropDeadMap();
    if (!map) return;
    if (!driverMark) driverMark = L.marker([lat, lng], { title: 'Driver' }).addTo(map); else driverMark.setLatLng([lat, lng]);
    map.panTo([lat, lng]);
  }

  function render() {
    const v = $('#view'); if (!v) return;
    dropDeadMap();
    const s = trip?.status;
    $('#sos').hidden = !['ACCEPTED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'].includes(s);
    if (!trip || ['NO_DRIVER_FOUND', 'CANCELLED_BY_CLIENT', 'CANCELLED_BY_DRIVER'].includes(s)) return renderRequest(v, s);
    renderTrip(v);
  }

  // ---------- request ----------
  function renderRequest(v, endedStatus) {
    v.innerHTML = `${endedStatus ? `<div class="card"><b>${LABEL[endedStatus]}</b><p class="muted small">You can try again below.</p></div>` : ''}
      <div class="card"><h3>Where to?</h3>
      <div class="tabs"><button id="m1" class="on">Pickup</button><button id="m2">Drop-off</button></div>
      <p class="muted small" id="hint">Tap the map to set your pickup, or use your location.</p>
      <div id="map"></div>
      <button class="btn ghost" id="loc">📍 Use my current location</button>
      <label>Venue code (optional)<input id="vc" placeholder="Scan QR or type code"></label>
      <label>Promo code (optional)<input id="promo" placeholder="LAUNCH20" style="text-transform:uppercase"></label>
      <div id="q"></div><button class="btn" id="go" disabled>Get fare estimate</button></div>`;
    setMap($('#map'));
    pick = { pickup: null, dropoff: null }; mode = 'pickup'; quote = null;
    const setMode = (m) => { mode = m; $('#m1').className = m === 'pickup' ? 'on' : ''; $('#m2').className = m === 'dropoff' ? 'on' : ''; $('#hint').textContent = m === 'pickup' ? 'Tap the map to set your pickup.' : 'Tap the map to set your drop-off (home).'; };
    $('#m1').onclick = () => setMode('pickup'); $('#m2').onclick = () => setMode('dropoff');
    const place = (which, ll) => {
      pick[which] = { lat: ll.lat, lng: ll.lng };
      if (which === 'pickup') { pickupMark?.remove(); pickupMark = pin(ll, '#0b7a53'); } else { dropMark?.remove(); dropMark = pin(ll, '#c0392b'); }
      quote = null; $('#q').innerHTML = ''; $('#go').textContent = 'Get fare estimate'; $('#go').disabled = !(pick.pickup && pick.dropoff);
      if (which === 'pickup' && !pick.dropoff) setMode('dropoff');
    };
    map.on('click', (e) => place(mode, e.latlng));
    $('#loc').onclick = () => navigator.geolocation?.getCurrentPosition((p) => { const ll = { lat: p.coords.latitude, lng: p.coords.longitude }; map.setView([ll.lat, ll.lng], 15); place('pickup', ll); }, () => toast('Could not get your location — tap the map instead', true), { enableHighAccuracy: true, timeout: 8000 });
    $('#vc').onchange = guard(async (e) => {
      if (!e.target.value) return;
      const ven = await fetch('/api/v1/venues/by-code/' + encodeURIComponent(e.target.value)).then((r) => r.ok ? r.json() : Promise.reject(new Error('Unknown venue code')));
      map.setView([ven.lat, ven.lng], 16); place('pickup', { lat: ven.lat, lng: ven.lng }); toast('Pickup set to ' + ven.name);
    });
    const qv = new URLSearchParams(location.search).get('venue');
    if (qv) { $('#vc').value = qv; $('#vc').onchange({ target: $('#vc') }); }
    $('#go').onclick = guard(async () => {
      const body = { pickup: pick.pickup, dropoff: pick.dropoff, promoCode: $('#promo').value.trim() || undefined };
      if (!quote) {
        quote = await api.post('/trips/quote', body);
        $('#q').innerHTML = `<div class="row"><div><div class="big">${kes(quote.total)}</div><div class="muted small">${quote.distanceKm} km${quote.surge > 1 ? ' · night rate ×' + quote.surge : ''}${quote.discount ? ' · saved ' + kes(quote.discount) : ''}</div></div>
          <div class="muted small" style="text-align:right">${quote.nearbyDrivers} driver${quote.nearbyDrivers === 1 ? '' : 's'} nearby${quote.etaMin ? '<br>~' + quote.etaMin + ' min' : ''}</div></div>`;
        $('#go').textContent = 'Request driver';
      } else {
        $('#go').disabled = true; trip = await api.post('/trips/request', body); render();
      }
    });
    navigator.geolocation?.getCurrentPosition((p) => map?.setView([p.coords.latitude, p.coords.longitude], 14), () => {}, { timeout: 4000 });
  }

  // ---------- active trip ----------
  function renderTrip(v) {
    const s = trip.status, step = STEP[s] || 1, d = trip.driver;
    const photos = (trip.photos || []).filter((p) => p.phase === 'PRE');
    v.innerHTML = `<div class="card"><div class="steps">${[1, 2, 3, 4, 5, 6].map((i) => `<i class="${i <= step ? 'on' : ''}"></i>`).join('')}</div>
      <h3>${LABEL[s] || s}</h3>
      ${d ? `<div class="row"><div><b>${esc(d.name || 'Your driver')}</b> ${d.verified ? '<span class="pill ok">Verified</span>' : ''}<div class="muted small">★ ${d.rating.toFixed(1)} · ${d.trips} trips</div></div></div>` : '<p class="muted">We\'re contacting drivers near you.</p>'}
      <div class="row" style="margin-top:8px"><span class="muted small">Fare</span><b>${kes(trip.final_fare_kes ?? trip.est_fare_kes)}</b></div>
      ${trip.insurance_ref ? `<div class="muted small">Covered by trip insurance · ${esc(trip.insurance_ref)}</div>` : ''}</div>
      ${['ACCEPTED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'].includes(s) ? '<div id="map"></div>' : ''}
      ${photos.length ? `<div class="card"><b>Your car before the trip</b><p class="muted small">Please check these photos match the car's condition.</p><div class="thumbs">${photos.map((p) => `<img src="${api.imgUrl(p.photo_url)}" alt="car photo">`).join('')}</div></div>` : ''}
      <div id="actions"></div>`;
    if ($('#map')) {
      setMap($('#map'));
      pickupMark = pin([trip.pickup_lat, trip.pickup_lng], '#0b7a53'); dropMark = pin([trip.dropoff_lat, trip.dropoff_lng], '#c0392b');
      map.fitBounds([[trip.pickup_lat, trip.pickup_lng], [trip.dropoff_lat, trip.dropoff_lng]], { padding: [30, 30] });
    }
    const a = $('#actions');
    if (['MATCHING', 'ACCEPTED', 'DRIVER_EN_ROUTE', 'ARRIVED'].includes(s)) {
      a.innerHTML = `<button class="btn ghost" id="cancel">Cancel trip</button>`;
      $('#cancel').onclick = guard(async () => { if (confirm(s === 'MATCHING' ? 'Cancel this request?' : 'The driver is already on the way — a small cancellation fee may apply. Cancel?')) { trip = await api.post(`/trips/${trip.id}/cancel`, { reason: 'client cancelled' }); await refresh(); } });
    }
    if (['IN_PROGRESS', 'ACCEPTED', 'DRIVER_EN_ROUTE', 'ARRIVED'].includes(s) && trip.share_token) {
      a.insertAdjacentHTML('beforeend', `<button class="btn ghost" id="share">Share live trip with a friend</button>`); // not innerHTML+=, which would wipe the Cancel handler
      $('#share').onclick = guard(async () => {
        const url = `${location.origin}/share/?t=${trip.share_token}`;
        if (navigator.share) await navigator.share({ title: 'Follow my SafeRide trip', url }); else { await navigator.clipboard.writeText(url); toast('Link copied'); }
      });
    }
    if (['COMPLETED', 'PAYMENT_FAILED'].includes(s)) {
      a.innerHTML = `<button class="btn" id="pay">Pay ${kes(trip.final_fare_kes)} with M-Pesa</button><p class="muted small" id="paymsg"></p>`;
      $('#pay').onclick = guard(async () => {
        $('#pay').disabled = true; const r = await api.post('/payments/mpesa/stk-push', { tripId: trip.id }); $('#paymsg').textContent = r.message;
        setTimeout(() => { const b = $('#pay'); if (b) b.disabled = false; }, 20000);
      });
    }
    if (s === 'PAID') {
      a.innerHTML = trip.client_rating ? `<button class="btn" id="done">Done</button>` : `<div class="card"><b>How was your driver?</b><div class="tabs" id="stars">${[1, 2, 3, 4, 5].map((n) => `<button data-n="${n}">${'★'.repeat(n)}</button>`).join('')}</div><textarea id="fb" rows="2" placeholder="Comments (optional)"></textarea><button class="btn ghost" id="skip">Skip</button></div>`;
      $('#done')?.addEventListener('click', () => { trip = null; render(); });
      $('#skip')?.addEventListener('click', () => { try { localStorage.setItem('saferide.skipRate', String(trip.id)); } catch {} trip = null; render(); });
      $$('#stars button').forEach((b) => (b.onclick = guard(async () => { await api.post(`/trips/${trip.id}/rate`, { rating: Number(b.dataset.n), feedback: $('#fb').value || undefined }); toast('Thanks for your feedback!'); trip = null; render(); })));
    }
  }

  // ---------- SOS / account / history ----------
  async function sendSos() {
    if (!confirm('Send an emergency alert to SafeRide support and your emergency contacts?')) return;
    const pos = await new Promise((r) => navigator.geolocation ? navigator.geolocation.getCurrentPosition((p) => r(p.coords), () => r(null), { timeout: 4000 }) : r(null));
    const r = await api.post('/sos/trigger', { tripId: trip?.id, lat: pos?.latitude, lng: pos?.longitude });
    toast(`Alert sent. ${r.notifiedContacts} contact(s) notified.`);
  }

  async function showAccount() {
    const me = await api.get('/auth/me');
    $('#view').innerHTML = `<div class="card"><h3>Account</h3><p>${esc(me.name || '')}<br><span class="muted">${esc(me.phone)}</span></p>
      <h3>Emergency contacts</h3><div id="ec">${me.emergencyContacts.map((c) => `<div class="row"><span>${esc(c.contact_name)} · ${esc(c.contact_phone)}</span><button class="btn sm ghost" data-del="${c.id}">Remove</button></div>`).join('') || '<p class="muted small">None yet. They get an SMS with your live location if you press SOS.</p>'}</div>
      <label>Name<input id="cn"></label><label>Phone<input id="cp" inputmode="tel"></label><button class="btn" id="add">Add contact</button>
      <button class="btn ghost" id="back">Back</button><button class="btn ghost" id="out">Sign out</button></div>`;
    $('#back').onclick = refresh; $('#out').onclick = () => api.signOut();
    $('#add').onclick = guard(async () => { await api.post('/auth/emergency-contacts', { name: $('#cn').value, phone: $('#cp').value }); showAccount(); });
    $$('[data-del]').forEach((b) => (b.onclick = guard(async () => { await api.del('/auth/emergency-contacts/' + b.dataset.del); showAccount(); })));
  }

  async function showHistory() {
    const rows = await api.get('/trips');
    $('#view').innerHTML = `<div class="card"><h3>Your trips</h3>${rows.length ? `<table>${rows.map((t) => `<tr><td>#${t.id}<div class="muted small">${new Date(t.requested_at).toLocaleString('en-KE')}</div></td><td>${esc(t.status.replace(/_/g, ' '))}</td><td>${kes(t.final_fare_kes ?? t.est_fare_kes)}</td></tr>`).join('')}</table>` : '<p class="muted">No trips yet.</p>'}<button class="btn ghost" id="back">Back</button></div>`;
    $('#back').onclick = refresh;
  }

  boot();
})();
