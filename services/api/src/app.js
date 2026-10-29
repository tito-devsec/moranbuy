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
  // The public site's demo runs on its own sandbox server with its own database; this process only passes the calls through.
  if (!c.DEMO_MODE && c.DEMO_API_URL) {
    const target = String(c.DEMO_API_URL).replace(/\/+$/, '');
    app.use('/api/demo', express.raw({ type: '*/*', limit: '8mb' }), async (req, res) => {
      try {
        const upstream = await fetch(`${target}/api/demo${req.url}`, { method: req.method, headers: { 'Content-Type': req.get('content-type') || 'application/json', 'X-Forwarded-For': req.ip }, body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body, signal: AbortSignal.timeout(90000) });
        res.status(upstream.status);
        for (const h of ['content-type', 'content-disposition', 'cache-control', 'ratelimit', 'ratelimit-policy', 'retry-after']) { const v = upstream.headers.get(h); if (v) res.set(h, v); }
        res.send(Buffer.from(await upstream.arrayBuffer()));
      } catch (err) {
        res.status(502).json({ error: 'DEMO_UNAVAILABLE', message: 'The demo sandbox is not reachable right now.' });
      }
    });
  }
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));

  // One shared ceiling per IP; signed webhooks are authenticated by their signature instead.
  app.use('/api', rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false }));

  app.use(healthRouter);
  for (const r of routers) app.use(r.path, r.router);

  // The three static apps are served from the same process.
  app.use('/customer', express.static(path.join(appsDir, 'customer')));
  app.use('/business', express.static(path.join(appsDir, 'business')));
  app.use('/admin', express.static(path.join(appsDir, 'admin')));
  // The public website: Home, How it works, For businesses and the demo; no sign-in anywhere on it.
  app.use('/site', express.static(path.join(appsDir, 'site', 'assets'), { maxAge: '1h' }));
  const sitePages = { '/': 'index.html', '/how-it-works': 'how-it-works.html', '/for-business': 'for-business.html', '/demo': 'demo.html' };
  for (const [route, file] of Object.entries(sitePages)) app.get(route, (_req, res) => res.sendFile(path.join(appsDir, 'site', file)));
  // Terms, privacy and the company pages share one bilingual page (English first, Swahili on the switch).
  for (const page of ['terms', 'privacy', 'about', 'developers', 'contact', 'copyright']) app.get(`/${page}`, (_req, res) => res.sendFile(path.join(appsDir, 'customer', 'legal.html')));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
