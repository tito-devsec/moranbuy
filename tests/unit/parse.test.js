import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBudget, parseFulfilment, parseLanguage, fallbackExtract, mergeRequest, clarificationQuestion, renderReply, buildFacts } from '@moranbuy/reverse-marketplace';
import { numbersAreGrounded } from '@moranbuy/muse-intelligence';
import { rankOffers } from '@moranbuy/budget-matching';

test('parseBudget reads shilling amounts in the forms customers write', () => {
  assert.equal(parseBudget('Nina TSh 350,000 ya sofa'), 350000);
  assert.equal(parseBudget('bajeti 350k'), 350000);
  assert.equal(parseBudget('laki tatu na nusu si zaidi ya laki 4'), 400000);
  assert.equal(parseBudget('I have 1.2m for a laptop'), 1200000);
  assert.equal(parseBudget('sofa ya watu watatu'), null);
});

test('parseFulfilment and parseLanguage read delivery wishes and language', () => {
  assert.equal(parseFulfilment('Nataka delivery ikiwezekana'), 'delivery');
  assert.equal(parseFulfilment('nitachukua mwenyewe'), 'pickup');
  assert.equal(parseLanguage('Nina TSh 350,000 ya sofa ya watu watatu. Nipo Sinza'), 'sw');
  assert.equal(parseLanguage('I want a sofa for 350k, I am in Sinza'), 'en');
});

test('the fallback extraction never invents a budget or a location', () => {
  const e = fallbackExtract('Nataka sofa ya watu watatu');
  assert.equal(e.maxBudget, null);
  assert.equal(e.locationText, null);
  assert.match(e.productType, /sofa/);
});

test('mergeRequest keeps what was already known and clarification asks only for what is missing', () => {
  const r1 = mergeRequest(null, { productType: 'sofa', essentialAttributes: { seats: 3 } });
  assert.equal(clarificationQuestion(r1).field, 'maxBudget');
  const r2 = mergeRequest(r1, { maxBudget: 350000 });
  assert.equal(r2.essentialAttributes.seats, 3);
  assert.equal(clarificationQuestion(r2).field, 'location');
  const r3 = mergeRequest(r2, { locationText: 'Sinza, Dar es Salaam' });
  assert.equal(clarificationQuestion(r3), null);
});

test('the deterministic reply states totals, unconfirmed delivery and over-budget amounts from the facts only', () => {
  const request = { productType: 'sofa', essentialAttributes: {}, maxBudget: 350000, currency: 'TZS', quantity: 1, fulfilment: 'delivery', location: null, language: 'sw' };
  const offers = [
    { id: 'a', merchantId: 'm1', merchantName: 'Duka A', name: 'Sofa 3', productType: 'sofa', price: 300000, currency: 'TZS', attributes: {}, status: 'active', delivery: { available: true, fee: null }, updatedAt: new Date().toISOString() },
    { id: 'b', merchantId: 'm2', merchantName: 'Duka B', name: 'Sofa 3 Deluxe', productType: 'sofa', price: 380000, currency: 'TZS', attributes: {}, status: 'active', delivery: { available: true, fee: 10000 }, updatedAt: new Date().toISOString() },
  ];
  const facts = buildFacts(rankOffers({ request, offers }), request);
  const text = renderReply(facts, 'sw');
  assert.match(text, /1\. Sofa 3 - Duka A/);
  assert.match(text, /delivery haijathibitishwa/);
  assert.match(text, /inazidi bajeti kwa TSh 40,000/);
  assert.equal(numbersAreGrounded(text, facts), true);
  assert.equal(numbersAreGrounded('Sofa 3 kwa TSh 250,000 tu!', facts), false);
});

test('amounts said in words stay out of the product name, and "niletewe" means delivery', async () => {
  const { parseProductGuess, parseFulfilment } = await import('../../packages/reverse-marketplace/src/parse.js');
  assert.equal(parseProductGuess('Nina elfu tisini, nataka blenda, nipo Sinza Mori, niletewe'), 'blenda');
  assert.equal(parseProductGuess('nataka sofa laki tatu na elfu hamsini'), 'sofa');
  assert.equal(parseFulfilment('nipo Sinza, niletewe nyumbani'), 'delivery');
});

test('every word for a product is known, so a Swahili request finds English listings', async () => {
  const { productWords, normalizeProductType } = await import('../../packages/budget-matching/src/vocabulary.js');
  assert.equal(normalizeProductType('blenda').productType, 'blender');
  assert.ok(productWords('blender').includes('blender') && productWords('blender').includes('blenda'));
  assert.deepEqual(productWords('unknown'), []);
});
