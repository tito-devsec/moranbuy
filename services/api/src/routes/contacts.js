import express from 'express';
import { z } from 'zod';
import { requireMerchantAuth } from '@moranbuy/authorization';
import { upsertContact, recordConsent, consentState, consentHistory, eraseContact, toMsisdn } from '@moranbuy/consent-management';
import { audit } from '@moranbuy/observability';
import { asyncHandler } from '../middleware/async-handler.js';
import { validate } from '../middleware/validate.js';
import { db } from '../db/connection.js';

export const contactsRouter = express.Router();
contactsRouter.use(requireMerchantAuth(db));
const mask = (p) => `${p.slice(0, 5)}…${p.slice(-2)}`;

contactsRouter.get('/', asyncHandler(async (req, res) => {
  const rows = await db('contacts').where({ merchant_id: req.merchant.id }).orderBy('last_interaction_at', 'desc').limit(500);
  const out = [];
  for (const c of rows) out.push({ id: c.id, phone: mask(c.phone), name: c.name, source: c.source, tags: c.tags, marketing: (await consentState(db, { merchantId: req.merchant.id, phone: c.phone, purpose: 'marketing' })).reason, lastInteractionAt: c.last_interaction_at });
  res.json({ contacts: out });
}));

// A merchant may add a contact it has a real relationship with and must attest the consent it holds; the attestation is the evidence on record.
contactsRouter.post('/', validate({ body: z.object({ phone: z.string().min(9).max(20), name: z.string().max(120).optional(), source: z.enum(['enquiry', 'order', 'import', 'web_form']).default('import'), marketingConsent: z.object({ granted: z.boolean(), evidence: z.string().min(3).max(200) }).optional() }) }), asyncHandler(async (req, res) => {
  const c = await upsertContact(db, { merchantId: req.merchant.id, phone: req.body.phone, name: req.body.name || null, source: req.body.source });
  if (!c) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'That phone number is not valid.' });
  if (req.body.marketingConsent) await recordConsent(db, { merchantId: req.merchant.id, phone: c.phone, purpose: 'marketing', status: req.body.marketingConsent.granted ? 'granted' : 'revoked', source: 'merchant_attestation', evidenceRef: req.body.marketingConsent.evidence, recordedBy: `merchant:${req.merchantUser.id}` });
  await audit(db, { actorType: 'merchant', actorId: req.merchantUser.id, merchantId: req.merchant.id, action: 'contact.added', targetType: 'contact', targetId: c.id, after: { source: req.body.source, consentAttested: !!req.body.marketingConsent }, ip: req.ip });
  res.status(201).json({ contact: { id: c.id, phone: mask(c.phone), name: c.name, source: c.source } });
}));

contactsRouter.get('/:phone/consent', asyncHandler(async (req, res) => {
  const history = await consentHistory(db, { phone: req.params.phone, merchantId: req.merchant.id });
  res.json({ phone: mask(toMsisdn(req.params.phone)), marketing: await consentState(db, { merchantId: req.merchant.id, phone: req.params.phone, purpose: 'marketing' }), followup: await consentState(db, { merchantId: req.merchant.id, phone: req.params.phone, purpose: 'followup' }), history: history.map((h) => ({ purpose: h.purpose, status: h.status, source: h.source, at: h.created_at })) });
}));

// Deletion on a customer's request: the contact and its consent rows for this merchant go; the audit trail stays.
contactsRouter.delete('/:phone', asyncHandler(async (req, res) => {
  await eraseContact(db, { merchantId: req.merchant.id, phone: req.params.phone });
  await audit(db, { actorType: 'merchant', actorId: req.merchantUser.id, merchantId: req.merchant.id, action: 'contact.erased', targetType: 'contact', targetId: mask(toMsisdn(req.params.phone)), ip: req.ip });
  res.json({ ok: true });
}));
