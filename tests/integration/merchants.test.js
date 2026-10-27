import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, closeDatabase, db } from '../helpers/db.js';
import { startFakeMoran } from '../helpers/fake-moran.js';
import { createApp } from '../../services/api/src/app.js';
import { routers } from '../../services/api/src/routers.js';
import { setMerchantDepsForTests } from '../../services/api/src/services/merchants.js';
import { MoranOwnerClient, FakeGeocoder } from '@moranbuy/integrations';
import { loadConfig } from '@moranbuy/core';

let server; let base; let fake;
const tenant = { id: 'a1b2c3d4-0000-4000-8000-000000000001', business_name: 'Samaki Furniture', owner_name: 'Asha', owner_email: 'asha@example.com', owner_wa_number: '+255712000000', industry: 'furniture', wa_connection_status: 'connected' };
const services = [{ id: 'svc-1', name: 'Furniture', kind: 'products' }];
const products = { 'svc-1': [
  { id: 'p-1', name: 'Sofa L-shape', description: 'Grey fabric', price: 450000, currency: 'TZS', stock: 3, status: 'ACTIVE', category: 'Sofas', sku: 'MOR-SOF-000001', retailer_id: 'MOR-P-p-1', image_url: 'https://api.moran.test/uploads/product-images/x.jpg', updated_at: '2026-10-20T00:00:00Z' },
  { id: 'p-2', name: 'Dining table 6 seats', price: 700000, currency: 'TZS', stock: 0, status: 'OUT_OF_STOCK', category: 'Tables', updated_at: '2026-10-21T00:00:00Z' },
] };
const locations = [{ id: 'loc-1', name: 'Mbezi showroom', country: 'TZ', region: 'Dar es Salaam', district: 'Kinondoni', ward: 'Mbezi', latitude: -6.72, longitude: 39.17, radiusMeters: 25000, isDefault: true }];

before(async () => {
  await resetDatabase();
  fake = await startFakeMoran({ tenant, services, productsByService: products, locations });
  const cfg = loadConfig({ ...process.env, MORAN_BACKEND_BASE_URL: fake.baseUrl });
  setMerchantDepsForTests({ moran: new MoranOwnerClient({ cfg }), geocoder: new FakeGeocoder({ sinza: { lat: -6.776, lng: 39.23, label: 'Sinza, Dar es Salaam' } }) });
  server = createApp({ routers }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await fake.close(); await closeDatabase(); });

const api = (path, { method = 'GET', body, token } = {}) => fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));

let aToken; let bToken; let aListingId; let aLocationId; let moranToken;

test('a standalone merchant registers, gets the free listing service, and paid services stay unactivated', async () => {
  const r = await api('/api/merchants/auth/register', { method: 'POST', body: { businessName: 'Duka la Juma', ownerName: 'Juma', email: 'juma@example.com', password: 'password123', services: ['campaign_engine'] } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  aToken = r.body.accessToken;
  const ent = Object.fromEntries(r.body.entitlements.map((e) => [e.service, e]));
  assert.equal(ent.product_listing.status, 'active');
  assert.equal(ent.campaign_engine.status, 'pending_payment');
  assert.equal(ent.campaign_engine.billing_state, 'unpaid');
  const dup = await api('/api/merchants/auth/register', { method: 'POST', body: { businessName: 'Duka Jingine', ownerName: 'Mtu', email: 'juma@example.com', password: 'password123' } });
  assert.equal(dup.status, 409);
  const b = await api('/api/merchants/auth/register', { method: 'POST', body: { businessName: 'Duka la Bakari', ownerName: 'Bakari', email: 'bakari@example.com', password: 'password123' } });
  bToken = b.body.accessToken;
});

test('an unactivated paid service is refused on the server even though it was selected', async () => {
  const r = await api('/api/merchant/entitlements/campaign_engine/check', { token: aToken });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'SERVICE_NOT_ACTIVE');
});

test('a standalone merchant adds a location and a listing; a missing address gives no coordinates, never a guess', async () => {
  const loc = await api('/api/merchant/locations', { method: 'POST', token: aToken, body: { name: 'Duka Sinza', region: 'Dar es Salaam', district: 'Ubungo', ward: 'Sinza', deliveryAvailable: true, deliveryFee: 8000, deliveryRadiusKm: 20 } });
  assert.equal(loc.status, 201, JSON.stringify(loc.body));
  assert.equal(loc.body.location.latitude, -6.776);
  assert.equal(loc.body.location.source, 'GEOCODED');
  assert.equal(loc.body.location.isDefault, true);
  aLocationId = loc.body.location.id;
  const nowhere = await api('/api/merchant/locations', { method: 'POST', token: aToken, body: { name: 'Branch', address: 'Nowhere Street 9' } });
  assert.equal(nowhere.body.location.latitude, null);
  assert.equal(nowhere.body.location.positionFound, false);
  const l = await api('/api/merchant/listings', { method: 'POST', token: aToken, body: { name: 'Sofa ya watu watatu', productType: 'sofa', category: 'furniture', price: 300000, stock: 2, attributes: { seats: 3 }, locationIds: [aLocationId] } });
  assert.equal(l.status, 201, JSON.stringify(l.body));
  aListingId = l.body.listing.id;
  assert.deepEqual(l.body.listing.locationIds, [aLocationId]);
  const zero = await api(`/api/merchant/listings/${aListingId}`, { method: 'PATCH', token: aToken, body: { stock: 0 } });
  assert.equal(zero.body.listing.status, 'out_of_stock');
});

test('tenant boundaries: another merchant cannot read, edit, delete or link to this merchant\'s records', async () => {
  assert.equal((await api(`/api/merchant/listings/${aListingId}`, { token: bToken })).status, 404);
  assert.equal((await api(`/api/merchant/listings/${aListingId}`, { method: 'PATCH', token: bToken, body: { price: 1 } })).status, 404);
  assert.equal((await api(`/api/merchant/listings/${aListingId}`, { method: 'DELETE', token: bToken })).status, 404);
  const steal = await api('/api/merchant/listings', { method: 'POST', token: bToken, body: { name: 'X', price: 10, locationIds: [aLocationId] } });
  assert.equal(steal.status, 400);
  assert.equal((await api('/api/merchant/listings', { token: aToken })).body.listings.length, 1);
  assert.equal((await api('/api/merchant/listings')).status, 401);
});

test('a Moran AI owner links with their own credentials and existing products and locations are imported, not re-uploaded', async () => {
  const bad = await api('/api/merchants/auth/link-moran', { method: 'POST', body: { email: 'asha@example.com', password: 'wrong' } });
  assert.equal(bad.status, 401);
  const r = await api('/api/merchants/auth/link-moran', { method: 'POST', body: { email: 'asha@example.com', password: 'moran-pass' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  moranToken = r.body.accessToken;
  assert.equal(r.body.merchant.registrationType, 'moran');
  assert.equal(r.body.merchant.moranTenantId, tenant.id);
  assert.equal(r.body.merchant.verificationStatus, 'verified');
  const sync = await api('/api/merchant/sync/moran', { method: 'POST', token: moranToken });
  assert.equal(sync.status, 200, JSON.stringify(sync.body));
  assert.deepEqual(sync.body.products, { created: 2, updated: 0, archived: 0, errors: [] });
  assert.equal(sync.body.locations.imported, 1);
  const list = await api('/api/merchant/listings', { token: moranToken });
  const sofa = list.body.listings.find((l) => l.name === 'Sofa L-shape');
  assert.equal(sofa.source, 'moran');
  assert.equal(sofa.sourceProductId, 'p-1');
  assert.equal(sofa.sourceSku, 'MOR-SOF-000001');
  assert.deepEqual(sofa.editable.viaMoran.includes('price'), true);
  const locs = await api('/api/merchant/locations', { token: moranToken });
  assert.equal(locs.body.locations[0].deliveryRadiusKm, 25);
  assert.equal(locs.body.locations[0].deliveryFee, null);
  assert.equal(locs.body.locations[0].origin, 'moran');
});

test('a second sync updates in place with no duplicates, and products gone from Moran are archived', async () => {
  fake.state.products['svc-1'][0].price = 440000;
  fake.state.products['svc-1'].pop();
  const sync = await api('/api/merchant/sync/moran', { method: 'POST', token: moranToken });
  assert.deepEqual(sync.body.products, { created: 0, updated: 1, archived: 1, errors: [] });
  const rows = await db('listings').where({ source: 'moran', source_merchant_ref: tenant.id });
  assert.equal(rows.length, 2);
  assert.equal(rows.find((x) => x.source_product_id === 'p-1').price, 440000);
  assert.equal(rows.find((x) => x.source_product_id === 'p-2').status, 'archived');
  const again = await api('/api/merchants/auth/link-moran', { method: 'POST', body: { email: 'asha@example.com', password: 'moran-pass' } });
  assert.equal(again.status, 201);
  assert.equal((await db('merchants').where({ moran_tenant_id: tenant.id }).count('id as n').first()).n, '1');
});

test('source of truth: Moran-owned fields are refused locally and go to Moran with the merchant\'s own token; MoranBuy fields stay local', async () => {
  const list = await api('/api/merchant/listings', { token: moranToken });
  const sofa = list.body.listings.find((l) => l.sourceProductId === 'p-1');
  const local = await api(`/api/merchant/listings/${sofa.id}`, { method: 'PATCH', token: moranToken, body: { price: 1 } });
  assert.equal(local.status, 409);
  assert.equal(local.body.error, 'FIELD_OWNED_BY_MORAN');
  const ours = await api(`/api/merchant/listings/${sofa.id}`, { method: 'PATCH', token: moranToken, body: { productType: 'sofa', attributes: { seats: 4 }, moranbuyVisible: false } });
  assert.equal(ours.status, 200);
  assert.equal(ours.body.listing.attributes.seats, 4);
  const via = await api(`/api/merchant/listings/${sofa.id}/moran`, { method: 'PATCH', token: moranToken, body: { price: 430000 } });
  assert.equal(via.status, 200, JSON.stringify(via.body));
  assert.equal(via.body.listing.price, 430000);
  assert.equal(via.body.listing.attributes.seats, 4);
  assert.deepEqual(fake.state.patches.at(-1), { id: 'p-1', patch: { price: 430000 } });
  assert.ok(fake.state.refreshCount >= 1);
  assert.equal((await api(`/api/merchant/listings/${sofa.id}`, { method: 'DELETE', token: moranToken })).status, 409);
});

test('every standalone merchant is recorded with its registration type for the admin to see', async () => {
  const rows = await db('merchants').select('business_name', 'registration_type', 'verification_status').orderBy('created_at');
  assert.deepEqual(rows.map((r) => r.registration_type), ['standalone', 'standalone', 'moran']);
  assert.equal(rows[0].verification_status, 'unverified');
});

test('a Moran account protected by two-factor sign-in is linked after the code', async () => {
  const tf = await startFakeMoran({ tenant: { ...tenant, id: 'a1b2c3d4-0000-4000-8000-000000000002', owner_email: 'two@example.com', business_name: 'Two FA Shop' }, services, twoFactor: true });
  setMerchantDepsForTests({ moran: new MoranOwnerClient({ cfg: loadConfig({ ...process.env, MORAN_BACKEND_BASE_URL: tf.baseUrl }) }), geocoder: new FakeGeocoder() });
  const first = await api('/api/merchants/auth/link-moran', { method: 'POST', body: { email: 'two@example.com', password: 'moran-pass' } });
  assert.equal(first.status, 202);
  assert.equal(first.body.twoFactorRequired, true);
  const second = await api('/api/merchants/auth/link-moran', { method: 'POST', body: { twoFactorToken: first.body.twoFactorToken, twoFactorCode: '123456' } });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  await tf.close();
});
