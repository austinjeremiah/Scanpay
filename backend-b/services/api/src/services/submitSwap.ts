import type { Hex } from 'viem';
import { erc20Abi, intentVaultAbi, type InvoiceMessage, type PaymentIntentMessage } from '@scanpay/shared';
import type { ChainCtx } from '../chains.js';
import { Intent, audit, type IntentDoc } from '../db/models.js';
import { ApiError } from '../errors.js';
import { relay } from '../relayer.js';
import { kuruSwapData } from './kuru.js';
import { applyReceipt, pushLifecycle } from './settlement.js';
import { submitResult } from './submit.js';

export async function submitSwap(ctx: ChainCtx, draft: IntentDoc, intent: PaymentIntentMessage, invoice: InvoiceMessage, payerSig: Hex) {
  const same = intent.inputToken.toLowerCase() === intent.payoutToken.toLowerCase();
  const pullAmount = same ? intent.amountOut : intent.maxAmountIn;
  const [allowance, balance] = await Promise.all([
    ctx.public.readContract({ address: intent.inputToken, abi: erc20Abi, functionName: 'allowance', args: [intent.payer, ctx.vault] }) as Promise<bigint>,
    ctx.public.readContract({ address: intent.inputToken, abi: erc20Abi, functionName: 'balanceOf', args: [intent.payer] }) as Promise<bigint>,
  ]);
  if (allowance < pullAmount) throw new ApiError('ALLOWANCE_REQUIRED', undefined, { allowance: allowance.toString(), needed: pullAmount.toString() });
  if (balance < pullAmount) throw new ApiError('INSUFFICIENT_BALANCE', undefined, { balance: balance.toString(), needed: pullAmount.toString() });

  let swapData: Hex = '0x';
  if (!same && ctx.adapterKind === 'kuru') {
    swapData = await kuruSwapData(ctx, intent.inputToken, intent.payoutToken, intent.maxAmountIn, intent.amountOut);
  }
  const { hash, receipt } = await relay(ctx, {
    address: ctx.vault, abi: intentVaultAbi, functionName: 'paySwap',
    args: [intent, invoice, draft.merchantSig, payerSig, swapData], label: 'paySwap',
  });
  await pushLifecycle(ctx.chainId, draft.intentId, 'SUBMITTED', 'paySwap mined', { 'txs.submit': hash }, ['DRAFT']);
  await applyReceipt(ctx, receipt);
  await audit('relayer', 'intent.swap', ctx.chainId, draft.intentId, { txHash: hash });
  return submitResult((await Intent.findOne({ draftId: draft.draftId }).lean()) as unknown as IntentDoc, hash);
}
