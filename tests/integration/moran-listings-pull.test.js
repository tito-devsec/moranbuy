import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, closeDatabase, db } from '../helpers/db.js';
import { pullMoranListings } from '@moranbuy/product-catalog';
import { FakeMoranInternalClient } from '@moranbuy/integrations';

before(resetDatabase);
after(closeDatabase);

const row = (over = {}) => ({ id: 'p-1', tenant_id: 'a1b2c3d4-0000-4000-8000-000000000009', service_id: 'svc-1', service_name: 'Furniture', name: 'Sofa L-shape', description: 'grey', price: 450000, currency: 'TZS', stock: 2, status: 'ACTIVE', category: 'Sofas', condition: 'new', image_url: null, sku: 'MOR-SOF-1', retailer_id: 'MOR-P-p-1', variants: [], updated_at: '2026-10-28T08:00:00Z', business_name: 'Samaki Furniture', wa_connection_status: 'connected', moranbuy_listed_at: '2026-10-27T00:00:00Z', owner_wa_number: '+255 712 000 999', owner_email: 'asha@example.com', industry: 'furniture', location_id: 'loc-1', location_name: 'Mbezi showroom', region: 'Dar es Salaam', district: 'Kinondoni', ward: 'Mbezi', formatted_address: 'Mbezi, Dar es Salaam', latitude: -6.72, longitude: 39.17, radius_meters: 25000, ...over });

test('an opted-in Moran business and its products appear by themselves, with the owner number for alerts and no sign-up', async () => {
  const moran = new FakeMoranInternalClient({ listings: [row(), row({ id: 'p-2', name: 'Dining table', price: 700000, stock: 0, status: 'OUT_OF_STOCK' })] });
  const out = await pullMoranListings(db, moran);
  assert.deepEqual([out.created, out.updated, out.merchants], [2, 0, 1]);
  const m = await db('merchants').where({ moran_tenant_id: 'a1b2c3d4-0000-4000-8000-000000000009' }).first();
  assert.equal(m.registration_type, 'moran');
  assert.equal(m.contact_phone, '255712000999');
  assert.equal(m.verification_status, 'verified');
  assert.equal(m.settings_json.autoImported, true);
  assert.equal((await db('merchant_users').where({ merchant_id: m.id }).count('id as n').first()).n, '0');
  assert.equal((await db('merchant_entitlements').where({ merchant_id: m.id, service: 'product_listing' }).first()).status, 'active');
  const loc = await db('merchant_locations').where({ merchant_id: m.id }).first();
  assert.equal(loc.is_default, true);
  assert.equal(loc.delivery_radius_km, 25);
  assert.equal(loc.delivery_fee, null);
  const state = (await db('platform_settings').where({ key: 'moran_listings_sync' }).first()).value;
  assert.ok(state.lastSince);
});

test('a second pull updates in place without duplicates, keeps MoranBuy-owned fields, and a full pass archives what is no longer listed', async () => {
  const m = await db('merchants').where({ moran_tenant_id: 'a1b2c3d4-0000-4000-8000-000000000009' }).first();
  await db('listings').where({ merchant_id: m.id, source_product_id: 'p-1' }).update({ product_type: 'sofa', attributes: JSON.stringify({ seats: 4 }) });
  const moran = new FakeMoranInternalClient({ listings: [row({ price: 440000, updated_at: '2026-10-28T09:00:00Z' })] });
  const again = await pullMoranListings(db, moran);
  assert.deepEqual([again.created, again.updated], [0, 1]);
  const rows = await db('listings').where({ merchant_id: m.id }).orderBy('source_product_id');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].price, 440000);
  assert.equal(rows[0].product_type, 'sofa');
  assert.equal(rows[0].attributes.seats, 4);
  const full = await pullMoranListings(db, moran, { full: true });
  assert.equal(full.archived, 1);
  assert.equal((await db('listings').where({ merchant_id: m.id, source_product_id: 'p-2' }).first()).status, 'archived');
  assert.equal((await db('merchants').count('id as n').first()).n, '1');
});

test('a pull that cannot reach Moran records the error and changes nothing', async () => {
  const broken = { configured: true, listings: async () => ({ ok: false, status: 'http_503', data: {} }) };
  const out = await pullMoranListings(db, broken);
  assert.equal(out.ok, false);
  assert.equal((await db('platform_settings').where({ key: 'moran_listings_sync' }).first()).value.lastError, 'http_503');
});
