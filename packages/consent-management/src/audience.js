import { consentState } from './consent.js';
import { toMsisdn, isValidMsisdn } from './phone.js';
import { resolvePlace } from '@moranbuy/location-ranking';

// Scores a merchant's contacts by what they asked MoranBuy for lately against the offer: product first, then category, place and timing.
export async function fitScores(db, { merchantId, listingId, phones, now = Date.now() }) {
  const listing = listingId ? await db('listings').where({ id: listingId, merchant_id: merchantId }).first() : null;
  const loc = await db('merchant_locations').where({ merchant_id: merchantId, is_default: true }).whereNull('deleted_at').first();
  const region = loc?.region || resolvePlace(loc?.formatted_address).region || null;
  const since = new Date(now - 90 * 86400000);
  const customers = phones.length ? await db('customers').where({ channel: 'whatsapp' }).whereIn('channel_ref', phones) : [];
  const signals = customers.length ? await db('demand_signals').whereIn('customer_id', customers.map((c) => c.id)).where('created_at', '>=', since).orderBy('created_at', 'desc') : [];
  const out = {};
  for (const c of customers) {
    const mine = signals.filter((s) => s.customer_id === c.id);
    let best = { score: 0, reasons: [] };
    for (const s of mine) {
      const r = [];
      let score = 0;
      if (listing?.product_type && s.product_type && s.product_type.toLowerCase() === listing.product_type.toLowerCase()) { score += 1; r.push('asked_for_this_product'); }
      else if (listing?.category && s.category && s.category === listing.category) { score += 0.5; r.push('asked_for_this_category'); }
      if (!score) continue;
      if (listing?.price && s.max_budget) { if (s.max_budget >= listing.price) { score += 0.2; r.push('within_their_budget'); } else r.push('over_their_budget'); }
      if (region && s.region === region) { score += 0.2; r.push('same_region'); }
      if (s.purchase_timing === 'later') { score += 0.1; r.push('said_they_would_buy_later'); }
      if (s.outcome === 'no_match') { score += 0.2; r.push('found_nothing_then'); }
      if (score > best.score) best = { score: Math.min(2, score), reasons: r, lastAskedAt: s.created_at, productType: s.product_type, budget: s.max_budget, region: s.region, district: s.district };
    }
    out[c.channel_ref] = best;
  }
  return out;
}

// Resolves a campaign audience to the contacts this merchant may message now, with a reason for every exclusion.
export async function resolveAudience(db, { merchantId, audience = {}, purpose = 'marketing', frequencyCap = 4, now = Date.now() }) {
  const segment = audience.segment || 'consented_contacts';
  let candidates = [];
  if (segment === 'consented_contacts' || segment === 'all_contacts' || segment === 'best_fit') candidates = await db('contacts').where({ merchant_id: merchantId }).select('phone', 'name', 'source', 'tags');
  else if (segment === 'phones' && Array.isArray(audience.phones)) candidates = audience.phones.map((p) => ({ phone: toMsisdn(p), name: null, source: 'list' }));
  else if (segment === 'tag' && audience.tag) candidates = (await db('contacts').where({ merchant_id: merchantId }).select('phone', 'name', 'source', 'tags')).filter((c) => (c.tags || []).includes(audience.tag));

  const included = [];
  const excluded = [];
  const seen = new Set();
  const windowStart = new Date(now - 30 * 86400000);
  for (const c of candidates) {
    const phone = toMsisdn(c.phone);
    if (!isValidMsisdn(phone)) { excluded.push({ phone: c.phone, reason: 'invalid_number' }); continue; }
    if (seen.has(phone)) { excluded.push({ phone, reason: 'duplicate' }); continue; }
    seen.add(phone);
    // A phone outside this merchant's own contacts is never messaged from a pasted list; the merchant must have a relationship with it.
    if (segment === 'phones') {
      const known = await db('contacts').where({ merchant_id: merchantId, phone }).first('id');
      if (!known) { excluded.push({ phone, reason: 'not_a_merchant_contact' }); continue; }
    }
    const consent = await consentState(db, { merchantId, phone, purpose });
    if (!consent.granted) { excluded.push({ phone, reason: consent.reason }); continue; }
    const recent = await db('campaign_recipients').where({ merchant_id: merchantId, phone }).whereIn('status', ['sent', 'delivered', 'read']).where('sent_at', '>=', windowStart).count('id as n').first();
    if (Number(recent.n) >= frequencyCap) { excluded.push({ phone, reason: 'frequency_cap' }); continue; }
    included.push({ phone, name: c.name || null });
  }
  // Best fit keeps only contacts whose recent requests match the offer, strongest first, up to the limit the merchant set.
  if (segment === 'best_fit') {
    const fit = await fitScores(db, { merchantId, listingId: audience.listingId || null, phones: included.map((i) => i.phone), now });
    const kept = [];
    for (const i of included) { const f = fit[i.phone]; if (f && f.score > 0) kept.push({ ...i, fit: f }); else excluded.push({ phone: i.phone, reason: 'no_fit' }); }
    kept.sort((a, b) => b.fit.score - a.fit.score);
    const limit = Math.min(5000, Math.max(1, Number(audience.limit) || 200));
    for (const extra of kept.slice(limit)) excluded.push({ phone: extra.phone, reason: 'over_limit' });
    included.length = 0; included.push(...kept.slice(0, limit));
  }
  const reasons = {};
  for (const e of excluded) reasons[e.reason] = (reasons[e.reason] || 0) + 1;
  return { segment, included, excluded, counts: { candidates: candidates.length, included: included.length, excluded: excluded.length }, exclusionReasons: reasons };
}

// Adds or refreshes a contact the merchant has a real relationship with (an enquiry, an order, a session); never from scraping.
export async function upsertContact(db, { merchantId, phone, name = null, source }) {
  const msisdn = toMsisdn(phone);
  if (!isValidMsisdn(msisdn)) return null;
  const [row] = await db('contacts').insert({ merchant_id: merchantId, phone: msisdn, name, source, last_interaction_at: db.fn.now() })
    .onConflict(['merchant_id', 'phone']).merge({ last_interaction_at: db.fn.now(), ...(name ? { name } : {}) }).returning('*');
  return row;
}
