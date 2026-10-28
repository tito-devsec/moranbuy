import { db } from './db.js';

// Inserts a merchant with one default location and returns the rows.
export async function makeMerchant({ name, lat = null, lng = null, deliveryAvailable = null, deliveryFee = null, radiusKm = null, verification = 'verified', registrationType = 'standalone', status = 'active', moranTenantId = null } = {}) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Math.random().toString(36).slice(2, 7);
  const [m] = await db('merchants').insert({ registration_type: registrationType, business_name: name, slug, verification_status: verification, status, moran_tenant_id: moranTenantId }).returning('*');
  const [loc] = await db('merchant_locations').insert({ merchant_id: m.id, name: `${name} shop`, latitude: lat, longitude: lng, location_source: lat !== null ? 'USER_PIN' : null, formatted_address: `${name} street`, delivery_available: deliveryAvailable, delivery_fee: deliveryFee, delivery_radius_km: radiusKm, is_default: true }).returning('*');
  return { merchant: m, location: loc };
}

// Inserts one listing for a merchant.
export async function makeListing(merchantId, { name, productType = 'sofa', category = 'furniture', price, attributes = {}, stock = 5, status = 'active', source = 'moranbuy', sourceRef = null, sourceProductId = null, imageUrl = null, updatedAt = null } = {}) {
  const [l] = await db('listings').insert({ merchant_id: merchantId, name, product_type: productType, category, price, attributes: JSON.stringify(attributes), stock, status, source, source_merchant_ref: sourceRef, source_product_id: sourceProductId, image_url: imageUrl, ...(updatedAt ? { updated_at: updatedAt, source_updated_at: updatedAt } : {}) }).returning('*');
  return l;
}

// A WhatsApp sender who already accepted the current terms, so a test can go straight to shopping.
export async function acceptedCustomer(phone, { language = 'sw' } = {}) {
  const [c] = await db('customers').insert({ channel: 'whatsapp', channel_ref: phone, language, terms_status: 'accepted', terms_version: '2026-10-28', terms_accepted_at: db.fn.now() }).onConflict(['channel', 'channel_ref']).merge({ terms_status: 'accepted', terms_version: '2026-10-28' }).returning('*');
  return c;
}
