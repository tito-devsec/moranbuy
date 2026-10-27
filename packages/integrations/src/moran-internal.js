import { config } from '@moranbuy/core';
import { signBody } from './signing.js';

// The signed internal channel to Moran for the admin-managed MoranBuy business: send replies, read listings and knowledge.
export class MoranInternalClient {
  constructor({ cfg = null, fetchImpl = globalThis.fetch } = {}) {
    const c = cfg || config();
    this.baseUrl = String(c.MORAN_BACKEND_BASE_URL || '').replace(/\/+$/, '');
    this.secret = c.MORAN_SHARED_SECRET || null;
    this.fetchImpl = fetchImpl;
  }

  get configured() { return !!(this.baseUrl && this.secret); }

  // Signed POST or GET to /internal/moranbuy/*; a missing configuration is reported, never hidden.
  async call(path, { method = 'POST', body = null } = {}) {
    if (!this.configured) return { ok: false, status: 'not_configured' };
    const raw = body ? JSON.stringify(body) : '';
    const { timestamp, signature } = signBody(this.secret, raw);
    const res = await this.fetchImpl(`${this.baseUrl}/internal/moranbuy${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-MoranBuy-Timestamp': timestamp, 'X-MoranBuy-Signature': signature },
      body: method === 'GET' ? undefined : raw,
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.ok ? 'ok' : `http_${res.status}`, data };
  }

  // Sends a text reply from the MoranBuy WhatsApp number through Moran's outbound gate.
  sendText({ to, body, idempotencyKey }) { return this.call('/send', { body: { type: 'text', to, body, idempotencyKey } }); }

  // Sends a product photo with a caption.
  sendImage({ to, imageUrl, caption, idempotencyKey }) { return this.call('/send', { body: { type: 'image', to, imageUrl, caption, idempotencyKey } }); }

  // Sends an approved template from a merchant's own connected number through Moran's outbound gate (the Moran-side drop-in checks the merchant opted in).
  sendTemplate({ tenantId, to, templateName, language, components = [], idempotencyKey }) { return this.call('/send-template', { body: { tenantId, to, templateName, language, components, idempotencyKey } }); }

  // Sends a plain text (inside a customer-service window) from a merchant's own number through Moran's outbound gate.
  sendMerchantText({ tenantId, to, body, idempotencyKey }) { return this.call('/send', { body: { type: 'text', tenantId, to, body, idempotencyKey } }); }

  // Pages through listings of Moran businesses that opted into MoranBuy, newest changes first.
  listings({ since = null, page = 1, pageSize = 200 } = {}) {
    const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize), ...(since ? { since } : {}) });
    return this.call(`/listings?${qs}`, { method: 'GET' });
  }

  // Searches the admin-written knowledge of the MoranBuy tenant.
  knowledgeSearch(query, limit = 3) { return this.call(`/knowledge/search?${new URLSearchParams({ q: query, limit: String(limit) })}`, { method: 'GET' }); }
}

// A recording stand-in for tests and dry runs: every send is kept in memory, nothing leaves the process.
export class FakeMoranInternalClient {
  constructor({ listings = [], knowledge = [] } = {}) { this.sent = []; this.listingRows = listings; this.knowledge = knowledge; this.configured = true; }
  async sendText(m) { this.sent.push({ type: 'text', ...m }); return { ok: true, status: 'ok', data: { messageId: `fake-${this.sent.length}` } }; }
  async sendImage(m) { this.sent.push({ type: 'image', ...m }); return { ok: true, status: 'ok', data: { messageId: `fake-${this.sent.length}` } }; }
  async sendMerchantText(m) { this.sent.push({ type: 'merchant_text', ...m }); return { ok: true, status: 'ok', data: { messageId: `fake-${this.sent.length}` } }; }
  async sendTemplate(m) { if (this.failNext) { this.failNext = false; return { ok: false, status: 'http_502', data: { error: 'META_ERROR' } }; } this.sent.push({ type: 'template', ...m }); return { ok: true, status: 'ok', data: { messageId: `fake-${this.sent.length}` } }; }
  async listings() { return { ok: true, status: 'ok', data: { listings: this.listingRows, nextPage: null } }; }
  async knowledgeSearch() { return { ok: true, status: 'ok', data: { passages: this.knowledge } }; }
}
