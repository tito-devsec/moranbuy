import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, closeDatabase, db } from '../helpers/db.js';
import { makeMerchant, makeListing } from '../helpers/fixtures.js';
import { createApp } from '../../services/api/src/app.js';
import { routers } from '../../services/api/src/routers.js';
import { setShoppingDepsForTests } from '../../services/api/src/services/shopping.js';
import { notifyMerchantOfOrder } from '../../services/api/src/services/merchant-notify.js';
import { ShoppingEngine } from '@moranbuy/reverse-marketplace';
import { MuseClient } from '@moranbuy/muse-intelligence';
import { FakeGeocoder, FakeMoranInternalClient, signBody } from '@moranbuy/integrations';
import { hashPassword, signAccessToken } from '@moranbuy/authorization';
import { loadConfig } from '@moranbuy/core';

let server; let base; let moran; let unregistered; let registered; let regTok;
const send = async (event) => { const raw = JSON.stringify(event); const s = signBody(process.env.MORAN_SHARED_SECRET, raw); return fetch(`${base}/internal/inbound`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MoranBuy-Timestamp': s.timestamp, 'X-MoranBuy-Signature': s.signature }, body: raw }).then((r) => r.json()); };
const api = (path, { method = 'GET', body, token } = {}) => fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));

before(async () => {
  await resetDatabase();
  moran = new FakeMoranInternalClient();
  const cfg = loadConfig({ ...process.env, MUSE_PROVIDER: 'disabled' });
  const engine = new ShoppingEngine({ db, muse: new MuseClient({ cfg, db }), geocoder: new FakeGeocoder({ sinza: { lat: -6.776, lng: 39.23, label: 'Sinza' } }), onOrderConfirmed: (order) => notifyMerchantOfOrder({ moran, order }) });
  setShoppingDepsForTests({ engine, moran });
  server = createApp({ routers }).listen(0); base = `http://127.0.0.1:${server.address().port}`;
  unregistered = (await makeMerchant({ name: 'Duka Bila Dashboard', lat: -6.78, lng: 39.235, deliveryAvailable: true, deliveryFee: null, radiusKm: 30, registrationType: 'moran', moranTenantId: 'tenant-u' })).merchant;
  await db('merchants').where({ id: unregistered.id }).update({ contact_phone: '255712000111' });
  await makeListing(unregistered.id, { name: 'Sofa ya watu watatu', price: 300000, attributes: { seats: 3 } });
  registered = (await makeMerchant({ name: 'Duka Lenye Dashboard', lat: -6.90, lng: 39.30, deliveryAvailable: true, deliveryFee: 20000, radiusKm: 30 })).merchant;
  await db('merchants').where({ id: registered.id }).update({ contact_phone: '255712000222' });
  await makeListing(registered.id, { name: 'Sofa ya watu watatu deluxe', price: 340000, attributes: { seats: 3 } });
  const [u] = await db('merchant_users').insert({ merchant_id: registered.id, email: 'r@example.com', name: 'R', password_hash: await hashPassword('password123') }).returning('*');
  regTok = signAccessToken({ type: 'merchant', sub: u.id, merchantId: registered.id, role: 'owner', email: u.email });
});
after(async () => { server.close(); await closeDatabase(); });

async function orderFrom(phone, option) {
  await send({ messageId: `${phone}-1`, from: phone, text: 'Nina laki nne ya sofa ya watu watatu, nipo Sinza, delivery' });
  await send({ messageId: `${phone}-2`, from: phone, text: option });
  return send({ messageId: `${phone}-3`, from: phone, text: 'ndio' });
}

test('a business without a dashboard is told to reply, accepts by WhatsApp with the delivery fee, and the customer is told', async () => {
  await orderFrom('255700000001', '1');
  const alert = moran.sent.find((m) => m.to === '255712000111');
  assert.match(alert.body, /Jibu KUBALI MB-[A-Z0-9]+ \(ongeza ada ya delivery/);
  assert.doesNotMatch(alert.body, /fungua MoranBuy/i);
  const order = await db('orders').where({ merchant_id: unregistered.id }).first();
  assert.equal(order.total_confirmed, false);
  const wrong = await send({ messageId: 'w1', from: '255799999999', text: `KUBALI ${order.order_ref} 15000` });
  assert.equal(wrong.state, 'order_reply_rejected');
  assert.equal((await db('orders').where({ id: order.id }).first()).status, 'pending_merchant');
  const ok = await send({ messageId: 'w2', from: '255712000111', text: `kubali ${order.order_ref} 15,000` });
  assert.equal(ok.state, 'order_accepted');
  const updated = await db('orders').where({ id: order.id }).first();
  assert.equal(updated.status, 'accepted');
  assert.equal(updated.delivery_fee, 15000);
  assert.equal(updated.known_total, 315000);
  assert.equal(updated.total_confirmed, true);
  const toCustomer = moran.sent.filter((m) => m.to === '255700000001').at(-1);
  assert.match(toCustomer.body, /imeikubali\. Jumla TSh 315,000/);
  const toMerchant = moran.sent.filter((m) => m.to === '255712000111').at(-1);
  assert.match(toMerchant.body, /sasa: accepted, delivery TSh 15,000/);
  const twice = await send({ messageId: 'w3', from: '255712000111', text: `KUBALI ${order.order_ref}` });
  assert.match(moran.sent.filter((m) => m.to === '255712000111').at(-1).body, /cannot become accepted/);
  assert.equal(twice.state, 'order_reply_rejected');
});

test('a registered business is told it may reply or open the dashboard; a dashboard decision also tells the customer', async () => {
  await orderFrom('255700000002', '2');
  const alert = moran.sent.filter((m) => m.to === '255712000222').at(-1);
  assert.match(alert.body, /Au fungua MoranBuy/);
  const order = await db('orders').where({ merchant_id: registered.id }).first();
  const r = await api(`/api/merchant/orders/${order.id}/status`, { method: 'POST', token: regTok, body: { status: 'rejected', note: 'out of stock' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.order.status, 'rejected');
  assert.equal(r.body.customerAlert.sent, true);
  assert.match(moran.sent.filter((m) => m.to === '255700000002').at(-1).body, /haikuweza kuchukua oda hii/);
  const bad = await api(`/api/merchant/orders/${order.id}/status`, { method: 'POST', token: regTok, body: { status: 'fulfilled' } });
  assert.equal(bad.status, 409);
});
