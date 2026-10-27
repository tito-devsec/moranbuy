import './env.js';
import { db } from '../../services/api/src/db/connection.js';
import { redis } from '../../services/api/src/db/redis.js';

// Applies migrations once and wipes every MoranBuy table between test files so runs never depend on order.
export async function resetDatabase() {
  await db.migrate.latest();
  const tables = ['matching_offers', 'matching_runs', 'session_messages', 'orders', 'enquiries', 'shopping_sessions', 'customers', 'listing_locations', 'listing_images', 'listings', 'merchant_locations', 'merchant_entitlements', 'merchant_users', 'refresh_tokens', 'merchants', 'audit_events', 'webhook_events', 'muse_requests', 'platform_settings', 'admin_users'];
  const existing = [];
  for (const t of tables) if (await db.schema.hasTable(t)) existing.push(t);
  if (existing.length) await db.raw(`TRUNCATE ${existing.map((t) => `"${t}"`).join(', ')} CASCADE`);
}

// Closes the connections so node:test exits cleanly.
export async function closeDatabase() {
  await db.destroy();
  redis.disconnect();
}

export { db, redis };
