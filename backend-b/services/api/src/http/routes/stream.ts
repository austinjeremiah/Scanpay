import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { zChainId } from '@scanpay/shared';
import { channel, subscribe } from '../../bus.js';
import { parse } from '../parse.js';
import type { SseEvent } from '@scanpay/shared';

let SSE_ORIGINS: string[] = ['*'];
export function setSseOrigins(origins: string[]) { SSE_ORIGINS = origins; }

async function openSse(reply: FastifyReply, req: FastifyRequest, ch: string) {
  const origin = (req.headers['origin'] as string | undefined) ?? '';
  const allowed = SSE_ORIGINS.includes('*') || SSE_ORIGINS.some((o) => o === origin);
  void reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': allowed ? origin || '*' : 'null',
  });

  const send = (ev: SseEvent) => {
    if (reply.raw.destroyed) return;
    reply.raw.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  };
  send({ type: 'ping', at: Math.floor(Date.now() / 1000) });

  const unsub = subscribe(ch, send);
  const ping = setInterval(() => send({ type: 'ping', at: Math.floor(Date.now() / 1000) }), 25_000);
  req.raw.on('close', () => { unsub(); clearInterval(ping); });
  await new Promise(() => {});
}

export const streamRoutes: FastifyPluginAsync = async (app) => {
  // GET /v1/stream/intent/:chainId/:intentId
  app.get('/v1/stream/intent/:chainId/:intentId', async (req, reply) => {
    const { chainId, intentId } = parse(
      z.object({ chainId: zChainId, intentId: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }),
      (req as any).params,
    );
    return openSse(reply, req, channel.intent(chainId, intentId));
  });

  // GET /v1/stream/merchant/:chainId/:merchantId
  app.get('/v1/stream/merchant/:chainId/:merchantId', async (req, reply) => {
    const { chainId, merchantId } = parse(
      z.object({ chainId: zChainId, merchantId: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }),
      (req as any).params,
    );
    return openSse(reply, req, channel.merchant(chainId, merchantId));
  });

  // GET /v1/stream/invoice/:shortCode
  app.get('/v1/stream/invoice/:shortCode', async (req, reply) => {
    const { shortCode } = parse(z.object({ shortCode: z.string().min(4) }), (req as any).params);
    return openSse(reply, req, channel.invoice(shortCode));
  });

  // GET /v1/stream/invoice-request/:requestId
  app.get('/v1/stream/invoice-request/:requestId', async (req, reply) => {
    const { requestId } = parse(z.object({ requestId: z.string().min(4) }), (req as any).params);
    return openSse(reply, req, channel.request(requestId));
  });
};
