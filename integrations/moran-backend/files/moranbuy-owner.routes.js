import express from 'express';
import { z } from 'zod';
import { db } from '../../db/connection.js';
import { config } from '../../config/index.js';
import { requireTenantAuth, requireOwner } from '../middleware/auth.middleware.js';
import { validateBody } from '../middleware/validate.middleware.js';
import { wrapRouterHandlers } from '../middleware/async-handler.js';

/*
 * /api/moranbuy — the owner's own MoranBuy switch (docs/moranbuy.md): whether this business's
 * products may be recommended to MoranBuy customers, and where the MoranBuy business app is.
 */
export const moranbuyOwnerRouter = express.Router();
moranbuyOwnerRouter.use(requireTenantAuth);

moranbuyOwnerRouter.get('/', async (req, res) => {
  const services = await db('services').where({ tenant_id: req.tenant.id }).whereNot('status', 'archived').select('id', 'name', 'moranbuy_listed');
  res.json({ listed: !!req.tenant.moranbuy_listed, listedAt: req.tenant.moranbuy_listed_at || null, services, businessAppUrl: config.moranbuy.apiUrl ? `${String(config.moranbuy.apiUrl).replace(/\/+$/, '')}/business/` : null });
});

const listingSchema = z.object({ listed: z.boolean(), serviceIds: z.array(z.string().uuid()).max(50).optional() });
moranbuyOwnerRouter.post('/listing', requireOwner, validateBody(listingSchema), async (req, res) => {
  await db('tenants').where({ id: req.tenant.id }).update({ moranbuy_listed: req.body.listed, moranbuy_listed_at: req.body.listed ? db.fn.now() : null, updated_at: db.fn.now() });
  if (req.body.serviceIds) {
    await db('services').where({ tenant_id: req.tenant.id }).update({ moranbuy_listed: false });
    await db('services').where({ tenant_id: req.tenant.id }).whereIn('id', req.body.serviceIds).update({ moranbuy_listed: true });
  }
  res.json({ listed: req.body.listed });
});

wrapRouterHandlers(moranbuyOwnerRouter);
