# ScanPay Guard — Backend B: Progress & Architecture Reference

> Updated: 2026-10-12 · Monad Metropolis hackathon · Deadline: Tue 13 Oct 2026, 23:59 ET

---

## Status Summary

All core phases (B0–B25) are complete. Integration fixes applied Oct 12. Remaining work is deployment-gated (needs Backend A contract addresses).

| Phase range | Area | Status |
|---|---|---|
| B0–B5 | Repo scaffold, shared SDK stubs, MongoDB models, env, chains | ✅ Done |
| B6–B9 | HTTP server, auth, idempotency, config/fx routes | ✅ Done |
| B10 | Merchant registration / rotation / payout relay | ✅ Done |
| B11 | Invoice storage, short-code QR, merchant-signed invoices | ✅ Done |
| B12 | Routes + quotes (DIRECT / SWAP / CROSSCHAIN) | ✅ Done |
| B13 | Intent prepare (all 3 routes) | ✅ Done |
| B14 | Intent submit — DIRECT (payDirect relay) | ✅ Done |
| B15 | Intent submit — SWAP (paySwap relay + Kuru swapData) | ✅ Done |
| B16 | Intent submit — CROSSCHAIN (commitCrossChain relay) | ✅ Done |
| B17 | Chain follower (on-chain events → MongoDB → SSE) | ✅ Done |
| B18 | Cross-chain watcher (forwarder poll → settle/refund/attest) | ✅ Done |
| B19 | Aurora Intents API integration (quote / submit / status) | ✅ Done + fixed |
| B20 | Kuru Flow adapter (exact-out quote + swapData encoding) | ✅ Done |
| B21 | Envio HyperIndex GraphQL reads | ✅ Done + fixed |
| B22 | SSE streams (intent, merchant, invoice channels) | ✅ Done |
| B23 | Attack Lab (scenarios, routes, proof of reverts) | ✅ Done |
| B24 | Faucet + gas drip (testnet) | ✅ Done |
| B25 | Full test suite (7 unit + 35 integration, all passing) | ✅ Done |
| B26 | ABI/type audit — a-stubs.ts fixed | ✅ Done Oct 12 |
| B27 | Aurora crosschain.ts bugs fixed (4 bugs) | ✅ Done Oct 12 |
| B28 | Envio auth header fixed (Hasura admin secret) | ✅ Done Oct 12 |
| B29 | e2e tests against real anvil | ⏳ Needs I1 from Backend A |
| B30 | Railway deployment | ⏳ Needs I2 (testnet addresses) |
| B31 | Mainnet runbook | ⏳ Needs I4 (mainnet deployment) |

---

## Integration Fixes Applied Oct 12

### B26 — `a-stubs.ts` ABI / EIP-712 audit (all silent bugs)

All fixes cross-referenced against `ScanPayTypes.sol`.

| Bug | Before | After | Impact |
|---|---|---|---|
| Domain name (vault) | `'ScanPay'` | `'ScanPayGuard'` | All vault signatures verified wrong |
| Domain name (registry) | `'ScanPay'` | `'ScanPayRegistry'` | All registry signatures verified wrong |
| `computeMerchantId` | `keccak256(string concat)` | `keccak256(encodeAbiParameters([address, bytes32]))` | IDs never matched on-chain |
| `computeIntentId` | same wrong pattern | `keccak256(encodeAbiParameters([bytes32, bytes32, address, uint256]))` | IDs never matched on-chain |
| `keyVersion` type | `uint8` | `uint32` | Wrong calldata encoding, wrong EIP-712 type hash |
| `expiresAt` / `deadline` type | `uint256` | `uint64` | Wrong calldata encoding, wrong EIP-712 type hash |
| `intentDigest` return type | cast error | `hashTypedData(...) as any` | TypeScript compile error |
| `getMerchant` return tuple | missing fields | full 8-field tuple matching `MerchantRecord` | Wrong struct decoding |
| `getIntent` return tuple | wrong field order | matches `IntentRecord` struct order | Wrong struct decoding |
| Missing vault functions | — | added `rescue`, `hashIntent`, `computeIntentId`, `usedNonce` | Calls would fail at runtime |
| Missing registry functions | — | added `computeMerchantId`, `setPayoutTokenAllowed` | Calls would fail at runtime |

### B27 — `crosschain.ts` worker bugs (4 bugs)

| # | Bug | Fix |
|---|---|---|
| 1 | `auroraStatus(correlationId)` — wrong param | changed to `auroraStatus(depositAddress)` — status polling was completely broken |
| 2 | `INCOMPLETE_DEPOSIT` never handled | added → pushes `UNDERPAID` lifecycle |
| 3 | No `RECONCILIATION_REQUIRED` detection | added: provider `SUCCESS` + forwarder short > 90s → push `RECONCILIATION_REQUIRED` |
| 4 | Mainnet settle with empty `swapData = '0x'` | added: fetch fresh Kuru swapData when `isMainnet && adapterKind === 'kuru' && inputToken !== payoutToken` |

Also added `timeWhenInactive` field to `AuroraQuote` interface + `aurora.ts`.

### B28 — Envio Hasura auth (`envio.ts`)

Envio runs Hasura locally. Without `x-hasura-admin-secret` header, every GraphQL query returns unauthorized.

- `setEnvioUrl(url, secret?)` — now accepts optional admin secret
- `gql()` — includes `x-hasura-admin-secret` header when secret is set
- `env.ts` — added `ENVIO_ADMIN_SECRET` optional env var
- `.env` — set `ENVIO_ADMIN_SECRET=testing` for local dev (Envio Docker default)
- For hosted Envio Cloud: set `ENVIO_ADMIN_SECRET` to the Cloud dashboard secret

---

## End-to-End Process: What Happens in Backend B

### Startup

```
index.ts
  → loadEnv()              validates all env vars (zod schema)
  → connectDb()            MongoDB Atlas (or local)
  → initChains()           builds ChainCtx per enabled chain (RPC client, operator wallet, contract addresses)
  → setEnvioUrl()          GraphQL endpoint + Hasura secret
  → configureAurora()      API key for Aurora Intents
  → buildApp()             Fastify routes registered
  → startWorker()          spawns follower + crosschain watcher per chain
```

---

### HTTP Flow: A Payment from Scan to Settlement

```
QR Scan (FE)
    │
    ▼
GET /v1/routes?shortCode=<sc>
    loadPayable(shortCode)                   → Invoice + Merchant from MongoDB
    routesFor(ctx, invoice)                  → which of DIRECT / SWAP / CROSSCHAIN are available
    priceCrossChain: originAssets()          → Aurora /api/tokens (cached 10 min)
    returns: { direct, swap, crosschain }

    │ user picks route + input token
    ▼
POST /v1/quotes  (optional preview, no DB write)
    priceSwap: kuruExactOut()                → Kuru /api/quote (exact-out)
    priceCrossChain: auroraQuote(dry=true)   → Aurora /api/quote/{key}
    returns: maxAmountIn, estimatedIn, feeBps, expiresAt

    │ user confirms
    ▼
POST /v1/intents/prepare
    randomNonce() → computeIntentId()        → deterministic bytes32 ID
    intentVault.forwarderOf(intentId)        → on-chain read: deposit forwarder address
    auroraQuote(dry=false)                   → live quote with real depositAddress
    Intent.create({ lifecycle: 'DRAFT' })    → saved to MongoDB with TTL
    returns: intent to sign, EIP-712 domain, receiveAuth (DIRECT only), crosschain forwarder

    │ user signs with Mera passkey (EIP-712)
    ▼
POST /v1/intents/submit
    ctx.public.verifyTypedData(payerSig)     → verify EIP-712 on-chain, no gas

    ┌─ DIRECT ──────────────────────────────────────────────────────────────────────┐
    │  verifyTypedData(receiveAuthSig)                                               │
    │  relay vault.payDirect(intent, invoice, merchantSig, payerSig, authSig)       │
    │  lifecycle: DRAFT → SUBMITTED → SETTLED  (single tx, receipt has PaymentSettled)│
    └───────────────────────────────────────────────────────────────────────────────┘

    ┌─ SWAP ─────────────────────────────────────────────────────────────────────────┐
    │  kuruSwapData()  → Kuru fresh quote → encodeAbiParameters([address, bytes])    │
    │  relay vault.paySwap(intent, invoice, merchantSig, payerSig, swapData)         │
    │  lifecycle: DRAFT → SUBMITTED → SETTLED                                        │
    └───────────────────────────────────────────────────────────────────────────────┘

    ┌─ CROSSCHAIN ───────────────────────────────────────────────────────────────────┐
    │  relay vault.commitCrossChain(intent, invoice, merchantSig, payerSig)          │
    │  lifecycle: DRAFT → COMMITTED                                                  │
    │  returns: depositAddress (user now sends funds on origin chain)                │
    └───────────────────────────────────────────────────────────────────────────────┘
```

---

### Background Worker: Two Loops Per Chain

#### Loop A — Chain Follower (`follower.ts`)

Polls chain every 3s in 500-block batches. Processes logs from both `IntentVault` and `MerchantRegistry` in block order.

```
getLogs(vault, fromBlock, toBlock)
getLogs(registry, fromBlock, toBlock)
sort by blockNumber + transactionIndex
for each log → applyLog(ctx, log, meta)
save cursor (lastBlock)
```

Event handling in `settlement.ts`:

| On-chain event | MongoDB write | SSE push |
|---|---|---|
| `IntentCommitted` (CROSSCHAIN) | lifecycle `AWAITING_DEPOSIT`, stores forwarder | `intent.updated` |
| `PaymentSettled` | lifecycle `SETTLED`, fee/amounts/netToMerchant, invoice → `PAID` | `intent.updated` + `payment.settled` + `invoice.updated` |
| `IntentRefunded` | lifecycle `REFUNDED`, invoice → `OPEN` | `intent.updated` |
| `SourceAttested` | stores sourceChainId + sourceTxHash | `intent.updated` |
| `MerchantRegistered` | upsert Merchant doc | — |
| `MerchantStatusChanged` | update status | — |
| `InvoiceSignerRotated` | update invoiceSigner + keyVersion | — |
| `PayoutUpdated` | update payoutWallet + payoutToken | — |

**Rule**: `SETTLED` can only be set by a `PaymentSettled` log. Nothing else.

#### Loop B — Cross-Chain Watcher (`crosschain.ts`)

Polls every 15s. Finds all intents in open cross-chain states.

```
for each open cross-chain intent:

  1. Poll Aurora (live mode only):
     GET /api/status/{key}?depositAddress=<addr>
     PENDING_DEPOSIT / KNOWN_DEPOSIT_TX / PROCESSING → update providerStatus
     INCOMPLETE_DEPOSIT                               → push UNDERPAID
     SUCCESS + forwarder short > 90s                 → push RECONCILIATION_REQUIRED

  2. decideCrossChain(intent, balance, now):
     pure function → { action: 'wait' | 'settle' | 'refund' | 'attest' }

  3. Execute:
     settle  → (mainnet+kuru) kuruSwapData() → relay vault.settleCrossChain(intentId, swapData)
     refund  → relay vault.refundCrossChain(intentId)
     attest  → relay vault.attestSource(intentId, sourceChainId, sourceTxHash, providerRef)
```

---

### Real-Time Streaming (`bus.ts` + SSE)

```
GET /v1/stream/intent/:chainId/:intentId   → SSE channel per intent
GET /v1/stream/merchant/:chainId/:merchantId → SSE channel per merchant
GET /v1/stream/invoice/:shortCode          → SSE channel per invoice

publish() called by:
  - applyLog() when log is decoded (follower)
  - pushLifecycle() when worker changes state

Events: intent.updated | payment.settled | invoice.updated
```

The merchant dashboard lights up green the moment `PaymentSettled` is seen on-chain. No polling.

---

### Read APIs

| Endpoint | Source |
|---|---|
| `GET /v1/intents/:chainId/:intentId` | MongoDB (fast, no RPC) |
| `GET /v1/merchants/:chainId/:merchantId` | Envio GraphQL → fallback to on-chain RPC |
| `GET /v1/merchants/:chainId/:merchantId/payments` | Envio (paginated, with daily stats) |
| `GET /v1/allowance` | Live ERC-20 `allowance()` + `balanceOf()` via RPC |
| `GET /v1/config` | Chain config (tokens, contracts, feeBps) |
| `GET /v1/fx` | Live token prices |

---

## Environment Variables (.env)

```bash
# Backend B
PORT=8787
MONGODB_URI=mongodb://127.0.0.1:27017/scanpay
ENABLED_CHAINS=31337
OPERATOR_PRIVATE_KEY_LOCAL=0x59c6995e...      # anvil key #1
OPERATOR_PRIVATE_KEY_TESTNET=                  # fill from A at I2
OPERATOR_PRIVATE_KEY_MAINNET=                  # fill from A at I4
ADMIN_TOKEN=294c72e88a0f30905238a80b56a39ec6
AURORA_API_KEY=a1396017-4d3c-4210-b810-efb66b1902b7
ENVIO_GRAPHQL_URL=http://localhost:8080/v1/graphql
ENVIO_ADMIN_SECRET=testing                     # Hasura local default; Cloud dashboard secret for hosted
```

---

## What Completing Backend B Achieves

1. **Gasless payments**: users sign with a passkey — never hold gas, never see a transaction hash
2. **Three settlement paths**: direct ERC-3009, on-chain swap via Kuru, cross-chain via Aurora Intents
3. **Cryptographic proof**: every settlement is an on-chain `PaymentSettled` event — judges and the Attack Lab can verify it
4. **Merchant experience**: SSE push means the merchant's screen turns green in < 1 block after settlement
5. **Historical data**: Envio GraphQL gives fast paginated payment history and volume stats without hitting RPC
6. **Attack Lab**: demonstrates the contract's security guarantees (replay protection, signature binding, tamper-proof amounts) through live revert proofs — key for bounty judges
7. **Cross-chain UX**: payer on Base/Arbitrum/ETH sends USDC → merchant on Monad receives stablecoins → neither party sees a blockchain

---

## Remaining Work (deployment-gated)

| Phase | Blocker | What to do |
|---|---|---|
| B29 — e2e vs real anvil | Need I1: `pnpm chain:local` from Backend A | Run full flow against local anvil, not in-memory MongoDB |
| B30 — Railway deploy | Need I2: testnet contract addresses + `OPERATOR_PRIVATE_KEY_TESTNET` | Set env vars in Railway, `pnpm build && railway up` |
| B31 — Mainnet runbook | Need I4: mainnet addresses + `OPERATOR_PRIVATE_KEY_MAINNET` | Confirm `ENABLED_CHAINS=143`, deploy, monitor follower |

Also pending from Backend A:
- `ENVIO_GRAPHQL_URL` (hosted Envio Cloud URL, from I3)
- `ENVIO_ADMIN_SECRET` (hosted Envio Cloud secret)
- `MONGODB_URI` (Atlas connection string, replace local)
