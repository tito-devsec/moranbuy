import './env.js';
import { db } from '../../services/api/src/db/connection.js';
import { redis } from '../../services/api/src/db/redis.js';
import { setOutboundImageFetchForTests } from '../../services/api/src/services/outbound-image.js';

// Product photos are fetched by MoranBuy before WhatsApp gets them; in tests every https photo answers with a tiny JPEG.
setOutboundImageFetchForTests(async () => new Response(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]), { status: 200, headers: { 'content-type': 'image/jpeg' } }));

// Applies migrations once and wipes every MoranBuy table between test files so runs never depend on order.
export async function resetDatabase() {
  await db.migrate.latest();
  const rows = await db('pg_tables').where({ schemaname: 'public' }).whereNotIn('tablename', ['knex_migrations', 'knex_migrations_lock']).pluck('tablename');
  if (rows.length) await db.raw(`TRUNCATE ${rows.map((t) => `"${t}"`).join(', ')} CASCADE`);
}

// Closes the connections so node:test exits cleanly.
export async function closeDatabase() {
  await db.destroy();
  redis.disconnect();
}

export { db, redis };
