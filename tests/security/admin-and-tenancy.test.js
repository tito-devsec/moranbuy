import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, closeDatabase, db } from '../helpers/db.js';
import { makeMerchant, makeListing } from '../helpers/fixtures.js';
import { createApp } from '../../services/api/src/app.js';
import { routers } from '../../services/api/src/routers.js';
import { setShoppingDepsForTests } from '../../services/api/src/services/shopping.js';
import { setMerchantDepsForTests } from '../../services/api/src/services/merchants.js';
import { setEngagementDepsForTests } from '../../services/api/src/services/engagement.js';
import { hashPassword, signAccessToken } from '@moranbuy/authorization';
import { MuseClient } from '@moranbuy/muse-intelligence';
import { FakeGeocoder, FakeMoranInternalClient, MoranOwnerClient, signBody } from '@moranbuy/integrations';
import { SandboxPaymentProvider } from '@moranbuy/billing';
import { DryRunSender } from '@moranbuy/campaign-engine';
import { ShoppingEngine } from '@moranbuy/reverse-marketplace';
import { loadConfig } from '@moranbuy/core';
import jwt from 'jsonwebtoken';

let server; let base; let adminTok; let supportTok; let merchantTok; let mA; let mB; let listingB;
const api = (path, { method = 'GET', body, token, raw } = {}) => fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: raw ?? (body ? JSON.stringify(body) : undefined) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

before(async () => {
  await resetDatabase();
  const cfg = loadConfig({ ...process.env, MUSE_PROVIDER: 'disabled' });
  const muse = new MuseClient({ cfg, db });
  const moran = new FakeMoranInternalClient();
  setShoppingDepsForTests({ engine: new ShoppingEngine({ db, muse, geocoder: new FakeGeocoder() }), moran, muse, researcher: null });
  setMerchantDepsForTests({ moran: new MoranOwnerClient({ cfg: loadConfig({ ...process.env, MORAN_BACKEND_BASE_URL: '' }) }), geocoder: new FakeGeocoder() });
  setEngagementDepsForTests({ muse, payments: new SandboxPaymentProvider(), moran, sender: new DryRunSender(), dryRun: true, followupDryRun: true });
  server = createApp({ routers }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  await db('admin_users').insert([
    { email: 'root@moranbuy.test', name: 'Root', password_hash: await hashPassword('correct-horse-battery'), role: 'super_admin' },
    { email: 'support@moranbuy.test', name: 'Support', password_hash: await hashPassword('correct-horse-battery'), role: 'support' },
  ]);
  mA = (await makeMerchant({ name: 'Duka A' })).merchant;
  mB = (await makeMerchant({ name: 'Duka B' })).merchant;
  listingB = await makeListing(mB.id, { name: 'Sofa B', price: 100000 });
  const [u] = await db('merchant_users').insert({ merchant_id: mA.id, email: 'a@example.com', name: 'A', password_hash: await hashPassword('password123') }).returning('*');
  merchantTok = signAccessToken({ type: 'merchant', sub: u.id, merchantId: mA.id, role: 'owner', email: u.email });
});
after(async () => { server.close(); await closeDatabase(); });

test('admin endpoints refuse anonymous, merchant and forged tokens', async () => {
  assert.equal((await api('/api/admin/overview')).status, 401);
  assert.equal((await api('/api/admin/overview', { token: merchantTok })).status, 403);
  const forged = jwt.sign({ type: 'admin', sub: '00000000-0000-4000-8000-000000000000', role: 'super_admin' }, 'wrong-secret');
  assert.equal((await api('/api/admin/overview', { token: forged })).status, 401);
  const wrongPassword = await api('/api/admin/auth/login', { method: 'POST', body: { email: 'root@moranbuy.test', password: 'nope' } });
  assert.equal(wrongPassword.status, 401);
  const login = await api('/api/admin/auth/login', { method: 'POST', body: { email: 'root@moranbuy.test', password: 'correct-horse-battery' } });
  assert.equal(login.status, 200);
  adminTok = login.body.accessToken;
  supportTok = (await api('/api/admin/auth/login', { method: 'POST', body: { email: 'support@moranbuy.test', password: 'correct-horse-battery' } })).body.accessToken;
  assert.equal((await api('/api/admin/overview', { token: adminTok })).status, 200);
});

test('a support admin can read but not change; a disabled admin is cut off before the token expires', async () => {
  assert.equal((await api('/api/admin/merchants', { token: supportTok })).status, 200);
  const r = await api(`/api/admin/merchants/${mA.id}/status`, { method: 'POST', token: supportTok, body: { status: 'suspended', reason: 'test' } });
  assert.equal(r.status, 403);
  await db('admin_users').where({ email: 'support@moranbuy.test' }).update({ is_active: false });
  assert.equal((await api('/api/admin/merchants', { token: supportTok })).status, 401);
});

test('every standalone merchant is visible with its entitlements, and merchant detail never exposes encrypted secrets', async () => {
  await db('merchants').where({ id: mA.id }).update({ moran_refresh_token_encrypted: 'aaa.bbb.ccc' });
  const list = await api('/api/admin/merchants?type=standalone', { token: adminTok });
  assert.equal(list.body.merchants.length, 2);
  const detail = await api(`/api/admin/merchants/${mA.id}`, { token: adminTok });
  assert.equal(detail.status, 200);
  const text = JSON.stringify(detail.body);
  assert.doesNotMatch(text, /aaa\.bbb\.ccc/);
  assert.doesNotMatch(text, /password_hash/);
  assert.doesNotMatch(text, /refresh_token/);
});

test('a merchant token cannot reach another merchant\'s rows through any merchant route', async () => {
  for (const path of [`/api/merchant/listings/${listingB.id}`, `/api/merchant/campaigns/${listingB.id}`]) assert.equal((await api(path, { token: merchantTok })).status, 404, path);
  const steal = await api('/api/merchant/campaigns', { method: 'POST', token: merchantTok, body: { name: 'x', listingId: listingB.id } });
  assert.ok([400, 403].includes(steal.status));
  assert.equal((await api('/api/merchant/listings', { token: merchantTok })).body.listings.length, 0);
});

test('search parameters are parameterised: an injection attempt returns nothing and breaks nothing', async () => {
  const r = await api(`/api/admin/merchants?search=${encodeURIComponent("%' OR 1=1; DROP TABLE merchants; --")}`, { token: adminTok });
  assert.equal(r.status, 200);
  assert.equal(r.body.merchants.length, 0);
  assert.equal(await db.schema.hasTable('merchants'), true);
});

test('signed inbound channel: a stale timestamp, a wrong secret and a tampered body are all refused', async () => {
  const raw = JSON.stringify({ messageId: 'sec-1', from: '255700000001', text: 'hi' });
  const good = signBody(process.env.MORAN_SHARED_SECRET, raw);
  const old = signBody(process.env.MORAN_SHARED_SECRET, raw, Math.floor(Date.now() / 1000) - 3600);
  const wrong = signBody('another-secret', raw);
  const send = (sig, body) => fetch(`${base}/internal/inbound`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MoranBuy-Timestamp': sig.timestamp, 'X-MoranBuy-Signature': sig.signature }, body }).then((r) => r.status);
  assert.equal(await send(old, raw), 401);
  assert.equal(await send(wrong, raw), 401);
  assert.equal(await send(good, raw.replace('hi', 'hello')), 401);
  assert.equal(await send(good, raw), 200);
});

test('the ranking policy changes only through an audited action with a reason, and the sandbox settle route is not an open door', async () => {
  const noReason = await api('/api/admin/ranking/policy', { method: 'PUT', token: adminTok, body: { priceSimilarityPct: 3 } });
  assert.equal(noReason.status, 400);
  const ok = await api('/api/admin/ranking/policy', { method: 'PUT', token: adminTok, body: { priceSimilarityPct: 3, reason: 'Wider band for furniture pilot' } });
  assert.equal(ok.body.effective.priceSimilarityPct, 3);
  const audit = await db('audit_events').where({ action: 'ranking.policy_changed' }).first();
  assert.equal(audit.reason, 'Wider band for furniture pilot');
  assert.equal(audit.actor_type, 'admin');
  const settle = await api('/api/sandbox/payments/does-not-exist/settle', { method: 'POST', body: { status: 'completed' } });
  assert.equal(settle.body.unknown, true);
});

test('Muse telemetry shown to admins comes from stored rows and carries no key', async () => {
  const r = await api('/api/admin/muse', { token: adminTok });
  assert.equal(r.status, 200);
  assert.equal(r.body.status.provider, 'disabled');
  assert.equal(Object.hasOwn(r.body.status, 'apiKey'), false);
  const test = await api('/api/admin/muse/test', { method: 'POST', token: adminTok });
  assert.equal(test.body.result, 'disabled');
  assert.equal((await db('muse_requests').where({ feature: 'test_connection' }).count('id as n').first()).n, '1');
});
