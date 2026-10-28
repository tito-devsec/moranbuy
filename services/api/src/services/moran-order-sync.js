import { logger } from '@moranbuy/observability';
import { db } from '../db/connection.js';

// Moran's order statuses for MoranBuy's.
const MORAN_STATUS = { pending_merchant: 'pending', accepted: 'confirmed', rejected: 'cancelled', fulfilled: 'fulfilled', cancelled: 'cancelled', paid: 'paid' };

// A confirmed order for a Moran-linked business is also written into Moran, so it shows in that business's own dashboard.
export async function handOrderToMoran({ dbImpl = db, moran, order }) {
  const merchant = await dbImpl('merchants').where({ id: order.merchant_id }).first();
  if (!merchant?.moran_tenant_id || !moran?.configured) return { skipped: !merchant?.moran_tenant_id ? 'not_moran_merchant' : 'moran_not_configured' };
  const listing = order.listing_id ? await dbImpl('listings').where({ id: order.listing_id }).first() : null;
  const customer = await dbImpl('customers').where({ id: order.customer_id }).first();
  const r = await moran.createOrder({
    tenantId: merchant.moran_tenant_id, orderRef: order.order_ref,
    customerPhone: customer?.channel === 'whatsapp' ? `+${customer.channel_ref}` : null, customerName: customer?.name || null,
    items: [{ name: `${listing?.name || 'MoranBuy order'}${order.variant ? ` (${order.variant})` : ''}`, sku: listing?.source_sku || null, productId: listing?.source_product_id || null, quantity: order.quantity, unitPrice: order.unit_price, lineTotal: order.unit_price * order.quantity }],
    deliveryFee: order.total_confirmed ? order.delivery_fee : null, totalAmount: order.known_total, totalConfirmed: order.total_confirmed, currency: order.currency, fulfilment: order.fulfilment,
    customerLocation: order.customer_location_json?.label || null, notes: `MoranBuy order ${order.order_ref} (${order.fulfilment}${order.total_confirmed ? '' : ', delivery fee not yet confirmed'})`,
  });
  if (!r.ok) { logger.warn({ orderId: order.id, status: r.status }, 'Order not handed to Moran'); return { ok: false, status: r.status }; }
  await dbImpl('orders').where({ id: order.id }).update({ external_ref: r.data?.orderId ? `moran:${r.data.orderId}` : `moran:${order.order_ref}` });
  return { ok: true, moranOrderId: r.data?.orderId || null };
}

// A status change in MoranBuy is mirrored to Moran's copy of the order.
export async function syncOrderStatusToMoran({ dbImpl = db, moran, order }) {
  const merchant = await dbImpl('merchants').where({ id: order.merchant_id }).first();
  if (!merchant?.moran_tenant_id || !moran?.configured || !order.external_ref) return { skipped: true };
  const r = await moran.updateOrder({ tenantId: merchant.moran_tenant_id, orderRef: order.order_ref, status: MORAN_STATUS[order.status] || 'pending', totalAmount: order.known_total, deliveryFee: order.total_confirmed ? order.delivery_fee : null, notes: order.notes || null });
  return { ok: r.ok, status: r.status };
}
