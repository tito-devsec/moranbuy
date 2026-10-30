import { config } from '@moranbuy/core';
import { logger } from '@moranbuy/observability';
import { metaWebSearch, pageDetails, searchNearbyShops, RuntimeResearcher } from '@moranbuy/integrations';
import { normalizeProductType, productWords } from '@moranbuy/budget-matching';
import { recordMuseRequest } from '@moranbuy/muse-intelligence';
import { db } from '../db/connection.js';
import { getCredentials, museRuntimeConfig, researchRuntimeConfig } from './runtime-settings.js';

// How MoranBuy looks beyond its own shops: Meta web search with an index of every product it has found, and Google Places for shops near the customer.
export const DISCOVERY_DEFAULTS = Object.freeze({ mode: 'meta_web', dailySearchLimit: 300, placesDailyLimit: 300, blockedDomains: '', preferredDomains: '', warmup: true });

const list = (s) => String(s || '').split(/[\s,]+/).map((x) => x.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean);
const record = (r) => recordMuseRequest(db, r).catch(() => null);

export async function discoveryRuntimeConfig(opts) {
  const c = (await getCredentials(opts)).discovery || {};
  const env = config();
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : d);
  return {
    // The demo sandbox does not search the web unless DEMO_WEB_SEARCH=true, because every search costs money.
    mode: env.DEMO_MODE && process.env.DEMO_WEB_SEARCH !== 'true' ? 'off' : (c.mode || DISCOVERY_DEFAULTS.mode),
    dailySearchLimit: num(c.dailySearchLimit, DISCOVERY_DEFAULTS.dailySearchLimit),
    placesDailyLimit: num(c.placesDailyLimit, DISCOVERY_DEFAULTS.placesDailyLimit),
    blockedDomains: list(c.blockedDomains),
    preferredDomains: list(c.preferredDomains),
    warmup: c.warmup ?? DISCOVERY_DEFAULTS.warmup,
    placesApiKey: env.DEMO_MODE ? null : c.placesApiKey || process.env.GOOGLE_PLACES_API_KEY || null,
    placesEnabled: c.placesEnabled ?? true,
  };
}

// Takes one search from today's allowance; false when the limit is reached. One statement, so two messages at once cannot both pass the last slot.
export async function takeQuota(kind, limit, dbImpl = db) {
  if (!limit) return false;
  const rows = await dbImpl.raw(`INSERT INTO discovery_usage (day, kind, count) VALUES ((now() AT TIME ZONE 'Africa/Dar_es_Salaam')::date, ?, 1)
    ON CONFLICT (day, kind) DO UPDATE SET count = discovery_usage.count + 1 WHERE discovery_usage.count < ? RETURNING count`, [kind, limit]);
  return rows.rows.length > 0;
}

export async function usageToday(dbImpl = db) {
  const rows = await dbImpl('discovery_usage').whereRaw("day = (now() AT TIME ZONE 'Africa/Dar_es_Salaam')::date").select('kind', 'count');
  return Object.fromEntries(rows.map((r) => [r.kind, r.count]));
}

// Products already found online that fit the request: same product, within budget plus a margin, seen within the last week.
export async function findIndexed(request, { dbImpl = db, limit = 12, withinHours = 168 } = {}) {
  const canon = normalizeProductType(request.productType).productType;
  const words = [...new Set([canon, request.productType, ...productWords(canon)].filter(Boolean).map((w) => String(w).toLowerCase()))];
  if (!words.length) return [];
  let q = dbImpl('web_products').where('last_seen_at', '>=', new Date(Date.now() - withinHours * 3600000)).whereNotNull('price')
    .where((w) => { for (const word of words) w.orWhereRaw('lower(product_type) = ?', [word]).orWhereILike('name', `%${word}%`); });
  if (request.maxBudget) q = q.where('price', '<=', Math.round(request.maxBudget * 1.25));
  if (request.essentialAttributes?.brand) q = q.whereILike('name', `%${request.essentialAttributes.brand}%`);
  const rows = await q.orderBy('price', 'asc').limit(limit);
  return rows.map(rowToResult(canon || request.productType));
}

const rowToResult = (productType) => (r) => ({ name: r.name, price: r.price === null ? null : Number(r.price), currency: r.currency, availability: 'unknown', sourceUrl: r.url, domain: r.domain, retrievedAt: new Date(r.last_seen_at).toISOString(), attributes: r.attributes || {}, imageUrl: r.image_url, description: r.description, shopName: r.shop_name, area: r.area, condition: r.condition, productType: r.product_type || productType, category: r.category, indexed: true, lastSeenAt: r.last_seen_at });

export async function saveFound(results, request, { dbImpl = db, query = null } = {}) {
  const canon = normalizeProductType(request.productType).productType || request.productType || null;
  for (const r of results) {
    const row = { url: r.sourceUrl, domain: r.domain, name: r.name, product_type: canon, category: request.category || null, price: r.price, currency: r.currency || 'TZS', description: r.description, image_url: r.imageUrl, attributes: JSON.stringify(r.attributes || {}), shop_name: r.shopName, area: r.area, condition: r.condition, source: 'meta_web_search', search_query: query ? String(query).slice(0, 300) : null, last_seen_at: dbImpl.fn.now() };
    await dbImpl('web_products').insert(row).onConflict('url').merge({ ...row, hits: dbImpl.raw('web_products.hits + 1') }).catch((err) => logger.warn({ err: err.message }, 'web product not saved'));
  }
}

// Fills in the photo and description from each listing's own page, a few at a time.
export async function addPageDetails(results, { fetchImpl = globalThis.fetch, max = 6 } = {}) {
  const todo = results.slice(0, max).filter((r) => !r.imageUrl || !r.description || r.price === null);
  await Promise.all(todo.map(async (r) => {
    const d = await pageDetails(r.sourceUrl, { fetchImpl });
    if (!d.ok) return;
    if (!r.imageUrl && d.imageUrl) r.imageUrl = d.imageUrl;
    if (!r.description && d.description) r.description = d.description;
    if (r.price === null && d.price && (!d.currency || d.currency === (r.currency || 'TZS'))) r.price = d.price;
  }));
  return results;
}

// The researcher the shopping engine calls: the index first, then a live Meta web search when the index has too little or is stale.
export class DiscoveryResearcher {
  constructor({ dbImpl = db, fetchImpl = globalThis.fetch, resolve = discoveryRuntimeConfig, museConfig = museRuntimeConfig, minIndexed = 3, freshHours = 24 } = {}) {
    Object.assign(this, { dbImpl, fetchImpl, resolve, museConfig, minIndexed, freshHours });
    this.name = 'discovery';
    this.hermes = new RuntimeResearcher({ resolve: () => researchRuntimeConfig(), deps: { recorder: record } });
  }

  async research(request, { maxResults = 6, city = null } = {}) {
    const s = await this.resolve();
    if (s.mode === 'off' || !request.productType) return { ok: false, status: 'disabled', results: [] };
    if (s.mode === 'hermes') return this.hermes.research(request, { maxResults });
    const canon = normalizeProductType(request.productType).productType || request.productType;
    const indexed = (await findIndexed(request, { dbImpl: this.dbImpl })).map((r) => ({ ...r, productType: canon }));
    const fresh = indexed.filter((r) => Date.now() - new Date(r.lastSeenAt).getTime() < this.freshHours * 3600000);
    // Enough fresh finds, or this product was searched in the last 6 hours: answer from the index, no new search to pay for.
    const searchedRecently = indexed.some((r) => Date.now() - new Date(r.lastSeenAt).getTime() < 6 * 3600000);
    if (fresh.length >= this.minIndexed || searchedRecently) return { ok: true, status: 'indexed', results: (fresh.length ? fresh : indexed).slice(0, maxResults) };
    const muse = await this.museConfig();
    if (!muse.apiKey) return { ok: indexed.length > 0, status: indexed.length ? 'indexed' : 'no_key', results: indexed.slice(0, maxResults) };
    if (!(await takeQuota('web_search', s.dailySearchLimit, this.dbImpl))) return { ok: indexed.length > 0, status: 'daily_limit', results: indexed.slice(0, maxResults) };
    const live = await metaWebSearch({ fetchImpl: this.fetchImpl, baseUrl: muse.baseUrl, apiKey: muse.apiKey, model: muse.model, request, city: city || cityOf(request), maxResults, blockedDomains: s.blockedDomains, preferredDomains: s.preferredDomains, recorder: record });
    if (!live.ok) return { ok: indexed.length > 0, status: indexed.length ? 'indexed' : live.status, results: indexed.slice(0, maxResults) };
    await addPageDetails(live.results, { fetchImpl: this.fetchImpl });
    for (const r of live.results) { r.productType = canon; r.category = request.category || null; }
    await saveFound(live.results, request, { dbImpl: this.dbImpl, query: `${request.productType} ${request.maxBudget || ''}` });
    const byUrl = new Map([...live.results, ...indexed].map((r) => [r.sourceUrl, r]));
    return { ok: true, status: 'ok', results: [...byUrl.values()].slice(0, maxResults) };
  }
}

// "Mbagala, Dar es Salaam" -> "Dar es Salaam"; Meta's search takes a city, not a neighbourhood.
export function cityOf(request) {
  const label = request.location?.label || request.locationText || '';
  const known = ['Dar es Salaam', 'Arusha', 'Mwanza', 'Dodoma', 'Mbeya', 'Morogoro', 'Tanga', 'Zanzibar', 'Moshi', 'Iringa', 'Tabora', 'Kigoma', 'Mtwara', 'Songea', 'Shinyanga', 'Musoma', 'Bukoba', 'Singida', 'Sumbawanga', 'Lindi'];
  return known.find((c) => label.toLowerCase().includes(c.toLowerCase())) || (/\b(dar|dsm)\b/i.test(label) ? 'Dar es Salaam' : null);
}

// Shops near the customer from Google Places, cached for a day per product and area.
export class NearbyShops {
  constructor({ dbImpl = db, fetchImpl = globalThis.fetch, resolve = discoveryRuntimeConfig } = {}) { Object.assign(this, { dbImpl, fetchImpl, resolve }); }

  async find(request, { max = 3 } = {}) {
    const s = await this.resolve();
    if (!s.placesApiKey || s.placesEnabled === false || !request.location || !request.productType) return { ok: false, status: !s.placesApiKey ? 'no_key' : 'skipped', shops: [] };
    const canon = normalizeProductType(request.productType).productType || request.productType;
    const key = `${canon}|${request.essentialAttributes?.brand || ''}|${request.location.lat.toFixed(2)}|${request.location.lng.toFixed(2)}`;
    const cached = await this.dbImpl('nearby_shop_cache').where({ key }).where('created_at', '>=', new Date(Date.now() - 24 * 3600000)).first();
    if (cached) return { ok: true, status: 'cached', shops: cached.results.slice(0, max) };
    if (!(await takeQuota('places', s.placesDailyLimit, this.dbImpl))) return { ok: false, status: 'daily_limit', shops: [] };
    const r = await searchNearbyShops({ fetchImpl: this.fetchImpl, apiKey: s.placesApiKey, request: { ...request, productType: canon }, location: request.location, maxResults: max, recorder: record });
    if (r.ok) await this.dbImpl('nearby_shop_cache').insert({ key, results: JSON.stringify(r.shops), created_at: this.dbImpl.fn.now() }).onConflict('key').merge();
    return r;
  }
}

// Keeps the index full: once a day, the products people asked for most (and the everyday ones) are searched in advance, using at most half of the day's allowance.
const EVERYDAY = ['smartphone', 'laptop', 'television', 'fridge', 'sofa', 'mattress', 'cooker', 'blender', 'speaker', 'generator', 'bed', 'water pump'];
export async function warmUpIndex({ dbImpl = db, researcher = new DiscoveryResearcher({ dbImpl }), limit = 20 } = {}) {
  const s = await discoveryRuntimeConfig();
  if (s.mode !== 'meta_web' || !s.warmup) return { searched: 0, reason: 'off' };
  const used = (await usageToday(dbImpl)).web_search || 0;
  const budget = Math.max(0, Math.floor(s.dailySearchLimit / 2) - used);
  const asked = await dbImpl('demand_signals').where('created_at', '>=', new Date(Date.now() - 7 * 86400000)).whereNotNull('product_type').groupBy('product_type').orderByRaw('count(*) desc').limit(limit).pluck('product_type').catch(() => []);
  const types = [...new Set([...asked, ...EVERYDAY].map((t) => normalizeProductType(t).productType || t).filter(Boolean))].slice(0, Math.min(limit, budget));
  let searched = 0;
  for (const productType of types) {
    const r = await researcher.research({ productType, essentialAttributes: {}, preferredAttributes: {}, maxBudget: null, currency: 'TZS', location: { label: 'Dar es Salaam' } }, { maxResults: 8, city: 'Dar es Salaam' });
    if (r.status === 'ok') searched += 1;
    if (r.status === 'daily_limit') break;
  }
  return { searched };
}

export async function discoveryStats(dbImpl = db) {
  const [{ n }] = await dbImpl('web_products').count('* as n');
  const [{ d }] = await dbImpl('web_products').countDistinct('domain as d');
  const [{ w }] = await dbImpl('web_products').where('last_seen_at', '>=', new Date(Date.now() - 7 * 86400000)).count('* as w');
  const types = await dbImpl('web_products').groupBy('product_type').select('product_type').count('* as n').orderBy('n', 'desc').limit(12);
  return { products: Number(n), sites: Number(d), seenThisWeek: Number(w), byType: types.map((t) => ({ productType: t.product_type, count: Number(t.n) })), today: await usageToday(dbImpl) };
}
