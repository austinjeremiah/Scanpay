import type { FastifyInstance } from 'fastify';
import { ICD_VERSION, type ConfigRes } from '@scanpay/shared';
import { allChains } from '../../chains.js';
import type { Env } from '../../env.js';

export async function configRoutes(app: FastifyInstance, opts: { env: Env }) {
  app.get('/v1/config', async (): Promise<ConfigRes> => ({
    icdVersion: ICD_VERSION,
    publicAppUrl: opts.env.PUBLIC_APP_URL,
    chains: allChains().map((c) => ({ chainId: c.chainId, deployment: c.deployment, features: c.features })),
  }));
}
