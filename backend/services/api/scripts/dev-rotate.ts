#!/usr/bin/env tsx
/**
 * Rotate the invoice signer for a merchant.
 * Usage: tsx --env-file=../../.env scripts/dev-rotate.ts <merchantId> <ownerKey> [newSignerKey] [chainId]
 */
import { loadEnv } from '../src/env.js';
import { connectDb } from '../src/db/connect.js';
import { initChains, chainCtx } from '../src/chains.js';
import { rotateSigner } from '../src/services/merchants.js';
import { buildSignerRotationTypedData, merchantRegistryAbi, toWireSignerRotation, type SignerRotationMessage } from '@scanpay/shared';
import { createWalletClient, http } from 'viem';
import { foundry } from 'viem/chains';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const [merchantId, ownerKey, newSignerKey, rawChainId] = process.argv.slice(2);
if (!merchantId || !ownerKey) { console.error('Usage: dev-rotate.ts <merchantId> <ownerKey> [newSignerKey]'); process.exit(1); }

const env = loadEnv();
await connectDb(env.MONGODB_URI);
initChains(env);
const chainId = Number(rawChainId ?? env.ENABLED_CHAINS[0]);
const ctx = chainCtx(chainId);

const owner = privateKeyToAccount(ownerKey as `0x${string}`);
const wallet = createWalletClient({ account: owner, chain: foundry, transport: http(env.LOCAL_RPC) });
const newSigner = privateKeyToAccount((newSignerKey ?? generatePrivateKey()) as `0x${string}`);
console.log('New signer:', newSigner.address);

const nonce = await ctx.public.readContract({ address: ctx.registry, abi: merchantRegistryAbi, functionName: 'ownerNonce', args: [owner.address] }) as bigint;
const msg: SignerRotationMessage = {
  merchantId: merchantId as `0x${string}`, newSigner: newSigner.address,
  nonce, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
};
const sig = await wallet.signTypedData({ account: owner, ...buildSignerRotationTypedData(chainId, ctx.registry, msg) } as any);
const res = await rotateSigner(ctx, { chainId, rotation: toWireSignerRotation(msg) as any, ownerSig: sig as any });
console.log('Rotated:', JSON.stringify(res, null, 2));
process.exit(0);
