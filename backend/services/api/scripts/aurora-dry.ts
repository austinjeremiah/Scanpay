#!/usr/bin/env tsx
/**
 * Dry-run Aurora cross-chain quote.
 * Usage: tsx --env-file=../../.env scripts/aurora-dry.ts [shortCode] [originAssetId]
 */
import { loadEnv } from '../src/env.js';
import { connectDb } from '../src/db/connect.js';
import { initChains } from '../src/chains.js';
import { configureAurora, auroraEnabled, originAssets, auroraQuote } from '../src/services/aurora.js';
import { previewQuote } from '../src/services/intents.js';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const [shortCode, originAssetId] = process.argv.slice(2);
const env = loadEnv();
await connectDb(env.MONGODB_URI);
initChains(env);
configureAurora(env.AURORA_API_KEY, env.ONECLICK_JWT);

if (!auroraEnabled()) { console.log('Aurora not configured (no AURORA_API_KEY or ONECLICK_JWT)'); }

console.log('Aurora enabled:', auroraEnabled());

const assets = await originAssets();
console.log('Origin assets count:', assets.length);
console.log('First 3:', assets.slice(0, 3).map((a) => `${a.symbol} on ${a.blockchain} (${a.assetId})`).join('\n'));

if (shortCode) {
  const payer = privateKeyToAccount(generatePrivateKey());
  const quote = await previewQuote({ shortCode, route: 'CROSSCHAIN', payer: payer.address as any, originAssetId });
  console.log('Quote:', JSON.stringify(quote, null, 2));
}
process.exit(0);
