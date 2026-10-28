import { ApiError, notFound } from '@moranbuy/core';
import { audit } from '@moranbuy/observability';
import { resolvePlace } from '@moranbuy/location-ranking';
import { db } from '../db/connection.js';
import { loadRankingPolicy } from './shopping.js';

const n = (v) => Number(v || 0);
const PAGE_MAX = 200;

// The quality problems that make a product rank badly or not at all, each as a SQL condition on listings (l) and merchants (m).
const FLAGS = {
  stale: (d, days) => d.raw('coalesce(l.source_updated_at, l.updated_at) < ?', [new Date(Date.now() - days * 86400000)]),
  no_image: (d) => d.raw("coalesce(l.image_url, '') = ''"),
  stock_unknown: (d) => d.raw('l.stock is null'),
  out_of_stock: (d) => d.raw('l.stock = 0'),
  no_type: (d) => d.raw("coalesce(l.product_type, '') = ''"),
  no_location: (d) => d.raw('not exists (select 1 from merchant_locations ml where ml.merchant_id = l.merchant_id and ml.deleted_at is null and ml.latitude is not null)'),
  hidden_by_business: (d) => d.raw('l.moranbuy_visible = false'),
  hidden_by_admin: (d) => d.raw('l.admin_hidden_at is not null'),
};
export const LISTING_FLAGS = Object.freeze(Object.keys(FLAGS));

// Every product across all businesses, filtered and paged, with the problems that hurt its ranking named on each row.
export async function adminListings({ dbImpl = db, q = {} } = {}) {
  const policy = await loadRankingPolicy(dbImpl);
  const staleDays = policy.staleAfterDays || 45;
  const base = () => {
    let b = dbImpl('listings as l').join('merchants as m', 'm.id', 'l.merchant_id').whereNull('l.deleted_at');
    if (q.search) b = b.where((w) => w.whereILike('l.name', `%${q.search}%`).orWhereILike('l.product_type', `%${q.search}%`).orWhereILike('m.business_name', `%${q.search}%`));
    if (q.merchantId) b = b.where('l.merchant_id', q.merchantId);
    if (q.source) b = b.where('l.source', q.source);
    if (q.status) b = b.where('l.status', q.status);
    if (q.category) b = b.where('l.category', q.category);
    if (q.priceMin !== undefined) b = b.where('l.price', '>=', q.priceMin);
    if (q.priceMax !== undefined) b = b.where('l.price', '<=', q.priceMax);
    if (q.flag) b = b.whereRaw(FLAGS[q.flag](dbImpl, staleDays));
    return b;
  };
  const order = { updated: ['l.updated_at', 'desc'], price: ['l.price', 'asc'], name: ['l.name', 'asc'], merchant: ['m.business_name', 'asc'] }[q.sort || 'updated'];
  const pageSize = Math.min(PAGE_MAX, q.pageSize || 50);
  const page = Math.max(1, q.page || 1);
  const flagSelect = Object.entries(FLAGS).map(([k, f]) => dbImpl.raw(`(${f(dbImpl, staleDays).toString()}) as "flag_${k}"`));
  const rows = await base().select('l.id', 'l.merchant_id', 'l.name', 'l.category', 'l.product_type', 'l.price', 'l.currency', 'l.price_status', 'l.stock', 'l.status', 'l.moranbuy_visible', 'l.admin_hidden_at', 'l.admin_hidden_reason', 'l.image_url', 'l.source', 'l.updated_at', 'l.source_updated_at', 'm.business_name', 'm.registration_type', 'm.verification_status', ...flagSelect)
    .orderBy(order[0], order[1]).orderBy('l.id').limit(pageSize).offset((page - 1) * pageSize);
  const total = n((await base().count('l.id as c').first()).c);
  // Summary across all products (not only this page), so admins see the size of each problem.
  const all = () => dbImpl('listings as l').join('merchants as m', 'm.id', 'l.merchant_id').whereNull('l.deleted_at');
  const flags = {};
  for (const k of LISTING_FLAGS) flags[k] = n((await all().whereRaw(FLAGS[k](dbImpl, staleDays)).count('l.id as c').first()).c);
  const bySource = Object.fromEntries((await all().select('l.source').count('l.id as c').groupBy('l.source')).map((r) => [r.source, n(r.c)]));
  const byStatus = Object.fromEntries((await all().select('l.status').count('l.id as c').groupBy('l.status')).map((r) => [r.status, n(r.c)]));
  const categories = (await all().whereNotNull('l.category').distinct('l.category').orderBy('l.category').pluck('l.category'));
  return {
    page, pageSize, total, staleAfterDays: staleDays,
    summary: { total: n((await all().count('l.id as c').first()).c), bySource, byStatus, flags, categories },
    listings: rows.map((r) => ({
      id: r.id, merchantId: r.merchant_id, merchant: r.business_name, merchantType: r.registration_type, merchantVerified: r.verification_status === 'verified',
      name: r.name, category: r.category, productType: r.product_type, price: Number(r.price), currency: r.currency, priceStatus: r.price_status,
      stock: r.stock === null ? null : Number(r.stock), status: r.status, visible: r.moranbuy_visible && !r.admin_hidden_at, hiddenByBusiness: !r.moranbuy_visible, adminHidden: r.admin_hidden_at ? { at: r.admin_hidden_at, reason: r.admin_hidden_reason } : null, imageUrl: r.image_url, source: r.source, updatedAt: r.source_updated_at || r.updated_at,
      flags: LISTING_FLAGS.filter((k) => r[`flag_${k}`] === true),
    })),
  };
}

// Hides a product from customer search, or lifts the hide; the business keeps the product, sees the reason, and cannot undo it.
export async function setListingVisibility({ dbImpl = db, id, visible, reason, admin }) {
  const row = await dbImpl('listings').where({ id }).whereNull('deleted_at').first();
  if (!row) throw notFound('LISTING_NOT_FOUND');
  const patch = visible ? { admin_hidden_at: null, admin_hidden_reason: null, admin_hidden_by: null } : { admin_hidden_at: dbImpl.fn.now(), admin_hidden_reason: reason, admin_hidden_by: admin.email };
  const [updated] = await dbImpl('listings').where({ id }).update(patch).returning('*');
  await audit(dbImpl, { actorType: 'admin', actorId: admin.id, merchantId: row.merchant_id, action: visible ? 'listing.admin_shown' : 'listing.admin_hidden', targetType: 'listing', targetId: id, before: { adminHidden: !!row.admin_hidden_at }, after: { adminHidden: !visible }, reason });
  return updated;
}

// Every business location, filtered and paged, with what is missing for distance and delivery to work.
export async function adminLocations({ dbImpl = db, q = {} } = {}) {
  const base = () => {
    let b = dbImpl('merchant_locations as loc').join('merchants as m', 'm.id', 'loc.merchant_id').whereNull('loc.deleted_at');
    if (q.search) b = b.where((w) => w.whereILike('loc.name', `%${q.search}%`).orWhereILike('loc.formatted_address', `%${q.search}%`).orWhereILike('loc.district', `%${q.search}%`).orWhereILike('m.business_name', `%${q.search}%`));
    if (q.merchantId) b = b.where('loc.merchant_id', q.merchantId);
    if (q.region) b = q.region === '(none)' ? b.whereNull('loc.region') : b.where('loc.region', q.region);
    if (q.source) b = b.where('loc.source', q.source);
    if (q.placed === 'yes') b = b.whereNotNull('loc.latitude');
    if (q.placed === 'no') b = b.whereNull('loc.latitude');
    if (q.delivery === 'yes') b = b.where('loc.delivery_available', true);
    if (q.delivery === 'no') b = b.where('loc.delivery_available', false);
    if (q.delivery === 'unknown') b = b.whereNull('loc.delivery_available');
    return b;
  };
  const pageSize = Math.min(PAGE_MAX, q.pageSize || 50);
  const page = Math.max(1, q.page || 1);
  const rows = await base().select('loc.*', 'm.business_name', 'm.registration_type').orderBy('m.business_name').orderBy('loc.is_default', 'desc').limit(pageSize).offset((page - 1) * pageSize);
  const total = n((await base().count('loc.id as c').first()).c);
  const all = () => dbImpl('merchant_locations').whereNull('deleted_at');
  const byRegion = (await all().select(dbImpl.raw("coalesce(region, '(none)') as region")).count('id as c').select(dbImpl.raw('sum(case when latitude is null then 1 else 0 end) as unplaced')).groupBy(dbImpl.raw("coalesce(region, '(none)')")).orderBy('c', 'desc'))
    .map((r) => ({ region: r.region, locations: n(r.c), unplaced: n(r.unplaced) }));
  // Active businesses with products on sale but nowhere to measure distance from.
  const withoutLocation = await dbImpl('merchants as m').where('m.status', 'active')
    .whereExists(dbImpl('listings as l').select(dbImpl.raw('1')).whereRaw('l.merchant_id = m.id').whereNull('l.deleted_at').where('l.status', 'active'))
    .whereNotExists(dbImpl('merchant_locations as ml').select(dbImpl.raw('1')).whereRaw('ml.merchant_id = m.id').whereNull('ml.deleted_at').whereNotNull('ml.latitude'))
    .select('m.id', 'm.business_name', 'm.registration_type').orderBy('m.business_name').limit(100);
  return {
    page, pageSize, total,
    summary: {
      total: n((await all().count('id as c').first()).c), unplaced: n((await all().whereNull('latitude').count('id as c').first()).c),
      deliveryUnknown: n((await all().whereNull('delivery_available').count('id as c').first()).c), deliveryFeeUnknown: n((await all().where('delivery_available', true).whereNull('delivery_fee').count('id as c').first()).c),
      byRegion, merchantsWithoutPlacedLocation: withoutLocation.map((m) => ({ id: m.id, businessName: m.business_name, registrationType: m.registration_type })),
    },
    locations: rows.map((r) => ({
      id: r.id, merchantId: r.merchant_id, merchant: r.business_name, merchantType: r.registration_type, name: r.name, region: r.region, district: r.district, ward: r.ward,
      address: r.formatted_address || r.address, latitude: r.latitude === null ? null : Number(r.latitude), longitude: r.longitude === null ? null : Number(r.longitude),
      positionSource: r.location_source, source: r.source, isDefault: r.is_default, pickupAvailable: r.pickup_available, deliveryAvailable: r.delivery_available, deliveryFee: r.delivery_fee, deliveryRadiusKm: r.delivery_radius_km,
      issues: [r.latitude === null ? 'not_placed' : null, r.delivery_available === null ? 'delivery_unknown' : null, r.delivery_available === true && r.delivery_fee === null ? 'delivery_fee_unknown' : null, !r.region ? 'no_region' : null].filter(Boolean),
    })),
  };
}

// An admin places or corrects a pin; Moran-owned locations are corrected in Moran AI so the next import does not undo it.
export async function correctLocation({ dbImpl = db, id, latitude, longitude, region = null, district = null, reason, admin }) {
  const row = await dbImpl('merchant_locations').where({ id }).whereNull('deleted_at').first();
  if (!row) throw notFound('LOCATION_NOT_FOUND');
  if (row.source === 'moran') throw new ApiError(409, 'MORAN_OWNED_LOCATION', 'This location comes from Moran AI; correct it there and pull again, or the next import would undo the change.');
  if (latitude < -12 || latitude > 0 || longitude < 29 || longitude > 41) throw new ApiError(400, 'OUTSIDE_TANZANIA', 'That position is outside Tanzania.');
  // Region and district come from the admin, or from the address when the admin gives none.
  const place = resolvePlace([row.formatted_address, row.address, row.district, row.region].filter(Boolean).join(' '));
  const patch = { latitude, longitude, location_source: 'ADMIN', region: region || row.region || place.region, district: district || row.district || place.district, updated_at: dbImpl.fn.now() };
  const [updated] = await dbImpl('merchant_locations').where({ id }).update(patch).returning('*');
  await audit(dbImpl, { actorType: 'admin', actorId: admin.id, merchantId: row.merchant_id, action: 'location.admin_corrected', targetType: 'location', targetId: id, before: { latitude: row.latitude, longitude: row.longitude, region: row.region, district: row.district }, after: { latitude, longitude, region: patch.region, district: patch.district }, reason });
  return updated;
}

// Products as CSV for spreadsheets; values that a spreadsheet would run as a formula are neutralised.
export function listingsCsv(listings) {
  const cell = (v) => { let s = v === null || v === undefined ? '' : String(v); if (/^[=+\-@]/.test(s)) s = `'${s}`; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ['id', 'merchant', 'name', 'category', 'productType', 'price', 'currency', 'stock', 'status', 'visible', 'source', 'updatedAt', 'flags'];
  return [head.join(','), ...listings.map((l) => [l.id, l.merchant, l.name, l.category, l.productType, l.price, l.currency, l.stock, l.status, l.visible, l.source, l.updatedAt && new Date(l.updatedAt).toISOString(), l.flags.join(' ')].map(cell).join(','))].join('\n');
}
