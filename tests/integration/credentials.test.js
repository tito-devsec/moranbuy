import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, closeDatabase, db } from '../helpers/db.js';
import { createApp } from '../../services/api/src/app.js';
import { routers } from '../../services/api/src/routers.js';
import { setShoppingDepsForTests } from '../../services/api/src/services/shopping.js';
import { setEngagementDepsForTests } from '../../services/api/src/services/engagement.js';
import { museRuntimeConfig, paymentRuntimeConfig, resetCredentialsCacheForTests } from '../../services/api/src/services/runtime-settings.js';
import { hashPassword } from '@moranbuy/authorization';
import { MuseClient } from '@moranbuy/muse-intelligence';
import { RuntimePaymentProvider } from '@moranbuy/billing';
import { FakeGeocoder, FakeMoranInternalClient } from '@moranbuy/integrations';
import { DryRunSender } from '@moranbuy/campaign-engine';
import { ShoppingEngine } from '@moranbuy/reverse-marketplace';
import { loadConfig } from '@moranbuy/core';

let server; let base; let tok; let museCalls = [];
const api = (path, { method = 'GET', body, token } = {}) => fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));

before(async () => {
  await resetDatabase();
  resetCredentialsCacheForTests();
  const cfg = loadConfig({ ...process.env, MUSE_PROVIDER: 'disabled' });
  const fetchImpl = async (url, init) => { museCalls.push({ url, auth: init.headers.Authorization, model: JSON.parse(init.body).model }); return new Response(JSON.stringify({ model: 'muse-spark-1.3', choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }), { status: 200 }); };
  const muse = new MuseClient({ cfg, db, fetchImpl, resolve: () => museRuntimeConfig({ fresh: true }) });
  const moran = new FakeMoranInternalClient();
  setShoppingDepsForTests({ engine: new ShoppingEngine({ db, muse, geocoder: new FakeGeocoder() }), moran, muse, researcher: null });
  setEngagementDepsForTests({ muse, payments: new RuntimePaymentProvider({ resolve: () => paymentRuntimeConfig({ fresh: true }), cfg }), moran, sender: new DryRunSender(), dryRun: true, followupDryRun: true });
  server = createApp({ routers }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  await db('admin_users').insert({ email: 'root@moranbuy.test', name: 'Root', password_hash: await hashPassword('correct-horse-battery'), role: 'super_admin' });
  tok = (await api('/api/admin/auth/login', { method: 'POST', body: { email: 'root@moranbuy.test', password: 'correct-horse-battery' } })).body.accessToken;
});
after(async () => { server.close(); await closeDatabase(); });

test('without a key Muse is disabled and the admin page says so', async () => {
  const r = await api('/api/admin/credentials', { token: tok });
  assert.equal(r.body.credentials.muse.apiKey.configured, false);
  assert.equal(r.body.credentials.muse.source, 'none');
  assert.equal((await api('/api/admin/muse/test', { method: 'POST', token: tok })).body.result, 'disabled');
});

test('entering the Muse key in Admin makes Muse work at once, stores it encrypted and never echoes it', async () => {
  const r = await api('/api/admin/credentials/muse', { method: 'PUT', token: tok, body: { apiKey: 'meta-live-key-ABCD1234', model: 'muse-spark-1.3', reason: 'go live' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.credentials.muse.apiKey.configured, true);
  assert.equal(r.body.credentials.muse.apiKey.last4, '1234');
  assert.equal(r.body.credentials.muse.source, 'admin');
  assert.doesNotMatch(JSON.stringify(r.body), /meta-live-key/);
  const stored = await db('platform_settings').where({ key: 'credentials' }).first();
  assert.doesNotMatch(JSON.stringify(stored.value), /meta-live-key/);
  const t = await api('/api/admin/muse/test', { method: 'POST', token: tok });
  assert.equal(t.body.result, 'ok');
  assert.equal(museCalls.at(-1).auth, 'Bearer meta-live-key-ABCD1234');
  assert.equal(museCalls.at(-1).url, 'https://api.meta.ai/v1/chat/completions');
  const status = await api('/api/admin/muse', { token: tok });
  assert.equal(status.body.status.enabled, true);
  assert.equal(Object.hasOwn(status.body.status, 'apiKey'), false);
  const audit = await db('audit_events').where({ action: 'credentials.muse_updated' }).first();
  assert.equal(audit.reason, 'go live');
});

test('only a super admin may change credentials and a blank secret keeps the old one', async () => {
  await db('admin_users').insert({ email: 'ops@moranbuy.test', name: 'Ops', password_hash: await hashPassword('correct-horse-battery'), role: 'admin' });
  const ops = (await api('/api/admin/auth/login', { method: 'POST', body: { email: 'ops@moranbuy.test', password: 'correct-horse-battery' } })).body.accessToken;
  assert.equal((await api('/api/admin/credentials/muse', { method: 'PUT', token: ops, body: { apiKey: 'x', reason: 'nope' } })).status, 403);
  const keep = await api('/api/admin/credentials/muse', { method: 'PUT', token: tok, body: { model: 'muse-spark-1.2', reason: 'older model' } });
  assert.equal(keep.body.credentials.muse.apiKey.last4, '1234');
  assert.equal(keep.body.credentials.muse.model, 'muse-spark-1.2');
  await api('/api/admin/muse/test', { method: 'POST', token: tok });
  assert.equal(museCalls.at(-1).model, 'muse-spark-1.2');
});

test('Snippe keys entered in Admin switch payments from the sandbox to Snippe', async () => {
  assert.equal((await paymentRuntimeConfig({ fresh: true })).provider, 'sandbox');
  await api('/api/admin/credentials/snippe', { method: 'PUT', token: tok, body: { apiKey: 'snippe-key-9999', webhookSecret: 'whsec', reason: 'from the VPS .env' } });
  const p = await paymentRuntimeConfig({ fresh: true });
  assert.equal(p.provider, 'snippe');
  assert.equal(p.apiKey, 'snippe-key-9999');
  const shown = await api('/api/admin/credentials', { token: tok });
  assert.equal(shown.body.credentials.snippe.webhookSecret.configured, true);
  assert.doesNotMatch(JSON.stringify(shown.body), /snippe-key-9999|whsec/);
});
