import express from 'express';
import { z } from 'zod';
import { config } from '@moranbuy/core';
import { requireMerchantAuth, requireEntitlement } from '@moranbuy/authorization';
import { offerFollowup, answerFollowupOffer, updateFollowupSettings, followupSettings, listLeads, createLead, stopLead } from '@moranbuy/followup-engine';
import { museSummarizeLeads } from '@moranbuy/muse-intelligence';
import { asyncHandler } from '../middleware/async-handler.js';
import { validate } from '../middleware/validate.js';
import { db } from '../db/connection.js';
import { engagementDeps } from '../services/engagement.js';

export const followupRouter = express.Router();
followupRouter.use(requireMerchantAuth(db));
const actor = (req) => ({ actorId: req.merchantUser.id, ip: req.ip });

// The question, asked before anything is activated or charged.
followupRouter.get('/offer', asyncHandler(async (req, res) => res.json({ ...(await offerFollowup(db, req.merchant.id, { language: req.query.lang === 'en' ? 'en' : 'sw' })), settings: followupSettings(req.merchant) })));
followupRouter.post('/offer/answer', validate({ body: z.object({ accept: z.boolean() }) }), asyncHandler(async (req, res) => res.json(await answerFollowupOffer(db, req.merchant.id, { accept: req.body.accept, appUrl: config().APP_URL, ...actor(req) }))));

// Everything below needs an active, paid follow-up service.
const needFollowup = requireEntitlement(db, 'paid_followup');
followupRouter.get('/settings', needFollowup, (req, res) => res.json({ settings: followupSettings(req.merchant) }));
followupRouter.patch('/settings', needFollowup, validate({ body: z.object({ scheduleHours: z.array(z.number().positive()).min(1).max(5).optional(), maxAttempts: z.number().int().min(1).max(5).optional(), paused: z.boolean().optional(), quietHours: z.object({ from: z.number().int().min(0).max(23), to: z.number().int().min(0).max(23) }).optional() }) }), asyncHandler(async (req, res) => res.json({ settings: await updateFollowupSettings(db, req.merchant.id, { ...req.body, ...actor(req) }) })));
followupRouter.get('/leads', needFollowup, asyncHandler(async (req, res) => {
  const leads = await listLeads(db, req.merchant.id);
  res.json({ leads: leads.map((l) => ({ ...l, phone: `${l.phone.slice(0, 5)}…${l.phone.slice(-2)}` })) });
}));
followupRouter.post('/leads', needFollowup, validate({ body: z.object({ phone: z.string().min(9).max(20), listingId: z.string().uuid().nullable().optional(), statedIntention: z.string().max(500).nullable().optional(), requestedContactAt: z.string().datetime().nullable().optional() }) }), asyncHandler(async (req, res) => {
  const lead = await createLead(db, { merchantId: req.merchant.id, phone: req.body.phone, listingId: req.body.listingId || null, source: 'manual', statedIntention: req.body.statedIntention || null, requestedContactAt: req.body.requestedContactAt || null });
  res.status(201).json({ lead });
}));
followupRouter.post('/leads/:id/stop', needFollowup, validate({ params: z.object({ id: z.string().uuid() }), body: z.object({ reason: z.enum(['converted', 'cancelled', 'declined']) }) }), asyncHandler(async (req, res) => {
  const lead = await db('followup_leads').where({ id: req.params.id, merchant_id: req.merchant.id }).first();
  if (!lead) return res.status(404).json({ error: 'LEAD_NOT_FOUND' });
  res.json({ lead: await stopLead(db, { leadId: lead.id, reason: req.body.reason }) });
}));
followupRouter.post('/leads/summary', needFollowup, asyncHandler(async (req, res) => {
  const leads = (await listLeads(db, req.merchant.id)).slice(0, 50).map((l) => ({ product: l.listing_name, intention: l.stated_intention, state: l.state, attempts: l.attempts, source: l.source }));
  const r = await museSummarizeLeads(engagementDeps().muse, { leads, language: req.query.lang === 'en' ? 'en' : 'sw', merchantId: req.merchant.id });
  res.json({ summary: r.ok ? r.json?.summary || null : null, museStatus: r.status, leads: leads.length });
}));
