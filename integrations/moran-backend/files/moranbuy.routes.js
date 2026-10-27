import express from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/async-handler.js';
import { requireAdminPermission } from '../../middleware/admin.middleware.js';
import { validate } from '../../middleware/validate.middleware.js';
import { registerMoranBuyTenant, moranBuyTenant } from '../../../services/moranbuy.service.js';
import { config } from '../../../config/index.js';

/* /api/admin/moranbuy — register the one admin-managed MoranBuy business and see its state. */
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
