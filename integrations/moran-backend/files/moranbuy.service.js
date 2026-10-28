/*
 * MoranBuy integration (github.com/tito-devsec/moranbuy, docs/moranbuy.md).
 *
 * MoranBuy is one admin-managed business inside Moran: Super Admin registers it, connects its
 * WhatsApp number like any other business, and writes its knowledge. Customer messages to that
 * number are forwarded to the MoranBuy service, which answers through this backend's own
 * outbound gate. Businesses that switch "List my products on MoranBuy" on let MoranBuy read their
 * active products. Every call between the two systems is signed with MORANBUY_SHARED_SECRET.
 */

import crypto from 'crypto';
import { db } from '../db/connection.js';
import { config } from '../config/index.js';
import { logger as baseLogger } from '../utils/logger.js';
import { unusablePasswordHash } from './auth.service.js';
import { sendWhatsAppText, sendWhatsAppImage, sendTemplateMessage, sendWhatsAppButtons } from './whatsapp-sender.service.js';
import { searchKnowledge } from '../core/knowledge-search.js';
import { audit } from './admin/audit.js';

const logger = baseLogger.child({ service: 'moranbuy' });

export const MORANBUY_WORKSPACE = 'moranbuy';

/** HMAC-SHA256 over `${timestamp}.${rawBody}`, the same scheme as the payment webhook. */
export function signMoranBuy(rawBody, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = crypto.createHmac('sha256', config.moranbuy.sharedSecret).update(`${timestamp}.${rawBody}`).digest('hex');
  return { timestamp: String(timestamp), signature };
}

/** Constant-time check of a signed MoranBuy request; five-minute replay window. */
export function verifyMoranBuySignature(rawBody, timestamp, signature) {
  const secret = config.moranbuy.sharedSecret;
  if (!secret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const a = Buffer.from(String(signature));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** The one MoranBuy tenant, or null. */
export function moranBuyTenant() {
  return db('tenants').where({ workspace_type: MORANBUY_WORKSPACE }).first();
}

/** Super Admin registers MoranBuy once: an admin-managed account with no usable owner password. */
export async function registerMoranBuyTenant({ businessName = 'MoranBuy', ownerEmail, reason = null, req = null }) {
  const existing = await moranBuyTenant();
  if (existing) throw Object.assign(new Error('MORANBUY_EXISTS'), { code: 'MORANBUY_EXISTS', status: 409, message: 'MoranBuy is already registered.' });
  const [tenant] = await db('tenants').insert({
    business_name: businessName, industry: 'marketplace', owner_name: 'MoranBuy (admin managed)', owner_email: ownerEmail,
    owner_password_hash: await unusablePasswordHash(), workspace_type: MORANBUY_WORKSPACE, admin_managed: true, status: 'active', email_verified: true,
  }).returning('*');
  await audit(db, req, { action: 'moranbuy.registered', targetType: 'tenant', targetId: tenant.id, tenantId: tenant.id, after: { businessName, ownerEmail }, reason });
  logger.info({ tenantId: tenant.id }, 'MoranBuy business registered');
  return tenant;
}

/** True when this inbound message belongs to the MoranBuy business and must be forwarded. */
export const isMoranBuyTenant = (tenant) => tenant?.workspace_type === MORANBUY_WORKSPACE;

/** Forwards one customer message to MoranBuy, which answers through /internal/moranbuy/send; a failure is logged. */
export async function forwardInboundToMoranBuy({ tenant, message, inbound, customerNumber, profileName = null }) {
  const base = config.moranbuy.apiUrl;
  if (!base || !config.moranbuy.sharedSecret) {
    logger.error('MORANBUY_API_URL or MORANBUY_SHARED_SECRET is not set; MoranBuy message dropped');
    return { ok: false, status: 'not_configured' };
  }
  const payload = {
    messageId: message.id, from: customerNumber, name: profileName,
    text: inbound?.text || '', imageUrl: inbound?.imageUrl || null, buttonId: inbound?.replyId || null, kind: inbound?.kind || message.type || 'text',
    location: message.type === 'location' && message.location ? { lat: message.location.latitude, lng: message.location.longitude, label: message.location.name || message.location.address || null } : null,
    tenantId: tenant.id,
  };
  const raw = JSON.stringify(payload);
  const { timestamp, signature } = signMoranBuy(raw);
  try {
    const res = await fetch(`${String(base).replace(/\/+$/, '')}/internal/inbound`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MoranBuy-Timestamp': timestamp, 'X-MoranBuy-Signature': signature }, body: raw, signal: AbortSignal.timeout(20000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) logger.warn({ status: res.status, data }, 'MoranBuy did not accept the forwarded message');
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    logger.error({ err: err.message }, 'Forwarding to MoranBuy failed');
    return { ok: false, status: 'network' };
  }
}

/** A reply from the MoranBuy number (text or image), through the outbound gate like every message. */
export async function sendFromMoranBuy({ type, to, body, imageUrl, caption, templateName, language, components = [], buttons = [], footer = null, idempotencyKey }) {
  const tenant = await moranBuyTenant();
  if (!tenant?.whatsapp_phone_number_id) throw Object.assign(new Error('MORANBUY_NOT_CONNECTED'), { code: 'MORANBUY_NOT_CONNECTED', status: 409 });
  const common = { phoneNumberId: tenant.whatsapp_phone_number_id, accessTokenEncrypted: tenant.wa_access_token_encrypted, to, kind: 'moranbuy', idempotencyKey, tenantId: tenant.id };
  if (type === 'image') return sendWhatsAppImage({ ...common, imageUrl, caption });
  // Up to three reply buttons (the terms question, for one).
  if (type === 'buttons') return sendWhatsAppButtons({ ...common, body, buttons, footer });
  if (type === 'template') {
    // A business-initiated message (an order alert to a merchant) must be a template Meta approved on the MoranBuy number.
    const template = await db('whatsapp_templates').where({ tenant_id: tenant.id, name: templateName, language }).first('status');
    if (!template || template.status !== 'APPROVED') throw Object.assign(new Error('TEMPLATE_NOT_APPROVED'), { code: 'TEMPLATE_NOT_APPROVED', status: 409 });
    return sendTemplateMessage({ ...common, templateName, languageCode: language, components });
  }
  return sendWhatsAppText({ ...common, body });
}

/** A merchant's own message to its own customer, only for businesses listed on MoranBuy with a connected number. */
async function listedTenant(tenantId) {
  const tenant = await db('tenants').where({ id: tenantId }).first();
  if (!tenant || !tenant.moranbuy_listed) throw Object.assign(new Error('TENANT_NOT_LISTED'), { code: 'TENANT_NOT_LISTED', status: 403 });
  if (tenant.wa_connection_status !== 'connected' || !tenant.whatsapp_phone_number_id) throw Object.assign(new Error('WHATSAPP_NOT_CONNECTED'), { code: 'WHATSAPP_NOT_CONNECTED', status: 409 });
  return tenant;
}

export async function sendMerchantText({ tenantId, to, body, idempotencyKey }) {
  const tenant = await listedTenant(tenantId);
  return sendWhatsAppText({ phoneNumberId: tenant.whatsapp_phone_number_id, accessTokenEncrypted: tenant.wa_access_token_encrypted, to, body, kind: 'moranbuy_merchant', idempotencyKey, tenantId: tenant.id });
}

export async function sendMerchantTemplate({ tenantId, to, templateName, language, components = [], idempotencyKey }) {
  const tenant = await listedTenant(tenantId);
  // Only a template this business owns and Meta approved may go out; the status here is the one Meta reported.
  const template = await db('whatsapp_templates').where({ tenant_id: tenantId, name: templateName, language }).first('status');
  if (!template || template.status !== 'APPROVED') throw Object.assign(new Error('TEMPLATE_NOT_APPROVED'), { code: 'TEMPLATE_NOT_APPROVED', status: 409 });
  return sendTemplateMessage({ phoneNumberId: tenant.whatsapp_phone_number_id, accessTokenEncrypted: tenant.wa_access_token_encrypted, to, templateName, languageCode: language, components, kind: 'moranbuy_campaign', idempotencyKey, tenantId: tenant.id });
}

/** MoranBuy orders carry this prefix in a business's order list, so they are told apart from the business's own. */
const MORANBUY_ORDER_PREFIX = 'MB-';
const MORANBUY_ORDER_STATUSES = new Set(['pending', 'confirmed', 'paid', 'fulfilled', 'cancelled']);

/** Writes an order MoranBuy confirmed into the listed business's own orders, so it shows in that business's dashboard; repeated calls return the same row. */
export async function createMoranBuyOrder({ tenantId, orderRef, customerName = null, customerPhone = null, items = [], deliveryFee = null, totalAmount = 0, currency = 'TZS', notes = null, customerLocation = null, fulfilment = null }) {
  const tenant = await db('tenants').where({ id: tenantId }).first();
  if (!tenant || !tenant.moranbuy_listed) throw Object.assign(new Error('TENANT_NOT_LISTED'), { code: 'TENANT_NOT_LISTED', status: 403 });
  const ref = `${MORANBUY_ORDER_PREFIX}${String(orderRef).toUpperCase()}`.slice(0, 40);
  const existing = await db('orders').where({ tenant_id: tenantId, order_ref: ref }).first('id', 'status');
  if (existing) return { orderId: existing.id, orderRef: ref, duplicate: true };
  // Lines keep the shape the agent writes, with the price MoranBuy verified against this business's catalogue.
  const lines = items.map((i) => ({ name: String(i.name || 'item').slice(0, 200), qty: Math.max(1, Math.floor(Number(i.quantity) || 1)), unit_price: Math.round(Number(i.unitPrice) || 0), sku: i.sku || null, product_id: i.productId || null, price_verified: true }));
  if (deliveryFee !== null && deliveryFee !== undefined) lines.push({ name: 'Delivery', qty: 1, unit_price: Math.round(Number(deliveryFee) || 0), price_verified: true });
  const where = customerLocation ? ` Delivery to: ${String(customerLocation).slice(0, 200)}.` : '';
  const [order] = await db('orders').insert({
    tenant_id: tenantId, order_ref: ref, customer_name: customerName ? String(customerName).slice(0, 120) : null, customer_phone: customerPhone || null,
    items: JSON.stringify(lines), total_amount: Math.round(Number(totalAmount) || 0), currency, status: 'pending',
    notes: `Placed through MoranBuy${fulfilment ? ` (${fulfilment})` : ''}.${where}${notes ? ` ${String(notes).slice(0, 500)}` : ''}`,
  }).returning('*');
  logger.info({ tenantId, orderRef: ref, total: order.total_amount }, 'MoranBuy order written into the business orders');
  return { orderId: order.id, orderRef: ref, duplicate: false };
}

/** Moves a MoranBuy order's status in step with MoranBuy; only MoranBuy's own orders can be touched this way. */
export async function updateMoranBuyOrder({ tenantId, orderRef, status, totalAmount = null, notes = null }) {
  const ref = `${MORANBUY_ORDER_PREFIX}${String(orderRef).toUpperCase()}`.slice(0, 40);
  if (!MORANBUY_ORDER_STATUSES.has(status)) throw Object.assign(new Error('BAD_STATUS'), { code: 'BAD_STATUS', status: 400 });
  const patch = { status, updated_at: db.fn.now() };
  if (totalAmount !== null && totalAmount !== undefined) patch.total_amount = Math.round(Number(totalAmount) || 0);
  if (notes) patch.notes = db.raw("coalesce(notes, '') || ?", [` ${String(notes).slice(0, 500)}`]);
  const n = await db('orders').where({ tenant_id: tenantId, order_ref: ref }).update(patch);
  if (!n) throw Object.assign(new Error('ORDER_NOT_FOUND'), { code: 'ORDER_NOT_FOUND', status: 404 });
  return { orderRef: ref, status };
}

/** Delivery receipts for messages MoranBuy sent (its own number or a listed business's) are passed on to MoranBuy; others are not its business. */
export async function forwardStatusesToMoranBuy(statuses = []) {
  const base = config.moranbuy.apiUrl;
  if (!base || !config.moranbuy.sharedSecret) return { ok: false, status: 'not_configured' };
  const ids = statuses.map((s) => s?.id).filter(Boolean);
  if (!ids.length) return { ok: true, forwarded: 0 };
  const ours = new Set((await db('message_usage_log').whereIn('provider_message_id', ids).whereIn('kind', ['moranbuy', 'moranbuy_merchant', 'moranbuy_campaign']).pluck('provider_message_id')));
  const mine = statuses.filter((s) => ours.has(s.id)).map((s) => ({ id: s.id, status: String(s.status || '').toLowerCase(), timestamp: s.timestamp || null, recipient: s.recipient_id || null, errors: Array.isArray(s.errors) ? s.errors.map((e) => ({ code: e.code, title: e.title || e.message || null })) : [] }));
  if (!mine.length) return { ok: true, forwarded: 0 };
  const raw = JSON.stringify({ statuses: mine });
  const { timestamp, signature } = signMoranBuy(raw);
  try {
    const res = await fetch(`${String(base).replace(/\/+$/, '')}/internal/inbound/status`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MoranBuy-Timestamp': timestamp, 'X-MoranBuy-Signature': signature }, body: raw, signal: AbortSignal.timeout(15000) });
    if (!res.ok) logger.warn({ status: res.status }, 'MoranBuy did not accept the delivery receipts');
    return { ok: res.ok, forwarded: mine.length };
  } catch (err) {
    logger.warn({ err: err.message }, 'Forwarding delivery receipts to MoranBuy failed');
    return { ok: false, status: 'network' };
  }
}

/** Active products of listed businesses and services, with each business's default location, newest changes first. */
export async function listedProducts({ since = null, page = 1, pageSize = 200 } = {}) {
  const limit = Math.min(500, Math.max(1, Number(pageSize) || 200));
  const offset = (Math.max(1, Number(page) || 1) - 1) * limit;
  let q = db('products as p')
    .join('tenants as t', 't.id', 'p.tenant_id')
    .leftJoin('services as s', 's.id', 'p.service_id')
    .leftJoin('business_locations as l', function j() { this.on('l.tenant_id', 't.id').andOn('l.is_default', db.raw('true')).andOnNull('l.deleted_at'); })
    .where('t.moranbuy_listed', true)
    .whereIn('t.status', ['active', 'trial'])
    .whereRaw("COALESCE(s.moranbuy_listed, true)")
    .whereNull('p.deleted_at')
    .where('p.is_active', true)
    .where('p.item_type', 'product')
    .select('p.id', 'p.tenant_id', 'p.service_id', 'p.name', 'p.description', 'p.price', 'p.currency', 'p.stock', 'p.status', 'p.category', 'p.condition', 'p.image_url', 'p.sku', 'p.retailer_id', 'p.variants', 'p.updated_at',
      't.business_name', 't.wa_connection_status', 't.moranbuy_listed_at', 't.owner_wa_number', 't.whatsapp_display_number', 't.owner_email', 't.industry', 's.name as service_name',
      'l.id as location_id', 'l.name as location_name', 'l.region', 'l.district', 'l.ward', 'l.formatted_address', 'l.latitude', 'l.longitude', 'l.radius_meters')
    .orderBy('p.updated_at', 'desc').limit(limit + 1).offset(offset);
  if (since) q = q.where('p.updated_at', '>', new Date(since));
  const rows = await q;
  const hasMore = rows.length > limit;
  return { listings: rows.slice(0, limit), nextPage: hasMore ? Number(page || 1) + 1 : null };
}

/** The MoranBuy tenant's own admin-written knowledge. */
export async function moranBuyKnowledge(query, limit = 3) {
  const tenant = await moranBuyTenant();
  if (!tenant) return [];
  return searchKnowledge(tenant.id, query, limit);
}
