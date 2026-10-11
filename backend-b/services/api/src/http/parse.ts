import type { ZodType } from 'zod';
import { ApiError } from '../errors.js';

export function parse<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ApiError('VALIDATION_ERROR', issues);
  }
  return result.data;
}
