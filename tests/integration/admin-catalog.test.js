import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, closeDatabase, db } from '../helpers/db.js';
import { makeMerchant, makeListing } from '../helpers/fixtures.js';
import { createApp } from '../../services/api/src/app.js';
import { routers } from '../../services/api/src/routers.js';
import { discoverOffers } from '@moranbuy/reverse-marketplace';
import { hashPassword, signAccessToken } from '@moranbuy/authorization';

let server; let base; let rootTok; let viewerTok; let shopTok; let near; let unplaced; let moranShop; let sofa; let oldChair; let moranSofa;
const api = (path, { method = 'GET', body, token } = {}) => fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, headers: r.headers, text: await r.clone().text(), body: await r.json().catch(() => null) }));

before(async () => {
  await resetDatabase();
  server = createApp({ routers }).listen(0); base = `http://127.0.0.1:${server.address().port}`;
  near = (await makeMerchant({ name: 'Duka la Sinza', lat: -6.776, lng: 39.23, deliveryAvailable: true, deliveryFee: null, radiusKm: 20 })).merchant;
  await db('merchant_locations').where({ merchant_id: near.id }).update({ region: 'Dar es Salaam', district: 'Kinondoni' });
  unplaced = (await makeMerchant({ name: 'Duka Bila Ramani' })).merchant;
  await db('merchant_locations').where({ merchant_id: unplaced.id }).update({ formatted_address: 'Njiro, Arusha' });
  moranShop = (await makeMerchant({ name: 'Moran Furniture', lat: -6.8, lng: 39.25, registrationType: 'moran', moranTenantId: 't-9' })).merchant;
  await db('merchant_locations').where({ merchant_id: moranShop.id }).update({ source: 'moran', region: 'Dar es Salaam' });
  sofa = await makeListing(near.id, { name: 'Sofa ya watu watatu', price: 300000, imageUrl: 'https://example.com/sofa.jpg' });
  oldChair = await makeListing(unplaced.id, { name: 'Kiti cha zamani', productType: 'chair', price: 20000, stock: null, updatedAt: new Date(Date.now() - 100 * 86400000) });
  moranSofa = await makeListing(moranShop.id, { name: '=HYPERLINK("x") Sofa', price: 450000, source: 'moran', sourceRef: 't-9', sourceProductId: 'p-1', imageUrl: 'https://example.com/m.jpg' });
  const [root] = await db('admin_users').insert({ email: 'root@moranbuy.test', name: 'Root', password_hash: await hashPassword('x'.repeat(12)), role: 'super_admin' }).returning('*');
  rootTok = signAccessToken({ type: 'admin', sub: root.id, role: 'super_admin', email: root.email });
  const [viewer] = await db('admin_users').insert({ email: 'support@moranbuy.test', name: 'Support', password_hash: await hashPassword('x'.repeat(12)), role: 'support' }).returning('*');
  viewerTok = signAccessToken({ type: 'admin', sub: viewer.id, role: viewer.role, email: viewer.email });
  const [u] = await db('merchant_users').insert({ merchant_id: near.id, email: 'sinza@example.com', name: 'O', password_hash: await hashPassword('password123') }).returning('*');
  shopTok = signAccessToken({ type: 'merchant', sub: u.id, merchantId: near.id, role: 'owner', email: u.email });
});
after(async () => { server.close(); await closeDatabase(); });

test('admins see every product across businesses, with the problems that hurt ranking named and counted', async () => {
  const r = await api('/api/admin/listings', { token: rootTok });
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 3);
  assert.equal(r.body.summary.total, 3);
  assert.deepEqual(r.body.summary.bySource, { moranbuy: 2, moran: 1 });
  const chair = r.body.listings.find((l) => l.id === oldChair.id);
  for (const f of ['stale', 'no_image', 'stock_unknown', 'no_location']) assert.ok(chair.flags.includes(f), f);
  assert.deepEqual(r.body.listings.find((l) => l.id === sofa.id).flags, []);
  assert.equal(r.body.summary.flags.no_location, 1);
  assert.equal(r.body.summary.flags.stale, 1);
  // Filters: a problem, a search across product and business names, a source, a price range, and paging.
  assert.deepEqual((await api('/api/admin/listings?flag=no_location', { token: rootTok })).body.listings.map((l) => l.id), [oldChair.id]);
  assert.equal((await api('/api/admin/listings?search=moran', { token: rootTok })).body.total, 1);
  assert.equal((await api('/api/admin/listings?source=moran', { token: rootTok })).body.listings[0].id, moranSofa.id);
  assert.equal((await api('/api/admin/listings?priceMin=100000&priceMax=350000', { token: rootTok })).body.listings[0].id, sofa.id);
  const p2 = await api('/api/admin/listings?pageSize=2&page=2&sort=price', { token: rootTok });
  assert.equal(p2.body.listings.length, 1);
  assert.equal(p2.body.listings[0].id, moranSofa.id);
  assert.equal((await api('/api/admin/listings?flag=everything', { token: rootTok })).status, 400);
});

test('the CSV export carries every match and neutralises spreadsheet formulas', async () => {
  const csv = await api('/api/admin/listings?format=csv', { token: rootTok });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const lines = csv.text.split('\n');
  assert.equal(lines.length, 4);
  assert.ok(csv.text.includes(`"'=HYPERLINK(""x"") Sofa"`));
  const viaProxy = await api('/api/admin/listings?format=csv_json&source=moranbuy', { token: rootTok });
  assert.equal(viaProxy.body.rows, 2);
  assert.ok(await db('audit_events').where({ action: 'listings.exported' }).first());
});

test('an admin hides a product from customer search with a reason; the business sees it and cannot undo it, and a Moran sync keeps it hidden', async () => {
  const before = await discoverOffers(db, { productType: 'sofa', essentialAttributes: {} });
  assert.ok(before.some((o) => o.id === sofa.id));
  assert.equal((await api(`/api/admin/listings/${sofa.id}/visibility`, { method: 'POST', token: rootTok, body: { visible: false } })).status, 400);
  const hide = await api(`/api/admin/listings/${sofa.id}/visibility`, { method: 'POST', token: rootTok, body: { visible: false, reason: 'Photo shows a different product' } });
  assert.equal(hide.status, 200);
  assert.equal(hide.body.listing.adminHidden, true);
  assert.equal(hide.body.listing.visibleToCustomers, false);
  assert.ok(!(await discoverOffers(db, { productType: 'sofa', essentialAttributes: {} })).some((o) => o.id === sofa.id));
  // The business switches its own visibility on again: still hidden, and it sees why.
  await api(`/api/merchant/listings/${sofa.id}`, { method: 'PATCH', token: shopTok, body: { moranbuyVisible: true } });
  const mine = await api(`/api/merchant/listings/${sofa.id}`, { token: shopTok });
  assert.equal(mine.body.listing.adminHidden.reason, 'Photo shows a different product');
  assert.ok(!(await discoverOffers(db, { productType: 'sofa', essentialAttributes: {} })).some((o) => o.id === sofa.id));
  const list = await api('/api/admin/listings?flag=hidden_by_admin', { token: rootTok });
  assert.deepEqual(list.body.listings.map((l) => l.id), [sofa.id]);
  assert.equal(list.body.listings[0].adminHidden.reason, 'Photo shows a different product');
  // A Moran-sourced product is hidden the same way, and a sync that rewrites the row does not clear it.
  await api(`/api/admin/listings/${moranSofa.id}/visibility`, { method: 'POST', token: rootTok, body: { visible: false, reason: 'Price looks wrong, asked the business' } });
  await db('listings').where({ id: moranSofa.id }).update({ moranbuy_visible: true, price: 460000, sync_json: JSON.stringify({ synced: true }) });
  assert.ok(!(await discoverOffers(db, { productType: 'sofa', essentialAttributes: {} })).some((o) => o.id === moranSofa.id));
  // Showing it again restores it to search.
  await api(`/api/admin/listings/${sofa.id}/visibility`, { method: 'POST', token: rootTok, body: { visible: true, reason: 'Business replaced the photo' } });
  assert.ok((await discoverOffers(db, { productType: 'sofa', essentialAttributes: {} })).some((o) => o.id === sofa.id));
  assert.equal(Number((await db('audit_events').whereIn('action', ['listing.admin_hidden', 'listing.admin_shown']).count('id as n').first()).n), 3);
});

test('admins see every location with what is missing, coverage by region, and businesses selling with no placed location', async () => {
  const r = await api('/api/admin/locations', { token: rootTok });
  assert.equal(r.status, 200);
  assert.equal(r.body.summary.total, 3);
  assert.equal(r.body.summary.unplaced, 1);
  assert.equal(r.body.summary.deliveryFeeUnknown, 1);
  assert.deepEqual(r.body.summary.merchantsWithoutPlacedLocation.map((m) => m.businessName), ['Duka Bila Ramani']);
  assert.deepEqual(r.body.summary.byRegion.find((x) => x.region === 'Dar es Salaam'), { region: 'Dar es Salaam', locations: 2, unplaced: 0 });
  const missing = r.body.locations.find((l) => l.merchantId === unplaced.id);
  assert.ok(missing.issues.includes('not_placed'));
  assert.ok(missing.issues.includes('no_region'));
  assert.ok(r.body.locations.find((l) => l.merchantId === near.id).issues.includes('delivery_fee_unknown'));
  assert.equal((await api('/api/admin/locations?placed=no', { token: rootTok })).body.total, 1);
  assert.equal((await api('/api/admin/locations?region=Dar%20es%20Salaam', { token: rootTok })).body.total, 2);
  assert.equal((await api('/api/admin/locations?region=(none)', { token: rootTok })).body.total, 1);
  assert.equal((await api('/api/admin/locations?search=sinza', { token: rootTok })).body.total, 1);
});

test('an admin places a missing pin, region and district are filled from the address, and Moran-owned or out-of-country positions are refused', async () => {
  const loc = await db('merchant_locations').where({ merchant_id: unplaced.id }).first();
  assert.equal((await api(`/api/admin/locations/${loc.id}/position`, { method: 'POST', token: rootTok, body: { latitude: 51.5, longitude: -0.12, reason: 'Pin from the owner' } })).body.error, 'OUTSIDE_TANZANIA');
  const r = await api(`/api/admin/locations/${loc.id}/position`, { method: 'POST', token: rootTok, body: { latitude: -3.39, longitude: 36.7, reason: 'Pin from the owner on the phone' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.location.positionSource, 'ADMIN');
  assert.equal(r.body.location.region, 'Arusha');
  assert.equal(r.body.location.district, 'Arusha City');
  const after = await api('/api/admin/locations', { token: rootTok });
  assert.equal(after.body.summary.unplaced, 0);
  assert.equal(after.body.summary.merchantsWithoutPlacedLocation.length, 0);
  assert.equal((await api('/api/admin/listings?flag=no_location', { token: rootTok })).body.total, 0);
  const moranLoc = await db('merchant_locations').where({ merchant_id: moranShop.id }).first();
  assert.equal((await api(`/api/admin/locations/${moranLoc.id}/position`, { method: 'POST', token: rootTok, body: { latitude: -6.7, longitude: 39.2, reason: 'Trying to move it' } })).body.error, 'MORAN_OWNED_LOCATION');
  assert.ok(await db('audit_events').where({ action: 'location.admin_corrected', target_id: loc.id }).first());
});

test('changing a product or a location needs an admin who may manage; anyone signed out is refused', async () => {
  assert.equal((await api('/api/admin/listings')).status, 401);
  const r = await api(`/api/admin/listings/${oldChair.id}/visibility`, { method: 'POST', token: viewerTok, body: { visible: false, reason: 'Not allowed to do this' } });
  assert.equal(r.status, 403);
});
