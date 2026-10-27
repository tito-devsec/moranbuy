import express from 'express';
import { checkDbConnection } from '../db/connection.js';
import { checkRedisConnection } from '../db/redis.js';
import { asyncHandler } from '../middleware/async-handler.js';

export const healthRouter = express.Router();

// Liveness: the process is up.
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
