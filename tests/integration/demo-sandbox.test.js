import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, closeDatabase, db } from '../helpers/db.js';
import { cleanDemoData } from '../../services/api/src/routes/demo.js';
import { createApp } from '../../services/api/src/app.js';
import { routers } from '../../services/api/src/routers.js';
import { loadConfig, setConfigForTests } from '@moranbuy/core';

let server; let base;
const post = (path, body) => fetch(`${base}/api/demo${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(async (r) => ({ status: r.status, body: await r.json() }));

before(async () => {
  await resetDatabase();
  setConfigForTests(loadConfig({ ...process.env, DEMO_MODE: 'true', MUSE_PROVIDER: 'disabled', MUSE_API_KEY: '' }));
  server = createApp({ routers }).listen(0); base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { setConfigForTests(null); server.close(); await closeDatabase(); });

test('a judge runs the whole story in the sandbox: terms, request, offers, order, payment held, rider, photo, code, release, receipt', async () => {
  const s = await post('/session');
  assert.equal(s.status, 201);
  const id = s.body.sessionId;
  assert.match(s.body.lines.map((l) => l.msg).join('\n'), /db=moranbuy_demo whatsapp=recording payments=sandbox/);
  let r = await post(`/session/${id}/send`, { role: 'customer', text: 'Habari' });
  assert.ok(r.body.customer.at(-1).buttons.some((b) => b.id === 'terms_accept'));
  r = await post(`/session/${id}/send`, { role: 'customer', buttonId: 'terms_accept', buttonTitle: 'Nakubali' });
  r = await post(`/session/${id}/send`, { role: 'customer', text: 'Nina elfu tisini, nataka blenda, nipo Sinza Mori, niletewe' });
  const terminal = r.body.lines.map((l) => `${l.svc} ${l.msg}`).join('\n');
  assert.match(terminal, /inbound POST \/internal\/inbound 200/);
  assert.match(terminal, /parse source=rules product=blenda budget=90,000/);
  assert.match(terminal, /rank run=\w+ candidates=\d+ within_budget=\d+/);
  assert.match(terminal, /outbound text -> 2557••••\d{3}/);
  r = await post(`/session/${id}/send`, { role: 'customer', text: '1' });
  r = await post(`/session/${id}/send`, { role: 'customer', text: 'ndio' });
  assert.ok(r.body.order, 'order placed');
  const ref = r.body.order.ref;
  assert.match(r.body.owner.at(-1).body, new RegExp(ref));
  r = await post(`/session/${id}/send`, { role: 'owner', text: `KUBALI ${ref} 3000` });
  assert.equal(r.body.order.protection, 'awaiting_payment');
  r = await post(`/session/${id}/pay`);
  assert.equal(r.body.order.protection, 'paid_held');
  assert.match(r.body.lines.map((l) => l.msg).join('\n'), /payment\.completed ref=sbx_\w+ signature=verified/);
  assert.ok(r.body.customer.some((m) => m.type === 'document'));
  const code = r.body.customer.map((m) => m.body || '').join('\n').match(/makabidhiano: ([A-Z0-9]{6})/)[1];
  r = await post(`/session/${id}/send`, { role: 'owner', text: `MSAFIRISHAJI ${ref} ${s.body.riderNumber} Baraka` });
  assert.ok(r.body.rider.at(-1).buttons.some((b) => b.id === `dlv:arrived:${ref}`));
  r = await post(`/session/${id}/send`, { role: 'rider', buttonId: `dlv:arrived:${ref}`, buttonTitle: 'Nimefika' });
  r = await post(`/session/${id}/photo`, { role: 'rider' });
  assert.match(r.body.lines.map((l) => l.msg).join('\n'), /photo actor=deliverer .* fp=[0-9a-f]{8}/);
  r = await post(`/session/${id}/send`, { role: 'rider', text: code });
  assert.equal(r.body.order.protection, 'delivered');
  r = await post(`/session/${id}/send`, { role: 'customer', text: `NIMEPOKEA ${ref}` });
  assert.equal(r.body.order.protection, 'released');
  assert.match(r.body.lines.map((l) => l.msg).join('\n'), /release provider=sandbox .* status=completed/);
  const pdf = await fetch(`${base}/api/demo/session/${id}/receipt`);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  const v = await (await fetch(`${base}/api/demo/session/${id}/verify`)).json();
  assert.equal((await fetch(`${base}${v.path}`)).status, 200);
  // The terminal never shows the handover code itself.
  const all = await (await fetch(`${base}/api/demo/session/${id}/state`)).json();
  assert.ok(!all.lines.some((l) => l.msg.includes(code)));
});

test('old sandbox orders are removed with everything attached to them, and the sample shops stay', async () => {
  const removed = await cleanDemoData({ olderThanHours: -1 });
  assert.ok(removed >= 1);
  assert.equal(Number((await db('orders').count('* as n').first()).n), 0);
  assert.equal(Number((await db('order_protection').count('* as n').first()).n), 0);
  assert.equal(Number((await db('merchants').where('contact_phone', 'like', '25570099%').count('* as n').first()).n), 5);
});

test('outside the sandbox server the demo answers 404', async () => {
  setConfigForTests(loadConfig({ ...process.env, DEMO_MODE: 'false' }));
  assert.equal((await post('/session')).status, 404);
  setConfigForTests(loadConfig({ ...process.env, DEMO_MODE: 'true', MUSE_PROVIDER: 'disabled', MUSE_API_KEY: '' }));
});
