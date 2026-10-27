import './env.js';
import { db } from '../../services/api/src/db/connection.js';
import { redis } from '../../services/api/src/db/redis.js';

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
