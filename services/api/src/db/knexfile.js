import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();
const here = path.dirname(fileURLToPath(import.meta.url));

// Knex configuration shared by the app, the CLI and the tests.
const base = {
  client: 'pg',
  connection: process.env.DATABASE_URL,
  pool: { min: 1, max: Number(process.env.DB_POOL_MAX || 10) },
  migrations: { directory: path.join(here, 'migrations'), loadExtensions: ['.js'] },
  seeds: { directory: path.join(here, '../../../../database/seeds'), loadExtensions: ['.js'] },
};

export default base;
