import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import pinoHttp from 'pino-http';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '@moranbuy/core';
import { logger } from '@moranbuy/observability';
import { healthRouter } from './routes/health.js';
import { notFoundHandler, errorHandler } from './middleware/error.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const appsDir = path.join(here, '../../../apps');

// Builds the Express app; routers are registered here as each phase adds them.
export function createApp({ routers = [] } = {}) {
  const c = config();
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: c.APP_ENV === 'production' ? [c.APP_URL] : true }));
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));

  // Webhooks are signed over the raw body, so they are parsed as bytes before the JSON parser runs.
  // Voice notes and photos arrive inside Moran's signed body, base64 encoded (a 16 MB WhatsApp voice note is about 22 MB of text).
  app.use('/internal/inbound', express.raw({ type: '*/*', limit: '24mb' }));
  app.use('/webhooks', express.raw({ type: '*/*', limit: '2mb' }));
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));

  // One shared ceiling per IP; signed webhooks are authenticated by their signature instead.
  app.use('/api', rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false }));

  app.use(healthRouter);
  for (const r of routers) app.use(r.path, r.router);

  // The three static apps are served from the same process.
  app.use('/customer', express.static(path.join(appsDir, 'customer')));
  app.use('/business', express.static(path.join(appsDir, 'business')));
  app.use('/admin', express.static(path.join(appsDir, 'admin')));
  app.get('/', (_req, res) => res.redirect('/customer/'));
  app.get('/terms', (_req, res) => res.sendFile(path.join(appsDir, 'customer', 'terms.html')));
  app.get('/privacy', (_req, res) => res.sendFile(path.join(appsDir, 'customer', 'privacy.html')));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
