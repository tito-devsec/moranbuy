import { config } from '@moranbuy/core';

// Calls Moran's owner API with a linked merchant's own tokens: sign in, who am I, products, locations, product edits.
export class MoranOwnerClient {
  constructor({ cfg = null, fetchImpl = globalThis.fetch } = {}) {
    const c = cfg || config();
    this.baseUrl = String(c.MORAN_BACKEND_BASE_URL || '').replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
  }

  get configured() { return !!this.baseUrl; }

  async request(path, { method = 'GET', token = null, body = null, serviceId = null } = {}) {
    if (!this.configured) throw Object.assign(new Error('MORAN_NOT_CONFIGURED'), { code: 'MORAN_NOT_CONFIGURED' });
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(serviceId ? { 'X-Service-Id': serviceId } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  // The merchant's own Moran sign-in; a 2FA challenge is passed back to the caller unchanged.
  login({ email, password }) { return this.request('/api/auth/login', { method: 'POST', body: { email, password } }); }
  secondStep(body) { return this.request('/api/auth/2fa', { method: 'POST', body }); }
  refresh(refreshToken) { return this.request('/api/auth/refresh', { method: 'POST', body: { refreshToken } }); }
  me(token) { return this.request('/api/auth/me', { token }); }
  services(token) { return this.request('/api/services', { token }); }
  products(token, serviceId) { return this.request('/api/products', { token, serviceId }); }
  updateProduct(token, serviceId, id, patch) { return this.request(`/api/products/${id}`, { method: 'PATCH', token, serviceId, body: patch }); }
  locations(token) { return this.request('/api/business-locations', { token }); }
  // Template lifecycle in Moran: the draft is saved and submitted there, and the status is whatever Meta told Moran.
  createTemplate(token, serviceId, draft) { return this.request('/api/whatsapp-templates', { method: 'POST', token, serviceId, body: draft }); }
  submitTemplate(token, id) { return this.request(`/api/whatsapp-templates/${id}/submit`, { method: 'POST', token }); }
  getTemplate(token, id) { return this.request(`/api/whatsapp-templates/${id}`, { token }); }
  syncTemplates(token) { return this.request('/api/whatsapp-templates/sync', { method: 'POST', token }); }
}
