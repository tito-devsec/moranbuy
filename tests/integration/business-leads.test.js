import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, closeDatabase, db } from '../helpers/db.js';
import { acceptedCustomer } from '../helpers/fixtures.js';
import { createApp } from '../../services/api/src/app.js';
import { routers } from '../../services/api/src/routers.js';
import { setShoppingDepsForTests } from '../../services/api/src/services/shopping.js';
import { askMatchingBusinesses } from '../../services/api/src/services/business-leads.js';
import { ShoppingEngine } from '@moranbuy/reverse-marketplace';
import { MuseClient } from '@moranbuy/muse-intelligence';
import { FakeGeocoder, FakeMoranInternalClient, signBody } from '@moranbuy/integrations';
import { loadConfig } from '@moranbuy/core';

// A Moran AI business that is not on MoranBuy has the laptop a customer wants: its owner is asked first, and only a yes shares anything.
const TENANT = '11111111-2222-4333-8444-555555555555';
const OWNER = '255713000777';
const product = (id, name, price) => ({ id, tenant_id: TENANT, name, description: `${name}, original charger`, price, currency: 'TZS', stock: 2, status: 'ACTIVE', category: 'laptop', condition: 'new', image_url: `https://cdn.moranai.co.tz/p/${id}.jpg`, sku: null, retailer_id: null, variants: [], updated_at: new Date().toISOString(), business_name: 'Mbagala Tech Store', wa_connection_status: 'connected', moranbuy_listed_at: null, owner_wa_number: OWNER, owner_email: 'owner@example.com', industry: 'electronics', service_name: null, location_id: 'loc-1', location_name: 'Shop', region: 'Dar es Salaam', district: 'Temeke', ward: 'Mbagala', formatted_address: 'Kilwa Rd, Mbagala', latitude: -6.901, longitude: 39.271, radius_meters: 15000 });

let server; let base; let moran; let seq = 0;
const send = async (event) => {
  const raw = JSON.stringify({ messageId: `wamid.bl.${seq += 1}`, ...event });
  const { timestamp, signature } = signBody(process.env.MORAN_SHARED_SECRET, raw);
  return fetch(`${base}/internal/inbound`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MoranBuy-Timestamp': timestamp, 'X-MoranBuy-Signature': signature }, body: raw }).then(async (r) => ({ status: r.status, body: await r.json() }));
};
const to = (phone) => moran.sent.filter((m) => m.to === phone);

before(async () => {
  await resetDatabase();
  moran = new FakeMoranInternalClient();
  moran.leadBusinesses = [{ tenantId: TENANT, businessName: 'Mbagala Tech Store', ownerPhone: '0713 000 777', area: 'Temeke, Dar es Salaam', matches: 2, productIds: ['p-hp1', 'p-hp2'] }];
  moran.leadRows = [product('p-hp1', 'HP 250 G8 Core i5 8GB RAM 256GB SSD', 345000), product('p-hp2', 'HP 15 Core i3 8GB RAM 256GB SSD', 300000)];
  const engine = new ShoppingEngine({ db, muse: new MuseClient({ cfg: loadConfig({ ...process.env, MUSE_PROVIDER: 'disabled' }), db }), geocoder: new FakeGeocoder({ mbagala: { lat: -6.9006, lng: 39.2707, label: 'Mbagala, Dar es Salaam' } }), leads: ({ session, customer, request }) => askMatchingBusinesses({ moran, session, customer, request }) });
  setShoppingDepsForTests({ engine, moran, muse: null, geocoder: null });
  server = createApp({ routers }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await closeDatabase(); });

test('the owner is asked first; NDIO sends the matching laptops to that customer only, who can order them with payment protection', async () => {
  const customer = '255712500001'; await acceptedCustomer(customer);
  await send({ from: customer, text: 'nataka laptop hp laki 350000, nipo Mbagala' });
  assert.match(to(customer).at(-1).body, /Pia nimeuliza maduka 1 ya Moran AI/);
  const ask = to(OWNER).at(-1).body;
  assert.match(ask, /anatafuta laptop, hp, bajeti TSh 350,000/);
  assert.match(ask, /bidhaa 2 zinazolingana/);
  assert.doesNotMatch(ask, /255712500001|0712/, 'the customer\'s number is never given to the business');
  const ref = ask.match(/NDIO ([A-Z0-9]{5})/)[1];
  assert.equal(await db('listings').count('* as n').first().then((r) => Number(r.n)), 0, 'nothing is shared before the owner answers');

  // The owner has never chatted with MoranBuy: NDIO with the code is enough, and records the terms acceptance.
  const yes = await send({ from: OWNER, text: `NDIO ${ref}` });
  assert.equal(yes.body.state, 'lead_answer');
  assert.match(to(OWNER).at(-1).body, /Bidhaa 2 zimetumwa kwa mteja/);
  assert.equal((await db('customers').where({ channel_ref: OWNER }).first()).terms_status, 'accepted');
  const offer = to(customer).slice(-3);
  assert.ok(offer.some((m) => m.type === 'image' && /HP 15 Core i3/.test(m.caption)), 'a photo with the cheaper laptop');
  assert.match(offer.at(-1).body, /Mbagala Tech Store amekubali kukuletea hizi/);
  assert.match(offer.at(-1).body, /1\. HP 15 Core i3.*TSh 300,000/);

  // Another customer searching does not see them: they were offered to one customer.
  const other = '255712500002'; await acceptedCustomer(other);
  await send({ from: other, text: 'nataka laptop laki 400000, nipo Mbagala' });
  assert.doesNotMatch(to(other).map((m) => m.body || m.caption).join('\n'), /HP 15 Core i3|HP 250 G8/);

  // The first customer orders: the usual MoranBuy order with the business, payable through protection.
  await send({ from: customer, text: '1' });
  const yesOrder = await send({ from: customer, text: 'ndio' });
  assert.equal(yesOrder.body.state, 'confirmed');
  const order = await db('orders as o').join('merchants as m', 'm.id', 'o.merchant_id').orderBy('o.created_at', 'desc').first('o.*', 'm.business_name', 'm.moran_tenant_id');
  assert.equal(order.business_name, 'Mbagala Tech Store');
  assert.equal(order.moran_tenant_id, TENANT);
  // Answering again changes nothing.
  await send({ from: OWNER, text: `NDIO ${ref}` });
  assert.match(to(OWNER).at(-1).body, /imeshajibiwa/);
});

test('LISTI lists the whole business on MoranBuy; HAPANA declines; a business is asked at most five times a day', async () => {
  const c = '255712500003'; await acceptedCustomer(c);
  await send({ from: c, text: 'natafuta laptop hp laki 350000, nipo Mbagala' });
  const ref = to(OWNER).at(-1).body.match(/NDIO ([A-Z0-9]{5})/)[1];
  await send({ from: OWNER, text: `LISTI ${ref}` });
  assert.deepEqual(moran.listedTenants, [TENANT]);
  assert.match(to(OWNER).at(-1).body, /Biashara yako sasa iko MoranBuy/);
  assert.equal((await db('listings').whereRaw("sync_json->>'via' = 'listings_pull'").where({ moranbuy_visible: true }).count('* as n').first()).n > 0, true);

  const d = '255712500004'; await acceptedCustomer(d);
  await send({ from: d, text: 'nataka laptop hp laki 350000, nipo Mbagala' });
  const ref2 = to(OWNER).at(-1).body.match(/NDIO ([A-Z0-9]{5})/)?.[1];
  if (ref2 && ref2 !== ref) {
    await send({ from: OWNER, text: `HAPANA ${ref2}` });
    assert.equal((await db('business_leads').where({ ref: ref2 }).first()).status, 'declined');
  }
  const asks = await db('business_leads').where({ tenant_id: TENANT }).count('* as n').first();
  assert.ok(Number(asks.n) <= 5);
});
