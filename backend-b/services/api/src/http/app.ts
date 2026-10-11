import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../errors.js';
import { log } from '../log.js';
import type { Env } from '../env.js';
import { setAdminToken } from './auth.js';
import { healthRoutes } from './routes/health.js';
import { configRoutes } from './routes/config.js';
import { fxRoutes } from './routes/fx.js';
import { merchantRoutes } from './routes/merchants.js';
import { adminRoutes } from './routes/admin.js';
import { invoiceRoutes } from './routes/invoices.js';
import { paymentRoutes } from './routes/payments.js';
import { streamRoutes, setSseOrigins } from './routes/stream.js';
import { verifyRoutes } from './routes/verify.js';
import { attackRoutes } from './routes/attack.js';

export async function buildApp(env: Env) {
  setAdminToken(env.ADMIN_TOKEN);

  const app = Fastify({ logger: false, genReqId: () => randomUUID() });

  await app.register(cors, { origin: env.CORS_ORIGINS.split(',').map((s) => s.trim()), methods: ['GET', 'POST', 'OPTIONS'] });
  await app.register(rateLimit, { global: true, max: 200, timeWindow: '1 minute', keyGenerator: (req) => req.ip });

  // error handler
  app.setErrorHandler((err, req, reply) => {
    const requestId = req.id as string;
    if (err instanceof ApiError) {
      log.warn({ requestId, code: err.code, msg: err.message }, 'api error');
      return reply.code(err.httpStatus).send({ error: { code: err.code, message: err.message, details: err.details, requestId } });
    }
    if ((err as any).statusCode === 429) {
      return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'Too many requests', requestId } });
    }
    log.error({ requestId, err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId } });
  });

  app.setNotFoundHandler((req, reply) => {
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: `${req.method} ${req.url} not found`, requestId: req.id } });
  });

  await app.register(healthRoutes);
  await app.register(configRoutes, { env });
  await app.register(fxRoutes);
  await app.register(merchantRoutes);
  await app.register(adminRoutes);
  await app.register(invoiceRoutes);
  await app.register(paymentRoutes);
  setSseOrigins(env.CORS_ORIGINS.split(',').map((s) => s.trim()));
  await app.register(streamRoutes);
  await app.register(verifyRoutes);
  await app.register(attackRoutes);

  return app;
}
