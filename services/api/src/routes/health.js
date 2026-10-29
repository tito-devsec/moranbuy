import express from 'express';
import { config } from '@moranbuy/core';
import { checkDbConnection } from '../db/connection.js';
import { checkRedisConnection } from '../db/redis.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { db } from '../db/connection.js';
import { verifyReceipt } from '../services/protection/receipts-store.js';

export const healthRouter = express.Router();

// Liveness: the process is up.
// What a public page needs to open MoranBuy on WhatsApp; nothing secret.
healthRouter.get('/api/public/contact', (_req, res) => {
  const digits = String(config().MORANBUY_WHATSAPP_NUMBER || '').replace(/\D/g, '');
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ whatsapp: digits.length >= 9 ? { number: `+${digits}`, link: `https://wa.me/${digits}` } : null, web: '/customer/' });
});

const escapeHtml = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The page behind a receipt's QR code: shown only when the receipt number and its check code match what MoranBuy issued.
healthRouter.get('/r/:no', asyncHandler(async (req, res) => {
  const r = await verifyReceipt(db, req.params.no, req.query.c);
  const body = r
    ? `<h1>&#10003; Genuine MoranBuy receipt</h1><p class="ok">${escapeHtml(r.receiptNo)} · version ${r.version}</p><pre>${escapeHtml(r.summary)}</pre><p>Current status: <strong>${escapeHtml(r.latestStatus)}</strong>${r.latestVersion !== r.version ? ` (receipt version ${r.latestVersion})` : ''}</p>`
    : '<h1>&#10007; Not verified</h1><p class="bad">This receipt number and check code do not match any receipt MoranBuy issued. The receipt may have been changed.</p>';
  res.status(r ? 200 : 404).set('Cache-Control', 'no-store').type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>MoranBuy receipt check</title><style>body{margin:0;background:#f4f8f8;color:#1f2933;font:16px/1.6 system-ui,sans-serif}main{max-width:560px;margin:0 auto;padding:24px 16px}h1{font-size:24px}.ok{color:#0f766e;font-weight:600}.bad{color:#b42318}pre{background:#fff;border:1px solid #e3e8ec;border-radius:10px;padding:14px;white-space:pre-wrap;font:14px/1.5 ui-monospace,Menlo,monospace}footer{color:#5f6b76;font-size:13px;margin-top:24px}</style></head><body><main>${body}<footer>Powered by MoranBuy · <a href="/terms">Terms</a></footer></main></body></html>`);
}));

healthRouter.get('/health', (_req, res) => res.json({ ok: true, service: 'moranbuy-api', time: new Date().toISOString() }));

// Readiness: the database and Redis answer; failures are reported, not hidden.
healthRouter.get('/ready', asyncHandler(async (_req, res) => {
  const checks = {};
  for (const [name, fn] of [['database', checkDbConnection], ['redis', checkRedisConnection]]) {
    try { checks[name] = (await fn()) ? 'ok' : 'failed'; } catch (err) { checks[name] = `failed: ${err.code || err.message}`; }
  }
  const ok = Object.values(checks).every((v) => v === 'ok');
  res.status(ok ? 200 : 503).json({ ok, checks });
}));
