import type { Hex } from 'viem';
import {
  merchantRegistryAbi, intentVaultAbi, profileHash, MERCHANT_STATUS_NAME, INVOICE_STATE,
  type MerchantRecord, type MerchantView, type InvoiceView, type IntentView, type PaymentView, type Profile,
} from '@scanpay/shared';
import type { ChainCtx } from '../chains.js';
import { Invoice, Merchant, type IntentDoc } from '../db/models.js';
import { nowSec } from '../util/time.js';

export async function readMerchant(ctx: ChainCtx, merchantId: Hex): Promise<MerchantRecord> {
  return (await ctx.public.readContract({
    address: ctx.registry,
    abi: merchantRegistryAbi,
    functionName: 'getMerchant',
    args: [merchantId],
  })) as MerchantRecord;
}

export async function merchantView(ctx: ChainCtx, merchantId: Hex): Promise<MerchantView | null> {
  const m = await readMerchant(ctx, merchantId);
  if (m.status === 0) return null;
  const doc = await Merchant.findOne({ chainId: ctx.chainId, merchantId: merchantId.toLowerCase() }).lean();
  const profile: Profile | null = doc?.profile?.displayName
    ? {
        displayName: doc.profile.displayName ?? '',
        category: doc.profile.category ?? '',
        city: doc.profile.city ?? '',
        country: doc.profile.country ?? '',
        logoUrl: doc.profile.logoUrl ?? '',
      }
    : null;
  return {
    chainId: ctx.chainId,
    merchantId: merchantId.toLowerCase() as Hex,
    owner: m.owner.toLowerCase() as Hex,
    payoutWallet: m.payoutWallet.toLowerCase() as Hex,
    invoiceSigner: m.invoiceSigner.toLowerCase() as Hex,
    payoutToken: m.payoutToken.toLowerCase() as Hex,
    payoutTokenKey: ctx.tokenByAddress(m.payoutToken)?.key ?? null,
    keyVersion: Number(m.keyVersion),
    status: MERCHANT_STATUS_NAME[Number(m.status)] as MerchantView['status'],
    registeredAt: Number(m.registeredAt),
    profile,
    profileVerified: profile ? profileHash(profile).toLowerCase() === m.metadataHash.toLowerCase() : false,
  };
}

export async function invoiceOnchainState(ctx: ChainCtx, merchantId: Hex, invoiceId: Hex): Promise<number> {
  return Number(
    await ctx.public.readContract({
      address: ctx.vault,
      abi: intentVaultAbi,
      functionName: 'invoiceState',
      args: [merchantId, invoiceId],
    }),
  );
}

export async function invoiceView(ctx: ChainCtx, doc: any): Promise<InvoiceView> {
  const merchant = await merchantView(ctx, doc.merchantId as Hex);
  const st = await invoiceOnchainState(ctx, doc.merchantId as Hex, doc.invoiceId as Hex);
  const state: InvoiceView['state'] =
    st === INVOICE_STATE.PAID ? 'PAID' : st === INVOICE_STATE.RESERVED ? 'RESERVED' : doc.expiresAt < nowSec() ? 'EXPIRED' : 'OPEN';
  return {
    shortCode: doc.shortCode,
    chainId: doc.chainId,
    invoice: doc.invoice,
    merchantSig: doc.merchantSig,
    merchant: merchant!,
    state,
    payoutTokenKey: ctx.tokenByAddress(doc.invoice.payoutToken)?.key ?? null,
    memo: doc.memo ?? null,
    fiat: doc.fiat?.currency ? { currency: doc.fiat.currency, amount: doc.fiat.amount } : null,
    paidIntentId: doc.paidIntentId ?? null,
    createdAt: Math.floor(new Date(doc.createdAt).getTime() / 1000),
  };
}

export function intentView(ctx: ChainCtx, d: IntentDoc, received = '0'): IntentView {
  const cc = d.crosschain;
  return {
    chainId: d.chainId,
    intentId: d.intentId as Hex,
    route: d.route as IntentView['route'],
    lifecycle: d.lifecycle as IntentView['lifecycle'],
    merchantId: d.merchantId as Hex,
    invoiceShortCode: d.shortCode,
    payer: d.payer as Hex,
    amountOut: d.intent.amountOut,
    payoutToken: d.intent.payoutToken,
    inputToken: d.intent.inputToken,
    maxAmountIn: d.intent.maxAmountIn,
    fee: d.onchain?.fee ?? null,
    netToMerchant: d.onchain?.netToMerchant ?? null,
    inputAmount: d.onchain?.inputAmount ?? null,
    forwarder: (d.forwarder as Hex) ?? null,
    expiresAt: Number(d.intent.expiresAt),
    refundableAt: d.route === 'CROSSCHAIN' ? Number(d.intent.expiresAt) + ctx.deployment.config.refundDelaySec : null,
    crosschain:
      d.route === 'CROSSCHAIN' && cc?.mode
        ? {
            mode: cc.mode as 'live' | 'simulated',
            depositAddress: cc.depositAddress ?? null,
            originAssetId: cc.originAssetId ?? null,
            originAmountIn: cc.originAmountIn ?? null,
            providerStatus: cc.providerStatus ?? null,
            sourceChainId: cc.sourceChainId ?? null,
            sourceTxHash: cc.originTxHashes?.[0] ?? null,
            userSourceTx: cc.userSourceTx ?? null,
            received: cc.lastBalance ?? received,
            required: d.intent.maxAmountIn,
          }
        : null,
    txs: {
      submit: (d.txs?.submit as Hex) ?? null,
      commit: (d.txs?.commit as Hex) ?? null,
      settle: (d.txs?.settle as Hex) ?? null,
      refund: (d.txs?.refund as Hex) ?? null,
      attest: (d.txs?.attest as Hex) ?? null,
    },
    error: d.error?.code ? { code: d.error.code, message: d.error.message ?? '' } : null,
    timeline: (d.timeline ?? []).map((t) => ({ at: t.at!, status: t.status as IntentView['lifecycle'], note: t.note ?? '' })),
  };
}

export function paymentViewFromIntent(d: IntentDoc): PaymentView {
  const status = d.lifecycle === 'SETTLED' ? 'SETTLED' : d.lifecycle === 'REFUNDED' ? 'REFUNDED' : 'COMMITTED';
  return {
    chainId: d.chainId,
    intentId: d.intentId as Hex,
    invoiceId: d.invoiceId as Hex,
    payer: d.payer as Hex,
    route: ['DIRECT', 'SWAP', 'CROSSCHAIN'].indexOf(d.route),
    routeName: d.route as PaymentView['routeName'],
    status,
    inputToken: d.intent.inputToken,
    payoutToken: d.intent.payoutToken,
    amountOut: d.intent.amountOut,
    fee: d.onchain?.fee ?? null,
    netToMerchant: d.onchain?.netToMerchant ?? null,
    inputAmount: d.onchain?.inputAmount ?? null,
    committedAt: Math.floor(new Date((d as any).createdAt).getTime() / 1000),
    commitTx: ((d.txs?.commit ?? d.txs?.submit) as Hex) ?? ('0x' as Hex),
    settledAt: d.onchain?.settledAt ?? null,
    settleTx: (d.txs?.settle as Hex) ?? null,
    sourceChainId: d.crosschain?.sourceChainId ?? null,
    sourceTxHash: (d.crosschain?.originTxHashes?.[0] as Hex) ?? null,
  };
}
