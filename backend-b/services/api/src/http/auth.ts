import type { FastifyRequest } from 'fastify';
import { ApiError } from '../errors.js';

let adminToken = '';
export const setAdminToken = (t: string) => { adminToken = t; };

export function requireAdmin(req: FastifyRequest): void {
  const auth = req.headers['authorization'] ?? '';
  const token = String(auth).startsWith('Bearer ') ? String(auth).slice(7) : '';
  if (!token || token !== adminToken) throw new ApiError('UNAUTHORIZED');
}
