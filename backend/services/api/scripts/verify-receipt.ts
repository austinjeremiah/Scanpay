/**
 * Verify a payment receipt by intentId on-chain and in the DB.
 * Usage: INTENT_ID=0x... pnpm verify-receipt
 */
import { loadEnv } from '../src/env.js';
import { connectDb } from '../src/db/connect.js';
import { initChains, chainCtx } from '../src/chains.js';
import { verifyIntent } from '../src/services/verify.js';
import { log } from '../src/log.js';
import type { Hex } from 'viem';

const intentId = process.env.INTENT_ID as Hex | undefined;
const chainIdArg = process.env.CHAIN_ID ? Number(process.env.CHAIN_ID) : undefined;

if (!intentId || !/^0x[0-9a-fA-F]{64}$/.test(intentId)) {
  console.error('Usage: INTENT_ID=0x<64 hex chars> [CHAIN_ID=31337] pnpm verify-receipt');
  process.exit(1);
}

const env = loadEnv();
await connectDb(env.MONGODB_URI);
initChains(env);

const chainId = chainIdArg ?? env.ENABLED_CHAINS[0];
if (!env.ENABLED_CHAINS.includes(chainId)) {
  console.error(`Chain ${chainId} not in ENABLED_CHAINS: ${env.ENABLED_CHAINS}`);
  process.exit(1);
}

log.info({ chainId, intentId }, 'verifying receipt…');

const result = await verifyIntent(chainId, intentId);

console.log(JSON.stringify(result, null, 2));

const passed = result.verdict === 'VERIFIED';
log.info({ verdict: result.verdict }, passed ? '✓ VERIFIED' : `✗ verdict=${result.verdict}`);
process.exit(passed ? 0 : 1);
