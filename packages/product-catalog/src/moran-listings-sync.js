import { audit } from '@moranbuy/observability';
import { toMsisdn } from '@moranbuy/consent-management';

// Pulls the products of every Moran business that switched on "List my products on MoranBuy"; businesses appear here by themselves, no sign-up needed.
export async function pullMoranListings(db, moran, { full = false, now = Date.now } = {}) {
  if (!moran?.configured) return { ok: false, status: 'not_configured' };
  const state = (await db('platform_settings').where({ key: 'moran_listings_sync' }).first())?.value || {};
  const since = full ? null : state.lastSince || null;
  const startedAt = new Date(now()).toISOString();
  let page = 1; let created = 0; let updated = 0; let merchantsSeen = new Set(); let archived = 0; let rows = 0;
  const seenProducts = new Set();
  while (page) {
    const r = await moran.listings({ since, page, pageSize: 200 });
    if (!r.ok) { await saveState(db, { ...state, lastRunAt: startedAt, lastError: r.status }); return { ok: false, status: r.status }; }
    for (const row of r.data?.listings || []) {
      rows += 1;
      const merchant = await upsertMoranMerchant(db, row);
      merchantsSeen.add(merchant.id);
      await upsertMoranLocation(db, merchant, row);
      const result = await upsertMoranListing(db, merchant, row);
      seenProducts.add(String(row.id));
      if (result === 'created') created += 1; else updated += 1;
    }
    page = r.data?.nextPage || null;
  }
  // A full pass sees every listed product, so anything from Moran it did not see is no longer offered: archived, never deleted.
  if (full) {
    const gone = await db('listings').where({ source: 'moran' }).whereNull('deleted_at').whereNot('status', 'archived').whereNotIn('source_product_id', [...seenProducts, '-']).whereRaw('sync_json @> ?::jsonb', [JSON.stringify({ via: 'listings_pull' })]);
    for (const g of gone) { await db('listings').where({ id: g.id }).update({ status: 'archived', synced_at: new Date(now()), sync_json: JSON.stringify({ via: 'listings_pull', archivedReason: 'no_longer_listed' }) }); archived += 1; }
  }
  const next = { lastSince: startedAt, lastRunAt: startedAt, lastFull: full ? startedAt : state.lastFull || null, lastError: null, lastCounts: { rows, created, updated, archived, merchants: merchantsSeen.size } };
  await saveState(db, next);
  await audit(db, { actorType: 'system', action: 'moran.listings_pulled', targetType: 'sync', targetId: 'moran_listings', after: next.lastCounts });
  return { ok: true, status: 'ok', ...next.lastCounts };
}

async function saveState(db, value) {
  await db('platform_settings').insert({ key: 'moran_listings_sync', value: JSON.stringify(value), updated_by: 'worker', updated_at: db.fn.now() }).onConflict('key').merge();
}

// A listed Moran business becomes a MoranBuy merchant automatically; its owner can claim it later by linking with their Moran login.
export async function upsertMoranMerchant(db, row) {
  const tenantId = String(row.tenant_id);
  const existing = await db('merchants').where({ moran_tenant_id: tenantId }).first();
  const patch = { business_name: row.business_name || existing?.business_name || 'Moran business', contact_phone: row.owner_wa_number ? toMsisdn(row.owner_wa_number) : existing?.contact_phone || null, industry: row.industry || existing?.industry || null, verification_status: row.wa_connection_status === 'connected' ? 'verified' : existing?.verification_status || 'pending', verification_json: JSON.stringify({ source: 'moran', waConnection: row.wa_connection_status || null, listedAt: row.moranbuy_listed_at || null }), updated_at: db.fn.now() };
  if (existing) { const [m] = await db('merchants').where({ id: existing.id }).update(patch).returning('*'); return m; }
  const slug = `${String(row.business_name || 'moran').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)}-${tenantId.slice(0, 6)}`;
  const [m] = await db('merchants').insert({ registration_type: 'moran', moran_tenant_id: tenantId, slug, contact_email: row.owner_email || null, settings_json: JSON.stringify({ autoImported: true }), ...patch }).returning('*');
  await db('merchant_entitlements').insert({ merchant_id: m.id, service: 'product_listing', status: 'active', billing_state: 'free', activated_at: db.fn.now(), activated_by: 'moran_listing_optin' }).onConflict(['merchant_id', 'service']).ignore();
  await audit(db, { actorType: 'system', merchantId: m.id, action: 'merchant.auto_imported_from_moran', targetType: 'merchant', targetId: m.id, after: { tenantId } });
  return m;
}

export async function upsertMoranLocation(db, merchant, row) {
  if (!row.location_id) return null;
  const radiusKm = row.radius_meters ? Math.max(1, Math.round(row.radius_meters / 1000)) : null;
  const rec = { merchant_id: merchant.id, name: row.location_name || 'Shop', region: row.region || null, district: row.district || null, ward: row.ward || null, formatted_address: row.formatted_address || null, latitude: row.latitude ?? null, longitude: row.longitude ?? null, location_source: 'IMPORTED', pickup_available: true, delivery_available: radiusKm ? true : null, delivery_radius_km: radiusKm, source: 'moran', source_location_id: String(row.location_id), updated_at: db.fn.now() };
  const hasDefault = await db('merchant_locations').where({ merchant_id: merchant.id, is_default: true }).whereNull('deleted_at').first('id', 'source_location_id');
  const [loc] = await db('merchant_locations').insert({ ...rec, is_default: !hasDefault || hasDefault.source_location_id === rec.source_location_id }).onConflict(['merchant_id', 'source', 'source_location_id']).merge(rec).returning('*');
  return loc;
}

export async function upsertMoranListing(db, merchant, row) {
  const status = String(row.status || 'ACTIVE').toLowerCase();
  const rec = { merchant_id: merchant.id, name: row.name, description: row.description || null, category: row.category || null, variants: JSON.stringify(row.variants || []), price: Math.round(Number(row.price) || 0), currency: row.currency || 'TZS', price_status: 'listed', stock: row.stock === null || row.stock === undefined ? null : Number(row.stock), condition: row.condition || 'new', status: ['active', 'inactive', 'out_of_stock', 'archived'].includes(status) ? status : 'inactive', image_url: row.image_url || null, source: 'moran', source_merchant_ref: String(row.tenant_id), source_product_id: String(row.id), source_sku: row.sku || null, source_retailer_id: row.retailer_id || null, moran_service_id: row.service_id ? String(row.service_id) : null, source_updated_at: row.updated_at || null, synced_at: db.fn.now(), sync_json: JSON.stringify({ via: 'listings_pull', service: row.service_name || null }), updated_at: db.fn.now() };
  const existing = await db('listings').where({ source: 'moran', source_merchant_ref: rec.source_merchant_ref, source_product_id: rec.source_product_id }).first('id', 'product_type');
  if (existing) { await db('listings').where({ id: existing.id }).update({ ...rec, product_type: existing.product_type || row.category || null }); return 'updated'; }
  await db('listings').insert({ ...rec, product_type: row.category || null });
  return 'created';
}
