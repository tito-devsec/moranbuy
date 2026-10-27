// How a campaign message leaves: recorded only (dry run) or through Moran from the merchant's own connected number.
export class DryRunSender {
  constructor() { this.name = 'dry_run'; this.sent = []; }
  async sendTemplate(msg) { this.sent.push(msg); return { ok: true, messageId: `dry-${this.sent.length}`, dryRun: true }; }
  async sendText(msg) { this.sent.push(msg); return { ok: true, messageId: `dry-${this.sent.length}`, dryRun: true }; }
}

export class MoranMerchantSender {
  constructor(moranInternal) { this.name = 'moran_merchant_number'; this.moran = moranInternal; }
  async sendTemplate({ tenantId, to, templateName, language, components, idempotencyKey }) {
    const r = await this.moran.sendTemplate({ tenantId, to, templateName, language, components, idempotencyKey });
    return r.ok ? { ok: true, messageId: r.data?.messageId || null } : { ok: false, error: r.data?.error || r.status, retryable: /^http_5|not_configured/.test(r.status) };
  }
  async sendText({ tenantId, to, body, idempotencyKey }) {
    const r = await this.moran.sendMerchantText({ tenantId, to, body, idempotencyKey });
    return r.ok ? { ok: true, messageId: r.data?.messageId || null } : { ok: false, error: r.data?.error || r.status, retryable: /^http_5|not_configured/.test(r.status) };
  }
}
