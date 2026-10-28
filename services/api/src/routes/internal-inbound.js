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
import { handleMerchantOrderReply } from '../services/order-actions.js';
import { termsGate } from '../services/terms.js';
import { recordDeliveryStatus } from '@moranbuy/campaign-engine';

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
  const { messageId, from, text = '', imageUrl = null, location = null, name = null, buttonId = null } = event;
  if (!messageId || !from) throw new ApiError(400, 'VALIDATION_ERROR', 'messageId and from are required.');

  // The same delivery twice is answered once.
  const inserted = await db('webhook_events').insert({ source: 'moran', event_id: String(messageId), event_type: 'inbound_message' }).onConflict(['source', 'event_id']).ignore().returning('id');
  if (!inserted.length) return res.json({ ok: true, duplicate: true });

  const customer = await upsertCustomer({ channel: 'whatsapp', channelRef: String(from), name });
  const { engine, moran } = shoppingDeps();
  // A bare STOP to the MoranBuy number ends marketing and follow-up from every merchant; START restores only the MoranBuy relationship.
  let out; let gate;
  if (detectOptOut(text)) {
    await optOut(db, { merchantId: null, phone: from, source: 'inbound_keyword', evidenceRef: String(messageId) });
    await stopLeadsForPhone(db, { phone: from, reason: 'opted_out' });
    out = { replies: [{ text: 'Sawa. Hutapokea tena ujumbe wa matangazo au ufuatiliaji kupitia MoranBuy. / You will no longer receive marketing or follow-up messages through MoranBuy.' }], session: { id: null, state: 'opted_out' } };
  } else if (detectOptIn(text)) {
    await optIn(db, { merchantId: null, phone: from, source: 'inbound_keyword', evidenceRef: String(messageId) });
    out = { replies: [{ text: 'Karibu tena. / Welcome back.' }], session: { id: null, state: 'opted_in' } };
  } else if (!(gate = await termsGate({ customer, text, buttonId, channel: 'whatsapp' })).pass) {
    // Nobody, customer or business owner, is answered before accepting the terms; the question is repeated until they do.
    out = { replies: gate.replies, session: { id: null, state: gate.accepted ? 'terms_accepted' : gate.rejected ? 'terms_rejected' : 'terms_prompted' } };
  } else {
    // "KUBALI MB-XXXX 15000" from a merchant's own number answers an order alert; everything else is a shopping message.
    const merchantReply = await handleMerchantOrderReply({ moran, from, text });
    if (merchantReply) out = { replies: [{ text: merchantReply.reply }], session: { id: null, state: merchantReply.order ? `order_${merchantReply.order.status}` : 'order_reply_rejected' } };
    else {
      await stopLeadsForPhone(db, { phone: from, reason: 'customer_replied', outcome: 'replied' }).catch(() => 0);
      out = await engine.handleMessage({ customer, text, imageUrl, sharedLocation: location });
    }
  }
  const sent = [];
  for (const [i, r] of out.replies.entries()) {
    const idempotencyKey = `moranbuy:${messageId}:${i}`;
    const result = r.buttons
      ? await moran.sendButtons({ to: from, body: r.text, buttons: r.buttons, footer: r.footer || null, idempotencyKey })
      : r.imageUrl
        ? await moran.sendImage({ to: from, imageUrl: r.imageUrl, caption: r.caption || '', idempotencyKey })
        : await moran.sendText({ to: from, body: r.text, idempotencyKey });
    sent.push({ idempotencyKey, status: result.status });
    if (!result.ok) logger.warn({ status: result.status }, 'Reply to Moran not delivered');
  }
  await db('webhook_events').where({ source: 'moran', event_id: String(messageId) }).update({ status: 'processed', processed_at: db.fn.now() });
  res.json({ ok: true, sessionId: out.session.id, state: out.session.state, sent });
}));

// Delivery receipts (sent, delivered, read, failed) for messages MoranBuy sent, forwarded by Moran; each only moves the ledger forward.
internalInboundRouter.post('/status', asyncHandler(async (req, res) => {
  const c = config();
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body || {});
  if (!verifySignedBody(c.MORAN_SHARED_SECRET, raw, req.headers['x-moranbuy-timestamp'], req.headers['x-moranbuy-signature'])) throw new ApiError(401, 'BAD_SIGNATURE', 'The request signature is not valid.');
  let event; try { event = JSON.parse(raw); } catch { throw new ApiError(400, 'BAD_JSON', 'Body is not JSON.'); }
  const statuses = Array.isArray(event.statuses) ? event.statuses : [];
  const results = [];
  for (const s of statuses) {
    const status = String(s.status || '').toLowerCase();
    if (!s.id || !['sent', 'delivered', 'read', 'failed'].includes(status)) continue;
    const campaign = await recordDeliveryStatus(db, { providerMessageId: s.id, status });
    const notified = await db('merchant_notifications').where({ provider_message_id: s.id }).update({ status: status === 'failed' ? 'failed' : 'sent', error: status === 'failed' ? (s.errors?.[0]?.title || 'Delivery failed') : null });
    results.push({ id: s.id, status, campaign, notification: notified > 0 });
  }
  // Campaign counters follow the recipient ledger.
  const ids = statuses.map((s) => s.id).filter(Boolean);
  const touched = ids.length ? [...new Set(await db('campaign_recipients').whereIn('provider_message_id', ids).pluck('campaign_id'))] : [];
  for (const id of touched) {
    const counts = Object.fromEntries((await db('campaign_recipients').where({ campaign_id: id }).select('status').count('id as n').groupBy('status')).map((x) => [x.status, Number(x.n)]));
    await db('campaigns').where({ id }).update({ count_sent: (counts.sent || 0) + (counts.delivered || 0) + (counts.read || 0), count_delivered: (counts.delivered || 0) + (counts.read || 0), count_failed: counts.failed || 0, updated_at: db.fn.now() });
  }
  res.json({ ok: true, results });
}));

// Constant-time comparison helper kept here for the WhatsApp verify handshake if Moran ever forwards it.
export const safeEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
