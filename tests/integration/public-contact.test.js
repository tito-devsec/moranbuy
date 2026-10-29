import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../services/api/src/app.js';
import { routers } from '../../services/api/src/routers.js';
import { loadConfig, setConfigForTests } from '@moranbuy/core';
import { closeDatabase } from '../helpers/db.js';

after(async () => { await closeDatabase(); });

test('the legal pages learn the MoranBuy WhatsApp number to open a chat, and fall back to the web chat without one', async (t) => {
  setConfigForTests(loadConfig({ ...process.env, MORANBUY_WHATSAPP_NUMBER: '+255 712 000 999' }));
  const server = createApp({ routers }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { setConfigForTests(null); server.close(); });
  const contact = await (await fetch(`${base}/api/public/contact`)).json();
  assert.deepEqual(contact.whatsapp, { number: '+255712000999', link: 'https://wa.me/255712000999' });
  const html = await (await fetch(`${base}/terms`)).text();
  assert.match(html, /fetch\('\/api\/public\/contact'\)/);
  setConfigForTests(loadConfig({ ...process.env, MORANBUY_WHATSAPP_NUMBER: '' }));
  assert.equal((await (await fetch(`${base}/api/public/contact`)).json()).whatsapp, null);
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
