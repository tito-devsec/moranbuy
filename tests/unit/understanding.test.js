import test from 'node:test';
import assert from 'node:assert/strict';
import { parseShillings } from '@moranbuy/core';
import { fallbackExtract, placeFromAnswer, parseAlternatives } from '../../packages/reverse-marketplace/src/parse.js';
import { attributeMatches } from '../../packages/budget-matching/src/suitability.js';
import { firstJsonObject } from '../../packages/muse-intelligence/src/client.js';

test('budgets in every form customers use, and "laki 350000" is 350,000 not 35 billion', () => {
  const cases = { 'Nina laki 350000': 350000, 'laki tatu na nusu': 350000, '350k': 350000, 'laki 3.5': 350000, 'milioni 1.5': 1500000, 'elfu tisini': 90000, 'elfu 90000': 90000, 'nina 350,000': 350000, 'TSh 1,200,000': 1200000, 'laki mbili na elfu hamsini': 250000 };
  for (const [text, want] of Object.entries(cases)) assert.equal(parseShillings(text), want, text);
});

test('the HP laptop request reads product, budget, RAM and SSD minimums and the brand', () => {
  const r = fallbackExtract('Me nahitaji laptop Nina laki 350000, iwe na Rami kuanzia 8 and storage SSD kuanzia 128 kampuni iwe hp');
  assert.equal(r.productType, 'laptop');
  assert.equal(r.maxBudget, 350000);
  assert.deepEqual(r.essentialAttributes, { ram: { min: 8 }, storage: { min: 128 }, brand: 'hp' });
  assert.deepEqual(fallbackExtract('laptop 8gb ram 256gb ssd').essentialAttributes, { ram: 8, storage: 256 });
  assert.equal(fallbackExtract('Nataka simu Samsung A15').productType, 'simu');
  assert.equal(fallbackExtract('Nataka simu Samsung A15').essentialAttributes.brand, 'samsung');
});

test('listings are judged on sizes and brands written in their names', () => {
  const offer = { name: 'HP 250 G8 Core i5, 8GB RAM, 256GB SSD', attributes: {} };
  assert.equal(attributeMatches('ram', { min: 8 }, {}, offer), true);
  assert.equal(attributeMatches('storage', { min: 128 }, {}, offer), true);
  assert.equal(attributeMatches('brand', 'hp', {}, offer), true);
  assert.equal(attributeMatches('brand', 'dell', {}, offer), false);
  assert.equal(attributeMatches('ram', { min: 16 }, { ram: '8GB' }), false);
  assert.equal(attributeMatches('storage', { min: 512 }, { storage: '1TB' }), true);
  assert.equal(attributeMatches('storage', 1024, { storage: '1 TB' }), true);
});

test('an answer to "Upo wapi?" is a place, and "mbadala ni upi?" asks for alternatives', () => {
  assert.equal(placeFromAnswer('mbagala dar'), 'mbagala Dar es Salaam');
  assert.equal(placeFromAnswer('Nipo Sinza'), 'Sinza');
  assert.equal(placeFromAnswer('sijui'), null);
  assert.equal(parseAlternatives('Mmbadala ni upi?').wantsAlternatives, true);
  assert.equal(parseAlternatives('nionyeshe mbadala').alternativesOk, true);
});

test('a JSON object is recovered from a reply with words around it', () => {
  assert.deepEqual(firstJsonObject('Here you go: {"a": {"b": "}"}, "c": 1} thanks'), { a: { b: '}' }, c: 1 });
  assert.equal(firstJsonObject('no json here'), null);
});

test('a model name alone names the product, and "hp elitebook g7" as a brand is split into brand and model', async () => {
  const { parseProductGuess, tidyAttributes } = await import('../../packages/reverse-marketplace/src/parse.js');
  assert.equal(parseProductGuess('nahitaji hp elitebook g7 budget yangu ni million moja'), 'laptop');
  assert.equal(parseProductGuess('nataka galaxy a15 laki 4'), 'smartphone');
  const tidy = tidyAttributes({ essentialAttributes: { brand: 'HP EliteBook G7' }, preferredAttributes: {} });
  assert.deepEqual(tidy.essentialAttributes, { brand: 'hp' });
  assert.deepEqual(tidy.preferredAttributes, { model: 'EliteBook G7' });
});

test('a shared map pin is named by reverse geocoding, with its country', async () => {
  const { Geocoder } = await import('../../packages/integrations/src/geocoder.js');
  const seen = [];
  const g = new Geocoder({ cfg: { GEOCODER_BASE_URL: 'https://nominatim.example', GEOCODER_CONTACT_EMAIL: 'test@example.com', DEFAULT_COUNTRY: 'TZ' }, fetchImpl: async (url) => { seen.push(url); return new Response(JSON.stringify({ display_name: 'Mbagala, Temeke, Dar es Salaam, Tanzania', address: { city: 'Dar es Salaam', country_code: 'tz' } }), { status: 200 }); } });
  const r = await g.reverse(-6.9006, 39.2707);
  assert.match(seen[0], /\/reverse\?format=jsonv2.*lat=-6\.9006.*lon=39\.2707/);
  assert.deepEqual(r, { label: 'Mbagala, Temeke, Dar es Salaam, Tanzania', city: 'Dar es Salaam', country: 'TZ' });
  assert.equal(await g.reverse('x', 1), null);
});
