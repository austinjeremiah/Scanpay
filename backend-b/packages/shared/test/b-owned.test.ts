import { describe, expect, it } from 'vitest';
import { keccak256, toBytes } from 'viem';
import { canonicalJson, quoteHash, profileHash, CONTRACT_ERROR_TO_CODE, API_ERROR, zWireIntent } from '../src/index.js';

describe('canonicalJson', () => {
  it('sorts keys deeply, drops undefined, stringifies bigint', () => {
    expect(canonicalJson({ b: 1, a: { d: 2n, c: undefined, b: [3, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"b":[3,{"y":2,"z":1}],"d":"2"},"b":1}',
    );
  });
  it('is stable regardless of insertion order', () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });
  it('rejects NaN', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
  });
});

describe('quoteHash', () => {
  it('= keccak256(utf8(canonicalJson(fields)))', () => {
    const f = {
      v: 1 as const, chainId: 10143, route: 'SWAP' as const, provider: 'mock' as const, quoteId: 'mock:25000',
      inputToken: '0x0000000000000000000000000000000000000001' as const,
      payoutToken: '0x0000000000000000000000000000000000000002' as const, amountOut: '12000000',
      maxAmountIn: '482400000000000000000', depositAddress: null, recipient: null, originAsset: null,
      originAmountIn: null, deadline: 1800000000,
    };
    expect(quoteHash(f)).toBe(keccak256(toBytes(canonicalJson(f))));
    expect(quoteHash({ ...f, maxAmountIn: '1' })).not.toBe(quoteHash(f));
  });
  it('profileHash is order independent', () => {
    const p = { displayName: 'Cafe', category: 'food', city: 'Chennai', country: 'IN', logoUrl: '' };
    expect(profileHash(p)).toBe(profileHash({ logoUrl: '', country: 'IN', city: 'Chennai', category: 'food', displayName: 'Cafe' }));
  });
});

describe('error map', () => {
  it('every mapped code exists in API_ERROR', () => {
    for (const code of Object.values(CONTRACT_ERROR_TO_CODE)) expect(API_ERROR[code]).toBeDefined();
  });
  it('covers all 25 vault errors + 10 registry errors', () => {
    const vault = ['MerchantNotActive', 'KeyVersionMismatch', 'InvoiceMismatch', 'PayoutTokenMismatch', 'PayoutTokenNotAllowed',
      'AmountMismatch', 'InvoiceExpired', 'IntentExpired', 'InvalidMerchantSignature', 'InvalidPayerSignature', 'NonceAlreadyUsed',
      'InvoiceNotOpen', 'RouteMismatch', 'InputTokenNotAllowed', 'AmountAboveCap', 'Underpaid', 'SwapOutputTooLow',
      'IntentNotCommitted', 'IntentAlreadyExists', 'RefundNotYetAllowed', 'IntentNotTerminal', 'AlreadyAttested', 'NoSwapAdapter',
      'InvalidFee', 'ZeroAddress'];
    const registry = ['MerchantAlreadyExists', 'MerchantNotFound', 'MerchantIsRevoked', 'InvalidOwnerSignature',
      'InvalidPayoutSignature', 'SignatureExpired', 'BadNonce', 'PayoutTokenNotAllowed', 'ZeroAddress', 'InvalidStatusTransition'];
    for (const e of [...vault, ...registry]) expect(CONTRACT_ERROR_TO_CODE[e], e).toBeDefined();
  });
});

describe('zod wire', () => {
  it('lowercases addresses and rejects numeric uint256', () => {
    const ok = zWireIntent.parse({
      merchantId: '0x' + 'AB'.repeat(32), invoiceId: '0x' + '01'.repeat(32), payer: '0x' + 'CD'.repeat(20),
      payoutToken: '0x' + '11'.repeat(20), amountOut: '1', route: 0, inputToken: '0x' + '11'.repeat(20), maxAmountIn: '1',
      quoteHash: '0x' + '00'.repeat(32), refundTo: '0x' + 'CD'.repeat(20), expiresAt: '1', nonce: '5', keyVersion: 1,
    });
    expect(ok.payer).toBe('0x' + 'cd'.repeat(20));
    expect(() => zWireIntent.parse({ ...ok, amountOut: 1 })).toThrow();
  });
});
