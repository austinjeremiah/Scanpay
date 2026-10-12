import { z } from 'zod';
import type { Address, Hex } from 'viem';

// ------------------------------------------------------------------ primitives
const lower = <T extends string>(s: string) => s.toLowerCase() as T;
export const zHex = z.string().regex(/^0x[0-9a-fA-F]*$/).transform((s) => lower<Hex>(s));
export const zAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'address').transform((s) => lower<Address>(s));
export const zBytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'bytes32').transform((s) => lower<Hex>(s));
export const zSig = z.string().regex(/^0x[0-9a-fA-F]{130}$/, '65-byte signature').transform((s) => lower<Hex>(s));
export const zUint = z.string().regex(/^\d+$/, 'decimal integer string');
export const zChainId = z.coerce.number().int().refine((x) => [31337, 10143, 143].includes(x), 'unknown chainId');
export const zTokenKey = z.enum(['USDC', 'AUSD', 'MON', 'WMON', 'WETH', 'USDT0']);
// TokenKey is declared in ./types (A-owned) — identical union. Keep one source of truth.
// A compile-time proof that the zod enum and the A-owned union still agree lives in
// test/b-owned.test.ts; if they diverge, that assertion fails rather than silently drifting.
export const zRouteName = z.enum(['DIRECT', 'SWAP', 'CROSSCHAIN']);
export const zMerchantStatusName = z.enum(['NONE', 'PENDING', 'ACTIVE', 'SUSPENDED', 'REVOKED']);
export const zLifecycle = z.enum([
  'DRAFT', 'SUBMITTED', 'COMMITTED', 'AWAITING_DEPOSIT', 'PROCESSING', 'SETTLED', 'UNDERPAID',
  'RECONCILIATION_REQUIRED', 'EXPIRED', 'REFUNDED', 'FAILED',
]);
export type Lifecycle = z.infer<typeof zLifecycle>;
// RouteName is declared in ./constants (A-owned) — identical union.

// ------------------------------------------------------------------ wire messages (ICD §0.10 wire rule)
export const zWireInvoice = z.object({
  merchantId: zBytes32, invoiceId: zBytes32, payoutToken: zAddress, amount: zUint, expiresAt: zUint,
  keyVersion: z.number().int().nonnegative(),
});
export const zWireIntent = z.object({
  merchantId: zBytes32, invoiceId: zBytes32, payer: zAddress, payoutToken: zAddress, amountOut: zUint,
  route: z.number().int().min(0).max(2), inputToken: zAddress, maxAmountIn: zUint, quoteHash: zBytes32,
  refundTo: zAddress, expiresAt: zUint, nonce: zUint, keyVersion: z.number().int().nonnegative(),
});
export const zWireRegistration = z.object({
  owner: zAddress, salt: zBytes32, payoutWallet: zAddress, invoiceSigner: zAddress, payoutToken: zAddress,
  metadataHash: zBytes32, nonce: zUint, deadline: zUint,
});
export const zWireSignerRotation = z.object({ merchantId: zBytes32, newSigner: zAddress, nonce: zUint, deadline: zUint });
export const zWirePayoutUpdate = z.object({
  merchantId: zBytes32, payoutWallet: zAddress, payoutToken: zAddress, nonce: zUint, deadline: zUint,
});
export const zProfile = z.object({
  displayName: z.string().trim().min(1).max(60),
  category: z.string().trim().max(40),
  city: z.string().trim().max(60),
  country: z.string().regex(/^[A-Z]{2}$/, 'ISO-3166 alpha-2'),
  logoUrl: z.union([z.string().url().max(300), z.literal('')]),
});
export type Profile = z.infer<typeof zProfile>;

// ------------------------------------------------------------------ shared views
export const zMerchantView = z.object({
  chainId: z.number(), merchantId: zBytes32, owner: zAddress, payoutWallet: zAddress, invoiceSigner: zAddress,
  payoutToken: zAddress, payoutTokenKey: zTokenKey.nullable(), keyVersion: z.number(), status: zMerchantStatusName,
  registeredAt: z.number(), profile: zProfile.nullable(), profileVerified: z.boolean(),
});
export type MerchantView = z.infer<typeof zMerchantView>;

export const zPaymentView = z.object({
  chainId: z.number(), intentId: zBytes32, invoiceId: zBytes32, payer: zAddress, route: z.number(),
  routeName: zRouteName, status: z.enum(['COMMITTED', 'SETTLED', 'REFUNDED']), inputToken: zAddress,
  payoutToken: zAddress, amountOut: zUint, fee: zUint.nullable(), netToMerchant: zUint.nullable(),
  inputAmount: zUint.nullable(), committedAt: z.number(), commitTx: zHex, settledAt: z.number().nullable(),
  settleTx: zHex.nullable(), sourceChainId: z.number().nullable(), sourceTxHash: zHex.nullable(),
});
export type PaymentView = z.infer<typeof zPaymentView>;

export const zStoredQuote = z.object({
  fields: z.any(),
  hash: zBytes32,
  simulated: z.boolean(),
});

export const zTimelineEntry = z.object({ at: z.number(), status: zLifecycle, note: z.string() });

export const zIntentView = z.object({
  chainId: z.number(), intentId: zBytes32, route: zRouteName, lifecycle: zLifecycle, merchantId: zBytes32,
  invoiceShortCode: z.string(), payer: zAddress, amountOut: zUint, payoutToken: zAddress, inputToken: zAddress,
  maxAmountIn: zUint, fee: zUint.nullable(), netToMerchant: zUint.nullable(), inputAmount: zUint.nullable(),
  forwarder: zAddress.nullable(), expiresAt: z.number(), refundableAt: z.number().nullable(),
  crosschain: z
    .object({
      mode: z.enum(['live', 'simulated']), depositAddress: z.string().nullable(), originAssetId: z.string().nullable(),
      originAmountIn: zUint.nullable(), providerStatus: z.string().nullable(), sourceChainId: z.number().nullable(),
      sourceTxHash: z.string().nullable(), userSourceTx: z.string().nullable(), received: zUint, required: zUint,
    })
    .nullable(),
  txs: z.object({
    submit: zHex.nullable(), commit: zHex.nullable(), settle: zHex.nullable(), refund: zHex.nullable(),
    attest: zHex.nullable(),
  }),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  timeline: z.array(zTimelineEntry),
});
export type IntentView = z.infer<typeof zIntentView>;

// ------------------------------------------------------------------ requests / responses
export const zErrorBody = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional(), requestId: z.string() }),
});

// health + config
export const zHealthRes = z.object({
  ok: z.boolean(), version: z.string(), uptimeSec: z.number(), mongo: z.enum(['up', 'down']),
  chains: z.array(z.object({ chainId: z.number(), block: zUint.nullable(), operator: zAddress, operatorBalance: zUint.nullable() })),
});
export const zChainFeatures = z.object({
  direct: z.boolean(), swap: z.boolean(), crosschain: z.enum(['live', 'simulated', 'off']), faucet: z.boolean(),
  attackLab: z.boolean(), indexer: z.boolean(),
});
export const zConfigRes = z.object({
  icdVersion: z.number(), publicAppUrl: z.string(),
  chains: z.array(z.object({ chainId: z.number(), deployment: z.any(), features: zChainFeatures })),
});
export type ConfigRes = z.infer<typeof zConfigRes>;

export const zFxRes = z.object({
  base: z.literal('USD'), quote: z.string(), rate: z.number(), asOf: z.string(), source: z.string(), stale: z.boolean(),
});

// merchants
export const zRegisterReq = z.object({
  chainId: zChainId, registration: zWireRegistration, ownerSig: zSig, payoutSig: zSig, profile: zProfile,
});
export const zRegisterRes = z.object({
  merchantId: zBytes32, txHash: zHex, status: zMerchantStatusName, autoApproved: z.boolean(), approveTxHash: zHex.nullable(),
});
export const zRotateReq = z.object({ chainId: zChainId, rotation: zWireSignerRotation, ownerSig: zSig });
export const zPayoutReq = z.object({ chainId: zChainId, update: zWirePayoutUpdate, ownerSig: zSig, payoutSig: zSig });
export const zKeyChangeRes = z.object({ merchantId: zBytes32, txHash: zHex, keyVersion: z.number() });
export const zMerchantsRes = z.object({ merchants: z.array(zMerchantView) });
export const zPaymentsRes = z.object({ items: z.array(zPaymentView), source: z.enum(['envio', 'db']) });
export const zStatsRes = z.object({
  paymentCount: z.number(), settledVolume: zUint, netReceived: zUint, feesPaid: zUint,
  daily: z.array(z.object({ dayStart: z.number(), payments: z.number(), volume: zUint, net: zUint })),
  source: z.enum(['envio', 'db']),
});
export const zKeyEventsRes = z.object({
  events: z.array(z.object({
    kind: z.enum(['REGISTERED', 'STATUS', 'SIGNER_ROTATED', 'PAYOUT_UPDATED']), keyVersion: z.number(),
    invoiceSigner: zAddress.nullable(), payoutWallet: zAddress.nullable(), payoutToken: zAddress.nullable(),
    fromStatus: z.number().nullable(), toStatus: z.number().nullable(), timestamp: z.number(), txHash: zHex,
  })),
  source: z.enum(['envio', 'db']),
});
export const zAdminActionRes = z.object({ txHash: zHex, status: zMerchantStatusName });

// invoices + QR
export const zCreateInvoiceReq = z.object({
  chainId: zChainId, invoice: zWireInvoice, merchantSig: zSig,
  memo: z.string().trim().max(140).optional(),
  fiat: z.object({ currency: z.string().regex(/^[A-Z]{3}$/), amount: z.string().regex(/^\d+(\.\d{1,2})?$/) }).optional(),
  requestId: z.string().optional(),
});
export const zInvoiceCreatedRes = z.object({
  shortCode: z.string(), invoiceId: zBytes32, url: z.string(), qrPayload: z.string(), expiresAt: z.number(),
});
export const zInvoiceView = z.object({
  shortCode: z.string(), chainId: z.number(), invoice: zWireInvoice, merchantSig: zSig, merchant: zMerchantView,
  state: z.enum(['OPEN', 'RESERVED', 'PAID', 'EXPIRED']), payoutTokenKey: zTokenKey.nullable(),
  memo: z.string().nullable(), fiat: z.object({ currency: z.string(), amount: z.string() }).nullable(),
  paidIntentId: zBytes32.nullable(), createdAt: z.number(),
});
export type InvoiceView = z.infer<typeof zInvoiceView>;
export const zInvoiceListRes = z.object({ invoices: z.array(zInvoiceView) });
export const zInvoiceRequestReq = z.object({
  chainId: zChainId, merchantId: zBytes32, amount: zUint, note: z.string().trim().max(140).optional(),
});
export const zInvoiceRequestRes = z.object({
  requestId: z.string(), chainId: z.number(), merchantId: zBytes32, amount: zUint, note: z.string().nullable(),
  status: z.enum(['PENDING', 'FULFILLED', 'CANCELLED', 'EXPIRED']), shortCode: z.string().nullable(), expiresAt: z.number(),
});
export const zInvoiceRequestListRes = z.object({ requests: z.array(zInvoiceRequestRes) });
export const zQrResolveRes = z.object({
  kind: z.enum(['invoice', 'merchant', 'unknown']),
  verified: z.boolean(),
  shortCode: z.string().nullable(), chainId: z.number().nullable(), merchantId: zBytes32.nullable(),
  merchant: zMerchantView.nullable(), warnings: z.array(z.string()),
});

// routes + quotes + intents
export const zOriginAsset = z.object({
  assetId: z.string(), blockchain: z.string(), symbol: z.string(), decimals: z.number(),
  priceUsd: z.number().nullable(), evmChainId: z.number().nullable(), contractAddress: z.string().nullable(),
});
export const zRoutesRes = z.object({
  chainId: z.number(), shortCode: z.string(), amountOut: zUint, payoutTokenKey: zTokenKey.nullable(),
  direct: z.object({ available: z.boolean(), tokens: z.array(zTokenKey), reason: z.string().nullable() }),
  swap: z.object({ available: z.boolean(), tokens: z.array(zTokenKey), reason: z.string().nullable() }),
  crosschain: z.object({
    available: z.boolean(), mode: z.enum(['live', 'simulated', 'off']), originAssets: z.array(zOriginAsset),
    reason: z.string().nullable(),
  }),
});
export const zQuoteReq = z.object({
  shortCode: z.string(), route: zRouteName, inputTokenKey: zTokenKey.optional(), originAssetId: z.string().optional(),
  payer: zAddress,
});
export const zQuoteRes = z.object({
  route: zRouteName, provider: z.string(), inputToken: zAddress, inputTokenKey: zTokenKey.nullable(),
  amountOut: zUint, maxAmountIn: zUint, estimatedIn: zUint, originAssetId: z.string().nullable(),
  originAmountIn: zUint.nullable(), expiresAt: z.number(), feeBps: z.number(), simulated: z.boolean(),
});
export type QuoteRes = z.infer<typeof zQuoteRes>;
export const zPrepareReq = z.object({
  shortCode: z.string(), route: zRouteName, inputTokenKey: zTokenKey.optional(),
  origin: z.object({ assetId: z.string(), refundTo: z.string().min(4).max(128) }).optional(),
  payer: zAddress,
});
export const zPrepareRes = z.object({
  draftId: z.string(), chainId: z.number(), intentId: zBytes32, vault: zAddress,
  intent: zWireIntent, invoice: zWireInvoice, merchantSig: zSig, quote: zStoredQuote.nullable(),
  signing: z.object({
    intent: z.literal(true),
    receiveAuth: z.object({ token: zAddress, domain: z.object({ name: z.string(), version: z.string() }) }).nullable(),
  }),
  swap: z.object({ spender: zAddress, allowance: zUint, needsApproval: z.boolean(), dripAvailable: z.boolean() }).nullable(),
  crosschain: z.object({
    mode: z.enum(['live', 'simulated']), forwarder: zAddress, depositAddress: z.string(), originAssetId: z.string().nullable(),
    originSymbol: z.string().nullable(), originAmountIn: zUint.nullable(), originDecimals: z.number().nullable(),
    deadline: z.number(),
  }).nullable(),
  expiresAt: z.number(),
});
export type PrepareRes = z.infer<typeof zPrepareRes>;
export const zSubmitReq = z.object({ draftId: z.string(), payerSig: zSig, receiveAuthSig: zSig.optional() });
export const zSubmitRes = z.object({
  chainId: z.number(), intentId: zBytes32, lifecycle: zLifecycle, txHash: zHex.nullable(), forwarder: zAddress.nullable(),
  depositAddress: z.string().nullable(),
});
export const zSourceTxReq = z.object({ txHash: z.string().min(10).max(120) });
export const zSimulateDepositReq = z.object({ amount: zUint.optional() });
export const zTxRes = z.object({ txHash: zHex });

// verify
export const zCheck = z.object({ label: z.string(), ok: z.boolean().nullable(), detail: z.string() });
export const zProofSection = z.object({ ok: z.boolean().nullable(), checks: z.array(zCheck) });
export const zVerifyRes = z.object({
  chainId: z.number(), intentId: zBytes32,
  verdict: z.enum(['VERIFIED', 'PENDING', 'REFUNDED', 'FAILED', 'NOT_FOUND']),
  proofs: z.object({ merchant: zProofSection, intent: zProofSection, settlement: zProofSection }),
  links: z.object({ commitTx: z.string().nullable(), settleTx: z.string().nullable(), vault: z.string(), registry: z.string() }),
  trustNotes: z.array(z.string()),
});
export type VerifyRes = z.infer<typeof zVerifyRes>;

// wallet helpers
export const zAllowanceRes = z.object({ tokenKey: zTokenKey.nullable(), spender: zAddress, allowance: zUint, balance: zUint });
export const zDripReq = z.object({ chainId: zChainId, address: zAddress, tokenKey: zTokenKey });
export const zDripRes = z.object({ txHash: zHex, amountWei: zUint });
export const zFaucetReq = z.object({ chainId: zChainId, address: zAddress });
export const zFaucetRes = z.object({ txHashes: z.array(zHex), amounts: z.record(zTokenKey, zUint) });

// attack lab
export const zScenarioId = z.enum([
  'tamper_amount', 'tamper_destination', 'replay', 'expired', 'unregistered_qr', 'fake_provider_success',
  'forged_settlement_hash', 'wrong_token',
]);
export type ScenarioId = z.infer<typeof zScenarioId>;
export const zScenarioInfo = z.object({
  id: zScenarioId, title: z.string(), attack: z.string(), defense: z.string(), expectedError: z.string(),
  proofLayer: z.enum(['merchant', 'intent', 'settlement']),
});
export const zScenariosRes = z.object({ scenarios: z.array(zScenarioInfo) });
export const zAttackRunReq = z.object({ chainId: zChainId, scenario: zScenarioId, broadcast: z.boolean().default(false) });
export const zAttackResult = z.object({
  scenario: zScenarioId, title: z.string(), attack: z.string(), defense: z.string(), expectedError: z.string(),
  outcome: z.enum(['BLOCKED', 'NOT_BLOCKED']),
  observed: z.object({ errorName: z.string().nullable(), apiCode: z.string().nullable(), message: z.string() }),
  txHash: zHex.nullable(), explorerUrl: z.string().nullable(), durationMs: z.number(),
});
export type AttackResult = z.infer<typeof zAttackResult>;

// stats
export const zProtocolStatsRes = z.object({
  chainId: z.number(), merchants: z.number(), activeMerchants: z.number(), intents: z.number(), settled: z.number(),
  refunded: z.number(), volume: zUint, fees: zUint, crossChainSettled: z.number(), source: z.enum(['envio', 'db']),
});

// SSE event payloads (event: <name>\ndata: <json>)
export type SseEvent =
  | { type: 'intent.updated'; intent: IntentView }
  | { type: 'payment.settled'; payment: PaymentView }
  | { type: 'invoice.updated'; shortCode: string; state: InvoiceView['state'] }
  | { type: 'invoice_request.created'; request: z.infer<typeof zInvoiceRequestRes> }
  | { type: 'merchant.updated'; merchant: MerchantView }
  | { type: 'ping'; at: number };
