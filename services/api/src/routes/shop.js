import express from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { asyncHandler } from '../middleware/async-handler.js';
import { validate } from '../middleware/validate.js';
import { shoppingDeps, upsertCustomer } from '../services/shopping.js';
import { db } from '../db/connection.js';
import { notFound } from '@moranbuy/core';
import { termsGate } from '../services/terms.js';
import { ApiError } from '@moranbuy/core';
import { saveUpload, uploadDataUrl } from '../services/uploads.js';
import { intakeVoice } from '../services/media-intake.js';
import { voiceReplyFor } from '../services/voice-reply.js';
import { rawFile } from './uploads.js';

export const shopRouter = express.Router();

const messageBody = z.object({
  customerToken: z.string().min(8).max(80).optional(),
  text: z.string().max(2000).default(''),
  imageUrl: z.string().url().max(600).optional(),
  photoUploadId: z.string().uuid().optional(),
  voiceUploadId: z.string().uuid().optional(),
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
  if (!gate.pass && !(gate.accepted && (req.body.text || req.body.imageUrl || req.body.photoUploadId || req.body.voiceUploadId || req.body.location))) return res.json({ customerToken: token, state: gate.accepted ? 'terms_accepted' : gate.rejected ? 'terms_rejected' : 'terms_required', replies: gate.replies.map((r) => ({ text: r.text })), terms: gate.terms || null });
  const { engine } = shoppingDeps();
  // A photo the customer uploaded stays private: Muse reads it as data, and the session records only its reference.
  let photo = null;
  if (req.body.photoUploadId) {
    photo = await db('uploads').where({ id: req.body.photoUploadId, customer_id: customer.id, purpose: 'customer_photo' }).first();
    if (!photo) throw notFound('UPLOAD_NOT_FOUND');
  }
  // A recorded voice message counts as the words Muse heard in it.
  let text = req.body.text; let kind = null;
  if (req.body.voiceUploadId) {
    const voice = await db('uploads').where({ id: req.body.voiceUploadId, customer_id: customer.id, purpose: 'voice_note' }).first();
    if (!voice) throw notFound('UPLOAD_NOT_FOUND');
    text = [req.body.text, voice.transcript].filter(Boolean).join(' ').trim(); kind = 'voice';
  }
  const out = await engine.handleMessage({ customer, text, kind, imageUrl: req.body.imageUrl || (photo ? `upload:${photo.id}` : null), imageDataUrl: photo ? await uploadDataUrl(photo) : null, sharedLocation: req.body.location || null });
  // A voice message is answered with a voice reply too, when spoken replies are set up; it plays in the page.
  const spoken = await voiceReplyFor({ replies: out.replies, language: customer.language === 'en' ? 'en' : 'sw', inboundKind: kind || 'text', state: out.session?.state, customerId: customer.id }).catch(() => null);
  res.json({ voiceReply: spoken?.ok ? { dataUrl: `data:audio/ogg;base64,${spoken.audio.toString('base64')}`, text: spoken.text } : null, heard: kind === 'voice' ? text : null, customerToken: token, sessionId: out.session.id, state: out.session.state, replies: out.replies, runId: out.run?.id || null, orderRef: out.orderRef || null, museStatus: out.museStatus || null });
}));

// A web customer's photo of what they want; only after accepting the terms, kept private and removed by the retention purge.
shopRouter.post('/uploads', rawFile, validate({ query: z.object({ customerToken: z.string().min(8).max(80), kind: z.enum(['photo', 'voice']).default('photo') }).passthrough() }), asyncHandler(async (req, res) => {
  const customer = await db('customers').where({ channel: 'web', channel_ref: req.query.customerToken }).first();
  if (!customer || customer.terms_status !== 'accepted') throw new ApiError(403, 'TERMS_REQUIRED', 'Accept the terms of service before sending a photo or a voice message.');
  if (req.query.kind === 'voice') {
    // Decoded and heard by Muse right away, so the page can show what was understood before it is sent.
    const heard = await intakeVoice({ muse: shoppingDeps().muse, buffer: req.body, customerId: customer.id });
    if (!heard.uploadId) throw new ApiError(415, 'UNSUPPORTED_FILE', 'Only Ogg Opus voice notes or WAV recordings are accepted.');
    return res.status(201).json({ uploadId: heard.uploadId, heard: heard.ok, transcript: heard.ok ? heard.text : null, reason: heard.ok ? null : heard.reason, seconds: heard.seconds ?? null, source: heard.source || null });
  }
  const row = await saveUpload({ buffer: req.body, purpose: 'customer_photo', customerId: customer.id });
  res.status(201).json({ uploadId: row.id, mime: row.mime, sizeBytes: row.size_bytes });
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
