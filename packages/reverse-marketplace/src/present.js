import { formatMoney } from '@moranbuy/core';

// Turns a ranking result into facts and a deterministic reply; the reply uses only these facts.
export function buildFacts(result, request, { max = 5 } = {}) {
  const line = (r, i) => ({
    option: i + 1,
    listingId: r.offer.id,
    merchantId: r.offer.merchantId || null,
    name: r.offer.variant ? `${r.offer.name} (${r.offer.variant.name})` : r.offer.name,
    variant: r.offer.variant?.name || null,
    merchant: r.offer.merchantName,
    price: r.cost.unitPrice,
    quantity: r.cost.quantity,
    deliveryFee: r.cost.deliveryApplies ? r.cost.deliveryFee : null,
    deliveryApplies: r.cost.deliveryApplies,
    knownTotal: r.cost.knownTotal,
    totalConfirmed: r.cost.totalConfirmed,
    budgetStatus: r.budget.status,
    shortfall: r.budget.shortfall || 0,
    distanceKm: r.location.distanceKm,
    locationLabel: r.offer.location?.label || null,
    deliveryAvailable: r.location.deliveryAvailable,
    pickupAvailable: r.location.pickupAvailable,
    merchantVerified: r.trust.merchantVerified,
    stock: r.offer.stock,
    imageUrl: r.offer.imageUrl || null,
    source: r.offer.source,
    sourceUrl: r.offer.sourceUrl || null,
    area: r.offer.area || null,
    condition: r.offer.condition || null,
    description: r.offer.description ? String(r.offer.description).replace(/\s+/g, ' ').slice(0, 140) : null,
    attributes: r.offer.attributes || {},
    reasons: r.reasons,
  });
  const ranked = result.ranked.slice(0, max).map(line);
  const over = result.overBudget.slice(0, Math.max(0, max - ranked.length) || 1).map((r, i) => line(r, ranked.length + i));
  return { currency: request.currency, maxBudget: request.maxBudget, fulfilment: request.fulfilment, ranked, overBudget: over, noneWithinBudget: result.noneWithinBudget, exactOnly: !!result.exactOnly, alternativesHidden: result.alternativesHidden || 0, urgency: result.urgency || null };
}

const T = {
  sw: {
    intro: (n) => `Nimepata ${n} zinazokaribia mahitaji yako. Nimezipanga kwa kuzingatia bei na bajeti yako kwanza, kisha ukaribu wa duka na delivery.`,
    none: (b) => `Sijapata bidhaa inayolingana ndani ya bajeti ya ${b}. Hizi ndizo zilizo karibu zaidi:`,
    nothing: 'Samahani, sijapata bidhaa inayolingana na ombi lako kwa sasa. Unaweza kubadilisha maelezo, kuongeza bajeti, au kukubali mbadala.',
    over: (s) => `inazidi bajeti kwa ${s}`,
    fits: 'ndani ya bajeti',
    unconfirmed: 'gharama ya delivery haijathibitishwa',
    deliveryFee: (f) => `delivery ${f}`,
    noDelivery: 'hakuna delivery, pickup tu',
    deliveryUnknown: 'delivery haijathibitishwa',
    km: (d) => `umbali ~${d} km`,
    verified: 'duka limethibitishwa',
    total: (t) => `jumla ${t}`,
    web: 'imepatikana mtandaoni, haijathibitishwa',
    ask: 'Jibu namba ya chaguo (mfano 1) kupata maelezo zaidi au kuagiza, au uliza swali.',
    askNone: 'Ungependa: (a) mbadala wa bei nafuu, (b) kubadilisha maelezo, au (c) kuongeza bajeti?',
    hidden: (n) => `Kuna ${n} zinazokaribia lakini zinazidi bajeti au hazilingani kabisa; umesema hutaki mbadala. Jibu "mbadala sawa" kuziona.`,
    ready: 'ipo sasa',
    urgentNote: 'Umesema unahitaji haraka, kwa hiyo zilizopo dukani sasa zimewekwa mbele ndani ya bei ileile.',
  },
  en: {
    intro: (n) => `I found ${n} offers close to what you need, ordered by price and your budget first, then by how close the shop is and delivery.`,
    none: (b) => `Nothing matched within ${b}. These are the closest alternatives:`,
    nothing: 'Sorry, I could not find a matching product right now. You can change the details, raise the budget, or accept alternatives.',
    over: (s) => `over budget by ${s}`,
    fits: 'within budget',
    unconfirmed: 'delivery cost not confirmed',
    deliveryFee: (f) => `delivery ${f}`,
    noDelivery: 'no delivery, pickup only',
    deliveryUnknown: 'delivery not confirmed',
    km: (d) => `about ${d} km away`,
    verified: 'verified merchant',
    total: (t) => `total ${t}`,
    web: 'found online, not confirmed',
    ask: 'Reply with an option number (e.g. 1) for details or to order, or ask a question.',
    askNone: 'Would you like: (a) cheaper alternatives, (b) a different specification, or (c) a higher budget?',
    hidden: (n) => `${n} close offers are over budget or not an exact match; you said no alternatives. Reply "alternatives ok" to see them.`,
    ready: 'in stock now',
    urgentNote: 'You said you need it soon, so offers in stock now come first within the same price.',
  },
};

// The deterministic reply, used directly or as the guard when Muse's wording is rejected.
export function renderReply(facts, language = 'sw') {
  const t = T[language] || T.sw;
  const cur = facts.currency;
  const lines = [];
  const all = [...facts.ranked, ...facts.overBudget];
  if (!all.length) return facts.alternativesHidden ? `${t.nothing}\n${t.hidden(facts.alternativesHidden)}` : `${t.nothing}`;
  if (facts.noneWithinBudget) lines.push(t.none(formatMoney(facts.maxBudget, cur)));
  else lines.push(t.intro(facts.ranked.length));
  if (facts.urgency) lines.push(t.urgentNote);
  for (const o of all) {
    const bits = [];
    bits.push(`${formatMoney(o.price, cur)}${o.quantity > 1 ? ` x${o.quantity}` : ''}`);
    if (o.deliveryApplies) bits.push(o.deliveryFee === null ? t.deliveryUnknown : t.deliveryFee(formatMoney(o.deliveryFee, cur)));
    if (o.deliveryAvailable === false) bits.push(t.noDelivery);
    bits.push(o.totalConfirmed ? t.total(formatMoney(o.knownTotal, cur)) : `${t.total(formatMoney(o.knownTotal, cur))} (${t.unconfirmed})`);
    bits.push(o.budgetStatus === 'over' ? t.over(formatMoney(o.shortfall, cur)) : t.fits);
    if (o.distanceKm !== null) bits.push(t.km(o.distanceKm));
    else if (o.locationLabel) bits.push(o.locationLabel);
    else if (o.area) bits.push(o.area);
    if (o.condition && o.condition !== 'new') bits.push(o.condition);
    if (o.merchantVerified) bits.push(t.verified);
    if (facts.urgency && (o.reasons || []).includes('available_now')) bits.push(t.ready);
    if (o.source === 'web') bits.push(t.web);
    lines.push(`${o.option}. ${o.name} - ${o.merchant}: ${bits.join(', ')}.${o.description ? ` ${o.description}` : ''}${o.source === 'web' && o.sourceUrl ? `\n   ${o.sourceUrl}` : ''}`);
  }
  if (facts.alternativesHidden) lines.push(t.hidden(facts.alternativesHidden));
  lines.push(facts.noneWithinBudget && !facts.exactOnly ? t.askNone : t.ask);
  return lines.join('\n');
}
