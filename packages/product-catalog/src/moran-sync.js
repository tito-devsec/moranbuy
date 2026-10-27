import { audit } from '@moranbuy/observability';

// Maps a Moran product row (as the owner API returns it) onto a listing; unknown fields stay null.
export function moranProductToListing(p, { tenantId, serviceId }) {
  const status = p.deleted_at ? 'archived' : String(p.status || (p.is_active === false ? 'INACTIVE' : 'ACTIVE')).toLowerCase();
  return {
    name: p.name, description: p.description || null, category: p.category || null, product_type: p.product_type || p.category || null,
    attributes: JSON.stringify(p.attributes || {}), variants: JSON.stringify(p.variants || []), price: Math.round(Number(p.price) || 0), currency: p.currency || 'TZS',
    price_status: 'listed', stock: p.stock === null || p.stock === undefined ? null : Number(p.stock), condition: p.condition || 'new',
    status: ['active', 'inactive', 'out_of_stock', 'archived'].includes(status) ? status : 'inactive', image_url: p.image_url || null,
    source: 'moran', source_merchant_ref: String(tenantId), source_product_id: String(p.id), source_sku: p.sku || null, source_retailer_id: p.retailer_id || null,
    moran_service_id: serviceId ? String(serviceId) : null, source_updated_at: p.updated_at || null, synced_at: new Date(), deleted_at: p.deleted_at || null,
  };
}

// Imports or refreshes every product of every Moran service of a linked merchant; keyed by source ids so a second run updates, never duplicates.
export async function syncMoranProducts(db, moran, merchant, accessToken, { actorId = null } = {}) {
  const services = merchant.moran_services_json?.length ? merchant.moran_services_json : [{ id: null, name: 'default' }];
  const seen = new Set();
  let created = 0; let updated = 0; let archived = 0; const errors = [];
  for (const service of services) {
    const res = await moran.products(accessToken, service.id);
    if (!res.ok) { errors.push({ serviceId: service.id, status: res.status, error: res.data?.error || null }); continue; }
    const products = res.data?.products || res.data?.items || (Array.isArray(res.data) ? res.data : []);
    for (const p of products) {
      const row = moranProductToListing(p, { tenantId: merchant.moran_tenant_id, serviceId: service.id });
      seen.add(row.source_product_id);
      const existing = await db('listings').where({ source: 'moran', source_merchant_ref: row.source_merchant_ref, source_product_id: row.source_product_id }).first('id', 'moranbuy_visible', 'product_type', 'attributes');
      if (existing) {
        // MoranBuy-owned fields are kept; Moran-owned ones are refreshed.
        const { product_type, attributes, ...moranOwned } = row;
        await db('listings').where({ id: existing.id }).update({ ...moranOwned, product_type: existing.product_type || product_type, updated_at: db.fn.now() });
        updated += 1;
      } else {
        await db('listings').insert({ merchant_id: merchant.id, ...row });
        created += 1;
      }
    }
  }
  // Products Moran no longer returns are archived here, never deleted, so history and orders keep their reference.
  if (!errors.length) {
    const gone = await db('listings').where({ merchant_id: merchant.id, source: 'moran' }).whereNull('deleted_at').whereNot('status', 'archived').whereNotIn('source_product_id', [...seen]);
    for (const g of gone) { await db('listings').where({ id: g.id }).update({ status: 'archived', synced_at: new Date(), sync_json: JSON.stringify({ archivedReason: 'missing_from_moran' }) }); archived += 1; }
  }
  await db('merchants').where({ id: merchant.id }).update({ products_synced_at: db.fn.now() });
  await audit(db, { actorType: actorId ? 'merchant' : 'system', actorId, merchantId: merchant.id, action: 'moran.products_synced', targetType: 'merchant', targetId: merchant.id, after: { created, updated, archived, errors: errors.length } });
  return { created, updated, archived, errors };
}

// Imports a linked merchant's Moran locations as read-only MoranBuy locations; delivery facts come only from Moran's radius.
export async function syncMoranLocations(db, moran, merchant, accessToken) {
  const res = await moran.locations(accessToken);
  if (!res.ok) return { imported: 0, error: res.data?.error || `http_${res.status}` };
  const rows = res.data?.locations || (Array.isArray(res.data) ? res.data : []);
  let imported = 0;
  for (const l of rows) {
    const radiusKm = l.radiusMeters ? Math.max(1, Math.round(l.radiusMeters / 1000)) : null;
    const row = {
      merchant_id: merchant.id, name: l.name || 'Shop', country: (l.country || 'TZ').toUpperCase(), region: l.region || null, district: l.district || null, ward: l.ward || null, street: l.street || null, address: l.address || null,
      formatted_address: l.formattedAddress || null, latitude: l.latitude ?? null, longitude: l.longitude ?? null, location_source: 'IMPORTED', pickup_available: true,
      delivery_available: radiusKm ? true : null, delivery_radius_km: radiusKm, is_default: !!l.isDefault, source: 'moran', source_location_id: String(l.id), updated_at: db.fn.now(),
    };
    if (row.is_default) await db('merchant_locations').where({ merchant_id: merchant.id }).update({ is_default: false });
    await db('merchant_locations').insert(row).onConflict(['merchant_id', 'source', 'source_location_id']).merge();
    imported += 1;
  }
  return { imported, error: null };
}
