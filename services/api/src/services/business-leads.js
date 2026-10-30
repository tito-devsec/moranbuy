import crypto from 'node:crypto';
import { logger, audit } from '@moranbuy/observability';
import { toMsisdn } from '@moranbuy/consent-management';
import { normalizeProductType, productWords } from '@moranbuy/budget-matching';
import { upsertMoranMerchant, upsertMoranLocation, upsertMoranListing } from '@moranbuy/product-catalog';
import { offersForListings } from '@moranbuy/reverse-marketplace';
import { formatMoney } from '@moranbuy/core';
import { db } from '../db/connection.js';

// Moran AI businesses that are not on MoranBuy but sell what a customer wants are asked first, on WhatsApp, for that one customer.
// Nothing about their products reaches a customer until the owner answers NDIO (this customer) or LISTI (list the whole business).
const MAX_PER_REQUEST = 3;
const MAX_PER_BUSINESS_PER_DAY = 5;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newRef = () => Array.from(crypto.randomBytes(5), (b) => ALPHABET[b % ALPHABET.length]).join('');

export async function askMatchingBusinesses({ moran, session, customer, request, dbImpl = db }) {
  if (!moran?.configured || !moran.leadMatches || !request.productType) return { asked: 0 };
  const canon = normalizeProductType(request.productType).productType;
  const words = [...new Set([request.productType, canon, ...productWords(canon), request.essentialAttributes?.brand].filter(Boolean))].slice(0, 12);
  // The same request is not sent to businesses twice.
  if (await dbImpl('business_leads').where({ session_id: session.id, product_type: canon || request.productType }).first('id')) return { asked: 0, already: true };
  const r = await moran.leadMatches({ words, maxPrice: request.maxBudget || null, limit: 6 });
  if (!r.ok) return { asked: 0, status: r.status };
  let asked = 0;
  for (const b of r.data?.businesses || []) {
    if (asked >= MAX_PER_REQUEST) break;
    const owner = toMsisdn(b.ownerPhone);
    if (!owner || owner === customer.channel_ref) continue;
    const today = await dbImpl('business_leads').where({ tenant_id: String(b.tenantId) }).where('created_at', '>=', new Date(Date.now() - 86400000)).count('* as n').first();
    if (Number(today.n) >= MAX_PER_BUSINESS_PER_DAY) continue;
    const ref = newRef();
    await dbImpl('business_leads').insert({ ref, session_id: session.id, customer_id: customer.id, tenant_id: String(b.tenantId), business_name: b.businessName || null, owner_phone: owner, product_type: canon || request.productType, matches: b.matches || 0, product_ids: JSON.stringify(b.productIds || []), request_json: JSON.stringify(request) });
    const place = request.location?.label || request.locationText || null;
    const budget = request.maxBudget ? formatMoney(request.maxBudget, request.currency || 'TZS') : null;
    const want = [request.productType, request.essentialAttributes?.brand, budget ? `bajeti ${budget}` : null].filter(Boolean).join(', ');
    const body = `MoranBuy (Moran AI): mteja${place ? ` aliye ${place}` : ''} anatafuta ${want}. ${b.businessName || 'Biashara yako'} ina bidhaa ${b.matches} zinazolingana.\n\nJibu NDIO ${ref} kumpa mteja huyu ofa zako (utalipwa kupitia MoranBuy baada ya kufikisha), LISTI ${ref} kuweka bidhaa zako zote MoranBuy, au HAPANA ${ref}. Kwa kujibu NDIO au LISTI unakubali Masharti ya MoranBuy kwa biashara: https://buy.moranai.co.tz/terms\n/ A customer${place ? ` in ${place}` : ''} wants ${want}. You have ${b.matches} matching products. Reply YES ${ref} to offer them, LIST ${ref} to list all your products on MoranBuy, or NO ${ref}. Answering YES or LIST accepts MoranBuy's terms for businesses.`;
    const sent = await moran.sendText({ to: owner, body, idempotencyKey: `moranbuy:lead:${ref}` });
    if (!sent.ok) { await dbImpl('business_leads').where({ ref }).update({ status: 'failed' }); continue; }
    asked += 1;
  }
  if (asked) await audit(dbImpl, { actorType: 'system', action: 'leads.asked', targetType: 'session', targetId: session.id, after: { asked, productType: canon } }).catch(() => null);
  return { asked };
}

// The owner's answer: NDIO/YES offers to that customer, LISTI/LIST also lists the whole business, HAPANA/NO declines.
export async function handleOwnerLeadReply({ moran, engine, from, text, acceptTerms = null, dbImpl = db }) {
  const m = String(text || '').trim().match(/^(ndio|ndiyo|yes|listi|list|hapana|no)\s+([A-Z0-9]{5})\b/i);
  if (!m) return null;
  const lead = await dbImpl('business_leads').where({ ref: m[2].toUpperCase(), owner_phone: toMsisdn(from) }).first();
  if (!lead) return null;
  if (lead.status !== 'asked') return { replies: [{ text: `MoranBuy: ${lead.ref} imeshajibiwa. / Already answered.` }] };
  if (Date.now() - new Date(lead.created_at).getTime() > 48 * 3600000) {
    await dbImpl('business_leads').where({ id: lead.id }).update({ status: 'expired', answered_at: dbImpl.fn.now() });
    return { replies: [{ text: `MoranBuy: ombi ${lead.ref} limepitwa na muda. / This request has expired.` }] };
  }
  const word = m[1].toLowerCase();
  if (['hapana', 'no'].includes(word)) {
    await dbImpl('business_leads').where({ id: lead.id }).update({ status: 'declined', answered_at: dbImpl.fn.now() });
    return { replies: [{ text: 'MoranBuy: Sawa, asante. / OK, thank you.' }] };
  }
  const listAll = ['listi', 'list'].includes(word);
  // The request said that answering NDIO or LISTI accepts MoranBuy's terms for businesses; the answer is recorded as that acceptance.
  if (acceptTerms) await acceptTerms();
  if (listAll) {
    const l = await moran.listTenant({ tenantId: lead.tenant_id, ownerPhone: lead.owner_phone });
    if (!l.ok) logger.warn({ status: l.status }, 'Business could not be listed from WhatsApp');
  }
  const p = await moran.leadProducts({ tenantId: lead.tenant_id, productIds: lead.product_ids || [] });
  const rows = p.ok ? p.data?.listings || [] : [];
  const ids = [];
  let businessName = lead.business_name || 'Duka';
  for (const row of rows) {
    const merchant = await upsertMoranMerchant(dbImpl, row);
    businessName = merchant.business_name || businessName;
    await upsertMoranLocation(dbImpl, merchant, row);
    await upsertMoranListing(dbImpl, merchant, row);
    const listing = await dbImpl('listings').where({ source: 'moran', source_merchant_ref: String(row.tenant_id), source_product_id: String(row.id) }).first('id');
    // Offered to one customer only: hidden from everyone else's search; LISTI makes them visible, including ones offered earlier.
    await dbImpl('listings').where({ id: listing.id }).update(listAll ? { moranbuy_visible: true } : { moranbuy_visible: false, sync_json: JSON.stringify({ via: 'lead', ref: lead.ref }) });
    ids.push(listing.id);
  }
  await dbImpl('business_leads').where({ id: lead.id }).update({ status: listAll ? 'listed' : 'accepted', answered_at: dbImpl.fn.now() });
  await audit(dbImpl, { actorType: 'merchant', action: listAll ? 'leads.listed' : 'leads.accepted', targetType: 'lead', targetId: lead.id, after: { ref: lead.ref, products: ids.length } }).catch(() => null);
  const customer = await dbImpl('customers').where({ id: lead.customer_id }).first();
  const out = customer && ids.length ? await engine.presentAgreedOffers(customer, await offersForListings(dbImpl, ids), { businessName }) : null;
  if (out) for (const [i, r] of out.replies.entries()) {
    const key = `moranbuy:lead-offer:${lead.ref}:${i}`;
    if (r.imageUrl) await moran.sendImage({ to: customer.channel_ref, imageUrl: r.imageUrl, caption: r.caption || '', idempotencyKey: key });
    else await moran.sendText({ to: customer.channel_ref, body: r.text, idempotencyKey: key });
  }
  const thanks = out
    ? `MoranBuy: Asante! Bidhaa ${ids.length} zimetumwa kwa mteja. Akiagiza utapata oda hapa.${listAll ? ' Biashara yako sasa iko MoranBuy.' : ''} / Thank you, sent to the customer.${listAll ? ' Your business is now on MoranBuy.' : ''}`
    : `MoranBuy: Asante. Bidhaa hazikupatikana kwa sasa${listAll ? ', lakini biashara yako sasa iko MoranBuy' : ''}. / Thank you.`;
  return { replies: [{ text: thanks }] };
}
