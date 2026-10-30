import test from 'node:test';
import assert from 'node:assert/strict';
import { rankOffers, chooseVariant, urgencyLevel } from '@moranbuy/budget-matching';
import { fallbackExtract } from '@moranbuy/reverse-marketplace';

const SINZA = { lat: -6.7760, lng: 39.2300 };
const NEAR = { lat: -6.7800, lng: 39.2350 };
const FAR = { lat: -6.8700, lng: 39.2800 };
const now = Date.parse('2026-10-27T12:00:00Z');
const fresh = '2026-10-20T00:00:00Z';
const offer = (over) => ({
  id: over.id, merchantId: over.id, merchantName: over.id, name: over.name || 'Samsung A15', productType: 'smartphone', category: 'phones', price: over.price, currency: 'TZS',
  attributes: over.attributes || {}, variants: over.variants || [], stock: over.stock === undefined ? 3 : over.stock, status: 'active', updatedAt: fresh,
  location: over.location || NEAR, delivery: { available: true, fee: 0, radiusKm: 30 }, pickup: true, merchantVerified: true,
});
const request = (over = {}) => ({ productType: 'smartphone', essentialAttributes: {}, preferredAttributes: {}, maxBudget: 500000, currency: 'TZS', quantity: 1, fulfilment: 'delivery', location: SINZA, ...over });

test('the variant the customer asked for sets the price and stock, and an out-of-stock variant is never picked', () => {
  const o = offer({ id: 'A', price: 380000, variants: [{ name: '64GB Black', price: 380000, stock: 4 }, { name: '128GB Black', price: 450000, stock: 0 }, { name: '128GB Blue', price: 460000, stock: 2 }] });
  const pick = chooseVariant({ request: request({ essentialAttributes: { storage: '128GB' }, preferredAttributes: { color: 'black' } }), offer: o });
  assert.equal(pick.variant.name, '128GB Blue');
  assert.equal(pick.price, 460000);
  const r = rankOffers({ request: request({ essentialAttributes: { storage: '128GB' } }), offers: [o], now });
  assert.equal(r.ranked.length, 1);
  assert.equal(r.ranked[0].offer.variant.name, '128GB Blue');
  assert.equal(r.ranked[0].cost.unitPrice, 460000);
  assert.ok(r.ranked[0].reasons.includes('variant:128GB Blue'));
  // Nothing named: the listing is judged as listed.
  assert.equal(chooseVariant({ request: request(), offer: o }), null);
});

test('a variant can push an offer over budget, where the listed price would have fit', () => {
  const o = offer({ id: 'A', price: 380000, variants: [{ name: '256GB', price: 620000, stock: 1 }] });
  const r = rankOffers({ request: request({ essentialAttributes: { storage: '256GB' } }), offers: [o], now });
  assert.equal(r.ranked.length, 0);
  assert.equal(r.overBudget[0].cost.unitPrice, 620000);
});

test('no alternatives: unconfirmed essentials are excluded and nothing over budget is offered', () => {
  const offers = [
    offer({ id: 'EXACT', price: 400000, attributes: { storage: '128GB' } }),
    offer({ id: 'UNKNOWN', price: 350000 }),
    offer({ id: 'OVER', price: 560000, attributes: { storage: '128GB' } }),
  ];
  const open = rankOffers({ request: request({ essentialAttributes: { storage: '128GB' } }), offers, now });
  assert.deepEqual(open.ranked.map((x) => x.offer.id), ['UNKNOWN', 'EXACT']);
  assert.equal(open.overBudget.length, 1);
  const exact = rankOffers({ request: request({ essentialAttributes: { storage: '128GB' }, alternativesOk: false }), offers, now });
  assert.deepEqual(exact.ranked.map((x) => x.offer.id), ['EXACT']);
  assert.equal(exact.overBudget.length, 0);
  assert.equal(exact.alternativesHidden, 1);
  assert.ok(exact.excluded.some((e) => e.offerId === 'UNKNOWN' && e.reason.startsWith('essential_unconfirmed')));
});

test('urgency puts offers in stock now ahead within the same price band, but never above a cheaper band', () => {
  const offers = [
    offer({ id: 'NEAR_UNKNOWN_STOCK', price: 400000, stock: null, location: NEAR }),
    offer({ id: 'FAR_IN_STOCK', price: 401000, stock: 5, location: FAR }),
    offer({ id: 'CHEAP_FAR_UNKNOWN', price: 300000, stock: null, location: FAR }),
  ];
  const calm = rankOffers({ request: request(), offers, now });
  assert.deepEqual(calm.ranked.map((x) => x.offer.id), ['CHEAP_FAR_UNKNOWN', 'NEAR_UNKNOWN_STOCK', 'FAR_IN_STOCK']);
  const urgent = rankOffers({ request: request({ urgency: 'leo' }), offers, now });
  assert.deepEqual(urgent.ranked.map((x) => x.offer.id), ['CHEAP_FAR_UNKNOWN', 'FAR_IN_STOCK', 'NEAR_UNKNOWN_STOCK']);
  assert.equal(urgent.urgency, 'now');
  assert.ok(urgent.ranked[1].reasons.includes('available_now'));
  assert.ok(urgent.ranked[0].reasons.includes('stock_unconfirmed_for_urgent'));
  assert.equal(urgencyLevel('kesho'), 'soon');
  assert.equal(urgencyLevel('mwezi ujao'), null);
});

test('the plain reader understands no alternatives, alternatives ok and urgency, and keeps them out of the product', () => {
  const a = fallbackExtract('Nataka simu ya laki 5 leo, bila mbadala');
  assert.equal(a.alternativesOk, false);
  assert.equal(a.urgency, 'leo');
  assert.equal(a.productType, 'simu');
  assert.equal(fallbackExtract('mbadala sawa').alternativesOk, true);
  assert.equal(fallbackExtract('mbadala sawa').productType, null);
  assert.equal(fallbackExtract('Nataka sofa').alternativesOk, undefined);
});

test('the plain reader reads sizes and colours, and "simu" or "kochi" match smartphone and sofa listings', async () => {
  const { assessSuitability } = await import('@moranbuy/budget-matching');
  const a = fallbackExtract('Nataka simu ya 128 GB nyeusi');
  assert.deepEqual(a.essentialAttributes, { storage: 128 });
  assert.deepEqual(a.preferredAttributes, { color: 'black' });
  const s = assessSuitability({ request: { productType: 'simu samsung', essentialAttributes: {} }, offer: { productType: 'smartphone', category: 'phones', name: 'Samsung A15', attributes: {} } });
  assert.equal(s.essentialMet, true);
  const k = assessSuitability({ request: { productType: 'kochi', essentialAttributes: {} }, offer: { productType: 'sofa', category: 'furniture', name: 'Sofa ya watu watatu', attributes: {} } });
  assert.equal(k.essentialMet, true);
  const no = assessSuitability({ request: { productType: 'kitanda', essentialAttributes: {} }, offer: { productType: 'sofa', category: 'furniture', name: 'Sofa', attributes: {} } });
  assert.equal(no.essentialMet, false);
});
