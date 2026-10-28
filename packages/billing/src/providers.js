import crypto from 'node:crypto';
import { config } from '@moranbuy/core';

// A payment provider starts a mobile-money request and verifies its webhook; the sandbox does both in memory.
export class SandboxPaymentProvider {
  constructor() { this.name = 'sandbox'; }
  async createPayment({ amount, currency, phone, metadata }) {
    return { reference: `sbx_${crypto.randomBytes(8).toString('hex')}`, status: 'pending', providerData: { sandbox: true, amount, currency, phone: phone || null, metadata } };
  }
  // The sandbox has no signature; its "webhook" is the explicit settle route that exists only outside production.
  verifyWebhook() { throw new Error('The sandbox provider has no webhook'); }
}

export class SnippePaymentProvider {
  constructor({ cfg = null, fetchImpl = globalThis.fetch, settings = null } = {}) {
    const c = cfg || config();
    this.name = 'snippe';
    this.baseUrl = String(settings?.baseUrl || c.SNIPPE_BASE_URL).replace(/\/+$/, '');
    this.apiKey = settings?.apiKey || c.SNIPPE_API_KEY;
    this.webhookSecret = settings?.webhookSecret || c.SNIPPE_WEBHOOK_SECRET;
    this.callbackUrl = `${String(settings?.appUrl || c.APP_URL).replace(/\/+$/, '')}/webhooks/payments`;
    this.fetchImpl = fetchImpl;
  }

  // The same request shape Moran uses for Snippe mobile money, with an idempotency key per attempt.
  async createPayment({ amount, currency = 'TZS', phone, metadata = {}, email = null }) {
    if (!this.apiKey) throw Object.assign(new Error('Snippe is not configured. An administrator must enter the Snippe API key in MoranBuy Admin.'), { code: 'PAYMENT_PROVIDER_NOT_CONFIGURED', status: 503 });
    const body = { payment_type: 'mobile', details: { amount: Math.round(amount), currency }, phone_number: phone, customer: { firstname: 'MoranBuy', lastname: String(phone).slice(-4), email: email || 'billing@moranbuy.invalid' }, webhook_url: this.callbackUrl, metadata };
    const res = await this.fetchImpl(`${this.baseUrl}/v1/payments`, { method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.data?.reference) throw Object.assign(new Error(json?.message || 'Could not start payment'), { code: 'PAYMENT_START_FAILED' });
    return { reference: json.data.reference, status: json.data.status || 'pending', providerData: json.data };
  }

  // HMAC-SHA256 over `${timestamp}.${rawBody}`, constant-time, with a five-minute replay window.
  verifyWebhook(rawBody, timestamp, signature) {
    if (!timestamp || !signature || !this.webhookSecret) throw new Error('Missing signature');
    const t = parseInt(timestamp, 10);
    if (!Number.isFinite(t) || Math.abs(Math.floor(Date.now() / 1000) - t) > 300) throw new Error('Webhook timestamp too old');
    const expected = crypto.createHmac('sha256', this.webhookSecret).update(`${timestamp}.${rawBody}`).digest('hex');
    const a = Buffer.from(String(signature)); const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Invalid webhook signature');
    return JSON.parse(rawBody);
  }
}

export function createPaymentProvider(cfg = config()) {
  return cfg.PAYMENT_PROVIDER === 'snippe' ? new SnippePaymentProvider({ cfg }) : new SandboxPaymentProvider();
}

// A provider whose settings come from the admin-entered credentials on every call; falls back to the sandbox outside production only.
export class RuntimePaymentProvider {
  constructor({ resolve, cfg = null, fetchImpl = globalThis.fetch }) { this.resolve = resolve; this.cfg = cfg || config(); this.fetchImpl = fetchImpl; this.sandbox = new SandboxPaymentProvider(); }
  async current() {
    const s = await this.resolve();
    if (s.provider === 'snippe') return new SnippePaymentProvider({ cfg: this.cfg, settings: s, fetchImpl: this.fetchImpl });
    if (this.cfg.APP_ENV === 'production') return new SnippePaymentProvider({ cfg: this.cfg, settings: s, fetchImpl: this.fetchImpl });
    return this.sandbox;
  }
  get name() { return this._name || (this.cfg.APP_ENV === 'production' ? 'snippe' : this.cfg.PAYMENT_PROVIDER); }
  async createPayment(args) { const p = await this.current(); this._name = p.name; return p.createPayment(args); }
  async verifyWebhookAsync(rawBody, timestamp, signature) { const p = await this.current(); this._name = p.name; return p.verifyWebhook(rawBody, timestamp, signature); }
  verifyWebhook() { throw new Error('Use verifyWebhookAsync'); }
}
