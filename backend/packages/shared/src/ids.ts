import { encodeAbiParameters, keccak256, toHex, type Address, type Hex } from 'viem';
import type { PaymentIntentMessage } from './types';

/** keccak256(abi.encode(owner, salt)) — matches ScanPayTypes.computeMerchantId */
export function computeMerchantId(owner: Address, salt: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [owner, salt]));
}

/** keccak256(abi.encode(merchantId, invoiceId, payer, nonce)) — matches ScanPayTypes.computeIntentId */
export function computeIntentId(i: Pick<PaymentIntentMessage, 'merchantId' | 'invoiceId' | 'payer' | 'nonce'>): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }],
      [i.merchantId, i.invoiceId, i.payer, i.nonce],
    ),
  );
}

export function randomBytes32(): Hex {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return toHex(b);
}

/** Random uint256 nonce (unordered nonces: usedNonce[payer][nonce]). */
export function randomNonce(): bigint {
  return BigInt(randomBytes32());
}
