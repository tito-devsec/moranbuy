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
import { loadConfig } from '@moranbuy/core';

const SINZA = { lat: -6.7760, lng: 39.2300, label: 'Sinza, Dar es Salaam' };
let server; let base; let moran;

before(async () => {
  await resetDatabase();
  const near = await makeMerchant({ name: 'Duka la Karibu', lat: -6.7800, lng: 39.2350, deliveryAvailable: true, deliveryFee: 10000, radiusKm: 30 });
  const far = await makeMerchant({ name: 'Duka la Mbali', lat: -6.8700, lng: 39.2800, deliveryAvailable: true, deliveryFee: 15000, radiusKm: 40 });
  const dear = await makeMerchant({ name: 'Duka Ghali', lat: -6.7790, lng: 39.2310, deliveryAvailable: true, deliveryFee: 5000, radiusKm: 30 });
  await makeListing(far.merchant.id, { name: 'Sofa ya watu watatu grey', price: 290000, attributes: { seats: 3, color: 'grey' } });
  await makeListing(near.merchant.id, { name: 'Sofa 3 seater brown', price: 320000, attributes: { seats: 3, color: 'brown' } });
  await makeListing(dear.merchant.id, { name: 'Sofa ya watu watatu leather', price: 360000, attributes: { seats: 3 } });
  await makeListing(near.merchant.id, { name: 'Kiti cha ofisi', productType: 'chair', category: 'furniture', price: 90000 });

  const cfg = loadConfig({ ...process.env, MUSE_PROVIDER: 'disabled' });
  moran = new FakeMoranInternalClient();
  const engine = new ShoppingEngine({ db, muse: new MuseClient({ cfg, db }), geocoder: new FakeGeocoder({ sinza: SINZA }) });
  setShoppingDepsForTests({ engine, moran, muse: null, geocoder: null });
  await acceptedCustomer('255712345678');
  server = createApp({ routers }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => { server.close(); await closeDatabase(); });

const post = (path, body, headers = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(path === '/api/shop/messages' && !body.customerToken ? { acceptTerms: true, ...body } : body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

test('a Swahili request with product, budget and place is matched budget-first and location-second', async () => {
  const r = await post('/api/shop/messages', { text: 'Nina TSh 350,000 ya sofa ya watu watatu. Nipo Sinza, Dar es Salaam. Nataka delivery ikiwezekana.' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.state, 'presented');
  assert.equal(r.body.museStatus, 'disabled');
  const text = r.body.replies.at(-1).text;
  assert.match(text, /1\. Sofa ya watu watatu grey - Duka la Mbali/);
  assert.match(text, /2\. Sofa 3 seater brown - Duka la Karibu/);
  assert.match(text, /3\. Sofa ya watu watatu leather - Duka Ghali.*inazidi bajeti kwa TSh 15,000/);
  assert.doesNotMatch(text, /Kiti cha ofisi/);
  const run = await fetch(`${base}/api/shop/runs/${r.body.runId}`).then((x) => x.json());
  assert.equal(run.run.candidates, 3);
  assert.equal(run.offers[0].known_total, 305000);
  assert.equal(run.offers[0].total_confirmed, true);
  assert.ok(run.offers[0].evidence_json.reasons.includes('lowest_known_total_among_suitable'));
});

test('a request missing the budget is asked one clarifying question and nothing is re-asked', async () => {
  const first = await post('/api/shop/messages', { text: 'Nataka sofa ya watu watatu, nipo Sinza' });
  assert.equal(first.body.state, 'clarifying');
  assert.match(first.body.replies[0].text, /Bajeti yako/);
  const second = await post('/api/shop/messages', { customerToken: first.body.customerToken, text: 'laki tatu' });
  assert.equal(second.body.state, 'presented');
  assert.doesNotMatch(second.body.replies.at(-1).text, /Upo wapi/);
});

test('a forwarded WhatsApp message is verified, answered through Moran, de-duplicated, and an order needs an explicit yes', async () => {
  const send = async (event) => {
    const raw = JSON.stringify(event);
    const { timestamp, signature } = signBody(process.env.MORAN_SHARED_SECRET, raw);
    return fetch(`${base}/internal/inbound`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MoranBuy-Timestamp': timestamp, 'X-MoranBuy-Signature': signature }, body: raw }).then(async (r) => ({ status: r.status, body: await r.json() }));
  };
  const bad = await fetch(`${base}/internal/inbound`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MoranBuy-Timestamp': '1', 'X-MoranBuy-Signature': 'nope' }, body: '{}' });
  assert.equal(bad.status, 401);

  const m1 = await send({ messageId: 'wamid.1', from: '255712345678', text: 'Nina laki tatu na nusu ya sofa ya watu watatu, nipo Sinza, delivery' });
  assert.equal(m1.status, 200, JSON.stringify(m1.body));
  assert.equal(m1.body.state, 'presented');
  assert.equal(moran.sent.length, 1);
  assert.equal(moran.sent[0].to, '255712345678');
  const again = await send({ messageId: 'wamid.1', from: '255712345678', text: 'Nina laki tatu na nusu ya sofa ya watu watatu, nipo Sinza, delivery' });
  assert.equal(again.body.duplicate, true);
  assert.equal(moran.sent.length, 1);

  const pick = await send({ messageId: 'wamid.2', from: '255712345678', text: '1' });
  assert.equal(pick.body.state, 'selected');
  assert.match(moran.sent.at(-1).body, /Jumla inayojulikana: TSh 305,000/);
  assert.equal(await db('orders').count('id as n').first().then((r) => Number(r.n)), 0);

  const no = await send({ messageId: 'wamid.3', from: '255712345678', text: 'hapana' });
  assert.equal(no.body.state, 'closed');
  assert.equal(await db('orders').count('id as n').first().then((r) => Number(r.n)), 0);

  await send({ messageId: 'wamid.4', from: '255712345678', text: 'Nina laki tatu na nusu ya sofa ya watu watatu, nipo Sinza, delivery' });
  await send({ messageId: 'wamid.5', from: '255712345678', text: '2' });
  const yes = await send({ messageId: 'wamid.6', from: '255712345678', text: 'ndio' });
  assert.equal(yes.body.state, 'confirmed');
  const order = await db('orders').first();
  assert.equal(order.status, 'pending_merchant');
  assert.equal(order.known_total, 330000);
  assert.equal(order.total_confirmed, true);
  assert.match(moran.sent.at(-1).body, new RegExp(`Oda ${order.order_ref}`));
  const status = await fetch(`${base}/api/shop/orders/${order.order_ref}`).then((r) => r.json());
  assert.equal(status.order.status, 'pending_merchant');
});

test('when nothing fits the budget the reply says so and offers choices instead of inventing a discount', async () => {
  const r = await post('/api/shop/messages', { text: 'I want a 3 seater sofa, budget 200k, I am in Sinza, pickup' });
  assert.equal(r.body.state, 'presented');
  const text = r.body.replies.at(-1).text;
  assert.match(text, /Nothing matched within TSh 200,000/);
  assert.match(text, /over budget by TSh 90,000/);
  assert.match(text, /cheaper alternatives/);
});

test('an image-only message without Muse configured is answered honestly with a clarification, not an invented product', async () => {
  const r = await post('/api/shop/messages', { imageUrl: 'https://example.com/sofa.jpg' });
  assert.equal(r.body.state, 'clarifying');
  assert.equal(r.body.museStatus, 'disabled');
});
