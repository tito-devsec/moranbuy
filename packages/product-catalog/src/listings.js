import { z } from 'zod';
import { ApiError, notFound } from '@moranbuy/core';
import { audit } from '@moranbuy/observability';

// Fields Moran owns for an imported product; MoranBuy only mirrors them and sends edits back to Moran.
export const MORAN_OWNED_FIELDS = Object.freeze(['name', 'description', 'price', 'currency', 'stock', 'status', 'imageUrl', 'category', 'condition']);
// Fields MoranBuy owns on every listing, imported or not.
export const MORANBUY_FIELDS = Object.freeze(['productType', 'attributes', 'moranbuyVisible', 'locationIds']);

export const listingInput = z.object({
  name: z.string().trim().min(2).max(200),
  description: z.string().max(4000).nullable().optional(),
  category: z.string().trim().max(80).nullable().optional(),
  productType: z.string().trim().max(80).nullable().optional(),
  attributes: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  variants: z.array(z.object({ name: z.string().max(80), price: z.number().int().nonnegative().optional(), stock: z.number().int().nonnegative().nullable().optional() })).max(50).optional(),
  price: z.number().int().nonnegative(),
  currency: z.string().length(3).optional(),
  stock: z.number().int().nonnegative().nullable().optional(),
  condition: z.enum(['new', 'refurbished', 'used']).optional(),
  status: z.enum(['active', 'inactive', 'out_of_stock', 'archived']).optional(),
  moranbuyVisible: z.boolean().optional(),
  imageUrl: z.string().url().max(600).nullable().optional(),
  locationIds: z.array(z.string().uuid()).max(50).optional(),
});

const COLS = { name: 'name', description: 'description', category: 'category', productType: 'product_type', price: 'price', currency: 'currency', stock: 'stock', condition: 'condition', status: 'status', moranbuyVisible: 'moranbuy_visible', imageUrl: 'image_url' };

// The listing as the apps see it, with which fields may be edited where.
export function publicListing(row, locations = []) {
  if (!row) return null;
  return {
    id: row.id, merchantId: row.merchant_id, name: row.name, description: row.description, category: row.category, productType: row.product_type,
    attributes: row.attributes || {}, variants: row.variants || [], price: Number(row.price), currency: row.currency, priceStatus: row.price_status,
    stock: row.stock === null ? null : Number(row.stock), condition: row.condition, status: row.status, moranbuyVisible: row.moranbuy_visible, imageUrl: row.image_url,
    source: row.source, sourceProductId: row.source_product_id, sourceSku: row.source_sku, moranServiceId: row.moran_service_id, syncedAt: row.synced_at, sourceUpdatedAt: row.source_updated_at,
    editable: row.source === 'moran' ? { local: [...MORANBUY_FIELDS], viaMoran: [...MORAN_OWNED_FIELDS] } : { local: [...MORANBUY_FIELDS, ...MORAN_OWNED_FIELDS, 'variants'], viaMoran: [] },
    locationIds: locations.map((l) => l.location_id), createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export async function listListings(db, merchantId, { includeArchived = false } = {}) {
  let q = db('listings').where({ merchant_id: merchantId }).whereNull('deleted_at').orderBy('updated_at', 'desc');
  if (!includeArchived) q = q.whereNot('status', 'archived');
  const rows = await q;
  const links = rows.length ? await db('listing_locations').whereIn('listing_id', rows.map((r) => r.id)) : [];
  return rows.map((r) => publicListing(r, links.filter((l) => l.listing_id === r.id)));
}

export async function getListing(db, merchantId, id) {
  const row = await db('listings').where({ id, merchant_id: merchantId }).whereNull('deleted_at').first();
  if (!row) throw notFound('LISTING_NOT_FOUND', 'That product was not found.');
  return publicListing(row, await db('listing_locations').where({ listing_id: id }));
}

// Creates a standalone listing; the stock decides the status unless the merchant switched it off.
export async function createListing(db, merchantId, input, { actorId, ip = null }) {
  const status = input.status || (input.stock === 0 ? 'out_of_stock' : 'active');
  return db.transaction(async (trx) => {
    const [row] = await trx('listings').insert({
      merchant_id: merchantId, name: input.name, description: input.description || null, category: input.category || null, product_type: input.productType || null,
      attributes: JSON.stringify(input.attributes || {}), variants: JSON.stringify(input.variants || []), price: input.price, currency: input.currency || 'TZS',
      stock: input.stock ?? null, condition: input.condition || 'new', status, moranbuy_visible: input.moranbuyVisible ?? true, image_url: input.imageUrl || null, source: 'moranbuy',
    }).returning('*');
    await linkLocations(trx, merchantId, row.id, input.locationIds || []);
    await audit(trx, { actorType: 'merchant', actorId, merchantId, action: 'listing.created', targetType: 'listing', targetId: row.id, after: { name: row.name, price: row.price }, ip });
    return publicListing(row, (input.locationIds || []).map((location_id) => ({ location_id })));
  });
}

// Updates a listing; Moran-owned fields of an imported product are refused here and must go through the Moran sync.
export async function updateListing(db, merchantId, id, input, { actorId, ip = null }) {
  const current = await db('listings').where({ id, merchant_id: merchantId }).whereNull('deleted_at').first();
  if (!current) throw notFound('LISTING_NOT_FOUND', 'That product was not found.');
  if (current.source === 'moran') {
    const blocked = Object.keys(input).filter((k) => MORAN_OWNED_FIELDS.includes(k) || k === 'variants');
    if (blocked.length) throw new ApiError(409, 'FIELD_OWNED_BY_MORAN', `Change ${blocked.join(', ')} in Moran AI; MoranBuy mirrors it on the next sync.`, { fields: blocked });
  }
  const patch = { updated_at: db.fn.now() };
  for (const [k, col] of Object.entries(COLS)) if (input[k] !== undefined) patch[col] = input[k];
  if (input.attributes !== undefined) patch.attributes = JSON.stringify(input.attributes);
  if (input.variants !== undefined) patch.variants = JSON.stringify(input.variants);
  if (input.stock !== undefined && input.status === undefined && current.source !== 'moran') patch.status = input.stock === 0 ? 'out_of_stock' : current.status === 'out_of_stock' ? 'active' : current.status;
  return db.transaction(async (trx) => {
    const [row] = await trx('listings').where({ id }).update(patch).returning('*');
    if (input.locationIds !== undefined) { await trx('listing_locations').where({ listing_id: id }).delete(); await linkLocations(trx, merchantId, id, input.locationIds); }
    await audit(trx, { actorType: 'merchant', actorId, merchantId, action: 'listing.updated', targetType: 'listing', targetId: id, before: { price: current.price, status: current.status }, after: { price: row.price, status: row.status }, ip });
    return publicListing(row, await trx('listing_locations').where({ listing_id: id }));
  });
}

export async function deleteListing(db, merchantId, id, { actorId, ip = null }) {
  const current = await db('listings').where({ id, merchant_id: merchantId }).whereNull('deleted_at').first();
  if (!current) throw notFound('LISTING_NOT_FOUND', 'That product was not found.');
  if (current.source === 'moran') throw new ApiError(409, 'FIELD_OWNED_BY_MORAN', 'Delete or archive this product in Moran AI, or hide it from MoranBuy with moranbuyVisible.');
  await db('listings').where({ id }).update({ deleted_at: db.fn.now(), status: 'archived' });
  await audit(db, { actorType: 'merchant', actorId, merchantId, action: 'listing.deleted', targetType: 'listing', targetId: id, ip });
}

// Links a listing to locations that belong to the same merchant only; a foreign location id is refused.
async function linkLocations(trx, merchantId, listingId, locationIds) {
  if (!locationIds.length) return;
  const owned = await trx('merchant_locations').where({ merchant_id: merchantId }).whereIn('id', locationIds).whereNull('deleted_at').pluck('id');
  if (owned.length !== new Set(locationIds).size) throw new ApiError(400, 'VALIDATION_ERROR', 'One of the locations does not belong to this business.', { locationIds: 'unknown location' });
  await trx('listing_locations').insert(owned.map((location_id) => ({ listing_id: listingId, location_id })));
}
