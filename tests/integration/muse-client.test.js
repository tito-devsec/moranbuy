import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, closeDatabase, db } from '../helpers/db.js';
import { MuseClient, museTelemetry } from '@moranbuy/muse-intelligence';
import { loadConfig } from '@moranbuy/core';

before(resetDatabase);
after(closeDatabase);

const cfg = loadConfig({ ...process.env, MUSE_PROVIDER: 'meta', MUSE_API_KEY: 'test-key', MUSE_TIMEOUT_MS: '200' });
const completion = (content, model = 'muse-spark-1.3') => new Response(JSON.stringify({ model, choices: [{ message: { content } }], usage: { prompt_tokens: 12, completion_tokens: 5 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('a successful call sends the documented request shape and records real token and latency telemetry', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init: JSON.parse(init.body), auth: init.headers.Authorization }; return completion('{"productType":"sofa","maxBudget":350000}'); };
  const muse = new MuseClient({ cfg, db, fetchImpl });
  const r = await muse.complete({ feature: 'intent', system: 'x', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.ok, true);
  assert.equal(r.json.productType, 'sofa');
  assert.equal(seen.url, 'https://api.meta.ai/v1/chat/completions');
  assert.equal(seen.auth, 'Bearer test-key');
  assert.equal(seen.init.model, 'muse-spark-1.3');
  assert.equal(seen.init.messages[0].role, 'developer');
  assert.deepEqual(seen.init.response_format, { type: 'json_object' });
  const row = await db('muse_requests').orderBy('id', 'desc').first();
  assert.equal(row.status, 'ok');
  assert.equal(row.input_tokens, 12);
  assert.equal(row.output_tokens, 5);
  assert.equal(row.feature, 'intent');
});

test('HTTP errors, bad JSON and timeouts are recorded as what they are and never as success', async () => {
  const bad = new MuseClient({ cfg, db, fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'key sk-abcdefghijklmnopqrstuvwxyz revoked' } }), { status: 401 }) });
  const r1 = await bad.complete({ feature: 'intent', system: 'x', messages: [] });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'HTTP_401');
  const notJson = new MuseClient({ cfg, db, fetchImpl: async () => completion('not json at all') });
  const r2 = await notJson.complete({ feature: 'intent', system: 'x', messages: [] });
  assert.equal(r2.code, 'BAD_JSON');
  const slow = new MuseClient({ cfg, db, fetchImpl: (_u, init) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'TimeoutError' })))) });
  const r3 = await slow.complete({ feature: 'intent', system: 'x', messages: [] });
  assert.equal(r3.status, 'timeout');
  const rows = await db('muse_requests').orderBy('id', 'desc').limit(3);
  assert.deepEqual(rows.map((r) => r.status).sort(), ['error', 'error', 'timeout']);
  assert.ok(rows.every((r) => !String(r.error_redacted || '').includes('sk-abcdefghijklmnopqrstuvwxyz')));
});

test('a disabled provider records a disabled outcome and the telemetry summary is built from the stored rows', async () => {
  const off = new MuseClient({ cfg: loadConfig({ ...process.env, MUSE_PROVIDER: 'disabled' }), db });
  const r = await off.complete({ feature: 'recommendation', system: 'x', messages: [] });
  assert.equal(r.status, 'disabled');
  const t = await museTelemetry(db, { sinceHours: 1 });
  assert.equal(t.requests, 5);
  assert.equal(t.ok, 1);
  assert.equal(t.failed, 4);
  assert.equal(t.byFeature.intent.requests, 4);
  assert.equal(t.lastSuccess.model, 'muse-spark-1.3');
  assert.equal(t.inputTokens, 24);
});

test('testConnection reports the real result of a real request', async () => {
  const muse = new MuseClient({ cfg, db, fetchImpl: async () => completion('{"ok":true}') });
  const s = await muse.testConnection();
  assert.equal(s.result, 'ok');
  assert.equal(s.model, 'muse-spark-1.3');
  assert.equal(s.configured, true);
  assert.equal(Object.hasOwn(s, 'apiKey'), false);
});
