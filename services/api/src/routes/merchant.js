import express from 'express';
import { z } from 'zod';
import { ApiError, notFound } from '@moranbuy/core';
import { requireMerchantAuth, requireEntitlement, listEntitlements, selectServices } from '@moranbuy/authorization';
import { publicMerchant, submitVerification, moranAccessTokenFor } from '@moranbuy/merchant-management';
import { listingInput, listListings, getListing, createListing, updateListing, deleteListing, locationInput, listLocations, createLocation, updateLocation, deleteLocation, syncMoranProducts, syncMoranLocations } from '@moranbuy/product-catalog';
import { audit } from '@moranbuy/observability';
import { offerOutreachForListing } from '@moranbuy/campaign-outreach';
import { asyncHandler } from '../middleware/async-handler.js';
import { validate } from '../middleware/validate.js';
import { db } from '../db/connection.js';
import { merchantDeps } from '../services/merchants.js';
import { shoppingDeps } from '../services/shopping.js';
import { applyOrderStatus } from '../services/order-actions.js';
import { engagementDeps } from '../services/engagement.js';
import { startPayment } from '@moranbuy/billing';
import { loadServicePricing } from '../services/service-pricing.js';
import { demandOverview } from '../services/insights.js';
import { toMsisdn, isValidMsisdn } from '@moranbuy/consent-management';
import { assignDeliverer } from '../services/protection/protection.js';
import { latestReceipt } from '../services/protection/receipts-store.js';

export const merchantRouter = express.Router();
merchantRouter.use(requireMerchantAuth(db));

const actor = (req) => ({ actorId: req.merchantUser.id, ip: req.ip });
const idParams = z.object({ id: z.string().uuid() });

// ---- profile, services, verification ----
merchantRouter.get('/profile', asyncHandler(async (req, res) => res.json({ merchant: publicMerchant(req.merchant), entitlements: await listEntitlements(db, req.merchant.id) })));

const profileBody = z.object({ businessName: z.string().trim().min(2).max(160).optional(), description: z.string().max(2000).nullable().optional(), industry: z.string().max(80).nullable().optional(), contactPhone: z.string().max(32).nullable().optional() });
merchantRouter.patch('/profile', validate({ body: profileBody }), asyncHandler(async (req, res) => {
  const patch = { updated_at: db.fn.now() };
  if (req.body.businessName !== undefined) patch.business_name = req.body.businessName;
  if (req.body.description !== undefined) patch.description = req.body.description;
  if (req.body.industry !== undefined) patch.industry = req.body.industry;
  if (req.body.contactPhone !== undefined) patch.contact_phone = req.body.contactPhone;
  const [row] = await db('merchants').where({ id: req.merchant.id }).update(patch).returning('*');
  await audit(db, { actorType: 'merchant', actorId: req.merchantUser.id, merchantId: req.merchant.id, action: 'merchant.profile_updated', targetType: 'merchant', targetId: req.merchant.id, after: req.body, ip: req.ip });
  res.json({ merchant: publicMerchant(row) });
}));

// Choosing a paid service never activates it; it waits for payment and activation.
merchantRouter.post('/services', validate({ body: z.object({ services: z.array(z.enum(['campaign_engine', 'new_product_outreach', 'paid_followup', 'conversation_agent'])).min(1).max(4) }) }), asyncHandler(async (req, res) => {
  if (req.body.services.includes('conversation_agent') && req.merchant.registration_type !== 'moran') throw new ApiError(403, 'MORAN_REQUIRED', 'The full conversation agent is a Moran AI service; link a Moran AI account first.');
  const rows = await selectServices(db, req.merchant.id, req.body.services, { actor: `merchant:${req.merchantUser.id}` });
  await audit(db, { actorType: 'merchant', actorId: req.merchantUser.id, merchantId: req.merchant.id, action: 'merchant.services_selected', targetType: 'merchant', targetId: req.merchant.id, after: { services: req.body.services }, ip: req.ip });
  res.json({ entitlements: rows });
}));

// What the paid services cost and how to buy one; activation follows the verified payment, never this request.
merchantRouter.get('/services/pricing', asyncHandler(async (_req, res) => res.json({ pricing: await loadServicePricing() })));
merchantRouter.post('/services/:service/pay', validate({ params: z.object({ service: z.enum(['campaign_engine', 'new_product_outreach', 'paid_followup']) }), body: z.object({ phone: z.string().max(20).optional() }).default({}) }), asyncHandler(async (req, res) => {
  const pricing = await loadServicePricing();
  const price = pricing[req.params.service];
  if (!price || price.monthlyTzs === null || price.monthlyTzs === undefined) throw new ApiError(409, 'SERVICE_NOT_PRICED', 'This service has no price yet; an administrator must set it.');
  await selectServices(db, req.merchant.id, [req.params.service], { actor: `merchant:${req.merchantUser.id}` });
  const pending = await db('payments').where({ merchant_id: req.merchant.id, purpose: 'entitlement', target_id: req.params.service, status: 'pending' }).orderBy('created_at', 'desc').first();
  const pub = (p) => ({ id: p.id, reference: p.reference, amount: p.amount, currency: p.currency, status: p.status, provider: p.provider });
  if (pending && Date.now() - new Date(pending.created_at).getTime() < 15 * 60000) return res.json({ payment: pub(pending), reused: true });
  const payment = await startPayment(db, engagementDeps().payments, { merchantId: req.merchant.id, purpose: 'entitlement', targetId: req.params.service, amount: price.monthlyTzs, currency: pricing.currency, phone: req.body.phone || req.merchant.contact_phone || null, breakdown: { service: req.params.service, monthlyTzs: price.monthlyTzs, periodDays: price.periodDays || 30 }, actorId: req.merchantUser.id });
  res.json({ payment: pub(payment) });
}));
// What the business itself paid MoranBuy for; customers' protected order payments show on the orders instead.
merchantRouter.get('/payments', asyncHandler(async (req, res) => res.json({ payments: await db('payments').where({ merchant_id: req.merchant.id }).whereNot({ purpose: 'order' }).orderBy('created_at', 'desc').limit(50).select('id', 'purpose', 'target_id', 'provider', 'reference', 'amount', 'currency', 'status', 'settled_at', 'created_at') })));

merchantRouter.post('/verification', validate({ body: z.object({ registrationNumber: z.string().max(80).nullable().optional(), taxId: z.string().max(80).nullable().optional(), documentUrls: z.array(z.string().url()).max(10).optional(), documentUploadIds: z.array(z.string().uuid()).max(10).optional(), notes: z.string().max(1000).nullable().optional() }) }), asyncHandler(async (req, res) => {
  const row = await submitVerification(db, req.merchant.id, { ...req.body, documentUrls: req.body.documentUrls || [], documentUploadIds: [...new Set(req.body.documentUploadIds || [])], ...actor(req) });
  res.json({ merchant: publicMerchant(row) });
}));

// ---- listings ----
merchantRouter.get('/listings', asyncHandler(async (req, res) => res.json({ listings: await listListings(db, req.merchant.id, { includeArchived: req.query.includeArchived === 'true' }) })));
merchantRouter.get('/listings/:id', validate({ params: idParams }), asyncHandler(async (req, res) => res.json({ listing: await getListing(db, req.merchant.id, req.params.id) })));
merchantRouter.post('/listings', validate({ body: listingInput }), asyncHandler(async (req, res) => {
  const listing = await createListing(db, req.merchant.id, req.body, actor(req));
  // Publishing a product may produce an outreach offer the merchant must answer; nothing is sent by publishing.
  const offer = await offerOutreachForListing(db, { merchantId: req.merchant.id, listingId: listing.id, trigger: 'listing_published' });
  res.status(201).json({ listing, outreachOffer: offer ? { id: offer.id, status: offer.status } : null });
}));
merchantRouter.patch('/listings/:id', validate({ params: idParams, body: listingInput.partial() }), asyncHandler(async (req, res) => res.json({ listing: await updateListing(db, req.merchant.id, req.params.id, req.body, actor(req)) })));
merchantRouter.delete('/listings/:id', validate({ params: idParams }), asyncHandler(async (req, res) => { await deleteListing(db, req.merchant.id, req.params.id, actor(req)); res.json({ ok: true }); }));

// Moran-owned fields of an imported product are changed in Moran with the merchant's own token, then mirrored back.
const moranPatch = z.object({ name: z.string().trim().min(2).max(200).optional(), description: z.string().max(4000).nullable().optional(), price: z.number().int().nonnegative().optional(), stock: z.number().int().nonnegative().nullable().optional(), isActive: z.boolean().optional() });
merchantRouter.patch('/listings/:id/moran', validate({ params: idParams, body: moranPatch }), asyncHandler(async (req, res) => {
  const listing = await getListing(db, req.merchant.id, req.params.id);
  if (listing.source !== 'moran') throw new ApiError(409, 'NOT_A_MORAN_PRODUCT', 'This product lives in MoranBuy; edit it directly.');
  const { moran } = merchantDeps();
  const token = await moranAccessTokenFor(db, moran, req.merchant);
  const patch = {};
  for (const k of ['name', 'description', 'price', 'stock']) if (req.body[k] !== undefined) patch[k] = req.body[k];
  if (req.body.isActive !== undefined) patch.is_active = req.body.isActive;
  const r = await moran.updateProduct(token, listing.moranServiceId, listing.sourceProductId, patch);
  if (!r.ok) throw new ApiError(502, 'MORAN_UPDATE_FAILED', r.data?.message || 'Moran AI did not accept the change.', r.data?.details);
  const result = await syncMoranProducts(db, moran, req.merchant, token, { actorId: req.merchantUser.id });
  res.json({ listing: await getListing(db, req.merchant.id, req.params.id), sync: result });
}));

// Pulls every product and location of the linked Moran account; repeatable without duplicates.
merchantRouter.post('/sync/moran', asyncHandler(async (req, res) => {
  if (req.merchant.registration_type !== 'moran') throw new ApiError(409, 'MORAN_NOT_LINKED', 'Link the Moran AI account first.');
  const { moran } = merchantDeps();
  const token = await moranAccessTokenFor(db, moran, req.merchant);
  const products = await syncMoranProducts(db, moran, req.merchant, token, { actorId: req.merchantUser.id });
  const locations = await syncMoranLocations(db, moran, req.merchant, token);
  res.json({ products, locations });
}));

// ---- locations ----
merchantRouter.get('/locations', asyncHandler(async (req, res) => res.json({ locations: await listLocations(db, req.merchant.id) })));
merchantRouter.post('/locations', validate({ body: locationInput }), asyncHandler(async (req, res) => res.status(201).json({ location: await createLocation(db, req.merchant.id, req.body, { geocoder: merchantDeps().geocoder, ...actor(req) }) })));
merchantRouter.patch('/locations/:id', validate({ params: idParams, body: locationInput.partial() }), asyncHandler(async (req, res) => res.json({ location: await updateLocation(db, req.merchant.id, req.params.id, req.body, { geocoder: merchantDeps().geocoder, ...actor(req) }) })));
merchantRouter.delete('/locations/:id', validate({ params: idParams }), asyncHandler(async (req, res) => { await deleteLocation(db, req.merchant.id, req.params.id, actor(req)); res.json({ ok: true }); }));

// ---- orders and enquiries ----
merchantRouter.get('/orders', asyncHandler(async (req, res) => {
  const rows = await db('orders as o').leftJoin('listings as l', 'l.id', 'o.listing_id').leftJoin('customers as c', 'c.id', 'o.customer_id').leftJoin('order_protection as p', 'p.order_id', 'o.id').where('o.merchant_id', req.merchant.id).orderBy('o.created_at', 'desc').limit(200)
    .select('o.*', 'l.name as listing_name', 'c.channel as customer_channel', 'c.channel_ref as customer_ref', 'c.name as customer_name', 'p.state as protection_state', 'p.deliverer_phone', 'p.deliverer_name', 'p.release_due_at');
  res.json({ orders: rows.map((o) => ({ ...o, customer_ref: o.customer_channel === 'whatsapp' ? o.customer_ref : null })) });
}));

merchantRouter.post('/orders/:id/status', validate({ params: idParams, body: z.object({ status: z.enum(['accepted', 'rejected', 'fulfilled', 'cancelled']), note: z.string().max(500).optional(), deliveryFee: z.number().int().nonnegative().optional() }) }), asyncHandler(async (req, res) => {
  const order = await db('orders').where({ id: req.params.id, merchant_id: req.merchant.id }).first();
  if (!order) throw notFound('ORDER_NOT_FOUND');
  try {
    const out = await applyOrderStatus({ moran: shoppingDeps().moran, order, status: req.body.status, deliveryFee: req.body.deliveryFee ?? null, note: req.body.note || null, actor: { type: 'merchant', id: req.merchantUser.id, via: 'dashboard' } });
    res.json({ order: out.order, customerAlert: out.customerAlert, moranSync: out.moranSync });
  } catch (err) { if (['BAD_TRANSITION', 'PROTECTED_ORDER', 'DELIVERY_FEE_REQUIRED'].includes(err.code)) throw new ApiError(409, err.code, err.message); throw err; }
}));

// Names who delivers a paid order; only that number can confirm it with the customer's handover code.
merchantRouter.post('/orders/:id/deliverer', validate({ params: idParams, body: z.object({ phone: z.string().min(9).max(20), name: z.string().max(120).optional() }) }), asyncHandler(async (req, res) => {
  const order = await db('orders').where({ id: req.params.id, merchant_id: req.merchant.id }).first();
  if (!order) throw notFound('ORDER_NOT_FOUND');
  try {
    const p = await assignDeliverer({ moran: shoppingDeps().moran, order, phone: req.body.phone, name: req.body.name || null, actor: { type: 'merchant', id: req.merchantUser.id, via: 'dashboard' } });
    res.json({ state: p.state, delivererPhone: p.deliverer_phone, delivererName: p.deliverer_name });
  } catch (err) { if (err.status) throw new ApiError(err.status, err.code, err.message); throw err; }
}));

// The latest receipt of an order as a PDF download.
merchantRouter.get('/orders/:id/receipt.pdf', validate({ params: idParams }), asyncHandler(async (req, res) => {
  const order = await db('orders').where({ id: req.params.id, merchant_id: req.merchant.id }).first();
  const r = order ? await latestReceipt(db, order.id) : null;
  if (!r?.pdf) throw notFound('RECEIPT_NOT_FOUND');
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="MoranBuy-${r.receiptNo}.pdf"`, 'Cache-Control': 'private, no-store' }).send(r.pdf);
}));

// The owner's name for receipts and the mobile money number protected payments are released to.
merchantRouter.put('/payout', validate({ body: z.object({ ownerName: z.string().min(2).max(120), payoutPhone: z.string().min(9).max(20) }) }), asyncHandler(async (req, res) => {
  const phone = toMsisdn(req.body.payoutPhone);
  if (!isValidMsisdn(phone)) throw new ApiError(400, 'BAD_PHONE', 'That phone number is not valid.');
  const before = { ownerName: req.merchant.owner_name, payoutPhone: req.merchant.payout_phone };
  await db('merchants').where({ id: req.merchant.id }).update({ owner_name: req.body.ownerName, payout_phone: phone, updated_at: db.fn.now() });
  await audit(db, { actorType: 'merchant', actorId: req.merchantUser.id, merchantId: req.merchant.id, action: 'merchant.payout_details_changed', targetType: 'merchant', targetId: req.merchant.id, before, after: { ownerName: req.body.ownerName, payoutPhone: phone } });
  res.json({ ownerName: req.body.ownerName, payoutPhone: phone });
}));

// What customers ask MoranBuy for in this business's line, where they are, what sold; Muse explains it when it is on.
merchantRouter.get('/insights', validate({ query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30), language: z.enum(['sw', 'en']).default('sw') }).passthrough() }), asyncHandler(async (req, res) => res.json(await demandOverview({ muse: shoppingDeps().muse, merchantId: req.merchant.id, days: req.query.days, language: req.query.language }))));
merchantRouter.get('/schedules', asyncHandler(async (req, res) => res.json({ schedules: await db('customer_schedules as s').join('customers as c', 'c.id', 's.customer_id').where('s.merchant_id', req.merchant.id).orderBy('s.due_at', 'asc').limit(200).select('s.*', 'c.name as customer_name', 'c.region', 'c.district') })));
merchantRouter.get('/enquiries', asyncHandler(async (req, res) => res.json({ enquiries: await db('enquiries').where({ merchant_id: req.merchant.id }).orderBy('created_at', 'desc').limit(200) })));

// A probe that only an active campaign entitlement passes; the campaign routes themselves arrive in Phase 7.
merchantRouter.get('/entitlements/campaign_engine/check', requireEntitlement(db, 'campaign_engine'), (_req, res) => res.json({ ok: true }));
