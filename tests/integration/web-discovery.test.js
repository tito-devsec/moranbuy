import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, closeDatabase, db } from '../helpers/db.js';
import { acceptedCustomer } from '../helpers/fixtures.js';
import { createApp } from '../../services/api/src/app.js';
import { routers } from '../../services/api/src/routers.js';
import { setShoppingDepsForTests } from '../../services/api/src/services/shopping.js';
import { DiscoveryResearcher, NearbyShops, findIndexed, warmUpIndex } from '../../services/api/src/services/discovery.js';
import { ShoppingEngine } from '@moranbuy/reverse-marketplace';
import { MuseClient } from '@moranbuy/muse-intelligence';
import { FakeGeocoder, FakeMoranInternalClient, signBody, resetRobotsCacheForTests } from '@moranbuy/integrations';
import { loadConfig } from '@moranbuy/core';

// Meta's web search, the shops' own pages and Google Places, all answered by a fake network so the whole path runs offline.
const calls = { responses: 0, places: 0, pages: [] };
const html = (title, img, desc, price) => `<html><head><title>${title}</title><meta property="og:image" content="${img}"><meta property="og:description" content="${desc}"><script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: title, offers: { price, priceCurrency: 'TZS' } })}</script></head><body></body></html>`;
async function fakeFetch(url, init = {}) {
  const u = String(url);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (u.endsWith('/responses')) {
    calls.responses += 1;
    const body = JSON.parse(init.body);
    assert.equal(body.tools[0].type, 'web_search');
    assert.equal(body.tools[0].user_location.country, 'TZ');
    return json({
      model: 'muse-spark-1.3',
      usage: { input_tokens: 900, output_tokens: 400 },
      output: [
        { type: 'web_search_call', status: 'completed', results: [{ title: 'HP 250 G8', url: 'https://kariakoo-tech.co.tz/hp-250-g8', snippet: '' }, { title: 'HP ProBook', url: 'https://www.facebook.com/dsmlaptops/posts/1', snippet: '' }] },
        { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ results: [
          { name: 'HP 250 G8 Core i5 8GB RAM 256GB SSD', price: 340000, currency: 'TZS', url: 'https://kariakoo-tech.co.tz/hp-250-g8', shopName: 'Kariakoo Tech', area: 'Kariakoo, Dar es Salaam', condition: 'new', description: null, attributes: { ram: 8, storage: 256, brand: 'hp' }, imageUrl: null },
          { name: 'HP ProBook 440 G5 8GB 256GB SSD (used)', price: 320000, currency: 'TZS', url: 'https://www.facebook.com/dsmlaptops/posts/1', shopName: 'DSM Laptops', area: 'Mbagala', condition: 'used', description: 'Ex-UK, battery good', attributes: { ram: 8, storage: 256, brand: 'hp' }, imageUrl: null },
          { name: 'HP invented listing', price: 100000, currency: 'TZS', url: 'https://made-up-shop.example/hp', shopName: 'Nowhere' },
        ] }), annotations: [] }] },
      ],
    });
  }
  if (u.endsWith('/robots.txt')) return new Response('User-agent: *\nDisallow: /private', { status: 200 });
  if (u === 'https://kariakoo-tech.co.tz/hp-250-g8') { calls.pages.push(u); return new Response(html('HP 250 G8', 'https://kariakoo-tech.co.tz/img/hp250.jpg', 'HP 250 G8, Core i5 11th gen, 8GB RAM, 256GB SSD, 15.6 inch.', 340000), { status: 200, headers: { 'content-type': 'text/html' } }); }
  if (u === 'https://www.facebook.com/dsmlaptops/posts/1') { calls.pages.push(u); return new Response('<html><head><meta property="og:image" content="https://scontent.example/probook.jpg"></head></html>', { status: 200, headers: { 'content-type': 'text/html' } }); }
  if (/\.(jpg|jpeg|png)$/.test(u)) return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 206, headers: { 'content-type': 'image/jpeg' } });
  if (u.startsWith('https://places.googleapis.com/v1/places:searchText')) {
    calls.places += 1;
    assert.equal(init.headers['X-Goog-Api-Key'], 'places-test-key');
    return json({ places: [{ id: 'p1', displayName: { text: 'Mbagala Computer Centre' }, formattedAddress: 'Kilwa Rd, Mbagala', location: { latitude: -6.902, longitude: 39.272 }, rating: 4.4, userRatingCount: 37, nationalPhoneNumber: '0712 000 111', currentOpeningHours: { openNow: true }, googleMapsUri: 'https://maps.google.com/?cid=1', photos: [{ name: 'places/p1/photos/a' }], businessStatus: 'OPERATIONAL' }] });
  }
  if (u.startsWith('https://places.googleapis.com/v1/places/p1/photos/a/media')) return json({ photoUri: 'https://lh3.googleusercontent.com/p/abc' });
  return new Response('not found', { status: 404 });
}

let server; let base; let moran; let seq = 0;
const settings = { mode: 'meta_web', dailySearchLimit: 2, placesDailyLimit: 5, blockedDomains: [], preferredDomains: [], warmup: true, placesApiKey: 'places-test-key', placesEnabled: true };
const send = async (event) => {
  const raw = JSON.stringify({ messageId: `wamid.wd.${seq += 1}`, ...event });
  const { timestamp, signature } = signBody(process.env.MORAN_SHARED_SECRET, raw);
  return fetch(`${base}/internal/inbound`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MoranBuy-Timestamp': timestamp, 'X-MoranBuy-Signature': signature }, body: raw }).then(async (r) => ({ status: r.status, body: await r.json() }));
};
const sentTo = (to) => moran.sent.filter((m) => m.to === to);

before(async () => {
  await resetDatabase();
  resetRobotsCacheForTests();
  moran = new FakeMoranInternalClient();
  const researcher = new DiscoveryResearcher({ fetchImpl: fakeFetch, resolve: async () => settings, museConfig: async () => ({ apiKey: 'muse-test-key', baseUrl: 'https://api.meta.ai/v1', model: 'muse-spark-1.3' }) });
  const nearby = new NearbyShops({ fetchImpl: fakeFetch, resolve: async () => settings });
  const engine = new ShoppingEngine({ db, muse: new MuseClient({ cfg: loadConfig({ ...process.env, MUSE_PROVIDER: 'disabled' }), db }), geocoder: new FakeGeocoder({ mbagala: { lat: -6.9006, lng: 39.2707, label: 'Mbagala, Dar es Salaam' } }), researcher, nearby });
  setShoppingDepsForTests({ engine, moran, muse: null, geocoder: null });
  server = createApp({ routers }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await closeDatabase(); });

test('with no MoranBuy shops, online finds arrive as photos with price, shop, area, description and link, plus shops near the customer', async () => {
  const phone = '255712400001'; await acceptedCustomer(phone);
  await send({ from: phone, text: 'Me nahitaji laptop Nina laki 350000, iwe na Rami kuanzia 8 and storage SSD kuanzia 128 kampuni iwe hp' });
  const r = await send({ from: phone, text: 'mbagala dar' });
  assert.equal(r.body.state, 'presented');
  assert.equal(calls.responses, 1);
  const out = sentTo(phone).slice(-4);
  const photos = out.filter((m) => m.type === 'image');
  assert.equal(photos.length, 2, 'two online finds with a photo');
  assert.equal(photos[0].imageUrl, 'https://scontent.example/probook.jpg', 'the cheaper one first');
  assert.match(photos[1].caption, /HP 250 G8/);
  assert.match(photos[1].caption, /TSh 340,000 - Kariakoo Tech, Kariakoo, Dar es Salaam/);
  assert.match(photos[1].caption, /Core i5 11th gen, 8GB RAM, 256GB SSD/, 'description read from the shop page');
  assert.match(photos[1].caption, /https:\/\/kariakoo-tech\.co\.tz\/hp-250-g8/);
  assert.match(photos[1].caption, /imepatikana mtandaoni, haijathibitishwa/);
  const text = out.find((m) => m.type === 'text' && /HP 250 G8/.test(m.body)).body;
  assert.match(text, /https:\/\/kariakoo-tech\.co\.tz\/hp-250-g8/);
  assert.doesNotMatch(text, /invented|made-up-shop/, 'a link the search never returned is dropped');
  const near = out.at(-1).body;
  assert.match(near, /Maduka karibu nawe yanayouza laptop/);
  assert.match(near, /Mbagala Computer Centre.*4\.4★ \(37\).*wazi sasa.*0712 000 111/s);
  assert.equal(await db('web_products').count('* as n').first().then((x) => Number(x.n)), 2);
});

test('the next customer asking for the same thing is answered from the index, without a new search; the daily limit holds', async () => {
  const phone = '255712400002'; await acceptedCustomer(phone);
  await send({ from: phone, text: 'nataka laptop hp laki 350000, nipo Mbagala' });
  assert.equal(calls.responses, 1, 'no new web search');
  assert.match(sentTo(phone).map((m) => m.body || m.caption).join('\n'), /HP 250 G8/);
  assert.equal(calls.places, 1, 'nearby shops came from the cache');
  const found = await findIndexed({ productType: 'laptop', maxBudget: 350000, essentialAttributes: { brand: 'hp' } });
  assert.equal(found.length, 2);
  // A product with nothing indexed searches live until the day's limit (2) is used, then stops.
  const researcher = new DiscoveryResearcher({ fetchImpl: fakeFetch, resolve: async () => settings, museConfig: async () => ({ apiKey: 'k', baseUrl: 'https://api.meta.ai/v1', model: 'muse-spark-1.3' }) });
  const second = await researcher.research({ productType: 'fridge', essentialAttributes: {}, maxBudget: 900000 });
  assert.equal(second.status, 'ok');
  const third = await researcher.research({ productType: 'television', essentialAttributes: {}, maxBudget: 900000 });
  assert.equal(third.status, 'daily_limit');
  assert.equal(calls.responses, 2);
  assert.equal((await warmUpIndex({ researcher })).searched, 0, 'the warm-up respects the limit too');
});
