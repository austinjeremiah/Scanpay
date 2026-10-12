import { type Abi, type Address, type Hex } from 'viem';
import type { ChainCtx } from './chains.js';
import { ApiError } from './errors.js';
import { decodeChainError } from './errors.js';
import { Mutex } from './util/mutex.js';
import { log } from './log.js';

const mutexes = new Map<number, Mutex>();
const getMutex = (chainId: number) => {
  if (!mutexes.has(chainId)) mutexes.set(chainId, new Mutex());
  return mutexes.get(chainId)!;
};

export interface RelayCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  label?: string;
  value?: bigint;
}

function throwDecoded(data: Hex | undefined): never {
  const err = decodeChainError(data);
  if (err) throw err;
  throw new ApiError('CHAIN_REVERT', 'Transaction reverted (unknown error)');
}

export async function simulate(ctx: ChainCtx, call: RelayCall) {
  try {
    await ctx.public.simulateContract({ account: ctx.operator.address, address: call.address, abi: call.abi, functionName: call.functionName, args: call.args ?? [], value: call.value });
  } catch (e: any) {
    const data = e?.cause?.data ?? e?.data;
    throwDecoded(data as Hex | undefined);
  }
}

export async function relay(ctx: ChainCtx, call: RelayCall): Promise<{ hash: Hex; receipt: any }> {
  return getMutex(ctx.chainId).run(async () => {
    await simulate(ctx, call);
    let gasEstimate: bigint;
    try {
      gasEstimate = await ctx.public.estimateContractGas({ account: ctx.operator.address, address: call.address, abi: call.abi, functionName: call.functionName, args: call.args ?? [], value: call.value });
    } catch (e: any) {
      const data = e?.cause?.data ?? e?.data;
      throwDecoded(data as Hex | undefined);
    }
    const gas = (gasEstimate! * 12n + 9n) / 10n;
    const hash = await (ctx.wallet as any).writeContract({ address: call.address, abi: call.abi, functionName: call.functionName, args: call.args ?? [], gas, value: call.value });
    log.info({ chainId: ctx.chainId, label: call.label, hash }, 'relay tx sent');
    const receipt = await ctx.public.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      log.warn({ chainId: ctx.chainId, hash, status: receipt.status }, 'relay tx reverted');
      throw new ApiError('CHAIN_REVERT', 'Transaction reverted on-chain');
    }
    return { hash, receipt };
  });
}

export interface BroadcastResult {
  outcome: 'BLOCKED' | 'NOT_BLOCKED';
  observed: { errorName: string | null; apiCode: string | null; message: string };
  txHash: Hex | null;
}

export async function broadcastExpectRevert(ctx: ChainCtx, call: RelayCall, broadcast: boolean): Promise<BroadcastResult> {
  // First try simulation — fast path for blocking before any tx
  try {
    await ctx.public.simulateContract({ account: ctx.operator.address, address: call.address, abi: call.abi, functionName: call.functionName, args: call.args ?? [], value: call.value });
  } catch (e: any) {
    const data: Hex | undefined = e?.cause?.data ?? e?.data;
    const decoded = decodeChainError(data);
    return {
      outcome: 'BLOCKED',
      observed: { errorName: decoded?.errorName ?? null, apiCode: decoded?.code ?? null, message: decoded?.message ?? `simulate reverted: ${String(e?.message ?? e)}` },
      txHash: null,
    };
  }

  if (!broadcast) {
    return { outcome: 'NOT_BLOCKED', observed: { errorName: null, apiCode: null, message: 'simulation did not revert' }, txHash: null };
  }

  // broadcast path
  const mutex = getMutex(ctx.chainId);
  const release = await mutex.acquire();
  try {
    let gas = 500_000n;
    try {
      const est = await ctx.public.estimateContractGas({ account: ctx.operator.address, address: call.address, abi: call.abi, functionName: call.functionName, args: call.args ?? [], value: call.value });
      gas = (est * 12n + 9n) / 10n;
    } catch { /* use default */ }
    const hash = await (ctx.wallet as any).writeContract({ address: call.address, abi: call.abi, functionName: call.functionName, args: call.args ?? [], gas, value: call.value }) as Hex;
    const receipt = await ctx.public.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      return { outcome: 'BLOCKED', observed: { errorName: null, apiCode: null, message: 'tx reverted on-chain' }, txHash: hash };
    }
    return { outcome: 'NOT_BLOCKED', observed: { errorName: null, apiCode: null, message: 'tx succeeded (attack not blocked)' }, txHash: hash };
  } finally {
    release();
  }
}

export async function sendNative(ctx: ChainCtx, to: Address, amount: bigint, label: string): Promise<{ hash: Hex }> {
  return getMutex(ctx.chainId).run(async () => {
    const hash = await (ctx.wallet as any).sendTransaction({ to, value: amount });
    log.info({ chainId: ctx.chainId, label, to, amount: amount.toString(), hash }, 'native send');
    await ctx.public.waitForTransactionReceipt({ hash });
    return { hash };
  });
}
