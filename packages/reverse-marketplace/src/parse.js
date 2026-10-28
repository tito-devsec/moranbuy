// Deterministic fallback parser used when Muse Spark is off or fails: budget, quantity, fulfilment and language from plain text.
const WORD_NUMBERS = { moja: 1, mbili: 2, tatu: 3, nne: 4, tano: 5, sita: 6, saba: 7, nane: 8, tisa: 9, kumi: 10, one: 1, two: 2, three: 3, four: 4, five: 5 };

export function parseBudget(text) {
  const t = String(text || '').toLowerCase().replace(/,/g, '');
  let m = t.match(/(?:tsh|tzs|sh|shilingi)?\s*(\d+(?:\.\d+)?)\s*(m|mil|milioni|million|k|elfu|laki)?\b/g);
  let best = null;
  for (const chunk of m || []) {
    const mm = chunk.match(/(\d+(?:\.\d+)?)\s*(m|mil|milioni|million|k|elfu|laki)?/);
    if (!mm) continue;
    let n = Number(mm[1]);
    const unit = mm[2];
    if (unit === 'laki') n *= 100000;
    else if (unit === 'k' || unit === 'elfu') n *= 1000;
    else if (unit) n *= 1000000;
    if (n >= 1000 && (best === null || n > best)) best = Math.round(n);
  }
  // Swahili also puts the unit first: "laki tatu", "laki 4", "milioni mbili".
  const UNITS = { laki: 100000, elfu: 1000, milioni: 1000000 };
  for (const mm of t.matchAll(/\b(laki|elfu|milioni)\s+(\w+)/g)) {
    const count = WORD_NUMBERS[mm[2]] ?? (Number.isFinite(Number(mm[2])) ? Number(mm[2]) : null);
    if (count === null) continue;
    const n = count * UNITS[mm[1]];
    if (best === null || n > best) best = n;
  }
  return best;
}

export function parseFulfilment(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(delivery|deliver|niletee|nileteewe|kuletewa|tuma)\b/.test(t)) return 'delivery';
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

// Best-effort product words: the text with budget, place and filler removed, trimmed to a short phrase.
export function parseProductGuess(text) {
  let t = String(text || '').toLowerCase();
  t = t.split(/\b(nipo|niko|i am in|i'm in|delivery|nataka delivery|pickup)\b/)[0];
  t = t.replace(/(tsh|tzs|sh)?\s*\d[\d,.]*\s*(m|mil|milioni|million|k|elfu|laki)?/g, ' ');
  t = t.replace(/\b(bila mbadala|sitaki mbadala|no alternatives?|mbadala sawa|alternatives? ok)\b/g, ' ');
  t = t.replace(/\b(nina|nataka|ninahitaji|naomba|nipo|niko|delivery|ikiwezekana|i want|i need|budget|please|tafadhali|na|ya|wa|of|for|a|an|the|my|is|leo|haraka|today|urgent|asap|kesho|tomorrow|sasa|hivi|tu|hii|only|exactly|laki|elfu|milioni|tsh|tzs)\b/g, ' ');
  t = t.replace(/[.,!?]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.split(' ').slice(0, 5).join(' ') || null;
}

export function parseLocationText(text) {
  const m = String(text || '').match(/\b(?:nipo|niko|nipo hapa|i am in|i'm in|location|from)\s+([A-Z][\w' ]+(?:,\s*[A-Z][\w' ]+)?)/i);
  return m ? m[1].trim().replace(/\s+(nataka|na|and).*$/i, '') : null;
}

// Attributes the plain reader can be sure of: storage and memory sizes are essential, colours are preferred.
export function parseAttributes(text) {
  const t = String(text || '').toLowerCase();
  const essential = {};
  const preferred = {};
  const sizes = [...t.matchAll(/\b(\d{1,4})\s?(gb|tb)\b/g)].map((m) => `${m[1]}${m[2].toUpperCase()}`);
  if (sizes.length) essential.storage = sizes.length > 1 ? sizes.sort((a, b) => parseInt(b, 10) - parseInt(a, 10))[0] : sizes[0];
  const color = t.match(/\b(nyeusi|nyeupe|kijivu|bluu|nyekundu|kijani|black|white|grey|gray|blue|red|green|gold|silver)\b/);
  if (color) preferred.color = { nyeusi: 'black', nyeupe: 'white', kijivu: 'grey', bluu: 'blue', nyekundu: 'red', kijani: 'green', gray: 'grey' }[color[1]] || color[1];
  return { ...(Object.keys(essential).length ? { essentialAttributes: essential } : {}), ...(Object.keys(preferred).length ? { preferredAttributes: preferred } : {}) };
}

// "bila mbadala" / "no alternatives" turns alternatives off; "mbadala sawa" / "alternatives ok" turns them back on; otherwise unsaid.
export function parseAlternatives(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(bila mbadala|sitaki mbadala|hakuna mbadala|no alternatives?|exactly this|only this|hii tu|hiyo tu)\b/.test(t)) return { alternativesOk: false };
  if (/\b(mbadala sawa|mbadala ni sawa|nionyeshe mbadala|alternatives? ok|show alternatives|any alternative)\b/.test(t)) return { alternativesOk: true };
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
