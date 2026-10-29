import express from 'express';
import { z } from 'zod';
import { verifyMoranBuySignature, sendFromMoranBuy, sendMerchantText, sendMerchantTemplate, listedProducts, moranBuyKnowledge, createMoranBuyOrder, updateMoranBuyOrder } from '../../services/moranbuy.service.js';
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
  type: z.enum(['text', 'image', 'template', 'buttons', 'audio', 'document', 'list']).default('text'),
  audioBase64: z.string().max(3_000_000).optional(),
  documentBase64: z.string().max(3_000_000).optional(),
  filename: z.string().max(120).optional(),
  button: z.string().max(20).optional(),
  header: z.string().max(60).nullable().optional(),
  sections: z.array(z.object({ title: z.string().max(24), rows: z.array(z.object({ id: z.string().min(1).max(200), title: z.string().min(1).max(24), description: z.string().max(72).optional() })).max(10) })).max(10).optional(),
  mime: z.string().max(60).optional(),
  to: z.string().min(9).max(20),
  body: z.string().max(4096).optional(),
  imageUrl: z.string().url().optional(),
  caption: z.string().max(1024).optional(),
  templateName: z.string().min(1).max(512).optional(),
  language: z.string().min(2).max(10).optional(),
  components: z.array(z.any()).max(10).optional(),
  buttons: z.array(z.object({ id: z.string().min(1).max(256), title: z.string().min(1).max(20) })).max(3).optional(),
  footer: z.string().max(60).nullable().optional(),
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
      : await sendFromMoranBuy({ type: m.type, to: m.to, body: m.body || '', imageUrl: m.imageUrl, caption: m.caption, templateName: m.templateName, language: m.language || 'sw', components: m.components || [], buttons: m.buttons || [], footer: m.footer || null, idempotencyKey: m.idempotencyKey || null, audioBase64: m.audioBase64 || null, mime: m.mime || null, documentBase64: m.documentBase64 || null, filename: m.filename || null, button: m.button || null, header: m.header || null, sections: m.sections || [] });
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

const orderSchema = z.object({
  tenantId: z.string().uuid(), orderRef: z.string().min(4).max(32), customerName: z.string().max(120).nullable().optional(), customerPhone: z.string().max(20).nullable().optional(),
  items: z.array(z.object({ name: z.string().max(200), sku: z.string().max(120).nullable().optional(), productId: z.string().max(64).nullable().optional(), quantity: z.number().int().positive().default(1), unitPrice: z.number().nonnegative(), lineTotal: z.number().optional() })).min(1).max(20),
  deliveryFee: z.number().nonnegative().nullable().optional(), totalAmount: z.number().nonnegative(), totalConfirmed: z.boolean().optional(), currency: z.string().max(8).default('TZS'),
  fulfilment: z.string().max(20).nullable().optional(), customerLocation: z.string().max(200).nullable().optional(), notes: z.string().max(500).nullable().optional(),
});

// An order MoranBuy confirmed for a listed business lands in that business's own order list.
moranbuyInternalRouter.post('/orders', async (req, res) => {
  const parsed = orderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR', details: parsed.error.issues });
  try {
    res.json(await createMoranBuyOrder(parsed.data));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.code, message: err.message });
    await reportError(err, { tier: 'WARNING', action: 'moranbuy_order' });
    res.status(500).json({ error: 'ORDER_FAILED' });
  }
});

const orderPatchSchema = z.object({ tenantId: z.string().uuid(), status: z.enum(['pending', 'confirmed', 'paid', 'fulfilled', 'cancelled']), totalAmount: z.number().nonnegative().nullable().optional(), deliveryFee: z.number().nonnegative().nullable().optional(), notes: z.string().max(500).nullable().optional() });

// MoranBuy mirrors the merchant's accept, reject and delivered decisions onto the same order.
moranbuyInternalRouter.patch('/orders/:orderRef', async (req, res) => {
  const parsed = orderPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR', details: parsed.error.issues });
  try {
    res.json(await updateMoranBuyOrder({ ...parsed.data, orderRef: req.params.orderRef }));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.code, message: err.message });
    await reportError(err, { tier: 'WARNING', action: 'moranbuy_order_update' });
    res.status(500).json({ error: 'ORDER_UPDATE_FAILED' });
  }
});
