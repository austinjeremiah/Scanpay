import mongoose, { Schema, type Document } from 'mongoose';

// ------------------------------------------------------------------ Merchant
const MerchantSchema = new Schema({
  chainId: { type: Number, required: true },
  merchantId: { type: String, required: true },
  owner: String,
  salt: String,
  payoutWallet: String,
  invoiceSigner: String,
  payoutToken: String,
  keyVersion: { type: Number, default: 1 },
  status: { type: String, default: 'PENDING' },
  metadataHash: String,
  profile: {
    displayName: String, category: String, city: String, country: String, logoUrl: String,
  },
  registeredAt: Number,
  registeredTx: String,
}, { timestamps: true });
MerchantSchema.index({ chainId: 1, merchantId: 1 }, { unique: true });
MerchantSchema.index({ chainId: 1, owner: 1 });
MerchantSchema.index({ chainId: 1, status: 1 });
export const Merchant = mongoose.model('Merchant', MerchantSchema);

// ------------------------------------------------------------------ Invoice
const InvoiceSchema = new Schema({
  shortCode: { type: String, required: true, unique: true },
  chainId: { type: Number, required: true },
  merchantId: { type: String, required: true },
  invoiceId: { type: String, required: true },
  invoice: Schema.Types.Mixed,
  merchantSig: String,
  memo: String,
  fiat: { currency: String, amount: String },
  requestId: String,
  expiresAt: Number,
  state: { type: String, default: 'OPEN' },
  paidIntentId: String,
}, { timestamps: true });
InvoiceSchema.index({ chainId: 1, merchantId: 1, invoiceId: 1 }, { unique: true });
InvoiceSchema.index({ chainId: 1, merchantId: 1 });
InvoiceSchema.index({ expiresAt: 1, state: 1 });
export const Invoice = mongoose.model('Invoice', InvoiceSchema);

// ------------------------------------------------------------------ InvoiceRequest
const InvoiceRequestSchema = new Schema({
  requestId: { type: String, required: true, unique: true },
  chainId: { type: Number, required: true },
  merchantId: { type: String, required: true },
  amount: String,
  note: String,
  status: { type: String, default: 'PENDING' },
  shortCode: String,
  expiresAt: Number,
}, { timestamps: true });
InvoiceRequestSchema.index({ chainId: 1, merchantId: 1, status: 1 });
InvoiceRequestSchema.index({ expiresAt: 1 });
export const InvoiceRequest = mongoose.model('InvoiceRequest', InvoiceRequestSchema);

// ------------------------------------------------------------------ Intent
export interface IntentDoc extends Document {
  draftId: string;
  chainId: number;
  intentId: string;
  route: string;
  lifecycle: string;
  shortCode: string;
  merchantId: string;
  invoiceId: string;
  payer: string;
  intent: Record<string, any>;
  invoice: Record<string, any>;
  merchantSig: string;
  payerSig?: string;
  receiveAuthSig?: string;
  quote?: { fields: Record<string, any>; hash: string; simulated: boolean } | null;
  forwarder?: string;
  crosschain?: {
    mode: string; provider?: string; depositAddress?: string; originAssetId?: string; originSymbol?: string;
    originDecimals?: number; originAmountIn?: string; deadline?: number; correlationId?: string;
    providerStatus?: string; providerUpdatedAt?: number; providerSuccessAt?: number;
    originTxHashes?: string[]; destinationTxHashes?: string[]; sourceChainId?: number;
    userSourceTx?: string; lastBalance?: string;
  };
  onchain?: { fee?: string; inputAmount?: string; excessRefunded?: string; netToMerchant?: string; settledAt?: number; settledBlock?: number; refundAmount?: string };
  txs?: { submit?: string; commit?: string; settle?: string; refund?: string; attest?: string };
  error?: { code: string; message: string } | null;
  timeline?: Array<{ at: number; status: string; note?: string }>;
  expiresAt: number;
  draftExpiresAt: number;
  attackLab?: boolean;
}

const IntentSchema = new Schema({
  draftId: { type: String, required: true, unique: true },
  chainId: Number,
  intentId: { type: String, required: true },
  route: String,
  lifecycle: { type: String, default: 'DRAFT' },
  shortCode: String,
  merchantId: String,
  invoiceId: String,
  payer: String,
  intent: Schema.Types.Mixed,
  invoice: Schema.Types.Mixed,
  merchantSig: String,
  payerSig: String,
  receiveAuthSig: String,
  quote: Schema.Types.Mixed,
  forwarder: String,
  crosschain: Schema.Types.Mixed,
  onchain: Schema.Types.Mixed,
  txs: Schema.Types.Mixed,
  error: Schema.Types.Mixed,
  timeline: [{ at: Number, status: String, note: String }],
  expiresAt: Number,
  draftExpiresAt: Number,
  attackLab: Boolean,
  // TTL field: set when lifecycle=DRAFT, cleared on first non-DRAFT transition
  expireAt: { type: Date, default: null },
}, { timestamps: true });
IntentSchema.index({ chainId: 1, intentId: 1 }, { unique: true });
IntentSchema.index({ chainId: 1, merchantId: 1, lifecycle: 1 });
IntentSchema.index({ chainId: 1, route: 1, lifecycle: 1 });
IntentSchema.index({ 'crosschain.depositAddress': 1 });
IntentSchema.index({ expiresAt: 1 });
// MongoDB auto-deletes document when expireAt is reached (sparse: drafts only)
IntentSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0, sparse: true });
export const Intent = mongoose.model<IntentDoc>('Intent', IntentSchema);

// ------------------------------------------------------------------ AuditLog
const AuditLogSchema = new Schema({
  source: String,
  action: String,
  chainId: Number,
  subject: String,
  data: Schema.Types.Mixed,
  at: { type: Date, default: Date.now },
});
AuditLogSchema.index({ chainId: 1, subject: 1 });
AuditLogSchema.index({ at: -1 });
const AuditLog = mongoose.model('AuditLog', AuditLogSchema);

export async function audit(source: string, action: string, chainId: number, subject: string, data?: unknown) {
  await AuditLog.create({ source, action, chainId, subject, data });
}

// ------------------------------------------------------------------ Idempotency
const IdempotencySchema = new Schema({
  key: { type: String, required: true, unique: true },
  chainId: Number,
  response: Schema.Types.Mixed,
  statusCode: Number,
  createdAt: { type: Date, default: Date.now, expires: 86400 },
});
export const Idempotency = mongoose.model('Idempotency', IdempotencySchema);

// ------------------------------------------------------------------ DripLog
const DripLogSchema = new Schema({
  chainId: Number,
  address: String,
  kind: String,
  txHash: String,
  at: { type: Date, default: Date.now },
});
DripLogSchema.index({ chainId: 1, address: 1, kind: 1, at: 1 });
export const DripLog = mongoose.model('DripLog', DripLogSchema);

// ------------------------------------------------------------------ Cursor (event follower position)
const CursorSchema = new Schema({
  chainId: { type: Number, required: true, unique: true },
  lastBlock: { type: Number, default: 0 },
  updatedAt: { type: Date, default: Date.now },
});
export const Cursor = mongoose.model('Cursor', CursorSchema);

// ------------------------------------------------------------------ LabState (Attack Lab)
const LabStateSchema = new Schema({
  chainId: { type: Number, required: true, unique: true },
  merchantKey: String,
  payerKey: String,
  merchantSalt: String,
});
export const LabState = mongoose.model('LabState', LabStateSchema);
