import { indexer } from 'envio';
import { dayStart, eid, emptyProtocolStat, lc, logId, num, ROUTE_NAME } from './util';

const FIELDS = { block: ['timestamp'], transaction: ['hash'] } as const;
const ZERO = '0x0000000000000000000000000000000000000000';

indexer.onEvent({ contract: 'IntentVault', event: 'IntentCommitted', fields: FIELDS }, async ({ event, context }) => {
  const p = event.params;
  const route = num(p.route);
  const ts = BigInt(event.block.timestamp);
  context.Intent.set({
    id: eid(event.chainId, p.intentId),
    chainId: event.chainId,
    intentId: lc(p.intentId),
    merchant_id: eid(event.chainId, p.merchantId),
    merchantId: lc(p.merchantId),
    payer: lc(p.payer),
    invoiceId: lc(p.invoiceId),
    route,
    routeName: ROUTE_NAME[route] ?? 'UNKNOWN',
    status: 'COMMITTED',
    inputToken: lc(p.inputToken),
    payoutToken: lc(p.payoutToken),
    amountOut: p.amountOut,
    forwarder: lc(p.forwarder) === ZERO ? undefined : lc(p.forwarder),
    payoutWallet: lc(p.payoutWallet),
    expiresAt: p.expiresAt,
    quoteHash: lc(p.quoteHash),
    committedAt: ts,
    committedTx: lc(event.transaction.hash),
    committedBlock: event.block.number,
    settledAt: undefined,
    settledTx: undefined,
    settledBlock: undefined,
    fee: undefined,
    netToMerchant: undefined,
    inputAmount: undefined,
    excessRefunded: undefined,
    refundedAt: undefined,
    refundTx: undefined,
    refundTo: undefined,
    refundAmount: undefined,
    rescuedAmount: 0n,
    sourceChainId: undefined,
    sourceTxHash: undefined,
    providerRef: undefined,
    attester: undefined,
    attestedTx: undefined,
  });
  const stat = (await context.ProtocolStat.get(String(event.chainId))) ?? emptyProtocolStat(event.chainId);
  context.ProtocolStat.set({ ...stat, intents: stat.intents + 1 });
});

indexer.onEvent({ contract: 'IntentVault', event: 'PaymentSettled', fields: FIELDS }, async ({ event, context }) => {
  const p = event.params;
  const ts = BigInt(event.block.timestamp);
  const id = eid(event.chainId, p.intentId);
  const net = p.amountOut - p.fee;
  const intent = await context.Intent.get(id);
  if (intent) {
    context.Intent.set({
      ...intent,
      status: 'SETTLED',
      settledAt: ts,
      settledTx: lc(event.transaction.hash),
      settledBlock: event.block.number,
      fee: p.fee,
      netToMerchant: net,
      inputAmount: p.inputAmount,
      excessRefunded: p.excessRefunded,
    });
  }

  const mId = eid(event.chainId, p.merchantId);
  const m = await context.Merchant.get(mId);
  if (m) {
    context.Merchant.set({
      ...m,
      paymentCount: m.paymentCount + 1,
      settledVolume: m.settledVolume + p.amountOut,
      netReceived: m.netReceived + net,
      feesPaid: m.feesPaid + p.fee,
      updatedAt: ts,
    });
  }

  const day = dayStart(ts);
  const dId = `${mId}_${day}`;
  const d = (await context.MerchantDailyStat.get(dId)) ?? {
    id: dId,
    chainId: event.chainId,
    merchantId: lc(p.merchantId),
    dayStart: day,
    payments: 0,
    volume: 0n,
    net: 0n,
  };
  context.MerchantDailyStat.set({ ...d, payments: d.payments + 1, volume: d.volume + p.amountOut, net: d.net + net });

  const stat = (await context.ProtocolStat.get(String(event.chainId))) ?? emptyProtocolStat(event.chainId);
  context.ProtocolStat.set({
    ...stat,
    settled: stat.settled + 1,
    volume: stat.volume + p.amountOut,
    fees: stat.fees + p.fee,
    crossChainSettled: stat.crossChainSettled + (num(p.route) === 2 ? 1 : 0),
  });
});

indexer.onEvent({ contract: 'IntentVault', event: 'IntentRefunded', fields: FIELDS }, async ({ event, context }) => {
  const p = event.params;
  const id = eid(event.chainId, p.intentId);
  const intent = await context.Intent.get(id);
  if (intent) {
    context.Intent.set({
      ...intent,
      status: 'REFUNDED',
      refundedAt: BigInt(event.block.timestamp),
      refundTx: lc(event.transaction.hash),
      refundTo: lc(p.refundTo),
      refundAmount: p.amount,
    });
  }
  const stat = (await context.ProtocolStat.get(String(event.chainId))) ?? emptyProtocolStat(event.chainId);
  context.ProtocolStat.set({ ...stat, refunded: stat.refunded + 1 });
});

indexer.onEvent({ contract: 'IntentVault', event: 'ForwarderRescued', fields: FIELDS }, async ({ event, context }) => {
  const intent = await context.Intent.get(eid(event.chainId, event.params.intentId));
  if (intent) context.Intent.set({ ...intent, rescuedAmount: intent.rescuedAmount + event.params.amount });
});

indexer.onEvent({ contract: 'IntentVault', event: 'SourceAttested', fields: FIELDS }, async ({ event, context }) => {
  const p = event.params;
  const intent = await context.Intent.get(eid(event.chainId, p.intentId));
  if (!intent) return;
  context.Intent.set({
    ...intent,
    sourceChainId: p.sourceChainId,
    sourceTxHash: lc(p.sourceTxHash),
    providerRef: lc(p.providerRef),
    attester: lc(p.attester),
    attestedTx: lc(event.transaction.hash),
  });
});

// ---- config events → ConfigEvent rows (admin audit trail shown on the verify page) ----
const CONFIG_EVENTS = [
  'FeeUpdated',
  'SwapAdapterUpdated',
  'RefundDelayUpdated',
  'AmountCapUpdated',
  'InputTokenAllowed',
  'CrossChainInputTokenUpdated',
] as const;

for (const name of CONFIG_EVENTS) {
  indexer.onEvent({ contract: 'IntentVault', event: name, fields: FIELDS }, async ({ event, context }) => {
    context.ConfigEvent.set({
      id: logId(event.chainId, event.transaction.hash, event.logIndex),
      chainId: event.chainId,
      contract: 'IntentVault',
      kind: name,
      data: JSON.stringify(event.params, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
      timestamp: BigInt(event.block.timestamp),
      txHash: lc(event.transaction.hash),
    });
  });
}
