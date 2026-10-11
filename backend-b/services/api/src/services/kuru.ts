import { encodeAbiParameters, getAddress, type Address, type Hex } from 'viem';
import type { ChainCtx } from '../chains.js';
import { ApiError } from '../errors.js';
import { log } from '../log.js';
import { sleep } from '../util/time.js';

type KuruQuote = { output: bigint; minOut: bigint; target: Address; callData: Hex; raw: unknown };

let token: { value: string; exp: number } | null = null;
let lastCall = 0;

async function spaced<T>(fn: () => Promise<T>): Promise<T> {
  const wait = lastCall + 1100 - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  return fn();
}

async function getKuruToken(ctx: ChainCtx): Promise<string> {
  if (token && token.exp > Date.now() + 30_000) return token.value;
  const api = ctx.deployment.external.kuruFlowApi!;
  const r = await spaced(() =>
    fetch(`${api}/api/generate-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_address: ctx.adapter }),
      signal: AbortSignal.timeout(8000),
    }),
  );
  if (!r.ok) throw new ApiError('QUOTE_FAILED', `kuru token ${r.status}`);
  const j = (await r.json()) as { token: string; expires_at?: number | string };
  const exp = j.expires_at ? (typeof j.expires_at === 'number' ? j.expires_at * 1000 : Date.parse(j.expires_at as string)) : Date.now() + 10 * 60_000;
  token = { value: j.token, exp };
  return j.token;
}

export async function kuruQuote(ctx: ChainCtx, tokenIn: Address, tokenOut: Address, amountIn: bigint, slippageBps = 50): Promise<KuruQuote> {
  if (ctx.adapterKind !== 'kuru' || !ctx.adapter) throw new ApiError('SWAP_UNAVAILABLE');
  const api = ctx.deployment.external.kuruFlowApi!;
  const bearer = await getKuruToken(ctx);
  const r = await spaced(() =>
    fetch(`${api}/api/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({
        userAddress: ctx.adapter, tokenIn: getAddress(tokenIn), tokenOut: getAddress(tokenOut),
        amount: amountIn.toString(), slippageTolerance: slippageBps,
      }),
      signal: AbortSignal.timeout(8000),
    }),
  );
  if (!r.ok) throw new ApiError('QUOTE_FAILED', `kuru quote ${r.status}`);
  const q = (await r.json()) as any;
  const to = getAddress(q.transaction?.to);
  if (!ctx.deployment.external.kuruTargets.map((x) => x.toLowerCase()).includes(to.toLowerCase())) {
    throw new ApiError('SWAP_UNAVAILABLE', `kuru target ${to} not allow-listed`);
  }
  if (q.transaction?.value && BigInt(q.transaction.value) !== 0n) throw new ApiError('SWAP_UNAVAILABLE', 'native-value quote');
  const cd = String(q.transaction.calldata);
  return { output: BigInt(q.output), minOut: BigInt(q.minOut), target: to, callData: (cd.startsWith('0x') ? cd : `0x${cd}`) as Hex, raw: q };
}

export async function kuruExactOut(ctx: ChainCtx, tokenIn: Address, tokenOut: Address, amountOut: bigint) {
  const inT = ctx.tokenByAddress(tokenIn)?.token;
  const outT = ctx.tokenByAddress(tokenOut)?.token;
  if (!inT || !outT) throw new ApiError('INPUT_TOKEN_NOT_ALLOWED');
  const outUsd = (Number(amountOut) / 10 ** outT.decimals) * outT.usdPrice;
  let guess = BigInt(Math.ceil((outUsd / inT.usdPrice) * 1.02 * 10 ** inT.decimals));
  let q = await kuruQuote(ctx, tokenIn, tokenOut, guess);
  if (q.minOut < amountOut) {
    guess = (guess * amountOut * 1010n) / (q.minOut * 1000n) + 1n;
    q = await kuruQuote(ctx, tokenIn, tokenOut, guess);
    if (q.minOut < amountOut) throw new ApiError('QUOTE_FAILED', 'kuru liquidity insufficient');
  }
  const estimatedIn = (guess * amountOut) / q.output + 1n;
  log.info({ tokenIn, tokenOut, amountOut: amountOut.toString(), maxIn: guess.toString() }, 'kuru exact-out');
  return { maxAmountIn: guess, estimatedIn, quoteId: `kuru:${q.output}:${q.minOut}` };
}

export async function kuruSwapData(ctx: ChainCtx, tokenIn: Address, tokenOut: Address, amountIn: bigint, requiredOut: bigint): Promise<Hex> {
  const q = await kuruQuote(ctx, tokenIn, tokenOut, amountIn);
  if (q.minOut < requiredOut) throw new ApiError('SWAP_OUTPUT_TOO_LOW', undefined, { minOut: q.minOut.toString(), required: requiredOut.toString() });
  return encodeAbiParameters([{ type: 'address' }, { type: 'bytes' }], [q.target, q.callData]);
}
