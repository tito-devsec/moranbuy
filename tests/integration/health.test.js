import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import '../helpers/env.js';
import { createApp } from '../../services/api/src/app.js';
import { db } from '../../services/api/src/db/connection.js';
import { redis } from '../../services/api/src/db/redis.js';

const app = createApp();
const server = app.listen(0);
const base = () => `http://127.0.0.1:${server.address().port}`;

after(async () => { server.close(); await db.destroy(); redis.disconnect(); });

test('GET /health answers without infrastructure', async () => {
  const res = await fetch(`${base()}/health`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test('GET /ready reports the real state of Postgres and Redis', async () => {
  const res = await fetch(`${base()}/ready`);
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.deepEqual(body.checks, { database: 'ok', redis: 'ok' });
});

test('migrations are applied and the foundation tables exist', async () => {
  for (const t of ['admin_users', 'merchants', 'merchant_entitlements', 'audit_events', 'webhook_events', 'muse_requests']) {
    assert.equal(await db.schema.hasTable(t), true, `${t} missing`);
  }
});

test('unknown routes answer JSON 404', async () => {
  const res = await fetch(`${base()}/api/nothing`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'NOT_FOUND');
});
