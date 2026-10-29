import { logger } from '@moranbuy/observability';
import { db } from '../../db/connection.js';
import { saveUpload, readUpload } from '../uploads.js';
import { renderReceiptPdf, receiptNumber, eatDate } from './receipts.js';

const CURRENCY_LABEL = { TZS: 'TSh' };

// Every figure on a receipt comes from these rows; nothing is typed by a person or written by Muse.
export async function receiptFacts(dbImpl, order, { status, statusNote = null, number }) {
  const [merchant, listing, customer, payment, location, firstUser] = await Promise.all([
    dbImpl('merchants').where({ id: order.merchant_id }).first(),
    order.listing_id ? dbImpl('listings').where({ id: order.listing_id }).first() : null,
    dbImpl('customers').where({ id: order.customer_id }).first(),
    dbImpl('order_protection as p').join('payments as pay', 'pay.id', 'p.payment_id').where('p.order_id', order.id).first('pay.*'),
    dbImpl('merchant_locations').where({ merchant_id: order.merchant_id }).whereNull('deleted_at').orderBy('created_at').first().catch(() => null),
    dbImpl('merchant_users').where({ merchant_id: order.merchant_id }).orderBy('created_at').first('name'),
  ]);
  const paidAt = payment?.settled_at || order.updated_at;
  const { date, time } = eatDate(paidAt);
  const channel = payment?.provider_json?.lastEvent?.channel || payment?.provider_json?.channel?.provider || null;
  const servedBy = merchant.owner_name || firstUser?.name || null;
  const area = location ? [location.district || location.street, location.region].filter(Boolean).join(', ') || location.name : null;
  const deliveryLabel = order.fulfilment === 'delivery' ? (order.customer_location_json?.label || null) : null;
  return {
    receiptNo: receiptNumber(number), orderRef: order.order_ref, date, time,
    businessName: merchant.business_name, address: area, businessPhone: merchant.contact_phone, servedBy, servedRole: servedBy ? 'Owner' : null,
    items: [{ name: `${listing?.name || 'Product'}${order.variant ? ` (${order.variant})` : ''}`, quantity: order.quantity, unitPrice: order.unit_price }],
    deliveryFee: order.fulfilment === 'delivery' ? (order.delivery_fee ?? 0) : null, deliveryLabel,
    total: order.known_total, currency: CURRENCY_LABEL[order.currency] || order.currency,
    method: payment ? `Mobile money${channel ? ` (${channel})` : ''}${payment.provider === 'sandbox' ? ' - sandbox' : ''}` : 'Mobile money',
    paymentRef: payment?.reference || '-', customerPhone: customer?.channel === 'whatsapp' ? customer.channel_ref : '', status, statusNote,
  };
}

// A new version of the order's receipt; the number stays the same across versions, the status and check code change.
export async function issueReceipt({ dbImpl = db, order, status, statusNote = null }) {
  const versions = await dbImpl('receipts').where({ order_id: order.id }).orderBy('version');
  const version = (versions.at(-1)?.version || 0) + 1;
  const [row] = await dbImpl('receipts').insert({ order_id: order.id, version, status_label: status.slice(0, 40), check_code: '-', qr_text: '-' }).returning('*');
  const number = versions[0]?.number || row.number;
  const facts = await receiptFacts(dbImpl, order, { status, statusNote, number });
  const out = await renderReceiptPdf(facts);
  const upload = await saveUpload({ dbImpl, buffer: out.pdf, purpose: 'receipt', customerId: order.customer_id }).catch((err) => { logger.warn({ err: err.message }, 'Receipt file not stored'); return null; });
  const [saved] = await dbImpl('receipts').where({ number: row.number }).update({ check_code: out.checkCode, qr_text: out.qrText, upload_id: upload?.id || null }).returning('*');
  return { ...saved, receiptNo: facts.receiptNo, pdf: out.pdf };
}

export async function latestReceipt(dbImpl, orderId) {
  const row = await dbImpl('receipts').where({ order_id: orderId }).orderBy('version', 'desc').first();
  if (!row) return null;
  const first = await dbImpl('receipts').where({ order_id: orderId }).orderBy('version').first('number');
  const upload = row.upload_id ? await dbImpl('uploads').where({ id: row.upload_id }).first() : null;
  return { ...row, receiptNo: receiptNumber(first.number), pdf: upload ? await readUpload(upload).catch(() => null) : null };
}

// Sends a receipt PDF to a WhatsApp customer from the MoranBuy number.
export async function sendReceipt({ moran, to, receipt, caption = '' }) {
  if (!moran?.configured || !receipt?.pdf || !to) return { ok: false, status: 'not_sent' };
  return moran.sendDocument({ to, documentBase64: receipt.pdf.toString('base64'), filename: `MoranBuy-${receipt.receiptNo}-v${receipt.version}.pdf`, caption, idempotencyKey: `moranbuy:receipt:${receipt.order_id}:${receipt.version}` });
}

// The public check behind the QR code: the receipt number and its check code must match, or nothing is shown.
export async function verifyReceipt(dbImpl, receiptNo, code) {
  const n = Number(String(receiptNo).replace(/^MB-R-/i, ''));
  if (!Number.isInteger(n) || n <= 0) return null;
  const first = await dbImpl('receipts').where({ number: n }).first();
  if (!first || first.version !== 1) return null;
  const all = await dbImpl('receipts').where({ order_id: first.order_id }).orderBy('version');
  const clean = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const match = all.find((r) => r.check_code.replace('-', '') === clean);
  if (!match) return null;
  return { receiptNo: receiptNumber(n), version: match.version, summary: match.qr_text.split('\nVerify:')[0], latestStatus: all.at(-1).status_label, latestVersion: all.at(-1).version };
}
