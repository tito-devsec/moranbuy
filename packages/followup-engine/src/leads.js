import { toMsisdn, consentState } from '@moranbuy/consent-management';
import { audit } from '@moranbuy/observability';
import { followupSettings } from './offer.js';

// Creates a lead from a real interaction and schedules its attempts from the merchant's rules; a lead with no basis to contact is recorded as stopped.
export async function createLead(db, { merchantId, phone, listingId = null, source, statedIntention = null, requestedContactAt = null, customerRef = null, now = Date.now() }) {
  const merchant = await db('merchants').where({ id: merchantId }).first();
  const s = followupSettings(merchant);
  const msisdn = toMsisdn(phone);
  const followup = await consentState(db, { merchantId, phone: msisdn, purpose: 'followup' });
  const service = await consentState(db, { merchantId, phone: msisdn, purpose: 'service' });
  const basis = followup.granted ? 'followup_granted' : service.granted ? 'service_relationship' : 'none';
  const existing = await db('followup_leads').where({ merchant_id: merchantId, phone: msisdn }).whereIn('state', ['new', 'scheduled']).first();
  if (existing) return existing;
  const firstAt = requestedContactAt ? new Date(requestedContactAt) : new Date(now + s.scheduleHours[0] * 3600000);
  const [lead] = await db('followup_leads').insert({ merchant_id: merchantId, phone: msisdn, customer_ref: customerRef, listing_id: listingId, source, stated_intention: statedIntention, requested_contact_at: requestedContactAt, consent_basis: basis, state: basis === 'none' ? 'stopped' : 'scheduled', stop_reason: basis === 'none' ? 'no_consent' : null, next_action_at: basis === 'none' ? null : firstAt, max_attempts: s.maxAttempts }).returning('*');
  if (basis !== 'none') {
    const tasks = s.scheduleHours.slice(0, s.maxAttempts).map((h, i) => ({ lead_id: lead.id, merchant_id: merchantId, attempt: i + 1, due_at: i === 0 ? firstAt : new Date(firstAt.getTime() + (h - s.scheduleHours[0]) * 3600000), idempotency_key: `followup:${lead.id}:${i + 1}` }));
    await db('followup_tasks').insert(tasks);
  }
  await audit(db, { actorType: 'system', merchantId, action: 'followup.lead_created', targetType: 'followup_lead', targetId: lead.id, after: { source, basis, state: lead.state } });
  return lead;
}

// Stops a lead for a reason that ends follow-up: opt-out, decline, purchase, cancellation or the attempt limit.
export async function stopLead(db, { leadId, reason, outcome = null }) {
  const [lead] = await db('followup_leads').where({ id: leadId }).update({ state: reason === 'converted' ? 'converted' : 'stopped', stop_reason: reason, outcome: outcome || (reason === 'converted' ? 'purchased' : null), next_action_at: null, updated_at: db.fn.now() }).returning('*');
  await db('followup_tasks').where({ lead_id: leadId, status: 'pending' }).update({ status: 'cancelled', skip_reason: reason, updated_at: db.fn.now() });
  return lead;
}

// A reply, an order or an opt-out from this phone stops every open lead the merchant has for it.
export async function stopLeadsForPhone(db, { merchantId = null, phone, reason, outcome = null }) {
  const q = db('followup_leads').where({ phone: toMsisdn(phone) }).whereIn('state', ['new', 'scheduled', 'contacted']);
  const leads = merchantId ? await q.andWhere({ merchant_id: merchantId }) : await q;
  for (const l of leads) await stopLead(db, { leadId: l.id, reason, outcome });
  return leads.length;
}

export function listLeads(db, merchantId) {
  return db('followup_leads as l').leftJoin('listings as p', 'p.id', 'l.listing_id').where('l.merchant_id', merchantId).orderBy('l.created_at', 'desc').limit(200).select('l.*', 'p.name as listing_name');
}

const OPEN = ['new', 'scheduled', 'contacted'];
const CONVERT_WINDOW_MS = 30 * 86400000;

// An order was placed: the merchant's open leads for this phone stop nudging while the merchant decides.
export async function holdLeadsForOrder(db, { merchantId, phone, orderRef }) {
  const leads = await db('followup_leads').where({ merchant_id: merchantId, phone: toMsisdn(phone) }).whereIn('state', OPEN);
  for (const l of leads) await stopLead(db, { leadId: l.id, reason: 'order_placed' });
  if (leads.length) await audit(db, { actorType: 'system', merchantId, action: 'followup.leads_held_for_order', targetType: 'order', targetId: null, after: { orderRef, leads: leads.length } });
  return leads.length;
}

// The merchant accepted, was paid for, or delivered the order: leads for this phone that came before it are converted, each once.
export async function convertLeadsForOrder(db, { order, phone, now = Date.now() }) {
  const created = new Date(order.created_at || now);
  const since = new Date(created.getTime() - CONVERT_WINDOW_MS);
  const leads = await db('followup_leads').where({ merchant_id: order.merchant_id, phone: toMsisdn(phone) })
    .where('created_at', '<', created).where('created_at', '>=', since)
    .where((q) => q.whereIn('state', OPEN).orWhere((s) => s.where({ state: 'stopped' }).whereIn('stop_reason', ['order_placed', 'customer_replied'])));
  for (const l of leads) {
    await db('followup_leads').where({ id: l.id }).whereNot({ state: 'converted' }).update({ state: 'converted', stop_reason: 'converted', outcome: 'purchased', converted_order_id: order.id, converted_at: new Date(now), next_action_at: null, updated_at: new Date(now) });
    await db('followup_tasks').where({ lead_id: l.id, status: 'pending' }).update({ status: 'cancelled', skip_reason: 'converted', updated_at: new Date(now) });
  }
  if (leads.length) await audit(db, { actorType: 'system', merchantId: order.merchant_id, action: 'followup.leads_converted', targetType: 'order', targetId: order.id, after: { orderRef: order.order_ref, leads: leads.map((l) => l.id) } });
  return leads.length;
}

// The order fell through: leads held for it say so, and stay stopped.
export async function releaseLeadsForOrder(db, { order, phone }) {
  return db('followup_leads').where({ merchant_id: order.merchant_id, phone: toMsisdn(phone), state: 'stopped', stop_reason: 'order_placed' })
    .where('updated_at', '>=', new Date(order.created_at || Date.now())).update({ stop_reason: 'order_not_completed', updated_at: db.fn.now() });
}
