// Shared client for the MoranBuy business app: session storage, API calls with refresh, and small helpers.
(function () {
  const ACCESS = 'moranbuy_merchant_access';
  const REFRESH = 'moranbuy_merchant_refresh';
  const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const set = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} };

  async function refresh() {
    const r = get(REFRESH);
    if (!r) return false;
    const res = await fetch('/api/merchants/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: r }) });
    if (!res.ok) { set(ACCESS, null); set(REFRESH, null); return false; }
    const d = await res.json();
    set(ACCESS, d.accessToken); set(REFRESH, d.refreshToken);
    return true;
  }

  // One place every request goes through; a 401 tries one refresh and then signs out.
  async function api(path, { method = 'GET', body, retry = true } = {}) {
    const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json', ...(get(ACCESS) ? { Authorization: `Bearer ${get(ACCESS)}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401 && retry && (await refresh())) return api(path, { method, body, retry: false });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.message || data.error || `HTTP ${res.status}`), { code: data.error, details: data.details, status: res.status });
    return data;
  }

  window.MoranBuy = {
    api,
    session: { save: (d) => { set(ACCESS, d.accessToken); set(REFRESH, d.refreshToken); }, clear: () => { set(ACCESS, null); set(REFRESH, null); }, loggedIn: () => !!get(ACCESS) },
    money: (n, c = 'TZS') => (n === null || n === undefined ? 'not stated' : `${c === 'TZS' ? 'TSh' : c} ${Number(n).toLocaleString('en-US')}`),
    label: (s) => String(s || '').replace(/_/g, ' '),
  };
})();
