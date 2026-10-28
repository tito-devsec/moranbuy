// Finds candidate listings for a request from MoranBuy's database and shapes them into offers for the ranking engine.
const tokens = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);

export async function discoverOffers(db, request, { limit = 200 } = {}) {
  const words = [...new Set([...tokens(request.productType), ...tokens(request.category), ...Object.values(request.essentialAttributes || {}).flatMap((v) => tokens(typeof v === 'object' ? '' : v))])];
  let q = db('listings as l')
    .join('merchants as m', 'm.id', 'l.merchant_id')
    .leftJoin('merchant_locations as loc', function j() { this.on('loc.merchant_id', 'm.id').andOn('loc.is_default', db.raw('true')).andOnNull('loc.deleted_at'); })
    .whereNull('l.deleted_at')
    .where('l.moranbuy_visible', true)
    .whereNull('l.admin_hidden_at')
    .where('m.status', 'active')
    .select('l.*', 'm.business_name', 'm.status as merchant_status', 'm.verification_status', 'm.registration_type',
      'loc.id as location_id', 'loc.latitude', 'loc.longitude', 'loc.formatted_address', 'loc.region', 'loc.district', 'loc.ward',
      'loc.pickup_available', 'loc.delivery_available', 'loc.delivery_radius_km', 'loc.delivery_fee')
    .limit(limit);
  if (words.length) {
    q = q.where(function w() {
      for (const word of words) {
        this.orWhereRaw("to_tsvector('simple', coalesce(l.name,'') || ' ' || coalesce(l.category,'') || ' ' || coalesce(l.product_type,'') || ' ' || coalesce(l.description,'')) @@ plainto_tsquery('simple', ?)", [word]);
        this.orWhereILike('l.name', `%${word}%`).orWhereILike('l.product_type', `%${word}%`).orWhereILike('l.category', `%${word}%`);
      }
    });
  }
  const rows = await q;
  return rows.map(rowToOffer);
}

// Shapes one database row into the offer object the ranking engine reads; unknowns stay null.
export function rowToOffer(r) {
  const hasCoords = r.latitude !== null && r.latitude !== undefined && r.longitude !== null && r.longitude !== undefined;
  return {
    id: r.id,
    merchantId: r.merchant_id,
    merchantName: r.business_name,
    merchantStatus: r.merchant_status,
    merchantVerified: r.verification_status === 'verified',
    source: r.source,
    sourceKey: r.source === 'moranbuy' ? null : `${r.source}:${r.source_merchant_ref}:${r.source_product_id}`,
    name: r.name,
    description: r.description,
    category: r.category,
    productType: r.product_type,
    attributes: r.attributes || {},
    variants: Array.isArray(r.variants) ? r.variants : [],
    price: Number(r.price),
    currency: r.currency,
    priceVerified: r.price_status === 'verified',
    stock: r.stock === null || r.stock === undefined ? null : Number(r.stock),
    status: r.status,
    imageUrl: r.image_url,
    updatedAt: r.source_updated_at || r.updated_at,
    deletedAt: r.deleted_at,
    locationId: r.location_id || null,
    location: hasCoords ? { lat: Number(r.latitude), lng: Number(r.longitude), label: r.formatted_address || [r.ward, r.district, r.region].filter(Boolean).join(', ') } : (r.formatted_address || r.region ? { label: r.formatted_address || [r.ward, r.district, r.region].filter(Boolean).join(', ') } : null),
    delivery: { available: r.delivery_available ?? null, fee: r.delivery_fee ?? null, radiusKm: r.delivery_radius_km ?? null },
    pickup: r.pickup_available ?? null,
  };
}
