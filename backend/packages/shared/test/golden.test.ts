import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { keccak256, toBytes, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  buildIntentTypedData,
  buildInvoiceTypedData,
  buildReceiveAuthTypedData,
  buildRegistrationTypedData,
  computeIntentId,
  computeMerchantId,
  intentDigest,
  intentStructHash,
  invoiceDigest,
  invoiceStructHash,
  receiveAuthDigest,
  receiveAuthForIntent,
  registrationDigest,
  splitSignature,
  ROUTE,
  ZERO_BYTES32,
} from '../src';

const v = JSON.parse(readFileSync(resolve(__dirname, '../test-vectors/eip712.json'), 'utf8'));
const chainId = Number(v.chainId);
const payer = v.payer as Address;
const token = { address: v.token as Address, eip712: { name: v.tokenName, version: v.tokenVersion } };

const invoice = {
  merchantId: v.merchantId as Hex,
  invoiceId: keccak256(toBytes('invoice-1')),
  payoutToken: v.token as Address,
  amount: 12_000_000n,
  expiresAt: 1_800_000_000n,
  keyVersion: 3,
};

const intent = {
  merchantId: v.merchantId as Hex,
  invoiceId: invoice.invoiceId,
  payer,
  payoutToken: v.token as Address,
  amountOut: 12_000_000n,
  route: ROUTE.DIRECT,
  inputToken: v.token as Address,
  maxAmountIn: 12_000_000n,
  quoteHash: ZERO_BYTES32,
  refundTo: payer,
  expiresAt: 1_800_000_000n,
  nonce: 0xdeadbeefn,
  keyVersion: 3,
};

describe('golden vectors (Solidity == TypeScript)', () => {
  it('merchantId', () => {
    expect(computeMerchantId(v.owner, v.salt)).toBe(v.merchantId);
  });
  it('invoice struct + digest + merchant signature', async () => {
    expect(invoice.invoiceId).toBe(v.invoiceId);
    expect(invoiceStructHash(invoice)).toBe(v.invoiceStructHash);
    expect(invoiceDigest(chainId, v.vault, invoice)).toBe(v.invoiceDigest);
    const signer = privateKeyToAccount(v.merchantSignerKey);
    const sig = await signer.signTypedData(buildInvoiceTypedData(chainId, v.vault, invoice));
    expect(sig).toBe(v.merchantSig);
  });
  it('intent struct + digest + id + payer signature', async () => {
    expect(intentStructHash(intent)).toBe(v.intentStructHash);
    expect(intentDigest(chainId, v.vault, intent)).toBe(v.intentDigest);
    expect(computeIntentId(intent)).toBe(v.intentId);
    const acct = privateKeyToAccount(v.payerKey);
    expect(acct.address.toLowerCase()).toBe(payer.toLowerCase());
    const sig = await acct.signTypedData(buildIntentTypedData(chainId, v.vault, intent));
    expect(sig).toBe(v.payerSig);
  });
  it('registration digest + owner signature', async () => {
    const reg = {
      owner: v.owner as Address,
      salt: v.salt as Hex,
      payoutWallet: '0x000000000000000000000000000000000000beef' as Address,
      invoiceSigner: privateKeyToAccount(v.merchantSignerKey).address,
      payoutToken: v.token as Address,
      metadataHash: keccak256(toBytes('profile')),
      nonce: 0n,
      deadline: 1_800_000_000n,
    };
    expect(registrationDigest(chainId, v.registry, reg)).toBe(v.registrationDigest);
    const sig = await privateKeyToAccount(v.ownerKey).signTypedData(buildRegistrationTypedData(chainId, v.registry, reg));
    expect(sig).toBe(v.ownerRegSig);
  });
  it('EIP-3009 receiveWithAuthorization bound to intent digest', async () => {
    const msg = receiveAuthForIntent(intent, v.intentDigest, v.vault);
    expect(receiveAuthDigest(chainId, token, msg)).toBe(v.receiveAuthDigest);
    const sig = await privateKeyToAccount(v.payerKey).signTypedData(buildReceiveAuthTypedData(chainId, token, msg));
    expect(sig).toBe(v.receiveAuthSig);
    const { v: vv, r, s } = splitSignature(sig);
    expect([27, 28]).toContain(vv);
    expect(r).toMatch(/^0x[0-9a-f]{64}$/);
    expect(s).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
