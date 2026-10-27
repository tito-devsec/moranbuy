import { logger } from '@moranbuy/observability';

// Background workers start here; campaign and follow-up workers register themselves in later phases.
export const workers = [];

async function main() {
  for (const w of workers) await w.start();
  logger.info({ workers: workers.map((w) => w.name) }, 'MoranBuy workers running');
  const stop = async () => { for (const w of workers) await w.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => { logger.error({ err: err.message }, 'Worker failed'); process.exit(1); });
