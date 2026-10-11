import type { Address, Hex } from 'viem';
import {
  computeIntentId, erc20Abi, randomNonce, toWireIntent, ROUTE, type PaymentIntentMessage, type zPrepareReq, type zQuoteReq,
} from '@scanpay/shared';
import type { z } from 'zod';
import { Intent } from '../db/models.js';
import { ApiError } from '../errors.js';
import { newId } from '../util/ids.js';
import { nowSec } from '../util/time.js';
import { loadPayable } from './payable.js';
import { priceCrossChain, priceDirect, priceSwap, routesFor, type PricedRoute } from './quotes.js';
import { dripAmount } from './wallet.js';

export async function getRoutes(shortCode: string) {
  const p = await loadPayable(shortCode);
  return { shortCode, ...(await routesFor(p.ctx, p.invoice)) };
}

export async function previewQuote(req: z.infer<typeof zQuoteReq>) {
  const p = await loadPayable(req.shortCode);
  let priced: PricedRoute;
  if (req.route === 'DIRECT') priced = await priceDirect(p.ctx, p.invoice);
  else if (req.route === 'SWAP') {
    if (!req.inputTokenKey) throw new ApiError('VALIDATION_ERROR', 'inputTokenKey required for SWAP');
    priced = await priceSwap(p.ctx, p.invoice, req.inputTokenKey);
  } else {
    priced = await priceCrossChain(
      p.ctx, p.invoice, { payer: req.payer, nonce: 0n },
      req.originAssetId ? { assetId: req.originAssetId, refundTo: req.payer } : null, true,
    );
  }
  return {
    route: priced.route, provider: priced.provider, inputToken: priced.inputToken.toLowerCase(), inputTokenKey: priced.inputTokenKey,
    amountOut: priced.amountOut.toString(), maxAmountIn: priced.maxAmountIn.toString(), estimatedIn: priced.estimatedIn.toString(),
    originAssetId: priced.crosschain?.originAssetId ?? null, originAmountIn: priced.crosschain?.originAmountIn?.toString() ?? null,
    expiresAt: Number(priced.intentExpiresAt), feeBps: p.ctx.deployment.config.feeBps, simulated: priced.simulated,
  };
}

export async function prepare(req: z.infer<typeof zPrepareReq>) {
  const p = await loadPayable(req.shortCode);
  const { ctx, invoice } = p;
  const nonce = randomNonce();
  const payer = req.payer as Address;

  let priced: PricedRoute;
  if (req.route === 'DIRECT') priced = await priceDirect(ctx, invoice);
  else if (req.route === 'SWAP') {
    if (!req.inputTokenKey) throw new ApiError('VALIDATION_ERROR', 'inputTokenKey required for SWAP');
    priced = await priceSwap(ctx, invoice, req.inputTokenKey);
  } else {
    priced = await priceCrossChain(ctx, invoice, { payer, nonce }, req.origin ?? null, false);
  }
  if (Number(priced.intentExpiresAt) < nowSec() + 60) throw new ApiError('INVOICE_EXPIRED', 'Not enough time left to pay this invoice');

  const intent: PaymentIntentMessage = {
    merchantId: invoice.merchantId,
    invoiceId: invoice.invoiceId,
    payer,
    payoutToken: invoice.payoutToken,
    amountOut: invoice.amount,
    route: ROUTE[req.route],
    inputToken: priced.inputToken,
    maxAmountIn: priced.maxAmountIn,
    quoteHash: priced.hash,
    refundTo: payer,
    expiresAt: priced.intentExpiresAt,
    nonce,
    keyVersion: invoice.keyVersion,
  };
  const intentId = computeIntentId(intent).toLowerCase() as Hex;
  const draftId = newId('drf');
  const now = nowSec();

  let swap: null | { spender: Hex; allowance: string; needsApproval: boolean; dripAvailable: boolean } = null;
  if (req.route === 'SWAP') {
    const allowance = (await ctx.public.readContract({
      address: priced.inputToken, abi: erc20Abi, functionName: 'allowance', args: [payer, ctx.vault],
    })) as bigint;
    const needsApproval = allowance < priced.maxAmountIn;
    const nativeBal = needsApproval ? await ctx.public.getBalance({ address: payer }) : 0n;
    swap = {
      spender: ctx.vault.toLowerCase() as Hex,
      allowance: allowance.toString(),
      needsApproval,
      dripAvailable: needsApproval && nativeBal < (await dripAmount(ctx)),
    };
  }

  const cc = priced.crosschain;
  await Intent.create({
    draftId, chainId: ctx.chainId, intentId, route: req.route, lifecycle: 'DRAFT', shortCode: req.shortCode,
    merchantId: invoice.merchantId.toLowerCase(), invoiceId: invoice.invoiceId.toLowerCase(), payer: payer.toLowerCase(),
    intent: toWireIntent(intent), invoice: p.doc.invoice, merchantSig: p.merchantSig,
    quote: priced.fields ? { fields: priced.fields, hash: priced.hash, simulated: priced.simulated } : null,
    forwarder: cc?.forwarder.toLowerCase() ?? null,
    crosschain: cc ? {
      mode: cc.mode, provider: priced.provider, depositAddress: cc.depositAddress, originAssetId: cc.originAssetId ?? undefined,
      originSymbol: cc.originSymbol ?? undefined, originDecimals: cc.originDecimals ?? undefined,
      originAmountIn: cc.originAmountIn?.toString(), deadline: cc.deadline, correlationId: cc.correlationId ?? undefined,
      providerStatus: cc.mode === 'live' ? 'PENDING_DEPOSIT' : undefined, originTxHashes: [], destinationTxHashes: [],
    } : undefined,
    expiresAt: Number(intent.expiresAt),
    draftExpiresAt: Math.min(Number(intent.expiresAt) - 30, now + 10 * 60),
    expireAt: new Date(Math.min(Number(intent.expiresAt) - 30, now + 10 * 60) * 1000),
    timeline: [{ at: now, status: 'DRAFT', note: `prepared ${req.route}${priced.simulated ? ' (simulated provider)' : ''}` }],
  });

  const payoutToken = ctx.tokenByAddress(invoice.payoutToken)?.token;
  return {
    draftId, chainId: ctx.chainId, intentId, vault: ctx.vault.toLowerCase() as Hex,
    intent: toWireIntent(intent), invoice: p.doc.invoice, merchantSig: p.merchantSig,
    quote: priced.fields ? { fields: priced.fields, hash: priced.hash, simulated: priced.simulated } : null,
    signing: {
      intent: true as const,
      receiveAuth: req.route === 'DIRECT' && payoutToken?.eip712
        ? { token: invoice.payoutToken.toLowerCase() as Hex, domain: payoutToken.eip712 }
        : null,
    },
    swap,
    crosschain: cc ? {
      mode: cc.mode, forwarder: cc.forwarder.toLowerCase() as Hex, depositAddress: cc.depositAddress,
      originAssetId: cc.originAssetId, originSymbol: cc.originSymbol, originAmountIn: cc.originAmountIn?.toString() ?? null,
      originDecimals: cc.originDecimals, deadline: cc.deadline,
    } : null,
    expiresAt: Number(intent.expiresAt),
  };
}
