import express from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { asyncHandler } from '../middleware/async-handler.js';
import { validate } from '../middleware/validate.js';
import { shoppingDeps, upsertCustomer } from '../services/shopping.js';
import { db } from '../db/connection.js';
import { notFound } from '@moranbuy/core';
import { termsGate } from '../services/terms.js';

export const shopRouter = express.Router();

const messageBody = z.object({
  customerToken: z.string().min(8).max(80).optional(),
  text: z.string().max(2000).default(''),
  imageUrl: z.string().url().max(600).optional(),
  location: z.object({ lat: z.number(), lng: z.number(), label: z.string().max(200).optional() }).optional(),
  language: z.enum(['sw', 'en']).optional(),
  acceptTerms: z.boolean().optional(),
  rejectTerms: z.boolean().optional(),
});

// The web customer experience: one message in, the engine's replies out; the customer token keeps the session.
shopRouter.post('/messages', validate({ body: messageBody }), asyncHandler(async (req, res) => {
  const token = req.body.customerToken || crypto.randomBytes(16).toString('hex');
  const customer = await upsertCustomer({ channel: 'web', channelRef: token, language: req.body.language || null });
  const gate = await termsGate({ customer, text: req.body.rejectTerms ? 'decline' : '', channel: 'web', acceptTerms: !!req.body.acceptTerms });
  if (!gate.pass && !(gate.accepted && (req.body.text || req.body.imageUrl || req.body.location))) return res.json({ customerToken: token, state: gate.accepted ? 'terms_accepted' : gate.rejected ? 'terms_rejected' : 'terms_required', replies: gate.replies.map((r) => ({ text: r.text })), terms: gate.terms || null });
  const { engine } = shoppingDeps();
  const out = await engine.handleMessage({ customer, text: req.body.text, imageUrl: req.body.imageUrl || null, sharedLocation: req.body.location || null });
  res.json({ customerToken: token, sessionId: out.session.id, state: out.session.state, replies: out.replies, runId: out.run?.id || null, orderRef: out.orderRef || null, museStatus: out.museStatus || null });
}));

// The evidence behind one matching run: the request, policy, every ranked offer with its reasons, and the exclusions.
shopRouter.get('/runs/:id', asyncHandler(async (req, res) => {
  const run = await db('matching_runs').where({ id: req.params.id }).first();
  if (!run) throw notFound('RUN_NOT_FOUND');
  const offers = await db('matching_offers').where({ run_id: run.id }).orderBy([{ column: 'group', order: 'desc' }, { column: 'rank', order: 'asc' }]);
  res.json({ run, offers });
}));

// Customer-visible order status by reference.
shopRouter.get('/orders/:ref', asyncHandler(async (req, res) => {
  const order = await db('orders as o').join('merchants as m', 'm.id', 'o.merchant_id').where('o.order_ref', req.params.ref).first('o.order_ref', 'o.status', 'o.known_total', 'o.total_confirmed', 'o.currency', 'o.fulfilment', 'o.created_at', 'm.business_name');
  if (!order) throw notFound('ORDER_NOT_FOUND');
  res.json({ order });
}));
