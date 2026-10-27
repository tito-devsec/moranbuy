import express from 'express';
import { z } from 'zod';
import { verifyMoranBuySignature, sendFromMoranBuy, sendMerchantText, sendMerchantTemplate, listedProducts, moranBuyKnowledge } from '../../services/moranbuy.service.js';
import { reportError } from '../../core/error-handler.js';
import { logger } from '../../utils/logger.js';

/*
 * /internal/moranbuy — the signed channel the MoranBuy service uses (docs/moranbuy.md). Mounted
 * with express.raw() in server.js because the signature covers the exact bytes. Never the n8n key.
 */
export const moranbuyInternalRouter = express.Router();

moranbuyInternalRouter.use((req, res, next) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : (req.method === 'GET' ? '' : JSON.stringify(req.body || {}));
  if (!verifyMoranBuySignature(raw, req.headers['x-moranbuy-timestamp'], req.headers['x-moranbuy-signature'])) {
    return res.status(401).json({ error: 'BAD_SIGNATURE' });
  }
  if (raw) { try { req.body = JSON.parse(raw); } catch { return res.status(400).json({ error: 'BAD_JSON' }); } }
  next();
});

const sendSchema = z.object({
  type: z.enum(['text', 'image']).default('text'),
  to: z.string().min(9).max(20),
  body: z.string().max(4096).optional(),
  imageUrl: z.string().url().optional(),
  caption: z.string().max(1024).optional(),
  idempotencyKey: z.string().max(120).optional(),
  tenantId: z.string().uuid().optional(), // set: a listed merchant's own number; unset: the MoranBuy number
});

moranbuyInternalRouter.post('/send', async (req, res) => {
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR', details: parsed.error.issues });
  const m = parsed.data;
  try {
    const result = m.tenantId
      ? await sendMerchantText({ tenantId: m.tenantId, to: m.to, body: m.body || '', idempotencyKey: m.idempotencyKey || null })
      : await sendFromMoranBuy({ type: m.type, to: m.to, body: m.body || '', imageUrl: m.imageUrl, caption: m.caption, idempotencyKey: m.idempotencyKey || null });
    res.json({ sent: true, messageId: result.messageId || null, duplicate: !!result.duplicate });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.code, message: err.message });
    if (err.entitlement) return res.status(402).json({ error: 'NOT_ENTITLED', state: err.entitlement.state });
    await reportError(err, { tier: 'WARNING', action: 'moranbuy_send' });
    res.status(502).json({ error: 'SEND_FAILED' });
  }
});

const templateSchema = z.object({
  tenantId: z.string().uuid(), to: z.string().min(9).max(20), templateName: z.string().min(1).max(512), language: z.string().min(2).max(10),
  components: z.array(z.any()).max(10).default([]), idempotencyKey: z.string().max(120).optional(),
});

moranbuyInternalRouter.post('/send-template', async (req, res) => {
  const parsed = templateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR', details: parsed.error.issues });
  try {
    const result = await sendMerchantTemplate({ ...parsed.data, idempotencyKey: parsed.data.idempotencyKey || null });
    res.json({ sent: true, messageId: result.messageId || null, duplicate: !!result.duplicate });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.code, message: err.message });
    if (err.entitlement) return res.status(402).json({ error: 'NOT_ENTITLED', state: err.entitlement.state });
    logger.warn({ err: err.response?.data || err.message }, 'MoranBuy merchant template send failed');
    res.status(502).json({ error: 'SEND_FAILED', message: err.response?.data?.error?.message || err.message });
  }
});

moranbuyInternalRouter.get('/listings', async (req, res) => {
  res.json(await listedProducts({ since: req.query.since || null, page: req.query.page, pageSize: req.query.pageSize }));
});

moranbuyInternalRouter.get('/knowledge/search', async (req, res) => {
  const q = String(req.query.q || '').slice(0, 500);
  if (!q) return res.json({ passages: [] });
  res.json({ passages: await moranBuyKnowledge(q, Math.min(10, Number(req.query.limit) || 3)) });
});
