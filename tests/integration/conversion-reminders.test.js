import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, closeDatabase, db } from '../helpers/db.js';
import { makeMerchant, makeListing, acceptedCustomer } from '../helpers/fixtures.js';
import { createApp } from '../../services/api/src/app.js';
import { routers } from '../../services/api/src/routers.js';
import { setShoppingDepsForTests } from '../../services/api/src/services/shopping.js';
import { processDueReminders, nextSendableAt, DEFAULT_SCHEDULE_REMINDER } from '../../services/api/src/services/schedule-reminders.js';
import { ShoppingEngine } from '@moranbuy/reverse-marketplace';
import { MuseClient } from '@moranbuy/muse-intelligence';
import { FakeGeocoder, FakeMoranInternalClient, signBody } from '@moranbuy/integrations';
import { hashPassword, signAccessToken } from '@moranbuy/authorization';
import { createLead, answerFollowupOffer } from '@moranbuy/followup-engine';
import { recordConsent, optOut } from '@moranbuy/consent-management';
import { loadConfig } from '@moranbuy/core';

let server; let base; let moran; let shop; let tok; let adminTok;
const send = (event) => { const raw = JSON.stringify(event); const s = signBody(process.env.MORAN_SHARED_SECRET, raw); return fetch(`${base}/internal/inbound`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MoranBuy-Timestamp': s.timestamp, 'X-MoranBuy-Signature': s.signature }, body: raw }).then(async (r) => ({ status: r.status, body: await r.json() })); };
const api = (path, { method = 'GET', body, token } = {}) => fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));
const last = () => moran.sent.at(-1);
// 10:00 East Africa Time, outside quiet hours.
const MORNING = Date.UTC(2026, 9, 29, 7, 0, 0);

before(async () => {
  await resetDatabase();
  moran = new FakeMoranInternalClient();
  const cfg = loadConfig({ ...process.env, MUSE_PROVIDER: 'disabled' });
  const muse = new MuseClient({ cfg, db });
  const engine = new ShoppingEngine({ db, muse, geocoder: new FakeGeocoder({ sinza: { lat: -6.776, lng: 39.23, label: 'Sinza, Dar es Salaam' } }) });
  setShoppingDepsForTests({ engine, moran, muse });
  for (const p of ['255700000011', '255700000012', '255700000013', '255700000014', '255700000015']) await acceptedCustomer(p);
  server = createApp({ routers }).listen(0); base = `http://127.0.0.1:${server.address().port}`;
  shop = (await makeMerchant({ name: 'Simu Center', lat: -6.78, lng: 39.235, deliveryAvailable: true, deliveryFee: 5000, radiusKm: 30 })).merchant;
  await makeListing(shop.id, { name: 'Samsung A15', productType: 'smartphone', category: 'phones', price: 380000, stock: 6, variants: [{ name: '64GB', price: 380000, stock: 4 }, { name: '128GB', price: 450000, stock: 2 }] });
  const [u] = await db('merchant_users').insert({ merchant_id: shop.id, email: 'simu@example.com', name: 'Owner', password_hash: await hashPassword('password123') }).returning('*');
  tok = signAccessToken({ type: 'merchant', sub: u.id, merchantId: shop.id, role: 'owner', email: u.email });
  const [a] = await db('admin_users').insert({ email: 'root@moranbuy.test', name: 'Root', password_hash: await hashPassword('x'.repeat(12)), role: 'super_admin' }).returning('*');
  adminTok = signAccessToken({ type: 'admin', sub: a.id, role: 'super_admin', email: a.email });
  await answerFollowupOffer(db, shop.id, { accept: true, actorId: u.id, appUrl: 'http://localhost' });
  await db('merchant_entitlements').insert({ merchant_id: shop.id, service: 'paid_followup', status: 'active', billing_state: 'paid', activated_at: db.fn.now(), activated_by: 'test' }).onConflict(['merchant_id', 'service']).merge();
});
after(async () => { server.close(); await closeDatabase(); });

test('a customer who asks for the 128GB variant is quoted, ordered and alerted at the variant price', async () => {
  await send({ messageId: 'v1', from: '255700000011', text: 'Nataka simu Samsung A15 128GB ya laki 5, nipo Sinza, delivery' });
  assert.match(last().body, /Samsung A15 \(128GB\)/);
  assert.match(last().body, /TSh 450,000/);
  await send({ messageId: 'v2', from: '255700000011', text: '1' });
  assert.match(last().body, /Samsung A15 \(128GB\)/);
  await send({ messageId: 'v3', from: '255700000011', text: 'ndio' });
  const order = await db('orders').orderBy('created_at', 'desc').first();
  assert.equal(order.variant, '128GB');
  assert.equal(order.unit_price, 450000);
});

test('saying no alternatives hides the over-budget offer and says how to see it', async () => {
  await send({ messageId: 'n1', from: '255700000012', text: 'Nataka simu Samsung A15 128GB ya laki 4, nipo Sinza, bila mbadala' });
  assert.match(last().body, /umesema hutaki mbadala/);
  assert.doesNotMatch(last().body, /1\. Samsung/);
  await send({ messageId: 'n2', from: '255700000012', text: 'mbadala sawa' });
  assert.match(last().body, /1\. Samsung A15 \(128GB\)/);
});

test('an order holds the earlier lead, the merchant accepting converts it, and the lead made by the order itself is not counted', async () => {
  const phone = '255700000013';
  await recordConsent(db, { merchantId: shop.id, phone, purpose: 'followup', status: 'granted', source: 'test', evidenceRef: 't' });
  const lead = await createLead(db, { merchantId: shop.id, phone, source: 'enquiry', statedIntention: 'asked about A15' });
  assert.equal(lead.state, 'scheduled');
  await send({ messageId: 'c1', from: phone, text: 'Nataka simu Samsung A15 ya laki 4, nipo Sinza, delivery' });
  // The shopping message already stopped the open lead as a reply.
  assert.equal((await db('followup_leads').where({ id: lead.id }).first()).stop_reason, 'customer_replied');
  await send({ messageId: 'c2', from: phone, text: '1' });
  await send({ messageId: 'c3', from: phone, text: 'ndio' });
  const order = await db('orders').orderBy('created_at', 'desc').first();
  const orderLead = await db('followup_leads').where({ phone, source: 'order' }).first();
  assert.ok(orderLead, 'the order created its own follow-up lead');
  let r = await api(`/api/merchant/orders/${order.id}/status`, { method: 'POST', token: tok, body: { status: 'accepted' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.leads?.converted ?? null, null, 'the response says nothing it was not asked');
  const converted = await db('followup_leads').where({ id: lead.id }).first();
  assert.equal(converted.state, 'converted');
  assert.equal(converted.outcome, 'purchased');
  assert.equal(converted.converted_order_id, order.id);
  assert.equal((await db('followup_leads').where({ id: orderLead.id }).first()).state === 'converted', false);
  // A second status change does not convert anything twice.
  r = await api(`/api/merchant/orders/${order.id}/status`, { method: 'POST', token: tok, body: { status: 'fulfilled' } });
  assert.equal(r.status, 200);
  assert.equal(Number((await db('audit_events').where({ action: 'followup.leads_converted' }).count('id as n').first()).n), 1);
});

test('a rejected order converts nothing: the lead stopped by the reply stays stopped', async () => {
  const phone = '255700000014';
  await recordConsent(db, { merchantId: shop.id, phone, purpose: 'followup', status: 'granted', source: 'test', evidenceRef: 't' });
  const lead = await createLead(db, { merchantId: shop.id, phone, source: 'manual' });
  await send({ messageId: 'r1', from: phone, text: 'Nataka simu Samsung A15 ya laki 4, nipo Sinza, delivery' });
  await send({ messageId: 'r2', from: phone, text: '1' });
  await send({ messageId: 'r3', from: phone, text: 'ndio' });
  assert.equal((await db('followup_leads').where({ id: lead.id }).first()).stop_reason, 'customer_replied');
  const order = await db('orders').orderBy('created_at', 'desc').first();
  await api(`/api/merchant/orders/${order.id}/status`, { method: 'POST', token: tok, body: { status: 'rejected' } });
  const l = await db('followup_leads').where({ id: lead.id }).first();
  assert.equal(l.state, 'stopped');
  assert.equal(l.stop_reason, 'customer_replied');
  assert.equal(l.converted_order_id, null);
});

test('a schedule falls due: quiet hours defer it, then the reminder goes as text inside 24 hours and YES reruns the earlier search', async () => {
  const phone = '255700000015';
  await send({ messageId: 's1', from: phone, name: 'Asha', text: 'Nataka simu Samsung A15 ya laki 4, nipo Sinza, nitanunua wiki ijayo' });
  const customer = await db('customers').where({ channel_ref: phone }).first();
  const sched = await db('customer_schedules').where({ customer_id: customer.id }).first();
  assert.equal(sched.status, 'scheduled');
  // Due now, but it is 23:00 in Dar es Salaam: moved to 08:00, nothing sent.
  await db('customer_schedules').where({ id: sched.id }).update({ due_at: new Date(Date.UTC(2026, 9, 28, 20, 0, 0)) });
  const night = Date.UTC(2026, 9, 28, 20, 0, 0);
  let out = await processDueReminders({ moran, dryRun: false, now: () => night });
  assert.equal(out.deferred, 1);
  const moved = await db('customer_schedules').where({ id: sched.id }).first();
  assert.equal(new Date(moved.due_at).toISOString(), '2026-10-29T05:00:00.000Z');
  assert.equal(nextSendableAt(MORNING, DEFAULT_SCHEDULE_REMINDER), null);
  // Morning, customer wrote within 24 hours: plain text.
  await db('customers').where({ id: customer.id }).update({ last_seen_at: new Date(MORNING - 3600000) });
  const before = moran.sent.length;
  out = await processDueReminders({ moran, dryRun: false, now: () => MORNING });
  assert.equal(out.sent, 1);
  const msg = moran.sent[before];
  assert.equal(msg.type, 'text');
  assert.equal(msg.to, phone);
  assert.match(msg.body, /Habari Asha, ulisema wiki ijayo utarudi kuhusu simu samsung/);
  assert.match(msg.body, /STOP/);
  const done = await db('customer_schedules').where({ id: sched.id }).first();
  assert.equal(done.status, 'reminded');
  assert.equal(done.reminder_kind, 'text');
  // Run again: nothing is sent twice.
  out = await processDueReminders({ moran, dryRun: false, now: () => MORNING + 60000 });
  assert.equal(out.sent, 0);
  // The customer answers YES and gets the offers for the search they made before.
  await send({ messageId: 's2', from: phone, text: 'ndio' });
  assert.match(last().body, /1\. Samsung A15/);
  assert.equal((await db('customer_schedules').where({ id: sched.id }).first()).status, 'done');
});

test('after 24 hours of silence a reminder needs the approved template; opted-out customers and dry runs send nothing', async () => {
  const c = await db('customers').where({ channel_ref: '255700000011' }).first();
  const mk = async () => (await db('customer_schedules').insert({ customer_id: c.id, kind: 'purchase_plan', due_at: new Date(MORNING - 60000), when_text: 'kesho', created_at: new Date(MORNING - 3 * 86400000) }).returning('*'))[0];
  await db('customers').where({ id: c.id }).update({ last_seen_at: new Date(MORNING - 3 * 86400000) });
  // The 128GB order was placed after this schedule was made, so it counts as already ordered; move the order earlier for this case.
  await db('orders').where({ customer_id: c.id }).update({ created_at: new Date(MORNING - 5 * 86400000) });
  let s = await mk();
  await processDueReminders({ moran, dryRun: false, now: () => MORNING });
  s = await db('customer_schedules').where({ id: s.id }).first();
  assert.equal(s.status, 'expired');
  assert.equal(s.skip_reason, 'outside_24h_window_no_template');
  const set = await api('/api/admin/notifications/schedule-reminder', { method: 'PUT', token: adminTok, body: { templateName: 'moranbuy_reminder', reason: 'Approved by Meta today' } });
  assert.equal(set.status, 200);
  s = await mk();
  const before = moran.sent.length;
  await processDueReminders({ moran, dryRun: false, now: () => MORNING });
  assert.equal(moran.sent[before].type, 'moranbuy_template');
  assert.equal(moran.sent[before].templateName, 'moranbuy_reminder');
  assert.deepEqual(moran.sent[before].components[0].parameters.map((p) => p.text), ['-', 'what you asked for', 'kesho'].map((x, i) => (i === 1 && c.language !== 'en' ? 'bidhaa uliyouliza' : x)).map((x, i) => (i === 0 && c.name ? String(c.name).split(' ')[0] : x)));
  assert.equal((await db('customer_schedules').where({ id: s.id }).first()).reminder_kind, 'template');
  // STOP to MoranBuy stops reminders too.
  await optOut(db, { merchantId: null, phone: c.channel_ref, source: 'test' });
  s = await mk();
  await processDueReminders({ moran, dryRun: false, now: () => MORNING });
  assert.equal((await db('customer_schedules').where({ id: s.id }).first()).skip_reason, 'opted_out');
  // Dry run records the message but sends nothing.
  const other = await db('customers').where({ channel_ref: '255700000012' }).first();
  await db('customers').where({ id: other.id }).update({ last_seen_at: new Date(MORNING - 60000) });
  const [d] = await db('customer_schedules').insert({ customer_id: other.id, kind: 'callback', due_at: new Date(MORNING - 60000), when_text: 'kesho' }).returning('*');
  const n = moran.sent.length;
  await processDueReminders({ moran, dryRun: true, now: () => MORNING });
  assert.equal(moran.sent.length, n);
  const dr = await db('customer_schedules').where({ id: d.id }).first();
  assert.equal(dr.reminder_kind, 'dry_run');
  const view = await api('/api/admin/notifications/schedule-reminder', { token: adminTok });
  assert.equal(view.status, 200);
  assert.ok(view.body.recent.length >= 4);
  assert.match(view.body.preview.sw, /Habari Neema/);
});

test('a lead still open when an order lands is held, then released by a rejection or converted by an acceptance', async () => {
  const { holdLeadsForOrder, convertLeadsForOrder, releaseLeadsForOrder } = await import('@moranbuy/followup-engine');
  const phone = '255700000016';
  const order = await db('orders').where({ merchant_id: shop.id }).orderBy('created_at', 'desc').first();
  const [l1] = await db('followup_leads').insert({ merchant_id: shop.id, phone, source: 'manual', consent_basis: 'followup_granted', state: 'scheduled', attempts: 0, max_attempts: 2, created_at: new Date(new Date(order.created_at).getTime() - 3600000) }).returning('*');
  assert.equal(await holdLeadsForOrder(db, { merchantId: shop.id, phone, orderRef: order.order_ref }), 1);
  assert.equal((await db('followup_leads').where({ id: l1.id }).first()).stop_reason, 'order_placed');
  await releaseLeadsForOrder(db, { order: { ...order, created_at: new Date(Date.now() - 60000) }, phone });
  assert.equal((await db('followup_leads').where({ id: l1.id }).first()).stop_reason, 'order_not_completed');
  await db('followup_leads').where({ id: l1.id }).update({ stop_reason: 'order_placed' });
  assert.equal(await convertLeadsForOrder(db, { order, phone }), 1);
  assert.equal((await db('followup_leads').where({ id: l1.id }).first()).state, 'converted');
});
