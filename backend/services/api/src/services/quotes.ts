import type { Address, Hex } from 'viem';
import {
  computeIntentId, mockSwapAdapterAbi, quoteHash, ZERO_BYTES32, intentVaultAbi,
  type QuoteHashFields, type RouteName, type TokenKey, type InvoiceMessage,
} from '@scanpay/shared';
import type { ChainCtx } from '../chains.js';
import { ApiError } from '../errors.js';
import { nowSec } from '../util/time.js';
import { kuruExactOut } from './kuru.js';
import { auroraQuote, auroraEnabled, originAssets, providerName, type OriginAsset } from './aurora.js';

export interface PricedRoute {
  route: RouteName;
  provider: QuoteHashFields['provider'] | 'none';
  inputToken: Address;
  inputTokenKey: TokenKey | null;
  amountOut: bigint;
  maxAmountIn: bigint;
  estimatedIn: bigint;
  intentExpiresAt: bigint;
  fields: QuoteHashFields | null;
  hash: Hex;
  simulated: boolean;
  crosschain: null | {
    forwarder: Address; depositAddress: string; originAssetId: string | null; originSymbol: string | null;
    originDecimals: number | null; originAmountIn: bigint | null; deadline: number; correlationId: string | null;
    mode: 'live' | 'simulated'; raw: unknown;
  };
}

const minBig = (a: bigint, b: bigint) => (a < b ? a : b);

export async function routesFor(ctx: ChainCtx, invoice: InvoiceMessage) {
  const payout = ctx.tokenByAddress(invoice.payoutToken);
  const payoutKey = payout?.key ?? null;
  const directOk = Boolean(payout?.token.roles.includes('direct') && payout.token.supports3009);
  const swapTokens = (Object.entries(ctx.deployment.tokens) as [TokenKey, NonNullable<(typeof ctx.deployment.tokens)[TokenKey]>][])
    .filter(([k, t]) => t.roles.includes('swapIn') && (k !== payoutKey || !t.supports3009))
    .filter(([k]) => k === payoutKey || ctx.adapterKind !== 'none')
    .map(([k]) => k);
  const ccKey = ctx.deployment.config.crossChainInputToken;
  const ccSameToken = ccKey !== null && ctx.token(ccKey)?.address.toLowerCase() === invoice.payoutToken.toLowerCase();
  const ccMode = ctx.features.crosschain;
  // Aurora bridge minimum is ~0.15 USDC; block cross-chain for amounts too small
  const CC_MIN = 200000n; // 0.20 USDC (6 decimals) — safe buffer above Aurora's ~0.15 minimum
  const ccTooSmall = ccMode === 'live' && invoice.amount < CC_MIN;
  const ccAvailable = ccMode !== 'off' && (ccSameToken || ctx.adapterKind !== 'none') && !ccTooSmall;
  let assets: OriginAsset[] = [];
  let ccReason: string | null = ccAvailable ? null : ccTooSmall ? 'Minimum for cross-chain is $0.20 USDC' : ccMode === 'off' ? 'Cross-chain provider not configured' : 'No swap path to payout token';
  if (ccAvailable) {
    try {
      assets = ccMode === 'live' ? await originAssets() : SIMULATED_ORIGINS;
    } catch {
      ccReason = 'Cross-chain provider unavailable';
    }
  }
  return {
    chainId: ctx.chainId,
    amountOut: invoice.amount.toString(),
    payoutTokenKey: payoutKey,
    direct: { available: directOk, tokens: directOk && payoutKey ? [payoutKey] : [], reason: directOk ? null : 'Gasless signature transfer not supported for this token' },
    swap: { available: swapTokens.length > 0, tokens: swapTokens, reason: swapTokens.length ? null : 'No swap route' },
    crosschain: { available: ccAvailable && assets.length > 0, mode: ccMode, originAssets: assets, reason: ccReason },
  };
}

export const SIMULATED_ORIGINS: OriginAsset[] = [
  { assetId: 'simulated:base:usdc', blockchain: 'base', symbol: 'USDC', decimals: 6, priceUsd: 1, evmChainId: 8453, contractAddress: null },
  { assetId: 'simulated:arb:usdc', blockchain: 'arb', symbol: 'USDC', decimals: 6, priceUsd: 1, evmChainId: 42161, contractAddress: null },
  { assetId: 'simulated:eth:eth', blockchain: 'eth', symbol: 'ETH', decimals: 18, priceUsd: 2500, evmChainId: 1, contractAddress: null },
];

export async function priceDirect(ctx: ChainCtx, invoice: InvoiceMessage): Promise<PricedRoute> {
  const payout = ctx.tokenByAddress(invoice.payoutToken);
  if (!payout?.token.supports3009 || !payout.token.roles.includes('direct')) throw new ApiError('ROUTE_UNAVAILABLE');
  return {
    route: 'DIRECT', provider: 'none', inputToken: invoice.payoutToken, inputTokenKey: payout.key, amountOut: invoice.amount,
    maxAmountIn: invoice.amount, estimatedIn: invoice.amount,
    intentExpiresAt: minBig(invoice.expiresAt, BigInt(nowSec() + 600)), fields: null, hash: ZERO_BYTES32, simulated: false,
    crosschain: null,
  };
}

export async function priceSwap(ctx: ChainCtx, invoice: InvoiceMessage, inputKey: TokenKey): Promise<PricedRoute> {
  const input = ctx.token(inputKey);
  if (!input || !input.roles.includes('swapIn')) throw new ApiError('INPUT_TOKEN_NOT_ALLOWED');
  const same = input.address.toLowerCase() === invoice.payoutToken.toLowerCase();
  let provider: QuoteHashFields['provider'];
  let maxAmountIn: bigint;
  let estimatedIn: bigint;
  let quoteId: string;
  let ttl = 300;
  if (same) {
    provider = 'none'; maxAmountIn = invoice.amount; estimatedIn = invoice.amount; quoteId = 'same-token';
  } else if (ctx.adapterKind === 'mock') {
    const [needed, rate] = await Promise.all([
      ctx.public.readContract({ address: ctx.adapter!, abi: mockSwapAdapterAbi, functionName: 'quoteIn', args: [input.address, invoice.payoutToken, invoice.amount] }) as Promise<bigint>,
      ctx.public.readContract({ address: ctx.adapter!, abi: mockSwapAdapterAbi, functionName: 'rateE18', args: [input.address, invoice.payoutToken] }) as Promise<bigint>,
    ]);
    provider = 'mock'; estimatedIn = needed; maxAmountIn = (needed * 10050n + 9999n) / 10000n; quoteId = `mock:${rate}`;
  } else if (ctx.adapterKind === 'kuru') {
    const k = await kuruExactOut(ctx, input.address, invoice.payoutToken, invoice.amount);
    provider = 'kuru'; maxAmountIn = k.maxAmountIn; estimatedIn = k.estimatedIn; quoteId = k.quoteId; ttl = 120;
  } else {
    throw new ApiError('SWAP_UNAVAILABLE');
  }
  const intentExpiresAt = minBig(invoice.expiresAt, BigInt(nowSec() + ttl));
  const fields: QuoteHashFields = {
    v: 1, chainId: ctx.chainId, route: 'SWAP', provider: provider as QuoteHashFields['provider'], quoteId,
    inputToken: input.address.toLowerCase() as Address, payoutToken: invoice.payoutToken.toLowerCase() as Address,
    amountOut: invoice.amount.toString(), maxAmountIn: maxAmountIn.toString(), depositAddress: null, recipient: null,
    originAsset: null, originAmountIn: null, deadline: Number(intentExpiresAt),
  };
  return {
    route: 'SWAP', provider, inputToken: input.address, inputTokenKey: inputKey, amountOut: invoice.amount, maxAmountIn,
    estimatedIn, intentExpiresAt, fields, hash: quoteHash(fields), simulated: provider === 'mock', crosschain: null,
  };
}

export async function priceCrossChain(
  ctx: ChainCtx,
  invoice: InvoiceMessage,
  id: { payer: Address; nonce: bigint },
  origin: { assetId: string; refundTo: string } | null,
  dry: boolean,
): Promise<PricedRoute> {
  const ccKey = ctx.deployment.config.crossChainInputToken;
  const cc = ccKey ? ctx.token(ccKey) : undefined;
  if (!cc || ctx.features.crosschain === 'off') throw new ApiError('ROUTE_UNAVAILABLE');
  const same = cc.address.toLowerCase() === invoice.payoutToken.toLowerCase();
  if (!same && ctx.adapterKind === 'none') throw new ApiError('ROUTE_UNAVAILABLE', 'No swap path from USDC to payout token');
  const maxAmountIn = same ? invoice.amount : (invoice.amount * 1003n + 999n) / 1000n;

  const intentId = computeIntentId({ merchantId: invoice.merchantId, invoiceId: invoice.invoiceId, payer: id.payer, nonce: id.nonce });
  const forwarder = (await ctx.public.readContract({
    address: ctx.vault, abi: intentVaultAbi, functionName: 'forwarderOf', args: [intentId],
  })) as Address;

  const mode = ctx.features.crosschain;
  let crosschain: NonNullable<PricedRoute['crosschain']>;
  let provider: QuoteHashFields['provider'];
  if (mode === 'live') {
    if (!origin) throw new ApiError('VALIDATION_ERROR', 'origin.assetId and origin.refundTo are required for cross-chain');
    if (!auroraEnabled()) throw new ApiError('PROVIDER_UNAVAILABLE');
    const q = await auroraQuote({
      dry, originAsset: origin.assetId, refundTo: origin.refundTo, recipient: forwarder,
      destinationAsset: ctx.deployment.external.auroraMonadUsdcAssetId!, amountOut: maxAmountIn,
    });
    const asset = (await originAssets()).find((a) => a.assetId === origin.assetId) ?? null;
    provider = providerName()!;
    crosschain = {
      forwarder, depositAddress: q.depositAddress ?? '(preview)', originAssetId: origin.assetId, originSymbol: asset?.symbol ?? null,
      originDecimals: asset?.decimals ?? null, originAmountIn: q.amountIn, deadline: q.deadline, correlationId: q.correlationId,
      mode: 'live', raw: q.raw,
    };
  } else {
    const asset = SIMULATED_ORIGINS.find((a) => a.assetId === origin?.assetId) ?? SIMULATED_ORIGINS[0];
    provider = 'simulated';
    crosschain = {
      forwarder, depositAddress: forwarder, originAssetId: asset.assetId, originSymbol: asset.symbol, originDecimals: asset.decimals,
      originAmountIn: BigInt(Math.ceil((Number(maxAmountIn) / 10 ** cc.decimals / (asset.priceUsd ?? 1)) * 10 ** asset.decimals)),
      deadline: nowSec() + 20 * 60, correlationId: `sim:${intentId}`, mode: 'simulated', raw: null,
    };
  }
  const intentExpiresAt = BigInt(crosschain.deadline);
  const fields: QuoteHashFields = {
    v: 1, chainId: ctx.chainId, route: 'CROSSCHAIN', provider: provider as QuoteHashFields['provider'], quoteId: crosschain.correlationId ?? `sim:${intentId}`,
    inputToken: cc.address.toLowerCase() as Address, payoutToken: invoice.payoutToken.toLowerCase() as Address,
    amountOut: invoice.amount.toString(), maxAmountIn: maxAmountIn.toString(), depositAddress: crosschain.depositAddress,
    recipient: forwarder.toLowerCase() as Address, originAsset: crosschain.originAssetId,
    originAmountIn: crosschain.originAmountIn?.toString() ?? null, deadline: crosschain.deadline,
  };
  return {
    route: 'CROSSCHAIN', provider, inputToken: cc.address, inputTokenKey: ccKey, amountOut: invoice.amount, maxAmountIn,
    estimatedIn: maxAmountIn, intentExpiresAt, fields, hash: quoteHash(fields), simulated: mode === 'simulated', crosschain,
  };
}
