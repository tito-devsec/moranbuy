import { computeCost, budgetFit } from './cost.js';
import { assessSuitability } from './suitability.js';
import { assessLocation } from '@moranbuy/location-ranking';

// Ranking policy values; changing them is an audited admin configuration change, never a silent edit.
export const DEFAULT_POLICY = Object.freeze({
  priceSimilarityPct: 2,       // totals within this share of the budget count as similar, so location may decide
  priceSimilarityMin: 2000,    // never narrower than this many currency units
  staleAfterDays: 45,          // listings not updated for this long are demoted and flagged
  suspiciousBelowMedianPct: 25, // a price under this share of the eligible median needs confirmation
  overBudgetShowPct: 25,       // over-budget alternatives shown only up to this much above budget
});

const STALE_MS = (days) => days * 86400000;

// Stage A: hard constraints; returns the reason an offer is out, or null when it stays in.
export function exclusionReason({ request, offer, suitability, now }) {
  if (offer.deletedAt) return 'deleted';
  if (offer.status && !['active', 'ACTIVE'].includes(offer.status)) return `status_${String(offer.status).toLowerCase()}`;
  if (offer.merchantStatus && offer.merchantStatus !== 'active') return 'merchant_suspended';
  if (offer.currency && request.currency && offer.currency !== request.currency) return 'currency_mismatch';
  if (!Number.isFinite(Number(offer.price)) || Number(offer.price) <= 0) return 'no_price';
  if (offer.stock !== null && offer.stock !== undefined && Number(offer.stock) < (request.quantity || 1)) return Number(offer.stock) <= 0 ? 'out_of_stock' : 'insufficient_stock';
  if (!suitability.essentialMet) return `unsuitable:${suitability.failedEssentials.join(',')}`;
  if (offer.availableFrom && now < new Date(offer.availableFrom).getTime()) return 'not_yet_available';
  return null;
}

// Removes offers that represent the same product from the same merchant, keeping the freshest.
export function dedupe(offers) {
  const seen = new Map();
  const out = [];
  for (const o of offers) {
    const key = o.sourceKey || `${o.merchantId}|${String(o.name).trim().toLowerCase()}|${o.price}`;
    const prev = seen.get(key);
    if (!prev) { seen.set(key, o); out.push(o); continue; }
    if (new Date(o.updatedAt || 0) > new Date(prev.updatedAt || 0)) { out[out.indexOf(prev)] = o; seen.set(key, o); }
  }
  return out;
}

// The full pipeline: hard constraints, budget, suitability, location, trust; returns ranked, over-budget and excluded offers with reasons.
export function rankOffers({ request, offers, policy = DEFAULT_POLICY, now = Date.now() }) {
  const p = { ...DEFAULT_POLICY, ...policy };
  const quantity = request.quantity || 1;
  const fulfilment = request.fulfilment || 'any';
  const excluded = [];
  const duplicates = offers.length - dedupe(offers).length;
  const assessed = [];

  for (const offer of dedupe(offers)) {
    const suitability = assessSuitability({ request, offer });
    const reason = exclusionReason({ request, offer, suitability, now });
    if (reason) { excluded.push({ offerId: offer.id, merchantId: offer.merchantId, name: offer.name, reason }); continue; }
    const cost = computeCost({ offer, quantity, fulfilment });
    const budget = budgetFit(cost, request.maxBudget);
    const location = assessLocation({ customerLocation: request.location, offer, fulfilment });
    const ageMs = offer.updatedAt ? now - new Date(offer.updatedAt).getTime() : null;
    const trust = {
      merchantVerified: offer.merchantVerified === true,
      priceVerified: offer.priceVerified === true,
      stockKnown: offer.stock !== null && offer.stock !== undefined,
      stale: ageMs !== null && ageMs > STALE_MS(p.staleAfterDays),
      suspiciousPrice: false,
      score: 0,
    };
    assessed.push({ offer, cost, budget, suitability, location, trust, reasons: [] });
  }

  // Trust stage: a price far below the eligible median is flagged, never silently recommended.
  const totals = assessed.map((a) => a.cost.knownTotal).sort((a, b) => a - b);
  const median = totals.length ? totals[Math.floor(totals.length / 2)] : 0;
  for (const a of assessed) {
    if (median > 0 && a.cost.knownTotal < median * (p.suspiciousBelowMedianPct / 100) && !a.trust.priceVerified) a.trust.suspiciousPrice = true;
    a.trust.score = (a.trust.merchantVerified ? 40 : 0) + (a.trust.priceVerified ? 20 : 0) + (a.trust.stockKnown ? 20 : 0) + (a.trust.stale ? 0 : 20) - (a.trust.suspiciousPrice ? 60 : 0);
    if (a.trust.stale) a.reasons.push('listing_stale');
    if (a.trust.suspiciousPrice) a.reasons.push('price_needs_confirmation');
    if (!a.cost.totalConfirmed) a.reasons.push(`unknown_cost:${a.cost.unknownParts.join(',')}`);
  }

  const inBudget = assessed.filter((a) => a.budget.status !== 'over');
  const overBudget = assessed.filter((a) => a.budget.status === 'over');
  const budgetValue = Number(request.maxBudget) || 0;
  const tolerance = Math.max(p.priceSimilarityMin, (budgetValue * p.priceSimilarityPct) / 100);

  // Price bands relative to the cheapest offer: inside one band location decides, across bands the cheaper total wins.
  const band = (a, min) => Math.floor((a.cost.knownTotal - min) / tolerance);
  const sortGroup = (group) => {
    const min = group.length ? Math.min(...group.map((a) => a.cost.knownTotal)) : 0;
    return group.sort((x, y) =>
      (y.trust.suspiciousPrice ? 0 : 1) - (x.trust.suspiciousPrice ? 0 : 1)
      || y.suitability.bucket - x.suitability.bucket
      || band(x, min) - band(y, min)
      || y.location.score - x.location.score
      || y.trust.score - x.trust.score
      || x.cost.knownTotal - y.cost.knownTotal
      || y.suitability.score - x.suitability.score);
  };
  sortGroup(inBudget);
  sortGroup(overBudget);
  let shownOver = budgetValue ? overBudget.filter((a) => a.cost.knownTotal <= budgetValue * (1 + p.overBudgetShowPct / 100)) : overBudget;
  // With nothing inside the budget the two cheapest alternatives are still shown so the customer sees the real gap.
  if (!inBudget.length && !shownOver.length) shownOver = overBudget.slice(0, 2);

  // Each ranked offer carries a plain explanation of why it stands where it does.
  const explain = (a, i, group) => {
    const r = [];
    if (a.budget.status === 'fits') r.push('within_budget');
    if (a.budget.status === 'unconfirmed') r.push('within_budget_on_known_costs');
    if (a.budget.status === 'over') r.push(`over_budget_by:${a.budget.shortfall}`);
    if (i === 0 && group.length > 1 && a.budget.status !== 'over') r.push('lowest_known_total_among_suitable');
    if (a.suitability.preferredTotal) r.push(`preferred_matched:${a.suitability.preferredMatched}/${a.suitability.preferredTotal}`);
    if (a.location.distanceKm !== null) r.push(`distance_km:${a.location.distanceKm}`);
    if (a.location.deliveryAvailable === true) r.push('delivery_available');
    if (a.location.deliveryAvailable === false) r.push('no_delivery');
    if (a.trust.merchantVerified) r.push('merchant_verified');
    return [...r, ...a.reasons];
  };
  const finish = (group) => group.map((a, i) => ({ rank: i + 1, ...a, reasons: explain(a, i, group) }));

  return {
    policy: p,
    ranked: finish(inBudget),
    overBudget: finish(shownOver),
    excluded,
    duplicatesRemoved: duplicates,
    noneWithinBudget: inBudget.length === 0,
    cheapestOverBudget: overBudget[0] ? { offerId: overBudget[0].offer.id, knownTotal: overBudget[0].cost.knownTotal, shortfall: overBudget[0].budget.shortfall } : null,
  };
}
