import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, closeDatabase, db } from '../helpers/db.js';
import { makeMerchant, makeListing, acceptedCustomer } from '../helpers/fixtures.js';
import { createApp } from '../../services/api/src/app.js';
import { routers } from '../../services/api/src/routers.js';
import { setShoppingDepsForTests } from '../../services/api/src/services/shopping.js';
import { ShoppingEngine } from '@moranbuy/reverse-marketplace';
import { MuseClient } from '@moranbuy/muse-intelligence';
import { FakeGeocoder, FakeMoranInternalClient, signBody } from '@moranbuy/integrations';
import { hashPassword, signAccessToken } from '@moranbuy/authorization';
import { resolveAudience, upsertContact, recordConsent } from '@moranbuy/consent-management';
import { loadConfig } from '@moranbuy/core';

let server; let base; let moran; let shop; let shopTok; let adminTok; let sofa;
const send = (event) => { const raw = JSON.stringify(event); const s = signBody(process.env.MORAN_SHARED_SECRET, raw); return fetch(`${base}/internal/inbound`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MoranBuy-Timestamp': s.timestamp, 'X-MoranBuy-Signature': s.signature }, body: raw }).then(async (r) => ({ status: r.status, body: await r.json() })); };
const api = (path, { method = 'GET', body, token } = {}) => fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));
const lastReply = () => moran.sent.at(-1);

before(async () => {
  await resetDatabase();
  moran = new FakeMoranInternalClient();
  const cfg = loadConfig({ ...process.env, MUSE_PROVIDER: 'disabled' });
  const muse = new MuseClient({ cfg, db });
  const engine = new ShoppingEngine({ db, muse, geocoder: new FakeGeocoder({ sinza: { lat: -6.776, lng: 39.23, label: 'Sinza, Dar es Salaam' }, njiro: { lat: -3.4, lng: 36.7, label: 'Njiro, Arusha' } }) });
  setShoppingDepsForTests({ engine, moran, muse });
  for (const p of ['255700000001', '255700000002', '255700000003', '255712000111']) await acceptedCustomer(p);
  server = createApp({ routers }).listen(0); base = `http://127.0.0.1:${server.address().port}`;
  shop = (await makeMerchant({ name: 'Duka la Asha', lat: -6.78, lng: 39.235, deliveryAvailable: true, deliveryFee: 10000, radiusKm: 30 })).merchant;
  await db('merchants').where({ id: shop.id }).update({ contact_phone: '0712 000 111' });
  sofa = await makeListing(shop.id, { name: 'Sofa ya watu watatu', price: 300000, attributes: { seats: 3 } });
  const [u] = await db('merchant_users').insert({ merchant_id: shop.id, email: 'asha@example.com', name: 'Asha', password_hash: await hashPassword('password123') }).returning('*');
  shopTok = signAccessToken({ type: 'merchant', sub: u.id, merchantId: shop.id, role: 'owner', email: u.email });
  const [a] = await db('admin_users').insert({ email: 'root@moranbuy.test', name: 'Root', password_hash: await hashPassword('x'.repeat(12)), role: 'super_admin' }).returning('*');
  adminTok = signAccessToken({ type: 'admin', sub: a.id, role: 'super_admin', email: a.email });
});
after(async () => { server.close(); await closeDatabase(); });

test('every shopping message leaves a demand signal with product, budget, region and district, and the customer record follows', async () => {
  await send({ messageId: 'd1', from: '255700000001', name: 'Neema', text: 'Nina laki nne ya sofa ya watu watatu, nipo Sinza, delivery' });
  const sig = await db('demand_signals').where({ outcome: 'presented' }).orderBy('created_at', 'desc').first();
  assert.ok(sig, 'a presented signal exists');
  assert.equal(sig.product_type, 'sofa');
  assert.equal(sig.max_budget, 400000);
  assert.equal(sig.region, 'Dar es Salaam');
  assert.equal(sig.district, 'Kinondoni');
  assert.equal(sig.intent, 'shop');
  assert.equal(sig.source_kind, 'text');
  const c = await db('customers').where({ channel_ref: '255700000001' }).first();
  assert.equal(c.region, 'Dar es Salaam');
  assert.equal(c.district, 'Kinondoni');
  assert.equal(c.name, 'Neema');
  assert.equal(c.last_intent, 'shop');
  // The reply carries a description line for the option and still ranks by budget.
  assert.match(lastReply().body, /1\. Sofa ya watu watatu/);
  await send({ messageId: 'd2', from: '255700000001', text: '1' });
  const sel = await db('demand_signals').where({ outcome: 'selected' }).first();
  assert.equal(sel.merchant_id, shop.id);
  assert.equal(sel.listing_id, sofa.id);
  await send({ messageId: 'd3', from: '255700000001', text: 'ndio' });
  assert.ok(await db('demand_signals').where({ outcome: 'ordered', merchant_id: shop.id }).first());
});

test('a customer who says they will buy later gets a schedule and a later timing, and a no-match is recorded as unmet demand', async () => {
  await send({ messageId: 'd4', from: '255700000002', text: 'Nataka jokofu la laki tano, nipo Njiro Arusha, nitanunua wiki ijayo' });
  const sig = await db('demand_signals').where({ customer_id: (await db('customers').where({ channel_ref: '255700000002' }).first()).id }).orderBy('created_at', 'desc').first();
  assert.equal(sig.purchase_timing, 'later');
  assert.equal(sig.region, 'Arusha');
  assert.equal(sig.district, 'Arusha City');
  assert.equal(sig.outcome, 'no_match');
  const s = await db('customer_schedules').where({ customer_id: sig.customer_id }).first();
  assert.equal(s.kind, 'purchase_plan');
  assert.equal(s.when_text, 'wiki ijayo');
  assert.ok(new Date(s.due_at).getTime() > Date.now() + 6 * 86400000);
});

test('a voice note is shopped from its transcript, and an unreadable one is answered with a request to type', async () => {
  await send({ messageId: 'v1', from: '255700000003', kind: 'audio', text: '[Customer sent a voice note] Transcript: Nina laki nne ya sofa ya watu watatu nipo Sinza delivery' });
  const sig = await db('demand_signals').where({ source_kind: 'voice' }).first();
  assert.ok(sig);
  assert.equal(sig.product_type, 'sofa');
  assert.match(lastReply().body, /Sofa ya watu watatu/);
  await send({ messageId: 'v2', from: '255700000003', kind: 'audio', text: '[Customer sent a voice note] Transcript: [voice note received — transcription not configured]' });
  assert.match(lastReply().body, /Sikuweza kusikia sauti/);
  const m = await db('session_messages').where({ kind: 'voice' }).count('id as n').first();
  assert.equal(Number(m.n), 2);
});

test('a registered business lists a product by chat, updates it by naming it again, and is refused without a price or a name', async () => {
  let r = await send({ messageId: 'm1', from: '255712000111', text: 'Bidhaa: Meza ya kulia ya watu 6, bei laki 4 na nusu, idadi 2' });
  assert.equal(r.body.state, 'merchant_product_created');
  const listing = await db('listings').where({ merchant_id: shop.id, source: 'whatsapp_chat' }).first();
  assert.equal(listing.name, 'Meza ya kulia ya watu 6');
  assert.equal(listing.price, 450000);
  assert.equal(listing.stock, 2);
  assert.equal(listing.product_type, 'table');
  assert.equal(listing.status, 'active');
  assert.match(lastReply().body, /Imeorodheshwa: Meza ya kulia ya watu 6/);
  r = await send({ messageId: 'm2', from: '255712000111', text: 'Bidhaa: Meza ya kulia ya watu 6, bei 480000, idadi 1' });
  assert.equal(r.body.state, 'merchant_product_updated');
  const again = await db('listings').where({ id: listing.id }).first();
  assert.equal(again.price, 480000);
  assert.equal(again.stock, 1);
  assert.equal(Number((await db('listings').where({ merchant_id: shop.id, source: 'whatsapp_chat' }).count('id as n').first()).n), 1);
  r = await send({ messageId: 'm3', from: '255712000111', text: 'Bidhaa: Kabati la nguo' });
  assert.equal(r.body.state, 'merchant_product_rejected');
  assert.match(lastReply().body, /bila bei/);
  r = await send({ messageId: 'm4', from: '255712000111', imageUrl: 'https://example.com/photo.jpg', text: '' });
  assert.equal(r.body.state, 'merchant_product_rejected');
  const uploads = await db('catalog_uploads').where({ merchant_id: shop.id }).orderBy('created_at');
  assert.deepEqual(uploads.map((u) => u.status), ['created', 'updated', 'rejected', 'rejected']);
  assert.equal(uploads[3].kind, 'image');
  // The same words from a number that is not a registered business are ordinary shopping.
  r = await send({ messageId: 'm5', from: '255700000003', text: 'Bidhaa: Meza, bei 100000' });
  assert.notEqual(r.body.state.startsWith('merchant_'), true);
});

test('a business asks for its report by chat and sees the same demand overview in its dashboard; admins see the platform', async () => {
  const r = await send({ messageId: 'r1', from: '255712000111', text: 'RIPOTI' });
  assert.equal(r.body.state, 'merchant_report');
  assert.match(lastReply().body, /Duka la Asha: Siku 30 zilizopita/);
  assert.match(lastReply().body, /sofa \(/);
  const me = await api('/api/merchant/insights?days=30', { token: shopTok });
  assert.equal(me.status, 200);
  assert.equal(me.body.source, 'deterministic');
  assert.equal(me.body.stats.topProducts[0].productType, 'sofa');
  assert.equal(me.body.stats.byRegion[0].region, 'Dar es Salaam');
  assert.equal(me.body.stats.bestSellers[0].name, 'Sofa ya watu watatu');
  assert.equal(me.body.stats.orders.count, 1);
  const all = await api('/api/admin/insights?language=en', { token: adminTok });
  assert.equal(all.status, 200);
  assert.ok(all.body.stats.unmetDemand.some((u) => u.productType === 'fridge' || u.productType === 'jokofu'));
  assert.equal(all.body.stats.purchaseTiming.later, 1);
  assert.match(all.body.summary, /Last 30 days/);
  const sched = await api('/api/admin/schedules', { token: adminTok });
  assert.equal(sched.body.schedules.length, 1);
  assert.equal(sched.body.schedules[0].customer_id, undefined);
});

test('a best-fit audience keeps only consented contacts whose recent requests match the offer, strongest first', async () => {
  for (const p of ['255700000001', '255700000002', '255700000003']) { await upsertContact(db, { merchantId: shop.id, phone: p, source: 'order' }); await recordConsent(db, { merchantId: shop.id, phone: p, purpose: 'marketing', status: 'granted', source: 'test', evidenceRef: 't' }); }
  const a = await resolveAudience(db, { merchantId: shop.id, audience: { segment: 'best_fit', listingId: sofa.id, limit: 10 }, purpose: 'marketing' });
  assert.equal(a.segment, 'best_fit');
  const phones = a.included.map((i) => i.phone);
  assert.ok(phones.includes('255700000001'));
  assert.ok(phones.includes('255700000003'));
  assert.ok(!phones.includes('255700000002'), 'the fridge shopper does not fit a sofa');
  assert.equal(a.exclusionReasons.no_fit, 1);
  assert.ok(a.included[0].fit.reasons.includes('asked_for_this_product'));
  assert.ok(a.included[0].fit.reasons.includes('within_their_budget'));
  const one = await resolveAudience(db, { merchantId: shop.id, audience: { segment: 'best_fit', listingId: sofa.id, limit: 1 }, purpose: 'marketing' });
  assert.equal(one.included.length, 1);
  assert.equal(one.exclusionReasons.over_limit, 1);
});
