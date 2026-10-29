import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../services/api/src/app.js';
import { routers } from '../../services/api/src/routers.js';
import { loadConfig, setConfigForTests } from '@moranbuy/core';
import { closeDatabase } from '../helpers/db.js';

after(async () => { await closeDatabase(); });

test('MoranBuy is reached by its WhatsApp username, old web chat links open WhatsApp, and the web chat is gone', async (t) => {
  setConfigForTests(loadConfig({ ...process.env, MORANBUY_WHATSAPP_USERNAME: '' }));
  const server = createApp({ routers }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { setConfigForTests(null); server.close(); });
  assert.deepEqual((await (await fetch(`${base}/api/public/contact`)).json()).whatsapp, { username: '@moranbuy', link: 'https://wa.me/moranbuy' });
  setConfigForTests(loadConfig({ ...process.env, MORANBUY_WHATSAPP_USERNAME: '@MoranBuy.tz' }));
  assert.deepEqual((await (await fetch(`${base}/api/public/contact`)).json()).whatsapp, { username: '@MoranBuy.tz', link: 'https://wa.me/MoranBuy.tz' });
  for (const old of ['/customer', '/customer/', '/customer/index.html']) {
    const r = await fetch(`${base}${old}`, { redirect: 'manual' });
    assert.equal(r.status, 302, old);
    assert.equal(r.headers.get('location'), 'https://wa.me/MoranBuy.tz');
  }
  assert.equal((await fetch(`${base}/api/shop/messages`, { method: 'POST' })).status, 404);
  const html = await (await fetch(`${base}/terms`)).text();
  assert.match(html, /fetch\('\/api\/public\/contact'\)/);
  assert.doesNotMatch(html, /\/customer\//);
  assert.throws(() => loadConfig({ ...process.env, MORANBUY_WHATSAPP_USERNAME: '2557 not a name!' }));
});

test('the public website serves its pages without any sign-in, and its numbers are real totals or left out', async (t) => {
  const server = createApp({ routers }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());
  for (const [path, text] of [['/', 'Tell it once.'], ['/how-it-works', 'Budget first, location second'], ['/for-business', 'Sell to people who are already asking']]) {
    const r = await fetch(`${base}${path}`);
    assert.equal(r.status, 200, path);
    assert.match(await r.text(), new RegExp(text));
  }
  assert.equal((await fetch(`${base}/site/site.css`)).status, 200);
  const stats = await (await fetch(`${base}/api/public/stats`)).json();
  assert.deepEqual(Object.keys(stats).sort(), ['products', 'requests', 'shops', 'withinBudgetPct']);
  for (const v of Object.values(stats)) assert.ok(v === null || (Number.isInteger(v) && v > 0));
});
