import {
  hashTypedData,
  hashStruct,
  parseSignature,
  type Address,
  type Hex,
  type TypedDataDomain,
} from 'viem';
import { DOMAIN_VERSION, REGISTRY_DOMAIN_NAME, VAULT_DOMAIN_NAME } from './constants';
import type {
  InvoiceMessage,
  PaymentIntentMessage,
  PayoutUpdateMessage,
  ReceiveAuthMessage,
  RegistrationMessage,
  SignerRotationMessage,
  TokenInfo,
} from './types';

// ---------------- types (field order == Solidity type string) ----------------

export const invoiceTypes = {
  Invoice: [
    { name: 'merchantId', type: 'bytes32' },
    { name: 'invoiceId', type: 'bytes32' },
    { name: 'payoutToken', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'keyVersion', type: 'uint32' },
  ],
} as const;

export const paymentIntentTypes = {
  PaymentIntent: [
    { name: 'merchantId', type: 'bytes32' },
    { name: 'invoiceId', type: 'bytes32' },
    { name: 'payer', type: 'address' },
    { name: 'payoutToken', type: 'address' },
    { name: 'amountOut', type: 'uint256' },
    { name: 'route', type: 'uint8' },
    { name: 'inputToken', type: 'address' },
    { name: 'maxAmountIn', type: 'uint256' },
    { name: 'quoteHash', type: 'bytes32' },
    { name: 'refundTo', type: 'address' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
    { name: 'keyVersion', type: 'uint32' },
  ],
} as const;

export const registrationTypes = {
  Registration: [
    { name: 'owner', type: 'address' },
    { name: 'salt', type: 'bytes32' },
    { name: 'payoutWallet', type: 'address' },
    { name: 'invoiceSigner', type: 'address' },
    { name: 'payoutToken', type: 'address' },
    { name: 'metadataHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const;

export const signerRotationTypes = {
  SignerRotation: [
    { name: 'merchantId', type: 'bytes32' },
    { name: 'newSigner', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const;

export const payoutUpdateTypes = {
  PayoutUpdate: [
    { name: 'merchantId', type: 'bytes32' },
    { name: 'payoutWallet', type: 'address' },
    { name: 'payoutToken', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const;

export const receiveWithAuthorizationTypes = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

// ---------------- domains ----------------

export function vaultDomain(chainId: number, vault: Address) {
  return { name: VAULT_DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract: vault } as const satisfies TypedDataDomain;
}

export function registryDomain(chainId: number, registry: Address) {
  return { name: REGISTRY_DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract: registry } as const satisfies TypedDataDomain;
}

export function tokenDomain(chainId: number, token: Pick<TokenInfo, 'address' | 'eip712'>) {
  if (!token.eip712) throw new Error(`token ${token.address} has no EIP-712 domain (not 3009-capable)`);
  return {
    name: token.eip712.name,
    version: token.eip712.version,
    chainId,
    verifyingContract: token.address,
  } as const satisfies TypedDataDomain;
}

// ---------------- full typed-data payloads (pass straight to account.signTypedData) ----------------

export function buildInvoiceTypedData(chainId: number, vault: Address, message: InvoiceMessage) {
  return { domain: vaultDomain(chainId, vault), types: invoiceTypes, primaryType: 'Invoice' as const, message };
}

export function buildIntentTypedData(chainId: number, vault: Address, message: PaymentIntentMessage) {
  return { domain: vaultDomain(chainId, vault), types: paymentIntentTypes, primaryType: 'PaymentIntent' as const, message };
}

export function buildRegistrationTypedData(chainId: number, registry: Address, message: RegistrationMessage) {
  return { domain: registryDomain(chainId, registry), types: registrationTypes, primaryType: 'Registration' as const, message };
}

export function buildSignerRotationTypedData(chainId: number, registry: Address, message: SignerRotationMessage) {
  return { domain: registryDomain(chainId, registry), types: signerRotationTypes, primaryType: 'SignerRotation' as const, message };
}

export function buildPayoutUpdateTypedData(chainId: number, registry: Address, message: PayoutUpdateMessage) {
  return { domain: registryDomain(chainId, registry), types: payoutUpdateTypes, primaryType: 'PayoutUpdate' as const, message };
}

export function buildReceiveAuthTypedData(
  chainId: number,
  token: Pick<TokenInfo, 'address' | 'eip712'>,
  message: ReceiveAuthMessage,
) {
  return {
    domain: tokenDomain(chainId, token),
    types: receiveWithAuthorizationTypes,
    primaryType: 'ReceiveWithAuthorization' as const,
    message,
  };
}

/** The 3009 message for a DIRECT payment is fully determined by the intent + its digest. */
export function receiveAuthForIntent(
  intent: PaymentIntentMessage,
  intentDigestHex: Hex,
  vault: Address,
): ReceiveAuthMessage {
  return {
    from: intent.payer,
    to: vault,
    value: intent.amountOut,
    validAfter: 0n,
    validBefore: intent.expiresAt,
    nonce: intentDigestHex,
  };
}

// ---------------- digests ----------------

export const invoiceDigest = (chainId: number, vault: Address, m: InvoiceMessage): Hex =>
  hashTypedData(buildInvoiceTypedData(chainId, vault, m));

export const intentDigest = (chainId: number, vault: Address, m: PaymentIntentMessage): Hex =>
  hashTypedData(buildIntentTypedData(chainId, vault, m));

export const registrationDigest = (chainId: number, registry: Address, m: RegistrationMessage): Hex =>
  hashTypedData(buildRegistrationTypedData(chainId, registry, m));

export const signerRotationDigest = (chainId: number, registry: Address, m: SignerRotationMessage): Hex =>
  hashTypedData(buildSignerRotationTypedData(chainId, registry, m));

export const payoutUpdateDigest = (chainId: number, registry: Address, m: PayoutUpdateMessage): Hex =>
  hashTypedData(buildPayoutUpdateTypedData(chainId, registry, m));

export const receiveAuthDigest = (
  chainId: number,
  token: Pick<TokenInfo, 'address' | 'eip712'>,
  m: ReceiveAuthMessage,
): Hex => hashTypedData(buildReceiveAuthTypedData(chainId, token, m));

export const invoiceStructHash = (m: InvoiceMessage): Hex =>
  hashStruct({ data: m, primaryType: 'Invoice', types: invoiceTypes });

export const intentStructHash = (m: PaymentIntentMessage): Hex =>
  hashStruct({ data: m, primaryType: 'PaymentIntent', types: paymentIntentTypes });

// ---------------- signatures ----------------

/** 65-byte 0x signature -> {v,r,s} for IntentVault.payDirect's Auth3009 tuple. */
export function splitSignature(sig: Hex): { v: number; r: Hex; s: Hex } {
  const p = parseSignature(sig);
  const v = p.v !== undefined ? Number(p.v) : p.yParity + 27;
  return { v, r: p.r, s: p.s };
}
