import type { Address, Hex } from 'viem';
import { intentVaultAbi, mockStableTokenAbi, type InvoiceMessage, type PaymentIntentMessage } from '@scanpay/shared';
import { chainCtx, type ChainCtx } from '../chains.js';
import { Intent, audit, type IntentDoc } from '../db/models.js';
import { ApiError } from '../errors.js';
import { relay } from '../relayer.js';
import { auroraSubmitDeposit } from './aurora.js';
import { intentView } from './views.js';
import { applyReceipt, pushLifecycle } from './settlement.js';
import { submitResult } from './submit.js';

export async function submitCrossChain(ctx: ChainCtx, draft: IntentDoc, intent: PaymentIntentMessage, invoice: InvoiceMessage, payerSig: Hex) {
  const { hash, receipt } = await relay(ctx, {
    address: ctx.vault, abi: intentVaultAbi, functionName: 'commitCrossChain',
    args: [intent, invoice, draft.merchantSig, payerSig], label: 'commitCrossChain',
  });
  await pushLifecycle(ctx.chainId, draft.intentId, 'COMMITTED', 'commitCrossChain mined', { 'txs.commit': hash }, ['DRAFT']);
  await applyReceipt(ctx, receipt);
  await audit('relayer', 'intent.commit', ctx.chainId, draft.intentId, { txHash: hash });
  return submitResult((await Intent.findOne({ draftId: draft.draftId }).lean()) as unknown as IntentDoc, hash);
}

const OPEN = ['AWAITING_DEPOSIT', 'PROCESSING', 'UNDERPAID', 'RECONCILIATION_REQUIRED', 'EXPIRED'];

export async function simulateDeposit(chainId: number, intentId: Hex, amount?: bigint) {
  const ctx = chainCtx(chainId);
  if (ctx.isMainnet) throw new ApiError('TESTNET_ONLY');
  const d = (await Intent.findOne({ chainId, intentId: intentId.toLowerCase() }).lean()) as IntentDoc | null;
  if (!d) throw new ApiError('INTENT_NOT_FOUND');
  if (d.route !== 'CROSSCHAIN' || d.crosschain?.mode !== 'simulated') throw new ApiError('WRONG_STATE', 'Not a simulated cross-chain payment');
  if (!OPEN.includes(d.lifecycle)) throw new ApiError('WRONG_STATE');
  const value = amount ?? BigInt(d.intent.maxAmountIn);
  const { hash } = await relay(ctx, {
    address: d.intent.inputToken as Address, abi: mockStableTokenAbi, functionName: 'mint', args: [d.forwarder as Address, value],
    label: 'simulated solver delivery',
  });
  await pushLifecycle(chainId, intentId, 'PROCESSING', `simulated solver delivered ${value} to forwarder`, {
    'crosschain.destinationTxHashes': [hash],
  }, ['AWAITING_DEPOSIT', 'UNDERPAID']);
  await audit('relayer', 'intent.simulateDeposit', chainId, intentId, { txHash: hash, amount: value.toString() });
  return { txHash: hash };
}

export async function postSourceTx(chainId: number, intentId: Hex, txHash: string) {
  const ctx = chainCtx(chainId);
  const d = (await Intent.findOne({ chainId, intentId: intentId.toLowerCase() }).lean()) as IntentDoc | null;
  if (!d || d.route !== 'CROSSCHAIN') throw new ApiError('INTENT_NOT_FOUND');
  if (!OPEN.includes(d.lifecycle)) throw new ApiError('WRONG_STATE');
  await Intent.updateOne({ _id: d._id }, { $set: { 'crosschain.userSourceTx': txHash } });
  let providerStatus: string | null = d.crosschain?.providerStatus ?? null;
  if (d.crosschain?.mode === 'live' && d.crosschain.depositAddress) {
    const r = await auroraSubmitDeposit(d.crosschain.depositAddress, txHash);
    providerStatus = r?.status ?? providerStatus;
  }
  await pushLifecycle(chainId, intentId, 'PROCESSING', `customer submitted source tx ${txHash.slice(0, 12)}…`, {}, ['AWAITING_DEPOSIT']);
  void ctx;
  return { ok: true, providerStatus };
}

export async function readIntent(chainId: number, intentId: Hex) {
  const ctx = chainCtx(chainId);
  const d = (await Intent.findOne({ chainId, intentId: intentId.toLowerCase() }).lean()) as IntentDoc | null;
  if (!d) throw new ApiError('INTENT_NOT_FOUND');
  return intentView(ctx, d);
}
