import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, closeDatabase, db } from '../helpers/db.js';
import { makeMerchant, makeListing, acceptedCustomer } from '../helpers/fixtures.js';
import { createApp } from '../../services/api/src/app.js';
import { routers } from '../../services/api/src/routers.js';
import { setShoppingDepsForTests } from '../../services/api/src/services/shopping.js';
import { notifyMerchantOfOrder } from '../../services/api/src/services/merchant-notify.js';
import { handOrderToMoran } from '../../services/api/src/services/moran-order-sync.js';
import { ShoppingEngine } from '@moranbuy/reverse-marketplace';
import { MuseClient } from '@moranbuy/muse-intelligence';
import { FakeGeocoder, FakeMoranInternalClient, signBody } from '@moranbuy/integrations';
import { hashPassword, signAccessToken } from '@moranbuy/authorization';
import { loadConfig } from '@moranbuy/core';

let server; let base; let moran; let linked; let standalone; let linkedTok; let standaloneTok; let adminTok;
const signed = (path, event) => { const raw = JSON.stringify(event); const s = signBody(process.env.MORAN_SHARED_SECRET, raw); return fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MoranBuy-Timestamp': s.timestamp, 'X-MoranBuy-Signature': s.signature }, body: raw }).then(async (r) => ({ status: r.status, body: await r.json() })); };
const send = (event) => signed('/internal/inbound', event);
const api = (path, { method = 'GET', body, token } = {}) => fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));

async function merchantToken(merchant, email) {
  const [u] = await db('merchant_users').insert({ merchant_id: merchant.id, email, name: 'Owner', password_hash: await hashPassword('password123') }).returning('*');
  return signAccessToken({ type: 'merchant', sub: u.id, merchantId: merchant.id, role: 'owner', email: u.email });
}

before(async () => {
  await resetDatabase();
  moran = new FakeMoranInternalClient();
  const cfg = loadConfig({ ...process.env, MUSE_PROVIDER: 'disabled' });
  const engine = new ShoppingEngine({ db, muse: new MuseClient({ cfg, db }), geocoder: new FakeGeocoder({ sinza: { lat: -6.776, lng: 39.23, label: 'Sinza' } }), onOrderConfirmed: async (order) => { await handOrderToMoran({ moran, order }); await notifyMerchantOfOrder({ moran, order }); } });
  setShoppingDepsForTests({ engine, moran });
  for (const p of ['255700000001', '255700000002']) await acceptedCustomer(p);
  server = createApp({ routers }).listen(0); base = `http://127.0.0.1:${server.address().port}`;
  linked = (await makeMerchant({ name: 'Duka la Moran', lat: -6.78, lng: 39.235, deliveryAvailable: true, deliveryFee: 10000, radiusKm: 30, registrationType: 'moran', moranTenantId: '11111111-1111-4111-8111-111111111111' })).merchant;
  await db('merchants').where({ id: linked.id }).update({ contact_phone: '255712000111' });
  await makeListing(linked.id, { name: 'Sofa ya watu watatu', price: 300000, attributes: { seats: 3 }, source: 'moran', sourceProductId: 'prod-1' });
  standalone = (await makeMerchant({ name: 'Duka Peke Yake', lat: -6.90, lng: 39.30, deliveryAvailable: true, deliveryFee: 20000, radiusKm: 30 })).merchant;
  await db('merchants').where({ id: standalone.id }).update({ contact_phone: '255712000222' });
  await makeListing(standalone.id, { name: 'Sofa ya watu watatu deluxe', price: 340000, attributes: { seats: 3 } });
  linkedTok = await merchantToken(linked, 'linked@example.com');
  standaloneTok = await merchantToken(standalone, 'alone@example.com');
  const [a] = await db('admin_users').insert({ email: 'root@moranbuy.test', name: 'Root', password_hash: await hashPassword('x'.repeat(12)), role: 'super_admin' }).returning('*');
  adminTok = signAccessToken({ type: 'admin', sub: a.id, role: 'super_admin', email: a.email });
});
after(async () => { server.close(); await closeDatabase(); });

async function orderFrom(phone, option) {
  await send({ messageId: `${phone}-1`, from: phone, text: 'Nina laki nne ya sofa ya watu watatu, nipo Sinza, delivery' });
  await send({ messageId: `${phone}-2`, from: phone, text: option });
  await send({ messageId: `${phone}-3`, from: phone, text: 'ndio' });
  return db('orders').orderBy('created_at', 'desc').first();
}

test('a confirmed order for a Moran-linked business is written into Moran and keeps the Moran reference', async () => {
  const order = await orderFrom('255700000001', '1');
  assert.equal(order.merchant_id, linked.id);
  assert.equal(moran.orders.length, 1);
  const sent = moran.orders[0];
  assert.equal(sent.tenantId, '11111111-1111-4111-8111-111111111111');
  assert.equal(sent.orderRef, order.order_ref);
  assert.equal(sent.items[0].productId, 'prod-1');
  assert.equal(sent.items[0].unitPrice, 300000);
  assert.equal(sent.customerPhone, '+255700000001');
  const after = await db('orders').where({ id: order.id }).first();
  assert.equal(after.external_ref, 'moran:moran-order-1');
  // The owner still gets the WhatsApp alert.
  assert.ok(moran.sent.some((m) => m.to === '255712000111'));
});

test('a status change by the linked merchant is mirrored onto the Moran order', async () => {
  const order = await db('orders').where({ merchant_id: linked.id }).first();
  const r = await api(`/api/merchant/orders/${order.id}/status`, { method: 'POST', token: linkedTok, body: { status: 'accepted' } });
  assert.equal(r.status, 200);
  const upd = moran.orderUpdates.at(-1);
  assert.equal(upd.orderRef, order.order_ref);
  assert.equal(upd.status, 'confirmed');
  await api(`/api/merchant/orders/${order.id}/status`, { method: 'POST', token: linkedTok, body: { status: 'fulfilled' } });
  assert.equal(moran.orderUpdates.at(-1).status, 'fulfilled');
});

test('a standalone business gets no Moran order, only the WhatsApp alert', async () => {
  const before = moran.orders.length;
  const order = await orderFrom('255700000002', '2');
  assert.equal(order.merchant_id, standalone.id);
  assert.equal(moran.orders.length, before);
  assert.equal((await db('orders').where({ id: order.id }).first()).external_ref, null);
  assert.ok(moran.sent.some((m) => m.to === '255712000222'));
  const r = await api(`/api/merchant/orders/${order.id}/status`, { method: 'POST', token: standaloneTok, body: { status: 'accepted' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.moranSync?.skipped, true);
});

test('a service cannot be bought before an administrator prices it', async () => {
  const r = await api('/api/merchant/services/paid_followup/pay', { method: 'POST', token: standaloneTok, body: {} });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'SERVICE_NOT_PRICED');
});

test('admins set service prices with an audited reason', async () => {
  const bad = await api('/api/admin/service-pricing', { method: 'PUT', token: adminTok, body: { paid_followup: { monthlyTzs: 50000, periodDays: 30 } } });
  assert.equal(bad.status, 400);
  const r = await api('/api/admin/service-pricing', { method: 'PUT', token: adminTok, body: { paid_followup: { monthlyTzs: 50000, periodDays: 30 }, reason: 'Launch price for follow-up' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.effective.paid_followup.monthlyTzs, 50000);
  assert.equal(r.body.effective.campaign_engine.monthlyTzs, null);
  const pub = await api('/api/merchant/services/pricing', { token: standaloneTok });
  assert.equal(pub.body.pricing.paid_followup.monthlyTzs, 50000);
  assert.ok(await db('audit_events').where({ action: 'service_pricing.changed' }).first());
});

test('paying for a service activates it only when the payment settles, and the registration page reflects every step', async () => {
  const offer = await api('/api/merchant/followup/offer/answer', { method: 'POST', token: standaloneTok, body: { accept: true } });
  assert.equal(offer.status, 200);
  const token = offer.body.registrationUrl.split('#followup=')[1];
  assert.ok(token);
  let reg = await api(`/api/merchant/followup/register/${token}`, { token: standaloneTok });
  assert.equal(reg.status, 200);
  assert.equal(reg.body.steps.policy.done, false);
  assert.equal(reg.body.steps.payment.done, false);
  assert.equal(reg.body.steps.payment.price.monthlyTzs, 50000);
  assert.equal(reg.body.active, false);
  assert.equal((await api(`/api/merchant/followup/register/${'x'.repeat(20)}`, { token: standaloneTok })).status, 404);
  reg = await api(`/api/merchant/followup/register/${token}/accept-policy`, { method: 'POST', token: standaloneTok, body: {} });
  assert.equal(reg.body.steps.policy.done, true);

  const pay = await api('/api/merchant/services/paid_followup/pay', { method: 'POST', token: standaloneTok, body: {} });
  assert.equal(pay.status, 200);
  assert.equal(pay.body.payment.amount, 50000);
  assert.equal(pay.body.payment.status, 'pending');
  // The same pending payment is reused rather than opened twice.
  const again = await api('/api/merchant/services/paid_followup/pay', { method: 'POST', token: standaloneTok, body: {} });
  assert.equal(again.body.payment.reference, pay.body.payment.reference);
  assert.equal(again.body.reused, true);
  let ent = await db('merchant_entitlements').where({ merchant_id: standalone.id, service: 'paid_followup' }).first();
  assert.equal(ent.status, 'pending_payment');
  assert.equal((await api('/api/merchant/followup/settings', { token: standaloneTok })).status, 403);

  // A short payment never activates anything.
  const short = await fetch(`${base}/api/sandbox/payments/${pay.body.payment.reference}/settle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'completed', amount: 1000, attempt: 1 }) });
  assert.equal(short.status, 200);
  ent = await db('merchant_entitlements').where({ merchant_id: standalone.id, service: 'paid_followup' }).first();
  assert.equal(ent.status, 'pending_payment');

  const pay2 = await api('/api/merchant/services/paid_followup/pay', { method: 'POST', token: standaloneTok, body: {} });
  assert.notEqual(pay2.body.payment.reference, pay.body.payment.reference);
  const full = await fetch(`${base}/api/sandbox/payments/${pay2.body.payment.reference}/settle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'completed', attempt: 1 }) });
  assert.equal(full.status, 200);
  ent = await db('merchant_entitlements').where({ merchant_id: standalone.id, service: 'paid_followup' }).first();
  assert.equal(ent.status, 'active');
  assert.equal(ent.billing_state, 'paid');
  assert.ok(new Date(ent.expires_at).getTime() > Date.now() + 29 * 86400000);
  assert.equal((await api('/api/merchant/followup/settings', { token: standaloneTok })).status, 200);
  reg = await api(`/api/merchant/followup/register/${token}`, { token: standaloneTok });
  assert.equal(reg.body.steps.payment.done, true);
  assert.equal(reg.body.active, true);
  assert.ok(await db('audit_events').where({ action: 'entitlement.activated_by_payment' }).first());
  const list = await api('/api/merchant/payments', { token: standaloneTok });
  assert.equal(list.body.payments.length, 2);
});

test('delivery receipts forwarded by Moran move campaign recipients and order alerts forward only', async () => {
  const [campaign] = await db('campaigns').insert({ merchant_id: standalone.id, kind: 'promotion', name: 'Receipts', status: 'sending', audience_json: '{}' }).returning('*');
  const [r1] = await db('campaign_recipients').insert({ campaign_id: campaign.id, merchant_id: standalone.id, phone: '255700000001', status: 'sent', idempotency_key: 'k-a', provider_message_id: 'wamid.A' }).returning('*');
  await db('campaign_recipients').insert({ campaign_id: campaign.id, merchant_id: standalone.id, phone: '255700000002', status: 'sent', idempotency_key: 'k-b', provider_message_id: 'wamid.B' });
  const alert = await db('merchant_notifications').orderBy('created_at', 'desc').first();
  await db('merchant_notifications').where({ id: alert.id }).update({ provider_message_id: 'wamid.N' });

  const bad = await fetch(`${base}/internal/inbound/status`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MoranBuy-Timestamp': '1', 'X-MoranBuy-Signature': 'nope' }, body: '{}' });
  assert.equal(bad.status, 401);

  let r = await signed('/internal/inbound/status', { statuses: [{ id: 'wamid.A', status: 'read' }, { id: 'wamid.B', status: 'failed', errors: [{ code: 131026, title: 'Message undeliverable' }] }, { id: 'wamid.N', status: 'failed', errors: [{ title: 'Number not on WhatsApp' }] }, { id: 'wamid.unknown', status: 'delivered' }] });
  assert.equal(r.status, 200);
  assert.equal((await db('campaign_recipients').where({ id: r1.id }).first()).status, 'read');
  assert.equal((await db('campaign_recipients').where({ provider_message_id: 'wamid.B' }).first()).status, 'failed');
  const c = await db('campaigns').where({ id: campaign.id }).first();
  assert.equal(c.count_sent, 1);
  assert.equal(c.count_delivered, 1);
  assert.equal(c.count_failed, 1);
  const n = await db('merchant_notifications').where({ id: alert.id }).first();
  assert.equal(n.status, 'failed');
  assert.equal(n.error, 'Number not on WhatsApp');

  // A late "delivered" after "read" does not move the recipient back.
  r = await signed('/internal/inbound/status', { statuses: [{ id: 'wamid.A', status: 'delivered' }] });
  assert.equal(r.body.results[0].campaign, false);
  assert.equal((await db('campaign_recipients').where({ id: r1.id }).first()).status, 'read');
});
