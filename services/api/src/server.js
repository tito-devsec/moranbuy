import { config } from '@moranbuy/core';
import { logger } from '@moranbuy/observability';
import { createApp } from './app.js';
import { routers } from './routers.js';
import { checkDbConnection } from './db/connection.js';
import { checkRedisConnection } from './db/redis.js';

// Boots the API: validates configuration, checks dependencies, then listens.
async function main() {
  const c = config();
  const app = createApp({ routers });
  try { await checkDbConnection(); logger.info('Database connected'); } catch (err) { logger.error({ err: err.message }, 'Database not reachable'); }
  try { await checkRedisConnection(); logger.info('Redis connected'); } catch (err) { logger.error({ err: err.message }, 'Redis not reachable'); }
  app.listen(c.PORT, () => logger.info({ port: c.PORT, env: c.APP_ENV, muse: c.MUSE_PROVIDER, campaignDryRun: c.CAMPAIGN_DRY_RUN }, 'MoranBuy API listening'));
}

main().catch((err) => { logger.error({ err: err.message }, 'Failed to start'); process.exit(1); });
