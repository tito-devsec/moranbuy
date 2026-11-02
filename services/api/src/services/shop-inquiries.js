import crypto from 'node:crypto';
import { audit } from '@moranbuy/observability';
import { toMsisdn } from '@moranbuy/consent-management';
import { formatMoney } from '@moranbuy/core';
import { db } from '../db/connection.js';

// A customer asked MoranBuy to check with an online shop or a shop on the map. The shop's number stays in this table; nothing here is ever sent to a customer.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newRef = () => Array.from(crypto.randomBytes(5), (b) => ALPHABET[b % ALPHABET.length]).join('');

export async function createShopInquiry({ session, customer, request, target, dbImpl = db }) {
  const ref = newRef();
  const phone = toMsisdn(target.contact || '');
  await dbImpl('shop_inquiries').insert({
    ref, session_id: session.id, customer_id: customer.id, source: target.kind === 'shop' ? 'nearby' : 'web', shop_name: String(target.merchant || 'Shop').slice(0, 200), shop_phone: phone || null, shop_area: target.area ? String(target.area).slice(0, 200) : null,
    product_name: target.name || request.productType || null, price: target.price || null, currency: request.currency || 'TZS', image_url: target.imageUrl || null, request_json: JSON.stringify(request),
  });
  await audit(dbImpl, { actorType: 'system', action: 'shop_inquiry.created', targetType: 'session', targetId: session.id, after: { ref, source: target.kind || 'web' } }).catch(() => null);
  return { ref };
}

export const listShopInquiries = ({ status = 'new', limit = 50, dbImpl = db } = {}) =>
  dbImpl('shop_inquiries as q').join('customers as c', 'c.id', 'q.customer_id').where(status === 'all' ? {} : { 'q.status': status }).orderBy('q.created_at', 'desc').limit(limit)
    .select('q.ref', 'q.status', 'q.source', 'q.shop_name', 'q.shop_phone', 'q.shop_area', 'q.product_name', 'q.price', 'q.currency', 'q.created_at', 'q.answered_at', 'q.note', 'c.channel_ref as customer_phone');

// What was found out from the shop is told to the customer in their language; the shop's number is never part of it.
export async function answerShopInquiry({ moran, ref, available, price = null, note = null, dbImpl = db }) {
  const q = await dbImpl('shop_inquiries').where({ ref: String(ref).toUpperCase() }).first();
  if (!q) return { ok: false, reason: 'not_found' };
  if (q.status !== 'new') return { ok: false, reason: 'already_answered', status: q.status };
  const customer = await dbImpl('customers').where({ id: q.customer_id }).first();
  const en = customer?.language === 'en';
  const money = price ? formatMoney(Number(price), q.currency) : null;
  const text = available
    ? (en ? `Good news: ${q.shop_name} confirmed that ${q.product_name} is in stock${money ? ` at ${money}` : ''}.${note ? ` ${note}` : ''}` : `Habari njema: ${q.shop_name} imethibitisha kuwa ${q.product_name} ipo${money ? ` kwa ${money}` : ''}.${note ? ` ${note}` : ''}`)
    : (en ? `Sorry, ${q.shop_name} said ${q.product_name} is not available right now.${note ? ` ${note}` : ''} Pick another option or ask me to search again.` : `Samahani, ${q.shop_name} imesema ${q.product_name} haipo kwa sasa.${note ? ` ${note}` : ''} Chagua chaguo lingine au niambie nitafute tena.`);
  const sent = await moran.sendText({ to: customer.channel_ref, body: text, idempotencyKey: `moranbuy:shop-inquiry:${q.ref}` });
  await dbImpl('shop_inquiries').where({ id: q.id }).update({ status: sent.ok ? (available ? 'available' : 'unavailable') : 'new', note: note || q.note, answered_at: sent.ok ? dbImpl.fn.now() : null, price: price ? Math.round(Number(price)) : q.price });
  await audit(dbImpl, { actorType: 'system', action: 'shop_inquiry.answered', targetType: 'shop_inquiry', targetId: q.id, after: { ref: q.ref, available, sent: sent.ok } }).catch(() => null);
  return { ok: sent.ok, reason: sent.ok ? null : 'send_failed' };
}
