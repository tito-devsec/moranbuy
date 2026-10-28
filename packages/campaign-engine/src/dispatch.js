import { ApiError } from '@moranbuy/core';
import { audit } from '@moranbuy/observability';
import { consentState } from '@moranbuy/consent-management';
import { getCampaign, checkReadiness } from './campaigns.js';
import { evaluateDispatchGates } from './gates.js';

const EAT_OFFSET_MS = 3 * 3600000;
const MIN_LEAD_MS = 5 * 60000;
const MAX_AHEAD_MS = 60 * 86400000;

// A send time must be at least five minutes ahead, within sixty days, and between 08:00 and 21:00 in Dar es Salaam.
export function validateSendAt(sendAt, now = Date.now()) {
  const t = new Date(sendAt).getTime();
  if (!Number.isFinite(t)) throw new ApiError(400, 'BAD_SEND_AT', 'The send time is not a valid date and time.');
  if (t < now + MIN_LEAD_MS) throw new ApiError(400, 'SEND_AT_TOO_SOON', 'Pick a send time at least five minutes from now, or send now.');
  if (t > now + MAX_AHEAD_MS) throw new ApiError(400, 'SEND_AT_TOO_FAR', 'A campaign can be scheduled at most sixty days ahead.');
  const hour = new Date(t + EAT_OFFSET_MS).getUTCHours();
  if (hour < 8 || hour >= 21) throw new ApiError(400, 'SEND_AT_QUIET_HOURS', 'Campaigns are sent between 08:00 and 21:00 Tanzania time.');
  return new Date(t);
}

// The merchant's explicit confirmation: gates are re-run now, the recipient ledger is written, and only then is anything queued.
export async function confirmDispatch(db, merchant, id, { pricingConfigured, actorId, ip = null, dryRun, sendAt = null, now = Date.now() }) {
  // A send time is checked before anything else, so a bad time never half-confirms a campaign.
  const scheduledAt = sendAt ? validateSendAt(sendAt, now) : null;
  const check = await checkReadiness(db, merchant, id, { pricingConfigured });
  if (!check.ok) throw new ApiError(409, 'GATES_FAILED', 'The campaign cannot be sent yet.', check.gates);
  const campaign = check.campaign;
  if (campaign.confirmed_at) throw new ApiError(409, 'ALREADY_CONFIRMED', 'This campaign was already confirmed.');
  return db.transaction(async (trx) => {
    const rows = check.audience.included.map((r) => ({ campaign_id: id, merchant_id: merchant.id, phone: r.phone, idempotency_key: `campaign:${id}:${r.phone}`, dry_run: dryRun }));
    if (rows.length) await trx('campaign_recipients').insert(rows).onConflict(['campaign_id', 'phone']).ignore();
    // A scheduled campaign keeps its ledger and waits; the worker re-runs every gate when its time comes.
    const [row] = await trx('campaigns').where({ id }).update({ status: scheduledAt ? 'scheduled' : 'dispatching', scheduled_at: scheduledAt, confirmed_at: trx.fn.now(), confirmed_by: `merchant:${actorId}`, dispatched_at: scheduledAt ? null : trx.fn.now(), dry_run: dryRun, count_queued: rows.length, status_reason: null, updated_at: trx.fn.now() }).returning('*');
    await audit(trx, { actorType: 'merchant', actorId, merchantId: merchant.id, action: scheduledAt ? 'campaign.scheduled' : 'campaign.dispatch_confirmed', targetType: 'campaign', targetId: id, after: { recipients: rows.length, dryRun, scheduledAt }, ip });
    return row;
  });
}

export async function pauseCampaign(db, merchantId, id, { resume = false, actorId, ip = null }) {
  const campaign = await getCampaign(db, merchantId, id);
  if (!['dispatching', 'paused', 'scheduled'].includes(campaign.status) || (resume && campaign.status !== 'paused')) throw new ApiError(409, 'NOT_RUNNING', 'Only a running or scheduled campaign can be paused, and only a paused one resumed.');
  // Resuming a campaign whose time has not come puts it back on its schedule rather than sending early.
  const waiting = campaign.scheduled_at && new Date(campaign.scheduled_at).getTime() > Date.now() && !campaign.dispatched_at;
  const [row] = await db('campaigns').where({ id }).update({ status: resume ? (waiting ? 'scheduled' : 'dispatching') : 'paused', updated_at: db.fn.now() }).returning('*');
  await audit(db, { actorType: 'merchant', actorId, merchantId, action: resume ? 'campaign.resumed' : 'campaign.paused', targetType: 'campaign', targetId: id, ip });
  return row;
}

// The merchant takes a scheduled campaign back: the queued ledger is removed and it is ready to confirm again, now or at another time.
export async function unscheduleCampaign(db, merchantId, id, { actorId, ip = null }) {
  const campaign = await getCampaign(db, merchantId, id);
  if (campaign.status !== 'scheduled' && !(campaign.status === 'paused' && campaign.scheduled_at && !campaign.dispatched_at)) throw new ApiError(409, 'NOT_SCHEDULED', 'Only a campaign that is waiting for its send time can be unscheduled.');
  return db.transaction(async (trx) => {
    await trx('campaign_recipients').where({ campaign_id: id, status: 'queued' }).delete();
    const [row] = await trx('campaigns').where({ id }).update({ status: 'ready', scheduled_at: null, confirmed_at: null, confirmed_by: null, count_queued: 0, updated_at: trx.fn.now() }).returning('*');
    await audit(trx, { actorType: 'merchant', actorId, merchantId, action: 'campaign.unscheduled', targetType: 'campaign', targetId: id, before: { scheduledAt: campaign.scheduled_at }, ip });
    return row;
  });
}

// Starts every scheduled campaign whose time has come, each claimed once; a gate that no longer holds (payment, template, entitlement, sender, merchant) fails it with the reason instead of sending.
export async function startDueCampaigns(db, { pricingConfigured = true, now = Date.now } = {}) {
  const due = await db('campaigns').where({ status: 'scheduled' }).where('scheduled_at', '<=', new Date(now())).orderBy('scheduled_at').limit(50);
  const summary = { started: 0, failed: 0 };
  for (const c of due) {
    const claimed = await db('campaigns').where({ id: c.id, status: 'scheduled' }).update({ status: 'starting', updated_at: new Date(now()) });
    if (!claimed) continue;
    const merchant = await db('merchants').where({ id: c.merchant_id }).first();
    const template = c.template_id ? await db('message_templates').where({ id: c.template_id, merchant_id: c.merchant_id }).first() : null;
    const result = await evaluateDispatchGates(db, { campaign: { ...c, status: 'ready' }, merchant, template, pricingConfigured, now: now() }).catch((err) => ({ ok: false, gates: { evaluation: { ok: false, reason: err.message } } }));
    if (result.ok) {
      await db('campaigns').where({ id: c.id }).update({ status: 'dispatching', dispatched_at: new Date(now()), gate_results_json: JSON.stringify(result.gates), status_reason: null, updated_at: new Date(now()) });
      await audit(db, { actorType: 'system', merchantId: c.merchant_id, action: 'campaign.schedule_started', targetType: 'campaign', targetId: c.id, after: { scheduledAt: c.scheduled_at } });
      summary.started += 1;
    } else {
      const failed = Object.entries(result.gates || {}).filter(([, g]) => !g.ok).map(([k, g]) => (g.reason ? `${k} (${g.reason})` : k)).join(', ');
      await db('campaign_recipients').where({ campaign_id: c.id, status: 'queued' }).update({ status: 'skipped', skip_reason: 'schedule_gates_failed', updated_at: new Date(now()) });
      await db('campaigns').where({ id: c.id }).update({ status: 'failed', gate_results_json: JSON.stringify(result.gates || {}), status_reason: `Not sent at the scheduled time: ${failed || 'a gate failed'}.`, updated_at: new Date(now()) });
      await audit(db, { actorType: 'system', merchantId: c.merchant_id, action: 'campaign.schedule_failed', targetType: 'campaign', targetId: c.id, after: { failed } });
      summary.failed += 1;
    }
  }
  return summary;
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
