import { normalizeProductType } from './vocabulary.js';

const norm = (v) => String(v ?? '').trim().toLowerCase();

// "16GB", "1 TB", "8" all read as gigabytes for memory and storage sizes.
export function sizeInGb(v) {
  const m = String(v ?? '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(tb|gb)?/i);
  if (!m) return NaN;
  return Number(m[1]) * (m[2] && m[2].toLowerCase() === 'tb' ? 1024 : 1);
}

// When a listing has no RAM, storage or brand field, its name and description often say it ("HP 250 G8, 8GB RAM, 256GB SSD").
const TEXT_ATTR = {
  ram: /(\d{1,3})\s?gb\s*(?:ddr\d\s*)?(?:ram|memory)|(?:ram|memory)\s*:?\s*(\d{1,3})\s?gb/i,
  storage: /(\d{2,4}|[1-8])\s?(gb|tb)\s*(?:ssd|hdd|emmc|storage|rom|nvme)|(?:ssd|hdd|storage|rom)\s*:?\s*(\d{2,4}|[1-8])\s?(gb|tb)/i,
};
export function attributeFromText(key, offer = {}) {
  const text = `${offer.name || ''} ${offer.description || ''}`;
  if (key === 'brand') return text.trim() ? text : undefined;
  const re = TEXT_ATTR[key];
  if (!re) return undefined;
  const m = text.match(re);
  if (!m) return undefined;
  if (key === 'ram') return Number(m[1] || m[2]);
  const n = Number(m[1] || m[3]); const unit = (m[2] || m[4] || 'gb').toLowerCase();
  return unit === 'tb' ? n * 1024 : n;
}

// Checks one requested attribute against an offer's attributes; numbers accept ranges, text accepts equal or contained values.
export function attributeMatches(key, wanted, offerAttrs = {}, offer = null) {
  let have = offerAttrs?.[key];
  if ((have === undefined || have === null || have === '') && offer) have = attributeFromText(key, offer);
  if (have === undefined || have === null || have === '') return null;
  if (key === 'brand') { const w = norm(wanted); return new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(String(have)); }
  if (wanted && typeof wanted === 'object' && !Array.isArray(wanted)) {
    const n = ['ram', 'storage'].includes(key) ? sizeInGb(have) : Number(have);
    if (!Number.isFinite(n)) return false;
    if (wanted.min !== undefined && n < Number(wanted.min)) return false;
    if (wanted.max !== undefined && n > Number(wanted.max)) return false;
    return true;
  }
  if (Array.isArray(wanted)) return wanted.some((w) => attributeMatches(key, w, offerAttrs, offer) === true);
  const w = norm(wanted);
  const h = norm(have);
  if (['ram', 'storage'].includes(key) && Number.isFinite(sizeInGb(w)) && Number.isFinite(sizeInGb(h))) return sizeInGb(w) === sizeInGb(h);
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
    const r = attributeMatches(k, v, offer.attributes, offer);
    if (r === false) failed.push(k);
    else if (r === null) unknown.push(k);
  }
  // The product type must appear in the offer's type, category or name when it is known.
  const typeWanted = norm(request.productType);
  const typeKnown = [offer.productType, offer.category, offer.name].map(norm);
  // "simu" and "smartphone", "kochi" and "sofa" are the same product: known words are compared by their canonical type.
  const canonWanted = normalizeProductType(typeWanted).productType;
  const canonOffer = typeKnown.map((t) => normalizeProductType(t).productType).filter(Boolean);
  const typeOk = !typeWanted || typeKnown.some((t) => t && (t.includes(typeWanted) || typeWanted.includes(t))) || (canonWanted && (canonOffer.includes(canonWanted) || typeKnown.some((t) => t && t.includes(canonWanted))));
  if (!typeOk) failed.push('productType');
  let matched = 0;
  const preferredKeys = Object.keys(preferred);
  for (const k of preferredKeys) if (attributeMatches(k, preferred[k], offer.attributes, offer) === true) matched += 1;
  const preferredRatio = preferredKeys.length ? matched / preferredKeys.length : 1;
  const essentialMet = failed.length === 0;
  const score = essentialMet ? Math.round(60 + 40 * preferredRatio - 5 * unknown.length) : 0;
  // Buckets keep "similarly suitable" offers together so price, then location, decides between them.
  const bucket = !essentialMet ? 0 : preferredRatio >= 0.66 ? 3 : preferredRatio >= 0.33 ? 2 : 1;
  return { essentialMet, failedEssentials: failed, unknownEssentials: unknown, preferredMatched: matched, preferredTotal: preferredKeys.length, score: Math.max(0, score), bucket };
}
