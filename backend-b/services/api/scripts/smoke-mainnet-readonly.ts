/**
 * Read-only smoke test against a live deployment.
 * Safe to run against mainnet — no writes, no transactions.
 * Usage: pnpm smoke:mainnet-readonly
 */
import { loadEnv } from '../src/env.js';
import { connectDb } from '../src/db/connect.js';
import { initChains, allChains } from '../src/chains.js';
import { log } from '../src/log.js';

const env = loadEnv();

log.info('--- ScanPay API smoke test (read-only) ---');
log.info({ chains: env.ENABLED_CHAINS, url: env.PUBLIC_APP_URL });

await connectDb(env.MONGODB_URI);
log.info('✓ MongoDB connected');

initChains(env);
log.info('✓ Chains initialised');

let allOk = true;
for (const ctx of allChains()) {
  try {
    const block = await ctx.public.getBlockNumber();
    const bal = await ctx.public.getBalance({ address: ctx.operator.address });
    log.info({
      chainId: ctx.chainId,
      block: block.toString(),
      operator: ctx.operator.address,
      operatorBalanceEth: (Number(bal) / 1e18).toFixed(4),
      vault: ctx.vault,
      registry: ctx.registry,
    }, `✓ chain ${ctx.chainId} reachable`);
  } catch (e) {
    log.error({ chainId: ctx.chainId, err: e }, `✗ chain ${ctx.chainId} unreachable`);
    allOk = false;
  }
}

if (!allOk) {
  log.error('smoke test FAILED');
  process.exit(1);
}
log.info('smoke test PASSED — all chains reachable, DB connected');
process.exit(0);
