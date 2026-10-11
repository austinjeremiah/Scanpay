import type { Address, Hex } from 'viem';
import { erc20Abi, mockStableTokenAbi, type TokenKey } from '@scanpay/shared';
import type { ChainCtx } from '../chains.js';
import { DripLog, audit } from '../db/models.js';
import { ApiError } from '../errors.js';
import { relay, sendNative } from '../relayer.js';

const DAY_MS = 24 * 3600 * 1000;
const APPROVE_GAS = 80_000n;

export async function dripAmount(ctx: ChainCtx): Promise<bigint> {
  const gp = await ctx.public.getGasPrice();
  return APPROVE_GAS * gp * 2n;
}

export async function allowanceOf(ctx: ChainCtx, token: Address, owner: Address) {
  const [allowance, balance] = await Promise.all([
    ctx.public.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, ctx.vault] }) as Promise<bigint>,
    ctx.public.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }) as Promise<bigint>,
  ]);
  return { tokenKey: ctx.tokenByAddress(token)?.key ?? null, spender: ctx.vault.toLowerCase() as Hex, allowance: allowance.toString(), balance: balance.toString() };
}

export async function gasDrip(ctx: ChainCtx, address: Address, tokenKey: TokenKey) {
  const token = ctx.token(tokenKey);
  if (!token?.roles.includes('swapIn')) throw new ApiError('INPUT_TOKEN_NOT_ALLOWED');
  const allowance = (await ctx.public.readContract({ address: token.address, abi: erc20Abi, functionName: 'allowance', args: [address, ctx.vault] })) as bigint;
  if (allowance > 10n ** 30n) throw new ApiError('DRIP_NOT_NEEDED', 'Already approved');
  const need = await dripAmount(ctx);
  const bal = await ctx.public.getBalance({ address });
  if (bal >= need) throw new ApiError('DRIP_NOT_NEEDED');
  const recent = await DripLog.findOne({ chainId: ctx.chainId, address: address.toLowerCase(), kind: 'gas', at: { $gt: new Date(Date.now() - DAY_MS) } });
  if (recent) throw new ApiError('FAUCET_LIMIT', 'Gas drip already used today');
  const amount = need - bal;
  const { hash } = await sendNative(ctx, address, amount, 'gas-drip');
  await DripLog.create({ chainId: ctx.chainId, address: address.toLowerCase(), kind: 'gas', txHash: hash });
  await audit('relayer', 'gas.drip', ctx.chainId, address, { amount: amount.toString(), hash });
  return { txHash: hash, amountWei: amount.toString() };
}

export async function faucet(ctx: ChainCtx, address: Address) {
  if (ctx.isMainnet || !ctx.features.faucet) throw new ApiError('TESTNET_ONLY');
  const recent = await DripLog.findOne({ chainId: ctx.chainId, address: address.toLowerCase(), kind: 'faucet', at: { $gt: new Date(Date.now() - DAY_MS) } });
  if (recent) throw new ApiError('FAUCET_LIMIT');
  const plan: Partial<Record<TokenKey, bigint>> = {};
  for (const [k, t] of Object.entries(ctx.deployment.tokens) as [TokenKey, NonNullable<(typeof ctx.deployment.tokens)[TokenKey]>][]) {
    if (!t.isMock) continue;
    plan[k] = k === 'MON' ? 2_000n * 10n ** BigInt(t.decimals) : 100n * 10n ** BigInt(t.decimals);
  }
  const txHashes: Hex[] = [];
  for (const [k, amt] of Object.entries(plan) as [TokenKey, bigint][]) {
    const { hash } = await relay(ctx, {
      address: ctx.token(k)!.address, abi: mockStableTokenAbi, functionName: 'mint', args: [address, amt], label: `faucet ${k}`,
    });
    txHashes.push(hash);
  }
  const need = await dripAmount(ctx);
  if ((await ctx.public.getBalance({ address })) < need) txHashes.push((await sendNative(ctx, address, need, 'faucet-gas')).hash);
  await DripLog.create({ chainId: ctx.chainId, address: address.toLowerCase(), kind: 'faucet', txHash: txHashes[0] });
  return { txHashes, amounts: Object.fromEntries(Object.entries(plan).map(([k, v]) => [k, v!.toString()])) };
}
