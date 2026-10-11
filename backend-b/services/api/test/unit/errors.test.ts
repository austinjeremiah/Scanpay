import { describe, it, expect, beforeAll } from 'vitest';
import { ApiError, decodeChainError, setDecodeAbi, notFound } from '../../src/errors.js';
import { intentVaultAbi } from '@scanpay/shared';

describe('ApiError', () => {
  it('sets correct HTTP status for known codes', () => {
    expect(new ApiError('NOT_FOUND').httpStatus).toBe(404);
    expect(new ApiError('VALIDATION_ERROR').httpStatus).toBe(400);
    expect(new ApiError('UNAUTHORIZED').httpStatus).toBe(401);
    expect(new ApiError('INTERNAL').httpStatus).toBe(500);
  });

  it('preserves details', () => {
    const err = new ApiError('VALIDATION_ERROR', 'bad input', { field: 'amount' });
    expect(err.details).toEqual({ field: 'amount' });
    expect(err.message).toBe('bad input');
  });

  it('returns 422 for unknown codes (fallback)', () => {
    const err = new ApiError('TOTALLY_UNKNOWN_CODE_XYZ' as any);
    expect(err.httpStatus).toBe(422);
  });

  it('instanceof Error', () => {
    expect(new ApiError('NOT_FOUND')).toBeInstanceOf(Error);
  });
});

describe('notFound', () => {
  it('returns 404 ApiError', () => {
    const e = notFound('thing');
    expect(e.httpStatus).toBe(404);
    expect(e.code).toBe('NOT_FOUND');
    expect(e.message).toContain('thing');
  });
});

describe('decodeChainError', () => {
  beforeAll(() => {
    setDecodeAbi([...intentVaultAbi]);
  });

  it('returns null for empty data', () => {
    expect(decodeChainError(undefined)).toBeNull();
    expect(decodeChainError('0x')).toBeNull();
  });

  it('returns null for unknown selector', () => {
    expect(decodeChainError('0xdeadbeef')).toBeNull();
  });
});
