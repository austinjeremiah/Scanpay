import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { zChainId } from '@scanpay/shared';
import type { Hex } from 'viem';
import { parse } from '../parse.js';
import { verifyIntent } from '../../services/verify.js';

export const verifyRoutes: FastifyPluginAsync = async (app) => {
  // GET /v1/verify/:chainId/:intentId
  app.get('/v1/verify/:chainId/:intentId', async (req) => {
    const { chainId, intentId } = parse(
      z.object({ chainId: zChainId, intentId: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }),
      (req as any).params,
    );
    return verifyIntent(chainId, intentId as Hex);
  });
};
