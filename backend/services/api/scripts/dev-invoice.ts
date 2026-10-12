#!/usr/bin/env tsx
/**
 * Create a test invoice for a registered merchant.
 * Usage: tsx --env-file=../../.env scripts/dev-invoice.ts <merchantId> <ownerKey> [chainId] [amount_usdc]
 */
import { loadEnv } from '../src/env.js';
import { connectDb } from '../src/db/connect.js';
import { initChains, chainCtx } from '../src/chains.js';
import { createInvoice } from '../src/services/invoices.js';
import { buildInvoiceTypedData, randomBytes32, toWireInvoice, type InvoiceMessage } from '@scanpay/shared';
import { createWalletClient, http } from 'viem';
import { foundry } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const [merchantId, ownerKey, rawChainId, rawAmount] = process.argv.slice(2);
if (!merchantId || !ownerKey) { console.error('Usage: dev-invoice.ts <merchantId> <ownerKey>'); process.exit(1); }

const env = loadEnv();
await connectDb(env.MONGODB_URI);
initChains(env);

const chainId = Number(rawChainId ?? env.ENABLED_CHAINS[0]);
const ctx = chainCtx(chainId);
const owner = privateKeyToAccount(ownerKey as `0x${string}`);
const wallet = createWalletClient({ account: owner, chain: foundry, transport: http(env.LOCAL_RPC) });

const amountUsdc = BigInt(rawAmount ?? '10') * 10n ** 6n;
const invoice: InvoiceMessage = {
  merchantId: merchantId as `0x${string}`, invoiceId: randomBytes32(),
  payoutToken: ctx.token('USDC')!.address, amount: amountUsdc,
  expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600), keyVersion: 1,
};
const sig = await wallet.signTypedData({ account: owner, ...buildInvoiceTypedData(chainId, ctx.vault, invoice) } as any);

const res = await createInvoice(ctx, {
  chainId, invoice: toWireInvoice(invoice) as any, merchantSig: sig as any,
  memo: 'Dev test invoice', fiat: { currency: 'USD', amount: String(Number(rawAmount ?? '10')) },
});
console.log('Invoice created:', JSON.stringify(res, null, 2));
process.exit(0);
