import { formatMoney } from '@moranbuy/core';
import { toMsisdn, isValidMsisdn } from '@moranbuy/consent-management';
import { logger } from '@moranbuy/observability';
import { db } from '../db/connection.js';

// The wording and the approved Meta template for "order confirmed", edited in Super Admin → MoranBuy → Notifications.
export const DEFAULT_ORDER_ALERT = Object.freeze({
  enabled: true,
  templateName: '',        // an APPROVED template on the MoranBuy number, e.g. moranbuy_order_alert; blank: text only (works inside a 24-hour window)
  templateLanguage: 'sw',
  // Placeholders: {order_ref} {product} {quantity} {total} {fulfilment} {customer_phone} {customer_location} {merchant} {reply_hint}
  textSw: 'MoranBuy: oda mpya {order_ref}. {product} x{quantity}, {total}, {fulfilment}. Mteja: {customer_phone}{customer_location}. {reply_hint}',
  textEn: 'MoranBuy: new order {order_ref}. {product} x{quantity}, {total}, {fulfilment}. Customer: {customer_phone}{customer_location}. {reply_hint}',
  // The order of template body parameters {{1}}..{{n}}, by placeholder name.
  templateParams: ['order_ref', 'product', 'quantity', 'total', 'fulfilment', 'customer_phone'],
});

export async function loadOrderAlertSettings(dbImpl = db) {
  const row = await dbImpl('platform_settings').where({ key: 'notification_order_confirmed' }).first();
  return { ...DEFAULT_ORDER_ALERT, ...(row?.value || {}) };
}

// Fills placeholders from the order facts only; unknown totals are said to be unconfirmed.
export function renderOrderAlert(text, facts) {
  return String(text).replace(/\{(\w+)\}/g, (_m, k) => (facts[k] === undefined || facts[k] === null ? '' : String(facts[k])));
}

export function orderAlertFacts({ order, listing, merchant, customer, language = 'sw', hasDashboard = false }) {
  const sw = language !== 'en';
  // A business without a MoranBuy login manages the order by replying; a registered one may also use the dashboard.
  const feeHint = order.total_confirmed ? '' : (sw ? ` (ongeza ada ya delivery, mfano KUBALI ${order.order_ref} 15000)` : ` (add the delivery fee, e.g. ACCEPT ${order.order_ref} 15000)`);
  const replyHint = sw ? `Jibu KUBALI ${order.order_ref}${feeHint} au KATAA ${order.order_ref}.${hasDashboard ? ' Au fungua MoranBuy.' : ''}` : `Reply ACCEPT ${order.order_ref}${feeHint} or REJECT ${order.order_ref}.${hasDashboard ? ' Or open MoranBuy.' : ''}`;
  const total = order.total_confirmed ? formatMoney(order.known_total, order.currency) : `${formatMoney(order.known_total, order.currency)} (${sw ? 'delivery haijathibitishwa' : 'delivery not confirmed'})`;
  const loc = order.customer_location_json?.label ? `, ${order.customer_location_json.label}` : '';
  return {
    order_ref: order.order_ref, product: listing?.name ? `${listing.name}${order.variant ? ` (${order.variant})` : ''}` : (sw ? 'bidhaa' : 'product'), quantity: order.quantity, total,
    fulfilment: order.fulfilment === 'delivery' ? 'delivery' : (sw ? 'pickup (mteja atachukua)' : 'pickup'),
    customer_phone: customer?.channel === 'whatsapp' ? `+${customer.channel_ref}` : (sw ? 'mteja wa tovuti' : 'web customer'),
    customer_location: loc, merchant: merchant.business_name, reply_hint: replyHint,
  };
}

// Sends the order alert to the business owner's WhatsApp from the MoranBuy number; the outcome, whatever it is, is recorded once per order.
export async function notifyMerchantOfOrder({ dbImpl = db, moran, order, dryRun = false }) {
  const key = `order_confirmed:${order.id}`;
  if (await dbImpl('merchant_notifications').where({ idempotency_key: key }).first()) return { duplicate: true };
  const [merchant, listing, customer, settings] = await Promise.all([
    dbImpl('merchants').where({ id: order.merchant_id }).first(), order.listing_id ? dbImpl('listings').where({ id: order.listing_id }).first() : null,
    dbImpl('customers').where({ id: order.customer_id }).first(), loadOrderAlertSettings(dbImpl),
  ]);
  const record = async (row) => { const [r] = await dbImpl('merchant_notifications').insert({ merchant_id: order.merchant_id, event: 'order_confirmed', target_type: 'order', target_id: order.id, channel: 'whatsapp', idempotency_key: key, ...row }).returning('*'); return r; };
  if (!settings.enabled) return record({ kind: 'text', status: 'skipped', skip_reason: 'disabled' });
  const to = toMsisdn(merchant.contact_phone);
  if (!isValidMsisdn(to)) return record({ kind: 'text', status: 'skipped', skip_reason: 'merchant_has_no_phone' });
  const language = merchant.settings_json?.language === 'en' ? 'en' : 'sw';
  const hasDashboard = !!(await dbImpl('merchant_users').where({ merchant_id: merchant.id, is_active: true }).first('id'));
  const facts = orderAlertFacts({ order, listing, merchant, customer, language, hasDashboard });
  const body = renderOrderAlert(language === 'en' ? settings.textEn : settings.textSw, facts);
  const useTemplate = !!settings.templateName;
  const params = useTemplate ? (settings.templateParams || []).map((k) => ({ type: 'text', text: String(facts[k] ?? '') })) : [];
  if (dryRun) return record({ kind: useTemplate ? 'template' : 'text', to_phone: to, template_name: settings.templateName || null, body, status: 'dry_run' });
  if (!moran?.configured) return record({ kind: useTemplate ? 'template' : 'text', to_phone: to, body, status: 'failed', error: 'moran_not_configured' });
  const r = useTemplate
    ? await moran.sendMoranBuyTemplate({ to, templateName: settings.templateName, language: settings.templateLanguage || 'sw', components: params.length ? [{ type: 'body', parameters: params }] : [], idempotencyKey: `moranbuy:${key}` })
    : await moran.sendText({ to, body, idempotencyKey: `moranbuy:${key}` });
  if (!r.ok) logger.warn({ orderId: order.id, status: r.status }, 'Merchant order alert not delivered');
  return record({ kind: useTemplate ? 'template' : 'text', to_phone: to, template_name: settings.templateName || null, body, status: r.ok ? 'sent' : 'failed', provider_message_id: r.data?.messageId || null, error: r.ok ? null : (r.data?.error || r.status) });
}
