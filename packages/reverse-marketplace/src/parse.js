// Deterministic fallback parser used when Muse Spark is off or fails: budget, quantity, fulfilment and language from plain text.
import { parseShillings } from '@moranbuy/core';
import { normalizeProductType } from '@moranbuy/budget-matching';

// The largest amount the customer named is their budget.
export const parseBudget = (text) => parseShillings(text);

export function parseFulfilment(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(delivery|deliver|niletee|nileteewe|niletewe|nileteeni|niletewa|kuletewa|tuma)\b/.test(t)) return 'delivery';
  if (/\b(pickup|pick up|nichukue|nitachukua|nije|kuja)\b/.test(t)) return 'pickup';
  return 'any';
}

export function parseLanguage(text) {
  const t = String(text || '').toLowerCase();
  const sw = (t.match(/\b(nina|nataka|nipo|ya|wa|na|bei|ninahitaji|naomba|niko)\b/g) || []).length;
  const en = (t.match(/\b(i|want|need|have|budget|the|for|with|am|in)\b/g) || []).length;
  return en > sw ? 'en' : 'sw';
}

export function parseQuantity(text) {
  const m = String(text || '').toLowerCase().match(/\b(\d{1,3})\s*(pcs|pieces|vipande|units?)\b/);
  return m ? Number(m[1]) : 1;
}

// Amounts said in words, such as "elfu tisini" or "laki moja na elfu ishirini", so the number words never end up in the product name.
const NUM = 'moja|mbili|tatu|nne|tano|sita|saba|nane|tisa|kumi|ishirini|thelathini|arobaini|hamsini|sitini|sabini|themanini|tisini';
const SPOKEN_AMOUNT = new RegExp(`\\b(elfu|laki|milioni|mia)((\\s+(na\\s+)?(${NUM}|elfu|laki|mia))+)\\b`, 'g');

// Best-effort product words: the text with budget, place and filler removed, trimmed to a short phrase.
export function parseProductGuess(text) {
  // A known product word ("laptop", "blenda", "simu") is the product, whatever else the sentence says.
  // The customer's own product word wins over a brand: "simu Samsung" is "simu" (the brand is kept separately).
  const withoutBrands = String(text || '').toLowerCase().replace(new RegExp(`\\b(${BRANDS.join('|')})\\b`, 'g'), ' ');
  const word = normalizeProductType(withoutBrands);
  if (word.matched) return word.matched;
  const known = normalizeProductType(text);
  if (known.matched) return known.productType;
  let t = String(text || '').toLowerCase();
  t = t.split(/\b(nipo|niko|i am in|i'm in|delivery|nataka delivery|pickup)\b/)[0];
  t = t.replace(/(tsh|tzs|sh)?\s*\d[\d,.]*\s*(m|mil|milioni|million|k|elfu|laki)?/g, ' ');
  t = t.replace(SPOKEN_AMOUNT, ' ');
  t = t.replace(/\b(bila mbadala|sitaki mbadala|no alternatives?|mbadala sawa|alternatives? ok)\b/g, ' ');
  t = t.replace(/\b(me|mimi|nahitaji|natak|natafuta|iwe|kampuni|na|nina|nataka|ninahitaji|naomba|nipo|niko|delivery|ikiwezekana|i want|i need|budget|please|tafadhali|na|ya|wa|of|for|a|an|the|my|is|leo|haraka|today|urgent|asap|kesho|tomorrow|sasa|hivi|tu|hii|only|exactly|laki|elfu|milioni|tsh|tzs)\b/g, ' ');
  t = t.replace(/[.,!?]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.split(' ').slice(0, 5).join(' ') || null;
}

// The reply to "Upo wapi?" is the place itself, without "nipo": "mbagala dar" or "Sinza, Dar es Salaam".
export function placeFromAnswer(text) {
  const t = String(text || '').replace(/^\s*(nipo|niko|nko|naishi|i am in|i'm in|in|at)\s+/i, '').replace(/[.!?]+$/, '').trim();
  if (!t || t.length > 80 || /\d{4,}/.test(t)) return null;
  if (/^(sijui|hapana|no|ndio|yes|sawa|ok)\b/i.test(t)) return null;
  // "dar", "dsm" stand for Dar es Salaam.
  return t.replace(/\b(dar|dsm)\b(?!\s+es)/i, 'Dar es Salaam');
}

export function parseLocationText(text) {
  const m = String(text || '').match(/\b(?:nipo|niko|nipo hapa|i am in|i'm in|location|from)\s+([A-Z][\w' ]+(?:,\s*[A-Z][\w' ]+)?)/i);
  return m ? m[1].trim().replace(/\s+(nataka|na|and).*$/i, '').replace(/,?\s*\b(niletewe|nileteeni|delivery|pickup|nataka|tafadhali)\b.*$/i, '').trim() || null : null;
}

// Brands customers name; the key is how the brand is matched in listing names.
export const BRANDS = ['hp', 'dell', 'lenovo', 'apple', 'macbook', 'asus', 'acer', 'msi', 'toshiba', 'samsung', 'tecno', 'infinix', 'itel', 'xiaomi', 'redmi', 'oppo', 'vivo', 'realme', 'nokia', 'huawei', 'iphone', 'google pixel', 'lg', 'hisense', 'sony', 'tcl', 'panasonic', 'philips', 'sharp', 'von', 'bruhm', 'boss', 'nikon', 'canon'];
const AT_LEAST = '(?:kuanzia|angalau|at least|from|min(?:imum)?|zaidi ya|over|>=?)';

// Attributes the plain reader can be sure of: memory and storage sizes (as minimums when the customer says "kuanzia", "angalau" or "at least") and the brand are essential, colours are preferred.
export function parseAttributes(text) {
  const t = String(text || '').toLowerCase();
  const essential = {};
  const preferred = {};
  const sizeOf = (n, unit) => Number(n) * (unit === 'tb' ? 1024 : 1);
  const ram = t.match(new RegExp(`(${AT_LEAST})?\\s*\\b(\\d{1,3})\\s?gb\\s*(?:ya\\s*)?(?:ram|rami|memory)\\b`)) || t.match(new RegExp(`\\b(?:ram|rami|memory)\\s*(?:ya\\s*)?(${AT_LEAST})?\\s*(?:ya\\s*)?(\\d{1,3})\\s?(?:gb)?\\b`));
  if (ram) essential.ram = ram[1] || /kuanzia|angalau/.test(t) ? { min: Number(ram[2]) } : Number(ram[2]);
  const storage = t.match(new RegExp(`(${AT_LEAST})?\\s*\\b(\\d{1,4})\\s?(gb|tb)\\s*(?:ya\\s*)?(?:ssd|hdd|storage|rom|nvme)\\b`)) || t.match(new RegExp(`\\b(?:ssd|hdd|storage|hifadhi|rom|nvme|emmc)\\s*(?:ya\\s*)?(${AT_LEAST})?\\s*(?:ya\\s*)?(\\d{1,4})\\s?(gb|tb)?\\b`));
  if (storage) { const gb = sizeOf(storage[2], storage[3]); essential.storage = storage[1] || /kuanzia|angalau/.test(t) ? { min: gb } : gb; }
  else {
    const sizes = [...t.matchAll(/\b(\d{1,4})\s?(gb|tb)\b/g)].map((m) => sizeOf(m[1], m[2])).filter((n) => !essential.ram || n !== (essential.ram.min ?? essential.ram));
    if (sizes.length) essential.storage = Math.max(...sizes);
  }
  const brand = BRANDS.find((b) => new RegExp(`\\b${b}\\b`).test(t));
  if (brand) essential.brand = brand === 'macbook' || brand === 'iphone' ? 'apple' : brand === 'redmi' ? 'xiaomi' : brand;
  const color = t.match(/\b(nyeusi|nyeupe|kijivu|bluu|nyekundu|kijani|black|white|grey|gray|blue|red|green|gold|silver)\b/);
  if (color) preferred.color = { nyeusi: 'black', nyeupe: 'white', kijivu: 'grey', bluu: 'blue', nyekundu: 'red', kijani: 'green', gray: 'grey' }[color[1]] || color[1];
  return { ...(Object.keys(essential).length ? { essentialAttributes: essential } : {}), ...(Object.keys(preferred).length ? { preferredAttributes: preferred } : {}) };
}

// "bila mbadala" / "no alternatives" turns alternatives off; "mbadala sawa" / "alternatives ok" turns them back on; otherwise unsaid.
export function parseAlternatives(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(bila mbadala|sitaki mbadala|hakuna mbadala|no alternatives?|exactly this|only this|hii tu|hiyo tu)\b/.test(t)) return { alternativesOk: false };
  if (/\b(mbadala sawa|mbadala ni sawa|nionyeshe mbadala|alternatives? ok|show alternatives|any alternative)\b/.test(t)) return { alternativesOk: true };
  if (/\b(m?mbadala|mibadala)\b.*\b(upi|ipi|gani|zipi|wapi)\b|\b(what|which|any) (other )?(options|alternatives)\b|\bnionyeshe (zingine|nyingine)\b/.test(t)) return { alternativesOk: true, wantsAlternatives: true };
  return {};
}

// The words that say when the customer needs it, kept as said; ranking decides what they mean.
export function parseUrgency(text) {
  const m = String(text || '').match(/\b(leo|today|sasa hivi|haraka|urgent|asap|immediately|right away|mara moja|kesho|tomorrow|wiki hii|this week)\b/i);
  return m ? m[0].toLowerCase() : null;
}

// Pulls everything the fallback can read from one message into extraction fields.
export function fallbackExtract(text) {
  return {
    productType: parseProductGuess(text),
    maxBudget: parseBudget(text),
    quantity: parseQuantity(text),
    fulfilment: parseFulfilment(text),
    locationText: parseLocationText(text),
    language: parseLanguage(text),
    ...parseAlternatives(text),
    ...parseAttributes(text),
    urgency: parseUrgency(text),
    intent: 'shop',
  };
}
