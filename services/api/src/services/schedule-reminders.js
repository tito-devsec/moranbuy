import { consentState } from '@moranbuy/consent-management';
import { logger, audit } from '@moranbuy/observability';
import { db } from '../db/connection.js';

// Wording and approved template for the reminder a customer asked for ("nitanunua wiki ijayo"), edited in Super Admin → MoranBuy → Notifications.
export const DEFAULT_SCHEDULE_REMINDER = Object.freeze({
  enabled: true,
  templateName: '', // an APPROVED template on the MoranBuy number; needed when the customer last wrote more than 24 hours ago
  templateLanguage: 'sw',
  // Placeholders: {name} {product} {when} {merchant}
  textSw: 'Habari{name}, ulisema {when} utarudi kuhusu {product}{merchant}. Bado unatafuta? Jibu NDIO nikutafutie bei na maduka ya karibu tena. Jibu STOP kusitisha.',
  textEn: 'Hello{name}, you said {when} you would come back about {product}{merchant}. Still looking? Reply YES and I will find prices and nearby shops again. Reply STOP to end these messages.',
  templateParams: ['name', 'product', 'when'],
  quietFrom: 21, // East Africa Time; nothing is sent from this hour...
  quietTo: 8,    // ...until this hour
});

const EAT_OFFSET_MS = 3 * 3600000;
const WINDOW_MS = 24 * 3600000;
const SESSION_TTL_MS = 24 * 3600000;

export async function loadReminderSettings(dbImpl = db) {
  const row = await dbImpl('platform_settings').where({ key: 'notification_schedule_reminder' }).first();
  return { ...DEFAULT_SCHEDULE_REMINDER, ...(row?.value || {}) };
}

export function renderReminder(text, facts) {
  return String(text).replace(/\{(\w+)\}/g, (_m, k) => (facts[k] === undefined || facts[k] === null ? '' : String(facts[k])));
}

// The next moment outside quiet hours, in East Africa Time; null when now is already fine.
export function nextSendableAt(now, { quietFrom, quietTo }) {
  const local = new Date(now + EAT_OFFSET_MS);
  const hour = local.getUTCHours();
  const quiet = quietFrom > quietTo ? (hour >= quietFrom || hour < quietTo) : (hour >= quietFrom && hour < quietTo);
  if (!quiet) return null;
  const target = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + (hour >= quietTo ? 1 : 0), quietTo, 0, 0) - EAT_OFFSET_MS);
  return target;
}

// Only the facts recorded with the schedule go into the reminder.
async function reminderFacts(dbImpl, schedule, customer, language) {
  const sw = language !== 'en';
  const session = schedule.session_id ? await dbImpl('shopping_sessions').where({ id: schedule.session_id }).first() : null;
  const listing = schedule.listing_id ? await dbImpl('listings').where({ id: schedule.listing_id }).first('name') : null;
  const merchant = schedule.merchant_id ? await dbImpl('merchants').where({ id: schedule.merchant_id }).first('business_name') : null;
  const request = session?.request_json || {};
  const product = listing?.name || request.productType || (sw ? 'bidhaa uliyouliza' : 'what you asked for');
  return {
    facts: { name: customer.name ? ` ${String(customer.name).split(' ')[0]}` : '', product, when: schedule.when_text || (sw ? 'baadaye' : 'later'), merchant: merchant ? (sw ? ` kutoka ${merchant.business_name}` : ` from ${merchant.business_name}`) : '' },
    session,
  };
}

// One pass: every due reminder is claimed once, every gate checked at that moment, and the real outcome recorded on the schedule.
export async function processDueReminders({ dbImpl = db, moran, dryRun = true, now = Date.now, batch = 50, scheduleId = null } = {}) {
  const settings = await loadReminderSettings(dbImpl);
  const summary = { sent: 0, skipped: 0, failed: 0, deferred: 0 };
  if (!settings.enabled) return { ...summary, disabled: true };
  const due = await dbImpl('customer_schedules').where({ status: 'scheduled' }).whereNotNull('due_at').where('due_at', '<=', new Date(now())).modify((q) => { if (scheduleId) q.where({ id: scheduleId }); }).orderBy('due_at').limit(batch);
  for (const s of due) {
    // Quiet hours move the reminder to the morning; it is not claimed.
    const later = nextSendableAt(now(), settings);
    if (later) { await dbImpl('customer_schedules').where({ id: s.id, status: 'scheduled' }).update({ due_at: later, updated_at: new Date(now()) }); summary.deferred += 1; continue; }
    const claimed = await dbImpl('customer_schedules').where({ id: s.id, status: 'scheduled' }).update({ status: 'sending', attempts: s.attempts + 1, updated_at: new Date(now()) });
    if (!claimed) continue;
    const customer = await dbImpl('customers').where({ id: s.customer_id }).first();
    const finish = async (patch, outcome) => { await dbImpl('customer_schedules').where({ id: s.id }).update({ ...patch, updated_at: new Date(now()) }); summary[outcome] += 1; };
    const consent = customer?.channel === 'whatsapp' ? await consentState(dbImpl, { merchantId: s.merchant_id || null, phone: customer.channel_ref, purpose: 'service' }) : null;
    const ordered = await dbImpl('orders').where({ customer_id: s.customer_id }).where('created_at', '>=', s.created_at).whereNotIn('status', ['rejected', 'cancelled']).first('id');
    const skip = !customer || customer.channel !== 'whatsapp' ? 'not_whatsapp'
      : customer.terms_status !== 'accepted' ? 'terms_not_accepted'
      : ['opted_out', 'revoked'].includes(consent.reason) ? consent.reason
      : ordered ? 'already_ordered'
      : null;
    if (skip) { await finish({ status: skip === 'already_ordered' ? 'done' : 'cancelled', reminder_status: 'skipped', skip_reason: skip }, 'skipped'); continue; }
    const language = customer.language === 'en' ? 'en' : 'sw';
    const { facts, session } = await reminderFacts(dbImpl, s, customer, language);
    const body = renderReminder(language === 'en' ? settings.textEn : settings.textSw, facts).replace(/\s+/g, ' ').trim();
    // Inside 24 hours of the customer's last message a plain text goes; after that only an approved template may.
    const inWindow = customer.last_seen_at && now() - new Date(customer.last_seen_at).getTime() < WINDOW_MS;
    const useTemplate = !inWindow;
    if (useTemplate && !settings.templateName) { await finish({ status: 'expired', reminder_status: 'skipped', skip_reason: 'outside_24h_window_no_template', reminder_message: body }, 'skipped'); continue; }
    const idempotencyKey = `moranbuy:reminder:${s.id}`;
    let r;
    if (dryRun) r = { ok: true, data: { messageId: `dry-run:${s.id}` } };
    else if (!moran?.configured) r = { ok: false, status: 'moran_not_configured' };
    else if (useTemplate) r = await moran.sendMoranBuyTemplate({ to: customer.channel_ref, templateName: settings.templateName, language: settings.templateLanguage || 'sw', components: [{ type: 'body', parameters: (settings.templateParams || []).map((k) => ({ type: 'text', text: String(facts[k] ?? '').trim() || '-' })) }], idempotencyKey });
    else r = await moran.sendText({ to: customer.channel_ref, body, idempotencyKey });
    if (!r.ok) {
      // A failed send is retried on the next pass up to three times, then given up.
      const giveUp = s.attempts + 1 >= 3;
      logger.warn({ scheduleId: s.id, status: r.status }, 'Schedule reminder not delivered');
      await finish({ status: giveUp ? 'failed' : 'scheduled', reminder_status: 'failed', skip_reason: String(r.status || 'send_failed').slice(0, 64), reminder_message: body }, 'failed');
      continue;
    }
    await finish({ status: 'reminded', reminded_at: new Date(now()), reminder_kind: dryRun ? 'dry_run' : useTemplate ? 'template' : 'text', reminder_status: 'sent', reminder_message: body, provider_message_id: r.data?.messageId || null }, 'sent');
    // The customer's reply picks up where they left off: the request they made is waiting in an open session.
    if (session?.request_json && Object.keys(session.request_json).length) {
      const open = await dbImpl('shopping_sessions').where({ customer_id: customer.id }).whereNotIn('state', ['closed', 'confirmed']).orderBy('created_at', 'desc').first();
      const ctx = { ...(open?.context_json || {}), fromScheduleId: s.id, presented: undefined };
      if (open) await dbImpl('shopping_sessions').where({ id: open.id }).update({ request_json: JSON.stringify(open.request_json && Object.keys(open.request_json).length ? open.request_json : session.request_json), state: 'clarifying', context_json: JSON.stringify(ctx), expires_at: new Date(now() + SESSION_TTL_MS), updated_at: new Date(now()) });
      else await dbImpl('shopping_sessions').insert({ customer_id: customer.id, state: 'clarifying', request_json: JSON.stringify(session.request_json), context_json: JSON.stringify({ fromScheduleId: s.id }), expires_at: new Date(now() + SESSION_TTL_MS) });
    }
    await audit(dbImpl, { actorType: 'system', action: 'schedule.reminded', targetType: 'customer_schedule', targetId: s.id, after: { kind: dryRun ? 'dry_run' : useTemplate ? 'template' : 'text' } });
  }
  return summary;
}
