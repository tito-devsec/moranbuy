// Works out what the customer would pay for an offer, keeping unknown parts unknown instead of zero.
export function computeCost({ offer, quantity = 1, fulfilment = 'any' }) {
  const unit = Number(offer.price);
  const subtotal = unit * quantity;
  const fees = Array.isArray(offer.mandatoryFees) ? offer.mandatoryFees : [];
  const unknownParts = [];
  let mandatory = 0;
  for (const f of fees) {
    if (f.amount === null || f.amount === undefined) unknownParts.push(f.name || 'fee');
    else mandatory += Number(f.amount);
  }
  const delivery = offer.delivery || {};
  let deliveryFee = null;
  let deliveryApplies = false;
  if (fulfilment === 'delivery' || (fulfilment === 'any' && delivery.available === true)) {
    deliveryApplies = delivery.available !== false;
    if (deliveryApplies) {
      if (delivery.fee === null || delivery.fee === undefined) unknownParts.push('delivery');
      else deliveryFee = Number(delivery.fee);
    }
  }
  const knownTotal = subtotal + mandatory + (deliveryFee || 0);
  return { unitPrice: unit, quantity, subtotal, mandatoryFees: mandatory, deliveryApplies, deliveryFee, knownTotal, unknownParts, totalConfirmed: unknownParts.length === 0 };
}

// Compares a cost against the budget: fits, over, or unconfirmed when unknown parts could still push it over.
export function budgetFit(cost, maxBudget) {
  if (maxBudget === null || maxBudget === undefined) return { status: 'no_budget', shortfall: 0 };
  const budget = Number(maxBudget);
  if (cost.knownTotal > budget) return { status: 'over', shortfall: cost.knownTotal - budget };
  if (!cost.totalConfirmed) return { status: 'unconfirmed', shortfall: 0, headroom: budget - cost.knownTotal };
  return { status: 'fits', shortfall: 0, headroom: budget - cost.knownTotal };
}
