// Product search on the public web with Muse Spark's built-in web search (Meta Model API, POST /v1/responses, tool "web_search").
// Every listing kept must link to a page Meta's search actually returned, so nothing invented reaches a customer.

const SYSTEM = `You find products for sale in Tanzania for a shopper, using web search.
Search shop websites, online marketplaces, brand stores and public social media shop pages (Facebook pages, Instagram shops) that show the product with a price.
Return up to the requested number of different listings that match the request and are for sale now. Prefer listings in Tanzania and near the shopper's city.
Copy the price exactly as the page shows it, as a number in its currency; if the page shows no price, use null. Never estimate a price.
For each listing give: name (as the page names it), price, currency, url (the listing page itself), shopName, area (town or neighbourhood if the page says), condition ("new", "used", "refurbished" or null), description (one or two plain sentences about the product from the page: model, key specs), attributes (object, e.g. {"ram": 8, "storage": 256, "brand": "hp"} with sizes in GB), imageUrl (a product image URL from the page if you saw one, else null).
Answer with one JSON object only: {"results": [...], "notes": ["..."]}. No words before or after it.`;

const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; } };

// Pulls the searched pages and cited pages out of a Responses API answer, and the text the model wrote.
export function readResponse(data) {
  const sources = new Set();
  let text = typeof data?.output_text === 'string' ? data.output_text : '';
  for (const item of data?.output || []) {
    if (item.type === 'web_search_call') for (const r of item.results || item.action?.sources || []) if (r?.url) sources.add(r.url);
    if (item.type === 'message') {
      for (const c of item.content || []) {
        if (c.type === 'output_text') { if (!data.output_text) text += c.text || ''; for (const a of c.annotations || []) if (a?.url) sources.add(a.url); }
      }
    }
  }
  return { text, sources: [...sources] };
}

// The first JSON object in a reply that may have words around it.
function firstJson(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch { /* fall through */ }
  const start = t.indexOf('{'); const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

// Keeps listings whose page is on a site the search returned, drops blocked sites, and cleans every field.
export function groundResults(parsed, sources, { blockedDomains = [], maxResults = 6 } = {}) {
  const hosts = new Set(sources.map(hostOf).filter(Boolean));
  const blocked = blockedDomains.map((d) => d.toLowerCase().replace(/^www\./, '')).filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(parsed?.results) ? parsed.results : []) {
    const host = hostOf(r?.url);
    if (!host || !r?.name) continue;
    if (!/^https?:\/\//i.test(r.url)) continue;
    if (!hosts.has(host) && !sources.includes(r.url)) continue;
    if (blocked.some((d) => host === d || host.endsWith(`.${d}`))) continue;
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    const price = r.price === null || r.price === undefined || r.price === '' ? null : Number(String(r.price).replace(/[^\d.]/g, ''));
    out.push({
      name: String(r.name).slice(0, 300),
      price: price && Number.isFinite(price) && price > 0 ? Math.round(price) : null,
      currency: String(r.currency || 'TZS').toUpperCase().slice(0, 3),
      sourceUrl: r.url,
      domain: host,
      shopName: r.shopName ? String(r.shopName).slice(0, 200) : null,
      area: r.area ? String(r.area).slice(0, 200) : null,
      condition: ['new', 'used', 'refurbished'].includes(String(r.condition || '').toLowerCase()) ? String(r.condition).toLowerCase() : null,
      description: r.description ? String(r.description).replace(/\s+/g, ' ').slice(0, 400) : null,
      attributes: r.attributes && typeof r.attributes === 'object' && !Array.isArray(r.attributes) ? r.attributes : {},
      imageUrl: r.imageUrl && /^https?:\/\//i.test(r.imageUrl) ? String(r.imageUrl) : null,
      retrievedAt: new Date().toISOString(),
    });
    if (out.length >= maxResults) break;
  }
  return out;
}

// One search: the request in plain words, Tanzania as the place, results grounded in what Meta's search returned.
export async function metaWebSearch({ fetchImpl = globalThis.fetch, baseUrl, apiKey, model = 'muse-spark-1.3', request, city = null, maxResults = 6, blockedDomains = [], preferredDomains = [], timeoutMs = 45000, recorder = null }) {
  const started = Date.now();
  const want = {
    product: request.productType,
    mustHave: request.essentialAttributes || {},
    niceToHave: request.preferredAttributes || {},
    maxBudget: request.maxBudget ? `${request.maxBudget} ${request.currency || 'TZS'}` : null,
    shopperCity: city,
    country: 'Tanzania',
    maxResults,
    ...(preferredDomains.length ? { preferSites: preferredDomains } : {}),
  };
  const body = {
    model,
    instructions: SYSTEM,
    input: JSON.stringify(want),
    tools: [{ type: 'web_search', search_context_size: 'medium', user_location: { type: 'approximate', country: 'TZ', ...(city ? { city } : {}) } }],
    include: ['web_search_call.results'],
    max_output_tokens: 6000,
    max_tool_calls: 3,
  };
  try {
    const res = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/responses`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const data = await res.json().catch(() => ({}));
    const latencyMs = Date.now() - started;
    const usage = data.usage || {};
    if (!res.ok) {
      await recorder?.({ feature: 'web_search', provider: 'meta', model, status: 'error', latencyMs, errorCode: `HTTP_${res.status}`, errorRedacted: JSON.stringify(data?.error || data).slice(0, 300) });
      return { ok: false, status: 'error', code: `HTTP_${res.status}`, results: [] };
    }
    const { text, sources } = readResponse(data);
    const parsed = firstJson(text);
    if (!parsed) {
      await recorder?.({ feature: 'web_search', provider: 'meta', model, status: 'error', latencyMs, errorCode: 'BAD_JSON', errorRedacted: String(text).slice(0, 200), inputTokens: usage.input_tokens, outputTokens: usage.output_tokens });
      return { ok: false, status: 'error', code: 'BAD_JSON', results: [] };
    }
    const results = groundResults(parsed, sources, { blockedDomains, maxResults });
    await recorder?.({ feature: 'web_search', provider: 'meta', model: data.model || model, status: 'ok', latencyMs, inputTokens: usage.input_tokens ?? null, outputTokens: usage.output_tokens ?? null });
    return { ok: true, status: 'ok', results, sources: sources.length, dropped: (parsed.results?.length || 0) - results.length };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    await recorder?.({ feature: 'web_search', provider: 'meta', model, status: timeout ? 'timeout' : 'error', latencyMs: Date.now() - started, errorCode: timeout ? 'TIMEOUT' : err.code || 'NETWORK', errorRedacted: err.message });
    return { ok: false, status: timeout ? 'timeout' : 'error', results: [] };
  }
}
