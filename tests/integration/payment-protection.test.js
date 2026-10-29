import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import jpeg from 'jpeg-js';
import { resetDatabase, closeDatabase, db } from '../helpers/db.js';
import { makeMerchant, makeListing, acceptedCustomer } from '../helpers/fixtures.js';
import { createApp } from '../../services/api/src/app.js';
import { routers } from '../../services/api/src/routers.js';
import { setShoppingDepsForTests } from '../../services/api/src/services/shopping.js';
import { setEngagementDepsForTests } from '../../services/api/src/services/engagement.js';
import { notifyMerchantOfOrder } from '../../services/api/src/services/merchant-notify.js';
import { runProtectionSweep } from '../../services/api/src/services/protection/protection.js';
import { ShoppingEngine } from '@moranbuy/reverse-marketplace';
import { MuseClient } from '@moranbuy/muse-intelligence';
import { SandboxPaymentProvider } from '@moranbuy/billing';
import { FakeGeocoder, FakeMoranInternalClient, signBody } from '@moranbuy/integrations';
import { hashPassword, signAccessToken } from '@moranbuy/authorization';
import { loadConfig } from '@moranbuy/core';

let server; let base; let moran; let payments; let shop; let shopTok; let adminTok; let n = 0;
const OWNER = '255712000333'; const RIDER = '255754000111';
const send = (event) => { const raw = JSON.stringify({ messageId: `pp-${n += 1}`, ...event }); const s = signBody(process.env.MORAN_SHARED_SECRET, raw); return fetch(`${base}/internal/inbound`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MoranBuy-Timestamp': s.timestamp, 'X-MoranBuy-Signature': s.signature }, body: raw }).then(async (r) => ({ status: r.status, body: await r.json() })); };
const api = (path, { method = 'GET', body, token } = {}) => fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() }));
const lastTo = (to, type = 'text') => moran.sent.filter((m) => m.to === to && m.type === type).at(-1);
const photo = (shade) => { const px = Buffer.alloc(64 * 64 * 4); for (let i = 0; i < px.length; i += 4) { const x = (i / 4) % 64; px[i] = x < 32 ? shade : 255 - shade; px[i + 1] = shade; px[i + 2] = 80; px[i + 3] = 255; } return Buffer.from(jpeg.encode({ width: 64, height: 64, data: px }, 90).data).toString('base64'); };
const state = async (order) => (await db('order_protection').where({ order_id: order.id }).first()).state;

before(async () => {
  await resetDatabase();
  moran = new FakeMoranInternalClient();
  payments = new SandboxPaymentProvider();
  const cfg = loadConfig({ ...process.env, MUSE_PROVIDER: 'disabled' });
  const muse = new MuseClient({ cfg, db });
  const engine = new ShoppingEngine({ db, muse, geocoder: new FakeGeocoder({ sinza: { lat: -6.776, lng: 39.23, label: 'Sinza' } }), onOrderConfirmed: async (order) => { await notifyMerchantOfOrder({ moran, order }); } });
  setShoppingDepsForTests({ engine, moran, muse });
  setEngagementDepsForTests({ payments, muse, moran });
  server = createApp({ routers }).listen(0); base = `http://127.0.0.1:${server.address().port}`;
  shop = (await makeMerchant({ name: 'Duka la Sinza Furniture', lat: -6.78, lng: 39.235, deliveryAvailable: true, deliveryFee: 10000, radiusKm: 30 })).merchant;
  await db('merchants').where({ id: shop.id }).update({ contact_phone: OWNER, owner_name: 'Asha Mwakyusa' });
  await makeListing(shop.id, { name: 'Sofa ya watu watatu', price: 320000, attributes: { seats: 3 } });
  const [u] = await db('merchant_users').insert({ merchant_id: shop.id, email: 'asha@example.com', name: 'Asha', password_hash: await hashPassword('password123') }).returning('*');
  shopTok = signAccessToken({ type: 'merchant', sub: u.id, merchantId: shop.id, role: 'owner', email: u.email });
  const [a] = await db('admin_users').insert({ email: 'root@moranbuy.test', name: 'Root', password_hash: await hashPassword('x'.repeat(12)), role: 'super_admin' }).returning('*');
  adminTok = signAccessToken({ type: 'admin', sub: a.id, role: 'super_admin', email: a.email });
  for (const p of ['255700000701', '255700000702', '255700000703', '255700000704', OWNER]) await acceptedCustomer(p);
});
after(async () => { server.close(); await closeDatabase(); });

async function paidOrder(phone) {
  await send({ from: phone, text: 'Nina laki nne ya sofa ya watu watatu, nipo Sinza, delivery' });
  await send({ from: phone, text: '1' });
  await send({ from: phone, text: 'ndio' });
  const order = await db('orders').orderBy('created_at', 'desc').first();
  await send({ from: OWNER, text: `KUBALI ${order.order_ref}` });
  const pay = await db('payments').where({ purpose: 'order', target_id: order.id }).orderBy('created_at', 'desc').first();
  const settled = await api(`/api/sandbox/payments/${pay.reference}/settle`, { method: 'POST', body: { status: 'completed' } });
  assert.equal(settled.status, 200);
  const code = lastTo(phone).body.match(/(?:makabidhiano|handover code): ([A-Z0-9]{6})/)[1];
  return { order: await db('orders').where({ id: order.id }).first(), code };
}

test('accepting a WhatsApp order asks the customer to pay MoranBuy; the verified payment is held, with a receipt and a private handover code', async () => {
  await send({ from: '255700000701', text: 'Nina laki nne ya sofa ya watu watatu, nipo Sinza, delivery' });
  await send({ from: '255700000701', text: '1' });
  await send({ from: '255700000701', text: 'ndio' });
  const order = await db('orders').orderBy('created_at', 'desc').first();
  await send({ from: OWNER, text: `KUBALI ${order.order_ref}` });
  assert.equal(await state(order), 'awaiting_payment');
  assert.match(lastTo('255700000701').body, /Lipa TSh 330,000 kwa MoranBuy/);
  const pay = await db('payments').where({ purpose: 'order', target_id: order.id }).first();
  assert.equal(pay.amount, 330000);
  await api(`/api/sandbox/payments/${pay.reference}/settle`, { method: 'POST', body: { status: 'completed' } });
  assert.equal(await state(order), 'paid_held');
  assert.equal((await db('orders').where({ id: order.id }).first()).status, 'paid');
  const doc = lastTo('255700000701', 'document');
  assert.equal(Buffer.from(doc.documentBase64, 'base64').subarray(0, 5).toString(), '%PDF-');
  assert.match(doc.filename, /^MoranBuy-MB-R-\d{6}-v1\.pdf$/);
  const code = lastTo('255700000701').body.match(/makabidhiano: ([A-Z0-9]{6})/)[1];
  // The code is never stored, only its keyed hash, and the business is not told it.
  const p = await db('order_protection').where({ order_id: order.id }).first();
  assert.notEqual(p.code_hash, code);
  assert.ok(!moran.sent.filter((m) => m.to === OWNER).some((m) => String(m.body || '').includes(code)));
  assert.match(lastTo(OWNER).body, new RegExp(`MSAFIRISHAJI ${order.order_ref}`));
  // A protected order cannot be marked delivered by the business itself.
  const r = await send({ from: OWNER, text: `NIMETUMA ${order.order_ref}` });
  assert.equal(r.status, 200);
  assert.match(lastTo(OWNER).body, /handover code|makabidhiano/i);
  assert.equal(await state(order), 'paid_held');
});

test('the delivery person proves delivery with a photo and the customer\'s code; a false "not received" is refused and the business is paid after RECEIVED', async () => {
  const { order, code } = await paidOrder('255700000702');
  await send({ from: OWNER, text: `MSAFIRISHAJI ${order.order_ref} 0754000111 Juma` });
  const prompt = lastTo(RIDER, 'buttons');
  assert.deepEqual(prompt.buttons.map((b) => b.id), [`dlv:arrived:${order.order_ref}`, `dlv:rejected:${order.order_ref}`, `dlv:absent:${order.order_ref}`]);
  // The rider never accepted MoranBuy's terms: delivery buttons work anyway, because they act for the business.
  await send({ from: RIDER, buttonId: `dlv:arrived:${order.order_ref}`, kind: 'button', text: 'Nimefika' });
  assert.match(lastTo(RIDER).body, /picha ya bidhaa/);
  await send({ from: RIDER, kind: 'image', media: { base64: photo(90), mime: 'image/jpeg' } });
  assert.match(lastTo(RIDER).body, /namba ya makabidhiano/);
  await send({ from: RIDER, text: 'ZZZZZZ' });
  assert.match(lastTo(RIDER).body, /jaribio 1 kati ya 3/);
  await send({ from: RIDER, text: `namba ni ${code.toLowerCase()}` });
  assert.match(lastTo(RIDER).body, /imethibitishwa kufika/);
  assert.equal(await state(order), 'delivered');
  assert.equal((await db('orders').where({ id: order.id }).first()).status, 'fulfilled');
  const kinds = (await db('delivery_events').where({ order_id: order.id }).orderBy('id')).map((e) => e.kind);
  for (const k of ['payment_held', 'deliverer_assigned', 'arrived', 'photo', 'code_bad', 'code_ok', 'delivered']) assert.ok(kinds.includes(k), k);
  const ph = await db('delivery_events').where({ order_id: order.id, kind: 'photo' }).first();
  assert.match(ph.data_json.fp, /^[0-9a-f]{16}$/);
  assert.deepEqual(ph.data_json.muse, { status: 'disabled' });

  await send({ from: '255700000702', text: `SIJAPOKEA ${order.order_ref}` });
  assert.match(lastTo('255700000702').body, /halikubaliki/);
  assert.equal((await db('strikes').where({ subject_type: 'customer' }).count('id as n').first()).n, '1');

  await send({ from: '255700000702', text: `NIMEPOKEA ${order.order_ref}` });
  assert.equal(await state(order), 'released');
  const payout = await db('payouts').where({ order_id: order.id, kind: 'release' }).first();
  assert.deepEqual([payout.status, payout.amount, payout.phone], ['completed', 330000, OWNER]);
  assert.match(lastTo(OWNER).body, /zimetumwa kwa \+255712000333/);
  const versions = await db('receipts').where({ order_id: order.id }).orderBy('version');
  assert.deepEqual(versions.map((v) => v.status_label), ['PAID - HELD BY MORANBUY', 'DELIVERED - HELD 48H', 'COMPLETED - PAID TO BUSINESS']);
  assert.ok(versions.every((v) => v.number && v.check_code.length === 9));

  // The QR code's link proves a receipt; a changed check code does not.
  const no = `MB-R-${String(versions[0].number).padStart(6, '0')}`;
  const ok = await api(`/r/${no}?c=${versions[0].check_code.replace('-', '')}`);
  assert.equal(ok.status, 200);
  assert.match(ok.body, /Genuine MoranBuy receipt[\s\S]*served by Asha Mwakyusa[\s\S]*COMPLETED - PAID TO BUSINESS/);
  assert.equal((await api(`/r/${no}?c=AAAAAAAA`)).status, 404);

  const dl = await fetch(`${base}/api/merchant/orders/${order.id}/receipt.pdf`, { headers: { Authorization: `Bearer ${shopTok}` } });
  assert.equal(dl.headers.get('content-type'), 'application/pdf');
});

test('a wrong product refused at the door: reason and photo from the rider, the customer confirms, the customer is refunded and the business gets a strike', async () => {
  const { order } = await paidOrder('255700000703');
  await api(`/api/merchant/orders/${order.id}/deliverer`, { method: 'POST', token: shopTok, body: { phone: '0754000111', name: 'Juma' } });
  await send({ from: RIDER, buttonId: `dlv:rejected:${order.order_ref}`, kind: 'button' });
  await send({ from: RIDER, text: 'Mteja amesema sio sofa aliyoagiza, rangi tofauti' });
  assert.match(lastTo(RIDER).body, /tuma picha/);
  await send({ from: RIDER, kind: 'image', media: { base64: photo(200), mime: 'image/jpeg' } });
  assert.equal(await state(order), 'rejection_pending');
  const ask = lastTo('255700000703', 'buttons');
  assert.deepEqual(ask.buttons.map((b) => b.id), [`cust:rej_yes:${order.order_ref}`, `cust:rej_no:${order.order_ref}`]);
  await send({ from: '255700000703', buttonId: `cust:rej_yes:${order.order_ref}`, kind: 'button', text: 'Ndio, nimekataa' });
  assert.equal(await state(order), 'refunded');
  assert.equal((await db('orders').where({ id: order.id }).first()).status, 'cancelled');
  const refund = await db('payouts').where({ order_id: order.id, kind: 'refund' }).first();
  assert.deepEqual([refund.status, refund.amount, refund.phone], ['completed', 330000, '255700000703']);
  const strike = await db('strikes').where({ subject_type: 'merchant', subject_id: shop.id }).first();
  assert.equal(strike.reason, 'wrong_item');
  assert.equal(lastTo('255700000703', 'document').filename.endsWith('-v2.pdf'), true);
});

test('a contested refusal becomes a dispute that only a super admin settles; unpaid orders expire; customers list their orders for receipts', async () => {
  const { order } = await paidOrder('255700000704');
  await send({ from: OWNER, text: `MSAFIRISHAJI ${order.order_ref} 0754000111` });
  await send({ from: RIDER, buttonId: `dlv:rejected:${order.order_ref}`, kind: 'button' });
  await send({ from: RIDER, kind: 'image', media: { base64: photo(30), mime: 'image/jpeg' } });
  await send({ from: RIDER, text: 'Imeharibika' });
  await send({ from: '255700000704', buttonId: `cust:rej_no:${order.order_ref}`, kind: 'button', text: 'Hapana' });
  assert.equal(await state(order), 'disputed');
  const dispute = await db('disputes').where({ order_id: order.id }).first();
  assert.equal(dispute.category, 'rejection_contested');
  const list = await api('/api/admin/protection', { token: adminTok });
  assert.equal(list.status, 200);
  assert.ok(list.body.disputes.some((d) => d.id === dispute.id));
  assert.ok(list.body.held >= 330000);
  const detail = await api(`/api/admin/protection/${order.id}`, { token: adminTok });
  assert.ok(detail.body.timeline.some((e) => e.kind === 'rejected'));
  assert.equal(detail.body.protection.code_hash, undefined);
  const resolved = await api(`/api/admin/disputes/${dispute.id}/resolve`, { method: 'POST', token: adminTok, body: { decision: 'release', note: 'Photo shows the right sofa in good condition' } });
  assert.equal(resolved.status, 200);
  assert.equal(await state(order), 'released');

  // "Oda zangu" lists the customer's protected orders; tapping one sends its receipt.
  await send({ from: '255700000704', text: 'oda zangu' });
  const listMsg = lastTo('255700000704', 'list');
  assert.equal(listMsg.sections[0].rows[0].id, `rcpt:${order.order_ref}`);
  const before = moran.sent.filter((m) => m.type === 'document').length;
  await send({ from: '255700000704', buttonId: `rcpt:${order.order_ref}`, kind: 'interactive' });
  assert.equal(moran.sent.filter((m) => m.type === 'document').length, before + 1);

  // An order accepted but never paid is cancelled by the timed rules.
  await send({ from: '255700000701', text: 'Nina laki nne ya sofa ya watu watatu, nipo Sinza, delivery' });
  await send({ from: '255700000701', text: '1' });
  await send({ from: '255700000701', text: 'ndio' });
  const unpaid = await db('orders').orderBy('created_at', 'desc').first();
  await send({ from: OWNER, text: `KUBALI ${unpaid.order_ref}` });
  const out = await runProtectionSweep({ moran, payments, now: new Date(Date.now() + 25 * 3600000) });
  assert.equal(out.expired, 1);
  assert.equal(await state(unpaid), 'expired');
  assert.equal((await db('orders').where({ id: unpaid.id }).first()).status, 'cancelled');
});
