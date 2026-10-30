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

// The two conversations that failed on 28 and 30 October, replayed word for word through the signed WhatsApp entry point, with Muse off (the rules path).
let server; let base; let moran; let geocoder; let seq = 0;
const send = async (event) => {
  const raw = JSON.stringify({ messageId: `wamid.fc.${seq += 1}`, ...event });
  const { timestamp, signature } = signBody(process.env.MORAN_SHARED_SECRET, raw);
  return fetch(`${base}/internal/inbound`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MoranBuy-Timestamp': timestamp, 'X-MoranBuy-Signature': signature }, body: raw }).then(async (r) => ({ status: r.status, body: await r.json() }));
};
const lastTo = (to) => moran.sent.filter((m) => m.to === to).at(-1)?.body || '';
const request = async (phone) => (await db('shopping_sessions as s').join('customers as c', 'c.id', 's.customer_id').where('c.channel_ref', phone).orderBy('s.created_at', 'desc').first('s.request_json', 's.state')) || {};

before(async () => {
  await resetDatabase();
  const kariakoo = await makeMerchant({ name: 'Kariakoo Computers', lat: -6.8193, lng: 39.2737, deliveryAvailable: true, deliveryFee: 5000, radiusKm: 30 });
  await makeListing(kariakoo.merchant.id, { name: 'HP 250 G8 Core i5, 8GB RAM, 256GB SSD', productType: 'laptop', category: 'electronics', price: 340000 });
  await makeListing(kariakoo.merchant.id, { name: 'HP 15 Celeron, 4GB RAM, 128GB SSD', productType: 'laptop', category: 'electronics', price: 280000 });
  await makeListing(kariakoo.merchant.id, { name: 'Dell Latitude 5490, 8GB RAM, 256GB SSD', productType: 'laptop', category: 'electronics', price: 330000 });
  moran = new FakeMoranInternalClient();
  geocoder = new FakeGeocoder({ mbagala: { lat: -6.9006, lng: 39.2707, label: 'Mbagala, Dar es Salaam' } });
  const engine = new ShoppingEngine({ db, muse: new MuseClient({ cfg: loadConfig({ ...process.env, MUSE_PROVIDER: 'disabled' }), db }), geocoder });
  setShoppingDepsForTests({ engine, moran, muse: null, geocoder: null });
  server = createApp({ routers }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await closeDatabase(); });

test('30 Oct: the HP laptop request keeps budget 350,000, RAM and SSD minimums and the brand through a shared location and "mmbadala ni upi?"', async () => {
  const phone = '255712300030'; await acceptedCustomer(phone);
  await send({ from: phone, text: 'Me nahitaji laptop Nina laki 350000, iwe na Rami kuanzia 8 and storage SSD kuanzia 128 kampuni iwe hp' });
  let r = (await request(phone)).request_json;
  assert.equal(r.productType, 'laptop');
  assert.equal(r.maxBudget, 350000);
  assert.deepEqual(r.essentialAttributes, { ram: { min: 8 }, storage: { min: 128 }, brand: 'hp' });
  assert.match(lastTo(phone), /Upo wapi/);
  // Moran forwards the shared location with a placeholder caption.
  const loc = await send({ from: phone, text: '[Customer shared their location: -]', location: { lat: -6.9006, lng: 39.2707 } });
  assert.equal(loc.body.state, 'presented');
  r = (await request(phone)).request_json;
  assert.equal(r.productType, 'laptop', 'a location never replaces the product');
  assert.match(lastTo(phone), /HP 250 G8/);
  assert.doesNotMatch(lastTo(phone), /Celeron|Dell/, 'only HP laptops with at least 8 GB RAM and 128 GB SSD');
  await send({ from: phone, text: 'Mmbadala ni upi?' });
  r = (await request(phone)).request_json;
  assert.equal(r.productType, 'laptop', '"mmbadala ni upi?" never replaces the product');
  assert.match(lastTo(phone), /HP 250 G8/);
});

test('28 Oct: "natak laptop 350k" then "mbagala dar" searches after one question, and a place nobody can find is asked at most twice', async () => {
  const phone = '255712300028'; await acceptedCustomer(phone);
  await send({ from: phone, text: 'natak laptop 350k' });
  assert.match(lastTo(phone), /Upo wapi/);
  const placed = await send({ from: phone, text: 'mbagala dar' });
  assert.equal(placed.body.state, 'presented');
  const r = (await request(phone)).request_json;
  assert.equal(r.productType, 'laptop');
  assert.equal(r.maxBudget, 350000);
  assert.equal(r.location.label, 'Mbagala, Dar es Salaam');
  assert.match(lastTo(phone), /HP 250 G8|Dell Latitude/);

  const other = '255712300029'; await acceptedCustomer(other);
  await send({ from: other, text: 'natak laptop 350k' });
  await send({ from: other, text: 'kwa mzee juma' });
  const third = await send({ from: other, text: 'pale pale' });
  const asks = moran.sent.filter((m) => m.to === other && /Upo wapi/.test(m.body)).length;
  assert.ok(asks <= 2, `asked ${asks} times`);
  assert.equal(third.body.state, 'presented');
  assert.equal((await request(other)).request_json.productType, 'laptop');
});
