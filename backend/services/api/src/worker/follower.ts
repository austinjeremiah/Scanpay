import type { Log } from 'viem';
import type { ChainCtx } from '../chains.js';
import { Cursor } from '../db/models.js';
import { applyLog } from '../services/settlement.js';
import { log } from '../log.js';
import { sleep } from '../util/time.js';

const BATCH = 500n;
const POLL_MS = 3_000;

export async function runFollower(ctx: ChainCtx, signal: AbortSignal) {
  const cursor = await Cursor.findOne({ chainId: ctx.chainId }).lean();
  let from = cursor ? BigInt(cursor.lastBlock) : BigInt(ctx.deployment.startBlock ?? 0);
  log.info({ chainId: ctx.chainId, from: from.toString() }, 'follower starting');

  while (!signal.aborted) {
    try {
      const latest = await ctx.public.getBlockNumber();
      if (from > latest) { await sleep(POLL_MS); continue; }
      const to = from + BATCH < latest ? from + BATCH : latest;

      const [vaultLogs, registryLogs] = await Promise.all([
        ctx.public.getLogs({ address: ctx.vault, fromBlock: from, toBlock: to }),
        ctx.public.getLogs({ address: ctx.registry, fromBlock: from, toBlock: to }),
      ]);

      const allLogs = [...vaultLogs, ...registryLogs].sort((a, b) =>
        Number(a.blockNumber ?? 0n) - Number(b.blockNumber ?? 0n) || Number(a.transactionIndex ?? 0) - Number(b.transactionIndex ?? 0),
      );

      for (const l of allLogs) {
        const block = await ctx.public.getBlock({ blockNumber: l.blockNumber! });
        await applyLog(ctx, l as Log, {
          txHash: l.transactionHash!, blockNumber: l.blockNumber!, timestamp: Number(block.timestamp),
        });
      }

      await Cursor.findOneAndUpdate({ chainId: ctx.chainId }, { $set: { lastBlock: Number(to), updatedAt: new Date() } }, { upsert: true });
      from = to + 1n;

      if (to === latest) await sleep(POLL_MS);
    } catch (err) {
      log.warn({ chainId: ctx.chainId, err }, 'follower error, retrying in 5s');
      await sleep(5_000);
    }
  }
  log.info({ chainId: ctx.chainId }, 'follower stopped');
}
