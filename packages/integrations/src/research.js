import { config } from '@moranbuy/core';

// Keeps only research results that are on an allowed domain, carry a real URL and a numeric or null price.
export function sanitizeResearchResults(raw, allowedDomains) {
  const allowed = new Set(allowedDomains.map((d) => d.toLowerCase()));
  const out = [];
  for (const r of Array.isArray(raw?.results) ? raw.results : []) {
    let url;
    try { url = new URL(String(r.sourceUrl)); } catch { continue; }
    const host = url.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol) || ![...allowed].some((d) => host === d || host.endsWith(`.${d}`))) continue;
    const price = r.price === null || r.price === undefined ? null : Number(r.price);
    if (price !== null && !(Number.isFinite(price) && price > 0)) continue;
    if (!r.name) continue;
    out.push({ name: String(r.name).slice(0, 200), price, currency: String(r.currency || 'TZS').slice(0, 3).toUpperCase(), availability: ['in stock', 'out of stock'].includes(String(r.availability || '').toLowerCase()) ? String(r.availability).toLowerCase() : 'unknown', sourceUrl: url.toString(), domain: host, retrievedAt: r.retrievedAt || new Date().toISOString(), attributes: r.attributes && typeof r.attributes === 'object' ? r.attributes : {}, imageUrl: r.imageUrl && /^https?:/.test(r.imageUrl) ? String(r.imageUrl) : null });
  }
  return out;
}

// Turns research results into offers for the ranking engine: unverified, no location, no delivery facts, never orderable.
export function researchResultsToOffers(results) {
  return results.filter((r) => r.price !== null).map((r, i) => ({
    id: `web:${r.domain}:${i}`, merchantId: `web:${r.domain}`, merchantName: r.domain, merchantStatus: 'active', merchantVerified: false, source: 'web', sourceKey: `web:${r.sourceUrl}`,
    name: r.name, productType: null, category: null, attributes: r.attributes, price: r.price, currency: r.currency, priceVerified: false,
    stock: r.availability === 'out of stock' ? 0 : null, status: 'active', imageUrl: r.imageUrl, updatedAt: r.retrievedAt, deletedAt: null,
    location: null, delivery: { available: null, fee: null, radiusKm: null }, pickup: null, sourceUrl: r.sourceUrl, unverified: true,
  }));
}

// Asks the MoranBuy Hermes agent (web and browser toolsets, one skill) for structured results from allowed domains.
export class HermesResearchClient {
  constructor({ cfg = null, fetchImpl = globalThis.fetch, recorder = null } = {}) {
    const c = cfg || config();
    this.enabled = c.MORANBUY_WEB_RESEARCH_ENABLED && !!c.HERMES_BASE_URL && !!c.HERMES_API_KEY;
    this.baseUrl = String(c.HERMES_BASE_URL || '').replace(/\/+$/, '');
    this.apiKey = c.HERMES_API_KEY;
    this.model = c.HERMES_MODEL;
    this.allowedDomains = String(c.MORANBUY_ALLOWED_DOMAINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    this.fetchImpl = fetchImpl;
    this.recorder = recorder;
    this.name = 'hermes';
  }

  async research(request, { maxResults = 5 } = {}) {
    if (!this.enabled || !this.allowedDomains.length) return { ok: false, status: 'disabled', results: [] };
    const input = { productType: request.productType, attributes: request.essentialAttributes, maxBudget: request.maxBudget, currency: request.currency, locationText: request.locationText || request.location?.label || null, allowedDomains: this.allowedDomains, maxResults };
    const started = Date.now();
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', 'X-Request-Id': `research-${started}` }, body: JSON.stringify({ model: this.model, stream: false, messages: [{ role: 'system', content: 'Use the moranbuy-product-research skill. Answer only with its JSON.' }, { role: 'user', content: JSON.stringify(input) }] }), signal: AbortSignal.timeout(70000) });
      const data = await res.json().catch(() => ({}));
      const text = data.choices?.[0]?.message?.content || '';
      let parsed = null;
      try { parsed = JSON.parse(String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')); } catch { parsed = null; }
      const results = res.ok && parsed ? sanitizeResearchResults(parsed, this.allowedDomains) : [];
      await this.recorder?.({ feature: 'web_research', provider: 'hermes', model: this.model, status: res.ok && parsed ? 'ok' : 'error', latencyMs: Date.now() - started, errorCode: res.ok ? (parsed ? null : 'BAD_JSON') : `HTTP_${res.status}` });
      return { ok: res.ok && !!parsed, status: res.ok && parsed ? 'ok' : 'error', results, notes: parsed?.notes || [] };
    } catch (err) {
      await this.recorder?.({ feature: 'web_research', provider: 'hermes', model: this.model, status: 'error', latencyMs: Date.now() - started, errorCode: err.name === 'TimeoutError' ? 'TIMEOUT' : err.code || 'NETWORK', errorRedacted: err.message });
      return { ok: false, status: 'error', results: [] };
    }
  }
}

// A plain fetch researcher for when Hermes is not deployed: reads allowed sites' search pages, obeys robots.txt, parses JSON-LD product data only.
export class PlainFetchResearcher {
  constructor({ cfg = null, fetchImpl = globalThis.fetch, recorder = null, searchPaths = {} } = {}) {
    const c = cfg || config();
    this.enabled = c.MORANBUY_WEB_RESEARCH_ENABLED;
    this.allowedDomains = String(c.MORANBUY_ALLOWED_DOMAINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    this.fetchImpl = fetchImpl;
    this.recorder = recorder;
    this.searchPaths = searchPaths; // domain -> "/search?q={q}"
    this.name = 'plain_fetch';
    this.robots = new Map();
  }

  async allowedByRobots(domain, path) {
    if (!this.robots.has(domain)) {
      try { const r = await this.fetchImpl(`https://${domain}/robots.txt`, { signal: AbortSignal.timeout(5000) }); this.robots.set(domain, r.ok ? await r.text() : ''); } catch { this.robots.set(domain, ''); }
    }
    const txt = this.robots.get(domain);
    const disallowed = [...txt.matchAll(/^Disallow:\s*(\S+)/gim)].map((m) => m[1]);
    return !disallowed.some((d) => d !== '/' ? path.startsWith(d) : true);
  }

  async research(request, { maxResults = 5 } = {}) {
    if (!this.enabled || !this.allowedDomains.length) return { ok: false, status: 'disabled', results: [] };
    const started = Date.now();
    const results = [];
    const q = encodeURIComponent(String(request.productType || ''));
    for (const domain of this.allowedDomains) {
      const path = (this.searchPaths[domain] || '/search?q={q}').replace('{q}', q);
      if (!(await this.allowedByRobots(domain, path.split('?')[0]))) continue;
      try {
        const r = await this.fetchImpl(`https://${domain}${path}`, { headers: { 'User-Agent': 'MoranBuyResearch/0.1 (+https://github.com/tito-devsec/moranbuy)' }, signal: AbortSignal.timeout(8000) });
        if (!r.ok) continue;
        const html = await r.text();
        for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
          let data; try { data = JSON.parse(m[1]); } catch { continue; }
          for (const item of Array.isArray(data) ? data : [data]) {
            const products = item?.['@type'] === 'Product' ? [item] : (item?.itemListElement || []).map((e) => e.item || e).filter((p) => p?.['@type'] === 'Product');
            for (const p of products) {
              const offer = Array.isArray(p.offers) ? p.offers[0] : p.offers;
              results.push({ name: p.name, price: offer?.price ?? null, currency: offer?.priceCurrency || 'TZS', availability: /InStock/i.test(offer?.availability || '') ? 'in stock' : /OutOfStock/i.test(offer?.availability || '') ? 'out of stock' : 'unknown', sourceUrl: p.url || offer?.url || `https://${domain}${path}`, retrievedAt: new Date().toISOString(), imageUrl: Array.isArray(p.image) ? p.image[0] : p.image || null });
              if (results.length >= maxResults) break;
            }
          }
        }
      } catch { continue; }
      if (results.length >= maxResults) break;
    }
    const clean = sanitizeResearchResults({ results }, this.allowedDomains);
    await this.recorder?.({ feature: 'web_research', provider: 'plain_fetch', model: 'jsonld', status: 'ok', latencyMs: Date.now() - started });
    return { ok: true, status: 'ok', results: clean, notes: [] };
  }
}

export function createResearcher(cfg = config(), deps = {}) {
  if (!cfg.MORANBUY_WEB_RESEARCH_ENABLED) return null;
  return cfg.HERMES_BASE_URL && cfg.HERMES_API_KEY ? new HermesResearchClient({ cfg, ...deps }) : new PlainFetchResearcher({ cfg, ...deps });
}
