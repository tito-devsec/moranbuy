import { shopRouter } from './routes/shop.js';
import { internalInboundRouter } from './routes/internal-inbound.js';
import { merchantAuthRouter } from './routes/merchant-auth.js';
import { merchantRouter } from './routes/merchant.js';

// Every API router with its mount path; phases append to this list.
export const routers = [
  { path: '/api/shop', router: shopRouter },
  { path: '/internal/inbound', router: internalInboundRouter },
  { path: '/api/merchants/auth', router: merchantAuthRouter },
  { path: '/api/merchant', router: merchantRouter },
];
