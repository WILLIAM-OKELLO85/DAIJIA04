// Shared client: token storage + auto-refresh, fetch wrapper, socket, helpers. No framework, no build step.
(function () {
  const KEY = 'saferide.auth';
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; } };
  const save = (a) => { try { a ? localStorage.setItem(KEY, JSON.stringify(a)) : localStorage.removeItem(KEY); } catch {} };
  let auth = load();
  let refreshing = null;

  async function refresh() {
    if (!auth?.refreshToken) throw new Error('signed out');
    refreshing = refreshing || fetch('/api/v1/auth/refresh', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: auth.refreshToken }),
    }).then(async (r) => {
      if (!r.ok) { api.signOut(false); throw new Error('session expired'); }
      const t = await r.json();
      auth = { ...auth, accessToken: t.accessToken, refreshToken: t.refreshToken };
      save(auth);
    }).finally(() => { refreshing = null; });
    return refreshing;
  }

  async function request(method, path, body, retry = true) {
    const res = await fetch('/api/v1' + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(auth?.accessToken ? { Authorization: 'Bearer ' + auth.accessToken } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && retry && auth?.refreshToken) { await refresh(); return request(method, path, body, false); }
    const data = await res.json().catch(() => null);
    if (!res.ok) { const e = new Error(data?.error || 'Request failed'); e.status = res.status; e.code = data?.code; throw e; }
    return data;
  }

  const api = {
    get: (p) => request('GET', p), del: (p) => request('DELETE', p), post: (p, b) => request('POST', p, b ?? {}), put: (p, b) => request('PUT', p, b),
    get user() { return auth?.user || null; },
    get token() { return auth?.accessToken; },
    async requestOtp(phone) { return request('POST', '/auth/otp/request', { phone }); },
    async verifyOtp(phone, code, role, name) {
      const r = await request('POST', '/auth/otp/verify', { phone, code, role, name: name || undefined });
      auth = { accessToken: r.accessToken, refreshToken: r.refreshToken, user: r.user }; save(auth); return r;
    },
    signOut(reload = true) { try { request('POST', '/auth/logout').catch(() => {}); } catch {} auth = null; save(null); if (reload) location.reload(); },
    // Authenticated URL for private images (uses the short-lived access token)
    imgUrl: (u) => u + '?token=' + encodeURIComponent(auth?.accessToken || ''),
    socket() {
      const s = io({ auth: (cb) => cb({ token: auth?.accessToken }) });
      s.on('connect_error', async (e) => { if (e.message === 'unauthorized') { try { await refresh(); s.connect(); } catch {} } });
      return s;
    },
  };
  window.api = api;

  // ---- tiny helpers ----
  window.$ = (sel, root = document) => root.querySelector(sel);
  window.$$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  window.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  window.kes = (n) => 'KES ' + Math.round(Number(n || 0)).toLocaleString('en-KE');
  window.toast = (msg, bad) => {
    let t = $('#toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
    t.textContent = msg; t.className = 'show' + (bad ? ' bad' : ''); clearTimeout(t._h); t._h = setTimeout(() => (t.className = ''), 3500);
  };
  window.guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message, true); } };

  // Reusable phone+OTP login screen. mount: element; opts: { roles: ['CLIENT'], onDone }
  window.mountLogin = function (mount, opts) {
    const roles = opts.roles;
    mount.innerHTML = `<div class="card login"><h2>${esc(opts.title)}</h2><p class="muted">${esc(opts.sub || '')}</p>
      <form id="f1"><label>Phone number<input id="ph" inputmode="tel" placeholder="0712 345 678" autocomplete="tel" required></label>
      <button class="btn">Send code</button></form>
      <form id="f2" hidden><label>6-digit code<input id="cd" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required></label>
      <label>Your name (first time only)<input id="nm" autocomplete="name"></label>
      <button class="btn">Verify &amp; continue</button><button type="button" class="btn ghost" id="back">Change number</button></form></div>`;
    let phone = '';
    $('#f1', mount).onsubmit = guard(async (e) => {
      e.preventDefault(); phone = $('#ph', mount).value;
      const r = await api.requestOtp(phone);
      $('#f1', mount).hidden = true; $('#f2', mount).hidden = false;
      if (r.devCode) { $('#cd', mount).value = r.devCode; toast('Dev mode: code filled in for you'); }
      $('#cd', mount).focus();
    });
    $('#back', mount).onclick = () => { $('#f1', mount).hidden = false; $('#f2', mount).hidden = true; };
    $('#f2', mount).onsubmit = guard(async (e) => {
      e.preventDefault();
      const r = await api.verifyOtp(phone, $('#cd', mount).value, roles[0], $('#nm', mount).value);
      if (!roles.includes(r.user.role) && !(opts.allow || []).includes(r.user.role)) { api.signOut(false); throw new Error('This number is registered for a different app (' + r.user.role + ').'); }
      opts.onDone(r.user);
    });
  };

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
