import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, closeDatabase, db } from '../helpers/db.js';
import { createApp } from '../../services/api/src/app.js';
import { routers } from '../../services/api/src/routers.js';
import { signAdminProxy } from '../../services/api/src/middleware/proxied-admin.js';
import { setShoppingDepsForTests } from '../../services/api/src/services/shopping.js';
import { setEngagementDepsForTests } from '../../services/api/src/services/engagement.js';
import { MuseClient } from '@moranbuy/muse-intelligence';
import { FakeGeocoder, FakeMoranInternalClient } from '@moranbuy/integrations';
import { SandboxPaymentProvider } from '@moranbuy/billing';
import { DryRunSender } from '@moranbuy/campaign-engine';
import { ShoppingEngine } from '@moranbuy/reverse-marketplace';
import { loadConfig } from '@moranbuy/core';

let server; let base;
before(async () => {
  await resetDatabase();
  const cfg = loadConfig({ ...process.env, MUSE_PROVIDER: 'disabled' });
  const muse = new MuseClient({ cfg, db }); const moran = new FakeMoranInternalClient();
  setShoppingDepsForTests({ engine: new ShoppingEngine({ db, muse, geocoder: new FakeGeocoder() }), moran, muse, researcher: null });
  setEngagementDepsForTests({ muse, payments: new SandboxPaymentProvider(), moran, sender: new DryRunSender(), dryRun: true, followupDryRun: true });
  server = createApp({ routers }).listen(0); base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await closeDatabase(); });

const call = (method, path, { body = null, email = 'ops@moranai.co.tz', role = 'super_admin', secret = process.env.MORAN_SHARED_SECRET, ts } = {}) => {
  const raw = body ? JSON.stringify(body) : '';
  const { timestamp, signature } = signAdminProxy(secret, { method, path, rawBody: raw, timestamp: ts });
  return fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-MoranBuy-Timestamp': timestamp, 'X-MoranBuy-Signature': signature, 'X-MoranBuy-Admin-Email': email, 'X-MoranBuy-Admin-Name': 'Ops', 'X-MoranBuy-Admin-Role': role }, body: raw || undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));
};

test('a Super Admin request signed by Moran is accepted without a MoranBuy login and is audited under that admin', async () => {
  const r = await call('GET', '/api/admin/overview');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const w = await call('PUT', '/api/admin/ranking/policy', { body: { priceSimilarityPct: 4, reason: 'from weare' } });
  assert.equal(w.status, 200);
  const audit = await db('audit_events').where({ action: 'ranking.policy_changed' }).first();
  const admin = await db('admin_users').where({ email: 'ops@moranai.co.tz' }).first();
  assert.equal(audit.actor_id, admin.id);
  assert.match(admin.password_hash, /^proxied:/);
});

test('wrong secret, stale timestamp, a replay against another path, and a tampered body are refused', async () => {
  assert.equal((await call('GET', '/api/admin/overview', { secret: 'other' })).status, 401);
  assert.equal((await call('GET', '/api/admin/overview', { ts: Math.floor(Date.now() / 1000) - 3600 })).status, 401);
  const { timestamp, signature } = signAdminProxy(process.env.MORAN_SHARED_SECRET, { method: 'GET', path: '/api/admin/overview' });
  const replay = await fetch(`${base}/api/admin/audit`, { headers: { 'X-MoranBuy-Timestamp': timestamp, 'X-MoranBuy-Signature': signature, 'X-MoranBuy-Admin-Email': 'ops@moranai.co.tz' } });
  assert.equal(replay.status, 401);
  const signed = signAdminProxy(process.env.MORAN_SHARED_SECRET, { method: 'PUT', path: '/api/admin/ranking/policy', rawBody: JSON.stringify({ priceSimilarityPct: 1, reason: 'x' }) });
  const tampered = await fetch(`${base}/api/admin/ranking/policy`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-MoranBuy-Timestamp': signed.timestamp, 'X-MoranBuy-Signature': signed.signature, 'X-MoranBuy-Admin-Email': 'ops@moranai.co.tz', 'X-MoranBuy-Admin-Role': 'super_admin' }, body: JSON.stringify({ priceSimilarityPct: 9, reason: 'x' }) });
  assert.equal(tampered.status, 401);
});

test('Moran roles map to MoranBuy roles: support reads, admin manages, only super_admin changes credentials', async () => {
  assert.equal((await call('GET', '/api/admin/merchants', { email: 'viewer@moranai.co.tz', role: 'viewer' })).status, 200);
  assert.equal((await call('PUT', '/api/admin/ranking/policy', { email: 'viewer@moranai.co.tz', role: 'viewer', body: { priceSimilarityPct: 2, reason: 'no' } })).status, 403);
  assert.equal((await call('PUT', '/api/admin/credentials/muse', { email: 'fin@moranai.co.tz', role: 'admin', body: { apiKey: 'k', reason: 'no' } })).status, 403);
  assert.equal((await call('PUT', '/api/admin/credentials/muse', { body: { apiKey: 'live-key-0001', reason: 'from weare' } })).status, 200);
});
