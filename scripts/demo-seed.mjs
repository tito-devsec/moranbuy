import '../tests/helpers/env.js';
import { db } from '../services/api/src/db/connection.js';
import { redis } from '../services/api/src/db/redis.js';
import { hashPassword } from '@moranbuy/authorization';

// Seeds the demo data from docs/demo-script.md into the configured database; safe to run twice.
async function merchant(name, loc, listings, extra = {}) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const existing = await db('merchants').where({ slug }).first();
  if (existing) return existing;
  const [m] = await db('merchants').insert({ registration_type: 'standalone', business_name: name, slug, verification_status: 'verified', ...extra }).returning('*');
  await db('merchant_users').insert({ merchant_id: m.id, email: `${slug}@demo.moranbuy.test`, name: 'Owner', password_hash: await hashPassword('demo-password-123') });
  await db('merchant_entitlements').insert({ merchant_id: m.id, service: 'product_listing', status: 'active', billing_state: 'free', activated_at: db.fn.now() });
  await db('merchant_locations').insert({ merchant_id: m.id, name: `${name} shop`, latitude: loc.lat, longitude: loc.lng, location_source: 'USER_PIN', formatted_address: loc.label, delivery_available: loc.delivery ?? null, delivery_fee: loc.fee ?? null, delivery_radius_km: loc.radius ?? null, is_default: true });
  for (const l of listings) await db('listings').insert({ merchant_id: m.id, name: l.name, product_type: l.type || 'sofa', category: 'furniture', price: l.price, stock: l.stock ?? 3, attributes: JSON.stringify(l.attributes || { seats: 3 }), image_url: l.image || null });
  return m;
}

await db.migrate.latest();
await merchant('Duka la Mbali', { lat: -6.87, lng: 39.28, label: 'Mbagala, Dar es Salaam', delivery: true, fee: 15000, radius: 40 }, [{ name: 'Sofa ya watu watatu grey', price: 290000, attributes: { seats: 3, color: 'grey' } }]);
await merchant('Duka la Karibu', { lat: -6.78, lng: 39.235, label: 'Sinza, Dar es Salaam', delivery: true, fee: 10000, radius: 30 }, [{ name: 'Sofa 3 seater brown', price: 320000, attributes: { seats: 3, color: 'brown' } }, { name: 'Kiti cha ofisi', type: 'chair', price: 90000, attributes: {} }]);
await merchant('Duka Ghali', { lat: -6.779, lng: 39.231, label: 'Sinza, Dar es Salaam', delivery: true, fee: 5000, radius: 30 }, [{ name: 'Sofa ya watu watatu leather', price: 360000, attributes: { seats: 3, material: 'leather' } }]);
await merchant('Samaki Furniture (Moran)', { lat: -6.72, lng: 39.17, label: 'Mbezi, Dar es Salaam', delivery: true, radius: 25 }, [{ name: 'Sofa L-shape', price: 450000, attributes: { seats: 4 } }], { registration_type: 'moran', moran_tenant_id: 'demo-tenant', verification_json: JSON.stringify({ waConnection: 'connected' }) });
if (!(await db('admin_users').first())) await db('admin_users').insert({ email: 'admin@demo.moranbuy.test', name: 'Demo Admin', password_hash: await hashPassword('demo-admin-password-123'), role: 'super_admin' });
await db('platform_settings').insert({ key: 'campaign_pricing', value: JSON.stringify({ providerUnitTzs: 60 }), updated_by: 'demo-seed' }).onConflict('key').ignore();
console.log('Demo data ready. Merchant sign-in: <slug>@demo.moranbuy.test / demo-password-123. Admin: admin@demo.moranbuy.test / demo-admin-password-123');
await db.destroy(); redis.disconnect();
