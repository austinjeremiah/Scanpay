import type { FastifyInstance } from 'fastify';
import { allChains } from '../../chains.js';
import { dbUp } from '../../db/connect.js';

const started = Date.now();

export async function healthRoutes(app: FastifyInstance) {
  app.get('/healthz', async () => ({ ok: true }));

  app.get('/health', async () => {
    const chains = await Promise.all(
      allChains().map(async (c) => {
        const [block, bal] = await Promise.allSettled([
          c.public.getBlockNumber(),
          c.public.getBalance({ address: c.operator.address }),
        ]);
        return {
          chainId: c.chainId,
          block: block.status === 'fulfilled' ? block.value.toString() : null,
          operator: c.operator.address.toLowerCase(),
          operatorBalance: bal.status === 'fulfilled' ? bal.value.toString() : null,
        };
      }),
    );
    return {
      ok: dbUp() && chains.every((c) => c.block !== null),
      version: process.env.RAILWAY_GIT_COMMIT_SHA ?? 'dev',
      uptimeSec: Math.round((Date.now() - started) / 1000),
      mongo: dbUp() ? 'up' : 'down',
      chains,
    };
  });
}
