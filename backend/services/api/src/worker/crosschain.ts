import type { Address, Hex } from 'viem';
import { erc20Abi, intentVaultAbi } from '@scanpay/shared';
import type { ChainCtx } from '../chains.js';
import { Intent, audit, type IntentDoc } from '../db/models.js';
import { relay } from '../relayer.js';
import { applyReceipt, pushLifecycle } from '../services/settlement.js';
import { auroraStatus } from '../services/aurora.js';
import { kuruSwapData } from '../services/kuru.js';
import { log } from '../log.js';
import { sleep, nowSec } from '../util/time.js';
import { decideCrossChain } from './decide.js';

const OPEN = ['COMMITTED', 'AWAITING_DEPOSIT', 'PROCESSING', 'UNDERPAID', 'RECONCILIATION_REQUIRED'];
const POLL_MS = 15_000;
// If provider reports SUCCESS but forwarder is still short after this window → RECONCILIATION_REQUIRED
const RECONCILIATION_GRACE_SEC = 90;

async function processOne(ctx: ChainCtx, d: IntentDoc) {
  const forwarder = d.forwarder as Address | undefined;
  if (!forwarder) return;

  const inputToken = d.intent.inputToken as Address;
  const balance = (await ctx.public.readContract({
    address: inputToken, abi: erc20Abi, functionName: 'balanceOf', args: [forwarder],
  })) as bigint;

  // Poll Aurora for provider status updates (live mode only, keyed by depositAddress)
  if (d.crosschain?.mode === 'live' && d.crosschain.depositAddress) {
    try {
      const provResult = await auroraStatus(d.crosschain.depositAddress);
      const provStatus = provResult?.status;
      if (provStatus && provStatus !== d.crosschain.providerStatus) {
        const update: Record<string, unknown> = { 'crosschain.providerStatus': provStatus, 'crosschain.providerUpdatedAt': nowSec() };
        if (provStatus === 'SUCCESS') update['crosschain.providerSuccessAt'] = nowSec();
        await Intent.updateOne({ _id: d._id }, { $set: update });

        // INCOMPLETE_DEPOSIT = solver delivered less than required → UNDERPAID
        if (provStatus === 'INCOMPLETE_DEPOSIT') {
          await pushLifecycle(ctx.chainId, d.intentId, 'UNDERPAID', 'provider reports INCOMPLETE_DEPOSIT', {}, OPEN);
        }
      }

      // RECONCILIATION_REQUIRED: provider says SUCCESS but funds still not in forwarder after grace period
      const successAt = d.crosschain.providerSuccessAt ?? (provStatus === 'SUCCESS' ? nowSec() : undefined);
      const required = BigInt(d.intent.maxAmountIn ?? 0);
      if (successAt && balance < required && nowSec() - successAt > RECONCILIATION_GRACE_SEC) {
        await pushLifecycle(ctx.chainId, d.intentId, 'RECONCILIATION_REQUIRED',
          `provider SUCCESS ${RECONCILIATION_GRACE_SEC}s ago but forwarder has ${balance} < ${required}`, {}, OPEN);
      }
    } catch { /* provider check is best-effort */ }
  }

  const decision = decideCrossChain(d, balance, nowSec());

  switch (decision.action) {
    case 'settle': {
      // On mainnet with Kuru adapter, fetch fresh swapData for the settle tx
      let swapData: Hex = '0x';
      if (ctx.isMainnet && ctx.adapterKind === 'kuru') {
        const payoutToken = d.intent.payoutToken as Address;
        if (inputToken.toLowerCase() !== payoutToken.toLowerCase()) {
          const amountOut = BigInt(d.intent.amountOut ?? 0);
          swapData = await kuruSwapData(ctx, inputToken, payoutToken, balance, amountOut);
        }
      }
      const { hash, receipt } = await relay(ctx, {
        address: ctx.vault, abi: intentVaultAbi, functionName: 'settleCrossChain',
        args: [d.intentId as Hex, swapData], label: 'settleCrossChain',
      });
      await pushLifecycle(ctx.chainId, d.intentId, 'PROCESSING', `settleCrossChain sent ${hash}`, { 'txs.settle': hash }, OPEN);
      await applyReceipt(ctx, receipt);
      await audit('worker', 'intent.settle', ctx.chainId, d.intentId, { hash, balance: balance.toString() });
      break;
    }
    case 'refund': {
      const { hash, receipt } = await relay(ctx, {
        address: ctx.vault, abi: intentVaultAbi, functionName: 'refundCrossChain',
        args: [d.intentId as Hex], label: 'refundCrossChain',
      });
      await pushLifecycle(ctx.chainId, d.intentId, 'REFUNDED', `refundCrossChain sent ${hash}`, { 'txs.refund': hash }, OPEN);
      await applyReceipt(ctx, receipt);
      await audit('worker', 'intent.refund', ctx.chainId, d.intentId, { hash });
      break;
    }
    case 'attest': {
      const { hash } = await relay(ctx, {
        address: ctx.vault, abi: intentVaultAbi, functionName: 'attestSource',
        args: [d.intentId as Hex, BigInt(decision.sourceChainId), decision.sourceTxHash, decision.providerRef],
        label: 'attestSource',
      });
      await audit('worker', 'intent.attest', ctx.chainId, d.intentId, { hash });
      break;
    }
    case 'wait':
      break;
  }
}

export async function runCrossChainWatcher(ctx: ChainCtx, signal: AbortSignal) {
  log.info({ chainId: ctx.chainId }, 'cross-chain watcher starting');
  while (!signal.aborted) {
    try {
      const open = await Intent.find({ chainId: ctx.chainId, route: 'CROSSCHAIN', lifecycle: { $in: OPEN } }).lean() as unknown as IntentDoc[];
      for (const d of open) {
        try { await processOne(ctx, d); } catch (e) { log.warn({ intentId: d.intentId, err: e }, 'crosschain watcher processOne error'); }
      }
    } catch (e) { log.warn({ chainId: ctx.chainId, err: e }, 'crosschain watcher outer error'); }
    await sleep(POLL_MS);
  }
  log.info({ chainId: ctx.chainId }, 'cross-chain watcher stopped');
}
