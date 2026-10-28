import { hasActiveEntitlement } from '@moranbuy/authorization';
import { consentState } from '@moranbuy/consent-management';
import { followupSettings } from './offer.js';
import { museDraftFollowup, numbersAreGrounded } from '@moranbuy/muse-intelligence';

// Writes one follow-up message from the lead's facts only.
export function followupMessage(lead, merchant, language = 'sw') {
  const product = lead.listing_name ? ` kuhusu ${lead.listing_name}` : '';
  if (language === 'en') return `Hello, this is ${merchant.business_name}. You asked${lead.listing_name ? ` about ${lead.listing_name}` : ' about a product'} recently. Are you still interested? Reply with any question, or STOP to end these messages.`;
  return `Habari, ni ${merchant.business_name}. Uliuliza${product} hivi karibuni. Bado una nia? Jibu swali lolote, au STOP kusitisha ujumbe huu.`;
}

// One pass of the follow-up worker: every due task is claimed, every gate checked at that moment, and the real result recorded.
export async function processDueFollowups(db, sender, { dryRun = true, now = Date.now, batch = 100, muse = null } = {}) {
  const due = await db('followup_tasks').where({ status: 'pending' }).where('due_at', '<=', new Date(now())).orderBy('due_at').limit(batch);
  const summary = { sent: 0, skipped: 0, failed: 0 };
  for (const task of due) {
    const claimed = await db('followup_tasks').where({ id: task.id, status: 'pending' }).update({ status: 'sending', updated_at: new Date(now()) });
    if (!claimed) continue;
    const lead = await db('followup_leads as l').leftJoin('listings as p', 'p.id', 'l.listing_id').where('l.id', task.lead_id).first('l.*', 'p.name as listing_name', 'p.price as listing_price', 'p.currency as listing_currency');
    const merchant = await db('merchants').where({ id: task.merchant_id }).first();
    const settings = followupSettings(merchant);
    const hour = new Date(now()).getHours();
    const quiet = settings.quietHours.from > settings.quietHours.to ? (hour >= settings.quietHours.from || hour < settings.quietHours.to) : (hour >= settings.quietHours.from && hour < settings.quietHours.to);
    const consent = await consentState(db, { merchantId: merchant.id, phone: lead.phone, purpose: lead.consent_basis === 'followup_granted' ? 'followup' : 'service' });
    const skip = merchant.status !== 'active' ? 'merchant_suspended'
      : settings.decision !== 'accepted' ? 'not_accepted'
      : !(await hasActiveEntitlement(db, merchant.id, 'paid_followup')) ? 'service_not_active_or_unpaid'
      : settings.paused ? 'paused'
      : !['scheduled', 'contacted'].includes(lead.state) ? `lead_${lead.state}`
      : lead.attempts >= lead.max_attempts ? 'max_attempts'
      : !consent.granted ? consent.reason
      : merchant.registration_type !== 'moran' ? 'no_connected_sender'
      : null;
    if (quiet && !skip) { await db('followup_tasks').where({ id: task.id }).update({ status: 'pending', due_at: new Date(new Date(now()).setHours(settings.quietHours.to, 0, 0, 0) + (hour >= settings.quietHours.from ? 86400000 : 0)), updated_at: new Date(now()) }); continue; }
    if (skip) { await db('followup_tasks').where({ id: task.id }).update({ status: 'skipped', skip_reason: skip, updated_at: new Date(now()) }); summary.skipped += 1; if (['max_attempts', 'opted_out', 'revoked', 'no_consent'].includes(skip)) await db('followup_leads').where({ id: lead.id }).update({ state: 'stopped', stop_reason: skip, next_action_at: null }); continue; }
    const language = merchant.settings_json?.language || 'sw';
    let message = followupMessage(lead, merchant, language);
    let messageSource = 'deterministic';
    if (muse?.enabled) {
      const facts = { business: merchant.business_name, product: lead.listing_name || null, price: lead.listing_price ?? null, currency: lead.listing_currency || 'TZS', customerSaid: lead.stated_intention || null, attempt: lead.attempts + 1 };
      const d = await museDraftFollowup(muse, { facts, language, merchantId: merchant.id }).catch(() => ({ ok: false }));
      if (d.ok && d.json?.body && numbersAreGrounded(d.json.body, facts) && /stop/i.test(d.json.body)) { message = String(d.json.body).slice(0, 600); messageSource = 'muse'; }
    }
    const result = dryRun ? { ok: true, messageId: `dry-run:${task.idempotency_key}`, dryRun: true } : await sender.sendText({ tenantId: merchant.moran_tenant_id, to: lead.phone, body: message, idempotencyKey: task.idempotency_key });
    await db('followup_tasks').where({ id: task.id }).update({ status: result.ok ? 'sent' : 'failed', message, dry_run: dryRun, result_json: JSON.stringify({ ...result, messageSource }), sent_at: result.ok ? new Date(now()) : null, updated_at: new Date(now()) });
    if (result.ok) {
      const attempts = lead.attempts + 1;
      const next = await db('followup_tasks').where({ lead_id: lead.id, status: 'pending' }).orderBy('due_at').first('due_at');
      await db('followup_leads').where({ id: lead.id }).update({ attempts, state: attempts >= lead.max_attempts || !next ? 'stopped' : 'contacted', stop_reason: attempts >= lead.max_attempts || !next ? 'max_attempts' : null, last_contact_at: new Date(now()), next_action_at: next?.due_at || null, updated_at: new Date(now()) });
      summary.sent += 1;
    } else summary.failed += 1;
  }
  return summary;
}
