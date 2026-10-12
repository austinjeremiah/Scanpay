import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zRegisterReq, zRotateReq, zPayoutReq, zAddress, zBytes32, zChainId } from '@scanpay/shared';
import { chainCtx } from '../../chains.js';
import { parse } from '../parse.js';
import { withIdempotency } from '../idempotency.js';
import { registerMerchant, rotateSigner, updatePayout } from '../../services/merchants.js';
import { getMerchantOr404, merchantKeys, merchantPayments, merchantsByOwner, merchantStats, protocolStats } from '../../services/merchantReads.js';

export async function merchantRoutes(app: FastifyInstance) {
  app.post('/v1/merchants/register', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) =>
    withIdempotency(req, reply, false, async () => {
      const body = parse(zRegisterReq, req.body);
      return registerMerchant(chainCtx(body.chainId), body as any);
    }),
  );

  app.post('/v1/merchants/rotate-signer', async (req, reply) =>
    withIdempotency(req, reply, false, async () => {
      const body = parse(zRotateReq, req.body);
      return rotateSigner(chainCtx(body.chainId), body as any);
    }),
  );

  app.post('/v1/merchants/update-payout', async (req, reply) =>
    withIdempotency(req, reply, false, async () => {
      const body = parse(zPayoutReq, req.body);
      return updatePayout(chainCtx(body.chainId), body as any);
    }),
  );

  const P = z.object({ chainId: zChainId, merchantId: zBytes32 });

  app.get('/v1/merchants/by-owner/:chainId/:owner', async (req) => {
    const p = parse(z.object({ chainId: zChainId, owner: zAddress }), req.params);
    return merchantsByOwner(chainCtx(p.chainId), p.owner as any);
  });

  app.get('/v1/merchants/:chainId/:merchantId', async (req) => {
    const p = parse(P, req.params);
    return getMerchantOr404(chainCtx(p.chainId), p.merchantId as any);
  });

  app.get('/v1/merchants/:chainId/:merchantId/payments', async (req) => {
    const p = parse(P, req.params);
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), offset: z.coerce.number().int().min(0).default(0) }), req.query);
    return merchantPayments(chainCtx(p.chainId), p.merchantId as any, q.limit ?? 25, q.offset ?? 0);
  });

  app.get('/v1/merchants/:chainId/:merchantId/stats', async (req) => {
    const p = parse(P, req.params);
    const q = parse(z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }), req.query);
    return merchantStats(chainCtx(p.chainId), p.merchantId as any, q.days ?? 30);
  });

  app.get('/v1/merchants/:chainId/:merchantId/keys', async (req) => {
    const p = parse(P, req.params);
    return merchantKeys(chainCtx(p.chainId), p.merchantId as any);
  });

  app.get('/v1/stats/:chainId', async (req) => {
    const p = parse(z.object({ chainId: zChainId }), req.params);
    return protocolStats(chainCtx(p.chainId));
  });
}
