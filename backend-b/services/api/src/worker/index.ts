import { allChains } from '../chains.js';
import { log } from '../log.js';
import { runFollower } from './follower.js';
import { runCrossChainWatcher } from './crosschain.js';

let controller: AbortController | null = null;

export function startWorker() {
  if (controller) return;
  controller = new AbortController();
  const { signal } = controller;

  for (const ctx of allChains()) {
    void runFollower(ctx, signal).catch((e) => log.error({ chainId: ctx.chainId, err: e }, 'follower crashed'));
    if (ctx.features.crosschain !== 'off') {
      void runCrossChainWatcher(ctx, signal).catch((e) => log.error({ chainId: ctx.chainId, err: e }, 'crosschain watcher crashed'));
    }
  }
  log.info('worker started');
}

export function stopWorker() {
  controller?.abort();
  controller = null;
  log.info('worker stopped');
}
