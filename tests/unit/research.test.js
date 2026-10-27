import test from 'node:test';
import assert from 'node:assert/strict';
import '../helpers/env.js';
import { sanitizeResearchResults, researchResultsToOffers, HermesResearchClient, PlainFetchResearcher } from '@moranbuy/integrations';
import { rankOffers } from '@moranbuy/budget-matching';
import { loadConfig } from '@moranbuy/core';

const cfg = loadConfig({ ...process.env, MORANBUY_WEB_RESEARCH_ENABLED: 'true', MORANBUY_ALLOWED_DOMAINS: 'shop.example.co.tz', HERMES_BASE_URL: 'http://hermes:8642', HERMES_API_KEY: 'k' });

test('research results off the allow-list, without a URL or with a non-numeric price are dropped', () => {
  const clean = sanitizeResearchResults({ results: [
    { name: 'Sofa', price: 290000, currency: 'TZS', sourceUrl: 'https://shop.example.co.tz/p/1' },
    { name: 'Sofa', price: 'cheap', sourceUrl: 'https://shop.example.co.tz/p/2' },
    { name: 'Sofa', price: 100, sourceUrl: 'https://other.example.com/p/3' },
    { name: 'Sofa', price: null, sourceUrl: 'https://shop.example.co.tz/p/4' },
  ] }, ['shop.example.co.tz']);
  assert.deepEqual(clean.map((r) => r.sourceUrl), ['https://shop.example.co.tz/p/1', 'https://shop.example.co.tz/p/4']);
});

test('web offers are unverified, unorderable, and never rank above a verified in-budget offer', () => {
  const web = researchResultsToOffers(sanitizeResearchResults({ results: [{ name: 'Sofa 3 seater', price: 200000, currency: 'TZS', sourceUrl: 'https://shop.example.co.tz/p/1', attributes: { seats: 3 } }] }, ['shop.example.co.tz']));
  assert.equal(web[0].unverified, true);
  assert.equal(web[0].source, 'web');
  const verified = { id: 'v', merchantId: 'm', merchantName: 'Duka', name: 'Sofa 3', productType: 'sofa', attributes: { seats: 3 }, price: 300000, currency: 'TZS', status: 'active', stock: 2, delivery: { available: true, fee: 0 }, merchantVerified: true, updatedAt: new Date().toISOString(), location: null };
  const r = rankOffers({ request: { productType: 'sofa', essentialAttributes: { seats: 3 }, maxBudget: 350000, currency: 'TZS', quantity: 1, fulfilment: 'any' }, offers: [...web, verified] });
  assert.equal(r.ranked[0].offer.id, 'v');
  assert.ok(r.ranked[1].reasons.includes('found_online_unverified'));
});

test('the Hermes client sends the skill input, parses its JSON, records telemetry and survives a bad answer', async () => {
  const calls = [];
  let seen;
  const good = new HermesResearchClient({ cfg, recorder: async (r) => calls.push(r), fetchImpl: async (url, init) => { seen = { url, body: JSON.parse(init.body) }; return new Response(JSON.stringify({ choices: [{ message: { content: '```json\n{"results":[{"name":"Sofa","price":250000,"currency":"TZS","sourceUrl":"https://shop.example.co.tz/p/9"}],"notes":["one page blocked"]}\n```' } }] }), { status: 200 }); } });
  const r = await good.research({ productType: 'sofa', essentialAttributes: { seats: 3 }, maxBudget: 350000, currency: 'TZS' });
  assert.equal(r.ok, true);
  assert.equal(r.results[0].price, 250000);
  assert.deepEqual(r.notes, ['one page blocked']);
  assert.equal(seen.url, 'http://hermes:8642/v1/chat/completions');
  assert.deepEqual(JSON.parse(seen.body.messages[1].content).allowedDomains, ['shop.example.co.tz']);
  assert.equal(calls[0].status, 'ok');
  const bad = new HermesResearchClient({ cfg, recorder: async (r) => calls.push(r), fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'no json here' } }] }), { status: 200 }) });
  assert.equal((await bad.research({ productType: 'sofa' })).ok, false);
  assert.equal(calls[1].errorCode, 'BAD_JSON');
  const off = new HermesResearchClient({ cfg: loadConfig({ ...process.env, MORANBUY_WEB_RESEARCH_ENABLED: 'false' }) });
  assert.equal((await off.research({ productType: 'sofa' })).status, 'disabled');
});

test('the plain fetch researcher obeys robots.txt and reads only JSON-LD product data from allowed sites', async () => {
  const pages = {
    'https://shop.example.co.tz/robots.txt': 'User-agent: *\nDisallow: /private',
    'https://shop.example.co.tz/search?q=sofa': '<html><script type="application/ld+json">{"@type":"Product","name":"Sofa ya watu 3","url":"https://shop.example.co.tz/p/1","offers":{"price":"310000","priceCurrency":"TZS","availability":"https://schema.org/InStock"}}</script></html>',
  };
  const r = new PlainFetchResearcher({ cfg: loadConfig({ ...process.env, MORANBUY_WEB_RESEARCH_ENABLED: 'true', MORANBUY_ALLOWED_DOMAINS: 'shop.example.co.tz' }), fetchImpl: async (url) => new Response(pages[url] || '', { status: pages[url] ? 200 : 404 }) });
  const out = await r.research({ productType: 'sofa' });
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].price, 310000);
  assert.equal(out.results[0].availability, 'in stock');
  const blocked = new PlainFetchResearcher({ cfg: loadConfig({ ...process.env, MORANBUY_WEB_RESEARCH_ENABLED: 'true', MORANBUY_ALLOWED_DOMAINS: 'shop.example.co.tz' }), searchPaths: { 'shop.example.co.tz': '/private/search?q={q}' }, fetchImpl: async (url) => new Response(pages[url] || '', { status: pages[url] ? 200 : 404 }) });
  assert.equal((await blocked.research({ productType: 'sofa' })).results.length, 0);
});
