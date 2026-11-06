// Venue staff portal: request a driver for a patron, see referral stats and the venue QR link.
(function () {
  const root = $('#root');
  let venue = null, map, drop = null, dropMark = null;

  async function boot() {
    if (!api.user) {
      // Venue accounts are created by an admin; existing numbers just sign in.
      mountLogin(root, { title: 'SafeRide for venues', sub: 'Sign in with the phone number registered by SafeRide.', roles: ['CLIENT'], allow: ['VENUE', 'ADMIN'], onDone: boot });
      return;
    }
    if (!['VENUE', 'ADMIN'].includes(api.user.role)) { api.signOut(); return; }
    try { venue = await api.get('/venues/mine'); }
    catch (e) {
      root.innerHTML = `<div class="card"><h3>No venue linked</h3><p class="muted">${esc(e.message)}. Ask SafeRide to link your number to a venue.</p><button class="btn ghost" id="out">Sign out</button></div>`;
      $('#out').onclick = () => api.signOut(); return;
    }
    const stats = await api.get(`/venues/${venue.id}/stats`);
    const link = `${location.origin}/client/?venue=${encodeURIComponent(venue.referral_code)}`;
    root.innerHTML = `<header class="bar"><b>🍸 ${esc(venue.name)}</b><button class="btn sm ghost" id="out">Sign out</button></header>
      <div class="grid"><div class="stat"><span class="muted small">Requests</span><b>${stats.total_requests}</b></div>
      <div class="stat"><span class="muted small">Paid rides</span><b>${stats.paid_trips}</b></div>
      <div class="stat"><span class="muted small">Referral earnings</span><b>${kes(stats.earnedKes)}</b></div></div>
      <div class="card"><h3>Get a patron home</h3>
        <label>Patron phone<input id="pp" inputmode="tel" placeholder="0712 345 678"></label>
        <label>Patron name (optional)<input id="pn"></label>
        <p class="muted small" id="hint">Tap the map to set where the patron is going.</p><div id="map"></div>
        <label>Destination note (optional)<input id="pa" placeholder="e.g. Kilimani, Argwings Kodhek Rd"></label>
        <button class="btn" id="go" disabled>Request driver</button>
        <p class="muted small">Pickup is the venue. The patron gets an SMS and pays by M-Pesa on their own phone.</p></div>
      <div class="card"><h3>Your QR link</h3><p class="small" style="word-break:break-all"><a href="${esc(link)}" target="_blank" rel="noopener">${esc(link)}</a></p>
        <p class="muted small">Print this link as a QR code for tables. Patrons who open it get this venue as their pickup.</p></div>
      <div id="result"></div>`;
    $('#out').onclick = () => api.signOut();
    map = L.map($('#map'), { zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false }).setView([venue.lat, venue.lng], 14);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
    L.circleMarker([venue.lat, venue.lng], { radius: 9, color: '#0b7a53', fillOpacity: .8 }).addTo(map).bindTooltip('Venue');
    map.on('click', (e) => {
      drop = { lat: e.latlng.lat, lng: e.latlng.lng };
      dropMark?.remove(); dropMark = L.circleMarker(e.latlng, { radius: 9, color: '#c0392b', fillOpacity: .8 }).addTo(map);
      $('#go').disabled = false;
    });
    $('#go').onclick = guard(async () => {
      $('#go').disabled = true;
      try {
        const t = await api.post(`/venues/${venue.id}/request-driver`, {
          patronPhone: $('#pp').value, patronName: $('#pn').value || undefined, dropoff: { ...drop, address: $('#pa').value || undefined },
        });
        $('#result').innerHTML = `<div class="card"><span class="pill ok">Requested</span> <b>Trip #${t.id}</b> — about ${kes(t.est_fare_kes)}. We're finding a driver; the patron has been texted.</div>`;
        $('#pp').value = ''; $('#pn').value = '';
      } finally { $('#go').disabled = false; }
    });
  }
  boot();
})();
