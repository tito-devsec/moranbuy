import { audit, logger } from '@moranbuy/observability';
import { db } from '../db/connection.js';

// How long each kind of record is kept, in days; administrators can lengthen or shorten these in Super Admin, never below the floors.
export const DEFAULT_RETENTION = Object.freeze({
  sessionMessagesDays: 180,   // the words of each chat
  sessionsDays: 365,          // finished or expired shopping sessions
  matchingRunsDays: 365,      // ranking evidence
  demandSignalsDays: 730,     // what people asked for, behind the statistics
  schedulesDays: 180,         // customer schedules that are finished
  followupLeadsDays: 365,     // converted or stopped leads and their tasks
  campaignRecipientsDays: 365, // the per-phone ledger of finished campaigns (the campaign's counts stay)
  notificationsDays: 365,     // owner alerts sent
  catalogUploadsDays: 365,    // products sent by chat, as received
  museRequestsDays: 365,      // Muse telemetry
  webhookEventsDays: 90,      // duplicate-delivery guard
  inactiveCustomersDays: 730, // customers who never ordered and have not written since
  orderLocationDays: 730,     // the customer's delivery location on old orders (the order itself is kept)
});
const FLOORS = { webhookEventsDays: 7 };
const MIN_DAYS = 30;
const BATCH = 2000;

// What is never purged here: orders (the record of a sale), payments, consent events (proof of permission), the audit trail, merchants and listings.
export const NEVER_PURGED = Object.freeze(['orders', 'payments', 'consent_events', 'audit_events', 'merchants', 'listings', 'contacts']);

export async function loadRetention(dbImpl = db) {
  const row = await dbImpl('platform_settings').where({ key: 'retention' }).first();
  const merged = { ...DEFAULT_RETENTION, ...(row?.value || {}) };
  for (const k of Object.keys(DEFAULT_RETENTION)) merged[k] = Math.max(FLOORS[k] ?? MIN_DAYS, Math.round(Number(merged[k]) || DEFAULT_RETENTION[k]));
  return merged;
}

export const retentionFloor = (key) => FLOORS[key] ?? MIN_DAYS;

// Each rule names its table, which rows are expired, and whether they are deleted or only scrubbed.
function rules(d, r, now) {
  const before = (days) => new Date(now - days * 86400000);
  return [
    { key: 'sessionMessagesDays', table: 'session_messages', where: (q) => q.where('created_at', '<', before(r.sessionMessagesDays)) },
    { key: 'sessionsDays', table: 'shopping_sessions', where: (q) => q.where('updated_at', '<', before(r.sessionsDays)).where((s) => s.whereIn('state', ['closed', 'confirmed']).orWhere('expires_at', '<', before(r.sessionsDays))) },
    { key: 'matchingRunsDays', table: 'matching_runs', where: (q) => q.where('created_at', '<', before(r.matchingRunsDays)) },
    { key: 'demandSignalsDays', table: 'demand_signals', where: (q) => q.where('created_at', '<', before(r.demandSignalsDays)) },
    { key: 'schedulesDays', table: 'customer_schedules', where: (q) => q.whereIn('status', ['done', 'cancelled', 'expired', 'failed', 'reminded']).where('updated_at', '<', before(r.schedulesDays)) },
    { key: 'followupLeadsDays', table: 'followup_leads', where: (q) => q.whereIn('state', ['converted', 'stopped']).where('updated_at', '<', before(r.followupLeadsDays)) },
    { key: 'campaignRecipientsDays', table: 'campaign_recipients', where: (q) => q.whereIn('campaign_id', d('campaigns').select('id').whereIn('status', ['completed', 'failed', 'cancelled']).where('updated_at', '<', before(r.campaignRecipientsDays))) },
    { key: 'notificationsDays', table: 'merchant_notifications', where: (q) => q.where('created_at', '<', before(r.notificationsDays)) },
    { key: 'catalogUploadsDays', table: 'catalog_uploads', where: (q) => q.where('created_at', '<', before(r.catalogUploadsDays)) },
    { key: 'museRequestsDays', table: 'muse_requests', where: (q) => q.where('created_at', '<', before(r.museRequestsDays)) },
    { key: 'webhookEventsDays', table: 'webhook_events', where: (q) => q.where('received_at', '<', before(r.webhookEventsDays)) },
    // A customer is removed only with no order or enquiry on record and no message for the whole period; their sessions, signals and schedules go with them.
    { key: 'inactiveCustomersDays', table: 'customers', where: (q) => q.where((s) => s.where('last_seen_at', '<', before(r.inactiveCustomersDays)).orWhere((n) => n.whereNull('last_seen_at').where('created_at', '<', before(r.inactiveCustomersDays)))).whereNotExists(d('orders').select(d.raw('1')).whereRaw('orders.customer_id = customers.id')).whereNotExists(d('enquiries').select(d.raw('1')).whereRaw('enquiries.customer_id = customers.id')) },
    { key: 'orderLocationDays', table: 'orders', scrub: { customer_location_json: null }, where: (q) => q.where('created_at', '<', before(r.orderLocationDays)).whereNotNull('customer_location_json') },
    // Spent refresh tokens are not personal history; they are cleared after thirty days.
    { key: null, table: 'refresh_tokens', where: (q) => q.where((s) => s.where('expires_at', '<', before(30)).orWhere('revoked_at', '<', before(30))) },
  ];
}

// One purge pass: counts what is expired, and unless it is a dry run deletes or scrubs it in batches; the result is recorded and audited.
export async function purgeExpired({ dbImpl = db, dryRun = true, now = Date.now(), actor = 'system', reason = null } = {}) {
  const r = await loadRetention(dbImpl);
  const started = Date.now();
  const result = {};
  for (const rule of rules(dbImpl, r, now)) {
    const label = rule.table + (rule.scrub ? ':scrubbed' : '');
    const count = Number((await rule.where(dbImpl(rule.table)).count('* as n').first()).n);
    result[label] = { expired: count, removed: 0, keepDays: rule.key ? r[rule.key] : 30 };
    if (dryRun || !count) continue;
    let removed = 0;
    // Batches keep each statement short so the live service is never locked for long.
    for (;;) {
      const ids = rule.where(dbImpl(rule.table)).select(dbImpl.raw('ctid')).limit(BATCH);
      const n = rule.scrub
        ? await dbImpl(rule.table).whereIn(dbImpl.raw('ctid'), ids).update(rule.scrub)
        : await dbImpl(rule.table).whereIn(dbImpl.raw('ctid'), ids).del();
      removed += n;
      if (n < BATCH) break;
    }
    result[label].removed = removed;
  }
  const summary = { ranAt: new Date(now).toISOString(), dryRun, durationMs: Date.now() - started, actor, result, totals: { expired: Object.values(result).reduce((a, x) => a + x.expired, 0), removed: Object.values(result).reduce((a, x) => a + x.removed, 0) } };
  await dbImpl('platform_settings').insert({ key: dryRun ? 'retention_last_preview' : 'retention_last_run', value: JSON.stringify(summary), updated_by: String(actor).slice(0, 64), updated_at: dbImpl.fn.now() }).onConflict('key').merge();
  if (!dryRun) {
    await audit(dbImpl, { actorType: actor === 'system' ? 'system' : 'admin', action: 'retention.purged', targetType: 'settings', targetId: 'retention', after: { totals: summary.totals, result }, reason });
    logger.info({ totals: summary.totals }, 'Retention purge finished');
  }
  return summary;
}
