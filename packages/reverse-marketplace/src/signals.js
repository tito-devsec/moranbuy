import { resolvePlace } from '@moranbuy/location-ranking';
import { normalizeProductType } from './vocabulary.js';

// Words that say the customer is not buying today; the schedule records them so a follow-up can land at the right time.
const LATER = /\b(baadaye|kesho|keshokutwa|wiki ijayo|mwezi ujao|mwishoni mwa mwezi|nikipata pesa|nikilipwa|later|tomorrow|next week|next month|end of month|when i get paid|nitakupigia|nitarudi|call me|nipigie)\b/i;
const BROWSING = /\b(naangalia tu|kuangalia tu|just looking|just checking|bei tu|nauliza tu|just asking)\b/i;

// Reads when the customer means to buy from the text alone, used when Muse did not say.
export function fallbackTiming(text) {
  const t = String(text || '');
  if (BROWSING.test(t)) return { purchaseTiming: 'browsing', schedule: null };
  const m = t.match(LATER);
  if (m) return { purchaseTiming: 'later', schedule: { when: m[0], note: t.slice(0, 160) } };
  return { purchaseTiming: null, schedule: null };
}

// Turns "kesho", "wiki ijayo" and the like into a due date; unknown phrases keep only the words.
export function dueFromWords(when, now = Date.now()) {
  const w = String(when || '').toLowerCase();
  const day = 86400000;
  if (/kesho kutwa|keshokutwa|day after tomorrow/.test(w)) return new Date(now + 2 * day);
  if (/kesho|tomorrow/.test(w)) return new Date(now + day);
  if (/wiki ijayo|next week/.test(w)) return new Date(now + 7 * day);
  if (/mwezi ujao|next month/.test(w)) return new Date(now + 30 * day);
  if (/mwishoni mwa mwezi|end of month|nikilipwa|when i get paid/.test(w)) { const d = new Date(now); return new Date(d.getFullYear(), d.getMonth() + 1, 0, 10, 0, 0); }
  return null;
}

// Records one demand signal from a customer message and keeps the customer's region, district, name and intent current for statistics.
export async function recordDemandSignal(db, { customer, session, request, kind = 'text', intent, outcome, purchaseTiming = null, merchantId = null, listingId = null, customerName = null, now = Date.now() }) {
  const label = request?.location?.label || request?.locationText || null;
  const place = resolvePlace(label);
  const region = place.region || customer.region || null;
  const district = place.district || (place.region ? null : customer.district || null);
  // The product is counted under one known name whenever a known word is in it; the guess is kept only when no word is known.
  const known = normalizeProductType(request?.productType);
  const productType = known.productType || (request?.productType ? String(request.productType).slice(0, 80) : null);
  const category = request?.category && request.category !== 'other' ? request.category : known.category || request?.category || null;
  const [row] = await db('demand_signals').insert({
    customer_id: customer.id, session_id: session?.id || null, merchant_id: merchantId, listing_id: listingId,
    product_type: productType, category, attributes_json: JSON.stringify({ ...(request?.essentialAttributes || {}), ...(request?.preferredAttributes || {}) }),
    max_budget: request?.maxBudget ?? null, currency: request?.currency || 'TZS', location_label: label ? String(label).slice(0, 200) : null, region, district,
    lat: request?.location?.lat ?? null, lng: request?.location?.lng ?? null, intent, purchase_timing: purchaseTiming, source_kind: kind, outcome, created_at: new Date(now),
  }).returning('*');
  const patch = { last_intent: intent, ...(purchaseTiming ? { purchase_timing: purchaseTiming } : {}), ...(place.region ? { region: place.region, district: place.district, last_location_at: new Date(now) } : {}), ...(customerName && !customer.name ? { name: String(customerName).slice(0, 120) } : {}) };
  await db('customers').where({ id: customer.id }).update(patch);
  return row;
}

// Keeps one open schedule per session: a later message with a new time replaces the earlier one.
export async function recordSchedule(db, { customer, session, schedule, merchantId = null, listingId = null, now = Date.now() }) {
  if (!schedule?.when) return null;
  const kind = /pigia|call|nipigie/i.test(schedule.when) || /pigia|call/i.test(schedule.note || '') ? 'callback' : 'purchase_plan';
  const row = { customer_id: customer.id, session_id: session?.id || null, merchant_id: merchantId, listing_id: listingId, kind, due_at: dueFromWords(schedule.when, now), when_text: String(schedule.when).slice(0, 160), note: schedule.note ? String(schedule.note).slice(0, 500) : null, updated_at: new Date(now) };
  const open = session?.id ? await db('customer_schedules').where({ session_id: session.id, status: 'scheduled' }).first() : null;
  if (open) { await db('customer_schedules').where({ id: open.id }).update(row); return { ...open, ...row }; }
  const [created] = await db('customer_schedules').insert(row).returning('*');
  return created;
}
