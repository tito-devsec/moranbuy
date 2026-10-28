const norm = (v) => String(v ?? '').trim().toLowerCase();

// Words customers use for "I need it now" and "soon"; anything else is not urgent.
const NOW = /\b(leo|today|sasa hivi|sasa|haraka|urgent|asap|immediately|now|right away|mara moja)\b/i;
const SOON = /\b(kesho|tomorrow|wiki hii|this week|within the week)\b/i;

// How urgent the request is from its urgency text: "now", "soon" or null.
export function urgencyLevel(urgency) {
  const t = String(urgency || '');
  if (!t.trim()) return null;
  if (NOW.test(t)) return 'now';
  if (SOON.test(t)) return 'soon';
  return null;
}

// Every value the customer asked for, flattened to plain words that can be looked for in a variant name.
function wantedTerms(attrs = {}) {
  const out = [];
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) v.forEach((x) => out.push({ key: k, value: x }));
    else if (typeof v === 'object') continue;
    else out.push({ key: k, value: v });
  }
  return out;
}

// The variant name contains the value as a word ("128gb", "grey", "3 seater"); numbers must match whole.
function nameHas(name, value) {
  const n = ` ${norm(name).replace(/[^a-z0-9]+/g, ' ')} `;
  const v = norm(value).replace(/[^a-z0-9]+/g, ' ').trim();
  if (!v) return false;
  return n.includes(` ${v} `) || n.replace(/ /g, '').includes(v.replace(/ /g, ''));
}

// Picks the variant of an offer that best fits the request: it must be in stock for the quantity, essentials count double; null when none names anything asked for.
export function chooseVariant({ request, offer }) {
  const variants = Array.isArray(offer.variants) ? offer.variants.filter((x) => x && x.name) : [];
  if (!variants.length) return null;
  const qty = request.quantity || 1;
  const essential = wantedTerms(request.essentialAttributes);
  const preferred = wantedTerms(request.preferredAttributes);
  let best = null;
  for (const v of variants) {
    if (v.stock !== null && v.stock !== undefined && Number(v.stock) < qty) continue;
    const essentialHit = essential.filter((w) => nameHas(v.name, w.value));
    const preferredHit = preferred.filter((w) => nameHas(v.name, w.value));
    const score = essentialHit.length * 2 + preferredHit.length;
    if (!score) continue;
    const price = Number.isFinite(Number(v.price)) && Number(v.price) > 0 ? Number(v.price) : Number(offer.price);
    if (!best || score > best.score || (score === best.score && price < best.price)) best = { variant: v, score, price, essentialHit, preferredHit };
  }
  return best;
}

// The offer as the customer would buy it: the chosen variant's price and stock, and the attributes its name satisfied.
export function applyVariant({ request, offer }) {
  const pick = chooseVariant({ request, offer });
  if (!pick) return offer;
  const attributes = { ...(offer.attributes || {}) };
  for (const w of [...pick.essentialHit, ...pick.preferredHit]) if (attributes[w.key] === undefined || attributes[w.key] === null || attributes[w.key] === '') attributes[w.key] = w.value;
  return {
    ...offer,
    price: pick.price,
    stock: pick.variant.stock === null || pick.variant.stock === undefined ? offer.stock : Number(pick.variant.stock),
    attributes,
    variant: { name: String(pick.variant.name).slice(0, 80), price: pick.price },
  };
}
