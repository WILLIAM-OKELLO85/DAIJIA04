// Network-first service worker: always tries live data, falls back to the cached app shell when offline.
const CACHE = 'saferide-shell-v1';
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.pathname.startsWith('/api/') || u.pathname.startsWith('/socket.io/') || u.pathname.startsWith('/uploads/')) return;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok && u.origin === location.origin) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request)));
});
