import { consentState } from './consent.js';
import { toMsisdn, isValidMsisdn } from './phone.js';

// Resolves a campaign audience to the contacts this merchant may message now, with a reason for every exclusion.
export async function resolveAudience(db, { merchantId, audience = {}, purpose = 'marketing', frequencyCap = 4, now = Date.now() }) {
  const segment = audience.segment || 'consented_contacts';
  let candidates = [];
  if (segment === 'consented_contacts' || segment === 'all_contacts') candidates = await db('contacts').where({ merchant_id: merchantId }).select('phone', 'name', 'source', 'tags');
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
