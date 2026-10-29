import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resetDatabase, closeDatabase, db } from '../helpers/db.js';
import { makeMerchant, acceptedCustomer } from '../helpers/fixtures.js';
import { createApp } from '../../services/api/src/app.js';
import { routers } from '../../services/api/src/routers.js';
import { setShoppingDepsForTests } from '../../services/api/src/services/shopping.js';
import { purgeExpired } from '../../services/api/src/services/retention.js';
import { uploadDir, sniff, publicUpload } from '../../services/api/src/services/uploads.js';
import { adminSummary } from '../../services/api/src/services/admin-summary.js';
import { ShoppingEngine } from '@moranbuy/reverse-marketplace';
import { MuseClient } from '@moranbuy/muse-intelligence';
import { FakeGeocoder, FakeMoranInternalClient, signBody } from '@moranbuy/integrations';
import { hashPassword, signAccessToken } from '@moranbuy/authorization';
import { loadConfig } from '@moranbuy/core';

let server; let base; let shop; let other; let tok; let otherTok; let rootTok; let museSeen = [];
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 3)]);
const HTML = Buffer.from('<html><script>alert(1)</script></html>');
const send = (url, { method = 'POST', body, type, token } = {}) => fetch(`${base}${url}`, { method, headers: { ...(type ? { 'Content-Type': type } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body }).then(async (r) => ({ status: r.status, headers: r.headers, buf: Buffer.from(await r.arrayBuffer()) })).then((r) => ({ ...r, body: (() => { try { return JSON.parse(r.buf.toString('utf8')); } catch { return null; } })() }));
const json = (url, { method = 'GET', body, token } = {}) => fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));

before(async () => {
  await resetDatabase();
  await fs.rm(uploadDir(), { recursive: true, force: true });
  // A fake Muse that records what it was shown and reads photos and admin data back.
  const cfg = loadConfig({ ...process.env, MUSE_PROVIDER: 'meta', MUSE_API_KEY: 'test-key' });
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body); museSeen.push(body);
    const sys = body.messages[0].content;
    const content = sys.includes('administrator') ? JSON.stringify({ summary: 'Two businesses are registered and one is waiting for verification.', checks: ['Review the business waiting for verification.', 'Check the 999 failed payments.'] })
      : JSON.stringify({ productType: 'sofa', maxBudget: 300000, intent: 'shop', language: 'sw' });
    return new Response(JSON.stringify({ model: 'muse-spark-1.3', choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const muse = new MuseClient({ cfg, db, fetchImpl });
  setShoppingDepsForTests({ engine: new ShoppingEngine({ db, muse, geocoder: new FakeGeocoder() }), moran: new FakeMoranInternalClient(), muse });
  server = createApp({ routers }).listen(0); base = `http://127.0.0.1:${server.address().port}`;
  shop = (await makeMerchant({ name: 'Duka la Picha' })).merchant;
  other = (await makeMerchant({ name: 'Duka Jingine', verification: 'unverified' })).merchant;
  const mk = async (m, email) => { const [u] = await db('merchant_users').insert({ merchant_id: m.id, email, name: 'O', password_hash: await hashPassword('password123') }).returning('*'); return signAccessToken({ type: 'merchant', sub: u.id, merchantId: m.id, role: 'owner', email }); };
  tok = await mk(shop, 'a@example.com'); otherTok = await mk(other, 'b@example.com');
  const [root] = await db('admin_users').insert({ email: 'root@moranbuy.test', name: 'Root', password_hash: await hashPassword('x'.repeat(12)), role: 'super_admin' }).returning('*');
  rootTok = signAccessToken({ type: 'admin', sub: root.id, role: 'super_admin', email: root.email });
});
after(async () => { server.close(); await closeDatabase(); });

test('file types are read from the bytes, not the declared type', () => {
  assert.equal(sniff(PNG).mime, 'image/png');
  assert.equal(sniff(JPG).mime, 'image/jpeg');
  assert.equal(sniff(PDF).mime, 'application/pdf');
  assert.equal(sniff(HTML), null);
  assert.equal(sniff(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)])).mime, 'image/webp');
});

test('a product photo is stored under a random name, served publicly, and refused when it is not really an image', async () => {
  const r = await send('/api/merchant/uploads?purpose=product_image&name=sofa.png', { body: PNG, type: 'image/png', token: tok });
  assert.equal(r.status, 201);
  assert.match(r.body.upload.url, /\/media\/[0-9a-f-]{36}\.png$/);
  const key = r.body.upload.url.split('/media/')[1];
  const pub = await send(`/media/${key}`, { method: 'GET' });
  assert.equal(pub.status, 200);
  assert.equal(pub.headers.get('content-type'), 'image/png');
  assert.equal(pub.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(pub.buf.equals(PNG));
  // A script dressed as an image, a PDF as a product photo, an unknown purpose and no login are all refused.
  assert.equal((await send('/api/merchant/uploads?purpose=product_image', { body: HTML, type: 'image/png', token: tok })).status, 415);
  assert.equal((await send('/api/merchant/uploads?purpose=product_image', { body: PDF, type: 'application/pdf', token: tok })).status, 415);
  assert.equal((await send('/api/merchant/uploads?purpose=avatar', { body: PNG, type: 'image/png', token: tok })).status, 400);
  assert.equal((await send('/api/merchant/uploads?purpose=product_image', { body: PNG, type: 'image/png' })).status, 401);
  assert.equal((await send('/media/../../etc/passwd', { method: 'GET' })).status, 404);
});

test('verification documents are private to their business and admins, and only that business may submit them', async () => {
  const doc = await send('/api/merchant/uploads?purpose=verification_document&name=leseni.pdf', { body: PDF, type: 'application/pdf', token: tok });
  assert.equal(doc.status, 201);
  assert.equal(doc.body.upload.url, null);
  const row = await db('uploads').where({ id: doc.body.upload.id }).first();
  assert.equal((await send(`/media/${row.storage_key}`, { method: 'GET' })).status, 404);
  const own = await send(`/api/merchant/uploads/${row.id}/file`, { method: 'GET', token: tok });
  assert.equal(own.status, 200);
  assert.ok(own.buf.equals(PDF));
  assert.equal((await send(`/api/merchant/uploads/${row.id}/file`, { method: 'GET', token: otherTok })).status, 404);
  // Another business cannot submit this document as its own.
  const theft = await json('/api/merchant/verification', { method: 'POST', token: otherTok, body: { documentUploadIds: [row.id] } });
  assert.equal(theft.status, 400);
  assert.equal(theft.body.error, 'BAD_DOCUMENT');
  const ok = await json('/api/merchant/verification', { method: 'POST', token: tok, body: { registrationNumber: 'BRN-1', documentUploadIds: [row.id] } });
  assert.equal(ok.status, 200);
  const m = await db('merchants').where({ id: shop.id }).first();
  assert.equal(m.verification_json.documents[0].uploadId, row.id);
  // While the verification is pending the document cannot be deleted.
  assert.equal((await send(`/api/merchant/uploads/${row.id}`, { method: 'DELETE', token: tok })).status, 409);
  // An admin opens it for review; the view is audited.
  const adm = await json(`/api/admin/uploads/${row.id}`, { token: rootTok });
  assert.equal(adm.status, 200);
  assert.ok(Buffer.from(adm.body.dataBase64, 'base64').equals(PDF));
  assert.ok(await db('audit_events').where({ action: 'upload.viewed', target_id: row.id }).first());
  assert.equal((await json(`/api/admin/merchants/${shop.id}/uploads`, { token: rootTok })).body.uploads.length, 2);
});

test('a WhatsApp customer photo is opened only after the terms are accepted; it stays private and Muse reads it as data', async () => {
  const wa = (from, event) => { const raw = JSON.stringify({ messageId: `wamid.up.${Math.random()}`, from, ...event }); const sig = signBody(process.env.MORAN_SHARED_SECRET, raw); return fetch(`${base}/internal/inbound`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MoranBuy-Timestamp': sig.timestamp, 'X-MoranBuy-Signature': sig.signature }, body: raw }).then(async (r) => ({ status: r.status, body: await r.json() })); };
  const media = { base64: JPG.toString('base64'), mime: 'image/jpeg' };
  const before = Number((await db('uploads').where({ purpose: 'customer_photo' }).count('* as n').first()).n);
  await wa('255712000201', { kind: 'image', text: 'hii', media });
  assert.equal(Number((await db('uploads').where({ purpose: 'customer_photo' }).count('* as n').first()).n), before, 'nothing is stored before the terms are accepted');
  await acceptedCustomer('255712000202');
  museSeen = [];
  const msg = await wa('255712000202', { kind: 'image', text: 'Nataka kama hii, nipo Sinza', media });
  assert.equal(msg.status, 200);
  const sentToMuse = museSeen.find((b) => JSON.stringify(b).includes('image_url'));
  assert.ok(sentToMuse, 'the photo went to Muse');
  assert.match(JSON.stringify(sentToMuse), /data:image\/jpeg;base64,/);
  const up = await db('uploads').where({ purpose: 'customer_photo' }).orderBy('created_at', 'desc').first();
  assert.ok(up, 'the photo is kept');
  assert.equal(publicUpload(up).url, null, 'a customer photo has no public address');
});

test('the retention purge deletes expired customer photos and unused product photos from disk and from the records', async () => {
  const photo = await db('uploads').where({ purpose: 'customer_photo' }).first();
  const unused = await db('uploads').where({ purpose: 'product_image' }).first();
  await db('uploads').whereIn('id', [photo.id, unused.id]).update({ created_at: new Date(Date.now() - 120 * 86400000) });
  const out = await purgeExpired({ dryRun: false });
  assert.equal(out.result.uploads.removed, 1);
  assert.equal(out.result['uploads:unused_product_images'].removed, 1);
  assert.equal(await db('uploads').where({ id: photo.id }).first(), undefined);
  await assert.rejects(fs.access(path.join(uploadDir(), photo.storage_key)));
  await assert.rejects(fs.access(path.join(uploadDir(), unused.storage_key)));
  // Verification documents are never purged by age.
  assert.ok(await db('uploads').where({ purpose: 'verification_document' }).first());
});

test('Muse explains an admin section from its counts, and its words are kept only when every number is in the data', async () => {
  const r = await json('/api/admin/summary', { method: 'POST', token: rootTok, body: { section: 'overview' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.source, 'muse');
  assert.match(r.body.summary, /one is waiting for verification/);
  // The rule check is always there; Muse's check with an invented number is dropped.
  assert.ok(r.body.checks.some((c) => /1 businesses are waiting for verification/.test(c)));
  assert.ok(r.body.checks.includes('Review the business waiting for verification.'));
  assert.ok(!r.body.checks.some((c) => c.includes('999')));
  assert.equal(r.body.data.merchants.active, 2);
  const shown = museSeen.find((b) => b.messages[0].content.includes('administrator'));
  assert.doesNotMatch(JSON.stringify(shown), /2557\d{8}/, 'no phone number goes to Muse');
  assert.ok(await db('muse_requests').where({ feature: 'admin_summary', status: 'ok' }).first());
  assert.equal((await json('/api/admin/summary', { method: 'POST', token: rootTok, body: { section: 'everything' } })).status, 400);
  assert.equal((await json('/api/admin/summary', { method: 'POST', body: { section: 'overview' } })).status, 401);
});

test('without Muse, or when Muse invents numbers, the summary falls back to the rule checks for every section', async () => {
  const off = new MuseClient({ cfg: loadConfig({ ...process.env, MUSE_PROVIDER: 'disabled' }), db });
  for (const section of ['overview', 'campaigns', 'followup', 'orders', 'payments', 'muse', 'demand', 'retention']) {
    const r = await adminSummary({ muse: off, section });
    assert.equal(r.source, 'rules', section);
    assert.ok(typeof r.summary === 'string' && r.summary.length > 10, section);
  }
  const muse = await adminSummary({ muse: off, section: 'muse' });
  assert.ok(muse.checks.some((c) => /Muse Spark is off/.test(c)) || muse.data.provider !== 'disabled');
  const liar = new MuseClient({ cfg: loadConfig({ ...process.env, MUSE_PROVIDER: 'meta', MUSE_API_KEY: 'k' }), db, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: 'There are 4521 businesses.', checks: [] }) } }] }), { status: 200 }) });
  const r = await adminSummary({ muse: liar, section: 'overview' });
  assert.equal(r.source, 'rules_muse_ungrounded');
  assert.doesNotMatch(r.summary, /4521/);
});
