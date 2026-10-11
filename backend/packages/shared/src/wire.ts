import { getAddress, type Address, type Hex } from 'viem';
import type {
  InvoiceMessage,
  PaymentIntentMessage,
  PayoutUpdateMessage,
  RegistrationMessage,
  SignerRotationMessage,
} from './types';

/** Wire rule (ICD §0.10): uint256/uint64 -> decimal string; uint8/uint32 -> number; hex -> lowercase. */
const lc = <T extends string>(x: T) => x.toLowerCase() as T;
const addr = (x: string): Address => lc(getAddress(x));

export type Wire<T> = { [K in keyof T]: T[K] extends bigint ? string : T[K] };

export const toWireInvoice = (m: InvoiceMessage): Wire<InvoiceMessage> => ({
  merchantId: lc(m.merchantId),
  invoiceId: lc(m.invoiceId),
  payoutToken: addr(m.payoutToken),
  amount: m.amount.toString(),
  expiresAt: m.expiresAt.toString(),
  keyVersion: m.keyVersion,
});

export const fromWireInvoice = (w: Wire<InvoiceMessage>): InvoiceMessage => ({
  merchantId: lc(w.merchantId) as Hex,
  invoiceId: lc(w.invoiceId) as Hex,
  payoutToken: addr(w.payoutToken),
  amount: BigInt(w.amount),
  expiresAt: BigInt(w.expiresAt),
  keyVersion: Number(w.keyVersion),
});

export const toWireIntent = (m: PaymentIntentMessage): Wire<PaymentIntentMessage> => ({
  merchantId: lc(m.merchantId),
  invoiceId: lc(m.invoiceId),
  payer: addr(m.payer),
  payoutToken: addr(m.payoutToken),
  amountOut: m.amountOut.toString(),
  route: m.route,
  inputToken: addr(m.inputToken),
  maxAmountIn: m.maxAmountIn.toString(),
  quoteHash: lc(m.quoteHash),
  refundTo: addr(m.refundTo),
  expiresAt: m.expiresAt.toString(),
  nonce: m.nonce.toString(),
  keyVersion: m.keyVersion,
});

export const fromWireIntent = (w: Wire<PaymentIntentMessage>): PaymentIntentMessage => ({
  merchantId: lc(w.merchantId) as Hex,
  invoiceId: lc(w.invoiceId) as Hex,
  payer: addr(w.payer),
  payoutToken: addr(w.payoutToken),
  amountOut: BigInt(w.amountOut),
  route: Number(w.route),
  inputToken: addr(w.inputToken),
  maxAmountIn: BigInt(w.maxAmountIn),
  quoteHash: lc(w.quoteHash) as Hex,
  refundTo: addr(w.refundTo),
  expiresAt: BigInt(w.expiresAt),
  nonce: BigInt(w.nonce),
  keyVersion: Number(w.keyVersion),
});

export const toWireRegistration = (m: RegistrationMessage): Wire<RegistrationMessage> => ({
  owner: addr(m.owner),
  salt: lc(m.salt),
  payoutWallet: addr(m.payoutWallet),
  invoiceSigner: addr(m.invoiceSigner),
  payoutToken: addr(m.payoutToken),
  metadataHash: lc(m.metadataHash),
  nonce: m.nonce.toString(),
  deadline: m.deadline.toString(),
});

export const fromWireRegistration = (w: Wire<RegistrationMessage>): RegistrationMessage => ({
  owner: addr(w.owner),
  salt: lc(w.salt) as Hex,
  payoutWallet: addr(w.payoutWallet),
  invoiceSigner: addr(w.invoiceSigner),
  payoutToken: addr(w.payoutToken),
  metadataHash: lc(w.metadataHash) as Hex,
  nonce: BigInt(w.nonce),
  deadline: BigInt(w.deadline),
});

export const toWireSignerRotation = (m: SignerRotationMessage): Wire<SignerRotationMessage> => ({
  merchantId: lc(m.merchantId),
  newSigner: addr(m.newSigner),
  nonce: m.nonce.toString(),
  deadline: m.deadline.toString(),
});

export const fromWireSignerRotation = (w: Wire<SignerRotationMessage>): SignerRotationMessage => ({
  merchantId: lc(w.merchantId) as Hex,
  newSigner: addr(w.newSigner),
  nonce: BigInt(w.nonce),
  deadline: BigInt(w.deadline),
});

export const toWirePayoutUpdate = (m: PayoutUpdateMessage): Wire<PayoutUpdateMessage> => ({
  merchantId: lc(m.merchantId),
  payoutWallet: addr(m.payoutWallet),
  payoutToken: addr(m.payoutToken),
  nonce: m.nonce.toString(),
  deadline: m.deadline.toString(),
});

export const fromWirePayoutUpdate = (w: Wire<PayoutUpdateMessage>): PayoutUpdateMessage => ({
  merchantId: lc(w.merchantId) as Hex,
  payoutWallet: addr(w.payoutWallet),
  payoutToken: addr(w.payoutToken),
  nonce: BigInt(w.nonce),
  deadline: BigInt(w.deadline),
});
