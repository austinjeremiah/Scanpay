import { ApiError } from '../errors.js';
import { log } from '../log.js';

const AURORA = 'https://intents-api.aurora.dev';
const ONECLICK = 'https://1click.chaindefuser.com';

let auroraKey: string | undefined;
let oneClickJwt: string | undefined;
export function configureAurora(key?: string, jwt?: string) {
  auroraKey = key;
  oneClickJwt = jwt;
}
// 1Click's public endpoint serves /v0/tokens and /v0/quote without credentials — an
// unauthenticated quote comes back 400 on a bad body, not 401 — so cross-chain is
// available even with neither secret set. The Aurora key, when present, is preferred
// because it gives higher rate limits.
export const auroraEnabled = () => true;
export const providerName = (): 'aurora' | 'oneclick' => (auroraKey ? 'aurora' : 'oneclick');

function url(op: 'tokens' | 'quote' | 'submit' | 'status', qs = '') {
  if (auroraKey) {
    const path = { tokens: 'tokens', quote: 'quote', submit: 'deposit/submit', status: 'status' }[op];
    return `${AURORA}/api/${path}/${auroraKey}${qs}`;
  }
  const path = { tokens: 'tokens', quote: 'quote', submit: 'deposit/submit', status: 'status' }[op];
  return `${ONECLICK}/v0/${path}${qs}`;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (!auroraKey && oneClickJwt) h.authorization = `Bearer ${oneClickJwt}`;
  return h;
}

async function call<T>(u: string, init?: RequestInit): Promise<T> {
  const r = await fetch(u, { ...init, headers: headers(), signal: AbortSignal.timeout(12_000) });
  const text = await r.text();
  if (!r.ok) {
    log.warn({ status: r.status, body: text.slice(0, 500) }, 'intents api error');
    if (r.status === 429) throw new ApiError('RATE_LIMITED', 'Cross-chain provider rate limit');
    throw new ApiError('PROVIDER_UNAVAILABLE', `intents api ${r.status}: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text) as T;
}

export interface OriginAsset {
  assetId: string; blockchain: string; symbol: string; decimals: number;
  priceUsd: number | null; evmChainId: number | null; contractAddress: string | null;
}

export const EVM_CHAIN_IDS: Record<string, number> = { eth: 1, base: 8453, arb: 42161, op: 10, pol: 137, bsc: 56, avax: 43114 };
const ALLOWED_SYMBOLS = new Set(['USDC', 'USDT', 'ETH', 'WETH', 'BNB', 'POL', 'AVAX', 'DAI']);

let tokensCache: { at: number; assets: OriginAsset[] } | null = null;

export async function originAssets(): Promise<OriginAsset[]> {
  if (tokensCache && Date.now() - tokensCache.at < 10 * 60_000) return tokensCache.assets;
  const raw = await call<any>(url('tokens'));
  const list: any[] = Array.isArray(raw) ? raw : raw.tokens ?? [];
  const assets = list
    .filter((t) => t.blockchain !== 'monad' && EVM_CHAIN_IDS[t.blockchain] !== undefined && ALLOWED_SYMBOLS.has(String(t.symbol).toUpperCase()))
    .map((t) => ({
      assetId: t.assetId as string, blockchain: t.blockchain as string, symbol: String(t.symbol).toUpperCase(),
      decimals: Number(t.decimals), priceUsd: t.price != null ? Number(t.price) : null,
      evmChainId: EVM_CHAIN_IDS[t.blockchain] ?? null, contractAddress: t.contractAddress ?? null,
    }))
    .sort((a, b) => (a.symbol === 'USDC' ? -1 : 0) - (b.symbol === 'USDC' ? -1 : 0) || a.blockchain.localeCompare(b.blockchain));
  tokensCache = { at: Date.now(), assets };
  return assets;
}

export function evmChainIdOfAsset(assetId: string | null | undefined): number {
  if (!assetId) return 0;
  const m = assetId.match(/^nep141:([a-z]+)[-.]/) ?? assetId.match(/^simulated:([a-z]+):/);
  if (m && EVM_CHAIN_IDS[m[1]]) return EVM_CHAIN_IDS[m[1]];
  const hot = assetId.match(/^nep245:v2_1\.omni\.hot\.tg:(\d+)_/);
  if (hot) return Number(hot[1]);
  return 0;
}

export interface AuroraQuote {
  depositAddress: string | null; amountIn: bigint | null; maxAmountIn: bigint | null;
  deadline: number; timeWhenInactive: number | null; correlationId: string | null; raw: unknown;
}

export async function auroraQuote(p: {
  dry: boolean; originAsset: string; refundTo: string; recipient: string; destinationAsset: string; amountOut: bigint;
}): Promise<AuroraQuote> {
  const deadlineIso = new Date(Date.now() + 25 * 60_000).toISOString();
  const body = {
    dry: p.dry, swapType: 'EXACT_OUTPUT', slippageTolerance: 100, originAsset: p.originAsset,
    depositType: 'ORIGIN_CHAIN', destinationAsset: p.destinationAsset, amount: p.amountOut.toString(),
    refundTo: p.refundTo, refundType: 'ORIGIN_CHAIN', recipient: p.recipient, recipientType: 'DESTINATION_CHAIN',
    deadline: deadlineIso, quoteWaitingTimeMs: 3000,
  };
  const r = await call<any>(url('quote'), { method: 'POST', body: JSON.stringify(body) });
  const q = r.quote ?? {};
  const deadlineSec = q.deadline ? Math.floor(Date.parse(q.deadline) / 1000) : Math.floor(Date.parse(deadlineIso) / 1000);
  const timeWhenInactive = q.timeWhenInactive ? Math.floor(Date.parse(q.timeWhenInactive) / 1000) : null;
  return {
    depositAddress: q.depositAddress ?? null, amountIn: q.amountIn ? BigInt(q.amountIn) : null,
    maxAmountIn: q.maxAmountIn ? BigInt(q.maxAmountIn) : null,
    deadline: deadlineSec, timeWhenInactive,
    correlationId: r.correlationId ?? null, raw: r,
  };
}

export async function auroraSubmitDeposit(depositAddress: string, txHash: string) {
  return call<any>(url('submit'), { method: 'POST', body: JSON.stringify({ txHash, depositAddress }) });
}

export interface ProviderStatus {
  status: string; originTxHashes: string[]; destinationTxHashes: string[]; raw: unknown;
}

export async function auroraStatus(depositAddress: string): Promise<ProviderStatus> {
  const r = await call<any>(url('status', `?depositAddress=${encodeURIComponent(depositAddress)}`));
  const sd = r.swapDetails ?? {};
  return {
    status: r.status,
    originTxHashes: (sd.originChainTxHashes ?? []).map((x: any) => x.hash ?? x),
    destinationTxHashes: (sd.destinationChainTxHashes ?? []).map((x: any) => x.hash ?? x),
    raw: r,
  };
}
