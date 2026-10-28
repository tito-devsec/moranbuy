import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, closeDatabase, db } from '../helpers/db.js';
import { makeMerchant, makeListing } from '../helpers/fixtures.js';
import { createApp } from '../../services/api/src/app.js';
import { routers } from '../../services/api/src/routers.js';
import { purgeExpired, loadRetention } from '../../services/api/src/services/retention.js';
import { hashPassword, signAccessToken } from '@moranbuy/authorization';

let server; let base; let rootTok; let adminTok; let shop; let listing;
const api = (path, { method = 'GET', body, token } = {}) => fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const count = async (table, where = {}) => Number((await db(table).where(where).count('* as n').first()).n);

// One customer per situation, with records old and new, so the purge can be checked table by table.
async function seed() {
  const mk = async (phone, lastSeenDays) => (await db('customers').insert({ channel: 'whatsapp', channel_ref: phone, last_seen_at: daysAgo(lastSeenDays), created_at: daysAgo(lastSeenDays + 1) }).returning('*'))[0];
  const buyer = await mk('255700000101', 800);      // ordered long ago: kept
  const ghost = await mk('255700000102', 800);      // never ordered, silent for 800 days: removed
  const recent = await mk('255700000103', 10);      // active: kept
  const [oldSession] = await db('shopping_sessions').insert({ customer_id: recent.id, state: 'closed', updated_at: daysAgo(400), created_at: daysAgo(400) }).returning('*');
  const [newSession] = await db('shopping_sessions').insert({ customer_id: recent.id, state: 'presented', updated_at: daysAgo(1) }).returning('*');
  await db('session_messages').insert([{ session_id: newSession.id, direction: 'in', content: 'zamani', content_type: 'text', created_at: daysAgo(200) }, { session_id: newSession.id, direction: 'in', content: 'jana', content_type: 'text', created_at: daysAgo(1) }]);
  await db('session_messages').insert({ session_id: oldSession.id, direction: 'in', content: 'old session', content_type: 'text', created_at: daysAgo(100) });
  await db('matching_runs').insert([{ session_id: newSession.id, request_json: '{}', policy_json: '{}', candidates: 1, ranked: 1, over_budget: 0, excluded: 0, none_within_budget: false, created_at: daysAgo(400) }, { session_id: newSession.id, request_json: '{}', policy_json: '{}', candidates: 1, ranked: 1, over_budget: 0, excluded: 0, none_within_budget: false, created_at: daysAgo(5) }]);
  await db('demand_signals').insert([{ customer_id: recent.id, product_type: 'sofa', intent: 'shop', created_at: daysAgo(800) }, { customer_id: recent.id, product_type: 'sofa', intent: 'shop', created_at: daysAgo(3) }]);
  await db('customer_schedules').insert([{ customer_id: recent.id, kind: 'reminder', status: 'done', updated_at: daysAgo(200) }, { customer_id: recent.id, kind: 'reminder', status: 'scheduled', updated_at: daysAgo(200) }]);
  const [order] = await db('orders').insert({ order_ref: 'MB-OLD1', customer_id: buyer.id, merchant_id: shop.id, listing_id: listing.id, quantity: 1, unit_price: 1000, known_total: 1000, total_confirmed: true, currency: 'TZS', fulfilment: 'delivery', customer_location_json: JSON.stringify({ label: 'Sinza' }), status: 'fulfilled', confirmed_at: daysAgo(800), created_at: daysAgo(800) }).returning('*');
  await db('webhook_events').insert([{ source: 'moran', event_id: 'old', event_type: 'x', received_at: daysAgo(100) }, { source: 'moran', event_id: 'new', event_type: 'x', received_at: daysAgo(1) }]);
  await db('muse_requests').insert({ feature: 'intent', provider: 'meta', model: 'm', status: 'ok', created_at: daysAgo(400) });
  await db('consent_events').insert({ phone: '255700000102', purpose: 'marketing', status: 'granted', source: 'test', channel: 'whatsapp', created_at: daysAgo(900) });
  return { buyer, ghost, recent, oldSession, newSession, order };
}

let s;
before(async () => {
  await resetDatabase();
  server = createApp({ routers }).listen(0); base = `http://127.0.0.1:${server.address().port}`;
  shop = (await makeMerchant({ name: 'Duka' })).merchant;
  listing = await makeListing(shop.id, { name: 'Sofa', price: 1000 });
  const [root] = await db('admin_users').insert({ email: 'root@moranbuy.test', name: 'Root', password_hash: await hashPassword('x'.repeat(12)), role: 'super_admin' }).returning('*');
  rootTok = signAccessToken({ type: 'admin', sub: root.id, role: 'super_admin', email: root.email });
  const [adm] = await db('admin_users').insert({ email: 'ops@moranbuy.test', name: 'Ops', password_hash: await hashPassword('x'.repeat(12)), role: 'admin' }).returning('*');
  adminTok = signAccessToken({ type: 'admin', sub: adm.id, role: 'admin', email: adm.email });
  s = await seed();
});
after(async () => { server.close(); await closeDatabase(); });

test('a dry run counts what has expired and changes nothing', async () => {
  const before = { msgs: await count('session_messages'), customers: await count('customers'), signals: await count('demand_signals') };
  const out = await purgeExpired({ dryRun: true });
  assert.equal(out.dryRun, true);
  // Only the 200-day message is past its own limit; the 100-day one goes with its expired session.
  assert.equal(out.result.session_messages.expired, 1);
  assert.equal(out.result.shopping_sessions.expired, 1);
  assert.equal(out.result.customers.expired, 1);
  assert.equal(out.result['orders:scrubbed'].expired, 1);
  assert.equal(out.totals.removed, 0);
  assert.deepEqual({ msgs: await count('session_messages'), customers: await count('customers'), signals: await count('demand_signals') }, before);
  assert.ok((await db('platform_settings').where({ key: 'retention_last_preview' }).first()).value.totals.expired > 0);
});

test('a real purge removes only expired records and never touches orders, consent or the audit trail', async () => {
  const out = await purgeExpired({ dryRun: false, actor: 'test', reason: 'test purge' });
  assert.ok(out.totals.removed > 0);
  // Chat words: the 200-day message goes (and the old closed session with its message), yesterday's stays.
  assert.deepEqual((await db('session_messages').pluck('content')).sort(), ['jana']);
  assert.equal(await count('shopping_sessions', { id: s.oldSession.id }), 0);
  assert.equal(await count('shopping_sessions', { id: s.newSession.id }), 1);
  assert.equal(await count('matching_runs'), 1);
  assert.equal(await count('demand_signals'), 1);
  // Finished schedules go; one still waiting stays whatever its age.
  assert.deepEqual(await db('customer_schedules').pluck('status'), ['scheduled']);
  assert.deepEqual(await db('webhook_events').pluck('event_id'), ['new']);
  assert.equal(await count('muse_requests'), 0);
  // The silent customer who never ordered is gone; the buyer and the active customer stay.
  assert.equal(await count('customers', { id: s.ghost.id }), 0);
  assert.equal(await count('customers', { id: s.buyer.id }), 1);
  assert.equal(await count('customers', { id: s.recent.id }), 1);
  // The old order stays as the record of a sale, with the delivery location removed.
  const order = await db('orders').where({ id: s.order.id }).first();
  assert.equal(order.status, 'fulfilled');
  assert.equal(order.customer_location_json, null);
  assert.equal(await count('consent_events'), 1);
  assert.ok(await db('audit_events').where({ action: 'retention.purged' }).first());
  // A second run finds nothing more.
  assert.equal((await purgeExpired({ dryRun: false })).totals.removed, 0);
});

test('admins set retention periods above the floors; only a super admin with confirmation may purge by hand', async () => {
  assert.equal((await api('/api/admin/retention', { method: 'PUT', token: rootTok, body: { sessionMessagesDays: 10, reason: 'too short' } })).status, 400);
  const put = await api('/api/admin/retention', { method: 'PUT', token: rootTok, body: { sessionMessagesDays: 90, reason: 'Shorter chat history' } });
  assert.equal(put.status, 200);
  assert.equal(put.body.settings.sessionMessagesDays, 90);
  assert.equal((await loadRetention()).demandSignalsDays, 730);
  const view = await api('/api/admin/retention', { token: rootTok });
  assert.equal(view.body.scheduledDryRun, true);
  assert.ok(view.body.neverPurged.includes('orders'));
  // The last run is the empty second pass of the previous test.
  assert.equal(view.body.lastRun.totals.removed, 0);
  assert.ok(view.body.lastRun.ranAt);
  const preview = await api('/api/admin/retention/run', { method: 'POST', token: adminTok, body: { dryRun: true, reason: 'Checking counts' } });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.dryRun, true);
  assert.equal((await api('/api/admin/retention/run', { method: 'POST', token: adminTok, body: { dryRun: false, confirm: true, reason: 'Ops purge' } })).status, 403);
  assert.equal((await api('/api/admin/retention/run', { method: 'POST', token: rootTok, body: { dryRun: false, reason: 'No confirm' } })).body.error, 'CONFIRM_REQUIRED');
  const run = await api('/api/admin/retention/run', { method: 'POST', token: rootTok, body: { dryRun: false, confirm: true, reason: 'Monthly purge' } });
  assert.equal(run.status, 200);
  assert.equal(run.body.actor, 'root@moranbuy.test');
});
