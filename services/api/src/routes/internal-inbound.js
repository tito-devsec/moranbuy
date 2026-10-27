import express from 'express';
import crypto from 'node:crypto';
import { config, ApiError } from '@moranbuy/core';
import { verifySignedBody } from '@moranbuy/integrations';
import { logger } from '@moranbuy/observability';
import { asyncHandler } from '../middleware/async-handler.js';
import { shoppingDeps, upsertCustomer } from '../services/shopping.js';
import { db } from '../db/connection.js';
import { detectOptOut, detectOptIn, optOut, optIn } from '@moranbuy/consent-management';
import { stopLeadsForPhone } from '@moranbuy/followup-engine';

export const internalInboundRouter = express.Router();

// A customer message forwarded by Moran for the MoranBuy business; signed, de-duplicated, answered through Moran's outbound gate.
internalInboundRouter.post('/', asyncHandler(async (req, res) => {
  const c = config();
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body || {});
  if (!verifySignedBody(c.MORAN_SHARED_SECRET, raw, req.headers['x-moranbuy-timestamp'], req.headers['x-moranbuy-signature'])) {
    throw new ApiError(401, 'BAD_SIGNATURE', 'The request signature is not valid.');
  }
  let event;
  try { event = JSON.parse(raw); } catch { throw new ApiError(400, 'BAD_JSON', 'Body is not JSON.'); }
  const { messageId, from, text = '', imageUrl = null, location = null, name = null } = event;
  if (!messageId || !from) throw new ApiError(400, 'VALIDATION_ERROR', 'messageId and from are required.');

  // The same delivery twice is answered once.
  const inserted = await db('webhook_events').insert({ source: 'moran', event_id: String(messageId), event_type: 'inbound_message' }).onConflict(['source', 'event_id']).ignore().returning('id');
  if (!inserted.length) return res.json({ ok: true, duplicate: true });

  const customer = await upsertCustomer({ channel: 'whatsapp', channelRef: String(from), name });
  const { engine, moran } = shoppingDeps();
  // A bare STOP to the MoranBuy number ends marketing and follow-up from every merchant; START restores only the MoranBuy relationship.
  let out;
  if (detectOptOut(text)) {
    await optOut(db, { merchantId: null, phone: from, source: 'inbound_keyword', evidenceRef: String(messageId) });
    await stopLeadsForPhone(db, { phone: from, reason: 'opted_out' });
    out = { replies: [{ text: 'Sawa. Hutapokea tena ujumbe wa matangazo au ufuatiliaji kupitia MoranBuy. / You will no longer receive marketing or follow-up messages through MoranBuy.' }], session: { id: null, state: 'opted_out' } };
  } else if (detectOptIn(text)) {
    await optIn(db, { merchantId: null, phone: from, source: 'inbound_keyword', evidenceRef: String(messageId) });
    out = { replies: [{ text: 'Karibu tena. / Welcome back.' }], session: { id: null, state: 'opted_in' } };
  } else {
    await stopLeadsForPhone(db, { phone: from, reason: 'customer_replied', outcome: 'replied' }).catch(() => 0);
    out = await engine.handleMessage({ customer, text, imageUrl, sharedLocation: location });
  }
  const sent = [];
  for (const [i, r] of out.replies.entries()) {
    const idempotencyKey = `moranbuy:${messageId}:${i}`;
    const result = r.imageUrl
      ? await moran.sendImage({ to: from, imageUrl: r.imageUrl, caption: r.caption || '', idempotencyKey })
      : await moran.sendText({ to: from, body: r.text, idempotencyKey });
    sent.push({ idempotencyKey, status: result.status });
    if (!result.ok) logger.warn({ status: result.status }, 'Reply to Moran not delivered');
  }
  await db('webhook_events').where({ source: 'moran', event_id: String(messageId) }).update({ status: 'processed', processed_at: db.fn.now() });
  res.json({ ok: true, sessionId: out.session.id, state: out.session.state, sent });
}));

// Constant-time comparison helper kept here for the WhatsApp verify handshake if Moran ever forwards it.
export const safeEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
