import type { Hex } from 'viem';
import {
  buildIntentTypedData, buildReceiveAuthTypedData, fromWireIntent, fromWireInvoice, intentDigest, intentVaultAbi,
  receiveAuthForIntent, splitSignature, type zSubmitReq,
} from '@scanpay/shared';
import type { z } from 'zod';
import { chainCtx, type ChainCtx } from '../chains.js';
import { Intent, audit, type IntentDoc } from '../db/models.js';
import { ApiError } from '../errors.js';
import { relay } from '../relayer.js';
import { nowSec } from '../util/time.js';
import { applyReceipt, pushLifecycle } from './settlement.js';
import { submitSwap } from './submitSwap.js';
import { submitCrossChain } from './submitCrossChain.js';

export function submitResult(d: IntentDoc, txHash: Hex | null) {
  return {
    chainId: d.chainId, intentId: d.intentId as Hex, lifecycle: d.lifecycle as any, txHash,
    forwarder: (d.forwarder as Hex) ?? null, depositAddress: d.crosschain?.depositAddress ?? null,
  };
}

export async function submit(req: z.infer<typeof zSubmitReq>) {
  const draft = (await Intent.findOne({ draftId: req.draftId }).lean()) as IntentDoc | null;
  if (!draft) throw new ApiError('INTENT_NOT_FOUND');
  if (draft.lifecycle !== 'DRAFT') return submitResult(draft, (draft.txs?.submit ?? draft.txs?.commit ?? null) as Hex | null);
  if (draft.draftExpiresAt < nowSec()) throw new ApiError('DRAFT_EXPIRED');

  const ctx = chainCtx(draft.chainId);
  const intent = fromWireIntent(draft.intent as any);
  const invoice = fromWireInvoice(draft.invoice as any);

  const okSig = await ctx.public.verifyTypedData({
    address: intent.payer, signature: req.payerSig, ...buildIntentTypedData(ctx.chainId, ctx.vault, intent),
  } as any);
  if (!okSig) throw new ApiError('INVALID_PAYER_SIGNATURE');
  // Clear the TTL field so MongoDB doesn't delete a successfully-submitted intent
  await Intent.updateOne({ draftId: req.draftId }, { $set: { payerSig: req.payerSig, receiveAuthSig: req.receiveAuthSig ?? null }, $unset: { expireAt: '' } });

  try {
    if (draft.route === 'DIRECT') return await submitDirect(ctx, draft, intent, invoice, req);
    if (draft.route === 'SWAP') return await submitSwap(ctx, draft, intent, invoice, req.payerSig);
    return await submitCrossChain(ctx, draft, intent, invoice, req.payerSig);
  } catch (e) {
    if (e instanceof ApiError) {
      const d = await pushLifecycle(ctx.chainId, draft.intentId, 'FAILED', `${e.code}${e.errorName ? ` (${e.errorName})` : ''}`, {
        error: { code: e.code, message: e.message },
      }, ['DRAFT', 'SUBMITTED']);
      await audit('relayer', 'intent.failed', ctx.chainId, draft.intentId, { code: e.code, errorName: e.errorName });
      void d;
    }
    throw e;
  }
}

async function submitDirect(
  ctx: ChainCtx, draft: IntentDoc, intent: ReturnType<typeof fromWireIntent>, invoice: ReturnType<typeof fromWireInvoice>,
  req: z.infer<typeof zSubmitReq>,
) {
  if (!req.receiveAuthSig) throw new ApiError('VALIDATION_ERROR', 'receiveAuthSig is required for DIRECT');
  const token = ctx.tokenByAddress(intent.payoutToken)?.token;
  if (!token?.eip712) throw new ApiError('ROUTE_UNAVAILABLE');
  const msg = receiveAuthForIntent(intent, intentDigest(ctx.chainId, ctx.vault, intent), ctx.vault);
  const okAuth = await ctx.public.verifyTypedData({
    address: intent.payer, signature: req.receiveAuthSig, ...buildReceiveAuthTypedData(ctx.chainId, token, msg),
  });
  if (!okAuth) throw new ApiError('TOKEN_AUTHORIZATION_FAILED', 'Transfer authorization signature does not match');

  const { hash, receipt } = await relay(ctx, {
    address: ctx.vault, abi: intentVaultAbi, functionName: 'payDirect',
    args: [intent, invoice, draft.merchantSig, req.payerSig, splitSignature(req.receiveAuthSig)],
    label: 'payDirect',
  });
  await pushLifecycle(ctx.chainId, draft.intentId, 'SUBMITTED', 'payDirect mined', { 'txs.submit': hash }, ['DRAFT']);
  await applyReceipt(ctx, receipt);
  const d = (await Intent.findOne({ draftId: draft.draftId }).lean()) as unknown as IntentDoc;
  await audit('relayer', 'intent.direct', ctx.chainId, draft.intentId, { txHash: hash });
  return submitResult(d, hash);
}
