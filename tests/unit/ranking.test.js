import test from 'node:test';
import assert from 'node:assert/strict';
import { rankOffers } from '@moranbuy/budget-matching';

const SINZA = { lat: -6.7760, lng: 39.2300 };
const NEAR = { lat: -6.7800, lng: 39.2350 };   // about 0.7 km from Sinza
const FAR = { lat: -6.8700, lng: 39.2800 };    // about 12 km from Sinza
const now = Date.parse('2026-10-27T12:00:00Z');
const fresh = '2026-10-20T00:00:00Z';

const sofa = (over) => ({
  id: over.id, merchantId: over.merchantId || over.id, merchantName: over.merchantName || over.id,
  name: 'Sofa ya watu watatu', productType: 'sofa', category: 'furniture', price: over.price, currency: 'TZS',
  attributes: { seats: 3, ...(over.attributes || {}) }, stock: over.stock ?? 2, status: 'active', updatedAt: over.updatedAt || fresh,
  location: over.location || NEAR, delivery: over.delivery || { available: true, fee: 0, radiusKm: 30 }, pickup: true,
  merchantVerified: over.merchantVerified ?? true, priceVerified: over.priceVerified ?? false, sourceKey: over.sourceKey, deletedAt: over.deletedAt || null,
});
const request = (over = {}) => ({ productType: 'sofa', essentialAttributes: { seats: 3 }, maxBudget: 350000, currency: 'TZS', quantity: 1, fulfilment: 'delivery', location: SINZA, ...over });

test('Case A: a cheaper suitable offer beats a nearer one, and the over-budget one is set apart', () => {
  const r = rankOffers({ request: request(), now, offers: [
    sofa({ id: 'A', price: 290000, location: FAR }),
    sofa({ id: 'B', price: 340000, location: NEAR }),
    sofa({ id: 'C', price: 360000, location: NEAR }),
  ] });
  assert.deepEqual(r.ranked.map((x) => x.offer.id), ['A', 'B']);
  assert.deepEqual(r.overBudget.map((x) => x.offer.id), ['C']);
  assert.equal(r.overBudget[0].budget.shortfall, 10000);
  assert.ok(r.ranked[0].reasons.includes('lowest_known_total_among_suitable'));
});

test('Case B: a known delivery charge changes the order through total customer cost', () => {
  const r = rankOffers({ request: request(), now, offers: [
    sofa({ id: 'A', price: 290000, location: FAR, delivery: { available: true, fee: 60000, radiusKm: 30 } }),
    sofa({ id: 'B', price: 320000, location: NEAR, delivery: { available: true, fee: 10000, radiusKm: 30 } }),
  ] });
  assert.deepEqual(r.ranked.map((x) => x.offer.id), ['B', 'A']);
  assert.equal(r.ranked[0].cost.knownTotal, 330000);
  assert.equal(r.ranked[1].cost.knownTotal, 350000);
  assert.equal(r.ranked[0].cost.deliveryFee, 10000);
});

test('Case C: an unknown delivery cost is disclosed and never treated as zero or guaranteed', () => {
  const r = rankOffers({ request: request(), now, offers: [sofa({ id: 'A', price: 300000, delivery: { available: true, fee: null } })] });
  const a = r.ranked[0];
  assert.equal(a.cost.totalConfirmed, false);
  assert.deepEqual(a.cost.unknownParts, ['delivery']);
  assert.equal(a.cost.deliveryFee, null);
  assert.equal(a.budget.status, 'unconfirmed');
  assert.ok(a.reasons.includes('unknown_cost:delivery'));
});

test('Case D: a cheap product that fails an essential requirement is excluded, not ranked first', () => {
  const r = rankOffers({ request: request(), now, offers: [
    sofa({ id: 'cheap-2-seater', price: 150000, attributes: { seats: 2 } }),
    sofa({ id: 'proper', price: 300000 }),
  ] });
  assert.deepEqual(r.ranked.map((x) => x.offer.id), ['proper']);
  assert.equal(r.excluded[0].reason, 'unsuitable:seats');
});

test('Case E: nothing within budget is reported plainly with the nearest alternatives and no invented discount', () => {
  const r = rankOffers({ request: request(), now, offers: [sofa({ id: 'X', price: 380000 }), sofa({ id: 'Y', price: 420000 })] });
  assert.equal(r.noneWithinBudget, true);
  assert.equal(r.ranked.length, 0);
  assert.deepEqual(r.overBudget.map((x) => x.offer.id), ['X', 'Y']);
  assert.equal(r.cheapestOverBudget.shortfall, 30000);
  assert.equal(r.overBudget[0].cost.knownTotal, 380000);
});

test('Case F: with similar prices and suitability the more convenient location ranks higher', () => {
  const r = rankOffers({ request: request(), now, offers: [
    sofa({ id: 'far', price: 300000, location: FAR }),
    sofa({ id: 'near', price: 301000, location: NEAR }),
  ] });
  assert.deepEqual(r.ranked.map((x) => x.offer.id), ['near', 'far']);
  assert.ok(r.ranked[0].location.distanceKm < r.ranked[1].location.distanceKm);
});

test('Case F counter-check: location never defeats a substantially cheaper suitable offer', () => {
  const r = rankOffers({ request: request(), now, offers: [
    sofa({ id: 'far-cheap', price: 280000, location: FAR }),
    sofa({ id: 'near-dear', price: 340000, location: NEAR }),
  ] });
  assert.deepEqual(r.ranked.map((x) => x.offer.id), ['far-cheap', 'near-dear']);
});

test('Case G: deleted, suspended, out-of-stock and duplicate listings are handled by rule', () => {
  const r = rankOffers({ request: request(), now, offers: [
    sofa({ id: 'ok', price: 300000, sourceKey: 'moran:t1:p1', updatedAt: '2026-10-01T00:00:00Z' }),
    sofa({ id: 'ok-newer', price: 300000, sourceKey: 'moran:t1:p1', updatedAt: fresh }),
    sofa({ id: 'gone', price: 250000, deletedAt: '2026-10-01T00:00:00Z' }),
    { ...sofa({ id: 'suspended', price: 250000 }), merchantStatus: 'suspended' },
    sofa({ id: 'empty', price: 250000, stock: 0 }),
    sofa({ id: 'old', price: 300000, updatedAt: '2026-01-01T00:00:00Z' }),
  ] });
  assert.equal(r.duplicatesRemoved, 1);
  assert.deepEqual(r.ranked.map((x) => x.offer.id), ['ok-newer', 'old']);
  assert.ok(r.ranked[1].trust.stale);
  assert.deepEqual(r.excluded.map((x) => x.reason).sort(), ['deleted', 'merchant_suspended', 'out_of_stock']);
});

test('Trust: a price far below the market without verification is pushed down and flagged, not recommended as confirmed', () => {
  const r = rankOffers({ request: request(), now, offers: [
    sofa({ id: 'too-good', price: 40000, merchantVerified: false }),
    sofa({ id: 'a', price: 300000 }), sofa({ id: 'b', price: 310000 }), sofa({ id: 'c', price: 320000 }),
  ] });
  assert.equal(r.ranked.at(-1).offer.id, 'too-good');
  assert.ok(r.ranked.at(-1).reasons.includes('price_needs_confirmation'));
});

test('Pickup preference ignores delivery fees and does not add them to the total', () => {
  const r = rankOffers({ request: request({ fulfilment: 'pickup' }), now, offers: [sofa({ id: 'A', price: 300000, delivery: { available: true, fee: 50000 } })] });
  assert.equal(r.ranked[0].cost.knownTotal, 300000);
  assert.equal(r.ranked[0].cost.deliveryApplies, false);
});

test('Quantity multiplies the price and insufficient stock excludes the offer', () => {
  const r = rankOffers({ request: request({ quantity: 2, maxBudget: 700000 }), now, offers: [sofa({ id: 'A', price: 300000, stock: 2 }), sofa({ id: 'B', price: 250000, stock: 1 })] });
  assert.deepEqual(r.ranked.map((x) => x.offer.id), ['A']);
  assert.equal(r.ranked[0].cost.subtotal, 600000);
  assert.equal(r.excluded[0].reason, 'insufficient_stock');
});
