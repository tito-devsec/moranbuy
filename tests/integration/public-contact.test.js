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
