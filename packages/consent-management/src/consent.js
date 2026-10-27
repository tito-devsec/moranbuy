import { toMsisdn } from './phone.js';

export const PURPOSES = Object.freeze(['marketing', 'followup', 'service', 'all']);

// Appends one consent event; nothing is ever overwritten, so the history is the evidence.
export async function recordConsent(db, { merchantId = null, phone, purpose, channel = 'whatsapp', status, source, evidenceRef = null, recordedBy = null }) {
  if (!PURPOSES.includes(purpose)) throw new Error(`Unknown consent purpose ${purpose}`);
  if (!['granted', 'revoked'].includes(status)) throw new Error('status must be granted or revoked');
  const [row] = await db('consent_events').insert({ merchant_id: merchantId, phone: toMsisdn(phone), purpose, channel, status, source, evidence_ref: evidenceRef, recorded_by: recordedBy }).returning('*');
  return row;
}

// The current answer for one phone, merchant and purpose: a global or merchant "all" revocation beats everything, then the latest event for the purpose.
export async function consentState(db, { merchantId, phone, purpose, channel = 'whatsapp' }) {
  const msisdn = toMsisdn(phone);
  const events = await db('consent_events').where({ phone: msisdn, channel }).where(function w() { this.whereNull('merchant_id').orWhere('merchant_id', merchantId); }).orderBy('created_at', 'desc').orderBy('id', 'desc');
  const latestAll = events.find((e) => e.purpose === 'all');
  if (latestAll && latestAll.status === 'revoked') return { granted: false, reason: 'opted_out', event: latestAll };
  const latest = events.find((e) => e.purpose === purpose && (e.merchant_id === merchantId || e.merchant_id === null));
  if (!latest) return { granted: false, reason: 'no_consent', event: null };
  if (latest.status === 'revoked') return { granted: false, reason: 'revoked', event: latest };
  return { granted: true, reason: 'granted', event: latest };
}

// A STOP sent to a merchant's number stops that merchant; one sent to the MoranBuy number stops everyone.
export async function optOut(db, { merchantId = null, phone, source = 'inbound_keyword', evidenceRef = null }) {
  return recordConsent(db, { merchantId, phone, purpose: 'all', status: 'revoked', source, evidenceRef });
}

// Only the customer's own explicit request may opt back in, and only for marketing from the merchant they wrote to.
export async function optIn(db, { merchantId, phone, source = 'inbound_keyword', evidenceRef = null }) {
  await recordConsent(db, { merchantId, phone, purpose: 'all', status: 'granted', source, evidenceRef });
  return recordConsent(db, { merchantId, phone, purpose: 'marketing', status: 'granted', source, evidenceRef });
}

// The full history for a phone as the admin or the customer may see it.
export function consentHistory(db, { phone, merchantId = null }) {
  const q = db('consent_events').where({ phone: toMsisdn(phone) }).orderBy('created_at', 'desc');
  return merchantId ? q.where(function w() { this.whereNull('merchant_id').orWhere('merchant_id', merchantId); }) : q;
}

// Deletes a customer's contact and consent rows for a merchant on request; audit stays.
export async function eraseContact(db, { merchantId, phone }) {
  const msisdn = toMsisdn(phone);
  await db('contacts').where({ merchant_id: merchantId, phone: msisdn }).delete();
  await db('consent_events').where({ merchant_id: merchantId, phone: msisdn }).delete();
}
