import { formatMoney } from '@moranbuy/core';
import { audit } from '@moranbuy/observability';
import { toMsisdn } from '@moranbuy/consent-management';
import { db } from '../db/connection.js';

const NEXT = { accepted: ['pending_merchant'], rejected: ['pending_merchant', 'accepted'], fulfilled: ['accepted', 'paid'], cancelled: ['pending_merchant', 'accepted'] };

// Moves an order forward (merchant dashboard or a WhatsApp reply from the merchant), audits it, and tells the customer.
export async function applyOrderStatus({ dbImpl = db, moran, order, status, deliveryFee = null, note = null, actor }) {
  if (!NEXT[status]?.includes(order.status)) throw Object.assign(new Error(`An order that is ${order.status} cannot become ${status}.`), { code: 'BAD_TRANSITION', status: 409 });
  const patch = { status, notes: note || order.notes, updated_at: dbImpl.fn.now() };
  if (deliveryFee !== null && deliveryFee !== undefined && !order.total_confirmed) { patch.delivery_fee = deliveryFee; patch.known_total = order.unit_price * order.quantity + deliveryFee; patch.total_confirmed = true; }
  const [row] = await dbImpl('orders').where({ id: order.id }).update(patch).returning('*');
  await audit(dbImpl, { actorType: actor.type, actorId: actor.id || null, merchantId: order.merchant_id, action: 'order.status_changed', targetType: 'order', targetId: order.id, before: { status: order.status }, after: { status, deliveryFee: patch.delivery_fee ?? null, via: actor.via } });
  const customerAlert = await notifyCustomerOfOrderStatus({ dbImpl, moran, order: row });
  return { order: row, customerAlert };
}

// Tells a WhatsApp customer what the merchant decided, from the MoranBuy number; web customers read the status page.
export async function notifyCustomerOfOrderStatus({ dbImpl = db, moran, order }) {
  const customer = await dbImpl('customers').where({ id: order.customer_id }).first();
  const merchant = await dbImpl('merchants').where({ id: order.merchant_id }).first();
  if (!customer || customer.channel !== 'whatsapp') return { skipped: 'not_whatsapp' };
  const lang = customer.language === 'en' ? 'en' : 'sw';
  const total = formatMoney(order.known_total, order.currency);
  const text = {
    accepted: lang === 'en' ? `Order ${order.order_ref}: ${merchant.business_name} accepted it. Total ${total}${order.total_confirmed ? '' : ' (delivery fee still to be agreed)'}. The merchant will contact you about payment and ${order.fulfilment}.` : `Oda ${order.order_ref}: ${merchant.business_name} imeikubali. Jumla ${total}${order.total_confirmed ? '' : ' (ada ya delivery bado itakubaliwa)'}. Muuzaji atawasiliana nawe kuhusu malipo na ${order.fulfilment}.`,
    rejected: lang === 'en' ? `Order ${order.order_ref}: ${merchant.business_name} could not take this order. Tell me what you need and I will look again.` : `Oda ${order.order_ref}: ${merchant.business_name} haikuweza kuchukua oda hii. Niambie unachohitaji nitafute tena.`,
    fulfilled: lang === 'en' ? `Order ${order.order_ref} is marked delivered by ${merchant.business_name}. Thank you for using MoranBuy.` : `Oda ${order.order_ref} imekamilika kwa mujibu wa ${merchant.business_name}. Asante kwa kutumia MoranBuy.`,
    cancelled: lang === 'en' ? `Order ${order.order_ref} was cancelled.` : `Oda ${order.order_ref} imeghairiwa.`,
  }[order.status];
  if (!text || !moran?.configured) return { skipped: text ? 'moran_not_configured' : 'no_text' };
  const r = await moran.sendText({ to: customer.channel_ref, body: text, idempotencyKey: `moranbuy:order:${order.id}:${order.status}` });
  await dbImpl('session_messages').insert({ session_id: order.session_id, direction: 'out', content: text }).catch(() => {});
  return { sent: r.ok, status: r.status };
}

const COMMAND = /^(kubali|accept|kataa|reject|nimetuma|delivered|ghairi|cancel)\s+(MB-[A-Z0-9]{4,8})(?:\s+(\d[\d,]*))?\s*$/i;
const STATUS_OF = { kubali: 'accepted', accept: 'accepted', kataa: 'rejected', reject: 'rejected', nimetuma: 'fulfilled', delivered: 'fulfilled', ghairi: 'cancelled', cancel: 'cancelled' };

// A business owner answering an order alert by WhatsApp: "KUBALI MB-7K2P9Q 15000" accepts with a delivery fee; only the merchant's own number may do it.
export async function handleMerchantOrderReply({ dbImpl = db, moran, from, text }) {
  const m = String(text || '').trim().match(COMMAND);
  if (!m) return null;
  const ref = m[2].toUpperCase();
  const order = await dbImpl('orders').where({ order_ref: ref }).first();
  if (!order) return { handled: true, reply: `Sijapata oda ${ref}. / Order ${ref} not found.` };
  const merchant = await dbImpl('merchants').where({ id: order.merchant_id }).first();
  if (!merchant || toMsisdn(merchant.contact_phone) !== toMsisdn(from)) return { handled: true, reply: `Namba hii haijasajiliwa kwa muuzaji wa oda ${ref}. / This number is not the merchant of order ${ref}.` };
  const status = STATUS_OF[m[1].toLowerCase()];
  const fee = m[3] ? Number(m[3].replace(/,/g, '')) : null;
  try {
    const out = await applyOrderStatus({ dbImpl, moran, order, status, deliveryFee: fee, actor: { type: 'merchant', id: null, via: 'whatsapp_reply' } });
    const total = formatMoney(out.order.known_total, out.order.currency);
    return { handled: true, order: out.order, reply: `Sawa. Oda ${ref} sasa: ${status}${fee !== null ? `, delivery ${formatMoney(fee, out.order.currency)}` : ''}, jumla ${total}. Mteja amejulishwa. / Order ${ref} is now ${status}; the customer has been told.` };
  } catch (err) {
    return { handled: true, reply: `Oda ${ref}: ${err.message}` };
  }
}
