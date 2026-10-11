import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { zChainId, zScenarioId, zAttackRunReq } from '@scanpay/shared';
import { parse } from '../parse.js';
import { SCENARIO_INFO, runScenario } from '../../attack/scenarios.js';
import { chainCtx } from '../../chains.js';
import { ApiError } from '../../errors.js';

export const attackRoutes: FastifyPluginAsync = async (app) => {
  // GET /v1/attack/scenarios
  app.get('/v1/attack/scenarios', async () => {
    return { scenarios: SCENARIO_INFO };
  });

  // POST /v1/attack/run
  app.post('/v1/attack/run', async (req) => {
    const body = parse(zAttackRunReq, (req as any).body);
    const ctx = chainCtx(body.chainId);
    if (!ctx.features.attackLab) throw new ApiError('ATTACK_LAB_DISABLED', 'Attack lab is not enabled on this chain');
    return runScenario(body.chainId, body.scenario, body.broadcast ?? false);
  });

  // GET /v1/attack/lab/:chainId
  app.get('/v1/attack/lab/:chainId', async (req) => {
    const { chainId } = parse(z.object({ chainId: zChainId }), (req as any).params);
    const ctx = chainCtx(chainId);
    if (!ctx.features.attackLab) throw new ApiError('ATTACK_LAB_DISABLED');
    const { getLab } = await import('../../attack/lab.js');
    const lab = await getLab(chainId);
    return {
      chainId,
      merchant: { address: lab.merchant.account.address },
      payer: { address: lab.payer.account.address },
      merchantId: lab.merchantId,
      usdc: lab.usdc,
    };
  });
};
