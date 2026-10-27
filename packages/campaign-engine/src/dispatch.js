import { ApiError } from '@moranbuy/core';
import { audit } from '@moranbuy/observability';
import { consentState } from '@moranbuy/consent-management';
import { getCampaign, checkReadiness } from './campaigns.js';

// The merchant's explicit confirmation: gates are re-run now, the recipient ledger is written, and only then is anything queued.
export async function confirmDispatch(db, merchant, id, { pricingConfigured, actorId, ip = null, dryRun }) {
  const check = await checkReadiness(db, merchant, id, { pricingConfigured });
  if (!check.ok) throw new ApiError(409, 'GATES_FAILED', 'The campaign cannot be sent yet.', check.gates);
  const campaign = check.campaign;
  if (campaign.confirmed_at) throw new ApiError(409, 'ALREADY_CONFIRMED', 'This campaign was already confirmed.');
  return db.transaction(async (trx) => {
    const rows = check.audience.included.map((r) => ({ campaign_id: id, merchant_id: merchant.id, phone: r.phone, idempotency_key: `campaign:${id}:${r.phone}`, dry_run: dryRun }));
    if (rows.length) await trx('campaign_recipients').insert(rows).onConflict(['campaign_id', 'phone']).ignore();
    const [row] = await trx('campaigns').where({ id }).update({ status: 'dispatching', confirmed_at: trx.fn.now(), confirmed_by: `merchant:${actorId}`, dispatched_at: trx.fn.now(), dry_run: dryRun, count_queued: rows.length, updated_at: trx.fn.now() }).returning('*');
    await audit(trx, { actorType: 'merchant', actorId, merchantId: merchant.id, action: 'campaign.dispatch_confirmed', targetType: 'campaign', targetId: id, after: { recipients: rows.length, dryRun }, ip });
    return row;
  });
}

export async function pauseCampaign(db, merchantId, id, { resume = false, actorId, ip = null }) {
  const campaign = await getCampaign(db, merchantId, id);
  if (!['dispatching', 'paused'].includes(campaign.status)) throw new ApiError(409, 'NOT_RUNNING', 'Only a running campaign can be paused or resumed.');
  const [row] = await db('campaigns').where({ id }).update({ status: resume ? 'dispatching' : 'paused', updated_at: db.fn.now() }).returning('*');
  await audit(db, { actorType: 'merchant', actorId, merchantId, action: resume ? 'campaign.resumed' : 'campaign.paused', targetType: 'campaign', targetId: id, ip });
  return row;
}

// One pass of the worker: claims queued recipients one at a time with a conditional update, rechecks consent, sends, records the real outcome.
export async function processCampaignQueue(db, sender, { batch = 50, maxAttempts = 3, now = Date.now } = {}) {
  const campaigns = await db('campaigns').where({ status: 'dispatching' }).orderBy('dispatched_at').limit(20);
  const summary = { sent: 0, failed: 0, skipped: 0, retried: 0, completed: 0 };
  for (const campaign of campaigns) {
    const merchant = await db('merchants').where({ id: campaign.merchant_id }).first();
    const template = campaign.template_id ? await db('message_templates').where({ id: campaign.template_id }).first() : null;
    const queued = await db('campaign_recipients').where({ campaign_id: campaign.id, status: 'queued' }).orderBy('id').limit(batch);
    for (const r of queued) {
      const claimed = await db('campaign_recipients').where({ id: r.id, status: 'queued' }).update({ status: 'sending', attempts: r.attempts + 1, updated_at: new Date(now()) });
      if (!claimed) continue;
      // Consent, opt-out and merchant status are rechecked at the moment of sending, not only when the campaign was planned.
      const consent = await consentState(db, { merchantId: campaign.merchant_id, phone: r.phone, purpose: 'marketing' });
      const blocked = !consent.granted ? consent.reason : merchant.status !== 'active' ? 'merchant_suspended' : !template || template.status !== 'approved' ? 'template_not_approved' : null;
      if (blocked) { await db('campaign_recipients').where({ id: r.id }).update({ status: 'skipped', skip_reason: blocked, updated_at: new Date(now()) }); summary.skipped += 1; continue; }
      const components = campaign.media_url && ['IMAGE', 'VIDEO'].includes(template.header_format) ? [{ type: 'header', parameters: [{ type: template.header_format.toLowerCase(), [template.header_format.toLowerCase()]: { link: campaign.media_url } }] }] : [];
      const result = campaign.dry_run
        ? { ok: true, messageId: `dry-run:${r.idempotency_key}`, dryRun: true }
        : await sender.sendTemplate({ tenantId: campaign.sender_json?.tenantId, to: r.phone, templateName: template.name, language: template.language, components, idempotencyKey: r.idempotency_key });
      if (result.ok) { await db('campaign_recipients').where({ id: r.id }).update({ status: 'sent', provider_message_id: result.messageId, sent_at: new Date(now()), updated_at: new Date(now()) }); summary.sent += 1; }
      else if (result.retryable && r.attempts + 1 < maxAttempts) { await db('campaign_recipients').where({ id: r.id }).update({ status: 'queued', last_error: String(result.error), updated_at: new Date(now()) }); summary.retried += 1; }
      else { await db('campaign_recipients').where({ id: r.id }).update({ status: 'failed', last_error: String(result.error), updated_at: new Date(now()) }); summary.failed += 1; }
    }
    const counts = await db('campaign_recipients').where({ campaign_id: campaign.id }).select('status').count('id as n').groupBy('status');
    const c = Object.fromEntries(counts.map((x) => [x.status, Number(x.n)]));
    const remaining = (c.queued || 0) + (c.sending || 0);
    await db('campaigns').where({ id: campaign.id }).update({ count_sent: (c.sent || 0) + (c.delivered || 0) + (c.read || 0), count_delivered: (c.delivered || 0) + (c.read || 0), count_failed: c.failed || 0, count_skipped: c.skipped || 0, ...(remaining === 0 ? { status: 'completed', completed_at: new Date(now()) } : {}), updated_at: new Date(now()) });
    if (remaining === 0) summary.completed += 1;
  }
  return summary;
}

// Delivery statuses reported back by the provider (through Moran) update the ledger forward only.
export async function recordDeliveryStatus(db, { providerMessageId, status }) {
  const order = { sent: 1, delivered: 2, read: 3, failed: 9 };
  const row = await db('campaign_recipients').where({ provider_message_id: providerMessageId }).first();
  if (!row || !order[status]) return false;
  if (order[row.status] >= order[status] && row.status !== 'failed') return false;
  await db('campaign_recipients').where({ id: row.id }).update({ status, updated_at: db.fn.now() });
  return true;
}
