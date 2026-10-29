import { toMsisdn } from '@moranbuy/consent-management';
import { museCheckDeliveryPhoto, museClassifyRejection } from '@moranbuy/muse-intelligence';
import { logger } from '@moranbuy/observability';
import { db } from '../../db/connection.js';
import { saveUpload, readUpload } from '../uploads.js';
import { fingerprint, fingerprintDistance } from '../image-crop.js';
import { codeMatches, findCodeCandidate } from './codes.js';
import { latestReceipt, sendReceipt } from './receipts-store.js';
import {
  loadProtectionSettings, recordEvent, assignDeliverer, completeDelivery, openDispute, refundPayment, releasePayment, requestPayment, addStrike, MERCHANT_FAULTS,
} from './protection.js';

// WhatsApp conversations around a protected order: the delivery person at the door, the customer, and the business owner.
const REF = /\bMB-[A-Z0-9]{4,8}\b/i;
const say = (l, sw, en) => (l === 'en' ? en : sw);
const both = (sw, en) => `${sw}\n/ ${en}`;

function haversineKm(a, b) {
  const r = (d) => (d * Math.PI) / 180;
  const dLat = r(b.lat - a.lat); const dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

async function orderByRef(dbImpl, ref) { return ref ? dbImpl('orders').where({ order_ref: String(ref).toUpperCase() }).first() : null; }

// The delivery person's active order: named by a button or reference, or the only one they carry.
async function delivererOrder(dbImpl, from, { buttonId, text }) {
  const ref = buttonId?.startsWith('dlv:') ? buttonId.split(':')[2] : (String(text || '').match(REF)?.[0] || null);
  const active = await dbImpl('order_protection as p').join('orders as o', 'o.id', 'p.order_id').where('p.deliverer_phone', toMsisdn(from)).whereIn('p.state', ['deliverer_assigned']).select('o.order_ref', 'p.order_id');
  if (ref) { const hit = active.find((a) => a.order_ref === ref.toUpperCase()); return hit ? { orderId: hit.order_id, many: false } : null; }
  if (active.length === 1) return { orderId: active[0].order_id, many: false };
  return active.length ? { orderId: null, many: true, refs: active.map((a) => a.order_ref) } : null;
}

// Photo evidence: kept privately, fingerprinted against earlier delivery photos and the catalogue picture, and checked by Muse and SAM 3.1.
async function takePhoto({ dbImpl, muse, order, listing, from, imageBuffer, purpose }) {
  const upload = await saveUpload({ dbImpl, buffer: imageBuffer, purpose: 'delivery_photo', merchantId: order.merchant_id }).catch(() => null);
  if (!upload) return { ok: false };
  const fp = (() => { try { return fingerprint(imageBuffer); } catch { return null; } })();
  const earlier = await dbImpl('delivery_events').whereIn('kind', ['photo', 'rejection_photo']).whereNot({ order_id: order.id }).whereRaw("data_json->>'fp' is not null").orderBy('id', 'desc').limit(2000).select('data_json');
  const reused = fp ? earlier.some((e) => fingerprintDistance(fp, e.data_json.fp) <= 5) : false;
  let catalogue = false;
  const key = listing?.image_url?.match(/\/media\/([^/?#]+)/)?.[1];
  if (fp && key) {
    const img = await dbImpl('uploads').where({ storage_key: key }).first();
    if (img) { const buf = await readUpload(img).catch(() => null); const cfp = buf ? (() => { try { return fingerprint(buf); } catch { return null; } })() : null; catalogue = cfp ? fingerprintDistance(fp, cfp) <= 5 : false; }
  }
  const dataUrl = `data:${upload.mime};base64,${imageBuffer.toString('base64')}`;
  const ordered = `${listing?.name || 'product'}${order.variant ? ` (${order.variant})` : ''}, quantity ${order.quantity}${listing?.product_type ? `, type ${listing.product_type}` : ''}`;
  const check = muse ? await museCheckDeliveryPhoto(muse, { imageUrl: dataUrl, ordered, merchantId: order.merchant_id, requestRef: order.id }).catch(() => ({ ok: false })) : { ok: false };
  const concept = listing?.product_type || String(listing?.name || '').split(/\s+/)[0] || null;
  const seg = muse && concept ? await muse.segment(dataUrl, concept, { merchantId: order.merchant_id, requestRef: order.id }).catch(() => ({ ok: false })) : { ok: false };
  const found = seg.ok ? seg.boxes.filter((b) => (b.confidence ?? 1) >= 0.35).length : null;
  const data = { fp, reusedPhoto: reused, cataloguePhoto: catalogue, muse: check.ok ? { matches: check.matches, productSeen: check.productSeen, colourMatches: check.colourMatches, looksStaged: check.looksStaged, reason: check.reason } : { status: check.status || 'unchecked' }, sam: seg.ok ? { concept, found } : null };
  await recordEvent(dbImpl, { orderId: order.id, actor: 'deliverer', kind: purpose, phone: toMsisdn(from), uploadId: upload.id, data });
  return { ok: true, uploadId: upload.id, data };
}

const hasEvent = async (dbImpl, orderId, kind, since = null) => !!(await dbImpl('delivery_events').where({ order_id: orderId, kind }).modify((q) => { if (since) q.where('created_at', '>=', since); }).first('id'));

// Messages from a delivery person; returns null when the message is not about a delivery, so ordinary shopping goes on.
export async function handleDelivererMessage({ dbImpl = db, moran, payments, muse, from, text = '', buttonId = null, imageBuffer = null, location = null }) {
  const isButton = buttonId?.startsWith('dlv:');
  const target = await delivererOrder(dbImpl, from, { buttonId, text });
  if (!target) return isButton ? { handled: true, reply: both('Oda hii haina delivery inayokusubiri.', 'This order has no delivery waiting for you.') } : null;
  if (target.many) {
    if (!isButton && !imageBuffer && !findCodeCandidate(text) && !location) return null;
    return { handled: true, reply: both(`Una delivery zaidi ya moja (${target.refs.join(', ')}). Taja namba ya oda pamoja na ujumbe wako.`, `You have more than one delivery (${target.refs.join(', ')}). Include the order number with your message.`) };
  }
  const order = await dbImpl('orders').where({ id: target.orderId }).first();
  let protection = await dbImpl('order_protection').where({ order_id: order.id }).first();
  const listing = order.listing_id ? await dbImpl('listings').where({ id: order.listing_id }).first() : null;
  const s = await loadProtectionSettings(dbImpl);
  const action = isButton ? buttonId.split(':')[1] : null;

  if (action === 'arrived') {
    await dbImpl('order_protection').where({ id: protection.id }).update({ deliverer_step: 'arrived', updated_at: dbImpl.fn.now() });
    await recordEvent(dbImpl, { orderId: order.id, actor: 'deliverer', kind: 'arrived', phone: toMsisdn(from) });
    return { handled: true, reply: both(`Oda ${order.order_ref}: mteja akague bidhaa kwanza. Kisha tuma (1) picha ya bidhaa mbele ya mteja na (2) namba ya makabidhiano aliyokupa. Unaweza pia kutuma location yako.`, `Order ${order.order_ref}: let the customer check the product first. Then send (1) a photo of the product with the customer and (2) the handover code they give you. You may also share your location.`) };
  }
  if (action === 'rejected') {
    await dbImpl('order_protection').where({ id: protection.id }).update({ deliverer_step: 'rejecting', rejection_json: JSON.stringify({}), updated_at: dbImpl.fn.now() });
    await recordEvent(dbImpl, { orderId: order.id, actor: 'deliverer', kind: 'rejection_started', phone: toMsisdn(from) });
    return { handled: true, reply: both(`Oda ${order.order_ref}: andika sababu ya mteja kukataa (au tuma sauti) na tuma picha ya bidhaa.`, `Order ${order.order_ref}: write why the customer refused (or send a voice note) and send a photo of the product.`) };
  }
  if (action === 'absent') {
    const n = protection.reschedules + 1;
    await dbImpl('order_protection').where({ id: protection.id }).update({ reschedules: n, deliverer_step: null, updated_at: dbImpl.fn.now() });
    await recordEvent(dbImpl, { orderId: order.id, actor: 'deliverer', kind: 'customer_absent', phone: toMsisdn(from), data: { attempt: n, location } });
    const customer = await dbImpl('customers').where({ id: order.customer_id }).first();
    if (n > s.maxReschedules) {
      await openDispute({ dbImpl, moran, muse, order, openedBy: 'deliverer', category: 'not_delivered', reason: `Customer not available ${n} times` });
      return { handled: true, reply: both('Imefika mara nyingi bila mteja; msimamizi wa MoranBuy atashughulikia.', 'Too many missed attempts; a MoranBuy administrator will handle it.') };
    }
    if (moran?.configured) await moran.sendText({ to: customer.channel_ref, body: say(customer.language, `Oda ${order.order_ref}: msafirishaji alifika lakini hakukupata. Mpigie +${toMsisdn(from)} kupanga muda mwingine.`, `Order ${order.order_ref}: the delivery person came but could not find you. Call +${toMsisdn(from)} to arrange another time.`), idempotencyKey: `moranbuy:absent:${order.id}:${n}` });
    return { handled: true, reply: both(`Sawa, tumemjulisha mteja (jaribio ${n} kati ya ${s.maxReschedules + 1}).`, `Noted; the customer has been told (attempt ${n} of ${s.maxReschedules + 1}).`) };
  }

  if (location?.lat !== undefined && location?.lng !== undefined) {
    const dest = order.customer_location_json;
    const km = dest?.lat !== undefined && dest?.lng !== undefined ? Math.round(haversineKm({ lat: Number(location.lat), lng: Number(location.lng) }, { lat: Number(dest.lat), lng: Number(dest.lng) }) * 100) / 100 : null;
    await recordEvent(dbImpl, { orderId: order.id, actor: 'deliverer', kind: 'location', phone: toMsisdn(from), data: { lat: Number(location.lat), lng: Number(location.lng), kmFromCustomer: km } });
    if (!imageBuffer && !text) return { handled: true, reply: both('Location imepokelewa.', 'Location received.') };
  }

  if (protection.deliverer_step === 'rejecting') {
    const rj = protection.rejection_json || {};
    if (imageBuffer) { const ph = await takePhoto({ dbImpl, muse, order, listing, from, imageBuffer, purpose: 'rejection_photo' }); rj.uploadId = ph.uploadId || null; }
    if (String(text || '').trim()) {
      const c = muse ? await museClassifyRejection(muse, { text, merchantId: order.merchant_id, requestRef: order.id }) : { category: 'other', summary: text, source: 'rules' };
      Object.assign(rj, { text: String(text).slice(0, 1000), category: c.category, summary: c.summary, source: c.source });
    }
    protection = (await dbImpl('order_protection').where({ id: protection.id }).update({ rejection_json: JSON.stringify(rj), updated_at: dbImpl.fn.now() }).returning('*'))[0];
    if (!rj.text) return { handled: true, reply: both('Picha imepokelewa. Sasa andika sababu ya kukataa.', 'Photo received. Now write the reason for the refusal.') };
    if (!rj.uploadId) return { handled: true, reply: both('Sababu imepokelewa. Sasa tuma picha ya bidhaa.', 'Reason received. Now send a photo of the product.') };
    await dbImpl('order_protection').where({ id: protection.id }).update({ state: 'rejection_pending', deliverer_step: null, updated_at: dbImpl.fn.now() });
    await recordEvent(dbImpl, { orderId: order.id, actor: 'deliverer', kind: 'rejected', phone: toMsisdn(from), uploadId: rj.uploadId, data: { category: rj.category, summary: rj.summary } });
    const customer = await dbImpl('customers').where({ id: order.customer_id }).first();
    if (moran?.configured) await moran.sendButtons({ to: customer.channel_ref, body: say(customer.language, `Oda ${order.order_ref}: msafirishaji amesema umekataa bidhaa kwa sababu: "${rj.summary || rj.text}". Je, ni kweli?`, `Order ${order.order_ref}: the delivery person says you refused the product because: "${rj.summary || rj.text}". Is that right?`), buttons: [{ id: `cust:rej_yes:${order.order_ref}`, title: say(customer.language, 'Ndio, nimekataa', 'Yes, I refused') }, { id: `cust:rej_no:${order.order_ref}`, title: say(customer.language, 'Hapana', 'No') }], idempotencyKey: `moranbuy:rej-confirm:${order.id}` });
    return { handled: true, reply: both('Tumemwomba mteja athibitishe. Rudisha bidhaa kwa muuzaji.', 'We asked the customer to confirm. Return the product to the business.') };
  }

  if (protection.deliverer_step === 'arrived') {
    if (imageBuffer) await takePhoto({ dbImpl, muse, order, listing, from, imageBuffer, purpose: 'photo' });
    const candidate = findCodeCandidate(text);
    if (candidate && !protection.code_ok) {
      if (codeMatches(order.id, candidate, protection.code_hash)) {
        protection = (await dbImpl('order_protection').where({ id: protection.id }).update({ code_ok: true, updated_at: dbImpl.fn.now() }).returning('*'))[0];
        await recordEvent(dbImpl, { orderId: order.id, actor: 'deliverer', kind: 'code_ok', phone: toMsisdn(from) });
      } else {
        const attempts = protection.code_attempts + 1;
        await dbImpl('order_protection').where({ id: protection.id }).update({ code_attempts: attempts, updated_at: dbImpl.fn.now() });
        await recordEvent(dbImpl, { orderId: order.id, actor: 'deliverer', kind: 'code_bad', phone: toMsisdn(from), data: { attempt: attempts } });
        if (attempts >= s.maxCodeAttempts) {
          await openDispute({ dbImpl, moran, muse, order, openedBy: 'system', category: 'code_lockout', reason: `${attempts} wrong handover codes` });
          return { handled: true, reply: both('Namba si sahihi mara nyingi. Oda imefungwa na msimamizi atashughulikia.', 'Too many wrong codes. The order is locked and an administrator will handle it.') };
        }
        return { handled: true, reply: both(`Namba si sahihi (jaribio ${attempts} kati ya ${s.maxCodeAttempts}). Mwombe mteja aisome tena.`, `Wrong code (attempt ${attempts} of ${s.maxCodeAttempts}). Ask the customer to read it again.`) };
      }
    }
    const photo = await hasEvent(dbImpl, order.id, 'photo');
    if (protection.code_ok && photo) {
      await completeDelivery({ dbImpl, moran, order });
      return { handled: true, reply: both(`Asante! Oda ${order.order_ref} imethibitishwa kufika.`, `Thank you! Order ${order.order_ref} is confirmed delivered.`) };
    }
    if (protection.code_ok) return { handled: true, reply: both('Namba ni sahihi. Sasa tuma picha ya bidhaa mbele ya mteja.', 'Code correct. Now send a photo of the product with the customer.') };
    if (photo) return { handled: true, reply: both('Picha imepokelewa. Sasa tuma namba ya makabidhiano kutoka kwa mteja.', 'Photo received. Now send the handover code from the customer.') };
    return { handled: true, reply: both('Tuma picha ya bidhaa na namba ya makabidhiano.', 'Send a photo of the product and the handover code.') };
  }
  if (imageBuffer || findCodeCandidate(text)) return { handled: true, reply: both(`Bonyeza "Nimefika" kwenye ujumbe wa oda ${order.order_ref} kwanza.`, `Tap "Arrived" on the order ${order.order_ref} message first.`) };
  return null;
}

const CUSTOMER = /^(lipa|pay|nimepokea|received|tatizo|problem|sijapokea|not received|risiti|receipt|oda zangu|my orders)\b\s*(MB-[A-Z0-9]{4,8})?\s*(.*)$/i;

// The customer's side: confirming a refusal, paying again, receiving, reporting a hidden defect, and getting receipts.
export async function handleCustomerProtectionMessage({ dbImpl = db, moran, payments, muse, customer, text = '', buttonId = null, photoUploadId = null }) {
  const l = customer.language === 'en' ? 'en' : 'sw';
  // A photo sent soon after the customer opened a dispute is evidence for it, not a new shopping search.
  if (photoUploadId) {
    const open = await dbImpl('disputes as d').join('orders as o', 'o.id', 'd.order_id').where({ 'o.customer_id': customer.id, 'd.status': 'open', 'd.opened_by': 'customer' }).where('d.created_at', '>=', new Date(Date.now() - 86400000)).orderBy('d.created_at', 'desc').first('d.id', 'o.id as order_id', 'o.order_ref');
    if (open) {
      await recordEvent(dbImpl, { orderId: open.order_id, actor: 'customer', kind: 'customer_photo', phone: customer.channel_ref, uploadId: photoUploadId });
      return { handled: true, reply: say(l, `Picha imeongezwa kwenye suala la oda ${open.order_ref}.`, `Photo added to the dispute on order ${open.order_ref}.`) };
    }
  }
  if (buttonId?.startsWith('rcpt:')) return sendReceiptFor({ dbImpl, moran, customer, ref: buttonId.slice(5), l });
  if (buttonId?.startsWith('cust:rej_')) {
    const [, kind, ref] = buttonId.split(':');
    const order = await orderByRef(dbImpl, ref);
    if (!order || order.customer_id !== customer.id) return { handled: true, reply: say(l, 'Oda haikupatikana.', 'Order not found.') };
    const protection = await dbImpl('order_protection').where({ order_id: order.id }).first();
    if (protection?.state !== 'rejection_pending') return { handled: true, reply: say(l, 'Hakuna kukataa kunakosubiri uthibitisho kwa oda hii.', 'There is no refusal waiting for confirmation on this order.') };
    if (kind === 'rej_yes') {
      await recordEvent(dbImpl, { orderId: order.id, actor: 'customer', kind: 'rejection_confirmed', phone: customer.channel_ref });
      const category = protection.rejection_json?.category || 'other';
      if (MERCHANT_FAULTS.includes(category)) await addStrike(dbImpl, { subjectType: 'merchant', subjectId: order.merchant_id, orderId: order.id, reason: category });
      await refundPayment({ dbImpl, moran, payments, order, why: `refused:${category}` });
      return { handled: true, reply: say(l, `Sawa. Pesa za oda ${order.order_ref} zinarudishwa kwenye namba yako.`, `Done. The money for order ${order.order_ref} is being refunded to your number.`) };
    }
    await recordEvent(dbImpl, { orderId: order.id, actor: 'customer', kind: 'rejection_denied', phone: customer.channel_ref });
    await openDispute({ dbImpl, moran, muse, order, openedBy: 'customer', category: 'rejection_contested', reason: 'Customer says they did not refuse' });
    return { handled: true, reply: null };
  }
  const m = String(text || '').trim().match(CUSTOMER);
  if (!m) return null;
  const word = m[1].toLowerCase();
  if (['oda zangu', 'my orders', 'risiti', 'receipt'].includes(word) && !m[2]) return listOrders({ dbImpl, moran, customer, l });
  const order = await orderByRef(dbImpl, m[2]);
  if (!order || order.customer_id !== customer.id) return { handled: true, reply: say(l, 'Taja namba ya oda yako, mfano NIMEPOKEA MB-7K2Q9P.', 'Include your order number, for example RECEIVED MB-7K2Q9P.') };
  const protection = await dbImpl('order_protection').where({ order_id: order.id }).first();
  if (['risiti', 'receipt'].includes(word)) return sendReceiptFor({ dbImpl, moran, customer, ref: order.order_ref, l });
  if (!protection) return { handled: true, reply: say(l, `Oda ${order.order_ref} hailindwi na MoranBuy; wasiliana na muuzaji.`, `Order ${order.order_ref} is not protected by MoranBuy; contact the business.`) };
  if (['lipa', 'pay'].includes(word)) {
    if (protection.state !== 'awaiting_payment') return { handled: true, reply: say(l, `Oda ${order.order_ref} haisubiri malipo.`, `Order ${order.order_ref} is not waiting for payment.`) };
    await requestPayment({ dbImpl, moran, payments, order, protection, customer });
    return { handled: true, reply: null };
  }
  if (['nimepokea', 'received'].includes(word)) {
    if (protection.state !== 'delivered') return { handled: true, reply: say(l, `Oda ${order.order_ref} bado haijathibitishwa kufika kwa namba ya makabidhiano.`, `Order ${order.order_ref} is not yet confirmed delivered with the handover code.`) };
    await recordEvent(dbImpl, { orderId: order.id, actor: 'customer', kind: 'customer_received', phone: customer.channel_ref });
    await releasePayment({ dbImpl, moran, payments, order, why: 'customer_confirmed' });
    return { handled: true, reply: say(l, `Asante! Muuzaji wa oda ${order.order_ref} analipwa sasa.`, `Thank you! The business is being paid for order ${order.order_ref}.`) };
  }
  if (['tatizo', 'problem'].includes(word)) {
    if (protection.state !== 'delivered') return { handled: true, reply: say(l, `Kwa oda ${order.order_ref}, usimpe msafirishaji namba kama bidhaa si sahihi; atarekodi kukataa.`, `For order ${order.order_ref}, do not give the code if the product is wrong; the delivery person records the refusal.`) };
    await openDispute({ dbImpl, moran, muse, order, openedBy: 'customer', category: 'hidden_defect', reason: m[3] || null });
    return { handled: true, reply: say(l, 'Tuma picha ya kasoro hapa kama unayo; msimamizi ataiona.', 'Send a photo of the defect here if you have one; the administrator will see it.') };
  }
  // "Not received" after a correct code is refused: the code is the proof of delivery.
  if (protection.code_ok) {
    await recordEvent(dbImpl, { orderId: order.id, actor: 'customer', kind: 'claim_refused', phone: customer.channel_ref, data: { claim: 'not_received' } });
    await addStrike(dbImpl, { subjectType: 'customer', subjectId: customer.id, orderId: order.id, reason: 'false_not_received' });
    return { handled: true, reply: say(l, `Oda ${order.order_ref} ilithibitishwa kufika kwa namba yako ya makabidhiano, kwa hiyo dai hili halikubaliki. Kama kuna tatizo jingine, jibu TATIZO ${order.order_ref}.`, `Order ${order.order_ref} was confirmed delivered with your handover code, so this claim cannot be accepted. For another problem, reply PROBLEM ${order.order_ref}.`) };
  }
  return { handled: true, reply: say(l, `Oda ${order.order_ref} bado haijafika; pesa yako inashikiliwa. Usitoe namba ya makabidhiano hadi upokee bidhaa sahihi.`, `Order ${order.order_ref} has not been delivered yet; your money is held. Do not give the handover code until you have the right product.`) };
}

async function sendReceiptFor({ dbImpl, moran, customer, ref, l }) {
  const order = await orderByRef(dbImpl, ref);
  if (!order || order.customer_id !== customer.id) return { handled: true, reply: say(l, 'Oda haikupatikana.', 'Order not found.') };
  const receipt = await latestReceipt(dbImpl, order.id);
  if (!receipt) return { handled: true, reply: say(l, `Oda ${order.order_ref} haina risiti bado (risiti hutolewa baada ya malipo).`, `Order ${order.order_ref} has no receipt yet (receipts come after payment).`) };
  await sendReceipt({ moran, to: customer.channel_ref, receipt, caption: say(l, `Risiti ya oda ${order.order_ref}`, `Receipt for order ${order.order_ref}`) });
  return { handled: true, reply: null };
}

const STATE_LABEL = { awaiting_payment: ['Inasubiri malipo', 'Awaiting payment'], paid_held: ['Imelipwa', 'Paid, held'], deliverer_assigned: ['Njiani', 'On the way'], delivered: ['Imefika', 'Delivered'], released: ['Imekamilika', 'Completed'], rejection_pending: ['Imekataliwa?', 'Refused?'], refund_pending: ['Inarejeshwa', 'Refunding'], refunded: ['Imerejeshwa', 'Refunded'], disputed: ['Suala', 'Disputed'], expired: ['Imeghairiwa', 'Cancelled'] };

// "Oda zangu": the last ten orders with receipts as a list; tapping one sends its receipt again.
async function listOrders({ dbImpl, moran, customer, l }) {
  const rows = await dbImpl('orders as o').join('order_protection as p', 'p.order_id', 'o.id').leftJoin('listings as li', 'li.id', 'o.listing_id').where('o.customer_id', customer.id).orderBy('o.created_at', 'desc').limit(10).select('o.order_ref', 'o.known_total', 'o.currency', 'p.state', 'li.name');
  if (!rows.length) return { handled: true, reply: say(l, 'Bado huna oda zilizolipwa kupitia MoranBuy.', 'You have no orders paid through MoranBuy yet.') };
  if (!moran?.configured) return { handled: true, reply: rows.map((r) => `${r.order_ref} · ${r.name || ''} · ${STATE_LABEL[r.state]?.[l === 'en' ? 1 : 0] || r.state}`).join('\n') };
  await moran.sendList({ to: customer.channel_ref, body: say(l, 'Oda zako. Chagua moja kupata risiti yake.', 'Your orders. Pick one to get its receipt.'), button: say(l, 'Oda zangu', 'My orders'), header: 'MoranBuy',
    sections: [{ title: say(l, 'Oda', 'Orders'), rows: rows.map((r) => ({ id: `rcpt:${r.order_ref}`, title: r.order_ref, description: `${(r.name || '').slice(0, 40)} · ${STATE_LABEL[r.state]?.[l === 'en' ? 1 : 0] || r.state}`.slice(0, 72) })) }], idempotencyKey: `moranbuy:orders:${customer.id}:${Date.now()}` });
  return { handled: true, reply: null };
}

const MERCHANT = /^(msafirishaji|deliverer|delivery)\s+(MB-[A-Z0-9]{4,8})\s+(\+?[\d\s-]{9,16})(?:\s+(.+))?$/i;

// "MSAFIRISHAJI MB-7K2Q9P 0712345678 Juma" from the business owner's own number names who delivers.
export async function handleMerchantProtectionMessage({ dbImpl = db, moran, from, text }) {
  const m = String(text || '').trim().match(MERCHANT);
  if (!m) return null;
  const order = await orderByRef(dbImpl, m[2]);
  if (!order) return { handled: true, reply: both(`Sijapata oda ${m[2]}.`, `Order ${m[2]} not found.`) };
  const merchant = await dbImpl('merchants').where({ id: order.merchant_id }).first();
  if (toMsisdn(merchant.contact_phone) !== toMsisdn(from)) return { handled: true, reply: both('Namba hii si ya muuzaji wa oda hii.', 'This number is not the business of this order.') };
  try {
    await assignDeliverer({ dbImpl, moran, order, phone: m[3], name: m[4] || null, actor: { type: 'merchant', via: 'whatsapp' } });
    return { handled: true, reply: both(`Sawa. Msafirishaji wa oda ${order.order_ref} amepewa maelekezo.`, `Done. The delivery person for order ${order.order_ref} has the instructions.`) };
  } catch (err) {
    logger.warn({ err: err.message }, 'Deliverer not assigned');
    return { handled: true, reply: `Oda ${order.order_ref}: ${err.message}` };
  }
}

// Whether a number is carrying a protected delivery now, so its voice notes and photos are read as delivery evidence first.
export async function isActiveDeliverer(dbImpl, from) {
  return !!(await dbImpl('order_protection').where({ deliverer_phone: toMsisdn(from), state: 'deliverer_assigned' }).first('id'));
}
