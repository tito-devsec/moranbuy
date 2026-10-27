import express from 'express';
import { z } from 'zod';
import { ApiError } from '@moranbuy/core';
import { requireMerchantAuth, requireEntitlement } from '@moranbuy/authorization';
import { moranAccessTokenFor } from '@moranbuy/merchant-management';
import { templateInput, listTemplates, saveTemplate, submitTemplate, refreshTemplateStatus, campaignInput, listCampaigns, getCampaign, createCampaign, updateCampaign, draftCampaign, approveDraft, priceAndPreview, startCampaignPayment, checkReadiness, confirmDispatch, pauseCampaign, publicCampaign, senderEligibility } from '@moranbuy/campaign-engine';
import { listOutreachOffers, answerOutreachOffer } from '@moranbuy/campaign-outreach';
import { asyncHandler } from '../middleware/async-handler.js';
import { validate } from '../middleware/validate.js';
import { db } from '../db/connection.js';
import { engagementDeps, loadCampaignPricing } from '../services/engagement.js';
import { merchantDeps } from '../services/merchants.js';

export const campaignsRouter = express.Router();
campaignsRouter.use(requireMerchantAuth(db));
const idParams = z.object({ id: z.string().uuid() });
const actor = (req) => ({ actorId: req.merchantUser.id, ip: req.ip });

// ---- templates (drafting is free; submission needs a connected sender) ----
campaignsRouter.get('/templates', asyncHandler(async (req, res) => res.json({ templates: await listTemplates(db, req.merchant.id) })));
campaignsRouter.post('/templates', validate({ body: templateInput }), asyncHandler(async (req, res) => res.status(201).json({ template: await saveTemplate(db, req.merchant.id, req.body, actor(req)) })));
campaignsRouter.patch('/templates/:id', validate({ params: idParams, body: templateInput }), asyncHandler(async (req, res) => res.json({ template: await saveTemplate(db, req.merchant.id, req.body, { id: req.params.id, ...actor(req) }) })));
campaignsRouter.post('/templates/:id/submit', validate({ params: idParams }), asyncHandler(async (req, res) => {
  const { moran } = merchantDeps();
  const moranToken = req.merchant.registration_type === 'moran' && moran.configured ? await moranAccessTokenFor(db, moran, req.merchant) : null;
  res.json({ template: await submitTemplate(db, req.merchant.id, req.params.id, { merchant: req.merchant, moran: moranToken ? moran : null, moranToken, ...actor(req) }) });
}));
campaignsRouter.post('/templates/:id/refresh', validate({ params: idParams }), asyncHandler(async (req, res) => {
  const { moran } = merchantDeps();
  if (req.merchant.registration_type !== 'moran') throw new ApiError(409, 'TEMPLATE_SUBMISSION_UNAVAILABLE', 'No provider to refresh from.');
  const moranToken = await moranAccessTokenFor(db, moran, req.merchant);
  res.json({ template: await refreshTemplateStatus(db, req.merchant.id, req.params.id, { moran, moranToken }) });
}));

// ---- sender eligibility, visible before anyone pays ----
campaignsRouter.get('/sender', (req, res) => res.json(senderEligibility(req.merchant)));

// ---- campaigns (the engine itself needs an active campaign entitlement) ----
const needCampaign = requireEntitlement(db, 'campaign_engine');
campaignsRouter.get('/', asyncHandler(async (req, res) => res.json({ campaigns: await listCampaigns(db, req.merchant.id) })));
campaignsRouter.post('/', needCampaign, validate({ body: campaignInput }), asyncHandler(async (req, res) => res.status(201).json({ campaign: publicCampaign(await createCampaign(db, req.merchant.id, req.body, { ...actor(req), dryRun: engagementDeps().dryRun })) })));
campaignsRouter.get('/:id', validate({ params: idParams }), asyncHandler(async (req, res) => {
  const row = await getCampaign(db, req.merchant.id, req.params.id);
  const recipients = await db('campaign_recipients').where({ campaign_id: row.id }).select('phone', 'status', 'skip_reason', 'attempts', 'last_error', 'sent_at', 'dry_run').orderBy('updated_at', 'desc').limit(500);
  res.json({ campaign: publicCampaign(row), recipients: recipients.map((r) => ({ ...r, phone: `${r.phone.slice(0, 5)}…${r.phone.slice(-2)}` })) });
}));
campaignsRouter.patch('/:id', needCampaign, validate({ params: idParams, body: campaignInput.partial().extend({ draftBody: z.string().max(1024).optional() }) }), asyncHandler(async (req, res) => res.json({ campaign: publicCampaign(await updateCampaign(db, req.merchant.id, req.params.id, req.body, actor(req))) })));
campaignsRouter.post('/:id/draft', needCampaign, validate({ params: idParams, body: z.object({ revision: z.string().max(500).optional() }) }), asyncHandler(async (req, res) => {
  const out = await draftCampaign(db, engagementDeps().muse, req.merchant, req.params.id, { revision: req.body.revision || null, ...actor(req) });
  res.json({ campaign: publicCampaign(out.campaign), draftSource: out.draftSource, notes: out.notes });
}));
campaignsRouter.post('/:id/approve', needCampaign, validate({ params: idParams }), asyncHandler(async (req, res) => res.json({ campaign: publicCampaign(await approveDraft(db, req.merchant.id, req.params.id, actor(req))) })));
campaignsRouter.post('/:id/price', needCampaign, validate({ params: idParams }), asyncHandler(async (req, res) => {
  const out = await priceAndPreview(db, req.merchant.id, req.params.id, { pricing: await loadCampaignPricing(), ...actor(req) });
  res.json({ campaign: publicCampaign(out.campaign), audience: out.audience, pricing: out.pricing });
}));
campaignsRouter.post('/:id/pay', needCampaign, validate({ params: idParams, body: z.object({ phone: z.string().max(20).optional() }) }), asyncHandler(async (req, res) => {
  const out = await startCampaignPayment(db, engagementDeps().payments, req.merchant.id, req.params.id, { phone: req.body.phone || null, ...actor(req) });
  res.json({ campaign: publicCampaign(out.campaign), payment: { id: out.payment.id, reference: out.payment.reference, amount: out.payment.amount, currency: out.payment.currency, status: out.payment.status, provider: out.payment.provider } });
}));
campaignsRouter.post('/:id/readiness', needCampaign, validate({ params: idParams }), asyncHandler(async (req, res) => {
  const pricing = await loadCampaignPricing();
  const out = await checkReadiness(db, req.merchant, req.params.id, { pricingConfigured: pricing.providerUnitTzs !== null });
  res.json({ campaign: publicCampaign(out.campaign), ready: out.ok, gates: out.gates, audience: out.audience.counts });
}));
// The one call that queues messages; it re-runs every gate first and records who confirmed.
campaignsRouter.post('/:id/confirm', needCampaign, validate({ params: idParams, body: z.object({ confirm: z.literal(true) }) }), asyncHandler(async (req, res) => {
  const pricing = await loadCampaignPricing();
  const row = await confirmDispatch(db, req.merchant, req.params.id, { pricingConfigured: pricing.providerUnitTzs !== null, dryRun: engagementDeps().dryRun, ...actor(req) });
  res.json({ campaign: publicCampaign(row), dryRun: row.dry_run });
}));
campaignsRouter.post('/:id/pause', needCampaign, validate({ params: idParams }), asyncHandler(async (req, res) => res.json({ campaign: publicCampaign(await pauseCampaign(db, req.merchant.id, req.params.id, actor(req))) })));
campaignsRouter.post('/:id/resume', needCampaign, validate({ params: idParams }), asyncHandler(async (req, res) => res.json({ campaign: publicCampaign(await pauseCampaign(db, req.merchant.id, req.params.id, { resume: true, ...actor(req) })) })));

// ---- new-product outreach offers ----
campaignsRouter.get('/outreach/offers', asyncHandler(async (req, res) => res.json({ offers: (await listOutreachOffers(db, req.merchant.id)).map((r) => publicCampaign(r, { listingName: r.listing_name, listingPrice: r.listing_price, listingCurrency: r.listing_currency })) })));
campaignsRouter.post('/outreach/offers/:id/answer', validate({ params: idParams, body: z.object({ accept: z.boolean() }) }), asyncHandler(async (req, res) => res.json({ campaign: publicCampaign(await answerOutreachOffer(db, req.merchant.id, req.params.id, { accept: req.body.accept, ...actor(req) })) })));
