import { loadEnv } from './env.js';
import { log } from './log.js';
import { connectDb } from './db/connect.js';
import { initChains } from './chains.js';
import { buildApp } from './http/app.js';
import { setPublicAppUrl } from './services/invoices.js';
import { setEnvioUrl } from './services/envio.js';
import { configureAurora } from './services/aurora.js';
import { startWorker, stopWorker } from './worker/index.js';

async function main() {
  const env = loadEnv();
  log.info({ chains: env.ENABLED_CHAINS, port: env.PORT }, 'scanpay api booting');

  await connectDb(env.MONGODB_URI);
  log.info('mongodb connected');

  initChains(env);
  log.info({ chains: env.ENABLED_CHAINS }, 'chains initialized');

  setPublicAppUrl(env.PUBLIC_APP_URL);
  if (env.ENVIO_GRAPHQL_URL) setEnvioUrl(env.ENVIO_GRAPHQL_URL);
  configureAurora(env.AURORA_API_KEY, env.ONECLICK_JWT);

  const app = await buildApp(env);
  const address = await app.listen({ port: env.PORT, host: '0.0.0.0' });
  log.info({ address }, 'http server listening');

  startWorker();

  const shutdown = async (sig: string) => {
    log.info({ sig }, 'shutdown signal received');
    stopWorker();
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  log.error({ err }, 'fatal startup error');
  process.exit(1);
});
