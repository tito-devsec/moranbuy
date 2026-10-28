import { toMsisdn } from '@moranbuy/consent-management';
import { formatMoney } from '@moranbuy/core';
import { museExtractProduct, museReadProductPhoto, fallbackExtractProduct } from '@moranbuy/muse-intelligence';
import { audit, logger } from '@moranbuy/observability';
import { offerOutreachForListing } from '@moranbuy/campaign-outreach';
import { normalizeProductType } from '@moranbuy/reverse-marketplace';
import { db } from '../db/connection.js';
import { demandOverview } from './insights.js';
import { saveUpload, publicUrl } from './uploads.js';
import { decodeImage, cropToJpeg } from './image-crop.js';

const PRODUCT_CMD = /^(bidhaa|product|ongeza|add)\b/i;
const REPORT_CMD = /^(ripoti|report|takwimu|stats|statistics)\b/i;
const MAX_FROM_PHOTO = 8;

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

// One product read from chat becomes a listing, or updates the one with the same name; the outcome is recorded either way.
async function upsertChatListing(dbImpl, { merchant, extraction, museStatus, from, messageId, rawText, kind, imageUrl = null, sourceImageRef = null }) {
  const name = extraction.name ? String(extraction.name).trim().slice(0, 160) : null;
  const known = normalizeProductType(`${name || ''} ${extraction.productType || ''} ${rawText || ''}`);
  if (!extraction.productType && known.productType) { extraction.productType = known.productType; if (!extraction.category || extraction.category === 'other') extraction.category = known.category; }
  const price = Number.isFinite(Number(extraction.price)) && Number(extraction.price) > 0 ? Math.round(Number(extraction.price)) : null;
  const record = { merchant_id: merchant.id, from_phone: toMsisdn(from), message_id: messageId, raw_text: rawText || null, image_url: sourceImageRef, kind, extraction_json: JSON.stringify(extraction), muse_status: museStatus };
  if (!name) { await dbImpl('catalog_uploads').insert({ ...record, status: 'rejected', reason: 'no_name' }); return { status: 'rejected', reason: 'no_name' }; }
  const existing = await dbImpl('listings').where({ merchant_id: merchant.id }).whereNull('deleted_at').whereRaw('lower(name) = lower(?)', [name]).first();
  const fields = {
    name, description: extraction.description ? String(extraction.description).slice(0, 2000) : existing?.description || null, category: extraction.category ? String(extraction.category).slice(0, 40) : existing?.category || 'other',
    product_type: extraction.productType ? String(extraction.productType).toLowerCase().slice(0, 80) : existing?.product_type || null,
    attributes: JSON.stringify({ ...(existing?.attributes || {}), ...(extraction.attributes && typeof extraction.attributes === 'object' ? extraction.attributes : {}) }),
    ...(price ? { price, price_status: 'listed' } : {}), ...(Number.isInteger(extraction.stock) ? { stock: extraction.stock } : {}), ...(extraction.condition ? { condition: extraction.condition } : {}), ...(imageUrl ? { image_url: imageUrl } : {}), updated_at: dbImpl.fn.now(),
  };
  let listing;
  if (existing) [listing] = await dbImpl('listings').where({ id: existing.id }).update(fields).returning('*');
  else {
    if (!price) { await dbImpl('catalog_uploads').insert({ ...record, status: 'rejected', reason: 'no_price' }); return { status: 'rejected', reason: 'no_price', name }; }
    [listing] = await dbImpl('listings').insert({ merchant_id: merchant.id, ...fields, currency: extraction.currency === 'USD' ? 'USD' : 'TZS', status: 'active', moranbuy_visible: true, source: 'whatsapp_chat', stock: Number.isInteger(extraction.stock) ? extraction.stock : null }).returning('*');
  }
  await dbImpl('catalog_uploads').insert({ ...record, listing_id: listing.id, status: existing ? 'updated' : 'created' });
  await audit(dbImpl, { actorType: 'merchant', merchantId: merchant.id, action: existing ? 'listing.updated_by_chat' : 'listing.created_by_chat', targetType: 'listing', targetId: listing.id, after: { museStatus, kind } });
  if (!existing) await offerOutreachForListing(dbImpl, { merchantId: merchant.id, listingId: listing.id, trigger: 'listing_published' }).catch(() => null);
  return { status: existing ? 'updated' : 'created', listing };
}

const line = (l, lang) => {
  const attrs = Object.entries(l.attributes || {}).map(([k, v]) => `${k}: ${v}`).join(', ');
  return `${l.name}, ${formatMoney(l.price, l.currency)}${l.stock !== null && l.stock !== undefined ? (lang === 'en' ? `, stock ${l.stock}` : `, idadi ${l.stock}`) : ''}${attrs ? ` (${attrs})` : ''}`;
};

// Saves a product photo (whole or cut out) as a public product image and returns its address.
async function saveProductImage(dbImpl, merchant, buffer) {
  const up = await saveUpload({ dbImpl, buffer, purpose: 'product_image', merchantId: merchant.id }).catch((err) => { logger.warn({ err: err.message }, 'Product photo not saved'); return null; });
  return up ? { url: publicUrl(up), ref: `upload:${up.id}` } : null;
}

// A business photo: Muse lists what is for sale, SAM 3.1 finds each pictured product, and each cut-out becomes that listing's photo.
async function listFromPhoto(dbImpl, { muse, merchant, from, messageId, text, imageDataUrl, imageBuffer, kind }) {
  const read = await museReadProductPhoto(muse, { imageUrl: imageDataUrl, text, merchantId: merchant.id }).catch(() => ({ ok: false, status: 'error' }));
  let products = read.ok && Array.isArray(read.json?.products) ? read.json.products.filter((p) => p && p.name).slice(0, MAX_FROM_PHOTO) : [];
  const museStatus = read.ok ? 'ok' : read.status === 'disabled' ? 'disabled' : 'fallback';
  // Without Muse, the caption alone may still describe one product.
  if (!products.length) { const fb = fallbackExtractProduct(text); products = fb.name ? [fb] : []; }
  const whole = imageBuffer ? await saveProductImage(dbImpl, merchant, imageBuffer) : null;
  if (!products.length) {
    await dbImpl('catalog_uploads').insert({ merchant_id: merchant.id, from_phone: toMsisdn(from), message_id: messageId, raw_text: text || null, image_url: whole?.ref || null, kind, extraction_json: JSON.stringify(read.json || {}), muse_status: museStatus, status: 'rejected', reason: 'no_name' });
    return { results: [], museStatus, located: 0 };
  }
  // SAM 3.1 finds every instance of each pictured concept; boxes are paired with the products left to right.
  const image = imageBuffer ? (() => { try { return decodeImage(imageBuffer); } catch { return null; } })() : null;
  const boxesFor = {};
  let located = 0;
  if (muse?.enabled && image) {
    for (const concept of [...new Set(products.map((p) => p.concept).filter(Boolean).map((c) => String(c).toLowerCase().slice(0, 40)))]) {
      const seg = await muse.segment(imageDataUrl, concept, { merchantId: merchant.id, requestRef: messageId }).catch(() => ({ ok: false }));
      boxesFor[concept] = seg.ok ? seg.boxes.filter((b) => b.confidence === null || b.confidence >= 0.35).sort((a, b) => a.x1 - b.x1 || a.y1 - b.y1) : [];
    }
  }
  const used = {};
  const results = [];
  for (const p of products) {
    const concept = p.concept ? String(p.concept).toLowerCase().slice(0, 40) : null;
    const box = concept && boxesFor[concept] ? boxesFor[concept][used[concept] = (used[concept] ?? -1) + 1] : null;
    let photo = null;
    if (box && image) {
      const jpg = (() => { try { return cropToJpeg(image, box); } catch { return null; } })();
      if (jpg) { photo = await saveProductImage(dbImpl, merchant, Buffer.from(jpg)); if (photo) located += 1; }
    }
    // A single pictured product keeps the whole photo when SAM is unavailable; a price list item gets no photo.
    if (!photo && products.length === 1 && p.concept !== null) photo = whole;
    results.push(await upsertChatListing(dbImpl, { merchant, extraction: { ...p }, museStatus, from, messageId, rawText: text, kind, imageUrl: photo?.url || null, sourceImageRef: whole?.ref || null }));
  }
  return { results, museStatus, located };
}

// A registered business talking to the MoranBuy number: products (typed, spoken or photographed) go into its catalogue, "RIPOTI" gets its demand overview; anything else is ordinary shopping.
export async function handleMerchantChat({ dbImpl = db, muse, from, text = '', imageUrl = null, imageBuffer = null, kind = 'text', messageId = null }) {
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
  const isPhoto = !!(imageBuffer || imageUrl);
  if (!isPhoto && !PRODUCT_CMD.test(t)) return null;

  if (isPhoto) {
    const { results, located } = await listFromPhoto(dbImpl, { muse, merchant, from, messageId, text: t, imageDataUrl: imageUrl, imageBuffer, kind });
    const done = results.filter((r) => r.listing);
    const noPrice = results.filter((r) => r.reason === 'no_price').map((r) => r.name);
    if (!done.length) {
      const reply = noPrice.length
        ? (lang === 'en' ? `I read ${noPrice.join(', ')} but no price. Send the photo again with prices in the caption, e.g. "Sofa 450000".` : `Nimesoma ${noPrice.join(', ')} lakini bila bei. Tuma picha tena na bei kwenye maelezo, mfano "Sofa 450000".`)
        : (lang === 'en' ? 'I could not read a product in that photo. Add a caption like "Product: name, price, stock".' : 'Sikuweza kusoma bidhaa kwenye picha hiyo. Ongeza maelezo kama "Bidhaa: jina, bei, idadi".');
      return { handled: true, kind: 'product_rejected', reply };
    }
    const listed = done.map((r) => `- ${line(r.listing, lang)}${r.status === 'updated' ? (lang === 'en' ? ' (updated)' : ' (imesasishwa)') : ''}`).join('\n');
    const head = lang === 'en' ? `Listed from your photo (${done.length}${located ? `, ${located} cut out as product photos` : ''}):` : `Nimeorodhesha kutoka kwenye picha (${done.length}${located ? `, picha ${located} zimekatwa kwa kila bidhaa` : ''}):`;
    const tail = noPrice.length ? (lang === 'en' ? `\nNo price for: ${noPrice.join(', ')}. Send their prices to list them.` : `\nHazina bei: ${noPrice.join(', ')}. Tuma bei zake kuziorodhesha.`) : '';
    return { handled: true, kind: done.length > 1 ? 'products_created' : done[0].status === 'updated' ? 'product_updated' : 'product_created', listings: done.map((r) => r.listing), reply: `${head}\n${listed}${tail}` };
  }

  // Typed or spoken: one product per message.
  let extraction; let museStatus;
  const r = await museExtractProduct(muse, { text: t, merchantId: merchant.id }).catch(() => ({ ok: false, status: 'error' }));
  if (r.ok && r.json?.name) { extraction = r.json; museStatus = 'ok'; } else { extraction = fallbackExtractProduct(t); museStatus = r.status === 'disabled' ? 'disabled' : 'fallback'; }
  const out = await upsertChatListing(dbImpl, { merchant, extraction, museStatus, from, messageId, rawText: t, kind });
  if (out.reason === 'no_name') return { handled: true, kind: 'product_rejected', reply: lang === 'en' ? 'I could not read the product. Send it as "Product: name, price, stock", with a photo if you like.' : 'Sikuweza kusoma bidhaa. Tuma kama "Bidhaa: jina, bei, idadi", na picha ukipenda.' };
  if (out.reason === 'no_price') return { handled: true, kind: 'product_rejected', reply: lang === 'en' ? `I read "${out.name}" but no price. Send it again with the price, e.g. "Product: ${out.name}, price 250000".` : `Nimesoma "${out.name}" lakini bila bei. Tuma tena na bei, mfano "Bidhaa: ${out.name}, bei 250000".` };
  const reply = lang === 'en'
    ? `${out.status === 'updated' ? 'Updated' : 'Listed'}: ${line(out.listing, lang)}. Customers asking for this will now see it. Edit it in your MoranBuy dashboard.`
    : `${out.status === 'updated' ? 'Imesasishwa' : 'Imeorodheshwa'}: ${line(out.listing, lang)}. Wateja wanaotafuta hii sasa wataiona. Ihariri kwenye dashibodi yako ya MoranBuy.`;
  return { handled: true, kind: out.status === 'updated' ? 'product_updated' : 'product_created', listing: out.listing, reply };
}
