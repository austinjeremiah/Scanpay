#!/usr/bin/env tsx
/**
 * Pay an invoice via SWAP route (MON → USDC) from a test payer.
 * Usage: tsx --env-file=../../.env scripts/dev-pay-swap.ts <shortCode> [payerKey] [inputTokenKey]
 */
import { loadEnv } from '../src/env.js';
import { connectDb } from '../src/db/connect.js';
import { initChains, chainCtx } from '../src/chains.js';
import { prepare } from '../src/services/intents.js';
import { submit } from '../src/services/submit.js';
import { faucet } from '../src/services/wallet.js';
import { buildIntentTypedData, fromWireIntent, type TokenKey } from '@scanpay/shared';
import { createWalletClient, http } from 'viem';
import { foundry } from 'viem/chains';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const [shortCode, rawKey, rawTokenKey] = process.argv.slice(2);
if (!shortCode) { console.error('Usage: dev-pay-swap.ts <shortCode> [payerKey] [inputTokenKey]'); process.exit(1); }

const env = loadEnv();
await connectDb(env.MONGODB_URI);
initChains(env);
const chainId = env.ENABLED_CHAINS[0];
const ctx = chainCtx(chainId);

const payerKey = (rawKey ?? generatePrivateKey()) as `0x${string}`;
const payer = privateKeyToAccount(payerKey);
const wallet = createWalletClient({ account: payer, chain: foundry, transport: http(env.LOCAL_RPC) });
console.log('Payer:', payer.address, '(key:', payerKey, ')');

await faucet(ctx, payer.address);
console.log('Faucet dripped');

const inputTokenKey = (rawTokenKey ?? 'MON') as TokenKey;
const prep = await prepare({ shortCode, route: 'SWAP', payer: payer.address as any, inputTokenKey });
console.log('Draft:', prep.draftId, 'intentId:', prep.intentId);

if (prep.swap?.needsApproval) {
  const { erc20Abi } = await import('@scanpay/shared');
  await wallet.writeContract({ chain: foundry, account: payer, address: prep.intent.inputToken as any, abi: erc20Abi, functionName: 'approve', args: [ctx.vault, BigInt(prep.intent.maxAmountIn) * 2n] });
  console.log('Approved vault to spend', inputTokenKey);
}

const intent = fromWireIntent(prep.intent);
const payerSig = await wallet.signTypedData({ account: payer, ...buildIntentTypedData(chainId, ctx.vault, intent) } as any);
const res = await submit({ draftId: prep.draftId, payerSig: payerSig as any });
console.log('Submit result:', JSON.stringify(res, null, 2));
process.exit(0);
