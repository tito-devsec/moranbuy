import express from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { ApiError, notFound, config } from '@moranbuy/core';
import { requireAdminAuth, signAccessToken, issueRefreshToken, rotateRefreshToken, verifyPassword, activateEntitlement, pauseEntitlement, listEntitlements, SERVICES } from '@moranbuy/authorization';
import { publicMerchant } from '@moranbuy/merchant-management';
import { listListings, listLocations, pullMoranListings } from '@moranbuy/product-catalog';
import { museTelemetry } from '@moranbuy/muse-intelligence';
import { consentHistory, consentState, toMsisdn } from '@moranbuy/consent-management';
import { publicCampaign, publicTemplate } from '@moranbuy/campaign-engine';
import { DEFAULT_POLICY } from '@moranbuy/budget-matching';
import { DEFAULT_PRICING } from '@moranbuy/billing';
import { audit, redact, maskPhone } from '@moranbuy/observability';
import { asyncHandler } from '../middleware/async-handler.js';
import { validate } from '../middleware/validate.js';
import { db } from '../db/connection.js';
import { checkDbConnection } from '../db/connection.js';
import { checkRedisConnection } from '../db/redis.js';
import { shoppingDeps } from '../services/shopping.js';
import { engagementDeps } from '../services/engagement.js';
import { merchantDeps } from '../services/merchants.js';
import { describeCredentials, saveCredentials, CREDENTIAL_FIELDS } from '../services/runtime-settings.js';
import { proxiedAdmin } from '../middleware/proxied-admin.js';
import { loadOrderAlertSettings, renderOrderAlert, DEFAULT_ORDER_ALERT } from '../services/merchant-notify.js';

export const adminRouter = express.Router();
const idParams = z.object({ id: z.string().uuid() });
const reason = z.string().max(500).optional();

// ---- sign-in (failed attempts limited per account) ----
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, max: 10, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => `admin:${String(req.body?.email || '').toLowerCase()}` });
adminRouter.post('/auth/login', loginLimiter, validate({ body: z.object({ email: z.string().max(255), password: z.string().min(1) }) }), asyncHandler(async (req, res) => {
  const admin = await db('admin_users').where({ email: String(req.body.email).toLowerCase() }).first();
  if (!admin || !admin.is_active || !(await verifyPassword(req.body.password, admin.password_hash))) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is not correct.');
  await db('admin_users').where({ id: admin.id }).update({ last_login_at: db.fn.now() });
  await audit(db, { actorType: 'admin', actorId: admin.id, action: 'admin.login', ip: req.ip });
  res.json({ accessToken: signAccessToken({ type: 'admin', sub: admin.id, role: admin.role, email: admin.email }), refreshToken: await issueRefreshToken(db, { subjectType: 'admin', subjectId: admin.id }), admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role } });
}));
adminRouter.post('/auth/refresh', validate({ body: z.object({ refreshToken: z.string().min(20) }) }), asyncHandler(async (req, res) => {
  const rotated = await rotateRefreshToken(db, req.body.refreshToken);
  if (!rotated || rotated.subjectType !== 'admin') throw new ApiError(401, 'INVALID_REFRESH_TOKEN', 'Sign in again.');
  const admin = await db('admin_users').where({ id: rotated.subjectId }).first();
  if (!admin?.is_active) throw new ApiError(401, 'INVALID_REFRESH_TOKEN', 'Sign in again.');
  res.json({ accessToken: signAccessToken({ type: 'admin', sub: admin.id, role: admin.role, email: admin.email }), refreshToken: rotated.refreshToken });
}));

adminRouter.use(proxiedAdmin(db), requireAdminAuth(db));
const manage = requireAdminAuth(db, 'super_admin', 'admin');
const act = (req, extra) => audit(db, { actorType: 'admin', actorId: req.admin.id, ip: req.ip, ...extra });

adminRouter.get('/me', (req, res) => res.json({ admin: { id: req.admin.id, name: req.admin.name, email: req.admin.email, role: req.admin.role } }));

// ---- overview ----
adminRouter.get('/overview', asyncHandler(async (_req, res) => {
  const count = async (table, where = {}) => Number((await db(table).where(where).count('id as n').first()).n);
  const since = new Date(Date.now() - 24 * 3600000);
  res.json({
    merchants: { total: await count('merchants'), standalone: await count('merchants', { registration_type: 'standalone' }), moran: await count('merchants', { registration_type: 'moran' }), pendingVerification: await count('merchants', { verification_status: 'pending' }), suspended: await count('merchants', { status: 'suspended' }) },
    listings: { active: await count('listings', { status: 'active' }), moran: await count('listings', { source: 'moran' }) },
    shopping: { runs24h: Number((await db('matching_runs').where('created_at', '>=', since).count('id as n').first()).n), noneWithinBudget24h: Number((await db('matching_runs').where('created_at', '>=', since).where({ none_within_budget: true }).count('id as n').first()).n), orders: await count('orders'), pendingOrders: await count('orders', { status: 'pending_merchant' }) },
    campaigns: { total: await count('campaigns'), dispatching: await count('campaigns', { status: 'dispatching' }), completed: await count('campaigns', { status: 'completed' }) },
    followup: { openLeads: Number((await db('followup_leads').whereIn('state', ['scheduled', 'contacted']).count('id as n').first()).n) },
    payments: { pending: await count('payments', { status: 'pending' }), completed: await count('payments', { status: 'completed' }) },
    muse: await museTelemetry(db, { sinceHours: 24 }),
    flags: { campaignDryRun: config().CAMPAIGN_DRY_RUN, followupDryRun: config().FOLLOWUP_DRY_RUN, paymentProvider: config().PAYMENT_PROVIDER, museProvider: config().MUSE_PROVIDER, webResearch: config().MORANBUY_WEB_RESEARCH_ENABLED },
  });
}));

// ---- merchants ----
adminRouter.get('/merchants', validate({ query: z.object({ type: z.enum(['standalone', 'moran']).optional(), status: z.string().max(16).optional(), verification: z.string().max(16).optional(), search: z.string().max(80).optional() }).passthrough() }), asyncHandler(async (req, res) => {
  let q = db('merchants').orderBy('created_at', 'desc').limit(500);
  if (req.query.type) q = q.where({ registration_type: req.query.type });
  if (req.query.status) q = q.where({ status: req.query.status });
  if (req.query.verification) q = q.where({ verification_status: req.query.verification });
  if (req.query.search) q = q.whereILike('business_name', `%${req.query.search}%`);
  const rows = await q;
  const ents = rows.length ? await db('merchant_entitlements').whereIn('merchant_id', rows.map((r) => r.id)) : [];
  const counts = rows.length ? await db('listings').whereIn('merchant_id', rows.map((r) => r.id)).whereNull('deleted_at').select('merchant_id').count('id as n').groupBy('merchant_id') : [];
  res.json({ merchants: rows.map((m) => ({ ...publicMerchant(m), entitlements: ents.filter((e) => e.merchant_id === m.id).map((e) => ({ service: e.service, status: e.status, billingState: e.billing_state })), listings: Number(counts.find((c) => c.merchant_id === m.id)?.n || 0) })) });
}));

adminRouter.get('/merchants/:id', validate({ params: idParams }), asyncHandler(async (req, res) => {
  const m = await db('merchants').where({ id: req.params.id }).first();
  if (!m) throw notFound('MERCHANT_NOT_FOUND');
  const [entitlements, listings, locations, campaigns, leads, payments, orders, users] = await Promise.all([
    listEntitlements(db, m.id), listListings(db, m.id, { includeArchived: true }), listLocations(db, m.id),
    db('campaigns').where({ merchant_id: m.id }).orderBy('created_at', 'desc').limit(50), db('followup_leads').where({ merchant_id: m.id }).orderBy('created_at', 'desc').limit(50),
    db('payments').where({ merchant_id: m.id }).orderBy('created_at', 'desc').limit(50), db('orders').where({ merchant_id: m.id }).orderBy('created_at', 'desc').limit(50),
    db('merchant_users').where({ merchant_id: m.id }).select('id', 'email', 'name', 'role', 'is_active', 'last_login_at'),
  ]);
  res.json({ merchant: { ...publicMerchant(m), verification: m.verification_json, statusReason: m.status_reason, settings: redact(m.settings_json) }, users, entitlements, listings, locations, campaigns: campaigns.map((c) => publicCampaign(c)), followup: { settings: m.settings_json?.followup || null, leads: leads.map((l) => ({ ...l, phone: maskPhone(l.phone) })) }, payments, orders });
}));

adminRouter.post('/merchants/:id/verification', manage, validate({ params: idParams, body: z.object({ decision: z.enum(['verified', 'rejected']), reason }) }), asyncHandler(async (req, res) => {
  const m = await db('merchants').where({ id: req.params.id }).first();
  if (!m) throw notFound('MERCHANT_NOT_FOUND');
  const [row] = await db('merchants').where({ id: m.id }).update({ verification_status: req.body.decision, updated_at: db.fn.now() }).returning('*');
  await act(req, { merchantId: m.id, action: 'merchant.verification_decided', targetType: 'merchant', targetId: m.id, before: { verificationStatus: m.verification_status }, after: { verificationStatus: req.body.decision }, reason: req.body.reason });
  res.json({ merchant: publicMerchant(row) });
}));

adminRouter.post('/merchants/:id/status', manage, validate({ params: idParams, body: z.object({ status: z.enum(['active', 'suspended', 'closed']), reason: z.string().min(3).max(500) }) }), asyncHandler(async (req, res) => {
  const m = await db('merchants').where({ id: req.params.id }).first();
  if (!m) throw notFound('MERCHANT_NOT_FOUND');
  const [row] = await db('merchants').where({ id: m.id }).update({ status: req.body.status, status_reason: req.body.reason, updated_at: db.fn.now() }).returning('*');
  if (req.body.status !== 'active') await db('campaigns').where({ merchant_id: m.id, status: 'dispatching' }).update({ status: 'paused' });
  await act(req, { merchantId: m.id, action: 'merchant.status_changed', targetType: 'merchant', targetId: m.id, before: { status: m.status }, after: { status: req.body.status }, reason: req.body.reason });
  res.json({ merchant: publicMerchant(row) });
}));

// Entitlements: activation is an audited admin decision (or a verified payment), never automatic.
adminRouter.post('/merchants/:id/entitlements/:service', manage, validate({ params: idParams.extend({ service: z.enum(SERVICES) }), body: z.object({ action: z.enum(['activate', 'pause', 'cancel']), billingState: z.enum(['paid', 'free']).optional(), expiresAt: z.string().datetime().nullable().optional(), limits: z.record(z.number()).optional(), reason: z.string().min(3).max(500) }) }), asyncHandler(async (req, res) => {
  const m = await db('merchants').where({ id: req.params.id }).first();
  if (!m) throw notFound('MERCHANT_NOT_FOUND');
  if (req.params.service === 'conversation_agent' && m.registration_type !== 'moran') throw new ApiError(409, 'MORAN_REQUIRED', 'The conversation agent is a Moran AI service.');
  const exists = await db('merchant_entitlements').where({ merchant_id: m.id, service: req.params.service }).first();
  if (!exists) await db('merchant_entitlements').insert({ merchant_id: m.id, service: req.params.service, status: 'selected', billing_state: 'unpaid' });
  const row = req.body.action === 'activate'
    ? await activateEntitlement(db, m.id, req.params.service, { billingState: req.body.billingState || 'paid', actor: `admin:${req.admin.id}`, expiresAt: req.body.expiresAt || null, limits: req.body.limits || {} })
    : await pauseEntitlement(db, m.id, req.params.service, { status: req.body.action === 'cancel' ? 'cancelled' : 'paused' });
  await act(req, { merchantId: m.id, action: `entitlement.${req.body.action}`, targetType: 'entitlement', targetId: row.id, before: exists ? { status: exists.status, billingState: exists.billing_state } : null, after: { status: row.status, billingState: row.billing_state }, reason: req.body.reason });
  res.json({ entitlement: row });
}));

// ---- ranking evidence and policy ----
adminRouter.get('/ranking/runs', asyncHandler(async (_req, res) => res.json({ runs: await db('matching_runs').orderBy('created_at', 'desc').limit(100) })));
adminRouter.get('/ranking/runs/:id', validate({ params: idParams }), asyncHandler(async (req, res) => {
  const run = await db('matching_runs').where({ id: req.params.id }).first();
  if (!run) throw notFound('RUN_NOT_FOUND');
  const offers = await db('matching_offers as o').leftJoin('listings as l', 'l.id', 'o.listing_id').leftJoin('merchants as m', 'm.id', 'o.merchant_id').where('o.run_id', run.id).orderBy([{ column: 'o.group', order: 'desc' }, { column: 'o.rank', order: 'asc' }]).select('o.*', 'l.name as listing_name', 'm.business_name');
  res.json({ run, offers });
}));
adminRouter.get('/ranking/policy', asyncHandler(async (_req, res) => {
  const row = await db('platform_settings').where({ key: 'ranking_policy' }).first();
  res.json({ defaults: DEFAULT_POLICY, overrides: row?.value || {}, effective: { ...DEFAULT_POLICY, ...(row?.value || {}) }, updatedBy: row?.updated_by || null, updatedAt: row?.updated_at || null });
}));
// Only the tuning values may change; the budget-first order itself is code, and every change is audited with a reason.
adminRouter.put('/ranking/policy', manage, validate({ body: z.object({ priceSimilarityPct: z.number().min(0).max(20).optional(), priceSimilarityMin: z.number().int().min(0).optional(), staleAfterDays: z.number().int().min(1).max(365).optional(), suspiciousBelowMedianPct: z.number().min(0).max(90).optional(), overBudgetShowPct: z.number().min(0).max(100).optional(), reason: z.string().min(5).max(500) }) }), asyncHandler(async (req, res) => {
  const { reason: why, ...overrides } = req.body;
  const before = (await db('platform_settings').where({ key: 'ranking_policy' }).first())?.value || {};
  await db('platform_settings').insert({ key: 'ranking_policy', value: JSON.stringify(overrides), updated_by: req.admin.email, updated_at: db.fn.now() }).onConflict('key').merge();
  await act(req, { action: 'ranking.policy_changed', targetType: 'settings', targetId: 'ranking_policy', before, after: overrides, reason: why });
  res.json({ effective: { ...DEFAULT_POLICY, ...overrides } });
}));

// ---- consent ----
adminRouter.get('/consent/:phone', asyncHandler(async (req, res) => {
  const phone = toMsisdn(req.params.phone);
  const history = await consentHistory(db, { phone });
  const merchants = [...new Set(history.map((h) => h.merchant_id).filter(Boolean))];
  const states = [];
  for (const mid of merchants) states.push({ merchantId: mid, marketing: (await consentState(db, { merchantId: mid, phone, purpose: 'marketing' })).reason, followup: (await consentState(db, { merchantId: mid, phone, purpose: 'followup' })).reason });
  await act(req, { action: 'consent.looked_up', targetType: 'phone', targetId: maskPhone(phone) });
  res.json({ phone: maskPhone(phone), globalOptOut: history.some((h) => h.merchant_id === null && h.purpose === 'all' && h.status === 'revoked'), states, history: history.map((h) => ({ merchantId: h.merchant_id, purpose: h.purpose, status: h.status, source: h.source, evidenceRef: h.evidence_ref, at: h.created_at })) });
}));

// ---- campaigns, templates, follow-up, orders, payments ----
adminRouter.get('/campaigns', asyncHandler(async (_req, res) => {
  const rows = await db('campaigns as c').join('merchants as m', 'm.id', 'c.merchant_id').orderBy('c.created_at', 'desc').limit(200).select('c.*', 'm.business_name');
  res.json({ campaigns: rows.map((r) => publicCampaign(r, { businessName: r.business_name })) });
}));
adminRouter.get('/campaigns/:id', validate({ params: idParams }), asyncHandler(async (req, res) => {
  const c = await db('campaigns').where({ id: req.params.id }).first();
  if (!c) throw notFound('CAMPAIGN_NOT_FOUND');
  const recipients = await db('campaign_recipients').where({ campaign_id: c.id }).orderBy('updated_at', 'desc').limit(500);
  res.json({ campaign: publicCampaign(c), recipients: recipients.map((r) => ({ ...r, phone: maskPhone(r.phone) })), payment: c.payment_id ? await db('payments').where({ id: c.payment_id }).first() : null });
}));
adminRouter.post('/campaigns/:id/pause', manage, validate({ params: idParams, body: z.object({ reason: z.string().min(3).max(500) }) }), asyncHandler(async (req, res) => {
  const c = await db('campaigns').where({ id: req.params.id }).first();
  if (!c) throw notFound('CAMPAIGN_NOT_FOUND');
  const [row] = await db('campaigns').where({ id: c.id }).update({ status: 'paused', updated_at: db.fn.now() }).returning('*');
  await act(req, { merchantId: c.merchant_id, action: 'campaign.admin_paused', targetType: 'campaign', targetId: c.id, before: { status: c.status }, after: { status: 'paused' }, reason: req.body.reason });
  res.json({ campaign: publicCampaign(row) });
}));
adminRouter.get('/templates', asyncHandler(async (_req, res) => res.json({ templates: (await db('message_templates').orderBy('updated_at', 'desc').limit(200)).map(publicTemplate) })));
adminRouter.get('/followup', asyncHandler(async (_req, res) => {
  const leads = await db('followup_leads as l').join('merchants as m', 'm.id', 'l.merchant_id').orderBy('l.updated_at', 'desc').limit(200).select('l.*', 'm.business_name');
  const tasks = await db('followup_tasks').orderBy('due_at', 'desc').limit(200);
  res.json({ leads: leads.map((l) => ({ ...l, phone: maskPhone(l.phone) })), tasks });
}));
adminRouter.get('/orders', asyncHandler(async (_req, res) => {
  const rows = await db('orders as o').join('merchants as m', 'm.id', 'o.merchant_id').leftJoin('listings as l', 'l.id', 'o.listing_id').orderBy('o.created_at', 'desc').limit(200).select('o.*', 'm.business_name', 'l.name as listing_name');
  res.json({ orders: rows, enquiries: await db('enquiries').orderBy('created_at', 'desc').limit(200) });
}));
adminRouter.get('/payments', asyncHandler(async (_req, res) => res.json({ payments: await db('payments as p').join('merchants as m', 'm.id', 'p.merchant_id').orderBy('p.created_at', 'desc').limit(200).select('p.*', 'm.business_name') })));
// A refund is recorded here; the money itself moves at the provider and is reconciled by the admin.
adminRouter.post('/payments/:id/refund', manage, validate({ params: idParams, body: z.object({ amount: z.number().int().positive(), providerReference: z.string().max(120).optional(), reason: z.string().min(3).max(500) }) }), asyncHandler(async (req, res) => {
  const p = await db('payments').where({ id: req.params.id }).first();
  if (!p) throw notFound('PAYMENT_NOT_FOUND');
  if (p.status !== 'completed') throw new ApiError(409, 'NOT_COMPLETED', 'Only a completed payment can be refunded.');
  if (req.body.amount > p.amount) throw new ApiError(400, 'VALIDATION_ERROR', 'Refund exceeds the payment.');
  const [row] = await db('payments').where({ id: p.id }).update({ status: 'refunded', provider_json: db.raw('provider_json || ?::jsonb', [JSON.stringify({ refund: { amount: req.body.amount, providerReference: req.body.providerReference || null, by: req.admin.email, at: new Date().toISOString() } })]) }).returning('*');
  await act(req, { merchantId: p.merchant_id, action: 'payment.refund_recorded', targetType: 'payment', targetId: p.id, after: { amount: req.body.amount }, reason: req.body.reason });
  res.json({ payment: row });
}));
adminRouter.get('/pricing', asyncHandler(async (_req, res) => { const row = await db('platform_settings').where({ key: 'campaign_pricing' }).first(); res.json({ defaults: DEFAULT_PRICING, overrides: row?.value || {}, effective: { ...DEFAULT_PRICING, ...(row?.value || {}) } }); }));
adminRouter.put('/pricing', manage, validate({ body: z.object({ providerUnitTzs: z.number().nonnegative().nullable().optional(), serviceFeeUnitTzs: z.number().nonnegative().optional(), serviceFeeMinTzs: z.number().nonnegative().optional(), taxPct: z.number().min(0).max(50).optional(), reason: z.string().min(5).max(500) }) }), asyncHandler(async (req, res) => {
  const { reason: why, ...overrides } = req.body;
  const before = (await db('platform_settings').where({ key: 'campaign_pricing' }).first())?.value || {};
  await db('platform_settings').insert({ key: 'campaign_pricing', value: JSON.stringify(overrides), updated_by: req.admin.email, updated_at: db.fn.now() }).onConflict('key').merge();
  await act(req, { action: 'pricing.changed', targetType: 'settings', targetId: 'campaign_pricing', before, after: overrides, reason: why });
  res.json({ effective: { ...DEFAULT_PRICING, ...overrides } });
}));

// ---- Muse Spark, integrations, audit ----
adminRouter.get('/muse', asyncHandler(async (req, res) => {
  const { muse } = shoppingDeps();
  res.json({ status: muse.status(), telemetry: await museTelemetry(db, { sinceHours: Number(req.query.hours) || 24 }), recent: await db('muse_requests').orderBy('id', 'desc').limit(50) });
}));
adminRouter.post('/muse/test', manage, asyncHandler(async (req, res) => {
  const out = await shoppingDeps().muse.testConnection();
  await act(req, { action: 'muse.test_connection', targetType: 'muse', targetId: out.model, after: { result: out.result, code: out.code } });
  res.json(out);
}));
adminRouter.get('/integrations', asyncHandler(async (_req, res) => {
  const c = config();
  const checks = {};
  try { checks.database = (await checkDbConnection()) ? 'ok' : 'failed'; } catch (err) { checks.database = `failed: ${err.code || err.message}`; }
  try { checks.redis = (await checkRedisConnection()) ? 'ok' : 'failed'; } catch (err) { checks.redis = `failed: ${err.code || err.message}`; }
  const lastInbound = await db('webhook_events').where({ source: 'moran' }).orderBy('received_at', 'desc').first('received_at', 'status');
  const lastPayment = await db('webhook_events').whereIn('source', ['snippe', 'sandbox']).orderBy('received_at', 'desc').first('received_at', 'status', 'source');
  res.json({
    checks,
    moran: { baseUrl: c.MORAN_BACKEND_BASE_URL || null, sharedSecretConfigured: !!c.MORAN_SHARED_SECRET, ownerClientConfigured: merchantDeps().moran.configured, internalClientConfigured: shoppingDeps().moran?.configured ?? false, lastInbound: lastInbound || null },
    payments: { provider: engagementDeps().payments.name, lastWebhook: lastPayment || null },
    muse: shoppingDeps().muse.status(),
    research: { enabled: c.MORANBUY_WEB_RESEARCH_ENABLED, provider: shoppingDeps().researcher?.name || null, allowedDomains: c.MORANBUY_ALLOWED_DOMAINS ? c.MORANBUY_ALLOWED_DOMAINS.split(',') : [] },
    flags: { campaignDryRun: c.CAMPAIGN_DRY_RUN, followupDryRun: c.FOLLOWUP_DRY_RUN },
    moranListingsSync: (await db('platform_settings').where({ key: 'moran_listings_sync' }).first())?.value || { lastRunAt: null },
  });
}));
// Pulls opted-in Moran businesses and products now instead of waiting for the worker.
adminRouter.post('/sync/moran-listings', manage, validate({ body: z.object({ full: z.boolean().optional() }).optional() }), asyncHandler(async (req, res) => {
  const out = await pullMoranListings(db, shoppingDeps().moran, { full: !!req.body?.full });
  await act(req, { action: 'moran.listings_pull_requested', targetType: 'sync', targetId: 'moran_listings', after: out });
  res.json(out);
}));
adminRouter.get('/audit', validate({ query: z.object({ merchantId: z.string().uuid().optional(), action: z.string().max(80).optional() }).passthrough() }), asyncHandler(async (req, res) => {
  let q = db('audit_events').orderBy('id', 'desc').limit(300);
  if (req.query.merchantId) q = q.where({ merchant_id: req.query.merchantId });
  if (req.query.action) q = q.whereILike('action', `${req.query.action}%`);
  res.json({ events: await q });
}));
// ---- credentials entered by an administrator: Muse Spark, Snippe, Hermes; stored encrypted, shown masked, used at once ----
adminRouter.get('/credentials', asyncHandler(async (_req, res) => res.json({ credentials: await describeCredentials({ fresh: true }) })));
const credentialBodies = {
  muse: z.object({ provider: z.enum(['meta', 'openai-compatible', 'disabled']).optional(), baseUrl: z.string().url().optional(), apiKey: z.string().max(400).optional(), model: z.string().max(64).optional(), reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).optional(), reason: z.string().min(3).max(500) }),
  snippe: z.object({ apiKey: z.string().max(400).optional(), webhookSecret: z.string().max(400).optional(), baseUrl: z.string().url().optional(), reason: z.string().min(3).max(500) }),
  hermes: z.object({ baseUrl: z.union([z.string().url(), z.literal('')]).optional(), apiKey: z.string().max(400).optional(), model: z.string().max(64).optional(), enabled: z.boolean().optional(), allowedDomains: z.string().max(2000).optional(), reason: z.string().min(3).max(500) }),
};
adminRouter.put('/credentials/:group', requireAdminAuth(db, 'super_admin'), validate({ params: z.object({ group: z.enum(Object.keys(CREDENTIAL_FIELDS)) }) }), asyncHandler(async (req, res) => {
  const body = credentialBodies[req.params.group].parse(req.body || {});
  const { reason: why, ...patch } = body;
  await saveCredentials(req.params.group, patch, { updatedBy: req.admin.email });
  await act(req, { action: `credentials.${req.params.group}_updated`, targetType: 'settings', targetId: 'credentials', after: { fields: Object.keys(patch) }, reason: why });
  res.json({ credentials: await describeCredentials({ fresh: true }) });
}));

// ---- the name MoranBuy appears under in conversations, chosen in Super Admin after the number is connected ----
adminRouter.get('/agent-profile', asyncHandler(async (_req, res) => { const row = await db('platform_settings').where({ key: 'agent_profile' }).first(); res.json({ profile: { name: 'MoranBuy', greetingSw: null, greetingEn: null, ...(row?.value || {}) } }); }));
adminRouter.put('/agent-profile', manage, validate({ body: z.object({ name: z.string().trim().min(2).max(60), greetingSw: z.string().max(300).nullable().optional(), greetingEn: z.string().max(300).nullable().optional(), reason: z.string().min(3).max(500) }) }), asyncHandler(async (req, res) => {
  const { reason: why, ...profile } = req.body;
  const before = (await db('platform_settings').where({ key: 'agent_profile' }).first())?.value || {};
  await db('platform_settings').insert({ key: 'agent_profile', value: JSON.stringify(profile), updated_by: req.admin.email, updated_at: db.fn.now() }).onConflict('key').merge();
  await act(req, { action: 'agent_profile.changed', targetType: 'settings', targetId: 'agent_profile', before, after: profile, reason: why });
  res.json({ profile });
}));

// ---- the message business owners get when an order is confirmed; wording and template set here ----
adminRouter.get('/notifications/order-confirmed', asyncHandler(async (_req, res) => {
  const settings = await loadOrderAlertSettings();
  const sample = { order_ref: 'MB-7K2P9Q', product: 'Sofa ya watu watatu', quantity: 1, total: 'TSh 305,000', fulfilment: 'delivery', customer_phone: '+2557…78', customer_location: ', Sinza, Dar es Salaam', merchant: 'Duka la Mfano', reply_hint: 'Jibu KUBALI MB-7K2P9Q au KATAA MB-7K2P9Q.' };
  res.json({ settings, defaults: DEFAULT_ORDER_ALERT, preview: { sw: renderOrderAlert(settings.textSw, sample), en: renderOrderAlert(settings.textEn, sample) }, placeholders: Object.keys(sample), recent: await db('merchant_notifications as n').join('merchants as m', 'm.id', 'n.merchant_id').orderBy('n.created_at', 'desc').limit(50).select('n.*', 'm.business_name') });
}));
adminRouter.put('/notifications/order-confirmed', manage, validate({ body: z.object({ enabled: z.boolean().optional(), templateName: z.string().max(120).regex(/^[a-z0-9_]*$/).optional(), templateLanguage: z.string().max(8).optional(), textSw: z.string().min(10).max(1000).optional(), textEn: z.string().min(10).max(1000).optional(), templateParams: z.array(z.string().max(30)).max(10).optional(), reason: z.string().min(3).max(500) }) }), asyncHandler(async (req, res) => {
  const { reason: why, ...patch } = req.body;
  const before = await loadOrderAlertSettings();
  const next = { ...before, ...patch };
  await db('platform_settings').insert({ key: 'notification_order_confirmed', value: JSON.stringify(next), updated_by: req.admin.email, updated_at: db.fn.now() }).onConflict('key').merge();
  await act(req, { action: 'notifications.order_confirmed_changed', targetType: 'settings', targetId: 'notification_order_confirmed', before, after: next, reason: why });
  res.json({ settings: next });
}));

adminRouter.get('/settings', asyncHandler(async (_req, res) => res.json({ settings: await db('platform_settings').orderBy('key'), admins: await db('admin_users').select('id', 'email', 'name', 'role', 'is_active', 'last_login_at') })));
adminRouter.post('/admins', requireAdminAuth(db, 'super_admin'), validate({ body: z.object({ email: z.string().email(), name: z.string().min(2).max(120), password: z.string().min(12).max(128), role: z.enum(['super_admin', 'admin', 'support']).default('admin') }) }), asyncHandler(async (req, res) => {
  const { hashPassword } = await import('@moranbuy/authorization');
  const [row] = await db('admin_users').insert({ email: req.body.email.toLowerCase(), name: req.body.name, password_hash: await hashPassword(req.body.password), role: req.body.role }).returning(['id', 'email', 'name', 'role']);
  await act(req, { action: 'admin.created', targetType: 'admin', targetId: row.id, after: { email: row.email, role: row.role } });
  res.status(201).json({ admin: row });
}));
