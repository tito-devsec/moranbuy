import { shopRouter } from './routes/shop.js';
import { internalInboundRouter } from './routes/internal-inbound.js';

// Every API router with its mount path; phases append to this list.
export const routers = [
  { path: '/api/shop', router: shopRouter },
  { path: '/internal/inbound', router: internalInboundRouter },
];
