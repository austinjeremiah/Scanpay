import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zBytes32, zChainId, zCreateInvoiceReq, zInvoiceRequestReq } from '@scanpay/shared';
import { chainCtx } from '../../chains.js';
import { parse } from '../parse.js';
import { withIdempotency } from '../idempotency.js';
import {
  createInvoice, createInvoiceRequest, getInvoice, getInvoiceRequest, listInvoiceRequests, listMerchantInvoices, resolveQr,
} from '../../services/invoices.js';

export async function invoiceRoutes(app: FastifyInstance) {
  app.post('/v1/invoices', async (req, reply) =>
    withIdempotency(req, reply, false, async () => {
      const body = parse(zCreateInvoiceReq, req.body);
      reply.code(201);
      return createInvoice(chainCtx(body.chainId), body as any);
    }),
  );

  app.get('/v1/invoices/:shortCode', async (req) => {
    const p = parse(z.object({ shortCode: z.string().regex(/^[a-z0-9]{6,16}$/) }), req.params);
    return getInvoice(null, p.shortCode, chainCtx);
  });

  app.get('/v1/merchants/:chainId/:merchantId/invoices', async (req) => {
    const p = parse(z.object({ chainId: zChainId, merchantId: zBytes32 }), req.params);
    return listMerchantInvoices(chainCtx(p.chainId), p.merchantId as any);
  });

  app.post('/v1/invoice-requests', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = parse(zInvoiceRequestReq, req.body);
    reply.code(201);
    return createInvoiceRequest(chainCtx(body.chainId), body as any);
  });

  app.get('/v1/invoice-requests/:requestId', async (req) => {
    const p = parse(z.object({ requestId: z.string().min(5).max(64) }), req.params);
    return getInvoiceRequest(p.requestId);
  });

  app.get('/v1/merchants/:chainId/:merchantId/invoice-requests', async (req) => {
    const p = parse(z.object({ chainId: zChainId, merchantId: zBytes32 }), req.params);
    return listInvoiceRequests(chainCtx(p.chainId), p.merchantId as any);
  });

  app.get('/v1/qr/resolve', async (req) => {
    const q = parse(z.object({ data: z.string().min(1).max(512) }), req.query);
    return resolveQr(q.data, chainCtx);
  });
}
