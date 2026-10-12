import type { Hex } from 'viem';
import {
  buildInvoiceTypedData, fromWireInvoice, intentVaultAbi, MERCHANT_STATUS, INVOICE_STATE,
  type zCreateInvoiceReq, type zInvoiceRequestReq,
} from '@scanpay/shared';
import type { z } from 'zod';
import type { ChainCtx } from '../chains.js';
import { Invoice, InvoiceRequest } from '../db/models.js';
import { ApiError } from '../errors.js';
import { channel, publish } from '../bus.js';
import { newId, shortCode } from '../util/ids.js';
import { nowSec } from '../util/time.js';
import { invoiceOnchainState, invoiceView, merchantView, readMerchant } from './views.js';

const MAX_INVOICE_TTL = 7 * 24 * 3600;
const REQUEST_TTL = 10 * 60;

let publicAppUrl = 'http://localhost:3000';
export const setPublicAppUrl = (u: string) => (publicAppUrl = u.replace(/\/$/, ''));
export const invoiceUrl = (code: string) => `${publicAppUrl}/pay/${code}`;
export const merchantQrUrl = (chainId: number, merchantId: string) => `${publicAppUrl}/m/${chainId}/${merchantId.toLowerCase()}`;

export async function createInvoice(ctx: ChainCtx, req: z.infer<typeof zCreateInvoiceReq>) {
  const inv = fromWireInvoice(req.invoice);
  const now = nowSec();
  if (inv.amount <= 0n) throw new ApiError('TAMPERED_AMOUNT', 'Amount must be > 0');
  if (inv.expiresAt < BigInt(now + 60)) throw new ApiError('INVOICE_EXPIRED', 'Invoice must be valid for at least 60 s');
  if (inv.expiresAt > BigInt(now + MAX_INVOICE_TTL)) throw new ApiError('VALIDATION_ERROR', 'Invoice expiry too far in the future');

  const m = await readMerchant(ctx, inv.merchantId);
  if (m.status !== MERCHANT_STATUS.ACTIVE) throw new ApiError('MERCHANT_NOT_ACTIVE');
  if (Number(m.keyVersion) !== inv.keyVersion) throw new ApiError('MERCHANT_KEYS_CHANGED');
  if (m.payoutToken.toLowerCase() !== inv.payoutToken.toLowerCase()) throw new ApiError('TAMPERED_PAYOUT_TOKEN');
  const cap = (await ctx.public.readContract({
    address: ctx.vault, abi: intentVaultAbi, functionName: 'amountCap', args: [inv.payoutToken],
  })) as bigint;
  if (cap !== 0n && inv.amount > cap) throw new ApiError('AMOUNT_ABOVE_CAP', undefined, { cap: cap.toString() });

  const ok = await ctx.public.verifyTypedData({
    address: m.invoiceSigner, signature: req.merchantSig, ...buildInvoiceTypedData(ctx.chainId, ctx.vault, inv),
  } as any);
  if (!ok) throw new ApiError('INVALID_MERCHANT_SIGNATURE');
  if ((await invoiceOnchainState(ctx, inv.merchantId, inv.invoiceId)) !== INVOICE_STATE.OPEN) throw new ApiError('INVOICE_ALREADY_PAID');

  let code = shortCode();
  for (let i = 0; i < 3 && (await Invoice.exists({ shortCode: code })); i++) code = shortCode();

  await Invoice.create({
    shortCode: code, chainId: ctx.chainId, merchantId: inv.merchantId.toLowerCase(), invoiceId: inv.invoiceId.toLowerCase(),
    invoice: req.invoice, merchantSig: req.merchantSig, memo: req.memo ?? null, fiat: req.fiat, requestId: req.requestId ?? null,
    expiresAt: Number(inv.expiresAt),
  });

  if (req.requestId) {
    const r = await InvoiceRequest.findOneAndUpdate(
      { requestId: req.requestId, merchantId: inv.merchantId.toLowerCase(), status: 'PENDING' },
      { $set: { status: 'FULFILLED', shortCode: code } },
      { new: true },
    ).lean();
    if (r) publish(channel.request(r.requestId), { type: 'invoice.updated', shortCode: code, state: 'OPEN' });
  }

  return { shortCode: code, invoiceId: inv.invoiceId.toLowerCase() as Hex, url: invoiceUrl(code), qrPayload: invoiceUrl(code), expiresAt: Number(inv.expiresAt) };
}

export async function getInvoice(ctx: ChainCtx | null, code: string, resolveCtx: (chainId: number) => ChainCtx) {
  const doc = await Invoice.findOne({ shortCode: code }).lean();
  if (!doc) throw new ApiError('INVOICE_NOT_FOUND');
  return invoiceView(ctx ?? resolveCtx(doc.chainId), doc);
}

export async function listMerchantInvoices(ctx: ChainCtx, merchantId: Hex, limit = 50) {
  const docs = await Invoice.find({ chainId: ctx.chainId, merchantId: merchantId.toLowerCase() }).sort({ createdAt: -1 }).limit(limit).lean();
  return { invoices: await Promise.all(docs.map((d) => invoiceView(ctx, d))) };
}

function requestView(r: any) {
  return {
    requestId: r.requestId, chainId: r.chainId, merchantId: r.merchantId, amount: r.amount, note: r.note ?? null,
    status: r.status === 'PENDING' && r.expiresAt < nowSec() ? 'EXPIRED' : r.status, shortCode: r.shortCode ?? null,
    expiresAt: r.expiresAt,
  };
}

export async function createInvoiceRequest(ctx: ChainCtx, req: z.infer<typeof zInvoiceRequestReq>) {
  const m = await readMerchant(ctx, req.merchantId);
  if (m.status !== MERCHANT_STATUS.ACTIVE) throw new ApiError('MERCHANT_NOT_ACTIVE');
  if (BigInt(req.amount) <= 0n || BigInt(req.amount) > 10n ** 12n) throw new ApiError('VALIDATION_ERROR', 'amount out of range');
  const doc = await InvoiceRequest.create({
    requestId: newId('req'), chainId: ctx.chainId, merchantId: req.merchantId.toLowerCase(), amount: req.amount,
    note: req.note ?? null, expiresAt: nowSec() + REQUEST_TTL,
  });
  const view = requestView(doc.toObject());
  publish(channel.merchant(ctx.chainId, req.merchantId), { type: 'invoice_request.created', request: view as any });
  return view;
}

export async function getInvoiceRequest(requestId: string) {
  const r = await InvoiceRequest.findOne({ requestId }).lean();
  if (!r) throw new ApiError('NOT_FOUND');
  return requestView(r);
}

export async function listInvoiceRequests(ctx: ChainCtx, merchantId: Hex) {
  const rs = await InvoiceRequest.find({
    chainId: ctx.chainId, merchantId: merchantId.toLowerCase(), status: 'PENDING', expiresAt: { $gt: nowSec() },
  }).sort({ createdAt: -1 }).limit(20).lean();
  return { requests: rs.map(requestView) };
}

export async function resolveQr(data: string, resolveCtx: (chainId: number) => ChainCtx) {
  const warnings: string[] = [];
  let u: URL;
  try {
    u = new URL(data.trim());
  } catch {
    return { kind: 'unknown' as const, verified: false, shortCode: null, chainId: null, merchantId: null, merchant: null, warnings: ['Not a ScanPay QR code.'] };
  }
  const expectedHost = new URL(publicAppUrl).host;
  if (u.host !== expectedHost) warnings.push(`This QR points to ${u.host}, not ScanPay (${expectedHost}). Do not pay.`);

  const pay = u.pathname.match(/^\/pay\/([a-z0-9]{6,16})$/);
  if (pay) {
    const doc = await Invoice.findOne({ shortCode: pay[1] }).lean();
    if (!doc) return { kind: 'invoice' as const, verified: false, shortCode: pay[1], chainId: null, merchantId: null, merchant: null, warnings: [...warnings, 'Unknown payment link.'] };
    const ctx = resolveCtx(doc.chainId);
    const merchant = await merchantView(ctx, doc.merchantId as Hex);
    if (!merchant || merchant.status !== 'ACTIVE') warnings.push('Merchant is not verified.');
    return {
      kind: 'invoice' as const, verified: warnings.length === 0, shortCode: doc.shortCode, chainId: doc.chainId,
      merchantId: doc.merchantId as Hex, merchant, warnings,
    };
  }
  const mq = u.pathname.match(/^\/m\/(\d+)\/(0x[0-9a-fA-F]{64})$/);
  if (mq) {
    const chainId = Number(mq[1]);
    const ctx = resolveCtx(chainId);
    const merchant = await merchantView(ctx, mq[2].toLowerCase() as Hex);
    if (!merchant) warnings.push('This merchant is not registered on ScanPay.');
    else if (merchant.status !== 'ACTIVE') warnings.push(`Merchant status: ${merchant.status}.`);
    if (merchant && !merchant.profileVerified) warnings.push('Merchant profile could not be verified.');
    return { kind: 'merchant' as const, verified: warnings.length === 0, shortCode: null, chainId, merchantId: mq[2].toLowerCase() as Hex, merchant, warnings };
  }
  return { kind: 'unknown' as const, verified: false, shortCode: null, chainId: null, merchantId: null, merchant: null, warnings: [...warnings, 'Not a ScanPay QR code.'] };
}
