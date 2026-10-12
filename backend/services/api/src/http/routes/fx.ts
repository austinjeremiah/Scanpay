import type { FastifyInstance } from 'fastify';
import { usdTo } from '../../services/fx.js';

export async function fxRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { quote?: string } }>('/v1/fx', async (req) => usdTo(req.query.quote ?? 'INR'));
}
