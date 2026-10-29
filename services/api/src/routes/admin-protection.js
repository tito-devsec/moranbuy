import express from 'express';
import { z } from 'zod';
import { ApiError, notFound } from '@moranbuy/core';
import { requireAdminAuth } from '@moranbuy/authorization';
import { audit, maskPhone } from '@moranbuy/observability';
import { asyncHandler } from '../middleware/async-handler.js';
import { validate } from '../middleware/validate.js';
import { db } from '../db/connection.js';
import { shoppingDeps } from '../services/shopping.js';
import { engagementDeps } from '../services/engagement.js';
import { loadProtectionSettings, DEFAULT_PROTECTION, resolveDispute, summarizeDispute, sendPayout } from '../services/protection/protection.js';
import { latestReceipt } from '../services/protection/receipts-store.js';
import { proxiedAdmin } from '../middleware/proxied-admin.js';

// Payment protection for administrators: held money, payouts, refunds, disputes with their evidence, strikes and the rules' numbers.
export const adminProtectionRouter = express.Router();
// Each route checks the admin itself; a router-wide check here would also catch /api/admin routes this router does not own.
const signedIn = proxiedAdmin(db);
const read = [signedIn, requireAdminAuth(db)];
const manage = [signedIn, requireAdminAuth(db, 'super_admin', 'admin')];
const superOnly = [signedIn, requireAdminAuth(db, 'super_admin')];
const orderParams = z.object({ orderId: z.string().uuid() });

adminProtectionRouter.get('/protection', read, asyncHandler(async (_req, res) => {
  const rows = await db('order_protection as p').join('orders as o', 'o.id', 'p.order_id').join('merchants as m', 'm.id', 'o.merchant_id').leftJoin('listings as l', 'l.id', 'o.listing_id')
    .orderBy('p.updated_at', 'desc').limit(200).select('p.*', 'o.order_ref', 'o.fulfilment', 'm.business_name', 'l.name as product');
  const byState = await db('order_protection').select('state').sum('amount as amount').count('id as n').groupBy('state');
  const disputes = await db('disputes as d').join('orders as o', 'o.id', 'd.order_id').where('d.status', 'open').orderBy('d.created_at').select('d.*', 'o.order_ref');
  const payouts = await db('payouts').orderBy('created_at', 'desc').limit(100);
  const strikes = await db('strikes').where('created_at', '>=', new Date(Date.now() - 90 * 86400000)).select('subject_type', 'subject_id').count('id as n').groupBy('subject_type', 'subject_id').orderBy('n', 'desc').limit(50);
  res.json({
    totals: byState.map((r) => ({ state: r.state, orders: Number(r.n), amount: Number(r.amount || 0) })),
    held: byState.filter((r) => ['paid_held', 'deliverer_assigned', 'delivered', 'rejection_pending', 'refund_pending', 'disputed'].includes(r.state)).reduce((n, r) => n + Number(r.amount || 0), 0),
    orders: rows.map((r) => ({ ...r, code_hash: undefined, deliverer_phone: maskPhone(r.deliverer_phone) })), disputes, payouts: payouts.map((p) => ({ ...p, phone: maskPhone(p.phone) })), strikes: strikes.map((s) => ({ ...s, n: Number(s.n) })),
    settings: await loadProtectionSettings(),
  });
}));

// One order's full evidence timeline, in order, with the photo uploads an administrator can open.
adminProtectionRouter.get('/protection/:orderId', read, validate({ params: orderParams }), asyncHandler(async (req, res) => {
  const order = await db('orders').where({ id: req.params.orderId }).first();
  if (!order) throw notFound('Order');
  const protection = await db('order_protection').where({ order_id: order.id }).first();
  if (!protection) throw notFound('Protected order');
  const [timeline, disputes, payouts, receipts] = await Promise.all([db('delivery_events').where({ order_id: order.id }).orderBy('id'), db('disputes').where({ order_id: order.id }).orderBy('created_at'), db('payouts').where({ order_id: order.id }), db('receipts').where({ order_id: order.id }).orderBy('version').select('number', 'version', 'status_label', 'check_code', 'created_at')]);
  await audit(db, { actorType: 'admin', actorId: req.admin.id, ip: req.ip, action: 'protection.viewed', targetType: 'order', targetId: order.id });
  res.json({ order, protection: { ...protection, code_hash: undefined }, timeline, disputes, payouts, receipts });
}));

adminProtectionRouter.get('/protection/:orderId/receipt', read, validate({ params: orderParams }), asyncHandler(async (req, res) => {
  const r = await latestReceipt(db, req.params.orderId);
  if (!r?.pdf) throw notFound('Receipt');
  res.json({ receiptNo: r.receiptNo, version: r.version, status: r.status_label, mime: 'application/pdf', base64: r.pdf.toString('base64') });
}));

adminProtectionRouter.post('/disputes/:id/summarize', manage, validate({ params: z.object({ id: z.string().uuid() }) }), asyncHandler(async (req, res) => {
  const r = await summarizeDispute({ muse: shoppingDeps().muse, disputeId: req.params.id });
  res.json({ ok: r.ok, status: r.status || 'ok', summary: r.summary || null, suggestion: r.suggestion || null, why: r.why || null });
}));

// Only a super admin moves disputed money, with a written reason; the decision is audited and told to both sides.
adminProtectionRouter.post('/disputes/:id/resolve', superOnly, validate({ params: z.object({ id: z.string().uuid() }), body: z.object({ decision: z.enum(['release', 'refund']), note: z.string().min(5).max(1000) }) }), asyncHandler(async (req, res) => {
  const out = await resolveDispute({ moran: shoppingDeps().moran, payments: engagementDeps().payments, disputeId: req.params.id, decision: req.body.decision, note: req.body.note, admin: req.admin });
  res.json({ ok: true, payout: out });
}));

adminProtectionRouter.post('/protection/:orderId/payout/retry', superOnly, validate({ params: orderParams, body: z.object({ kind: z.enum(['release', 'refund']), reason: z.string().min(5).max(500) }) }), asyncHandler(async (req, res) => {
  const p = await db('payouts').where({ order_id: req.params.orderId, kind: req.body.kind }).first();
  if (!p || p.status !== 'failed') throw new ApiError(409, 'NOT_FAILED', 'Only a failed payout can be retried.');
  await audit(db, { actorType: 'admin', actorId: req.admin.id, ip: req.ip, action: 'payout.retried', targetType: 'order', targetId: req.params.orderId, after: { kind: req.body.kind }, reason: req.body.reason });
  const order = await db('orders').where({ id: req.params.orderId }).first();
  res.json({ payout: await sendPayout({ moran: shoppingDeps().moran, payments: engagementDeps().payments, order, kind: req.body.kind }) });
}));

const settingsBody = z.object({
  enabled: z.boolean(), commissionPercent: z.number().min(0).max(30), releaseAfterHours: z.number().int().min(12).max(336), paymentExpiryHours: z.number().int().min(1).max(168),
  assignDeadlineHours: z.number().int().min(6).max(336), maxCodeAttempts: z.number().int().min(1).max(10), maxReschedules: z.number().int().min(0).max(5), strikeLimit: z.number().int().min(1).max(20),
  delivererTemplateName: z.string().max(512), delivererTemplateLanguage: z.string().min(2).max(10),
}).partial().extend({ reason: z.string().min(5).max(500) });

adminProtectionRouter.put('/protection/settings', superOnly, validate({ body: settingsBody }), asyncHandler(async (req, res) => {
  const { reason, ...patch } = req.body;
  const before = await loadProtectionSettings();
  const value = { ...before, ...patch };
  await db('platform_settings').insert({ key: 'payment_protection', value: JSON.stringify(value) }).onConflict('key').merge();
  await audit(db, { actorType: 'admin', actorId: req.admin.id, ip: req.ip, action: 'protection.settings_changed', targetType: 'settings', targetId: 'payment_protection', before, after: value, reason });
  res.json({ settings: value, defaults: DEFAULT_PROTECTION });
}));
