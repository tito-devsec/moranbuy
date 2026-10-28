import { config } from '@moranbuy/core';
import { redact } from '@moranbuy/observability';
import { museTelemetry, museAdminSummary, numbersAreGrounded } from '@moranbuy/muse-intelligence';
import { db } from '../db/connection.js';
import { demandStats } from './insights.js';

export const SUMMARY_SECTIONS = Object.freeze(['overview', 'campaigns', 'followup', 'orders', 'payments', 'muse', 'demand', 'retention']);
const n = (v) => Number(v || 0);
const byStatus = async (dbImpl, table, col = 'status', where = (q) => q) => Object.fromEntries((await where(dbImpl(table)).select(col).count('* as c').groupBy(col)).map((r) => [r[col], n(r.c)]));

// Counts for one admin section: aggregates only, no phone numbers or message text, so they are safe to hand to Muse.
export async function sectionData(section, { dbImpl = db, now = Date.now() } = {}) {
  const since = (days) => new Date(now - days * 86400000);
  switch (section) {
    case 'overview': return {
      merchants: await byStatus(dbImpl, 'merchants'), verification: await byStatus(dbImpl, 'merchants', 'verification_status'),
      listingsActive: n((await dbImpl('listings').where({ status: 'active' }).whereNull('deleted_at').count('* as c').first()).c),
      searches7d: n((await dbImpl('matching_runs').where('created_at', '>=', since(7)).count('* as c').first()).c),
      searchesNothingInBudget7d: n((await dbImpl('matching_runs').where('created_at', '>=', since(7)).where({ none_within_budget: true }).count('* as c').first()).c),
      orders7d: await byStatus(dbImpl, 'orders', 'status', (q) => q.where('created_at', '>=', since(7))),
      campaigns: await byStatus(dbImpl, 'campaigns'), payments: await byStatus(dbImpl, 'payments'),
      flags: { campaignDryRun: config().CAMPAIGN_DRY_RUN, followupDryRun: config().FOLLOWUP_DRY_RUN, reminderDryRun: config().REMINDER_DRY_RUN, retentionDryRun: config().RETENTION_DRY_RUN, museProvider: config().MUSE_PROVIDER },
    };
    case 'campaigns': return {
      byStatus: await byStatus(dbImpl, 'campaigns'), recipients30d: await byStatus(dbImpl, 'campaign_recipients', 'status', (q) => q.where('updated_at', '>=', since(30))),
      skipReasons30d: Object.fromEntries((await dbImpl('campaign_recipients').where('updated_at', '>=', since(30)).whereNotNull('skip_reason').select('skip_reason').count('* as c').groupBy('skip_reason')).map((r) => [r.skip_reason, n(r.c)])),
      scheduledNext7d: n((await dbImpl('campaigns').where({ status: 'scheduled' }).where('scheduled_at', '<=', new Date(now + 7 * 86400000)).count('* as c').first()).c),
      failedReasons: (await dbImpl('campaigns').where({ status: 'failed' }).whereNotNull('status_reason').orderBy('updated_at', 'desc').limit(5).pluck('status_reason')),
      templates: await byStatus(dbImpl, 'message_templates'), dryRun: config().CAMPAIGN_DRY_RUN,
    };
    case 'followup': return {
      leads: await byStatus(dbImpl, 'followup_leads', 'state'), stopReasons: await byStatus(dbImpl, 'followup_leads', 'stop_reason', (q) => q.whereNotNull('stop_reason')),
      tasks30d: await byStatus(dbImpl, 'followup_tasks', 'status', (q) => q.where('updated_at', '>=', since(30))),
      taskSkipReasons30d: await byStatus(dbImpl, 'followup_tasks', 'skip_reason', (q) => q.where('updated_at', '>=', since(30)).whereNotNull('skip_reason')),
      convertedLast30d: n((await dbImpl('followup_leads').where({ state: 'converted' }).where('converted_at', '>=', since(30)).count('* as c').first()).c),
      schedules: await byStatus(dbImpl, 'customer_schedules'), reminderSkips: await byStatus(dbImpl, 'customer_schedules', 'skip_reason', (q) => q.whereNotNull('skip_reason')),
      dryRun: config().FOLLOWUP_DRY_RUN, reminderDryRun: config().REMINDER_DRY_RUN,
    };
    case 'orders': return {
      byStatus30d: await byStatus(dbImpl, 'orders', 'status', (q) => q.where('created_at', '>=', since(30))),
      waitingOnMerchantOver24h: n((await dbImpl('orders').where({ status: 'pending_merchant' }).where('created_at', '<', since(1)).count('* as c').first()).c),
      deliveryFeeUnconfirmed: n((await dbImpl('orders').where({ status: 'pending_merchant', total_confirmed: false }).count('* as c').first()).c),
      ownerAlerts30d: await byStatus(dbImpl, 'merchant_notifications', 'status', (q) => q.where('created_at', '>=', since(30))),
      ownerAlertSkips30d: await byStatus(dbImpl, 'merchant_notifications', 'skip_reason', (q) => q.where('created_at', '>=', since(30)).whereNotNull('skip_reason')),
      handedToMoran30d: n((await dbImpl('orders').where('created_at', '>=', since(30)).where('external_ref', 'like', 'moran:%').count('* as c').first()).c),
    };
    case 'payments': return {
      byStatus: await byStatus(dbImpl, 'payments'), byPurpose: await byStatus(dbImpl, 'payments', 'purpose'),
      pendingOver1h: n((await dbImpl('payments').where({ status: 'pending' }).where('created_at', '<', new Date(now - 3600000)).count('* as c').first()).c),
      completedAmount30d: n((await dbImpl('payments').where({ status: 'completed' }).where('created_at', '>=', since(30)).sum('amount as s').first()).s),
      provider: config().PAYMENT_PROVIDER,
    };
    case 'muse': { const t = await museTelemetry(dbImpl, { sinceHours: 24 }); return { last24h: { requests: t.requests, ok: t.ok, failed: t.failed, avgLatencyMs: t.avgLatencyMs, inputTokens: t.inputTokens, outputTokens: t.outputTokens, byFeature: t.byFeature, lastFailureCode: t.lastFailure?.error_code || null }, provider: config().MUSE_PROVIDER }; }
    case 'demand': { const s = await demandStats({ dbImpl, days: 30, now }); return { customers: s.customers, topProducts: s.topProducts.slice(0, 5), byRegion: s.byRegion.slice(0, 5), unmetDemand: s.unmetDemand, purchaseTiming: s.purchaseTiming, outcomes: s.outcomes, orders: s.orders, openSchedules: s.openSchedules }; }
    case 'retention': {
      const run = (await dbImpl('platform_settings').where({ key: 'retention_last_run' }).first())?.value || null;
      const preview = (await dbImpl('platform_settings').where({ key: 'retention_last_preview' }).first())?.value || null;
      return { scheduledDryRun: config().RETENTION_DRY_RUN, lastRun: run ? { ranAt: run.ranAt, totals: run.totals } : null, lastPreview: preview ? { ranAt: preview.ranAt, totals: preview.totals, expiredByTable: Object.fromEntries(Object.entries(preview.result).map(([k, v]) => [k, v.expired])) } : null };
    }
    default: return {};
  }
}

// Plain rules that flag what needs attention; they stand in for Muse and are always shown beside its reading.
export function ruleChecks(section, d) {
  const c = [];
  const s = (o, k) => n(o?.[k]);
  if (section === 'overview') {
    if (s(d.verification, 'pending')) c.push(`${s(d.verification, 'pending')} businesses are waiting for verification.`);
    if (d.searches7d && d.searchesNothingInBudget7d / d.searches7d > 0.3) c.push(`${d.searchesNothingInBudget7d} of ${d.searches7d} searches this week found nothing within budget; check what people ask for in Insights.`);
    if (s(d.orders7d, 'pending_merchant')) c.push(`${s(d.orders7d, 'pending_merchant')} orders from this week are still waiting for the merchant.`);
    for (const [k, v] of Object.entries(d.flags || {})) if (v === true && /DryRun$/i.test(k)) c.push(`${k} is on: those messages or deletions are recorded, not carried out.`);
  }
  if (section === 'campaigns') {
    if (s(d.byStatus, 'failed')) c.push(`${s(d.byStatus, 'failed')} campaigns failed; read their reasons.`);
    if (s(d.recipients30d, 'failed')) c.push(`${s(d.recipients30d, 'failed')} campaign messages failed in 30 days.`);
    if (s(d.templates, 'rejected')) c.push(`${s(d.templates, 'rejected')} templates were rejected by Meta.`);
    if (s(d.byStatus, 'awaiting_payment')) c.push(`${s(d.byStatus, 'awaiting_payment')} campaigns are waiting on payment.`);
  }
  if (section === 'followup') {
    if (s(d.taskSkipReasons30d, 'service_not_active_or_unpaid')) c.push(`${s(d.taskSkipReasons30d, 'service_not_active_or_unpaid')} follow-ups were skipped because the service is not paid.`);
    if (s(d.reminderSkips, 'outside_24h_window_no_template')) c.push(`${s(d.reminderSkips, 'outside_24h_window_no_template')} reminders expired for lack of an approved template.`);
    if (s(d.tasks30d, 'failed')) c.push(`${s(d.tasks30d, 'failed')} follow-up messages failed in 30 days.`);
  }
  if (section === 'orders') {
    if (d.waitingOnMerchantOver24h) c.push(`${d.waitingOnMerchantOver24h} orders have waited more than a day for the merchant.`);
    if (s(d.ownerAlerts30d, 'failed')) c.push(`${s(d.ownerAlerts30d, 'failed')} owner alerts failed to send.`);
    if (s(d.ownerAlertSkips30d, 'merchant_has_no_phone')) c.push(`${s(d.ownerAlertSkips30d, 'merchant_has_no_phone')} businesses have no phone for alerts.`);
  }
  if (section === 'payments' && d.pendingOver1h) c.push(`${d.pendingOver1h} payments have been pending over an hour; check the provider webhook.`);
  if (section === 'muse') {
    if (d.provider === 'disabled') c.push('Muse Spark is off; every Muse duty is using its plain fallback.');
    else if (d.last24h.requests && d.last24h.failed / d.last24h.requests > 0.2) c.push(`${d.last24h.failed} of ${d.last24h.requests} Muse requests failed in 24 hours (last error ${d.last24h.lastFailureCode || 'unknown'}).`);
  }
  if (section === 'demand' && d.unmetDemand?.length) c.push(`Customers asked for ${d.unmetDemand.map((u) => u.productType).join(', ')} and found nothing; these are products to recruit businesses for.`);
  if (section === 'retention') {
    if (!d.lastRun && !d.lastPreview) c.push('The retention purge has not run yet.');
    if (d.scheduledDryRun && d.lastPreview?.totals.expired) c.push(`${d.lastPreview.totals.expired} records are past their keep period but the purge is in count-only mode.`);
  }
  return c;
}

// The section's numbers, the rule checks, and Muse's reading when it is on and keeps to the numbers.
export async function adminSummary({ dbImpl = db, muse = null, section = 'overview' } = {}) {
  const data = redact(await sectionData(section, { dbImpl }));
  const checks = ruleChecks(section, data);
  const plain = checks.length ? `${checks.length} thing${checks.length === 1 ? '' : 's'} need attention in ${section}.` : `Nothing in ${section} needs attention by the rules.`;
  if (!muse?.enabled) return { section, data, summary: plain, checks, source: 'rules' };
  const r = await museAdminSummary(muse, { data, section }).catch(() => ({ ok: false, status: 'error' }));
  if (r.ok && r.json?.summary && numbersAreGrounded(r.json.summary, data)) {
    const museChecks = Array.isArray(r.json.checks) ? r.json.checks.map(String).filter((x) => numbersAreGrounded(x, data)).slice(0, 6) : [];
    return { section, data, summary: String(r.json.summary).slice(0, 1500), checks: [...new Set([...checks, ...museChecks])], source: 'muse' };
  }
  return { section, data, summary: plain, checks, source: r.ok ? 'rules_muse_ungrounded' : `rules_muse_${r.status}` };
}
