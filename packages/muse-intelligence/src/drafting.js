// Drafting helpers: Muse writes words around facts the application supplies; every number it may use is in the facts.
const RECOMMEND = `You write short WhatsApp replies for MoranBuy, a reverse marketplace in Tanzania.
Write in the customer's language (sw = Swahili with common English product words, en = English).
Use only the offers, prices, totals, distances and notes in the facts. Do not add, round or change any number.
Say that offers are ordered by budget and total cost first, then by closeness. For each option give one short line: what it is (from its description and attributes) and why it is recommended (within budget or by how much over, distance or place, verified shop, delivery). Say clearly when a delivery fee is not confirmed.
Keep it under 900 characters. Number the options exactly as given. End by asking the customer to reply with an option number or a question.
Answer as JSON: {"reply": "..."}.`;

export async function museDraftRecommendation(muse, { facts, language = 'sw', requestRef = null }) {
  return muse.complete({ feature: 'recommendation', system: RECOMMEND, messages: [{ role: 'user', content: JSON.stringify({ language, facts }) }], maxTokens: 700, requestRef });
}

const CAMPAIGN = `You draft WhatsApp marketing messages for a Tanzanian merchant using MoranBuy.
Use only the product facts supplied: name, price, currency, key attributes, availability, merchant name, location. Never invent discounts, stock, delivery promises or dates.
Keep under 700 characters, in the requested language, with a clear reason to reply and the words "Jibu STOP kuacha" (sw) or "Reply STOP to opt out" (en) at the end.
Answer as JSON: {"body": "...", "headerSuggestion": "...", "notes": ["anything the merchant should verify"]}.`;

export async function museDraftCampaign(muse, { objective, product, merchant, language = 'sw', revision = null, merchantId = null }) {
  const messages = [{ role: 'user', content: JSON.stringify({ objective, product, merchant, language }) }];
  if (revision) messages.push({ role: 'user', content: `Revise the previous draft: ${revision.instruction}. Previous: ${revision.previous}` });
  return muse.complete({ feature: revision ? 'campaign_revision' : 'campaign_draft', system: CAMPAIGN, messages, maxTokens: 600, merchantId });
}

const OUTREACH = `You draft a short "new product" announcement for WhatsApp from the facts supplied. Use only the facts. No invented prices, discounts or stock. Under 600 characters, in the requested language, ending with the opt-out line. Answer as JSON: {"body": "...", "headerSuggestion": "...", "notes": []}.`;

export async function museDraftOutreach(muse, { product, merchant, language = 'sw', merchantId = null }) {
  return muse.complete({ feature: 'outreach_draft', system: OUTREACH, messages: [{ role: 'user', content: JSON.stringify({ product, merchant, language }) }], maxTokens: 500, merchantId });
}

const LEADS = `Summarise these follow-up leads for a merchant in two or three sentences, in the requested language, from the facts only. Answer as JSON: {"summary": "..."}.`;

export async function museSummarizeLeads(muse, { leads, language = 'sw', merchantId = null }) {
  return muse.complete({ feature: 'followup_summary', system: LEADS, messages: [{ role: 'user', content: JSON.stringify({ language, leads }) }], maxTokens: 400, merchantId });
}

const ADMIN = `You help a MoranBuy administrator read redacted operational data for one section of the admin dashboard.
Explain in plain English what the data shows and what needs attention, from the data only: say what is healthy, what is stuck or failing, and why it matters.
Use only numbers that appear in the data; do not add, round or change any. Three to six sentences. Then list the concrete things to check next, most urgent first.
Answer as JSON: {"summary": "...", "checks": ["..."]}.`;

export async function museAdminSummary(muse, { data, section = 'overview' }) {
  return muse.complete({ feature: 'admin_summary', system: ADMIN, messages: [{ role: 'user', content: JSON.stringify({ section, data }).slice(0, 12000) }], maxTokens: 600, requestRef: `admin:${section}` });
}

// Every number in a drafted text must come from the facts; otherwise the deterministic text is used instead.
export function numbersAreGrounded(text, facts) {
  const allowed = new Set(JSON.stringify(facts).match(/\d[\d,.]*/g)?.map(normalizeNumber) || []);
  const found = String(text).match(/\d[\d,.]*/g) || [];
  return found.every((n) => allowed.has(normalizeNumber(n)) || /^\d{1,2}$/.test(n.replace(/[.,]$/, '')));
}

function normalizeNumber(n) { return n.replace(/[,.]+$/, '').replace(/,/g, ''); }
