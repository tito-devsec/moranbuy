const norm = (v) => String(v ?? '').trim().toLowerCase();

// Checks one requested attribute against an offer's attributes; numbers accept ranges, text accepts equal or contained values.
export function attributeMatches(key, wanted, offerAttrs = {}) {
  const have = offerAttrs[key];
  if (have === undefined || have === null || have === '') return null;
  if (wanted && typeof wanted === 'object' && !Array.isArray(wanted)) {
    const n = Number(have);
    if (!Number.isFinite(n)) return false;
    if (wanted.min !== undefined && n < Number(wanted.min)) return false;
    if (wanted.max !== undefined && n > Number(wanted.max)) return false;
    return true;
  }
  if (Array.isArray(wanted)) return wanted.some((w) => attributeMatches(key, w, offerAttrs) === true);
  const w = norm(wanted);
  const h = norm(have);
  if (!Number.isNaN(Number(w)) && !Number.isNaN(Number(h))) return Number(w) === Number(h);
  return h === w || h.includes(w) || w.includes(h);
}

// Scores how well an offer fits the request: essentials must all hold, preferred ones add to the score.
export function assessSuitability({ request, offer }) {
  const essential = request.essentialAttributes || {};
  const preferred = request.preferredAttributes || {};
  const failed = [];
  const unknown = [];
  for (const [k, v] of Object.entries(essential)) {
    const r = attributeMatches(k, v, offer.attributes);
    if (r === false) failed.push(k);
    else if (r === null) unknown.push(k);
  }
  // The product type must appear in the offer's type, category or name when it is known.
  const typeWanted = norm(request.productType);
  const typeKnown = [offer.productType, offer.category, offer.name].map(norm);
  const typeOk = !typeWanted || typeKnown.some((t) => t && (t.includes(typeWanted) || typeWanted.includes(t)));
  if (!typeOk) failed.push('productType');
  let matched = 0;
  const preferredKeys = Object.keys(preferred);
  for (const k of preferredKeys) if (attributeMatches(k, preferred[k], offer.attributes) === true) matched += 1;
  const preferredRatio = preferredKeys.length ? matched / preferredKeys.length : 1;
  const essentialMet = failed.length === 0;
  const score = essentialMet ? Math.round(60 + 40 * preferredRatio - 5 * unknown.length) : 0;
  // Buckets keep "similarly suitable" offers together so price, then location, decides between them.
  const bucket = !essentialMet ? 0 : preferredRatio >= 0.66 ? 3 : preferredRatio >= 0.33 ? 2 : 1;
  return { essentialMet, failedEssentials: failed, unknownEssentials: unknown, preferredMatched: matched, preferredTotal: preferredKeys.length, score: Math.max(0, score), bucket };
}
