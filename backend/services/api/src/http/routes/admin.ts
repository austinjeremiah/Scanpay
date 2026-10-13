import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Hex } from 'viem';
import { zBytes32, zChainId, MERCHANT_STATUS } from '@scanpay/shared';
import { chainCtx } from '../../chains.js';
import { Merchant } from '../../db/models.js';
import { requireAdmin } from '../auth.js';
import { parse } from '../parse.js';
import { setStatus } from '../../services/merchants.js';
import { merchantView } from '../../services/views.js';
import { pushLifecycle } from '../../services/settlement.js';

const ACTIONS = { approve: MERCHANT_STATUS.ACTIVE, reactivate: MERCHANT_STATUS.ACTIVE, suspend: MERCHANT_STATUS.SUSPENDED, revoke: MERCHANT_STATUS.REVOKED } as const;

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req) => {
    if (req.url.startsWith('/v1/admin')) requireAdmin(req);
  });

  app.get('/v1/admin/merchants', async (req) => {
    const q = parse(z.object({ chainId: zChainId, status: z.string().optional() }), req.query);
    const docs = await Merchant.find({ chainId: q.chainId, ...(q.status ? { status: q.status } : {}) })
      .sort({ createdAt: -1 }).limit(200).lean();
    const ctx = chainCtx(q.chainId);
    const merchants = (await Promise.all(docs.map((d) => merchantView(ctx, d.merchantId as Hex)))).filter(Boolean);
    return { merchants };
  });

  app.post('/v1/admin/merchants/:chainId/:merchantId/:action', async (req) => {
    const p = parse(
      z.object({ chainId: zChainId, merchantId: zBytes32, action: z.enum(['approve', 'reactivate', 'suspend', 'revoke']) }),
      req.params,
    );
    return setStatus(chainCtx(p.chainId), p.merchantId as any, ACTIONS[p.action], `admin:${p.action}`);
  });

  app.post('/v1/admin/intents/:chainId/:intentId/abandon', async (req) => {
    const p = parse(z.object({ chainId: zChainId, intentId: zBytes32 }), req.params);
    const updated = await pushLifecycle(p.chainId, p.intentId as string, 'FAILED', 'admin:abandon');
    if (!updated) return { ok: false, reason: 'Intent not found or already terminal' };
    return { ok: true, intentId: p.intentId };
  });
}
