import { hasActiveEntitlement } from '@moranbuy/authorization';
import { paymentCompleted } from '@moranbuy/billing';
import { resolveAudience } from '@moranbuy/consent-management';

// Whether this merchant may send business-initiated WhatsApp messages, and from which sender; never assumed.
export function senderEligibility(merchant) {
  if (merchant.registration_type !== 'moran' || !merchant.moran_tenant_id) return { eligible: false, reason: 'no_connected_sender', message: 'Campaigns send from your own WhatsApp Business number. Link a Moran AI account with a connected number first.' };
  const wa = merchant.verification_json?.waConnection;
  if (wa && wa !== 'connected') return { eligible: false, reason: 'number_not_connected', message: 'Your Moran AI WhatsApp number is not connected.' };
  return { eligible: true, reason: 'moran_tenant_number', sender: { kind: 'moran_tenant', tenantId: merchant.moran_tenant_id } };
}

// Every gate a campaign must pass before a single message is queued; each result is stored for the record.
export async function evaluateDispatchGates(db, { campaign, merchant, template, pricingConfigured, now = Date.now() }) {
  const gates = {};
  gates.entitlement = { ok: await hasActiveEntitlement(db, merchant.id, campaign.kind === 'new_product_outreach' ? 'new_product_outreach' : 'campaign_engine') };
  gates.payment = { ok: campaign.payment_id ? await paymentCompleted(db, campaign.payment_id) : false, reason: campaign.payment_id ? undefined : 'no_payment' };
  const sender = senderEligibility(merchant);
  gates.sender = { ok: sender.eligible, reason: sender.reason };
  gates.template = { ok: !!template && template.status === 'approved', reason: template ? template.status : 'no_template' };
  gates.draftApproved = { ok: !!campaign.approved_at };
  const audience = await resolveAudience(db, { merchantId: merchant.id, audience: campaign.audience_json, purpose: 'marketing', now });
  gates.consent = { ok: audience.included.length > 0, included: audience.included.length, excluded: audience.exclusionReasons };
  const limits = (await db('merchant_entitlements').where({ merchant_id: merchant.id, service: 'campaign_engine' }).first('limits_json'))?.limits_json || {};
  const dailyCap = Number(limits.dailyMessages || 1000);
  const sentToday = await db('campaign_recipients').where({ merchant_id: merchant.id }).whereIn('status', ['sent', 'delivered', 'read']).where('sent_at', '>=', new Date(new Date(now).setHours(0, 0, 0, 0))).count('id as n').first();
  gates.rateLimit = { ok: Number(sentToday.n) + audience.included.length <= dailyCap, dailyCap, sentToday: Number(sentToday.n) };
  gates.pricing = { ok: !!pricingConfigured, reason: pricingConfigured ? undefined : 'provider_rate_not_configured' };
  const ok = Object.values(gates).every((g) => g.ok);
  return { ok, gates, audience, sender: sender.sender || null };
}
