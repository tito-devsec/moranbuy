import { DEFAULT_SERVICE_PRICING } from '@moranbuy/billing';
import { db } from '../db/connection.js';

// Prices of the paid services as administrators set them, with the defaults filling any gap.
export async function loadServicePricing(dbImpl = db) {
  const row = await dbImpl('platform_settings').where({ key: 'service_pricing' }).first();
  return { ...DEFAULT_SERVICE_PRICING, ...(row?.value || {}) };
}
