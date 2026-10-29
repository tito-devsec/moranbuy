import { merchantUploadsRouter, mediaRouter } from './routes/uploads.js';
import { shopRouter } from './routes/shop.js';
import { internalInboundRouter } from './routes/internal-inbound.js';
import { merchantAuthRouter } from './routes/merchant-auth.js';
import { merchantRouter } from './routes/merchant.js';
import { campaignsRouter } from './routes/campaigns.js';
import { followupRouter } from './routes/followup.js';
import { contactsRouter } from './routes/contacts.js';
import { paymentsWebhookRouter, sandboxRouter } from './routes/payments-webhook.js';
import { adminProtectionRouter } from './routes/admin-protection.js';
import { adminRouter } from './routes/admin.js';

// Every API router with its mount path; phases append to this list.
export const routers = [
  { path: '/api/shop', router: shopRouter },
  { path: '/internal/inbound', router: internalInboundRouter },
  { path: '/api/merchants/auth', router: merchantAuthRouter },
  { path: '/api/merchant/uploads', router: merchantUploadsRouter },
  { path: '/media', router: mediaRouter },
  { path: '/api/merchant', router: merchantRouter },
  { path: '/api/merchant/campaigns', router: campaignsRouter },
  { path: '/api/merchant/followup', router: followupRouter },
  { path: '/api/merchant/contacts', router: contactsRouter },
  { path: '/webhooks', router: paymentsWebhookRouter },
  { path: '/api/sandbox', router: sandboxRouter },
  { path: '/api/admin', router: adminProtectionRouter },
  { path: '/api/admin', router: adminRouter },
];
