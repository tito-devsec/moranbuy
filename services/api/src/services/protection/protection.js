import { formatMoney } from '@moranbuy/core';
import { audit, logger } from '@moranbuy/observability';
import { startPayment } from '@moranbuy/billing';
import { toMsisdn, isValidMsisdn } from '@moranbuy/consent-management';
import { museSummarizeDispute } from '@moranbuy/muse-intelligence';
import { db } from '../../db/connection.js';
import { syncOrderStatusToMoran } from '../moran-order-sync.js';
import { generateCode, hashCode } from './codes.js';
import { issueReceipt, sendReceipt } from './receipts-store.js';

// Payment protection: the customer pays MoranBuy, the money is held, and fixed rules release it to the business or refund it; Muse only explains.
export const DEFAULT_PROTECTION = Object.freeze({
  enabled: true,
  commissionPercent: 0,     // MoranBuy's share of a released payment
  releaseAfterHours: 48,    // after a correct handover code, unless the customer reports a hidden defect
  paymentExpiryHours: 24,   // an unpaid protected order is cancelled after this
  assignDeadlineHours: 48,  // a paid order with no delivery person by then is refunded
  maxCodeAttempts: 3,
  maxReschedules: 2,
  strikeLimit: 3,           // strikes in 90 days before a person reviews first
  delivererTemplateName: '', // an APPROVED template on the MoranBuy number with three quick-reply buttons; blank: buttons inside 24 hours only
  delivererTemplateLanguage: 'sw',
});

export const ACTIVE_STATES = Object.freeze(['awaiting_payment', 'paid_held', 'deliverer_assigned', 'delivered', 'rejection_pending', 'refund_pending', 'disputed']);
export const MERCHANT_FAULTS = Object.freeze(['wrong_item', 'damaged', 'wrong_size_or_variant', 'not_ordered', 'no_deliverer', 'late']);

export async function loadProtectionSettings(dbImpl = db) {
  const row = await dbImpl('platform_settings').where({ key: 'payment_protection' }).first();
  return { ...DEFAULT_PROTECTION, ...(row?.value || {}) };
}

export async function recordEvent(dbImpl, { orderId, actor, kind, phone = null, uploadId = null, data = {} }) {
  await dbImpl('delivery_events').insert({ order_id: orderId, actor, kind, phone, upload_id: uploadId, data_json: JSON.stringify(data) });
}

const money = (n, cur = 'TZS') => formatMoney(n, cur);
const lang = (customer) => (customer?.language === 'en' ? 'en' : 'sw');
const say = (l, sw, en) => (l === 'en' ? en : sw);

async function context(dbImpl, orderId) {
  const order = await dbImpl('orders').where({ id: orderId }).first();
  const [protection, merchant, customer, listing] = await Promise.all([
    dbImpl('order_protection').where({ order_id: orderId }).first(), dbImpl('merchants').where({ id: order.merchant_id }).first(),
    dbImpl('customers').where({ id: order.customer_id }).first(), order.listing_id ? dbImpl('listings').where({ id: order.listing_id }).first() : null,
  ]);
  return { order, protection, merchant, customer, listing };
}

const productLabel = (order, listing) => `${listing?.name || 'bidhaa'}${order.variant ? ` (${order.variant})` : ''} x${order.quantity}`;

async function setState(dbImpl, protection, state, patch = {}) {
  const [row] = await dbImpl('order_protection').where({ id: protection.id }).update({ state, ...patch, updated_at: dbImpl.fn.now() }).returning('*');
  return row;
}

async function setOrderStatus(dbImpl, moran, order, status, why) {
  const [row] = await dbImpl('orders').where({ id: order.id }).update({ status, updated_at: dbImpl.fn.now() }).returning('*');
  await audit(dbImpl, { actorType: 'system', merchantId: order.merchant_id, action: 'order.status_changed', targetType: 'order', targetId: order.id, before: { status: order.status }, after: { status, via: why } });
  await syncOrderStatusToMoran({ dbImpl, moran, order: row }).catch(() => null);
  return row;
}

const text = (moran, to, body, key) => (moran?.configured && to ? moran.sendText({ to, body, idempotencyKey: key }) : Promise.resolve({ ok: false, status: 'not_sent' }));

// Whether this order is paid through MoranBuy: protection on, a WhatsApp customer (the payment prompt goes to that phone), and a known total.
export async function protectsOrder(dbImpl, order) {
  const s = await loadProtectionSettings(dbImpl);
  if (!s.enabled) return false;
  const customer = await dbImpl('customers').where({ id: order.customer_id }).first();
  return customer?.channel === 'whatsapp' && isValidMsisdn(customer.channel_ref);
}

// The business accepted with a known total: MoranBuy asks the customer to pay it and holds the money.
export async function startProtection({ dbImpl = db, moran, payments, order }) {
  const existing = await dbImpl('order_protection').where({ order_id: order.id }).first();
  if (existing) return existing;
  const { customer } = await context(dbImpl, order.id);
  const [protection] = await dbImpl('order_protection').insert({ order_id: order.id, state: 'awaiting_payment', amount: order.known_total, currency: order.currency }).returning('*');
  await recordEvent(dbImpl, { orderId: order.id, actor: 'system', kind: 'protection_started', data: { amount: order.known_total } });
  return requestPayment({ dbImpl, moran, payments, order, protection, customer });
}

export async function requestPayment({ dbImpl = db, moran, payments, order, protection, customer }) {
  const l = lang(customer);
  let payment = null;
  try {
    payment = await startPayment(dbImpl, payments, { merchantId: order.merchant_id, purpose: 'order', targetId: order.id, amount: order.known_total, currency: order.currency, phone: customer.channel_ref, breakdown: { orderRef: order.order_ref, protected: true } });
  } catch (err) {
    await recordEvent(dbImpl, { orderId: order.id, actor: 'system', kind: 'payment_not_started', data: { error: err.code || err.message } });
    await text(moran, customer.channel_ref, say(l, `Oda ${order.order_ref}: ombi la malipo halikutumwa sasa hivi. Jibu LIPA ${order.order_ref} kujaribu tena.`, `Order ${order.order_ref}: the payment request could not be sent just now. Reply PAY ${order.order_ref} to try again.`), `moranbuy:pay-failed:${order.id}:${Date.now()}`);
    return protection;
  }
  const row = await setState(dbImpl, protection, 'awaiting_payment', { payment_id: payment.id });
  await recordEvent(dbImpl, { orderId: order.id, actor: 'system', kind: 'payment_requested', data: { reference: payment.reference, provider: payment.provider } });
  await text(moran, customer.channel_ref, say(l,
    `Oda ${order.order_ref} imekubaliwa. Lipa ${money(order.known_total, order.currency)} kwa MoranBuy: ombi la malipo limetumwa kwenye simu yako (M-Pesa, Airtel Money, Mixx). Pesa yako itashikiliwa na MoranBuy hadi upokee bidhaa sahihi.`,
    `Order ${order.order_ref} was accepted. Pay ${money(order.known_total, order.currency)} to MoranBuy: a payment request was sent to your phone (M-Pesa, Airtel Money, Mixx). MoranBuy holds your money until you receive the right product.`), `moranbuy:pay-request:${payment.id}`);
  return row;
}

// A verified payment for a protected order: hold it, give the customer a receipt and a handover code, and ask the business who delivers.
export async function onOrderPaymentSettled({ dbImpl = db, moran, payment }) {
  if (payment?.purpose !== 'order') return null;
  const { order, protection, merchant, customer, listing } = await context(dbImpl, payment.target_id);
  if (!protection || protection.payment_id !== payment.id) return null;
  const l = lang(customer);
  if (payment.status !== 'completed') {
    if (protection.state === 'awaiting_payment') {
      await recordEvent(dbImpl, { orderId: order.id, actor: 'system', kind: 'payment_failed', data: { reference: payment.reference } });
      await text(moran, customer.channel_ref, say(l, `Malipo ya oda ${order.order_ref} hayakufanikiwa. Jibu LIPA ${order.order_ref} kujaribu tena.`, `Payment for order ${order.order_ref} did not go through. Reply PAY ${order.order_ref} to try again.`), `moranbuy:pay-failed:${payment.id}`);
    }
    return protection;
  }
  if (protection.state !== 'awaiting_payment') return protection;
  const code = generateCode();
  let row = await setState(dbImpl, protection, 'paid_held', { paid_at: dbImpl.fn.now(), code_hash: hashCode(order.id, code) });
  const paidOrder = await setOrderStatus(dbImpl, moran, order, 'paid', 'payment_protection');
  await recordEvent(dbImpl, { orderId: order.id, actor: 'system', kind: 'payment_held', data: { reference: payment.reference, amount: payment.amount } });
  const receipt = await issueReceipt({ dbImpl, order: paidOrder, status: 'PAID - HELD BY MORANBUY', statusNote: say(l, 'Mpe msafirishaji namba yako ya makabidhiano BAADA ya kukagua bidhaa.', 'Give the delivery person your handover code only after checking the product.') });
  await sendReceipt({ moran, to: customer.channel_ref, receipt, caption: say(l, `Risiti ya oda ${order.order_ref}`, `Receipt for order ${order.order_ref}`) });
  await text(moran, customer.channel_ref, say(l,
    `Malipo ${money(order.known_total, order.currency)} yamepokelewa na yanashikiliwa na MoranBuy.\nNamba yako ya makabidhiano: ${code}\nMpe msafirishaji namba hii BAADA ya kukagua bidhaa. Usiitume kwa mtu yeyote kabla ya hapo. Bidhaa ikiwa si sahihi, usitoe namba: utarudishiwa pesa.`,
    `Payment ${money(order.known_total, order.currency)} received and held by MoranBuy.\nYour handover code: ${code}\nGive it to the delivery person only AFTER checking the product. Do not send it to anyone before that. If the product is wrong, do not give the code: you will be refunded.`), `moranbuy:code:${order.id}`);
  // Pickup: the owner hands over at the shop, so the owner's own number is the one that confirms with the code.
  if (order.fulfilment !== 'delivery') {
    row = await assignDeliverer({ dbImpl, moran, order: paidOrder, phone: merchant.contact_phone, name: merchant.owner_name || merchant.business_name, actor: { type: 'system', via: 'pickup' } }).catch(() => row);
  } else {
    await text(moran, toMsisdn(merchant.contact_phone), `MoranBuy: oda ${order.order_ref} (${productLabel(order, listing)}) imelipwa ${money(order.known_total, order.currency)}; pesa inashikiliwa na MoranBuy hadi delivery ithibitishwe. Tuma namba ya msafirishaji: MSAFIRISHAJI ${order.order_ref} 07XXXXXXXX Jina\n/ Order ${order.order_ref} is paid and held. Send the delivery person's number: DELIVERER ${order.order_ref} 07XXXXXXXX Name`, `moranbuy:paid-merchant:${order.id}`);
  }
  return row;
}

const DELIVERER_BUTTONS = (ref) => [{ id: `dlv:arrived:${ref}`, title: 'Nimefika / Arrived' }, { id: `dlv:rejected:${ref}`, title: 'Imekataliwa' }, { id: `dlv:absent:${ref}`, title: 'Mteja hayupo' }];

// The business names who delivers; only that number may confirm this order with the customer's code.
export async function assignDeliverer({ dbImpl = db, moran, order, phone, name = null, actor }) {
  const { protection, merchant, customer, listing } = await context(dbImpl, order.id);
  if (!protection || !['paid_held', 'deliverer_assigned'].includes(protection.state)) throw Object.assign(new Error('This order is not paid and waiting for delivery.'), { status: 409, code: 'NOT_AWAITING_DELIVERY' });
  if (protection.deliverer_step) throw Object.assign(new Error('The delivery person is already at the customer.'), { status: 409, code: 'DELIVERY_IN_PROGRESS' });
  const to = toMsisdn(phone);
  if (!isValidMsisdn(to)) throw Object.assign(new Error('That phone number is not valid.'), { status: 400, code: 'BAD_PHONE' });
  const row = await setState(dbImpl, protection, 'deliverer_assigned', { deliverer_phone: to, deliverer_name: name ? String(name).slice(0, 120) : null, assigned_at: dbImpl.fn.now() });
  await recordEvent(dbImpl, { orderId: order.id, actor: actor.type === 'system' ? 'system' : 'merchant', kind: 'deliverer_assigned', phone: to, data: { name, via: actor.via } });
  const s = await loadProtectionSettings(dbImpl);
  const where = order.customer_location_json?.label || (order.fulfilment === 'delivery' ? 'eneo la mteja' : 'dukani (pickup)');
  const body = `MoranBuy: delivery ya oda ${order.order_ref} kutoka ${merchant.business_name}.\nBidhaa: ${productLabel(order, listing)}\nMahali: ${where}\nMteja: +${customer.channel_ref}\nUkifika, mteja akague bidhaa kwanza, kisha akupe namba ya makabidhiano. Bonyeza kitufe chini.\n/ Delivery of order ${order.order_ref}. At the customer, let them check the product, then they give you the handover code. Tap a button below.`;
  if (moran?.configured) {
    if (s.delivererTemplateName) {
      await moran.sendMoranBuyTemplate({ to, templateName: s.delivererTemplateName, language: s.delivererTemplateLanguage || 'sw', idempotencyKey: `moranbuy:deliverer:${order.id}:${to}`,
        components: [{ type: 'body', parameters: [order.order_ref, merchant.business_name, productLabel(order, listing), where, `+${customer.channel_ref}`].map((t) => ({ type: 'text', text: String(t) })) },
          ...DELIVERER_BUTTONS(order.order_ref).map((b, i) => ({ type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload: b.id }] }))] });
    } else {
      await moran.sendButtons({ to, body, buttons: DELIVERER_BUTTONS(order.order_ref), footer: 'MoranBuy Payment Protection', idempotencyKey: `moranbuy:deliverer:${order.id}:${to}` });
    }
  }
  const l = lang(customer);
  if (order.fulfilment === 'delivery') await text(moran, customer.channel_ref, say(l, `Oda ${order.order_ref}: msafirishaji ${name || ''} (+${to}) ataileta. Kagua bidhaa kwanza, kisha mpe namba yako ya makabidhiano.`, `Order ${order.order_ref}: ${name || 'the delivery person'} (+${to}) will deliver it. Check the product first, then give them your handover code.`), `moranbuy:assigned:${order.id}:${to}`);
  return row;
}

// The correct code and a photo: delivered. The payment is released after the hidden-defect window unless the customer reports one.
export async function completeDelivery({ dbImpl = db, moran, order }) {
  const { protection, merchant, customer } = await context(dbImpl, order.id);
  const s = await loadProtectionSettings(dbImpl);
  const due = new Date(Date.now() + s.releaseAfterHours * 3600000);
  const row = await setState(dbImpl, protection, 'delivered', { delivered_at: dbImpl.fn.now(), release_due_at: due, deliverer_step: null });
  const delivered = await setOrderStatus(dbImpl, moran, order, 'fulfilled', 'handover_code');
  await recordEvent(dbImpl, { orderId: order.id, actor: 'system', kind: 'delivered', data: { releaseDueAt: due.toISOString() } });
  const l = lang(customer);
  const receipt = await issueReceipt({ dbImpl, order: delivered, status: 'DELIVERED - HELD 48H', statusNote: say(l, `Malipo yatatolewa kwa muuzaji ${due.toISOString().slice(0, 16).replace('T', ' ')} UTC isipokuwa uripoti tatizo.`, `Payment goes to the business at ${due.toISOString().slice(0, 16).replace('T', ' ')} UTC unless you report a problem.`) });
  await sendReceipt({ moran, to: customer.channel_ref, receipt, caption: say(l, `Oda ${order.order_ref} imefikishwa`, `Order ${order.order_ref} delivered`) });
  await text(moran, customer.channel_ref, say(l,
    `Oda ${order.order_ref} imethibitishwa kufika. Ukigundua kasoro iliyofichika, jibu TATIZO ${order.order_ref} na maelezo ndani ya saa ${s.releaseAfterHours}. Kama kila kitu kiko sawa, jibu NIMEPOKEA ${order.order_ref} ili muuzaji alipwe sasa.`,
    `Order ${order.order_ref} is confirmed delivered. If you find a hidden defect, reply PROBLEM ${order.order_ref} with details within ${s.releaseAfterHours} hours. If all is well, reply RECEIVED ${order.order_ref} so the business is paid now.`), `moranbuy:delivered:${order.id}`);
  await text(moran, toMsisdn(merchant.contact_phone), `MoranBuy: oda ${order.order_ref} imethibitishwa kufika kwa namba ya mteja. Malipo yatatumwa kwako ndani ya saa ${s.releaseAfterHours} (au mapema mteja akithibitisha). / Order ${order.order_ref} confirmed delivered; payment is released within ${s.releaseAfterHours} hours.`, `moranbuy:delivered-merchant:${order.id}`);
  return row;
}

// Money out of MoranBuy's account, once per order and kind; a sandbox payout completes at once.
export async function sendPayout({ dbImpl = db, moran, payments, order, kind }) {
  const { protection, merchant, customer } = await context(dbImpl, order.id);
  const s = await loadProtectionSettings(dbImpl);
  const existing = await dbImpl('payouts').where({ order_id: order.id, kind }).first();
  if (existing && existing.status !== 'failed') return existing;
  const commission = kind === 'release' ? Math.round((protection.amount * Number(s.commissionPercent || 0)) / 100) : 0;
  const amount = protection.amount - commission;
  const phone = kind === 'release' ? toMsisdn(merchant.payout_phone || merchant.contact_phone) : customer.channel_ref;
  const name = kind === 'release' ? (merchant.owner_name || merchant.business_name) : (customer.name || 'MoranBuy customer');
  const base = { order_id: order.id, kind, amount, currency: protection.currency, phone, recipient_name: name, status: 'pending', provider: payments.name || 'sandbox' };
  const [row] = existing ? await dbImpl('payouts').where({ id: existing.id }).update({ ...base, error: null }).returning('*') : await dbImpl('payouts').insert(base).returning('*');
  await recordEvent(dbImpl, { orderId: order.id, actor: 'system', kind: `payout_${kind}_started`, data: { amount, commission } });
  try {
    const started = await payments.createPayout({ amount, currency: protection.currency, phone, name, narration: `MoranBuy ${order.order_ref} ${kind}`, metadata: { orderId: order.id, orderRef: order.order_ref, kind } });
    const [updated] = await dbImpl('payouts').where({ id: row.id }).update({ reference: started.reference, provider: payments.name || 'sandbox', fee: started.fee ?? null, provider_json: JSON.stringify(started.providerData || {}) }).returning('*');
    if (started.status === 'completed') return settlePayout({ dbImpl, moran, reference: started.reference, status: 'completed' });
    return updated;
  } catch (err) {
    await dbImpl('payouts').where({ id: row.id }).update({ status: 'failed', error: String(err.message).slice(0, 300) });
    await recordEvent(dbImpl, { orderId: order.id, actor: 'system', kind: `payout_${kind}_failed`, data: { error: err.code || err.message } });
    logger.warn({ orderId: order.id, kind, err: err.message }, 'Payout not started; an administrator can retry it');
    return { ...row, status: 'failed', error: err.message };
  }
}

// A payout result from Snippe's signed webhook (or the sandbox): the order closes only on a completed payout.
export async function settlePayout({ dbImpl = db, moran, reference, status }) {
  const payout = await dbImpl('payouts').where({ reference }).first();
  if (!payout) return { unknown: true };
  if (payout.status === 'completed' && status === 'completed') return payout;
  const [row] = await dbImpl('payouts').where({ id: payout.id }).update({ status, settled_at: dbImpl.fn.now() }).returning('*');
  await recordEvent(dbImpl, { orderId: payout.order_id, actor: 'system', kind: `payout_${payout.kind}_${status}`, data: { reference, amount: payout.amount } });
  if (status !== 'completed') return row;
  const { order, protection, merchant, customer } = await context(dbImpl, payout.order_id);
  const l = lang(customer);
  if (payout.kind === 'release') {
    await setState(dbImpl, protection, 'released', { closed_at: dbImpl.fn.now() });
    await issueReceipt({ dbImpl, order, status: 'COMPLETED - PAID TO BUSINESS' });
    await text(moran, toMsisdn(merchant.contact_phone), `MoranBuy: ${money(payout.amount, payout.currency)} za oda ${order.order_ref} zimetumwa kwa +${payout.phone}. Asante! / ${money(payout.amount, payout.currency)} for order ${order.order_ref} was sent to +${payout.phone}.`, `moranbuy:released:${order.id}`);
  } else {
    await setState(dbImpl, protection, 'refunded', { closed_at: dbImpl.fn.now() });
    const cancelled = await setOrderStatus(dbImpl, moran, order, 'cancelled', 'refund');
    const receipt = await issueReceipt({ dbImpl, order: cancelled, status: 'REFUNDED TO CUSTOMER' });
    await sendReceipt({ moran, to: customer.channel_ref, receipt, caption: say(l, `Marejesho ya oda ${order.order_ref}`, `Refund for order ${order.order_ref}`) });
    await text(moran, customer.channel_ref, say(l, `${money(payout.amount, payout.currency)} za oda ${order.order_ref} zimerudishwa kwenye namba yako.`, `${money(payout.amount, payout.currency)} for order ${order.order_ref} was refunded to your number.`), `moranbuy:refunded:${order.id}`);
  }
  return row;
}

export async function releasePayment({ dbImpl = db, moran, payments, order, why }) {
  await recordEvent(dbImpl, { orderId: order.id, actor: 'system', kind: 'release_decided', data: { why } });
  return sendPayout({ dbImpl, moran, payments, order, kind: 'release' });
}

export async function refundPayment({ dbImpl = db, moran, payments, order, why }) {
  const { protection } = await context(dbImpl, order.id);
  await setState(dbImpl, protection, 'refund_pending');
  await recordEvent(dbImpl, { orderId: order.id, actor: 'system', kind: 'refund_decided', data: { why } });
  return sendPayout({ dbImpl, moran, payments, order, kind: 'refund' });
}

export async function addStrike(dbImpl, { subjectType, subjectId, orderId, reason }) {
  await dbImpl('strikes').insert({ subject_type: subjectType, subject_id: subjectId, order_id: orderId, reason });
  const n = await dbImpl('strikes').where({ subject_type: subjectType, subject_id: subjectId }).where('created_at', '>=', new Date(Date.now() - 90 * 86400000)).count('id as n').first();
  return Number(n.n);
}

// A dispute holds the money until an administrator decides; Muse writes a summary of the evidence for them, never the decision.
export async function openDispute({ dbImpl = db, moran, muse = null, order, openedBy, category, reason = null }) {
  const { protection, merchant, customer } = await context(dbImpl, order.id);
  const open = await dbImpl('disputes').where({ order_id: order.id, status: 'open' }).first();
  if (open) return open;
  await setState(dbImpl, protection, 'disputed', { deliverer_step: null });
  const [dispute] = await dbImpl('disputes').insert({ order_id: order.id, opened_by: openedBy, category, reason }).returning('*');
  await recordEvent(dbImpl, { orderId: order.id, actor: openedBy, kind: 'dispute_opened', data: { category, reason } });
  if (muse) await summarizeDispute({ dbImpl, muse, disputeId: dispute.id }).catch(() => null);
  const l = lang(customer);
  await text(moran, customer.channel_ref, say(l, `Oda ${order.order_ref}: suala limefunguliwa na pesa inaendelea kushikiliwa. Msimamizi wa MoranBuy atapitia ushahidi na kukujulisha uamuzi.`, `Order ${order.order_ref}: a dispute is open and the money stays held. A MoranBuy administrator will review the evidence and tell you the decision.`), `moranbuy:dispute:${dispute.id}:customer`);
  await text(moran, toMsisdn(merchant.contact_phone), `MoranBuy: oda ${order.order_ref} ina suala (${category}); malipo yanashikiliwa hadi msimamizi aamue. / Order ${order.order_ref} is disputed (${category}); payment is held until an administrator decides.`, `moranbuy:dispute:${dispute.id}:merchant`);
  return dispute;
}

export async function summarizeDispute({ dbImpl = db, muse, disputeId }) {
  const dispute = await dbImpl('disputes').where({ id: disputeId }).first();
  const order = await dbImpl('orders').where({ id: dispute.order_id }).first('order_ref', 'quantity', 'unit_price', 'known_total', 'fulfilment', 'merchant_id');
  const timeline = (await dbImpl('delivery_events').where({ order_id: dispute.order_id }).orderBy('id')).map((e) => ({ at: e.created_at, actor: e.actor, kind: e.kind, data: e.data_json }));
  const r = await museSummarizeDispute(muse, { order: { ...order, category: dispute.category, reason: dispute.reason }, timeline, merchantId: order.merchant_id, requestRef: dispute.id });
  if (r.ok) await dbImpl('disputes').where({ id: disputeId }).update({ muse_json: JSON.stringify({ summary: r.summary, suggestion: r.suggestion, why: r.why, at: new Date().toISOString() }) });
  return r;
}

// An administrator's decision; audited, and the only way a disputed payment moves.
export async function resolveDispute({ dbImpl = db, moran, payments, disputeId, decision, note, admin }) {
  const dispute = await dbImpl('disputes').where({ id: disputeId }).first();
  if (!dispute || dispute.status !== 'open') throw Object.assign(new Error('This dispute is not open.'), { status: 409, code: 'NOT_OPEN' });
  const order = await dbImpl('orders').where({ id: dispute.order_id }).first();
  await dbImpl('disputes').where({ id: disputeId }).update({ status: decision === 'release' ? 'released' : 'refunded', resolved_by: admin.id, resolution_note: note, resolved_at: dbImpl.fn.now() });
  await recordEvent(dbImpl, { orderId: order.id, actor: 'admin', kind: 'dispute_resolved', data: { decision, note, admin: admin.email } });
  await audit(dbImpl, { actorType: 'admin', actorId: admin.id, merchantId: order.merchant_id, action: 'dispute.resolved', targetType: 'order', targetId: order.id, after: { decision, note } });
  return decision === 'release' ? releasePayment({ dbImpl, moran, payments, order, why: 'admin_decision' }) : refundPayment({ dbImpl, moran, payments, order, why: 'admin_decision' });
}

// The timed rules: release after the window, cancel unpaid orders, refund paid orders nobody is delivering.
export async function runProtectionSweep({ dbImpl = db, moran, payments, now = new Date() }) {
  const s = await loadProtectionSettings(dbImpl);
  const out = { released: 0, expired: 0, refundedNoDeliverer: 0 };
  const due = await dbImpl('order_protection as p').where('p.state', 'delivered').where('p.release_due_at', '<=', now)
    .whereNotExists(dbImpl('disputes as d').select(dbImpl.raw('1')).whereRaw('d.order_id = p.order_id').where('d.status', 'open')).select('p.order_id');
  for (const { order_id: id } of due) { await releasePayment({ dbImpl, moran, payments, order: await dbImpl('orders').where({ id }).first(), why: 'window_passed' }); out.released += 1; }
  const unpaid = await dbImpl('order_protection').where({ state: 'awaiting_payment' }).where('created_at', '<=', new Date(now - s.paymentExpiryHours * 3600000));
  for (const p of unpaid) {
    const { order, customer } = await context(dbImpl, p.order_id);
    await setState(dbImpl, p, 'expired', { closed_at: dbImpl.fn.now() });
    await setOrderStatus(dbImpl, moran, order, 'cancelled', 'unpaid');
    await recordEvent(dbImpl, { orderId: order.id, actor: 'system', kind: 'expired_unpaid' });
    await text(moran, customer.channel_ref, say(lang(customer), `Oda ${order.order_ref} imeghairiwa kwa kuwa haikulipwa ndani ya saa ${s.paymentExpiryHours}.`, `Order ${order.order_ref} was cancelled because it was not paid within ${s.paymentExpiryHours} hours.`), `moranbuy:expired:${order.id}`);
    out.expired += 1;
  }
  const stuck = await dbImpl('order_protection').where({ state: 'paid_held' }).where('paid_at', '<=', new Date(now - s.assignDeadlineHours * 3600000));
  for (const p of stuck) {
    const order = await dbImpl('orders').where({ id: p.order_id }).first();
    await addStrike(dbImpl, { subjectType: 'merchant', subjectId: order.merchant_id, orderId: order.id, reason: 'no_deliverer' });
    await refundPayment({ dbImpl, moran, payments, order, why: 'no_deliverer' });
    out.refundedNoDeliverer += 1;
  }
  return out;
}
