// Read-only live trip view for a client's trusted contacts. No sign-in: the unguessable link is the credential.
(function () {
  const root = $('#root');
  const token = new URLSearchParams(location.search).get('t') || '';
  const LABEL = { MATCHING: 'Finding a driver', ACCEPTED: 'Driver assigned', DRIVER_EN_ROUTE: 'Driver heading to pickup', ARRIVED: 'Driver at pickup',
    IN_PROGRESS: 'Trip in progress', COMPLETED: 'Arrived', PAID: 'Trip finished', CANCELLED_BY_CLIENT: 'Cancelled', CANCELLED_BY_DRIVER: 'Cancelled', NO_DRIVER_FOUND: 'No driver found' };
  const DONE = ['COMPLETED', 'PAID', 'CANCELLED_BY_CLIENT', 'CANCELLED_BY_DRIVER', 'NO_DRIVER_FOUND', 'REFUNDED'];
  let map, car, timer;

  async function tick() {
    let t;
    try {
      const r = await fetch('/api/v1/share/' + encodeURIComponent(token));
      if (!r.ok) throw new Error();
      t = await r.json();
    } catch { root.innerHTML = '<div class="card"><h3>Link not found</h3><p class="muted">This tracking link is invalid or has expired.</p></div>'; clearInterval(timer); return; }

    if (!map) {
      root.innerHTML = `<header class="bar"><b>🚗 SafeRide live trip</b></header><div class="card"><div class="row"><b id="st"></b><span class="pill ok" id="ins"></span></div><p class="muted small" id="dr"></p></div><div id="map"></div>`;
      map = L.map($('#map'), { zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false }).setView([t.pickup.lat, t.pickup.lng], 14);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
      L.circleMarker([t.pickup.lat, t.pickup.lng], { radius: 8, color: '#0b7a53', fillOpacity: .8 }).addTo(map).bindTooltip('Pickup');
      L.circleMarker([t.dropoff.lat, t.dropoff.lng], { radius: 8, color: '#c0392b', fillOpacity: .8 }).addTo(map).bindTooltip('Destination');
    }
    $('#st').textContent = LABEL[t.status] || t.status;
    $('#ins').textContent = t.insurance ? 'Insured' : ''; $('#ins').hidden = !t.insurance;
    $('#dr').textContent = t.driver ? `Driver: ${t.driver.name || 'SafeRide driver'} · rated ${t.driver.rating}` : '';
    if (t.driverLocation) {
      const ll = [t.driverLocation.lat, t.driverLocation.lng];
      if (!car) car = L.marker(ll).addTo(map).bindTooltip('Driver'); else car.setLatLng(ll);
      map.panTo(ll);
    }
    if (DONE.includes(t.status)) clearInterval(timer);
  }
  tick(); timer = setInterval(tick, 5000);
})();
