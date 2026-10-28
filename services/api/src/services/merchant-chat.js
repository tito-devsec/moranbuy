import { toMsisdn } from '@moranbuy/consent-management';
import { formatMoney } from '@moranbuy/core';
import { museExtractProduct, fallbackExtractProduct } from '@moranbuy/muse-intelligence';
import { audit } from '@moranbuy/observability';
import { offerOutreachForListing } from '@moranbuy/campaign-outreach';
import { db } from '../db/connection.js';
import { demandOverview } from './insights.js';
import { normalizeProductType } from '@moranbuy/reverse-marketplace';

const PRODUCT_CMD = /^(bidhaa|product|ongeza|add)\b/i;
const REPORT_CMD = /^(ripoti|report|takwimu|stats|statistics)\b/i;

// The registered business behind a WhatsApp number: its contact number, an active account and at least one dashboard user.
export async function registeredMerchantByPhone(dbImpl, phone) {
  const msisdn = toMsisdn(phone);
  if (!msisdn) return null;
  const rows = await dbImpl('merchants').where({ status: 'active' }).whereNotNull('contact_phone');
  const merchant = rows.find((m) => toMsisdn(m.contact_phone) === msisdn);
  if (!merchant) return null;
  const user = await dbImpl('merchant_users').where({ merchant_id: merchant.id }).first('id');
  return user ? merchant : null;
}

// A registered business talking to the MoranBuy number: a product (text or photo) goes into its catalogue, "RIPOTI" gets its demand overview; anything else is ordinary shopping.
export async function handleMerchantChat({ dbImpl = db, muse, from, text = '', imageUrl = null, kind = 'text', messageId = null }) {
  const merchant = await registeredMerchantByPhone(dbImpl, from);
  if (!merchant) return null;
  const t = String(text || '').trim();
  const lang = merchant.settings_json?.language === 'en' ? 'en' : 'sw';
  if (REPORT_CMD.test(t)) {
    const days = Number((t.match(/(\d{1,3})/) || [])[1]) || 30;
    const o = await demandOverview({ dbImpl, muse, merchantId: merchant.id, days: Math.min(365, Math.max(1, days)), language: lang });
    const actions = o.actions.length ? `\n${o.actions.map((a) => `- ${a}`).join('\n')}` : '';
    return { handled: true, kind: 'report', reply: `${merchant.business_name}: ${o.summary}${actions}` };
  }
  if (!imageUrl && !PRODUCT_CMD.test(t)) return null;
  // What Muse read from the message, or the plain parser when Muse is off; nothing is listed without a name.
  let extraction; let museStatus;
  const r = await museExtractProduct(muse, { text: t, imageUrl, merchantId: merchant.id }).catch(() => ({ ok: false, status: 'error' }));
  if (r.ok && r.json?.name) { extraction = r.json; museStatus = 'ok'; } else { extraction = fallbackExtractProduct(t); museStatus = r.status === 'disabled' ? 'disabled' : 'fallback'; }
  const name = extraction.name ? String(extraction.name).trim().slice(0, 160) : null;
  const known = normalizeProductType(`${name || ''} ${t}`);
  if (!extraction.productType && known.productType) { extraction.productType = known.productType; if (!extraction.category || extraction.category === 'other') extraction.category = known.category; }
  const price = Number.isFinite(Number(extraction.price)) && Number(extraction.price) > 0 ? Math.round(Number(extraction.price)) : null;
  const upload = { merchant_id: merchant.id, from_phone: toMsisdn(from), message_id: messageId, raw_text: t || null, image_url: imageUrl, kind, extraction_json: JSON.stringify(extraction), muse_status: museStatus };
  if (!name) {
    await dbImpl('catalog_uploads').insert({ ...upload, status: 'rejected', reason: 'no_name' });
    return { handled: true, kind: 'product_rejected', reply: lang === 'en' ? 'I could not read the product. Send it as "Product: name, price, stock", with a photo if you like.' : 'Sikuweza kusoma bidhaa. Tuma kama "Bidhaa: jina, bei, idadi", na picha ukipenda.' };
  }
  // The same product named again is updated, not listed twice.
  const existing = await dbImpl('listings').where({ merchant_id: merchant.id }).whereNull('deleted_at').whereRaw('lower(name) = lower(?)', [name]).first();
  const fields = {
    name, description: extraction.description ? String(extraction.description).slice(0, 2000) : existing?.description || null, category: extraction.category ? String(extraction.category).slice(0, 40) : existing?.category || 'other',
    product_type: extraction.productType ? String(extraction.productType).toLowerCase().slice(0, 80) : existing?.product_type || null, attributes: JSON.stringify({ ...(existing?.attributes || {}), ...(extraction.attributes && typeof extraction.attributes === 'object' ? extraction.attributes : {}) }),
    ...(price ? { price, price_status: 'listed' } : {}), ...(Number.isInteger(extraction.stock) ? { stock: extraction.stock } : {}), ...(extraction.condition ? { condition: extraction.condition } : {}), ...(imageUrl ? { image_url: imageUrl } : {}), updated_at: dbImpl.fn.now(),
  };
  let listing;
  if (existing) [listing] = await dbImpl('listings').where({ id: existing.id }).update(fields).returning('*');
  else {
    if (!price) {
      await dbImpl('catalog_uploads').insert({ ...upload, status: 'rejected', reason: 'no_price' });
      return { handled: true, kind: 'product_rejected', reply: lang === 'en' ? `I read "${name}" but no price. Send it again with the price, e.g. "Product: ${name}, price 250000".` : `Nimesoma "${name}" lakini bila bei. Tuma tena na bei, mfano "Bidhaa: ${name}, bei 250000".` };
    }
    [listing] = await dbImpl('listings').insert({ merchant_id: merchant.id, ...fields, currency: extraction.currency === 'USD' ? 'USD' : 'TZS', status: 'active', moranbuy_visible: true, source: 'whatsapp_chat', stock: Number.isInteger(extraction.stock) ? extraction.stock : null }).returning('*');
  }
  await dbImpl('catalog_uploads').insert({ ...upload, listing_id: listing.id, status: existing ? 'updated' : 'created' });
  await audit(dbImpl, { actorType: 'merchant', merchantId: merchant.id, action: existing ? 'listing.updated_by_chat' : 'listing.created_by_chat', targetType: 'listing', targetId: listing.id, after: { museStatus, kind } });
  if (!existing) await offerOutreachForListing(dbImpl, { merchantId: merchant.id, listingId: listing.id, trigger: 'listing_published' }).catch(() => null);
  const attrs = Object.entries(listing.attributes || {}).map(([k, v]) => `${k}: ${v}`).join(', ');
  const reply = lang === 'en'
    ? `${existing ? 'Updated' : 'Listed'}: ${listing.name}, ${formatMoney(listing.price, listing.currency)}${listing.stock !== null ? `, stock ${listing.stock}` : ''}${attrs ? ` (${attrs})` : ''}. Customers asking for this will now see it. Edit it in your MoranBuy dashboard.`
    : `${existing ? 'Imesasishwa' : 'Imeorodheshwa'}: ${listing.name}, ${formatMoney(listing.price, listing.currency)}${listing.stock !== null ? `, idadi ${listing.stock}` : ''}${attrs ? ` (${attrs})` : ''}. Wateja wanaotafuta hii sasa wataiona. Ihariri kwenye dashibodi yako ya MoranBuy.`;
  return { handled: true, kind: existing ? 'product_updated' : 'product_created', listing, reply };
}
