import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, closeDatabase, db } from '../helpers/db.js';
import { makeMerchant, makeListing } from '../helpers/fixtures.js';
import { createApp } from '../../services/api/src/app.js';
import { routers } from '../../services/api/src/routers.js';
import { setShoppingDepsForTests } from '../../services/api/src/services/shopping.js';
import { ShoppingEngine } from '@moranbuy/reverse-marketplace';
import { MuseClient } from '@moranbuy/muse-intelligence';
import { FakeGeocoder, FakeMoranInternalClient, signBody } from '@moranbuy/integrations';
import { hashPassword, signAccessToken } from '@moranbuy/authorization';
import { loadConfig } from '@moranbuy/core';

let server; let base; let moran; let adminTok;
const send = async (event) => { const raw = JSON.stringify(event); const s = signBody(process.env.MORAN_SHARED_SECRET, raw); return fetch(`${base}/internal/inbound`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MoranBuy-Timestamp': s.timestamp, 'X-MoranBuy-Signature': s.signature }, body: raw }).then((r) => r.json()); };
const post = (path, body, token, method = 'POST') => fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

before(async () => {
  await resetDatabase();
  moran = new FakeMoranInternalClient();
  const cfg = loadConfig({ ...process.env, MUSE_PROVIDER: 'disabled' });
  setShoppingDepsForTests({ engine: new ShoppingEngine({ db, muse: new MuseClient({ cfg, db }), geocoder: new FakeGeocoder({ sinza: { lat: -6.776, lng: 39.23 } }) }), moran });
  server = createApp({ routers }).listen(0); base = `http://127.0.0.1:${server.address().port}`;
  const m = (await makeMerchant({ name: 'Duka', lat: -6.78, lng: 39.235, deliveryAvailable: true, deliveryFee: 5000, radiusKm: 30 })).merchant;
  await makeListing(m.id, { name: 'Sofa ya watu watatu', price: 300000, attributes: { seats: 3 } });
  const [a] = await db('admin_users').insert({ email: 'root@moranbuy.test', name: 'Root', password_hash: await hashPassword('x'.repeat(12)), role: 'super_admin' }).returning('*');
  adminTok = signAccessToken({ type: 'admin', sub: a.id, role: 'super_admin', email: a.email });
});
after(async () => { server.close(); await closeDatabase(); });

test('a new WhatsApp sender gets the terms question with two buttons and no answer; asking again repeats it', async () => {
  const first = await send({ messageId: 't1', from: '255700000001', text: 'Nina laki tatu ya sofa, nipo Sinza' });
  assert.equal(first.state, 'terms_prompted');
  const q = moran.sent.at(-1);
  assert.equal(q.type, 'buttons');
  assert.match(q.body, /Masharti ya Huduma/);
  assert.match(q.body, /\/terms/);
  assert.deepEqual(q.buttons.map((b) => b.id), ['terms_accept', 'terms_reject']);
  assert.equal((await db('shopping_sessions').count('id as n').first()).n, '0');
  const again = await send({ messageId: 't2', from: '255700000001', text: 'sofa?' });
  assert.equal(again.state, 'terms_prompted');
  assert.equal(moran.sent.filter((m) => m.type === 'buttons').length, 2);
  assert.equal((await db('customers').where({ channel_ref: '255700000001' }).first()).terms_prompts, 2);
});

test('rejecting silences the agent; a later text brings the question back; accepting by button starts the conversation', async () => {
  const no = await send({ messageId: 't3', from: '255700000001', text: 'Sikubali', buttonId: 'terms_reject' });
  assert.equal(no.state, 'terms_rejected');
  assert.match(moran.sent.at(-1).body, /haitakujibu hadi ukubali/);
  const later = await send({ messageId: 't4', from: '255700000001', text: 'Nina laki tatu ya sofa' });
  assert.equal(later.state, 'terms_prompted');
  assert.equal((await db('shopping_sessions').count('id as n').first()).n, '0');
  const yes = await send({ messageId: 't5', from: '255700000001', text: 'Nakubali', buttonId: 'terms_accept' });
  assert.equal(yes.state, 'terms_accepted');
  assert.match(moran.sent.at(-1).body, /Niambie bidhaa unayotaka/);
  const consent = await db('consent_events').where({ phone: '255700000001', purpose: 'service' }).first();
  assert.equal(consent.evidence_ref, 'terms:2026-10-28');
  const shop = await send({ messageId: 't6', from: '255700000001', text: 'Nina laki nne ya sofa ya watu watatu, nipo Sinza, delivery' });
  assert.equal(shop.state, 'presented');
});

test('a typed acceptance works too, and a new terms version asks everyone again', async () => {
  const typed = await send({ messageId: 't7', from: '255700000002', text: 'nakubali' });
  assert.equal(typed.state, 'terms_accepted');
  const r = await post('/api/admin/notifications/terms', { version: '2026-11-01', reason: 'new policy' }, adminTok, 'PUT');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const re = await send({ messageId: 't8', from: '255700000001', text: 'sofa' });
  assert.equal(re.state, 'terms_prompted');
  assert.match(moran.sent.at(-1).footer, /2026-11-01/);
});

test('on the web the first message returns the terms, rejection returns nothing, acceptance proceeds', async () => {
  const first = await post('/api/shop/messages', { text: 'I want a 3 seater sofa, budget 400k, I am in Sinza' });
  assert.equal(first.body.state, 'terms_required');
  assert.match(first.body.terms.text, /\/privacy/);
  assert.equal(first.body.replies.length, 1);
  const token = first.body.customerToken;
  const no = await post('/api/shop/messages', { customerToken: token, rejectTerms: true });
  assert.equal(no.body.state, 'terms_rejected');
  const blocked = await post('/api/shop/messages', { customerToken: token, text: 'sofa please' });
  assert.equal(blocked.body.state, 'terms_required');
  const yes = await post('/api/shop/messages', { customerToken: token, acceptTerms: true });
  assert.equal(yes.body.state, 'terms_accepted');
  const shop = await post('/api/shop/messages', { customerToken: token, text: 'I want a 3 seater sofa, budget 400k, I am in Sinza' });
  assert.equal(shop.body.state, 'presented');
});
