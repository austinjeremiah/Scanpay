import type { FastifyReply, FastifyRequest } from 'fastify';
import { Idempotency } from '../db/models.js';

export async function withIdempotency<T>(
  req: FastifyRequest,
  reply: FastifyReply,
  useCached: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  const key = req.headers['idempotency-key'] as string | undefined;
  if (!key) return fn();

  if (useCached) {
    const existing = await Idempotency.findOne({ key }).lean();
    if (existing) {
      reply.code(existing.statusCode as number);
      return existing.response as T;
    }
  }

  const result = await fn();
  const statusCode = reply.statusCode || 200;
  await Idempotency.findOneAndUpdate({ key }, { key, response: result, statusCode }, { upsert: true }).catch(() => {});
  return result;
}
