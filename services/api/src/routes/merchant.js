import express from 'express';
import { z } from 'zod';
import { ApiError, notFound } from '@moranbuy/core';
import { requireMerchantAuth, requireEntitlement, listEntitlements, selectServices } from '@moranbuy/authorization';
import { publicMerchant, submitVerification, moranAccessTokenFor } from '@moranbuy/merchant-management';
import { listingInput, listListings, getListing, createListing, updateListing, deleteListing, locationInput, listLocations, createLocation, updateLocation, deleteLocation, syncMoranProducts, syncMoranLocations } from '@moranbuy/product-catalog';
import { audit } from '@moranbuy/observability';
import { asyncHandler } from '../middleware/async-handler.js';
import { validate } from '../middleware/validate.js';
import { db } from '../db/connection.js';
import { merchantDeps } from '../services/merchants.js';

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

merchantRouter.post('/verification', validate({ body: z.object({ registrationNumber: z.string().max(80).nullable().optional(), taxId: z.string().max(80).nullable().optional(), documentUrls: z.array(z.string().url()).max(10).optional(), notes: z.string().max(1000).nullable().optional() }) }), asyncHandler(async (req, res) => {
  const row = await submitVerification(db, req.merchant.id, { ...req.body, documentUrls: req.body.documentUrls || [], ...actor(req) });
  res.json({ merchant: publicMerchant(row) });
}));

// ---- listings ----
merchantRouter.get('/listings', asyncHandler(async (req, res) => res.json({ listings: await listListings(db, req.merchant.id, { includeArchived: req.query.includeArchived === 'true' }) })));
merchantRouter.get('/listings/:id', validate({ params: idParams }), asyncHandler(async (req, res) => res.json({ listing: await getListing(db, req.merchant.id, req.params.id) })));
merchantRouter.post('/listings', validate({ body: listingInput }), asyncHandler(async (req, res) => res.status(201).json({ listing: await createListing(db, req.merchant.id, req.body, actor(req)) })));
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
  const rows = await db('orders as o').leftJoin('listings as l', 'l.id', 'o.listing_id').leftJoin('customers as c', 'c.id', 'o.customer_id').where('o.merchant_id', req.merchant.id).orderBy('o.created_at', 'desc').limit(200)
    .select('o.*', 'l.name as listing_name', 'c.channel as customer_channel', 'c.channel_ref as customer_ref', 'c.name as customer_name');
  res.json({ orders: rows.map((o) => ({ ...o, customer_ref: o.customer_channel === 'whatsapp' ? o.customer_ref : null })) });
}));

merchantRouter.post('/orders/:id/status', validate({ params: idParams, body: z.object({ status: z.enum(['accepted', 'rejected', 'fulfilled', 'cancelled']), note: z.string().max(500).optional(), deliveryFee: z.number().int().nonnegative().optional() }) }), asyncHandler(async (req, res) => {
  const order = await db('orders').where({ id: req.params.id, merchant_id: req.merchant.id }).first();
  if (!order) throw notFound('ORDER_NOT_FOUND');
  const patch = { status: req.body.status, notes: req.body.note || order.notes, updated_at: db.fn.now() };
  if (req.body.deliveryFee !== undefined && !order.total_confirmed) { patch.delivery_fee = req.body.deliveryFee; patch.known_total = order.unit_price * order.quantity + req.body.deliveryFee; patch.total_confirmed = true; }
  const [row] = await db('orders').where({ id: order.id }).update(patch).returning('*');
  await audit(db, { actorType: 'merchant', actorId: req.merchantUser.id, merchantId: req.merchant.id, action: 'order.status_changed', targetType: 'order', targetId: order.id, before: { status: order.status }, after: { status: row.status }, ip: req.ip });
  res.json({ order: row });
}));

merchantRouter.get('/enquiries', asyncHandler(async (req, res) => res.json({ enquiries: await db('enquiries').where({ merchant_id: req.merchant.id }).orderBy('created_at', 'desc').limit(200) })));

// A probe that only an active campaign entitlement passes; the campaign routes themselves arrive in Phase 7.
merchantRouter.get('/entitlements/campaign_engine/check', requireEntitlement(db, 'campaign_engine'), (_req, res) => res.json({ ok: true }));
