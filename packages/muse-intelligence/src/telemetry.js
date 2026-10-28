// The rates an administrator entered for Muse; Meta's price is not in the API response, so cost is only as good as these numbers.
export const DEFAULT_MUSE_PRICING = Object.freeze({
  inputPerMillionUsd: null,  // US dollars per million input tokens
  outputPerMillionUsd: null, // US dollars per million output tokens
  usdToTzs: null,            // for showing costs in shillings; blank shows dollars only
  monthlyBudgetUsd: null,    // alert threshold for the calendar month
  hardCap: false,            // when true, Muse is not called once the month's cost reaches the budget; every duty uses its plain fallback
  asrPerHourUsd: null,       // Muse Voice Transcribe, US dollars per hour of audio
  updatedAt: null,
});

let pricingCache = { at: 0, value: null };
// Reads the rate card, cached for a minute so every call does not query it.
export async function loadMusePricing(db, { fresh = false } = {}) {
  if (!db) return { ...DEFAULT_MUSE_PRICING };
  if (!fresh && pricingCache.value && Date.now() - pricingCache.at < 60000) return pricingCache.value;
  const row = await db('platform_settings').where({ key: 'muse_pricing' }).first().catch(() => null);
  pricingCache = { at: Date.now(), value: { ...DEFAULT_MUSE_PRICING, ...(row?.value || {}) } };
  return pricingCache.value;
}
export function clearMusePricingCache() { pricingCache = { at: 0, value: null }; budgetCache = { at: 0, value: null }; }

// The cost of one request from its token counts and the rate card; null when either is unknown.
export function priceTokens(pricing, inputTokens, outputTokens) {
  if (pricing.inputPerMillionUsd === null || pricing.outputPerMillionUsd === null || pricing.inputPerMillionUsd === undefined || pricing.outputPerMillionUsd === undefined) return null;
  if (inputTokens === null && outputTokens === null) return null;
  return (Number(inputTokens || 0) * Number(pricing.inputPerMillionUsd) + Number(outputTokens || 0) * Number(pricing.outputPerMillionUsd)) / 1e6;
}

// Records one real Muse request outcome, with its cost when rates are set; nothing here is ever written without an actual call having been made.
export async function recordMuseRequest(db, { feature, provider, model, status, latencyMs = null, inputTokens = null, outputTokens = null, errorCode = null, errorRedacted = null, merchantId = null, requestRef = null, audioMs = null }) {
  if (!db) return;
  const pricing = await loadMusePricing(db);
  const cost = audioMs ? (pricing.asrPerHourUsd === null || pricing.asrPerHourUsd === undefined ? null : (audioMs / 3600000) * Number(pricing.asrPerHourUsd)) : priceTokens(pricing, inputTokens ?? null, outputTokens ?? null);
  await db('muse_requests').insert({
    feature, provider, model, status, latency_ms: latencyMs, input_tokens: inputTokens, output_tokens: outputTokens,
    error_code: errorCode, error_redacted: errorRedacted ? String(errorRedacted).slice(0, 500) : null, merchant_id: merchantId, request_ref: requestRef,
    cost_usd: cost, pricing_ref: cost === null ? null : String(pricing.updatedAt || 'rates').slice(0, 40),
  });
  if (cost) budgetCache.value = budgetCache.value ? { ...budgetCache.value, spentUsd: budgetCache.value.spentUsd + cost } : null;
}

const monthStart = (now = Date.now()) => { const d = new Date(now); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); };
let budgetCache = { at: 0, value: null };
// This month's spend against the budget; blocked only when the hard cap is on and the budget is reached.
export async function museBudgetState(db, { now = Date.now(), fresh = false } = {}) {
  if (!db) return { blocked: false };
  if (!fresh && budgetCache.value && now - budgetCache.at < 60000) return budgetCache.value;
  const pricing = await loadMusePricing(db, { fresh });
  const row = await db('muse_requests').where('created_at', '>=', monthStart(now)).sum('cost_usd as s').first().catch(() => ({ s: 0 }));
  const spentUsd = Number(row?.s || 0);
  const budget = pricing.monthlyBudgetUsd === null || pricing.monthlyBudgetUsd === undefined ? null : Number(pricing.monthlyBudgetUsd);
  const value = { spentUsd, budgetUsd: budget, usedShare: budget ? spentUsd / budget : null, hardCap: !!pricing.hardCap, blocked: !!(pricing.hardCap && budget !== null && spentUsd >= budget) };
  budgetCache = { at: now, value };
  return value;
}

// Summarises the telemetry table for the admin page: counts, failures, latency and last success, all from stored rows.
export async function museTelemetry(db, { sinceHours = 24 } = {}) {
  const since = new Date(Date.now() - sinceHours * 3600000);
  const rows = await db('muse_requests').where('created_at', '>=', since).select('feature', 'status', 'latency_ms', 'input_tokens', 'output_tokens', 'model', 'provider', 'created_at', 'cost_usd');
  const byFeature = {};
  let ok = 0; let failed = 0; let latencySum = 0; let latencyCount = 0; let inTok = 0; let outTok = 0; let cost = 0; let unpriced = 0;
  for (const r of rows) {
    byFeature[r.feature] ||= { requests: 0, ok: 0, failed: 0 };
    byFeature[r.feature].requests += 1;
    if (r.status === 'ok') { ok += 1; byFeature[r.feature].ok += 1; } else { failed += 1; byFeature[r.feature].failed += 1; }
    if (r.latency_ms !== null) { latencySum += r.latency_ms; latencyCount += 1; }
    inTok += r.input_tokens || 0; outTok += r.output_tokens || 0;
    if (r.cost_usd !== null) cost += Number(r.cost_usd); else if (r.input_tokens || r.output_tokens) unpriced += 1;
  }
  const lastOk = await db('muse_requests').where({ status: 'ok' }).orderBy('created_at', 'desc').first('created_at', 'model', 'provider');
  const lastErr = await db('muse_requests').whereNot({ status: 'ok' }).orderBy('created_at', 'desc').first('created_at', 'error_code', 'error_redacted');
  return {
    sinceHours, requests: rows.length, ok, failed, avgLatencyMs: latencyCount ? Math.round(latencySum / latencyCount) : null,
    inputTokens: inTok, outputTokens: outTok, costUsd: Math.round(cost * 1e6) / 1e6, unpricedRequests: unpriced, byFeature, lastSuccess: lastOk || null, lastFailure: lastErr || null,
  };
}

// The cost report: totals, by day, by feature and by business, month to date with a projection, and how much was left unpriced.
export async function museCostReport(db, { days = 30, now = Date.now() } = {}) {
  const pricing = await loadMusePricing(db, { fresh: true });
  const since = new Date(now - days * 86400000);
  const base = () => db('muse_requests as r').where('r.created_at', '>=', since);
  const sumRow = (q) => q.count('r.id as requests').sum('r.input_tokens as input').sum('r.output_tokens as output').sum('r.cost_usd as cost').first();
  const round = (v) => Math.round(Number(v || 0) * 1e6) / 1e6;
  const shape = (r) => ({ requests: Number(r.requests || 0), inputTokens: Number(r.input || 0), outputTokens: Number(r.output || 0), costUsd: round(r.cost) });
  const totals = shape(await sumRow(base()));
  const byDay = (await base().select(db.raw("to_char(date_trunc('day', r.created_at at time zone 'Africa/Dar_es_Salaam'), 'YYYY-MM-DD') as day")).count('r.id as requests').sum('r.input_tokens as input').sum('r.output_tokens as output').sum('r.cost_usd as cost').groupByRaw('1').orderBy('day')).map((r) => ({ day: r.day, ...shape(r) }));
  const byFeature = (await base().select('r.feature').count('r.id as requests').sum('r.input_tokens as input').sum('r.output_tokens as output').sum('r.cost_usd as cost').groupBy('r.feature').orderByRaw('sum(r.cost_usd) desc nulls last, count(r.id) desc')).map((r) => ({ feature: r.feature, ...shape(r) }));
  const byMerchant = (await base().leftJoin('merchants as m', 'm.id', 'r.merchant_id').select(db.raw("coalesce(m.business_name, '(shoppers and platform)') as business")).count('r.id as requests').sum('r.input_tokens as input').sum('r.output_tokens as output').sum('r.cost_usd as cost').groupByRaw('1').orderByRaw('sum(r.cost_usd) desc nulls last, count(r.id) desc').limit(10)).map((r) => ({ business: r.business, ...shape(r) }));
  const unpriced = Number((await base().whereNull('r.cost_usd').where((q) => q.where('r.input_tokens', '>', 0).orWhere('r.output_tokens', '>', 0)).count('r.id as c').first()).c);
  const ms = monthStart(now);
  const mtd = shape(await sumRow(db('muse_requests as r').where('r.created_at', '>=', ms)));
  const d = new Date(now);
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  const elapsed = Math.max(1, (now - ms.getTime()) / 86400000);
  const projectedUsd = round((mtd.costUsd / elapsed) * daysInMonth);
  const budget = await museBudgetState(db, { now, fresh: true });
  const tzs = (usd) => (pricing.usdToTzs ? Math.round(usd * Number(pricing.usdToTzs)) : null);
  return {
    days, pricing, ratesSet: pricing.inputPerMillionUsd !== null && pricing.outputPerMillionUsd !== null,
    totals: { ...totals, costTzs: tzs(totals.costUsd) }, unpricedRequests: unpriced,
    monthToDate: { ...mtd, costTzs: tzs(mtd.costUsd), projectedUsd, projectedTzs: tzs(projectedUsd) },
    budget: { ...budget, alert: budget.budgetUsd !== null && (budget.spentUsd >= budget.budgetUsd * 0.8 || projectedUsd >= budget.budgetUsd) },
    byDay, byFeature, byMerchant,
  };
}

// Prices past requests that were made before any rate was set, with today's rates; already priced requests keep their price.
export async function priceUnpricedRequests(db) {
  const p = await loadMusePricing(db, { fresh: true });
  if (p.inputPerMillionUsd === null || p.outputPerMillionUsd === null) return 0;
  return db('muse_requests').whereNull('cost_usd').where((q) => q.where('input_tokens', '>', 0).orWhere('output_tokens', '>', 0))
    .update({ cost_usd: db.raw('(coalesce(input_tokens, 0) * ? + coalesce(output_tokens, 0) * ?) / 1000000.0', [Number(p.inputPerMillionUsd), Number(p.outputPerMillionUsd)]), pricing_ref: 'recomputed' });
}
