import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, closeDatabase, db } from '../helpers/db.js';
import { makeMerchant, makeListing, acceptedCustomer } from '../helpers/fixtures.js';
import { createApp } from '../../services/api/src/app.js';
import { routers } from '../../services/api/src/routers.js';
import { setShoppingDepsForTests } from '../../services/api/src/services/shopping.js';
import { notifyMerchantOfOrder } from '../../services/api/src/services/merchant-notify.js';
import { ShoppingEngine } from '@moranbuy/reverse-marketplace';
import { MuseClient } from '@moranbuy/muse-intelligence';
import { FakeGeocoder, FakeMoranInternalClient, signBody } from '@moranbuy/integrations';
import { hashPassword, signAccessToken } from '@moranbuy/authorization';
import { loadConfig } from '@moranbuy/core';

let server; let base; let moran; let merchant; let adminTok;
const send = async (event) => { const raw = JSON.stringify(event); const s = signBody(process.env.MORAN_SHARED_SECRET, raw); return fetch(`${base}/internal/inbound`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MoranBuy-Timestamp': s.timestamp, 'X-MoranBuy-Signature': s.signature }, body: raw }).then((r) => r.json()); };
const api = (path, { method = 'GET', body, token } = {}) => fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));

before(async () => {
  await resetDatabase();
  moran = new FakeMoranInternalClient();
  const cfg = loadConfig({ ...process.env, MUSE_PROVIDER: 'disabled' });
  const engine = new ShoppingEngine({ db, muse: new MuseClient({ cfg, db }), geocoder: new FakeGeocoder({ sinza: { lat: -6.776, lng: 39.23, label: 'Sinza, Dar es Salaam' } }), onOrderConfirmed: (order) => notifyMerchantOfOrder({ moran, order }) });
  setShoppingDepsForTests({ engine, moran });
  for (const p of ["255700000001", "255700000002", "255700000003", "255700000004"]) await acceptedCustomer(p);
  server = createApp({ routers }).listen(0); base = `http://127.0.0.1:${server.address().port}`;
  merchant = (await makeMerchant({ name: 'Duka la Asha', lat: -6.78, lng: 39.235, deliveryAvailable: true, deliveryFee: 10000, radiusKm: 30 })).merchant;
  await db('merchants').where({ id: merchant.id }).update({ contact_phone: '0712 000 111' });
  await makeListing(merchant.id, { name: 'Sofa ya watu watatu', price: 300000, attributes: { seats: 3 } });
  const [a] = await db('admin_users').insert({ email: 'root@moranbuy.test', name: 'Root', password_hash: await hashPassword('x'.repeat(12)), role: 'super_admin' }).returning('*');
  adminTok = signAccessToken({ type: 'admin', sub: a.id, role: 'super_admin', email: a.email });
});
after(async () => { server.close(); await closeDatabase(); });

async function confirmAnOrder(phone) {
  await send({ messageId: `${phone}-1`, from: phone, text: 'Nina laki nne ya sofa ya watu watatu, nipo Sinza, delivery' });
  await send({ messageId: `${phone}-2`, from: phone, text: '1' });
  return send({ messageId: `${phone}-3`, from: phone, text: 'ndio' });
}

test('a confirmed order texts the business owner from the MoranBuy number with the admin wording, once', async () => {
  const yes = await confirmAnOrder('255700000001');
  assert.equal(yes.state, 'confirmed');
  const alert = moran.sent.find((m) => m.to === '255712000111');
  assert.ok(alert, 'owner was not messaged');
  assert.equal(alert.type, 'text');
  assert.match(alert.body, /MoranBuy: oda mpya MB-[A-Z0-9]+\. Sofa ya watu watatu x1, TSh 310,000, delivery\. Mteja: \+255700000001, Sinza, Dar es Salaam/);
  const rows = await db('merchant_notifications').where({ merchant_id: merchant.id });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'sent');
  const order = await db('orders').first();
  assert.deepEqual(await notifyMerchantOfOrder({ moran, order }), { duplicate: true });
});

test('with an approved template configured in Admin the alert goes out as that template with the facts as parameters', async () => {
  const r = await api('/api/admin/notifications/order-confirmed', { method: 'PUT', token: adminTok, body: { templateName: 'moranbuy_order_alert', templateLanguage: 'sw', reason: 'template approved by Meta' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await confirmAnOrder('255700000002');
  const alert = moran.sent.filter((m) => m.to === '255712000111').at(-1);
  assert.equal(alert.type, 'moranbuy_template');
  assert.equal(alert.templateName, 'moranbuy_order_alert');
  assert.equal(alert.components[0].parameters.length, 6);
  assert.equal(alert.components[0].parameters[1].text, 'Sofa ya watu watatu');
  const prev = await api('/api/admin/notifications/order-confirmed', { token: adminTok });
  assert.match(prev.body.preview.sw, /MB-7K2P9Q/);
  assert.equal(prev.body.recent.length, 2);
});

test('a merchant without a phone is recorded as skipped and the order still stands; a failed send is recorded as failed', async () => {
  await db('merchants').where({ id: merchant.id }).update({ contact_phone: null });
  const yes = await confirmAnOrder('255700000003');
  assert.equal(yes.state, 'confirmed');
  const row = await db('merchant_notifications').orderBy('created_at', 'desc').first();
  assert.equal(row.status, 'skipped');
  assert.equal(row.skip_reason, 'merchant_has_no_phone');
  await db('merchants').where({ id: merchant.id }).update({ contact_phone: '255712000111' });
  moran.sendMoranBuyTemplate = async () => ({ ok: false, status: 'http_409', data: { error: 'TEMPLATE_NOT_APPROVED' } });
  await confirmAnOrder('255700000004');
  const failed = await db('merchant_notifications').orderBy('created_at', 'desc').first();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'TEMPLATE_NOT_APPROVED');
  assert.equal((await db('orders').count('id as n').first()).n, '4');
});
