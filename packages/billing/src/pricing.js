// Campaign pricing from configured values only; a provider rate nobody configured is reported as unknown, never guessed.
export const DEFAULT_PRICING = Object.freeze({
  providerUnitTzs: null,   // Meta's per-message marketing conversation charge, set by the admin from the current rate card
  serviceFeeUnitTzs: 20,   // MoranBuy's own fee per queued message
  serviceFeeMinTzs: 2000,
  taxPct: 18,              // VAT applied to MoranBuy's fee
  currency: 'TZS',
});

export function priceCampaign({ recipients, pricing = DEFAULT_PRICING }) {
  const p = { ...DEFAULT_PRICING, ...pricing };
  const n = Number(recipients) || 0;
  const providerKnown = Number.isFinite(Number(p.providerUnitTzs)) && p.providerUnitTzs !== null;
  const providerTotal = providerKnown ? Math.round(n * Number(p.providerUnitTzs)) : null;
  const serviceFee = Math.max(p.serviceFeeMinTzs, Math.round(n * p.serviceFeeUnitTzs));
  const taxes = Math.round((serviceFee * p.taxPct) / 100);
  const estimatedTotal = providerKnown ? providerTotal + serviceFee + taxes : null;
  return {
    recipients: n, currency: p.currency, providerUnit: providerKnown ? Number(p.providerUnitTzs) : null, providerTotal, serviceFee, taxes, taxPct: p.taxPct,
    estimatedTotal, knownPortion: serviceFee + taxes, pricingSource: providerKnown ? 'configured' : 'provider_rate_not_configured',
    note: providerKnown ? 'Provider charges are an estimate from the configured rate; the settled amount is recorded after dispatch.' : 'The WhatsApp provider rate is not configured; the campaign cannot be paid until an administrator sets it.',
  };
}
