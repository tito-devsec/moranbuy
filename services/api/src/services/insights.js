import { formatMoney } from '@moranbuy/core';
import { museDemandOverview, numbersAreGrounded } from '@moranbuy/muse-intelligence';
import { db } from '../db/connection.js';

const n = (v) => Number(v || 0);

// What customers asked MoranBuy for, where they are, what they would pay and what sold: the facts behind every overview, for one business or the whole platform.
export async function demandStats({ dbImpl = db, merchantId = null, days = 30, now = Date.now() } = {}) {
  const since = new Date(now - days * 86400000);
  let types = null;
  if (merchantId) {
    // A business sees the demand for what it sells, plus every signal where it was the chosen shop.
    types = (await dbImpl('listings').where({ merchant_id: merchantId }).whereNull('deleted_at').whereNotNull('product_type').distinct('product_type').pluck('product_type')).map((t) => String(t).toLowerCase());
  }
  const base = () => {
    let q = dbImpl('demand_signals').where('created_at', '>=', since).whereNotNull('product_type');
    if (merchantId) q = q.where((b) => { b.where({ merchant_id: merchantId }); if (types.length) b.orWhereRaw('lower(product_type) = any(?)', [types]); });
    return q;
  };
  const topProducts = (await base().select('product_type').count('id as asks').countDistinct('customer_id as customers').avg('max_budget as avg_budget').min('max_budget as min_budget').max('max_budget as max_budget').groupBy('product_type').orderBy('asks', 'desc').limit(10))
    .map((r) => ({ productType: r.product_type, asks: n(r.asks), customers: n(r.customers), avgBudget: r.avg_budget ? Math.round(Number(r.avg_budget)) : null, minBudget: r.min_budget, maxBudget: r.max_budget }));
  const byRegion = (await base().whereNotNull('region').select('region').count('id as asks').countDistinct('customer_id as customers').groupBy('region').orderBy('asks', 'desc').limit(10)).map((r) => ({ region: r.region, asks: n(r.asks), customers: n(r.customers) }));
  const byDistrict = (await base().whereNotNull('district').select('region', 'district').count('id as asks').groupBy('region', 'district').orderBy('asks', 'desc').limit(10)).map((r) => ({ region: r.region, district: r.district, asks: n(r.asks) }));
  const unmet = (await base().where({ outcome: 'no_match' }).select('product_type').count('id as asks').groupBy('product_type').orderBy('asks', 'desc').limit(5)).map((r) => ({ productType: r.product_type, asks: n(r.asks) }));
  const timing = Object.fromEntries((await base().whereNotNull('purchase_timing').select('purchase_timing').count('id as c').groupBy('purchase_timing')).map((r) => [r.purchase_timing, n(r.c)]));
  const outcomes = Object.fromEntries((await base().whereNotNull('outcome').select('outcome').count('id as c').groupBy('outcome')).map((r) => [r.outcome, n(r.c)]));
  const customers = await base().countDistinct('customer_id as c').first();
  let orders = dbImpl('orders as o').leftJoin('listings as l', 'l.id', 'o.listing_id').where('o.created_at', '>=', since).whereNotIn('o.status', ['rejected', 'cancelled']);
  if (merchantId) orders = orders.where('o.merchant_id', merchantId);
  const bestSellers = (await orders.clone().select('l.name', 'l.product_type').count('o.id as orders').sum('o.quantity as units').sum('o.known_total as revenue').groupBy('l.name', 'l.product_type').orderBy('orders', 'desc').limit(10))
    .map((r) => ({ name: r.name, productType: r.product_type, orders: n(r.orders), units: n(r.units), revenue: n(r.revenue) }));
  const totals = await orders.clone().count('o.id as orders').sum('o.known_total as revenue').first();
  const schedules = await dbImpl('customer_schedules').where({ status: 'scheduled' }).modify((q) => { if (merchantId) q.where({ merchant_id: merchantId }); }).count('id as c').first();
  return { days, since: since.toISOString(), customers: n(customers.c), topProducts, byRegion, byDistrict, unmetDemand: unmet, purchaseTiming: timing, outcomes, bestSellers, orders: { count: n(totals.orders), revenue: n(totals.revenue) }, openSchedules: n(schedules.c) };
}

// The overview in words, from the numbers alone.
export function renderOverview(stats, language = 'sw') {
  const sw = language !== 'en';
  const lines = [];
  lines.push(sw ? `Siku ${stats.days} zilizopita: wateja ${stats.customers} waliuliza bidhaa.` : `Last ${stats.days} days: ${stats.customers} customers asked for products.`);
  if (stats.topProducts.length) lines.push((sw ? 'Zinazoulizwa zaidi: ' : 'Most asked for: ') + stats.topProducts.slice(0, 5).map((p) => `${p.productType} (${p.asks}${p.avgBudget ? `, ${sw ? 'bajeti wastani' : 'avg budget'} ${formatMoney(p.avgBudget, 'TZS')}` : ''})`).join('; ') + '.');
  if (stats.byRegion.length) lines.push((sw ? 'Wanakotoka: ' : 'Where they are: ') + stats.byRegion.slice(0, 5).map((r) => `${r.region} ${r.asks}`).join(', ') + (stats.byDistrict.length ? ` (${stats.byDistrict.slice(0, 3).map((d) => `${d.district} ${d.asks}`).join(', ')})` : '') + '.');
  if (stats.bestSellers.length) lines.push((sw ? 'Zilizouzwa zaidi: ' : 'Best sellers: ') + stats.bestSellers.slice(0, 5).map((b) => `${b.name} (${b.orders} ${sw ? 'oda' : 'orders'})`).join('; ') + '.');
  lines.push(sw ? `Oda ${stats.orders.count}, thamani ${formatMoney(stats.orders.revenue, 'TZS')}.` : `${stats.orders.count} orders worth ${formatMoney(stats.orders.revenue, 'TZS')}.`);
  if (stats.unmetDemand.length) lines.push((sw ? 'Hazikupatikana: ' : 'Not found for customers: ') + stats.unmetDemand.map((u) => `${u.productType} (${u.asks})`).join(', ') + '.');
  if (stats.purchaseTiming.later) lines.push(sw ? `Wateja ${stats.purchaseTiming.later} walisema watanunua baadaye; ratiba zilizo wazi ${stats.openSchedules}.` : `${stats.purchaseTiming.later} customers said they will buy later; ${stats.openSchedules} open schedules.`);
  return lines.join('\n');
}

// Stats plus Muse's reading of them; Muse's words are used only when every number in them is in the stats.
export async function demandOverview({ dbImpl = db, muse = null, merchantId = null, days = 30, language = 'sw' } = {}) {
  const stats = await demandStats({ dbImpl, merchantId, days });
  const fallback = renderOverview(stats, language);
  if (!muse?.enabled) return { stats, summary: fallback, actions: [], source: 'deterministic' };
  const r = await museDemandOverview(muse, { stats, language, merchantId }).catch(() => ({ ok: false, status: 'error' }));
  if (r.ok && r.json?.summary && numbersAreGrounded(r.json.summary, stats)) return { stats, summary: String(r.json.summary).slice(0, 1500), actions: Array.isArray(r.json.actions) ? r.json.actions.slice(0, 5).map(String) : [], source: 'muse' };
  return { stats, summary: fallback, actions: [], source: r.ok ? 'fallback_ungrounded' : `fallback_${r.status}` };
}
