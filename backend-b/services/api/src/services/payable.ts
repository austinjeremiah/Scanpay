import type { Hex } from 'viem';
import { fromWireInvoice, MERCHANT_STATUS, INVOICE_STATE, type InvoiceMessage } from '@scanpay/shared';
import { chainCtx, type ChainCtx } from '../chains.js';
import { Invoice } from '../db/models.js';
import { ApiError } from '../errors.js';
import { nowSec } from '../util/time.js';
import { invoiceOnchainState, readMerchant } from './views.js';

export interface Payable {
  ctx: ChainCtx;
  doc: Record<string, any>;
  invoice: InvoiceMessage;
  merchantSig: Hex;
  payoutWallet: Hex;
}

export async function loadPayable(shortCode: string): Promise<Payable> {
  const doc = await Invoice.findOne({ shortCode }).lean();
  if (!doc) throw new ApiError('INVOICE_NOT_FOUND');
  const ctx = chainCtx(doc.chainId);
  const invoice = fromWireInvoice(doc.invoice);
  if (Number(invoice.expiresAt) <= nowSec() + 30) throw new ApiError('INVOICE_EXPIRED');
  const m = await readMerchant(ctx, invoice.merchantId);
  if (m.status !== MERCHANT_STATUS.ACTIVE) throw new ApiError('MERCHANT_NOT_ACTIVE');
  if (Number(m.keyVersion) !== invoice.keyVersion) throw new ApiError('MERCHANT_KEYS_CHANGED');
  const st = await invoiceOnchainState(ctx, invoice.merchantId, invoice.invoiceId);
  if (st !== INVOICE_STATE.OPEN) throw new ApiError('INVOICE_ALREADY_PAID');
  return { ctx, doc: doc as any, invoice, merchantSig: doc.merchantSig as Hex, payoutWallet: m.payoutWallet as Hex };
}
