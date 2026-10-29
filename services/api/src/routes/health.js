import express from 'express';
import { config } from '@moranbuy/core';
import { checkDbConnection } from '../db/connection.js';
import { checkRedisConnection } from '../db/redis.js';
import { asyncHandler } from '../middleware/async-handler.js';

export const healthRouter = express.Router();

// Liveness: the process is up.
// What a public page needs to open MoranBuy on WhatsApp; nothing secret.
healthRouter.get('/api/public/contact', (_req, res) => {
  const digits = String(config().MORANBUY_WHATSAPP_NUMBER || '').replace(/\D/g, '');
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ whatsapp: digits.length >= 9 ? { number: `+${digits}`, link: `https://wa.me/${digits}` } : null, web: '/customer/' });
});

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
