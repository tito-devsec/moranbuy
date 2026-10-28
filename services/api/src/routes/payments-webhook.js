import express from 'express';
import { config, ApiError } from '@moranbuy/core';
import { settlePayment } from '@moranbuy/billing';
import { logger } from '@moranbuy/observability';
import { asyncHandler } from '../middleware/async-handler.js';
import { db } from '../db/connection.js';
import { engagementDeps } from '../services/engagement.js';

export const paymentsWebhookRouter = express.Router();

// Snippe's signed webhook; the signature is over the exact raw bytes, and every event id is processed once.
paymentsWebhookRouter.post('/payments', asyncHandler(async (req, res) => {
  const { payments } = engagementDeps();
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
  let event;
  try { event = payments.verifyWebhookAsync ? await payments.verifyWebhookAsync(raw, req.headers['x-webhook-timestamp'], req.headers['x-webhook-signature']) : payments.verifyWebhook(raw, req.headers['x-webhook-timestamp'], req.headers['x-webhook-signature']); } catch (err) { logger.warn({ err: err.message }, 'Payment webhook rejected'); return res.status(400).send('Invalid signature'); }
  res.sendStatus(200);
  const status = event.type === 'payment.completed' ? 'completed' : ['payment.failed', 'payment.expired', 'payment.voided'].includes(event.type) ? 'failed' : null;
  if (!status || !event.data?.reference) return;
  await settlePayment(db, { reference: event.data.reference, status, settledAmount: event.data.amount ?? null, eventId: event.id || `${event.type}:${event.data.reference}`, source: 'snippe' }).catch((err) => logger.error({ err: err.message }, 'Payment settlement failed'));
}));

// Outside production, the sandbox provider is settled by this explicit call so the whole flow can be exercised honestly.
export const sandboxRouter = express.Router();
sandboxRouter.post('/payments/:reference/settle', asyncHandler(async (req, res) => {
  if (config().APP_ENV === 'production') throw new ApiError(404, 'NOT_FOUND', 'Not available.');
  const status = req.body?.status === 'failed' ? 'failed' : 'completed';
  const out = await settlePayment(db, { reference: req.params.reference, status, settledAmount: req.body?.amount ?? null, eventId: `sandbox:${req.params.reference}:${status}:${req.body?.attempt || 1}`, source: 'sandbox' });
  res.json(out);
}));
