import { describe, expect, it } from 'vitest';
import { KeyRing } from './keys';

describe('KeyRing', () => {
  it('is deterministic and role-separated', () => {
    const prf = new Uint8Array(32).fill(7);
    const a = new KeyRing(prf.slice());
    const b = new KeyRing(prf.slice());
    expect(a.address('pay')).toBe(b.address('pay'));
    const set = new Set([a.address('pay'), a.address('owner'), a.address('payout'), a.address('invoice', 1), a.address('invoice', 2)]);
    expect(set.size).toBe(5);
  });
});
