#!/usr/bin/env tsx
/**
 * Register a merchant on the local chain.
 * Usage: tsx --env-file=../../.env scripts/dev-register.ts [chainId]
 */
import { loadEnv } from '../src/env.js';
import { connectDb } from '../src/db/connect.js';
import { initChains, chainCtx } from '../src/chains.js';
import { registerMerchant } from '../src/services/merchants.js';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  buildRegistrationTypedData, computeMerchantId, randomBytes32,
  type RegistrationMessage,
} from '@scanpay/shared';
import { createWalletClient, http } from 'viem';
import { foundry } from 'viem/chains';

const env = loadEnv();
await connectDb(env.MONGODB_URI);
initChains(env);

const chainId = Number(process.argv[2] ?? env.ENABLED_CHAINS[0]);
const ctx = chainCtx(chainId);

const ownerKey = generatePrivateKey();
const owner = privateKeyToAccount(ownerKey);
const wallet = createWalletClient({ account: owner, chain: foundry, transport: http(env.LOCAL_RPC) });

const nonce = await ctx.public.readContract({ address: ctx.registry, abi: (await import('@scanpay/shared')).merchantRegistryAbi, functionName: 'ownerNonce', args: [owner.address] }) as bigint;

const msg: RegistrationMessage = {
  owner: owner.address, salt: randomBytes32(), payoutWallet: owner.address, invoiceSigner: owner.address,
  payoutToken: ctx.token('USDC')!.address, metadataHash: randomBytes32(),
  nonce, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
};
const typedData = buildRegistrationTypedData(chainId, ctx.registry, msg);
const ownerSig = await wallet.signTypedData({ account: owner, ...typedData } as any);

const res = await registerMerchant(ctx, {
  chainId, registration: (await import('@scanpay/shared')).toWireRegistration(msg) as any,
  ownerSig: ownerSig as any, payoutSig: ownerSig as any,
  profile: { displayName: 'Dev Merchant', category: 'Testing', city: 'Testville', country: 'US', logoUrl: '' },
});
console.log('Registered:', JSON.stringify(res, null, 2));
console.log('Private key (save this):', ownerKey);
process.exit(0);
