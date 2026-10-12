import { indexer } from 'envio';
import { eid, emptyProtocolStat, lc, logId, MERCHANT_ACTIVE, MERCHANT_STATUS_NAME, num } from './util';

const FIELDS = { block: ['timestamp'], transaction: ['hash'] } as const;

indexer.onEvent(
  { contract: 'MerchantRegistry', event: 'MerchantRegistered', fields: FIELDS },
  async ({ event, context }) => {
    const p = event.params;
    const ts = BigInt(event.block.timestamp);
    const id = eid(event.chainId, p.merchantId);
    context.Merchant.set({
      id,
      chainId: event.chainId,
      merchantId: lc(p.merchantId),
      owner: lc(p.owner),
      salt: lc(p.salt),
      payoutWallet: lc(p.payoutWallet),
      invoiceSigner: lc(p.invoiceSigner),
      payoutToken: lc(p.payoutToken),
      metadataHash: lc(p.metadataHash),
      status: 1,
      statusName: 'PENDING',
      keyVersion: 1,
      registeredAt: ts,
      registeredTx: lc(event.transaction.hash),
      updatedAt: ts,
      paymentCount: 0,
      settledVolume: 0n,
      netReceived: 0n,
      feesPaid: 0n,
    });
    context.MerchantKeyEvent.set({
      id: logId(event.chainId, event.transaction.hash, event.logIndex),
      chainId: event.chainId,
      merchant_id: id,
      kind: 'REGISTERED',
      keyVersion: 1,
      invoiceSigner: lc(p.invoiceSigner),
      payoutWallet: lc(p.payoutWallet),
      payoutToken: lc(p.payoutToken),
      fromStatus: undefined,
      toStatus: undefined,
      by: undefined,
      timestamp: ts,
      txHash: lc(event.transaction.hash),
      blockNumber: event.block.number,
    });
    const stat = (await context.ProtocolStat.get(String(event.chainId))) ?? emptyProtocolStat(event.chainId);
    context.ProtocolStat.set({ ...stat, merchants: stat.merchants + 1 });
  },
);

indexer.onEvent(
  { contract: 'MerchantRegistry', event: 'MerchantStatusChanged', fields: FIELDS },
  async ({ event, context }) => {
    const p = event.params;
    const id = eid(event.chainId, p.merchantId);
    const m = await context.Merchant.get(id);
    if (!m) return; // MerchantRegistered always precedes in the same tx; defensive only
    const from = num(p.previousStatus);
    const to = num(p.newStatus);
    const ts = BigInt(event.block.timestamp);
    context.Merchant.set({ ...m, status: to, statusName: MERCHANT_STATUS_NAME[to] ?? 'UNKNOWN', updatedAt: ts });
    context.MerchantKeyEvent.set({
      id: logId(event.chainId, event.transaction.hash, event.logIndex),
      chainId: event.chainId,
      merchant_id: id,
      kind: 'STATUS',
      keyVersion: m.keyVersion,
      invoiceSigner: undefined,
      payoutWallet: undefined,
      payoutToken: undefined,
      fromStatus: from,
      toStatus: to,
      by: lc(p.by),
      timestamp: ts,
      txHash: lc(event.transaction.hash),
      blockNumber: event.block.number,
    });
    if (from === to) return;
    const stat = (await context.ProtocolStat.get(String(event.chainId))) ?? emptyProtocolStat(event.chainId);
    const delta = (to === MERCHANT_ACTIVE ? 1 : 0) - (from === MERCHANT_ACTIVE ? 1 : 0);
    if (delta !== 0) context.ProtocolStat.set({ ...stat, activeMerchants: stat.activeMerchants + delta });
  },
);

indexer.onEvent(
  { contract: 'MerchantRegistry', event: 'InvoiceSignerRotated', fields: FIELDS },
  async ({ event, context }) => {
    const p = event.params;
    const id = eid(event.chainId, p.merchantId);
    const m = await context.Merchant.get(id);
    if (!m) return;
    const ts = BigInt(event.block.timestamp);
    context.Merchant.set({ ...m, invoiceSigner: lc(p.invoiceSigner), keyVersion: num(p.keyVersion), updatedAt: ts });
    context.MerchantKeyEvent.set({
      id: logId(event.chainId, event.transaction.hash, event.logIndex),
      chainId: event.chainId,
      merchant_id: id,
      kind: 'SIGNER_ROTATED',
      keyVersion: num(p.keyVersion),
      invoiceSigner: lc(p.invoiceSigner),
      payoutWallet: undefined,
      payoutToken: undefined,
      fromStatus: undefined,
      toStatus: undefined,
      by: undefined,
      timestamp: ts,
      txHash: lc(event.transaction.hash),
      blockNumber: event.block.number,
    });
  },
);

indexer.onEvent(
  { contract: 'MerchantRegistry', event: 'PayoutUpdated', fields: FIELDS },
  async ({ event, context }) => {
    const p = event.params;
    const id = eid(event.chainId, p.merchantId);
    const m = await context.Merchant.get(id);
    if (!m) return;
    const ts = BigInt(event.block.timestamp);
    context.Merchant.set({
      ...m,
      payoutWallet: lc(p.payoutWallet),
      payoutToken: lc(p.payoutToken),
      keyVersion: num(p.keyVersion),
      updatedAt: ts,
    });
    context.MerchantKeyEvent.set({
      id: logId(event.chainId, event.transaction.hash, event.logIndex),
      chainId: event.chainId,
      merchant_id: id,
      kind: 'PAYOUT_UPDATED',
      keyVersion: num(p.keyVersion),
      invoiceSigner: undefined,
      payoutWallet: lc(p.payoutWallet),
      payoutToken: lc(p.payoutToken),
      fromStatus: undefined,
      toStatus: undefined,
      by: undefined,
      timestamp: ts,
      txHash: lc(event.transaction.hash),
      blockNumber: event.block.number,
    });
  },
);

indexer.onEvent(
  { contract: 'MerchantRegistry', event: 'PayoutTokenAllowed', fields: FIELDS },
  async ({ event, context }) => {
    context.ConfigEvent.set({
      id: logId(event.chainId, event.transaction.hash, event.logIndex),
      chainId: event.chainId,
      contract: 'MerchantRegistry',
      kind: 'PayoutTokenAllowed',
      data: JSON.stringify({ token: lc(event.params.token), allowed: event.params.allowed }),
      timestamp: BigInt(event.block.timestamp),
      txHash: lc(event.transaction.hash),
    });
  },
);
