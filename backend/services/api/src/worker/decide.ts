import type { IntentDoc } from '../db/models.js';

export type Decision =
  | { action: 'settle'; swapData: `0x${string}` }
  | { action: 'refund' }
  | { action: 'wait' }
  | { action: 'attest'; sourceChainId: number; sourceTxHash: `0x${string}`; providerRef: `0x${string}` };

const REFUND_DELAY = 30 * 60;

export function decideCrossChain(d: IntentDoc, balanceWei: bigint, nowSec: number): Decision {
  const required = BigInt(d.intent.maxAmountIn ?? 0);
  const expiresAt = d.expiresAt;
  const cc = d.crosschain;

  if (d.lifecycle === 'SETTLED' || d.lifecycle === 'REFUNDED') return { action: 'wait' };

  // enough balance delivered → settle
  if (balanceWei >= required) {
    return { action: 'settle', swapData: '0x' };
  }

  // expired with delay elapsed → refund
  if (nowSec > expiresAt + REFUND_DELAY) return { action: 'refund' };

  // source attestation available but not yet submitted
  if (cc?.userSourceTx && cc.userSourceTx.startsWith('0x') && !d.txs?.attest) {
    return {
      action: 'attest',
      sourceChainId: cc.sourceChainId ?? 1,
      sourceTxHash: cc.userSourceTx as `0x${string}`,
      providerRef: '0x' + '00'.repeat(32) as `0x${string}`,
    };
  }

  return { action: 'wait' };
}
