import http from 'node:http';

// A small stand-in for the Moran owner API routes MoranBuy calls, with the response shapes read from moran-backend.
export function startFakeMoran({ tenant, services = [], productsByService = {}, locations = [], password = 'moran-pass', twoFactor = false } = {}) {
  const state = { products: structuredClone(productsByService), refreshCount: 0, patches: [], twoFactorTokens: new Set() };
  const tokenFor = (n) => `moran-access-${n}`;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      const auth = req.headers.authorization || '';
      const authed = auth.startsWith('Bearer moran-access-');
      const url = new URL(req.url, 'http://x');
      const parsed = body ? JSON.parse(body) : {};
      if (req.method === 'POST' && url.pathname === '/api/auth/login') {
        if (parsed.email !== tenant.owner_email || parsed.password !== password) return json(401, { error: 'INVALID_CREDENTIALS' });
        if (twoFactor) { state.twoFactorTokens.add('2fa-token-1'); return json(200, { twoFactorRequired: true, token: '2fa-token-1' }); }
        return json(200, { accessToken: tokenFor(1), refreshToken: 'moran-refresh-1', tenant, user: { role: 'owner', email: tenant.owner_email } });
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/2fa') {
        if (!state.twoFactorTokens.has(parsed.token) || parsed.code !== '123456') return json(401, { error: 'INVALID_CODE' });
        return json(200, { accessToken: tokenFor(1), refreshToken: 'moran-refresh-1', tenant, user: { role: 'owner', email: tenant.owner_email } });
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/refresh') {
        if (!/^moran-refresh-\d+$/.test(parsed.refreshToken || '')) return json(401, { error: 'INVALID_REFRESH_TOKEN' });
        state.refreshCount += 1;
        return json(200, { accessToken: tokenFor(state.refreshCount + 1), refreshToken: `moran-refresh-${state.refreshCount + 1}` });
      }
      if (!authed) return json(401, { error: 'MISSING_TOKEN' });
      if (url.pathname === '/api/auth/me') return json(200, { tenant, user: { role: 'owner', email: tenant.owner_email } });
      if (url.pathname === '/api/services') return json(200, { services });
      if (url.pathname === '/api/products' && req.method === 'GET') {
        const sid = req.headers['x-service-id'];
        if (!sid) return json(400, { error: 'SERVICE_REQUIRED' });
        return json(200, { products: state.products[sid] || [] });
      }
      const patch = url.pathname.match(/^\/api\/products\/([^/]+)$/);
      if (patch && req.method === 'PATCH') {
        const sid = req.headers['x-service-id'];
        const p = (state.products[sid] || []).find((x) => x.id === patch[1]);
        if (!p) return json(404, { error: 'PRODUCT_NOT_FOUND' });
        Object.assign(p, parsed, { updated_at: new Date().toISOString() });
        state.patches.push({ id: patch[1], patch: parsed });
        return json(200, { product: p });
      }
      if (url.pathname === '/api/business-locations') return json(200, { locations });
      json(404, { error: 'NOT_FOUND' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}`, state, close: () => new Promise((r) => server.close(r)) })));
}
