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

// A customer answers "where are you?" by sharing their WhatsApp location: the pin is named, kept as the place, and the search runs from it.
let server; let base; let moran; let geocoder; let seq = 0;
const send = async (event) => {
  const raw = JSON.stringify({ messageId: `wamid.sl.${seq += 1}`, ...event });
  const { timestamp, signature } = signBody(process.env.MORAN_SHARED_SECRET, raw);
  return fetch(`${base}/internal/inbound`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MoranBuy-Timestamp': timestamp, 'X-MoranBuy-Signature': signature }, body: raw }).then(async (r) => ({ status: r.status, body: await r.json() }));
};
const lastTo = (to) => moran.sent.filter((m) => m.to === to).at(-1)?.body || '';

before(async () => {
  await resetDatabase();
  const shop = await makeMerchant({ name: 'Mbagala Electronics', lat: -6.9, lng: 39.27, deliveryAvailable: true, deliveryFee: 3000, radiusKm: 20 });
  await makeListing(shop.merchant.id, { name: 'Blender 1.5L', productType: 'blender', category: 'appliances', price: 70000 });
  moran = new FakeMoranInternalClient();
  geocoder = new FakeGeocoder({ mbagala: { lat: -6.9006, lng: 39.2707, label: 'Mbagala, Dar es Salaam', country: 'TZ' } });
  const engine = new ShoppingEngine({ db, muse: new MuseClient({ cfg: loadConfig({ ...process.env, MUSE_PROVIDER: 'disabled' }), db }), geocoder });
  setShoppingDepsForTests({ engine, moran, muse: null, geocoder: null });
  server = createApp({ routers }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await closeDatabase(); });

test('a shared pin with no name is named by reverse geocoding and used as the place', async () => {
  const phone = '255712600001'; await acceptedCustomer(phone);
  await send({ from: phone, text: 'I need a blender, my budget is 100,000 shillings.' });
  assert.match(lastTo(phone), /where are you/i, 'the place is asked, in English');
  const r = await send({ from: phone, kind: 'location', text: '', location: { lat: -6.9010, lng: 39.2710, label: null } });
  assert.equal(r.body.state, 'presented');
  const s = await db('shopping_sessions as s').join('customers as c', 'c.id', 's.customer_id').where('c.channel_ref', phone).orderBy('s.created_at', 'desc').first('s.request_json');
  assert.equal(s.request_json.location.source, 'customer_shared');
  assert.equal(s.request_json.location.label, 'Mbagala, Dar es Salaam');
  assert.equal(s.request_json.location.country, 'TZ');
  assert.equal(s.request_json.productType, 'blender', 'the pin never replaces the product');
  assert.match(lastTo(phone), /Blender 1\.5L/);
  assert.match(lastTo(phone), /within budget|I found/i, 'the reply stays in English after a pin with no words');
  assert.ok(geocoder.calls.some((c) => c.startsWith('reverse:')));
});
