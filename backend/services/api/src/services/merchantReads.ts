import type { Hex } from 'viem';
import type { PaymentView } from '@scanpay/shared';
import type { ChainCtx } from '../chains.js';
import { Intent, Merchant } from '../db/models.js';
import { ApiError } from '../errors.js';
import { log } from '../log.js';
import { eid, envioEnabled, gql, Q1_MERCHANT, Q2_MERCHANT_INTENTS, Q4_DAILY, Q5_KEYS, Q6_STATS, type EnvioIntent } from './envio.js';
import { merchantView, paymentViewFromIntent } from './views.js';

const useEnvio = (ctx: ChainCtx) => ctx.features.indexer && envioEnabled();

export async function getMerchantOr404(ctx: ChainCtx, merchantId: Hex) {
  const v = await merchantView(ctx, merchantId);
  if (!v) throw new ApiError('MERCHANT_NOT_FOUND');
  return v;
}

export async function merchantsByOwner(ctx: ChainCtx, owner: Hex) {
  const docs = await Merchant.find({ chainId: ctx.chainId, owner: owner.toLowerCase() }).lean();
  const views = await Promise.all(docs.map((d) => merchantView(ctx, d.merchantId as Hex)));
  return { merchants: views.filter((v): v is NonNullable<typeof v> => v !== null) };
}

function fromEnvio(ctx: ChainCtx, i: EnvioIntent): PaymentView {
  return {
    chainId: ctx.chainId, intentId: i.intentId, invoiceId: i.invoiceId, payer: i.payer, route: i.route,
    routeName: i.routeName as PaymentView['routeName'], status: i.status as PaymentView['status'],
    inputToken: i.inputToken, payoutToken: i.payoutToken, amountOut: String(i.amountOut), fee: i.fee,
    netToMerchant: i.netToMerchant, inputAmount: i.inputAmount, committedAt: Number(i.committedAt),
    commitTx: i.committedTx, settledAt: i.settledAt ? Number(i.settledAt) : null, settleTx: i.settledTx,
    sourceChainId: i.sourceChainId ? Number(i.sourceChainId) : null, sourceTxHash: i.sourceTxHash,
  };
}

export async function merchantPayments(ctx: ChainCtx, merchantId: Hex, limit: number, offset: number) {
  if (useEnvio(ctx)) {
    try {
      const d = await gql<{ Intent: EnvioIntent[] }>(Q2_MERCHANT_INTENTS, {
        chainId: ctx.chainId, merchantId: merchantId.toLowerCase(), limit, offset,
      });
      return { items: d.Intent.map((i) => fromEnvio(ctx, i)), source: 'envio' as const };
    } catch (e) {
      log.warn({ e }, 'envio payments failed; falling back to db');
    }
  }
  const docs = await Intent.find({
    chainId: ctx.chainId, merchantId: merchantId.toLowerCase(), lifecycle: { $nin: ['DRAFT', 'FAILED'] },
  }).sort({ createdAt: -1 }).skip(offset).limit(limit).lean();
  return { items: docs.map((d) => paymentViewFromIntent(d as any)), source: 'db' as const };
}

export async function merchantStats(ctx: ChainCtx, merchantId: Hex, days: number) {
  const since = Math.floor(Date.now() / 1000 / 86400 - days) * 86400;
  if (useEnvio(ctx)) {
    try {
      const [m, daily] = await Promise.all([
        gql<{ Merchant: any[] }>(Q1_MERCHANT, { id: eid(ctx.chainId, merchantId) }),
        gql<{ MerchantDailyStat: any[] }>(Q4_DAILY, { chainId: ctx.chainId, merchantId: merchantId.toLowerCase(), since: String(since) }),
      ]);
      const row = m.Merchant[0];
      return {
        paymentCount: row?.paymentCount ?? 0,
        settledVolume: String(row?.settledVolume ?? '0'),
        netReceived: String(row?.netReceived ?? '0'),
        feesPaid: String(row?.feesPaid ?? '0'),
        daily: daily.MerchantDailyStat.map((x) => ({ dayStart: Number(x.dayStart), payments: x.payments, volume: String(x.volume), net: String(x.net) })),
        source: 'envio' as const,
      };
    } catch (e) {
      log.warn({ e }, 'envio stats failed; falling back to db');
    }
  }
  const settled = await Intent.find({ chainId: ctx.chainId, merchantId: merchantId.toLowerCase(), lifecycle: 'SETTLED' }).lean();
  let vol = 0n, net = 0n, fees = 0n;
  const byDay = new Map<number, { payments: number; volume: bigint; net: bigint }>();
  for (const s of settled) {
    const a = BigInt(s.intent.amountOut), f = BigInt(s.onchain?.fee ?? '0');
    vol += a; fees += f; net += a - f;
    const day = Math.floor((s.onchain?.settledAt ?? 0) / 86400) * 86400;
    if (day < since) continue;
    const cur = byDay.get(day) ?? { payments: 0, volume: 0n, net: 0n };
    byDay.set(day, { payments: cur.payments + 1, volume: cur.volume + a, net: cur.net + a - f });
  }
  return {
    paymentCount: settled.length, settledVolume: vol.toString(), netReceived: net.toString(), feesPaid: fees.toString(),
    daily: [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([dayStart, v]) => ({ dayStart, payments: v.payments, volume: v.volume.toString(), net: v.net.toString() })),
    source: 'db' as const,
  };
}

export async function merchantKeys(ctx: ChainCtx, merchantId: Hex) {
  if (useEnvio(ctx)) {
    try {
      const d = await gql<{ MerchantKeyEvent: any[] }>(Q5_KEYS, { id: eid(ctx.chainId, merchantId) });
      return {
        events: d.MerchantKeyEvent.map((e) => ({
          kind: e.kind, keyVersion: e.keyVersion, invoiceSigner: e.invoiceSigner ?? null, payoutWallet: e.payoutWallet ?? null,
          payoutToken: e.payoutToken ?? null, fromStatus: e.fromStatus ?? null, toStatus: e.toStatus ?? null,
          timestamp: Number(e.timestamp), txHash: e.txHash,
        })),
        source: 'envio' as const,
      };
    } catch (e) {
      log.warn({ e }, 'envio keys failed; falling back to db');
    }
  }
  const m = await Merchant.findOne({ chainId: ctx.chainId, merchantId: merchantId.toLowerCase() }).lean();
  if (!m) return { events: [], source: 'db' as const };
  return {
    events: [{
      kind: 'REGISTERED' as const, keyVersion: 1, invoiceSigner: m.invoiceSigner as Hex, payoutWallet: m.payoutWallet as Hex,
      payoutToken: m.payoutToken as Hex, fromStatus: null, toStatus: null, timestamp: m.registeredAt, txHash: (m.registeredTx ?? '0x') as Hex,
    }],
    source: 'db' as const,
  };
}

export async function protocolStats(ctx: ChainCtx) {
  if (useEnvio(ctx)) {
    try {
      const d = await gql<{ ProtocolStat: any[] }>(Q6_STATS, { chainId: String(ctx.chainId) });
      const s = d.ProtocolStat[0] ?? {};
      return {
        chainId: ctx.chainId, merchants: s.merchants ?? 0, activeMerchants: s.activeMerchants ?? 0, intents: s.intents ?? 0,
        settled: s.settled ?? 0, refunded: s.refunded ?? 0, volume: String(s.volume ?? '0'), fees: String(s.fees ?? '0'),
        crossChainSettled: s.crossChainSettled ?? 0, source: 'envio' as const,
      };
    } catch (e) {
      log.warn({ e }, 'envio stats failed');
    }
  }
  const [merchants, active, intents, settled, refunded] = await Promise.all([
    Merchant.countDocuments({ chainId: ctx.chainId }),
    Merchant.countDocuments({ chainId: ctx.chainId, status: 'ACTIVE' }),
    Intent.countDocuments({ chainId: ctx.chainId, lifecycle: { $nin: ['DRAFT', 'FAILED'] } }),
    Intent.find({ chainId: ctx.chainId, lifecycle: 'SETTLED' }, { 'intent.amountOut': 1, 'onchain.fee': 1, route: 1 }).lean(),
    Intent.countDocuments({ chainId: ctx.chainId, lifecycle: 'REFUNDED' }),
  ]);
  const volume = settled.reduce((a, s) => a + BigInt(s.intent.amountOut), 0n);
  const fees = settled.reduce((a, s) => a + BigInt(s.onchain?.fee ?? '0'), 0n);
  return {
    chainId: ctx.chainId, merchants, activeMerchants: active, intents, settled: settled.length, refunded,
    volume: volume.toString(), fees: fees.toString(), crossChainSettled: settled.filter((s) => s.route === 'CROSSCHAIN').length,
    source: 'db' as const,
  };
}
