import express from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/async-handler.js';
import { requireAdminPermission } from '../../middleware/admin.middleware.js';
import { hasAdminPermission } from '../../../services/admin/permissions.js';
import { validate } from '../../middleware/validate.middleware.js';
import { registerMoranBuyTenant, moranBuyTenant } from '../../../services/moranbuy.service.js';
import { connectTenantWhatsApp } from '../../../services/tenant.service.js';
import { getEffectiveMetaConfig, embeddedSignupExtras } from '../../../services/app-config.service.js';
import { audit } from '../../../services/admin/audit.js';
import { db } from '../../../db/connection.js';
import { config } from '../../../config/index.js';
import { logger } from '../../../utils/logger.js';

/*
 * /api/admin/moranbuy — register the one admin-managed MoranBuy business, see its state, and reach
 * the MoranBuy admin API from Super Admin (docs/moranbuy.md).
 */
export const moranbuyAdminRouter = express.Router();
moranbuyAdminRouter.use(requireAdminPermission('businesses.read'));

moranbuyAdminRouter.get('/', asyncHandler(async (_req, res) => {
  const t = await moranBuyTenant();
  res.json({
    registered: !!t,
    tenant: t ? { id: t.id, businessName: t.business_name, status: t.status, whatsapp: { status: t.wa_connection_status, displayNumber: t.whatsapp_display_number }, adminManaged: t.admin_managed } : null,
    service: { apiUrl: config.moranbuy.apiUrl || null, secretConfigured: !!config.moranbuy.sharedSecret },
  });
}));

const registerBody = z.object({ businessName: z.string().min(2).max(160).default('MoranBuy'), ownerEmail: z.string().email().max(255), reason: z.string().max(500).optional() });
moranbuyAdminRouter.post('/register', requireAdminPermission('businesses.manage'), validate({ body: registerBody }), asyncHandler(async (req, res) => {
  try {
    const tenant = await registerMoranBuyTenant({ ...req.body, req });
    res.status(201).json({ tenant: { id: tenant.id, businessName: tenant.business_name, status: tenant.status } });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.code, message: err.message });
    throw err;
  }
}));

/* The Embedded Signup settings Super Admin's "Connect MoranBuy to WhatsApp" button needs; the same values the owner dashboard uses. */
moranbuyAdminRouter.get('/signup-config', asyncHandler(async (_req, res) => {
  const metaConfig = await getEffectiveMetaConfig();
  res.json({ appId: metaConfig.appId, configId: metaConfig.embeddedSignupConfigId, version: metaConfig.embeddedSignupVersion, coexistence: metaConfig.embeddedSignupCoexistence, extras: embeddedSignupExtras(metaConfig.embeddedSignupVersion, { coexistence: metaConfig.embeddedSignupCoexistence }) });
}));

const connectBody = z.object({ code: z.string().min(1), wabaId: z.string().min(1).optional(), phoneNumberId: z.string().min(1).optional(), displayNumber: z.string().min(5).optional(), businessId: z.string().min(1).max(64).optional(), coexistence: z.boolean().optional(), reason: z.string().max(500).optional() });
/* Connects the MoranBuy number through Meta's Embedded Signup, exactly as an owner does, but from Super Admin and audited. */
moranbuyAdminRouter.post('/whatsapp/connect', requireAdminPermission('channels.manage'), validate({ body: connectBody }), asyncHandler(async (req, res) => {
  const tenant = await moranBuyTenant();
  if (!tenant) return res.status(409).json({ error: 'MORANBUY_NOT_REGISTERED', message: 'Register MoranBuy first.' });
  logger.info({ tenantId: tenant.id, wabaId: req.body.wabaId, phoneNumberId: req.body.phoneNumberId, signupVersion: config.meta.embeddedSignupVersion }, 'MoranBuy WhatsApp connect attempt');
  try {
    const { reason, ...body } = req.body;
    const result = await connectTenantWhatsApp(tenant.id, body);
    await audit(db, req, { action: 'moranbuy.whatsapp_connected', targetType: 'tenant', targetId: tenant.id, tenantId: tenant.id, after: { displayNumber: result.displayNumber, coexistence: !!result.coexistence }, reason });
    res.json({ connected: true, displayNumber: result.displayNumber, coexistence: !!result.coexistence });
  } catch (err) {
    const metaErr = err.response?.data?.error;
    logger.error({ tenantId: tenant.id, metaErr, err: err.message, code: err.code }, 'MoranBuy WhatsApp connect failed');
    res.status(err.status || 502).json({ error: err.code || 'CONNECT_FAILED', message: metaErr ? `Meta error ${metaErr.code}: ${metaErr.message}` : err.message });
  }
}));

/* The name MoranBuy appears under: stored on the tenant here and passed to MoranBuy, which greets customers with it. */
moranbuyAdminRouter.post('/profile', requireAdminPermission('businesses.manage'), validate({ body: z.object({ name: z.string().trim().min(2).max(60), reason: z.string().max(500).optional() }) }), asyncHandler(async (req, res) => {
  const tenant = await moranBuyTenant();
  if (!tenant) return res.status(409).json({ error: 'MORANBUY_NOT_REGISTERED', message: 'Register MoranBuy first.' });
  await db('tenants').where({ id: tenant.id }).update({ business_name: req.body.name, updated_at: db.fn.now() });
  await audit(db, req, { action: 'moranbuy.profile_name_changed', targetType: 'tenant', targetId: tenant.id, tenantId: tenant.id, before: { name: tenant.business_name }, after: { name: req.body.name }, reason: req.body.reason });
  res.json({ name: req.body.name });
}));

/*
 * Every call under /api/admin/moranbuy/api/* is forwarded to the MoranBuy service signed with the
 * shared secret and carrying this admin's email, name and role; MoranBuy audits the action under
 * that admin. Reads need businesses.read, writes businesses.manage; MoranBuy allows credential
 * changes to a super_admin only.
 */
moranbuyAdminRouter.all('/api/*', asyncHandler(async (req, res) => {
  const base = config.moranbuy.apiUrl;
  const secret = config.moranbuy.sharedSecret;
  if (!base || !secret) return res.status(503).json({ error: 'MORANBUY_NOT_CONFIGURED', message: 'Set MORANBUY_API_URL and MORANBUY_SHARED_SECRET on the backend.' });
  const perm = req.method === 'GET' ? 'businesses.read' : 'businesses.manage';
  if (!hasAdminPermission(req.admin, perm)) return res.status(403).json({ error: 'PERMISSION_DENIED', permission: perm });
  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const path = `/api/admin/${req.params[0]}${query}`;
  const rawBody = ['GET', 'HEAD'].includes(req.method) ? '' : JSON.stringify(req.body || {});
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${req.method.toUpperCase()}.${path}.${rawBody}`).digest('hex');
  let upstream;
  try {
    upstream = await fetch(`${String(base).replace(/\/+$/, '')}${path}`, {
      method: req.method,
      headers: { 'Content-Type': 'application/json', 'X-MoranBuy-Timestamp': timestamp, 'X-MoranBuy-Signature': signature, 'X-MoranBuy-Admin-Email': req.admin.email, 'X-MoranBuy-Admin-Name': req.admin.name || req.admin.email, 'X-MoranBuy-Admin-Role': req.admin.role },
      body: rawBody || undefined,
      // A test web search reads several shop pages, so it gets longer than other admin calls.
      signal: AbortSignal.timeout(path.startsWith('/api/admin/discovery/test') ? 90000 : 30000),
    });
  } catch (err) {
    return res.status(502).json({ error: 'MORANBUY_UNREACHABLE', message: err.message });
  }
  const data = await upstream.json().catch(() => ({}));
  res.status(upstream.status).json(data);
}));
