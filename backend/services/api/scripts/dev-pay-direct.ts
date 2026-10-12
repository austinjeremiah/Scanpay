#!/usr/bin/env tsx
/**
 * Pay an invoice via DIRECT route from a test payer account.
 * Usage: tsx --env-file=../../.env scripts/dev-pay-direct.ts <shortCode> [payerKey]
 */
import { loadEnv } from '../src/env.js';
import { connectDb } from '../src/db/connect.js';
import { initChains, chainCtx } from '../src/chains.js';
import { prepare } from '../src/services/intents.js';
import { submit } from '../src/services/submit.js';
import { faucet } from '../src/services/wallet.js';
import { buildIntentTypedData, buildReceiveAuthTypedData, receiveAuthForIntent, intentDigest, fromWireIntent, fromWireInvoice } from '@scanpay/shared';
import { createWalletClient, http } from 'viem';
import { foundry } from 'viem/chains';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const [shortCode, rawKey] = process.argv.slice(2);
if (!shortCode) { console.error('Usage: dev-pay-direct.ts <shortCode> [payerKey]'); process.exit(1); }

const env = loadEnv();
await connectDb(env.MONGODB_URI);
initChains(env);
const chainId = env.ENABLED_CHAINS[0];
const ctx = chainCtx(chainId);

const payerKey = (rawKey ?? generatePrivateKey()) as `0x${string}`;
const payer = privateKeyToAccount(payerKey);
const wallet = createWalletClient({ account: payer, chain: foundry, transport: http(env.LOCAL_RPC) });
console.log('Payer:', payer.address, '(key:', payerKey, ')');

// fund payer via faucet
await faucet(ctx, payer.address);
console.log('Faucet dripped');

// prepare
const prep = await prepare({ shortCode, route: 'DIRECT', payer: payer.address as any });
console.log('Draft:', prep.draftId, 'intentId:', prep.intentId);

const intent = fromWireIntent(prep.intent);
const invoice = fromWireInvoice(prep.invoice);

const payerSig = await wallet.signTypedData({ account: payer, ...buildIntentTypedData(chainId, ctx.vault, intent) } as any);

const authToken = ctx.token('USDC') ?? ctx.token('AUSD');
const authMsg = receiveAuthForIntent(intent, intentDigest(chainId, ctx.vault, intent), ctx.vault);
const receiveAuthSig = authToken?.eip712
  ? await wallet.signTypedData({ account: payer, ...buildReceiveAuthTypedData(chainId, authToken, authMsg) } as any)
  : undefined;

const res = await submit({ draftId: prep.draftId, payerSig: payerSig as any, receiveAuthSig: receiveAuthSig as any });
console.log('Submit result:', JSON.stringify(res, null, 2));
process.exit(0);
