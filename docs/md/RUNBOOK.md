# ScanPay Guard — runbook

How to get the backend running, confirm it works, and wire a frontend to it.
Everything below has been run end-to-end on Monad testnet **and** mainnet.

---

## 1. Where things stand

| Piece | State |
|---|---|
| Contracts | deployed + Sourcify-verified on **testnet (10143)** and **mainnet (143)** |
| Backend API | one service, both chains, running locally |
| Indexer | Envio Cloud, public GraphQL, indexing both chains |
| Routes | **DIRECT, SWAP, CROSSCHAIN all settled and verified on both chains** |
| Tests | 192 passing — 135 contracts, 42 API, 15 shared |

Proof transactions with explorer links: [`docs/md/evidence/proof-transactions.md`](evidence/proof-transactions.md).

Nothing is stubbed. Testnet uses our own mock ERC-20s (so a Monad testnet reset can't
break the demo); mainnet uses real USDC, real AUSD, real Kuru, real Aurora.

---

## 2. Run it locally

**Needs:** Node 22+, pnpm 9+, Docker (for the local indexer only), MongoDB on `:27017`,
and Foundry (`cast`, `forge`, `anvil`) if you want a local chain.

```bash
git pull && pnpm install
cp .env.example .env     # if you don't already have .env — ask Austin for the filled one
```

### Against Monad testnet (what you want 95% of the time)

```bash
pnpm api:dev
```

Serves on **http://localhost:8787**. No local chain needed — it talks to the deployed
testnet contracts.

Confirm it's alive:

```bash
curl -s localhost:8787/health | jq
```

You should see `"ok": true`, `"mongo": "up"`, and a `chains` entry per enabled chain
with the relayer's balance.

### Against a local chain instead

```bash
pnpm chain:local      # boots anvil, deploys everything, keeps running
```

Addresses are deterministic, so you get the same ones every time. Then set
`ENABLED_CHAINS=31337` in `.env` and run `pnpm api:dev`.

---

## 3. Prove it works

One command runs a full payment — registers a merchant, mints, signs an invoice,
prepares, submits and verifies:

```bash
cd backend/services/api
pnpm exec tsx --env-file=../../../.env scripts/e2e-routes.ts 10143 DIRECT      # ~15s
pnpm exec tsx --env-file=../../../.env scripts/e2e-routes.ts 10143 SWAP
pnpm exec tsx --env-file=../../../.env scripts/e2e-routes.ts 10143 CROSSCHAIN
pnpm exec tsx --env-file=../../../.env scripts/e2e-routes.ts 10143 all
```

A good run ends with:

```
   tx 0x…   lifecycle SETTLED
   merchant received 1.22631 USDC
   VERDICT: VERIFIED
     ok   merchant
     ok   intent
     ok   settlement
```

Unit/integration tests:

```bash
pnpm api:test        # 42
pnpm shared:test     # 15
pnpm contracts:test  # 135
```

---

## 4. Wiring a frontend

Base URL `http://localhost:8787`. Everything is JSON. No auth except admin routes
(`Authorization: Bearer $ADMIN_TOKEN`).

### The payment flow you implement

```
GET  /v1/config                      → chains, contracts, tokens, features
GET  /v1/invoices/:shortCode         → what the QR resolves to (merchant, amount)
GET  /v1/routes?…                    → which routes are available for this payer
POST /v1/quotes                      → price a route
POST /v1/intents/prepare             → returns { draftId, intent } to sign
         ↓  user signs with their passkey-derived key
POST /v1/intents/submit              → { draftId, payerSig, receiveAuthSig? }
GET  /v1/stream/intent/:chainId/:id  → SSE, live lifecycle updates
GET  /v1/verify/:chainId/:intentId   → the three proofs, recomputed
```

**What the user signs** — use the helpers in `@scanpay/shared`, do not hand-roll
EIP-712:

| Route | Signatures needed |
|---|---|
| DIRECT | `payerSig` (intent) + `receiveAuthSig` (EIP-3009) |
| SWAP | `payerSig` only — plus a one-time ERC-20 `approve` of the vault |
| CROSSCHAIN | `payerSig` only — then the user sends funds on the origin chain |

```ts
import { buildIntentTypedData, buildReceiveAuthTypedData,
         receiveAuthForIntent, intentDigest, getDeployment } from '@scanpay/shared';
```

The intent returned by `/prepare` has string numbers — convert `amountOut`,
`maxAmountIn`, `expiresAt` and `nonce` to `BigInt` before signing, or the signature
won't match. See `backend/services/api/scripts/e2e-routes.ts` for a working example of
every route.

### Merchant side

```
POST /v1/merchants/register          → registration + ownerSig + payoutSig + profile
POST /v1/invoices                    → invoice + merchantSig (signed by the invoice key)
GET  /v1/merchants/:chainId/:id/payments
GET  /v1/stream/merchant/:chainId/:id → SSE
```

`metadataHash` in the registration **must** equal `profileHash(profile)` from
`@scanpay/shared`, or you get `PROFILE_HASH_MISMATCH`. Off mainnet, merchants are
auto-approved; don't call the admin approve route or it reverts
`InvalidStatusTransition(2,2)`.

### History / analytics

Envio GraphQL, public, no auth:

```
https://indexer.dev.hyperindex.xyz/247ade4/v1/graphql
```

```graphql
{ ProtocolStat { id settled volume fees }
  Merchant { merchantId statusName paymentCount netReceived } }
```

Entities: `Merchant`, `MerchantKeyEvent`, `Intent`, `MerchantDailyStat`,
`ProtocolStat`, `ConfigEvent`. Ids are `"<chainId>_<hex>"`.

---

## 5. Deployed addresses

| | Testnet 10143 | Mainnet 143 |
|---|---|---|
| MerchantRegistry | `0x2725111582b68539df62d57f579eafcebfb870b0` | same |
| IntentVault | `0xa952e8ac92bce001b5ef4ddb1a4027a7b9d2868e` | same |
| SwapAdapter | `0x36e1c5c4…` (mock) | `0xa5e36c82…` (**Kuru**) |
| USDC | `0xa5e36c82…` tUSDC | `0x754704bc…` real |
| AUSD | `0x7cdf8e23…` tAUSD | `0x00000000efe3…` real |
| Explorer | testnet.monadscan.com | monadscan.com |

Addresses match across chains because the deployer's nonce order is identical on both.
That's expected, not a bug. Machine-readable: `backend/deployments/*.json` — read them
through `getDeployment(chainId)` rather than hardcoding.

---

## 6. Things that will bite you

**Passkeys are bound to a domain.** A passkey created on `localhost` will not work on a
Vercel URL, and **Vercel preview URLs never work** — decide the production domain before
anyone creates a real passkey. PRF needs iOS 18+ / Android Chrome / Safari 18+ /
Chrome 132+, so demo on a phone, not a laptop.

**Cross-chain is not instant.** DIRECT and SWAP settle in about a second. Cross-chain
took ~25 minutes on mainnet, nearly all of it the external solver bridging. Start it
first in a demo and show the instant routes while it travels. 1Click also rejects
anything under ~0.15 USDC (`Amount is too low for bridge`).

**The relayer needs gas.** If payments start failing with a confusing
`Missing or invalid parameters`, check the relayer's balance first — that's what an
out-of-gas relayer looks like through viem. `/health` shows `operatorBalance` per chain.

**Mainnet is capped at 1 USDC per payment** on-chain (`amountCap`). Deliberate.

**`pnpm --filter @scanpay/api start` does not load `.env`** — that script is for Railway,
where the platform injects env. Locally use `pnpm api:dev`.

---

## 7. Who to ask

Austin owns contracts, deployments, indexer and the API. Anything that reverts on-chain,
or any question about what a signature must contain, starts there.
