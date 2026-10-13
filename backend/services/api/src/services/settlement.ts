import { decodeEventLog, type Hex, type Log, type TransactionReceipt } from 'viem';
import { intentVaultAbi, merchantRegistryAbi, MERCHANT_STATUS_NAME } from '@scanpay/shared';
import type { ChainCtx } from '../chains.js';
import { Intent, Invoice, Merchant, type IntentDoc } from '../db/models.js';
import { channel, publish } from '../bus.js';
import { intentView, paymentViewFromIntent } from './views.js';
import { log } from '../log.js';

const OPEN_CC = ['COMMITTED', 'AWAITING_DEPOSIT', 'PROCESSING', 'UNDERPAID', 'RECONCILIATION_REQUIRED', 'EXPIRED'];

type Meta = { txHash: Hex; blockNumber: bigint; timestamp: number };

export async function pushLifecycle(chainId: number, intentId: string, lifecycle: string, note: string, set: Record<string, unknown> = {}, onlyFrom?: string[]) {
  const filter: Record<string, unknown> = { chainId, intentId: intentId.toLowerCase() };
  if (onlyFrom) filter.lifecycle = { $in: onlyFrom };
  const doc = await Intent.findOneAndUpdate(
    filter,
    { $set: { lifecycle, ...set }, $push: { timeline: { at: Math.floor(Date.now() / 1000), status: lifecycle, note } } },
    { new: true },
  ).lean();
  return doc as IntentDoc | null;
}

function emitIntent(ctx: ChainCtx, d: IntentDoc | null) {
  if (!d) return;
  publish(channel.intent(ctx.chainId, d.intentId), { type: 'intent.updated', intent: intentView(ctx, d) });
}

export async function applyLog(ctx: ChainCtx, log_: Log, meta: Meta) {
  const isVault = log_.address.toLowerCase() === ctx.vault.toLowerCase();
  const isRegistry = log_.address.toLowerCase() === ctx.registry.toLowerCase();
  if (!isVault && !isRegistry) return;
  let ev: { eventName: string; args: any };
  try {
    ev = decodeEventLog({ abi: isVault ? intentVaultAbi : merchantRegistryAbi, data: log_.data, topics: log_.topics }) as any;
  } catch {
    return;
  }
  const a = ev.args;
  switch (ev.eventName) {
    case 'IntentCommitted': {
      if (Number(a.route) === 2) {
        const d = await pushLifecycle(ctx.chainId, a.intentId, 'AWAITING_DEPOSIT', 'committed on-chain; waiting for deposit',
          { 'txs.commit': meta.txHash, forwarder: String(a.forwarder).toLowerCase() }, ['DRAFT', 'SUBMITTED', 'COMMITTED']);
        emitIntent(ctx, d);
      }
      await Invoice.updateOne({ chainId: ctx.chainId, merchantId: String(a.merchantId).toLowerCase(), invoiceId: String(a.invoiceId).toLowerCase(), state: 'OPEN' }, { $set: { state: 'RESERVED' } });
      break;
    }
    case 'PaymentSettled': {
      const fee = BigInt(a.fee);
      const ROUTE_NAMES = ['DIRECT', 'SWAP', 'CROSSCHAIN'] as const;
      const routeName = ROUTE_NAMES[Number(a.route)] ?? 'DIRECT';
      let d = await pushLifecycle(ctx.chainId, a.intentId, 'SETTLED', `settled on-chain (block ${meta.blockNumber})`, {
        'txs.settle': meta.txHash,
        'onchain.fee': fee.toString(),
        'onchain.inputAmount': BigInt(a.inputAmount).toString(),
        'onchain.excessRefunded': BigInt(a.excessRefunded).toString(),
        'onchain.netToMerchant': (BigInt(a.amountOut) - fee).toString(),
        'onchain.settledAt': meta.timestamp,
        'onchain.settledBlock': Number(meta.blockNumber),
        error: null,
      }, ['DRAFT', 'SUBMITTED', ...OPEN_CC]);
      // Intent was committed via a different backend instance — upsert from on-chain data so it appears in merchant history.
      if (!d) {
        const intentIdLow = String(a.intentId).toLowerCase();
        d = await Intent.findOneAndUpdate(
          { chainId: ctx.chainId, intentId: intentIdLow },
          {
            $setOnInsert: {
              draftId: `onchain:${intentIdLow}`,
              chainId: ctx.chainId,
              intentId: intentIdLow,
              route: routeName,
              merchantId: String(a.merchantId).toLowerCase(),
              invoiceId: String(a.invoiceId).toLowerCase(),
              payer: String(a.payer).toLowerCase(),
              intent: { amountOut: BigInt(a.amountOut).toString(), payoutToken: String(a.payoutToken).toLowerCase() },
              invoice: {},
              merchantSig: '',
              expiresAt: meta.timestamp,
              draftExpiresAt: meta.timestamp,
            },
            $set: {
              lifecycle: 'SETTLED',
              'txs.settle': meta.txHash,
              'onchain.fee': fee.toString(),
              'onchain.inputAmount': BigInt(a.inputAmount).toString(),
              'onchain.excessRefunded': BigInt(a.excessRefunded).toString(),
              'onchain.netToMerchant': (BigInt(a.amountOut) - fee).toString(),
              'onchain.settledAt': meta.timestamp,
              'onchain.settledBlock': Number(meta.blockNumber),
            },
            $push: { timeline: { at: meta.timestamp, status: 'SETTLED', note: `settled on-chain (block ${meta.blockNumber})` } },
          },
          { upsert: true, new: true },
        ).lean() as unknown as IntentDoc | null;
      }
      const inv = await Invoice.findOneAndUpdate(
        { chainId: ctx.chainId, merchantId: String(a.merchantId).toLowerCase(), invoiceId: String(a.invoiceId).toLowerCase() },
        { $set: { state: 'PAID', paidIntentId: String(a.intentId).toLowerCase() } },
        { new: true },
      ).lean();
      emitIntent(ctx, d);
      if (d) publish(channel.merchant(ctx.chainId, d.merchantId), { type: 'payment.settled', payment: paymentViewFromIntent(d) });
      if (inv) publish(channel.invoice(inv.shortCode), { type: 'invoice.updated', shortCode: inv.shortCode, state: 'PAID' });
      log.info({ chainId: ctx.chainId, intentId: a.intentId, tx: meta.txHash }, 'PaymentSettled');
      break;
    }
    case 'IntentRefunded': {
      const d = await pushLifecycle(ctx.chainId, a.intentId, 'REFUNDED', `refunded ${a.amount} to ${a.refundTo}`, {
        'txs.refund': meta.txHash, 'onchain.refundAmount': BigInt(a.amount).toString(),
      }, OPEN_CC);
      if (d) {
        await Invoice.updateOne({ chainId: ctx.chainId, merchantId: d.merchantId, invoiceId: d.invoiceId }, { $set: { state: 'OPEN' } });
      }
      emitIntent(ctx, d);
      break;
    }
    case 'SourceAttested': {
      const d = await Intent.findOneAndUpdate(
        { chainId: ctx.chainId, intentId: String(a.intentId).toLowerCase() },
        { $set: { 'txs.attest': meta.txHash, 'crosschain.sourceChainId': Number(a.sourceChainId) } },
        { new: true },
      ).lean();
      emitIntent(ctx, d as IntentDoc | null);
      break;
    }
    case 'MerchantRegistered': {
      await Merchant.updateOne(
        { chainId: ctx.chainId, merchantId: String(a.merchantId).toLowerCase() },
        {
          $setOnInsert: {
            owner: String(a.owner).toLowerCase(), salt: String(a.salt).toLowerCase(), payoutWallet: String(a.payoutWallet).toLowerCase(),
            invoiceSigner: String(a.invoiceSigner).toLowerCase(), payoutToken: String(a.payoutToken).toLowerCase(), keyVersion: 1,
            status: 'PENDING', metadataHash: String(a.metadataHash).toLowerCase(), registeredAt: meta.timestamp, registeredTx: meta.txHash,
          },
        },
        { upsert: true },
      );
      break;
    }
    case 'MerchantStatusChanged':
      await Merchant.updateOne({ chainId: ctx.chainId, merchantId: String(a.merchantId).toLowerCase() }, { $set: { status: MERCHANT_STATUS_NAME[Number(a.newStatus)] } });
      break;
    case 'InvoiceSignerRotated':
      await Merchant.updateOne({ chainId: ctx.chainId, merchantId: String(a.merchantId).toLowerCase() }, { $set: { invoiceSigner: String(a.invoiceSigner).toLowerCase(), keyVersion: Number(a.keyVersion) } });
      break;
    case 'PayoutUpdated':
      await Merchant.updateOne({ chainId: ctx.chainId, merchantId: String(a.merchantId).toLowerCase() }, { $set: { payoutWallet: String(a.payoutWallet).toLowerCase(), payoutToken: String(a.payoutToken).toLowerCase(), keyVersion: Number(a.keyVersion) } });
      break;
    default:
      break;
  }
}

export async function applyReceipt(ctx: ChainCtx, receipt: TransactionReceipt) {
  const block = await ctx.public.getBlock({ blockNumber: receipt.blockNumber });
  for (const l of receipt.logs) {
    await applyLog(ctx, l as Log, { txHash: receipt.transactionHash, blockNumber: receipt.blockNumber, timestamp: Number(block.timestamp) });
  }
}
