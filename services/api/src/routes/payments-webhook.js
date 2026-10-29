import express from 'express';
import { config, ApiError } from '@moranbuy/core';
import { settlePayment, amountValue } from '@moranbuy/billing';
import { logger } from '@moranbuy/observability';
import { asyncHandler } from '../middleware/async-handler.js';
import { db } from '../db/connection.js';
import { engagementDeps } from '../services/engagement.js';
import { shoppingDeps } from '../services/shopping.js';
import { onOrderPaymentSettled, settlePayout } from '../services/protection/protection.js';

// After a payment settles, a protected order moves on (held, receipt and handover code); other purposes need nothing more here.
async function afterSettle(out) {
  if (out?.payment?.purpose === 'order') await onOrderPaymentSettled({ moran: shoppingDeps().moran, payment: out.payment }).catch((err) => logger.error({ err: err.message }, 'Protected order not moved after payment'));
  return out;
}

export const paymentsWebhookRouter = express.Router();

// Snippe's signed webhook; the signature is over the exact raw bytes, and every event id is processed once.
paymentsWebhookRouter.post('/payments', asyncHandler(async (req, res) => {
  const { payments } = engagementDeps();
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
  let event;
  try { event = payments.verifyWebhookAsync ? await payments.verifyWebhookAsync(raw, req.headers['x-webhook-timestamp'], req.headers['x-webhook-signature']) : payments.verifyWebhook(raw, req.headers['x-webhook-timestamp'], req.headers['x-webhook-signature']); } catch (err) { logger.warn({ err: err.message }, 'Payment webhook rejected'); return res.status(400).send('Invalid signature'); }
  res.sendStatus(200);
  // Payouts (a release to a business or a refund to a customer) report back on the same signed webhook.
  if (String(event.type || '').startsWith('payout.') && event.data?.reference) {
    const st = { 'payout.completed': 'completed', 'payout.failed': 'failed', 'payout.reversed': 'reversed' }[event.type];
    const fresh = await db('webhook_events').insert({ source: 'snippe', event_id: event.id || `${event.type}:${event.data.reference}`, event_type: event.type }).onConflict(['source', 'event_id']).ignore().returning('id');
    if (st && fresh.length) await settlePayout({ moran: shoppingDeps().moran, reference: event.data.reference, status: st }).catch((err) => logger.error({ err: err.message }, 'Payout settlement failed'));
    return;
  }
  const status = event.type === 'payment.completed' ? 'completed' : ['payment.failed', 'payment.expired', 'payment.voided'].includes(event.type) ? 'failed' : null;
  if (!status || !event.data?.reference) return;
  await settlePayment(db, { reference: event.data.reference, status, settledAmount: amountValue(event.data.amount), eventId: event.id || `${event.type}:${event.data.reference}`, source: 'snippe' }).then(afterSettle).catch((err) => logger.error({ err: err.message }, 'Payment settlement failed'));
}));

// Outside production, the sandbox provider is settled by this explicit call so the whole flow can be exercised honestly.
export const sandboxRouter = express.Router();
sandboxRouter.post('/payments/:reference/settle', asyncHandler(async (req, res) => {
  if (config().APP_ENV === 'production') throw new ApiError(404, 'NOT_FOUND', 'Not available.');
  const status = req.body?.status === 'failed' ? 'failed' : 'completed';
  const out = await afterSettle(await settlePayment(db, { reference: req.params.reference, status, settledAmount: req.body?.amount ?? null, eventId: `sandbox:${req.params.reference}:${status}:${req.body?.attempt || 1}`, source: 'sandbox' }));
  res.json(out);
}));
