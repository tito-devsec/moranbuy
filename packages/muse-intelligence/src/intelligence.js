// Muse's wider duties: reading a business's product from chat, explaining demand statistics, and judging which customers fit an offer; every answer is checked against the facts.

const PRODUCT = `You read a product a Tanzanian business describes in a WhatsApp message (text, and a photo when given) for its MoranBuy catalogue.
Extract only what is stated or clearly visible. Never invent a price, a stock count or a specification.
Answer with one JSON object: name (short product name), productType (short English noun, e.g. "sofa"), category (one of: furniture, electronics, phones, fashion, home, beauty, food, vehicles, building, other),
description (one or two plain sentences from the facts), attributes (object, e.g. {"seats": 3, "color": "grey"}), price (integer or null), currency ("TZS" unless stated), stock (integer or null),
condition ("new", "used" or null), confidence (0 to 1). Price words: "laki" = 100,000; "elfu" = 1,000; "milioni" = 1,000,000; "k" = 1,000.`;

export async function museExtractProduct(muse, { text, imageUrl = null, merchantId = null }) {
  const content = [];
  if (text) content.push({ type: 'text', text });
  if (imageUrl) content.push({ type: 'image_url', image_url: { url: imageUrl } });
  if (!content.length) return { ok: false, status: 'empty' };
  return muse.complete({ feature: 'catalog_extract', system: PRODUCT, messages: [{ role: 'user', content }], maxTokens: 500, merchantId });
}

const OVERVIEW = `You explain MoranBuy demand statistics to a business owner or administrator, in the requested language (sw = Swahili, en = English).
Use only the numbers in the data: which products customers ask for most, where they are, what budgets they state, what sold best, and what the business could do about it.
Do not add, round or change any number. Three to six short sentences. Answer as JSON: {"summary": "...", "actions": ["..."]}.`;

export async function museDemandOverview(muse, { stats, language = 'sw', merchantId = null }) {
  return muse.complete({ feature: 'demand_overview', system: OVERVIEW, messages: [{ role: 'user', content: JSON.stringify({ language, stats }).slice(0, 12000) }], maxTokens: 600, merchantId });
}

const FIT = `You judge which customers fit a business's offer, from the facts only: what each customer asked MoranBuy for (product, attributes, budget, place, when they want to buy) and the offer (product, price, place).
Return the customers ordered from best fit to least, with a one-line reason each in the requested language. Never include a customer who is not in the input.
Answer as JSON: {"ranked": [{"ref": "...", "score": 0 to 1, "reason": "..."}]}.`;

export async function museAudienceFit(muse, { offer, candidates, language = 'sw', merchantId = null }) {
  return muse.complete({ feature: 'audience_fit', system: FIT, messages: [{ role: 'user', content: JSON.stringify({ language, offer, candidates }).slice(0, 12000) }], maxTokens: 1200, merchantId });
}

const FOLLOWUP = `You write one short WhatsApp follow-up from a business to a customer who asked about a product and went quiet.
Use only the facts: business name, product name, price, what the customer said. No invented discounts, stock or dates. Under 400 characters, in the requested language, warm and not pushy,
ending with "Jibu STOP kusitisha" (sw) or "Reply STOP to end these messages" (en). Answer as JSON: {"body": "..."}.`;

export async function museDraftFollowup(muse, { facts, language = 'sw', merchantId = null }) {
  return muse.complete({ feature: 'followup_draft', system: FOLLOWUP, messages: [{ role: 'user', content: JSON.stringify({ language, facts }) }], maxTokens: 300, merchantId });
}

// Reads "Bidhaa: Sofa ya watu 3, bei laki 3, stock 5" without a model, so a business can still list by chat when Muse is off.
export function fallbackExtractProduct(text) {
  const t = String(text || '').trim();
  const body = t.replace(/^(bidhaa|product|ongeza|add)\s*[:\-]?\s*/i, '');
  const mult = { laki: 100000, elfu: 1000, milioni: 1000000, k: 1000, m: 1000000 };
  const words = { moja: 1, mbili: 2, tatu: 3, nne: 4, tano: 5, sita: 6, saba: 7, nane: 8, tisa: 9, kumi: 10 };
  // "bei 450000", "bei laki 4 na nusu", "laki tatu", "250k": the number may come before or after the unit word, in digits or Swahili words.
  let price = null;
  const after = body.match(/\b(laki|elfu|milioni)\s+([\d.,]+|moja|mbili|tatu|nne|tano|sita|saba|nane|tisa|kumi)(\s+na\s+nusu)?/i);
  const before = body.match(/(?:bei|price|tsh|tzs|sh)\s*[:\-]?\s*([\d.,]+)\s*(laki|elfu|milioni|k|m)?\b/i) || body.match(/([\d.,]+)\s*(laki|elfu|milioni|k|m)\b/i);
  if (after) price = Math.round(((words[after[2].toLowerCase()] ?? parseFloat(after[2].replace(/,/g, ''))) + (after[3] ? 0.5 : 0)) * mult[after[1].toLowerCase()]);
  else if (before) price = Math.round(parseFloat(before[1].replace(/,/g, '')) * (mult[(before[2] || '').toLowerCase()] || 1));
  const stockM = body.match(/(?:stock|idadi|zipo|vipo|qty)\s*[:\-]?\s*(\d+)/i);
  const name = body.split(/[,;\n]|\bbei\b|\bprice\b|\bstock\b|\bidadi\b/i)[0].trim().slice(0, 120);
  const attributes = {};
  const seats = body.match(/(?:watu|seats?|viti)\s*(\d+)|(\d+)\s*(?:seater|seats?|watu)/i);
  if (seats) attributes.seats = Number(seats[1] || seats[2]);
  const color = body.match(/\b(nyeusi|nyeupe|kijivu|bluu|nyekundu|kijani|brown|black|white|grey|gray|blue|red|green)\b/i);
  if (color) attributes.color = color[1].toLowerCase();
  const lower = body.toLowerCase();
  const typeMap = [['sofa', 'sofa', 'furniture'], ['kochi', 'sofa', 'furniture'], ['kitanda', 'bed', 'furniture'], ['meza', 'table', 'furniture'], ['kiti', 'chair', 'furniture'], ['simu', 'smartphone', 'phones'], ['phone', 'smartphone', 'phones'], ['tv', 'television', 'electronics'], ['friji', 'fridge', 'electronics'], ['laptop', 'laptop', 'electronics'], ['viatu', 'shoes', 'fashion'], ['nguo', 'clothing', 'fashion'], ['gauni', 'dress', 'fashion']];
  const hit = typeMap.find(([w]) => lower.includes(w));
  return { name: name || null, productType: hit?.[1] || null, category: hit?.[2] || 'other', description: body.slice(0, 500) || null, attributes, price: price && price > 0 ? price : null, currency: 'TZS', stock: stockM ? Number(stockM[1]) : null, condition: /\b(used|mtumba|second ?hand)\b/i.test(body) ? 'used' : null, confidence: name ? 0.4 : 0 };
}
