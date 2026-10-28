import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, closeDatabase, db, redis } from '../helpers/db.js';
import { makeMerchant, acceptedCustomer } from '../helpers/fixtures.js';
import { createApp } from '../../services/api/src/app.js';
import { routers } from '../../services/api/src/routers.js';
import { WorkQueue } from '../../services/api/src/queue/work-queue.js';
import { QUEUES, queue, feedQueues, runOne } from '../../services/api/src/queue/jobs.js';
import { adminSummary } from '../../services/api/src/services/admin-summary.js';
import { MuseClient, clearMusePricingCache } from '@moranbuy/muse-intelligence';
import { hashPassword, signAccessToken } from '@moranbuy/authorization';
import { loadConfig } from '@moranbuy/core';

let server; let base; let rootTok; let shop;
const api = (path, { method = 'GET', body, token } = {}) => fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));
const wipe = async (pattern) => { const keys = await redis.keys(pattern); if (keys.length) await redis.del(...keys); };
// A Muse that answers with fixed token usage, so cost can be checked exactly.
const museWith = (usage = { prompt_tokens: 1000, completion_tokens: 500 }) => new MuseClient({ cfg: loadConfig({ ...process.env, MUSE_PROVIDER: 'meta', MUSE_API_KEY: 'k' }), db, fetchImpl: async () => new Response(JSON.stringify({ model: 'muse-spark-1.3', choices: [{ message: { content: '{"ok":true}' } }], usage }), { status: 200 }) });

before(async () => {
  await resetDatabase();
  if (redis.status === 'wait') await redis.connect();
  await wipe('moranbuy:queue:*'); await wipe('moranbuy:test:*');
  server = createApp({ routers }).listen(0); base = `http://127.0.0.1:${server.address().port}`;
  shop = (await makeMerchant({ name: 'Duka la Gharama' })).merchant;
  const [root] = await db('admin_users').insert({ email: 'root@moranbuy.test', name: 'Root', password_hash: await hashPassword('x'.repeat(12)), role: 'super_admin' }).returning('*');
  rootTok = signAccessToken({ type: 'admin', sub: root.id, role: 'super_admin', email: root.email });
  clearMusePricingCache();
});
after(async () => { await wipe('moranbuy:queue:*'); await wipe('moranbuy:test:*'); server.close(); await closeDatabase(); });

test('a job waits for its time, is leased to one worker, and is counted when done; adding it again only moves it earlier', async () => {
  const q = new WorkQueue(redis, 'basic', { prefix: 'moranbuy:test', leaseMs: 1000 });
  const t0 = Date.now();
  await q.enqueue('job-1', t0 + 60000);
  await q.enqueue('job-1', t0 + 120000);
  assert.equal(await q.reserve(t0), null, 'not due yet');
  await q.enqueue('job-1', t0 + 30000);
  assert.equal((await q.stats(t0)).queued, 1, 'one job, not three');
  assert.equal(await q.reserve(t0 + 30000), 'job-1');
  assert.equal(await q.reserve(t0 + 30000), null, 'leased to the first taker only');
  assert.equal((await q.stats(t0 + 30000)).leased, 1);
  await q.ack('job-1');
  const s = await q.stats(t0 + 30000);
  assert.deepEqual([s.queued, s.leased, s.done], [0, 0, 1]);
});

test('a job whose worker died comes back after its lease; failures retry with a growing delay and end on the dead list', async () => {
  const q = new WorkQueue(redis, 'faults', { prefix: 'moranbuy:test', leaseMs: 1000, maxAttempts: 3 });
  const t0 = Date.now();
  await q.enqueue('crashy', t0);
  assert.equal(await q.reserve(t0), 'crashy');
  assert.equal(await q.reap(t0 + 500), 0, 'lease still running');
  assert.equal(await q.reap(t0 + 1500), 1);
  assert.equal(await q.reserve(t0 + 1500), 'crashy');
  assert.equal(await q.fail('crashy', new Error('boom'), t0 + 1500), 'retry');
  assert.equal(await q.reserve(t0 + 1500), null, 'retried after a delay, not at once');
  assert.equal(await q.reserve(t0 + 1500 + 5000), 'crashy');
  assert.equal(await q.fail('crashy', new Error('boom'), t0 + 7000), 'retry');
  assert.equal(await q.reserve(t0 + 7000 + 10000), 'crashy');
  assert.equal(await q.fail('crashy', new Error('still boom'), t0 + 20000), 'dead');
  const dead = await q.deadJobs();
  assert.equal(dead[0].id, 'crashy');
  assert.equal(dead[0].attempts, 3);
  assert.equal(dead[0].error, 'still boom');
  assert.equal(await q.retryDead(t0 + 30000), 1);
  assert.equal(await q.reserve(t0 + 30000), 'crashy');
});

test('the feeder loads what Postgres says is due, and each job handles only the item it names', async () => {
  // No quiet hours here, so the result does not depend on the hour the suite runs (21:00 to 08:00 EAT would hold the reminder).
  await db('platform_settings').insert({ key: 'notification_schedule_reminder', value: JSON.stringify({ quietFrom: 0, quietTo: 0 }) }).onConflict('key').merge();
  const c = await acceptedCustomer('255700000901');
  await db('customers').where({ id: c.id }).update({ last_seen_at: new Date() });
  const [due] = await db('customer_schedules').insert({ customer_id: c.id, kind: 'purchase_plan', due_at: new Date(Date.now() - 1000), when_text: 'leo' }).returning('*');
  const [later] = await db('customer_schedules').insert({ customer_id: c.id, kind: 'purchase_plan', due_at: new Date(Date.now() + 3600000), when_text: 'baadaye' }).returning('*');
  const [camp] = await db('campaigns').insert({ merchant_id: shop.id, kind: 'campaign', name: 'Ratiba', status: 'scheduled', scheduled_at: new Date(Date.now() - 1000), audience_json: '{}' }).returning('*');
  const fed = await feedQueues({ horizonMs: 120000 });
  assert.equal(fed.reminder, 1, 'only the schedule due within two minutes');
  assert.equal(fed['campaign-start'], 1);
  assert.ok(await redis.zscore('moranbuy:queue:reminder:jobs', due.id));
  assert.equal(await redis.zscore('moranbuy:queue:reminder:jobs', later.id), null);
  // The reminder job runs (dry run by default): the schedule is reminded and the job is done.
  const r = await runOne('reminder');
  assert.equal(r.id, due.id);
  assert.equal(r.ok, true);
  assert.equal((await db('customer_schedules').where({ id: due.id }).first()).status, 'reminded');
  assert.equal((await db('customer_schedules').where({ id: later.id }).first()).status, 'scheduled');
  // The campaign job re-runs the gates for that campaign only; with no payment it fails with the reason instead of sending.
  const s = await runOne('campaign-start');
  assert.equal(s.ok, true);
  const after = await db('campaigns').where({ id: camp.id }).first();
  assert.equal(after.status, 'failed');
  assert.match(after.status_reason, /payment/);
  assert.equal((await queue('campaign-dispatch').stats()).queued, 0, 'a failed start is not handed to dispatch');
  // A repeated job for work already done changes nothing.
  await queue('reminder').enqueue(due.id);
  assert.equal((await runOne('reminder')).out.sent, 0);
});

test('a handler that throws is retried, and admins see queue state and can send dead jobs back', async () => {
  const original = QUEUES.reminder.handle;
  QUEUES.reminder.handle = async () => { throw new Error('database hiccup'); };
  await queue('reminder').enqueue('00000000-0000-4000-8000-000000000001');
  const r = await runOne('reminder');
  QUEUES.reminder.handle = original;
  assert.equal(r.ok, false);
  assert.equal(r.fate, 'retry');
  const view = await api('/api/admin/queues', { token: rootTok });
  assert.equal(view.status, 200);
  assert.equal(view.body.mode, 'redis');
  assert.deepEqual(view.body.queues.map((q) => q.queue).sort(), ['campaign-dispatch', 'campaign-start', 'followup', 'reminder']);
  assert.ok(view.body.queues.find((q) => q.queue === 'reminder').queued >= 1);
  await redis.lpush('moranbuy:queue:followup:dead', JSON.stringify({ id: 'task-x', error: 'x', attempts: 5 }));
  assert.equal((await api('/api/admin/queues/followup/retry-dead', { method: 'POST', token: rootTok, body: {} })).status, 400);
  const retried = await api('/api/admin/queues/followup/retry-dead', { method: 'POST', token: rootTok, body: { reason: 'Database is back' } });
  assert.equal(retried.body.retried, 1);
  assert.ok(await redis.zscore('moranbuy:queue:followup:jobs', 'task-x'));
});

test('with rates set, every Muse request carries its cost; past unpriced requests can be priced, and the report adds it up by feature, business and day', async () => {
  // A request before any rate: tokens counted, no cost.
  await museWith().complete({ feature: 'intent', system: 's', messages: [{ role: 'user', content: 'x' }] });
  let row = await db('muse_requests').orderBy('id', 'desc').first();
  assert.equal(row.input_tokens, 1000);
  assert.equal(row.cost_usd, null);
  let report = await api('/api/admin/muse/cost', { token: rootTok });
  assert.equal(report.body.ratesSet, false);
  assert.equal(report.body.unpricedRequests, 1);
  const set = await api('/api/admin/muse/pricing', { method: 'PUT', token: rootTok, body: { inputPerMillionUsd: 1, outputPerMillionUsd: 2, usdToTzs: 2500, applyToPast: true, reason: 'Rates from the Meta billing page' } });
  assert.equal(set.status, 200);
  assert.equal(set.body.repriced, 1);
  // 1,000 input at $1 per million plus 500 output at $2 per million is $0.002.
  await museWith().complete({ feature: 'recommendation', system: 's', messages: [{ role: 'user', content: 'x' }], merchantId: shop.id });
  row = await db('muse_requests').orderBy('id', 'desc').first();
  assert.equal(Number(row.cost_usd), 0.002);
  report = await api('/api/admin/muse/cost?days=30', { token: rootTok });
  assert.equal(report.body.ratesSet, true);
  assert.equal(report.body.unpricedRequests, 0);
  assert.equal(report.body.totals.costUsd, 0.004);
  assert.equal(report.body.totals.costTzs, 10);
  assert.equal(report.body.monthToDate.costUsd, 0.004);
  assert.ok(report.body.monthToDate.projectedUsd >= 0.004);
  assert.deepEqual(report.body.byFeature.map((f) => f.feature).sort(), ['intent', 'recommendation']);
  assert.equal(report.body.byMerchant.find((m) => m.business === 'Duka la Gharama').costUsd, 0.002);
  assert.equal(report.body.byDay.length, 1);
  assert.ok(await db('audit_events').where({ action: 'muse.pricing_changed' }).first());
});

test('a monthly budget alerts as it nears, and with the hard cap on Muse stops at the budget so every duty falls back', async () => {
  await api('/api/admin/muse/pricing', { method: 'PUT', token: rootTok, body: { monthlyBudgetUsd: 0.005, hardCap: false, reason: 'Small test budget' } });
  let report = await api('/api/admin/muse/cost', { token: rootTok });
  assert.equal(report.body.budget.alert, true, '$0.004 of $0.005 is past 80%');
  assert.equal(report.body.budget.blocked, false);
  await museWith().complete({ feature: 'intent', system: 's', messages: [{ role: 'user', content: 'x' }] });
  // Over budget without the cap: still calling, only alerting.
  assert.equal((await museWith().complete({ feature: 'intent', system: 's', messages: [{ role: 'user', content: 'x' }] })).ok, true);
  await api('/api/admin/muse/pricing', { method: 'PUT', token: rootTok, body: { hardCap: true, reason: 'Stop at the budget' } });
  const blocked = await museWith().complete({ feature: 'intent', system: 's', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 'budget_exceeded');
  assert.equal((await db('muse_requests').orderBy('id', 'desc').first()).status, 'budget_exceeded');
  // The connection test still works so an admin can check the key.
  assert.equal((await museWith().complete({ feature: 'test_connection', system: 's', messages: [{ role: 'user', content: 'x' }] })).ok, true);
  report = await api('/api/admin/muse/cost', { token: rootTok });
  assert.equal(report.body.budget.blocked, true);
  const s = await adminSummary({ section: 'muse' });
  assert.ok(s.checks.some((c) => /budget of \$0.005 is used up/.test(c)), JSON.stringify(s.checks));
  // Raising the budget lets Muse run again at once.
  await api('/api/admin/muse/pricing', { method: 'PUT', token: rootTok, body: { monthlyBudgetUsd: 10, reason: 'Raise the budget' } });
  assert.equal((await museWith().complete({ feature: 'intent', system: 's', messages: [{ role: 'user', content: 'x' }] })).ok, true);
});
