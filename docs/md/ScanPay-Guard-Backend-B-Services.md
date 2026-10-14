# ScanPay Guard — Backend B: Services (API · Relayer · Quotes · Settlement Watcher · Attack Lab)

> **Scan. Verify. Pay. Know it arrived.**
> Monad Metropolis · Track 02 Consumer Products & Payments · build doc for the **Backend B** engineer.
> Companion docs: **Backend A — Chain** (contracts, shared SDK, deployments, Envio) and **Frontend** (written next).

| | |
|---|---|
| Owner | Backend B (`services/api/` + B-owned files in `packages/shared/src/`) |
| You receive from A | **I0** (ABIs + SDK), **I1** (local chain), **I2** (testnet), **I3** (Envio URL), **I4** (mainnet) |
| You hand off to FE | **I5** — API deployed, `GET /v1/config` live (target Mon 12:00 IST; local API available from Sat night) |
| Deadline | **Tue 13 Oct 2026, 23:59 ET = Wed 14 Oct 09:29 IST** |
| Your freeze | **Tue 13 Oct 18:00 IST** — after that only bug fixes |
| Stack | Node 22, pnpm 9, Fastify 5, Mongoose 8 (MongoDB Atlas), viem ≥ 2.40, zod 3, pino; Railway |

---

## Table of contents

- [Part I — Context you must read once](#part-i--context-you-must-read-once)
- [Part II — Interface Control Document (shared with Backend A)](#0-interface-control-document-icd--identical-in-backend-a-and-backend-b)
- [Part III — Build phases B0 → B31](#part-iii--build-phases)
- [Part IV — API reference (§B-API)](#part-iv--api-reference-b-api)
- [Part V — Troubleshooting](#part-v--troubleshooting)
- [Part VI — Final checklist](#part-vi--final-checklist)

---

## Part I — Context you must read once

### I.1 What Backend B is

Backend A makes the guarantees (contracts). **You make them usable**: the customer and the merchant only ever sign
with a Mera passkey — they never hold gas, never see a transaction, never paste an address. Everything between
"signature on the phone" and "event on Monad" is yours:

```
             ┌──────────────────────────── services/api (one Node process) ─────────────────────────────┐
 FE (PWA) ──►│ HTTP API (Fastify)                                                                         │
             │  ├─ /v1/config, /v1/fx                                       read-only                     │
             │  ├─ merchants: register / rotate / payout / admin approve    relays registry txs           │
             │  ├─ invoices + invoice-requests + qr/resolve                 stores merchant-signed invoices│
             │  ├─ routes + quotes (mock | Kuru Flow | Aurora Swap API)     computes quoteHash             │
             │  ├─ intents prepare → submit                                relays vault txs (gasless)     │
             │  ├─ verify, receipts, SSE streams                            reads chain + Envio           │
             │  ├─ faucet, gas drip (testnet)                               operator MINTER / MON          │
             │  └─ Attack Lab                                               runs real attacks, shows reverts│
             │ Worker (same process)                                                                      │
             │  ├─ event follower: vault + registry logs → Mongo → SSE      ONLY source of "SETTLED"      │
             │  └─ cross-chain watcher: forwarder balance → settle / refund / attest; provider status     │
             └──────┬───────────────────────────────┬──────────────────────────────┬────────────────────┘
                    │ viem (operator key)            │ HTTPS                         │ GraphQL
                    ▼                                ▼                               ▼
              Monad 31337 / 10143 / 143     Aurora Swap API · Kuru Flow · FX    Envio HyperIndex
```

### I.2 Non-negotiable rules for this layer

| # | Rule | Why |
|---|---|---|
| R1 | **Only an on-chain `PaymentSettled` log sets `SETTLED`.** Provider status, webhooks, client calls never can | This is "proof of settlement" — judges and the Attack Lab test it |
| R2 | The API never holds user keys. It holds exactly one hot key per chain: the **operator** | Mera = entire account layer (bounty rule) |
| R3 | Every relayed tx: `simulate` → `estimateGas × 1.2` → send. Never a default gas limit | Monad charges the **gas limit** |
| R4 | Every contract revert is decoded and mapped to an API error code (ICD §0.8) | FE shows "Terms changed after you signed", not "execution reverted" |
| R5 | Server-side pre-checks mirror the contract checks **but the contract is the authority** | Pre-checks give fast, friendly errors; the chain gives guarantees |
| R6 | All JSON numbers follow the ICD wire rule (uint256/uint64 → decimal string) | One converter (`@scanpay/shared` wire.ts) for every app |
| R7 | Cross-chain deposits go **only** to the per-intent forwarder (`vault.forwarderOf(intentId)`) | Anything else is unrecoverable |
| R8 | Attack Lab, faucet, simulated deposits: **never** on chain 143 (code-enforced, not only env) | Mainnet safety |

### I.3 Routes from B's point of view

| Route | Prepare (B) | Customer signs (FE) | Submit (B) | Settled by |
|---|---|---|---|---|
| `DIRECT` 0 | intent with `inputToken = payoutToken`, `maxAmountIn = amountOut`, `quoteHash = 0x0` | `PaymentIntent` + `ReceiveWithAuthorization` (nonce = intent digest) | `vault.payDirect(...)` | same tx |
| `SWAP` 1 | quote (mock `quoteIn` / Kuru Flow) → `maxAmountIn` with buffer, `quoteHash`; allowance check | `PaymentIntent` (+ one-time `approve(vault)` tx — B drips MON for it) | fresh swapData → `vault.paySwap(...)` | same tx |
| `CROSSCHAIN` 2 | nonce → intentId → forwarder → Aurora `EXACT_OUTPUT` quote with `recipient = forwarder` → `quoteHash` | `PaymentIntent` | `vault.commitCrossChain(...)` → customer sends source-chain deposit | worker: forwarder balance → `settleCrossChain` |

Testnet has no Aurora: CROSSCHAIN on 10143/31337 uses provider **`simulated`** — the "deposit" is a tUSDC mint to the
forwarder triggered by a clearly-labelled "Simulate solver delivery" button. Same contract path, same watcher.

### I.4 Off-chain lifecycle (ICD §0.4) — what moves it

| From → To | Trigger |
|---|---|
| (none) → `DRAFT` | `POST /v1/intents/prepare` |
| `DRAFT` → `SUBMITTED` | DIRECT/SWAP tx sent |
| `SUBMITTED` → `SETTLED` | `PaymentSettled` log (receipt or follower) |
| `DRAFT` → `COMMITTED` → `AWAITING_DEPOSIT` | `commitCrossChain` mined (`IntentCommitted` log) |
| `AWAITING_DEPOSIT` → `PROCESSING` | provider says `KNOWN_DEPOSIT_TX` / `PROCESSING`, or user posted source tx |
| any open cross-chain → `UNDERPAID` | forwarder balance `0 < bal < required` |
| `PROCESSING` → `RECONCILIATION_REQUIRED` | provider `SUCCESS` but forwarder short for > 90 s, or provider's destination tx has no matching transfer to the forwarder |
| open cross-chain → `SETTLED` | worker's `settleCrossChain` → `PaymentSettled` log |
| open cross-chain → `EXPIRED` | `now > intent.expiresAt` (still settleable until refund) |
| `EXPIRED`/`UNDERPAID`/`RECONCILIATION_REQUIRED` → `REFUNDED` | `now ≥ expiresAt + refundDelay` → worker calls `refundCrossChain` → `IntentRefunded` log |
| `DRAFT`/`SUBMITTED` → `FAILED` | relay reverted / simulate failed (nothing moved) |

### I.5 Sponsor bounties your layer must satisfy

| Bounty | What B contributes |
|---|---|
| Track 02 "a payments app that never mentions a blockchain to the person using it" | gasless relayer, human error messages, fiat display (FX), receipts |
| Mera — Best UX / One Passkey, Many Keys | no custody backend: B stores no user keys; registration requires owner **and** payout signatures; rotation endpoint |
| Aurora Intents — Any-Chain Liquidity | Swap API integration (quote/deposit-submit/status), forwarder recipient, watcher, refunds |
| Agora — Cross-Border Payments | AUSD payouts, USD→INR (and other) fiat display, cross-chain payer → AUSD merchant |
| Envio | merchant history/stats/verify served from HyperIndex GraphQL (Mongo only as fallback) |

### I.6 Schedule (IST)

| Block | Phases | Ends with |
|---|---|---|
| Sat 16:30 → 21:00 | B0 – B4 (setup, skeleton, B-owned shared files, chains, models) | builds against I0 ABIs |
| Sat 21:00 → 02:00 | B5 – B12 (errors, app, bus/views/FX, merchants, admin, rotation, merchant reads + Envio, invoices + QR) | local API on anvil (after I1) |
| Sun 09:00 → 15:00 | B13 – B19 (quotes + Kuru, Aurora, prepare, submit DIRECT/SWAP/CROSSCHAIN, faucet/drip, source-tx) | full payment flow on local |
| Sun 15:00 → 22:00 | B20 – B26 (follower, cross-chain watcher, SSE, verify, Attack Lab ×2, webhook) | testnet (after I2/I3) |
| Mon 09:00 → 14:00 | B27 – B30 (verify-receipt CLI, unit tests, e2e tests, Railway) | **I5** |
| Mon 14:00 → Tue 18:00 | B31 mainnet runbook (after I4), integration with FE, video support | freeze |

---
## 0. INTERFACE CONTROL DOCUMENT (ICD) — identical in Backend A and Backend B

> **This section is copied word-for-word into both backend docs.** It is the single wiring contract between
> Backend A (chain), Backend B (services) and the Frontend. If code disagrees with this section, the code is
> wrong. Any change to this section requires: (1) edit in both docs, (2) bump `ICD_VERSION` in
> `packages/shared/src/constants.ts`, (3) a message in the team chat "ICD vX → vY: <what changed>".

**ICD_VERSION = 1**

### 0.1 Who owns what

| Path | Owner | Others may | Notes |
|---|---|---|---|
| `contracts/` | **A** | read | Foundry project. Solidity 0.8.28, OpenZeppelin v5.1.0 |
| `indexer/` | **A** | read | Envio HyperIndex v3 |
| `deployments/*.json` | **A** (generated) | read | Never hand-edit. Generated by `pnpm deployments:build` |
| `packages/shared/src/generated/*` | **A** (generated) | read | ABIs + deployments as TS. Never hand-edit |
| `packages/shared/src/eip712.ts` `types.ts` `constants.ts` `ids.ts` `wire.ts` | **A** | read | Typed-data + ids + enums + bigint wire helpers |
| `packages/shared/src/api.ts` `canonical.ts` `quote-hash.ts` `errors.ts` | **B** | read | API request/response types, canonical JSON, quote hash, error codes |
| `packages/shared/test-vectors/eip712.json` | **A** (generated by forge) | read | Golden vectors; B and FE tests consume |
| `services/api/` | **B** | read | Fastify + MongoDB + viem. API **and** worker in one process |
| `apps/web/` | **FE** | read | Next.js PWA (separate doc) |
| root `package.json`, `pnpm-workspace.yaml`, `.gitignore`, `LICENSE`, `README.md` | **A** creates in Phase A1 | PR to edit | |

Rule: **you never edit a file you don't own.** You open an issue / ping the owner.

### 0.2 Repository layout (final)

```
scanpay-guard/
├── LICENSE                         # MIT
├── README.md
├── package.json                    # pnpm workspaces root
├── pnpm-workspace.yaml
├── .gitignore
├── .env.example                    # documents every env var (see §0.11)
├── deployments/
│   ├── raw/                        # forge script output (A)
│   ├── 31337.json                  # local anvil (A, generated)
│   ├── 10143.json                  # Monad testnet (A, generated)
│   └── 143.json                    # Monad mainnet (A, generated)
├── contracts/                      # A
│   ├── foundry.toml
│   ├── config/                     # per-chain token + external config (A)
│   ├── src/
│   │   ├── libraries/ScanPayTypes.sol
│   │   ├── interfaces/{IMerchantRegistry,IIntentVault,ISwapAdapter,IERC3009,IMockStableToken,IMockSwapAdapter}.sol
│   │   ├── MerchantRegistry.sol
│   │   ├── IntentVault.sol
│   │   ├── DepositForwarder.sol
│   │   ├── adapters/{KuruFlowAdapter,MockSwapAdapter}.sol
│   │   └── mocks/{MockStableToken,MockERC20}.sol
│   ├── script/{Deploy.s.sol,VerifyAddresses.sh}
│   ├── scripts/{export-abis.ts,build-deployments.ts}
│   └── test/…
├── indexer/                        # A (Envio)
├── packages/
│   └── shared/                     # @scanpay/shared — TS source consumed directly (no build step)
│       ├── package.json
│       ├── src/
│       │   ├── index.ts
│       │   ├── constants.ts  types.ts  eip712.ts  ids.ts  wire.ts          (A)
│       │   ├── api.ts  canonical.ts  quote-hash.ts  errors.ts              (B)
│       │   └── generated/{abis.ts,deployments.ts}                         (A, generated)
│       └── test-vectors/eip712.json                                       (A, generated)
├── services/
│   └── api/                        # B
└── apps/
    └── web/                        # FE
```

### 0.3 Chains

| Key | chainId | RPC (default) | Explorer | viem chain export | Purpose |
|---|---|---|---|---|---|
| `local` | 31337 | `http://127.0.0.1:8545` | — | `foundry` | anvil, B develops before testnet deploy |
| `testnet` | 10143 | `https://testnet-rpc.monad.xyz` | `https://testnet.monadscan.com` | `monadTestnet` | Main demo + judges try it + Attack Lab |
| `mainnet` | 143 | `https://rpc.monad.xyz` | `https://monadscan.com` | `monad` | Real Aurora cross-chain payment + real Kuru swap |

Monad facts that change code (from docs.monad.xyz, verified 2026-10-10):
- **Gas is charged on the gas LIMIT, not gas used.** Every relayed tx sets `gas = estimate × 1.2` (never a blind default).
- Block ≈ 300–400 ms, finality ≈ 2 blocks. `TIMESTAMP` has 1-second granularity.
- Max contract size 128 KB. Tx types 0/1/2/4 supported, not 3.
- Foundry ≥ 1.8.0 with `network = "monad"`. viem ≥ 2.40.0 (has `monad`, `monadTestnet`).

### 0.4 Enums (numbers on-chain, strings in the API)

```
Route            0 DIRECT        1 SWAP          2 CROSSCHAIN
IntentStatus     0 NONE          1 COMMITTED     2 SETTLED       3 REFUNDED
InvoiceState     0 OPEN          1 RESERVED      2 PAID
MerchantStatus   0 NONE          1 PENDING       2 ACTIVE        3 SUSPENDED      4 REVOKED
```

Off-chain (API) intent lifecycle — owned by B, superset of on-chain status:

```
DRAFT → SUBMITTED → SETTLED                                   (DIRECT, SWAP: one tx)
DRAFT → COMMITTED → AWAITING_DEPOSIT → PROCESSING → SETTLED   (CROSSCHAIN)
                                     ↘ UNDERPAID
                                     ↘ RECONCILIATION_REQUIRED (provider says SUCCESS, chain disagrees)
                                     ↘ EXPIRED → REFUNDED
any → FAILED (relay reverted; nothing moved)
```
**Only an on-chain `PaymentSettled` event can produce `SETTLED`.** No provider status, webhook, or client call can.

### 0.5 EIP-712

Domains:

| Name | `name` | `version` | `chainId` | `verifyingContract` |
|---|---|---|---|---|
| Vault domain (Invoice, PaymentIntent) | `ScanPayGuard` | `1` | chain | `IntentVault` address |
| Registry domain (Registration, SignerRotation, PayoutUpdate) | `ScanPayRegistry` | `1` | chain | `MerchantRegistry` address |
| Token domain (ReceiveWithAuthorization) | from `deployments.tokens[X].eip712.name` | from `…eip712.version` | chain | token address |

Type strings (exact — these bytes are hashed; never reorder):

```
Invoice(bytes32 merchantId,bytes32 invoiceId,address payoutToken,uint256 amount,uint64 expiresAt,uint32 keyVersion)

PaymentIntent(bytes32 merchantId,bytes32 invoiceId,address payer,address payoutToken,uint256 amountOut,uint8 route,address inputToken,uint256 maxAmountIn,bytes32 quoteHash,address refundTo,uint64 expiresAt,uint256 nonce,uint32 keyVersion)

Registration(address owner,bytes32 salt,address payoutWallet,address invoiceSigner,address payoutToken,bytes32 metadataHash,uint256 nonce,uint64 deadline)

SignerRotation(bytes32 merchantId,address newSigner,uint256 nonce,uint64 deadline)

PayoutUpdate(bytes32 merchantId,address payoutWallet,address payoutToken,uint256 nonce,uint64 deadline)

ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)
```

Who signs what:

| Message | Signer | When |
|---|---|---|
| `Registration` | merchant **owner** key **and** merchant **payout** key (same digest, 2 sigs) | onboarding |
| `SignerRotation` | merchant owner key | rotate invoice key |
| `PayoutUpdate` | owner key **and** the new payout key | change payout |
| `Invoice` | merchant **invoice signer** key | every invoice |
| `PaymentIntent` | customer (payer) key | every payment |
| `ReceiveWithAuthorization` | customer key; `to = IntentVault`, `value = amountOut`, `validAfter = 0`, `validBefore = intent.expiresAt`, **`nonce = intent EIP-712 digest`** | DIRECT route only |

All keys are Mera passkey-derived EOAs (FE doc). Backends never hold user keys.

### 0.6 Identifier derivations

```
merchantId = keccak256(abi.encode(address owner, bytes32 salt))
intentId   = keccak256(abi.encode(bytes32 merchantId, bytes32 invoiceId, address payer, uint256 nonce))
invoiceId  = random 32 bytes chosen by the merchant app
nonce      = random uint256 chosen by the payer app (unordered; usedNonce[payer][nonce])
forwarder  = IntentVault.forwarderOf(intentId)   // CREATE2 clone, salt = intentId, deployer = IntentVault
quoteHash  = DIRECT: 0x00…00 | SWAP & CROSSCHAIN: quoteHash(canonicalJson(quoteFields))  (§0.10)
metadataHash = keccak256(utf8(canonicalJson(profile)))   // profile = {displayName,category,city,country,logoUrl}
```

### 0.7 Solidity surface (authoritative copy lives in `contracts/src/...`, reproduced here)

#### 0.7.1 `contracts/src/libraries/ScanPayTypes.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

uint8 constant ROUTE_DIRECT = 0;
uint8 constant ROUTE_SWAP = 1;
uint8 constant ROUTE_CROSSCHAIN = 2;

uint8 constant INTENT_NONE = 0;
uint8 constant INTENT_COMMITTED = 1;
uint8 constant INTENT_SETTLED = 2;
uint8 constant INTENT_REFUNDED = 3;

uint8 constant INVOICE_OPEN = 0;
uint8 constant INVOICE_RESERVED = 1;
uint8 constant INVOICE_PAID = 2;

uint8 constant MERCHANT_NONE = 0;
uint8 constant MERCHANT_PENDING = 1;
uint8 constant MERCHANT_ACTIVE = 2;
uint8 constant MERCHANT_SUSPENDED = 3;
uint8 constant MERCHANT_REVOKED = 4;

struct Invoice {
    bytes32 merchantId;
    bytes32 invoiceId;
    address payoutToken;
    uint256 amount;
    uint64 expiresAt;
    uint32 keyVersion;
}

struct PaymentIntent {
    bytes32 merchantId;
    bytes32 invoiceId;
    address payer;
    address payoutToken;
    uint256 amountOut;
    uint8 route;
    address inputToken;
    uint256 maxAmountIn;
    bytes32 quoteHash;
    address refundTo;
    uint64 expiresAt;
    uint256 nonce;
    uint32 keyVersion;
}

struct Auth3009 {
    uint8 v;
    bytes32 r;
    bytes32 s;
}

struct Merchant {
    address owner;
    address payoutWallet;
    address invoiceSigner;
    address payoutToken;
    uint32 keyVersion;
    uint8 status;
    uint64 registeredAt;
    bytes32 metadataHash;
}

struct Registration {
    address owner;
    bytes32 salt;
    address payoutWallet;
    address invoiceSigner;
    address payoutToken;
    bytes32 metadataHash;
    uint256 nonce;
    uint64 deadline;
}

struct SignerRotation {
    bytes32 merchantId;
    address newSigner;
    uint256 nonce;
    uint64 deadline;
}

struct PayoutUpdate {
    bytes32 merchantId;
    address payoutWallet;
    address payoutToken;
    uint256 nonce;
    uint64 deadline;
}

struct IntentRecord {
    address payer;
    uint8 route;
    uint8 status;
    uint64 expiresAt;
    uint64 committedAt;
    uint64 settledAt;
    bytes32 merchantId;
    bytes32 invoiceId;
    address payoutToken;
    address inputToken;
    address payoutWallet;
    address refundTo;
    uint256 amountOut;
    uint256 inputAmount;
    uint256 fee;
    bytes32 quoteHash;
    uint256 sourceChainId;
    bytes32 sourceTxHash;
}

library ScanPayTypes {
    bytes32 internal constant INVOICE_TYPEHASH = keccak256(
        "Invoice(bytes32 merchantId,bytes32 invoiceId,address payoutToken,uint256 amount,uint64 expiresAt,uint32 keyVersion)"
    );
    bytes32 internal constant PAYMENT_INTENT_TYPEHASH = keccak256(
        "PaymentIntent(bytes32 merchantId,bytes32 invoiceId,address payer,address payoutToken,uint256 amountOut,uint8 route,address inputToken,uint256 maxAmountIn,bytes32 quoteHash,address refundTo,uint64 expiresAt,uint256 nonce,uint32 keyVersion)"
    );
    bytes32 internal constant REGISTRATION_TYPEHASH = keccak256(
        "Registration(address owner,bytes32 salt,address payoutWallet,address invoiceSigner,address payoutToken,bytes32 metadataHash,uint256 nonce,uint64 deadline)"
    );
    bytes32 internal constant SIGNER_ROTATION_TYPEHASH =
        keccak256("SignerRotation(bytes32 merchantId,address newSigner,uint256 nonce,uint64 deadline)");
    bytes32 internal constant PAYOUT_UPDATE_TYPEHASH =
        keccak256("PayoutUpdate(bytes32 merchantId,address payoutWallet,address payoutToken,uint256 nonce,uint64 deadline)");

    function hashInvoice(Invoice memory i) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(INVOICE_TYPEHASH, i.merchantId, i.invoiceId, i.payoutToken, i.amount, i.expiresAt, i.keyVersion)
        );
    }

    function hashIntent(PaymentIntent memory p) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                PAYMENT_INTENT_TYPEHASH,
                p.merchantId,
                p.invoiceId,
                p.payer,
                p.payoutToken,
                p.amountOut,
                p.route,
                p.inputToken,
                p.maxAmountIn,
                p.quoteHash,
                p.refundTo,
                p.expiresAt,
                p.nonce,
                p.keyVersion
            )
        );
    }

    function hashRegistration(Registration memory r) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                REGISTRATION_TYPEHASH,
                r.owner,
                r.salt,
                r.payoutWallet,
                r.invoiceSigner,
                r.payoutToken,
                r.metadataHash,
                r.nonce,
                r.deadline
            )
        );
    }

    function hashSignerRotation(SignerRotation memory r) internal pure returns (bytes32) {
        return keccak256(abi.encode(SIGNER_ROTATION_TYPEHASH, r.merchantId, r.newSigner, r.nonce, r.deadline));
    }

    function hashPayoutUpdate(PayoutUpdate memory u) internal pure returns (bytes32) {
        return keccak256(abi.encode(PAYOUT_UPDATE_TYPEHASH, u.merchantId, u.payoutWallet, u.payoutToken, u.nonce, u.deadline));
    }

    function computeIntentId(PaymentIntent memory p) internal pure returns (bytes32) {
        return keccak256(abi.encode(p.merchantId, p.invoiceId, p.payer, p.nonce));
    }

    function computeMerchantId(address owner, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encode(owner, salt));
    }
}
```

#### 0.7.2 `contracts/src/interfaces/IMerchantRegistry.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Merchant, Registration, SignerRotation, PayoutUpdate} from "../libraries/ScanPayTypes.sol";

interface IMerchantRegistry {
    event MerchantRegistered(
        bytes32 indexed merchantId,
        address indexed owner,
        bytes32 salt,
        address payoutWallet,
        address invoiceSigner,
        address payoutToken,
        bytes32 metadataHash
    );
    event MerchantStatusChanged(bytes32 indexed merchantId, uint8 previousStatus, uint8 newStatus, address indexed by);
    event InvoiceSignerRotated(bytes32 indexed merchantId, address invoiceSigner, uint32 keyVersion);
    event PayoutUpdated(bytes32 indexed merchantId, address payoutWallet, address payoutToken, uint32 keyVersion);
    event PayoutTokenAllowed(address indexed token, bool allowed);

    error MerchantAlreadyExists(bytes32 merchantId);
    error MerchantNotFound(bytes32 merchantId);
    error MerchantIsRevoked(bytes32 merchantId);
    error InvalidOwnerSignature();
    error InvalidPayoutSignature();
    error SignatureExpired();
    error BadNonce(uint256 expected, uint256 provided);
    error PayoutTokenNotAllowed(address token);
    error ZeroAddress();
    error InvalidStatusTransition(uint8 fromStatus, uint8 toStatus);

    function registerMerchant(Registration calldata r, bytes calldata ownerSig, bytes calldata payoutSig)
        external
        returns (bytes32 merchantId);
    function rotateInvoiceSigner(SignerRotation calldata r, bytes calldata ownerSig) external;
    function updatePayout(PayoutUpdate calldata u, bytes calldata ownerSig, bytes calldata payoutSig) external;
    function setMerchantStatus(bytes32 merchantId, uint8 newStatus) external;
    function setPayoutTokenAllowed(address token, bool allowed) external;

    function getMerchant(bytes32 merchantId) external view returns (Merchant memory);
    function isPayoutTokenAllowed(address token) external view returns (bool);
    function ownerNonce(address owner) external view returns (uint256);
    function computeMerchantId(address owner, bytes32 salt) external pure returns (bytes32);
    function hashRegistration(Registration calldata r) external view returns (bytes32 digest);
    function hashSignerRotation(SignerRotation calldata r) external view returns (bytes32 digest);
    function hashPayoutUpdate(PayoutUpdate calldata u) external view returns (bytes32 digest);
}
```

#### 0.7.3 `contracts/src/interfaces/IIntentVault.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Invoice, PaymentIntent, Auth3009, IntentRecord} from "../libraries/ScanPayTypes.sol";
import {IMerchantRegistry} from "./IMerchantRegistry.sol";

interface IIntentVault {
    event IntentCommitted(
        bytes32 indexed intentId,
        bytes32 indexed merchantId,
        address indexed payer,
        bytes32 invoiceId,
        uint8 route,
        address inputToken,
        address payoutToken,
        uint256 amountOut,
        address forwarder,
        address payoutWallet,
        uint64 expiresAt,
        bytes32 quoteHash
    );
    event PaymentSettled(
        bytes32 indexed intentId,
        bytes32 indexed merchantId,
        address indexed payer,
        bytes32 invoiceId,
        uint8 route,
        address payoutToken,
        uint256 amountOut,
        uint256 fee,
        address payoutWallet,
        address inputToken,
        uint256 inputAmount,
        uint256 excessRefunded
    );
    event IntentRefunded(bytes32 indexed intentId, address indexed refundTo, address token, uint256 amount);
    event ForwarderRescued(bytes32 indexed intentId, address indexed to, address token, uint256 amount);
    event SourceAttested(
        bytes32 indexed intentId, uint256 sourceChainId, bytes32 sourceTxHash, bytes32 providerRef, address indexed attester
    );
    event FeeUpdated(uint16 feeBps, address feeRecipient);
    event SwapAdapterUpdated(address adapter);
    event RefundDelayUpdated(uint64 refundDelay);
    event AmountCapUpdated(address indexed token, uint256 cap);
    event InputTokenAllowed(address indexed token, uint8 route, bool allowed);
    event CrossChainInputTokenUpdated(address token);

    error MerchantNotActive(bytes32 merchantId, uint8 status);
    error KeyVersionMismatch(uint32 expected, uint32 provided);
    error InvoiceMismatch();
    error PayoutTokenMismatch();
    error PayoutTokenNotAllowed(address token);
    error AmountMismatch();
    error InvoiceExpired();
    error IntentExpired();
    error InvalidMerchantSignature();
    error InvalidPayerSignature();
    error NonceAlreadyUsed(address payer, uint256 nonce);
    error InvoiceNotOpen(uint8 state);
    error RouteMismatch(uint8 expected, uint8 provided);
    error InputTokenNotAllowed(address token, uint8 route);
    error AmountAboveCap(uint256 amount, uint256 cap);
    error Underpaid(uint256 received, uint256 required);
    error SwapOutputTooLow(uint256 out, uint256 required);
    error IntentNotCommitted(bytes32 intentId);
    error IntentAlreadyExists(bytes32 intentId);
    error RefundNotYetAllowed(uint256 allowedAt);
    error IntentNotTerminal(bytes32 intentId);
    error AlreadyAttested(bytes32 intentId);
    error NoSwapAdapter();
    error InvalidFee(uint16 feeBps);
    error ZeroAddress();

    // ---- payments ----
    function payDirect(
        PaymentIntent calldata intent,
        Invoice calldata invoice,
        bytes calldata merchantSig,
        bytes calldata payerSig,
        Auth3009 calldata auth
    ) external returns (bytes32 intentId);

    function paySwap(
        PaymentIntent calldata intent,
        Invoice calldata invoice,
        bytes calldata merchantSig,
        bytes calldata payerSig,
        bytes calldata swapData
    ) external returns (bytes32 intentId);

    function commitCrossChain(
        PaymentIntent calldata intent,
        Invoice calldata invoice,
        bytes calldata merchantSig,
        bytes calldata payerSig
    ) external returns (bytes32 intentId, address forwarder);

    function settleCrossChain(bytes32 intentId, bytes calldata swapData) external;
    function refundCrossChain(bytes32 intentId) external;
    function rescue(bytes32 intentId, address token) external;
    function attestSource(bytes32 intentId, uint256 sourceChainId, bytes32 sourceTxHash, bytes32 providerRef) external;

    // ---- config (CONFIG_ROLE / PAUSER_ROLE) ----
    function setFee(uint16 feeBps_, address feeRecipient_) external;
    function setSwapAdapter(address adapter) external;
    function setRefundDelay(uint64 refundDelay_) external;
    function setAmountCap(address token, uint256 cap) external;
    function setInputTokenAllowed(address token, uint8 route, bool allowed) external;
    function setCrossChainInputToken(address token) external;
    function pause() external;
    function unpause() external;

    // ---- views ----
    function registry() external view returns (IMerchantRegistry);
    function forwarderImplementation() external view returns (address);
    function feeBps() external view returns (uint16);
    function feeRecipient() external view returns (address);
    function swapAdapter() external view returns (address);
    function refundDelay() external view returns (uint64);
    function crossChainInputToken() external view returns (address);
    function amountCap(address token) external view returns (uint256);
    function isInputTokenAllowed(address token, uint8 route) external view returns (bool);
    function usedNonce(address payer, uint256 nonce) external view returns (bool);
    function invoiceState(bytes32 merchantId, bytes32 invoiceId) external view returns (uint8);
    function getIntent(bytes32 intentId) external view returns (IntentRecord memory);
    function forwarderOf(bytes32 intentId) external view returns (address);
    function hashInvoice(Invoice calldata invoice) external view returns (bytes32 digest);
    function hashIntent(PaymentIntent calldata intent) external view returns (bytes32 digest);
    function computeIntentId(PaymentIntent calldata intent) external pure returns (bytes32);
}
```

#### 0.7.4 `contracts/src/interfaces/ISwapAdapter.sol`, `IERC3009.sol`, `IMockStableToken.sol`, `IMockSwapAdapter.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Vault transfers `amountIn` of tokenIn to the adapter BEFORE calling swap().
/// Adapter must send >= minOut tokenOut to `recipient` and any unused tokenIn to `leftoverTo`.
interface ISwapAdapter {
    error OnlyVault();
    error TargetNotAllowed(address target);
    error SwapCallFailed(bytes reason);
    error NoRate(address tokenIn, address tokenOut);
    error InsufficientOutput(uint256 out, uint256 minOut);

    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        bytes calldata data,
        address recipient,
        address leftoverTo
    ) external returns (uint256 out);

    function vault() external view returns (address);
}
```

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}
```

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC3009} from "./IERC3009.sol";

/// Testnet/local only. Mintable by MINTER_ROLE (the operator = faucet).
interface IMockStableToken is IERC3009 {
    function mint(address to, uint256 amount) external;
    function decimals() external view returns (uint8);
    function balanceOf(address) external view returns (uint256);
}
```

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Testnet/local only fixed-rate swap. rateE18 = tokenOut base units per 1 tokenIn base unit, scaled 1e18.
interface IMockSwapAdapter {
    function rateE18(address tokenIn, address tokenOut) external view returns (uint256);
    function quoteOut(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256);
    function quoteIn(address tokenIn, address tokenOut, uint256 amountOut) external view returns (uint256);
    function setRate(address tokenIn, address tokenOut, uint256 rate) external;
}
```

`swapData` encoding (passed to `paySwap` / `settleCrossChain`):

| Adapter | `swapData` |
|---|---|
| `MockSwapAdapter` (local, testnet) | `0x` (empty) |
| `KuruFlowAdapter` (mainnet) | `abi.encode(address target, bytes callData)` where `target = quote.transaction.to`, `callData = "0x" + quote.transaction.calldata` from Kuru Flow `/api/quote` with `userAddress = KuruFlowAdapter address` |

### 0.8 Error → API code map (B implements in `packages/shared/src/errors.ts`)

| Solidity error | API `code` | HTTP | User-facing meaning |
|---|---|---|---|
| `MerchantNotActive` | `MERCHANT_NOT_ACTIVE` | 409 | Merchant is not verified/active |
| `KeyVersionMismatch` | `MERCHANT_KEYS_CHANGED` | 409 | Merchant changed keys/payout — invoice must be re-issued |
| `InvoiceMismatch` | `TAMPERED_INVOICE_REF` | 422 | Intent doesn't match invoice |
| `PayoutTokenMismatch` | `TAMPERED_PAYOUT_TOKEN` | 422 | Token changed |
| `PayoutTokenNotAllowed` | `PAYOUT_TOKEN_NOT_ALLOWED` | 422 | |
| `AmountMismatch` | `TAMPERED_AMOUNT` | 422 | Amount changed |
| `InvoiceExpired` | `INVOICE_EXPIRED` | 410 | |
| `IntentExpired` | `QUOTE_EXPIRED` | 410 | |
| `InvalidMerchantSignature` | `INVALID_MERCHANT_SIGNATURE` | 422 | Invoice not signed by this merchant |
| `InvalidPayerSignature` | `INVALID_PAYER_SIGNATURE` | 422 | Terms changed after you signed |
| `NonceAlreadyUsed` | `REPLAY_BLOCKED` | 409 | |
| `InvoiceNotOpen` | `INVOICE_ALREADY_PAID` | 409 | |
| `RouteMismatch` | `ROUTE_MISMATCH` | 422 | |
| `InputTokenNotAllowed` | `INPUT_TOKEN_NOT_ALLOWED` | 422 | |
| `AmountAboveCap` | `AMOUNT_ABOVE_CAP` | 422 | Mainnet safety cap |
| `Underpaid` | `UNDERPAID` | 409 | |
| `SwapOutputTooLow` | `SWAP_OUTPUT_TOO_LOW` | 409 | Price moved — re-quote |
| `IntentNotCommitted` | `INTENT_NOT_COMMITTED` | 409 | |
| `IntentAlreadyExists` | `REPLAY_BLOCKED` | 409 | |
| `RefundNotYetAllowed` | `REFUND_NOT_YET_ALLOWED` | 409 | |
| `IntentNotTerminal` | `INTENT_NOT_TERMINAL` | 409 | |
| `AlreadyAttested` | `ALREADY_ATTESTED` | 409 | |
| `NoSwapAdapter` | `SWAP_UNAVAILABLE` | 503 | |
| `MerchantAlreadyExists` | `MERCHANT_EXISTS` | 409 | |
| `MerchantNotFound` | `MERCHANT_NOT_FOUND` | 404 | |
| `MerchantIsRevoked` | `MERCHANT_REVOKED` | 409 | |
| `InvalidOwnerSignature` | `INVALID_OWNER_SIGNATURE` | 422 | |
| `InvalidPayoutSignature` | `INVALID_PAYOUT_SIGNATURE` | 422 | |
| `SignatureExpired` | `SIGNATURE_EXPIRED` | 410 | |
| `BadNonce` | `BAD_NONCE` | 409 | |
| `InvalidStatusTransition` | `INVALID_STATUS_TRANSITION` | 409 | |
| ERC-3009 token revert (any) | `TOKEN_AUTHORIZATION_FAILED` | 422 | Token rejected the transfer authorization |
| anything else | `CHAIN_REVERT` | 502 | |

### 0.9 `deployments/{chainId}.json` schema (generated by A, read by B, FE, indexer)

```json
{
  "schemaVersion": 1,
  "chainId": 10143,
  "network": "testnet",
  "generatedAt": "2026-10-11T06:00:00.000Z",
  "startBlock": 12345678,
  "explorer": "https://testnet.monadscan.com",
  "contracts": {
    "MerchantRegistry": { "address": "0x…", "deployBlock": 12345678, "deployTx": "0x…" },
    "IntentVault":      { "address": "0x…", "deployBlock": 12345679, "deployTx": "0x…" },
    "DepositForwarderImpl": { "address": "0x…" },
    "SwapAdapter":      { "address": "0x…", "kind": "mock" }
  },
  "roles": {
    "admin": "0x…",
    "operator": "0x…",
    "feeRecipient": "0x…"
  },
  "config": {
    "feeBps": 30,
    "refundDelaySec": 600,
    "crossChainInputToken": "USDC",
    "amountCaps": { "USDC": "0", "AUSD": "0" }
  },
  "tokens": {
    "USDC": {
      "address": "0x…", "symbol": "tUSDC", "displaySymbol": "USDC", "decimals": 6,
      "eip712": { "name": "ScanPay Test USDC", "version": "1" },
      "supports3009": true, "isMock": true, "usdPrice": 1,
      "roles": ["payout", "direct", "swapIn", "crosschainIn"]
    },
    "AUSD": {
      "address": "0x…", "symbol": "tAUSD", "displaySymbol": "AUSD", "decimals": 6,
      "eip712": { "name": "ScanPay Test AUSD", "version": "1" },
      "supports3009": true, "isMock": true, "usdPrice": 1,
      "roles": ["payout", "direct", "swapIn"]
    },
    "MON": {
      "address": "0x…", "symbol": "tMON", "displaySymbol": "MON", "decimals": 18,
      "eip712": null, "supports3009": false, "isMock": true, "usdPrice": 0.025,
      "roles": ["swapIn"]
    }
  },
  "external": {
    "kuruFlowApi": null,
    "kuruTargets": [],
    "auroraMonadUsdcAssetId": null
  }
}
```

Token key names are **fixed**: `USDC`, `AUSD`, `MON`, `WMON`, `WETH`, `USDT0`. Not every chain has every key.
Mainnet `tokens` contain the real addresses (USDC `0x754704Bc059F8C67012fEd69BC8A327a5aafb603`, AUSD `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a`,
WMON `0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A`, WETH `0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242`), `isMock: false`, and `external`:
```json
"external": {
  "kuruFlowApi": "https://ws.kuru.io",
  "kuruTargets": ["0xb3e6778480b2E488385E8205eA05E20060B813cb", "0x0d3a1BE29E9dEd63c7a5678b31e847D68F71FFa2"],
  "auroraMonadUsdcAssetId": "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx"
}
```

### 0.10 `@scanpay/shared` exports (import path `@scanpay/shared`)

A-owned:
```ts
// constants.ts
export const ICD_VERSION = 1;
export const ROUTE = { DIRECT: 0, SWAP: 1, CROSSCHAIN: 2 } as const;
export const INTENT_STATUS = { NONE: 0, COMMITTED: 1, SETTLED: 2, REFUNDED: 3 } as const;
export const INVOICE_STATE = { OPEN: 0, RESERVED: 1, PAID: 2 } as const;
export const MERCHANT_STATUS = { NONE: 0, PENDING: 1, ACTIVE: 2, SUSPENDED: 3, REVOKED: 4 } as const;
export const CHAIN_IDS = { local: 31337, testnet: 10143, mainnet: 143 } as const;
export const VAULT_DOMAIN_NAME = 'ScanPayGuard'; export const REGISTRY_DOMAIN_NAME = 'ScanPayRegistry'; export const DOMAIN_VERSION = '1';
// types.ts      Hex, Address, InvoiceMessage, PaymentIntentMessage, RegistrationMessage, SignerRotationMessage,
//               PayoutUpdateMessage, ReceiveAuthMessage, IntentRecord, MerchantRecord, Deployment, TokenInfo, TokenKey
// eip712.ts     *Types objects, vaultDomain(), registryDomain(), tokenDomain(), build*TypedData(), *Digest(), splitSignature()
// ids.ts        computeMerchantId(), computeIntentId(), randomBytes32(), randomNonce()
// wire.ts       toWire*/fromWire* converters (bigint <-> decimal string) for every message type
// generated/abis.ts         merchantRegistryAbi, intentVaultAbi, swapAdapterAbi, erc3009Abi, mockStableTokenAbi, mockSwapAdapterAbi, erc20Abi
// generated/deployments.ts  DEPLOYMENTS: Record<number, Deployment>, getDeployment(chainId), getToken(chainId, key)
```
B-owned:
```ts
// canonical.ts   canonicalJson(value): string     (sorted keys, no whitespace, bigint -> decimal string)
// quote-hash.ts  quoteHash(fields: QuoteHashFields): Hex  = keccak256(toBytes(canonicalJson(fields)))
// errors.ts      API_ERROR (code -> {http, message}), CONTRACT_ERROR_TO_CODE map (§0.8)
// api.ts         zod schemas + inferred types for every request/response in Backend B §B-API
```

**Wire format rule (API JSON and deployments):** `uint256`/`uint64` → decimal **string**; `uint8`/`uint32` → **number**;
`address`/`bytes32` → lowercase `0x` hex **string**; timestamps are **unix seconds** (number) unless the field name ends
in `At` *and* is a Mongo date (then ISO string). Signatures are `0x` hex (65 bytes).

### 0.11 Environment variables (all of them)

| Var | Used by | Example | Notes |
|---|---|---|---|
| `MONAD_TESTNET_RPC` | A, B | `https://testnet-rpc.monad.xyz` | |
| `MONAD_MAINNET_RPC` | A, B | `https://rpc.monad.xyz` | |
| `DEPLOYER_ACCOUNT` | A | `scanpay-deployer` | Foundry keystore name (`cast wallet import`) |
| `ADMIN_ADDRESS` | A | `0x…` | = deployer address; holds DEFAULT_ADMIN/CONFIG/PAUSER |
| `OPERATOR_ADDRESS` | A | `0x…` | B's hot key address; gets VERIFIER, ATTESTER, MINTER |
| `FEE_RECIPIENT` | A | `0x…` | |
| `FEE_BPS` | A | `30` | max 100 |
| `REFUND_DELAY_SEC` | A | `600` testnet / `3600` mainnet | |
| `MONADSCAN_API_KEY` | A | | optional (Sourcify needs none) |
| `ENVIO_API_TOKEN` | A | | envio.dev/app/api-tokens |
| `OPERATOR_PRIVATE_KEY_LOCAL` | B | anvil key #1 | |
| `OPERATOR_PRIVATE_KEY_TESTNET` | B | `0x…` | must match `OPERATOR_ADDRESS` used by A on testnet |
| `OPERATOR_PRIVATE_KEY_MAINNET` | B | `0x…` | must match mainnet `OPERATOR_ADDRESS` |
| `MONGODB_URI` | B | `mongodb+srv://…` | |
| `PORT` | B | `8787` | |
| `PUBLIC_APP_URL` | B, FE | `https://scanpay-guard.vercel.app` | QR links |
| `CORS_ORIGINS` | B | `http://localhost:3000,https://…` | |
| `ENABLED_CHAINS` | B | `31337,10143,143` | |
| `ADMIN_TOKEN` | B, FE(admin page) | random 32 chars | Bearer for /v1/admin/* |
| `AURORA_API_KEY` | B | | studio.aurora.dev (not secret per Aurora docs) |
| `ONECLICK_JWT` | B | | optional fallback provider |
| `ENVIO_GRAPHQL_URL` | B | `http://localhost:8080/v1/graphql` | |
| `ATTACK_LAB_ENABLED` | B | `true` | testnet/local only |
| `NEXT_PUBLIC_API_URL` | FE | `https://api…` | |

### 0.12 Ports & URLs

| Service | Local | Deployed |
|---|---|---|
| anvil | `127.0.0.1:8545` | — |
| Envio Hasura GraphQL | `http://localhost:8080/v1/graphql` (admin secret `testing`) | Envio Cloud endpoint (A posts URL in chat at I3) |
| Backend B API | `http://localhost:8787` | Railway URL (B posts at I5) |
| Frontend | `http://localhost:3000` | Vercel |

### 0.13 Handoff checkpoints (the only moments A ↔ B depend on each other)

| ID | From → To | Deliverable | Acceptance command (receiver runs) | Target (IST) |
|---|---|---|---|---|
| **I0** | A → B, FE | Interfaces + `ScanPayTypes.sol` committed; `packages/shared` with `eip712.ts`, `types.ts`, `ids.ts`, `wire.ts`, `constants.ts`, **generated ABIs from interfaces**, golden vectors | `pnpm --filter @scanpay/shared test` → all pass | Sat 21:00 |
| **I1** | A → B | `pnpm chain:local` boots anvil and deploys full stack, writes `deployments/31337.json` + regenerates `generated/deployments.ts` | `pnpm chain:local` then `curl -s localhost:8545 -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'` → `0x7a69`; file exists | Sun 10:00 |
| **I2** | A → B, FE | Testnet deployment, verified on explorer, `deployments/10143.json` committed | `pnpm --filter @scanpay/shared exec tsx scripts/print-deployment.ts 10143` prints addresses | Sun 15:00 |
| **I3** | A → B | Envio indexer for testnet running on Envio Cloud; GraphQL URL shared | `curl $ENVIO_GRAPHQL_URL -H 'content-type: application/json' -d '{"query":"{ Merchant(limit:1){ id } }"}'` → 200 | Sun 22:00 |
| **I4** | A → B | Mainnet deployment + `deployments/143.json` + Kuru adapter allowlisted | B runs `pnpm --filter @scanpay/api smoke:mainnet-readonly` | Mon 14:00 |
| **I5** | B → FE | API deployed with `GET /v1/config` working for 10143 (+143) | `curl $API/v1/config` | Mon 12:00 |

Before a checkpoint lands, the receiver **never blocks**: B builds against `local` (I1) and FE builds against B's local API.

---

## Part III — Build phases

Conventions used in every phase:
- **Goal** – one sentence. **Time** – budget. **Depends on** – earlier phases / checkpoints.
- **Files** – every file you create or change, with full content.
- **Commands** – run from repo root unless a `cd` is shown.
- **Exit checks** – all must pass before the commit.
- **Commit** – exact message. Push after every commit (commit history is judged).

All service code lives in `services/api/src/`. Paths below are relative to the repo root.

---

### Phase B0 — Machine setup, keys, accounts

**Goal:** tools installed, operator keys created (addresses sent to A), external accounts ready.
**Time:** 30 min. **Depends on:** nothing.

**Commands**

```bash
node --version            # v22.x
corepack enable && corepack prepare pnpm@9.12.0 --activate
curl -L https://foundry.paradigm.xyz | bash && foundryup   # you need `cast` + `anvil` for local work
cast --version

# Operator keys (B's hot keys). Testnet and mainnet may be the same key for the hackathon; separate is cleaner.
cast wallet new           # → OPERATOR_PRIVATE_KEY_TESTNET + its address
cast wallet new           # → OPERATOR_PRIVATE_KEY_MAINNET + its address
```

Send **only the addresses** to A in the team chat (A needs them for `OPERATOR_ADDRESS` at A19/A23):

```
OPERATOR (testnet) = 0x…
OPERATOR (mainnet) = 0x…
```

**Accounts**

| Service | What to do | Result |
|---|---|---|
| MongoDB Atlas | free M0 cluster, DB user, network access `0.0.0.0/0` (Railway has dynamic IPs) | `MONGODB_URI=mongodb+srv://…/scanpay` |
| Local Mongo | `docker run -d --name mongo -p 27017:27017 mongo:7` | `MONGODB_URI=mongodb://127.0.0.1:27017/scanpay` |
| Aurora Studio | https://studio.aurora.dev → create app → copy API key (it is **not** secret per Aurora docs; still keep it in env) | `AURORA_API_KEY` |
| NEAR Intents partners (optional fallback) | https://partners.near-intents.org → JWT | `ONECLICK_JWT` |
| Railway | account + GitHub link | used in B30 |
| Admin token | `openssl rand -hex 16` | `ADMIN_TOKEN` |

**Exit checks**
- [ ] A has your operator addresses
- [ ] `.env` (copied from `.env.example`) has `MONGODB_URI`, `ADMIN_TOKEN`, `AURORA_API_KEY`, both operator keys
- [ ] `docker ps` shows mongo running (local dev)

**Commit:** nothing to commit.

---

### Phase B1 — `services/api` skeleton + env + logger

**Goal:** a typed, validated config object and a booting (empty) process. **Time:** 30 min. **Depends on:** I0.

**File: `services/api/package.json`**

```json
{
  "name": "@scanpay/api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch --env-file=../../.env src/index.ts",
    "start": "tsx src/index.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run test/unit",
    "test:e2e": "vitest run test/e2e --no-file-parallelism",
    "smoke:mainnet-readonly": "tsx --env-file=../../.env scripts/smoke-mainnet-readonly.ts",
    "verify-receipt": "tsx --env-file=../../.env scripts/verify-receipt.ts"
  },
  "dependencies": {
    "@fastify/cors": "^10.0.1",
    "@fastify/rate-limit": "^10.1.1",
    "@scanpay/shared": "workspace:*",
    "fastify": "^5.1.0",
    "mongoose": "^8.8.0",
    "pino": "^9.5.0",
    "viem": "^2.40.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.9.0",
    "mongodb-memory-server": "^10.1.2",
    "pino-pretty": "^11.3.0",
    "tsx": "^4.19.2",
    "typescript": "^5.6.3",
    "vitest": "^2.1.4"
  }
}
```

> `tsx --env-file` needs Node ≥ 20.6 (we use 22). On Railway env vars come from the dashboard, so `start` has no
> `--env-file`.

**File: `services/api/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "scripts", "test"]
}
```

**File: `services/api/src/env.ts`**

```ts
import { z } from 'zod';

const hexKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 0x-prefixed 32-byte private key');
const optKey = z.preprocess((v) => (v === '' ? undefined : v), hexKey.optional());
const optStr = z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(8787),
  PUBLIC_APP_URL: z.string().url().default('http://localhost:3000'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  ENABLED_CHAINS: z
    .string()
    .default('31337')
    .transform((s) => s.split(',').map((x) => Number(x.trim())).filter(Boolean)),
  MONGODB_URI: z.string().min(1),
  MONAD_TESTNET_RPC: z.string().url().default('https://testnet-rpc.monad.xyz'),
  MONAD_MAINNET_RPC: z.string().url().default('https://rpc.monad.xyz'),
  LOCAL_RPC: z.string().url().default('http://127.0.0.1:8545'),
  OPERATOR_PRIVATE_KEY_LOCAL: optKey,
  OPERATOR_PRIVATE_KEY_TESTNET: optKey,
  OPERATOR_PRIVATE_KEY_MAINNET: optKey,
  ADMIN_TOKEN: z.string().min(16),
  AURORA_API_KEY: optStr,
  ONECLICK_JWT: optStr,
  ENVIO_GRAPHQL_URL: optStr,
  ATTACK_LAB_ENABLED: z
    .string()
    .default('true')
    .transform((s) => s === 'true'),
  LOG_LEVEL: z.string().default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${msg}`);
  }
  const env = parsed.data;
  for (const id of env.ENABLED_CHAINS) {
    const key = operatorKeyFor(env, id);
    if (!key) throw new Error(`ENABLED_CHAINS includes ${id} but its OPERATOR_PRIVATE_KEY_* is empty`);
  }
  return env;
}

export function operatorKeyFor(env: Env, chainId: number): `0x${string}` | undefined {
  if (chainId === 31337) return env.OPERATOR_PRIVATE_KEY_LOCAL as `0x${string}` | undefined;
  if (chainId === 10143) return env.OPERATOR_PRIVATE_KEY_TESTNET as `0x${string}` | undefined;
  if (chainId === 143) return env.OPERATOR_PRIVATE_KEY_MAINNET as `0x${string}` | undefined;
  return undefined;
}
```

> `LOCAL_RPC` is a B-only convenience (defaults to anvil); it doesn't need to be in the ICD table because nothing
> else reads it. Every ICD §0.11 B variable is covered above.

**File: `services/api/src/log.ts`**

```ts
import pino from 'pino';

export const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty', options: { colorize: true } },
  redact: ['req.headers.authorization', '*.privateKey', '*.OPERATOR_PRIVATE_KEY_*'],
});
```

**File: `services/api/src/index.ts`** (grows in B6 and B20)

```ts
import { loadEnv } from './env';
import { log } from './log';

const env = loadEnv();
log.info({ chains: env.ENABLED_CHAINS, port: env.PORT }, 'scanpay api booting');
```

**Commands**

```bash
pnpm install
cd services/api && pnpm dev     # prints "scanpay api booting", Ctrl+C
```

**Exit checks**
- [ ] Booting with an empty `MONGODB_URI` fails with a readable "Invalid environment" message
- [ ] `ENABLED_CHAINS=31337` without `OPERATOR_PRIVATE_KEY_LOCAL` fails with the operator-key message

**Commit:** `feat(api): service skeleton, validated env, logger`

---

### Phase B2 — B-owned shared files: canonical JSON, quote hash, error map, API schemas

**Goal:** the four files in `packages/shared/src/` you own (ICD §0.1): they are the B↔FE contract.
**Time:** 90 min. **Depends on:** I0.

**File: `packages/shared/src/canonical.ts`**

```ts
/**
 * Canonical JSON (ICD §0.10): object keys sorted (UTF-16 code unit order, i.e. JS default sort), no whitespace,
 * bigint -> decimal string, undefined properties dropped, arrays keep order. Used for quoteHash and metadataHash.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('canonicalJson: non-finite number');
    return v;
  }
  if (Array.isArray(v)) return v.map(normalize);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>).sort()) {
    const val = (v as Record<string, unknown>)[k];
    if (val === undefined) continue;
    out[k] = normalize(val);
  }
  return out;
}
```

**File: `packages/shared/src/quote-hash.ts`**

```ts
import { keccak256, toBytes, type Address, type Hex } from 'viem';
import { canonicalJson } from './canonical';

/**
 * Everything the payer is agreeing to about HOW they pay. The payer signs keccak256(canonicalJson(fields))
 * inside PaymentIntent.quoteHash, so B can never swap the quote after signing, and the verify page can
 * recompute it from the stored fields.
 */
export interface QuoteHashFields {
  v: 1;
  chainId: number;
  route: 'SWAP' | 'CROSSCHAIN';
  provider: 'none' | 'mock' | 'kuru' | 'aurora' | 'oneclick' | 'simulated';
  quoteId: string; // provider correlation id / deterministic id for mock+simulated
  inputToken: Address; // Monad token the vault receives (lowercase)
  payoutToken: Address;
  amountOut: string; // uint256 decimal
  maxAmountIn: string; // uint256 decimal (Monad inputToken units)
  depositAddress: string | null; // CROSSCHAIN: source-chain deposit address from provider
  recipient: Address | null; // CROSSCHAIN: forwarder on Monad
  originAsset: string | null; // CROSSCHAIN: provider assetId on the source chain
  originAmountIn: string | null; // CROSSCHAIN: amount the customer sends on the source chain
  deadline: number; // unix seconds — provider quote deadline (or intent expiry)
}

export function quoteHash(fields: QuoteHashFields): Hex {
  return keccak256(toBytes(canonicalJson(fields)));
}

/** metadataHash for merchant profiles (ICD §0.6) */
export function profileHash(profile: {
  displayName: string;
  category: string;
  city: string;
  country: string;
  logoUrl: string;
}): Hex {
  return keccak256(toBytes(canonicalJson(profile)));
}
```

**File: `packages/shared/src/errors.ts`**

```ts
import { parseAbi } from 'viem';

export const API_ERROR = {
  // ---- generic ----
  VALIDATION_ERROR: { http: 400, message: 'The request is invalid.' },
  UNAUTHORIZED: { http: 401, message: 'Not authorized.' },
  NOT_FOUND: { http: 404, message: 'Not found.' },
  RATE_LIMITED: { http: 429, message: 'Too many requests. Try again shortly.' },
  IDEMPOTENCY_CONFLICT: { http: 409, message: 'This request is already being processed.' },
  CHAIN_NOT_ENABLED: { http: 400, message: 'This network is not enabled.' },
  INTERNAL: { http: 500, message: 'Something went wrong on our side.' },
  // ---- domain (off-chain) ----
  INVOICE_NOT_FOUND: { http: 404, message: 'This payment link does not exist.' },
  INTENT_NOT_FOUND: { http: 404, message: 'Payment not found.' },
  DRAFT_EXPIRED: { http: 410, message: 'This payment request expired. Start again.' },
  ROUTE_UNAVAILABLE: { http: 422, message: 'This payment method is not available for this merchant.' },
  QR_NOT_RECOGNIZED: { http: 422, message: 'This QR code is not a ScanPay code.' },
  PROFILE_HASH_MISMATCH: { http: 422, message: 'Merchant profile does not match what was signed.' },
  PROVIDER_UNAVAILABLE: { http: 503, message: 'Cross-chain provider is unavailable. Try another method.' },
  QUOTE_FAILED: { http: 502, message: 'Could not get a price right now.' },
  ALLOWANCE_REQUIRED: { http: 409, message: 'One-time approval needed for this token.' },
  INSUFFICIENT_BALANCE: { http: 409, message: 'Not enough balance.' },
  FAUCET_LIMIT: { http: 429, message: 'Faucet already used today for this address.' },
  DRIP_NOT_NEEDED: { http: 409, message: 'This wallet already has enough gas for approval.' },
  TESTNET_ONLY: { http: 403, message: 'Only available on testnet.' },
  ATTACK_LAB_DISABLED: { http: 403, message: 'Attack Lab is disabled.' },
  WRONG_STATE: { http: 409, message: 'Not possible in the current state.' },
  PAUSED: { http: 503, message: 'Payments are temporarily paused.' },
  // ---- contract (ICD §0.8) ----
  MERCHANT_NOT_ACTIVE: { http: 409, message: 'This merchant is not verified right now.' },
  MERCHANT_KEYS_CHANGED: { http: 409, message: 'The merchant updated their keys. Ask for a new QR.' },
  TAMPERED_INVOICE_REF: { http: 422, message: 'Payment does not match the invoice.' },
  TAMPERED_PAYOUT_TOKEN: { http: 422, message: 'The payout currency was changed.' },
  PAYOUT_TOKEN_NOT_ALLOWED: { http: 422, message: 'This payout currency is not supported.' },
  TAMPERED_AMOUNT: { http: 422, message: 'The amount was changed.' },
  INVOICE_EXPIRED: { http: 410, message: 'This invoice expired. Ask for a new QR.' },
  QUOTE_EXPIRED: { http: 410, message: 'The price expired. Get a new quote.' },
  INVALID_MERCHANT_SIGNATURE: { http: 422, message: 'Invoice not signed by this merchant.' },
  INVALID_PAYER_SIGNATURE: { http: 422, message: 'Terms changed after you signed.' },
  REPLAY_BLOCKED: { http: 409, message: 'This payment was already used.' },
  INVOICE_ALREADY_PAID: { http: 409, message: 'This invoice is already paid or in progress.' },
  ROUTE_MISMATCH: { http: 422, message: 'Wrong payment method for this request.' },
  INPUT_TOKEN_NOT_ALLOWED: { http: 422, message: 'This token cannot be used here.' },
  AMOUNT_ABOVE_CAP: { http: 422, message: 'Amount above the safety limit.' },
  UNDERPAID: { http: 409, message: 'Not enough funds arrived yet.' },
  SWAP_OUTPUT_TOO_LOW: { http: 409, message: 'Price moved. Get a new quote.' },
  INTENT_NOT_COMMITTED: { http: 409, message: 'Payment is not open.' },
  REFUND_NOT_YET_ALLOWED: { http: 409, message: 'Refund not available yet.' },
  INTENT_NOT_TERMINAL: { http: 409, message: 'Payment still open.' },
  ALREADY_ATTESTED: { http: 409, message: 'Source already attested.' },
  SWAP_UNAVAILABLE: { http: 503, message: 'Swaps are unavailable right now.' },
  MERCHANT_EXISTS: { http: 409, message: 'This merchant already exists.' },
  MERCHANT_NOT_FOUND: { http: 404, message: 'Merchant not found.' },
  MERCHANT_REVOKED: { http: 409, message: 'This merchant was revoked.' },
  INVALID_OWNER_SIGNATURE: { http: 422, message: 'Owner signature is invalid.' },
  INVALID_PAYOUT_SIGNATURE: { http: 422, message: 'Payout wallet signature is invalid.' },
  SIGNATURE_EXPIRED: { http: 410, message: 'Signature expired. Try again.' },
  BAD_NONCE: { http: 409, message: 'Out-of-date request. Try again.' },
  INVALID_STATUS_TRANSITION: { http: 409, message: 'Status change not allowed.' },
  TOKEN_AUTHORIZATION_FAILED: { http: 422, message: 'The token rejected the transfer authorization.' },
  CHAIN_REVERT: { http: 502, message: 'The network rejected the transaction.' },
} as const;

export type ApiErrorCode = keyof typeof API_ERROR;

/** Solidity custom error name -> API code (ICD §0.8 + OpenZeppelin/mocks/adapters). */
export const CONTRACT_ERROR_TO_CODE: Record<string, ApiErrorCode> = {
  // IntentVault
  MerchantNotActive: 'MERCHANT_NOT_ACTIVE',
  KeyVersionMismatch: 'MERCHANT_KEYS_CHANGED',
  InvoiceMismatch: 'TAMPERED_INVOICE_REF',
  PayoutTokenMismatch: 'TAMPERED_PAYOUT_TOKEN',
  PayoutTokenNotAllowed: 'PAYOUT_TOKEN_NOT_ALLOWED',
  AmountMismatch: 'TAMPERED_AMOUNT',
  InvoiceExpired: 'INVOICE_EXPIRED',
  IntentExpired: 'QUOTE_EXPIRED',
  InvalidMerchantSignature: 'INVALID_MERCHANT_SIGNATURE',
  InvalidPayerSignature: 'INVALID_PAYER_SIGNATURE',
  NonceAlreadyUsed: 'REPLAY_BLOCKED',
  InvoiceNotOpen: 'INVOICE_ALREADY_PAID',
  RouteMismatch: 'ROUTE_MISMATCH',
  InputTokenNotAllowed: 'INPUT_TOKEN_NOT_ALLOWED',
  AmountAboveCap: 'AMOUNT_ABOVE_CAP',
  Underpaid: 'UNDERPAID',
  SwapOutputTooLow: 'SWAP_OUTPUT_TOO_LOW',
  IntentNotCommitted: 'INTENT_NOT_COMMITTED',
  IntentAlreadyExists: 'REPLAY_BLOCKED',
  RefundNotYetAllowed: 'REFUND_NOT_YET_ALLOWED',
  IntentNotTerminal: 'INTENT_NOT_TERMINAL',
  AlreadyAttested: 'ALREADY_ATTESTED',
  NoSwapAdapter: 'SWAP_UNAVAILABLE',
  InvalidFee: 'CHAIN_REVERT',
  ZeroAddress: 'VALIDATION_ERROR',
  // MerchantRegistry
  MerchantAlreadyExists: 'MERCHANT_EXISTS',
  MerchantNotFound: 'MERCHANT_NOT_FOUND',
  MerchantIsRevoked: 'MERCHANT_REVOKED',
  InvalidOwnerSignature: 'INVALID_OWNER_SIGNATURE',
  InvalidPayoutSignature: 'INVALID_PAYOUT_SIGNATURE',
  SignatureExpired: 'SIGNATURE_EXPIRED',
  BadNonce: 'BAD_NONCE',
  InvalidStatusTransition: 'INVALID_STATUS_TRANSITION',
  // OpenZeppelin
  EnforcedPause: 'PAUSED',
  ERC20InsufficientAllowance: 'ALLOWANCE_REQUIRED',
  ERC20InsufficientBalance: 'INSUFFICIENT_BALANCE',
  AccessControlUnauthorizedAccount: 'CHAIN_REVERT',
  ReentrancyGuardReentrantCall: 'CHAIN_REVERT',
  SafeERC20FailedOperation: 'CHAIN_REVERT',
  // MockStableToken (EIP-3009)
  CallerMustBePayee: 'TOKEN_AUTHORIZATION_FAILED',
  AuthorizationNotYetValid: 'TOKEN_AUTHORIZATION_FAILED',
  AuthorizationExpired: 'TOKEN_AUTHORIZATION_FAILED',
  AuthorizationAlreadyUsed: 'REPLAY_BLOCKED',
  InvalidAuthorizationSignature: 'TOKEN_AUTHORIZATION_FAILED',
  // Swap adapters
  OnlyVault: 'CHAIN_REVERT',
  TargetNotAllowed: 'SWAP_UNAVAILABLE',
  SwapCallFailed: 'SWAP_OUTPUT_TOO_LOW',
  NoRate: 'SWAP_UNAVAILABLE',
  InsufficientOutput: 'SWAP_OUTPUT_TOO_LOW',
};

/** Error(string) reverts (e.g. Circle FiatToken "FiatTokenV2: invalid signature"). First match wins. */
export const REVERT_STRING_RULES: ReadonlyArray<readonly [RegExp, ApiErrorCode]> = [
  [/authorization is used|authorization is expired|authorization is not yet valid|invalid signature|caller must be the payee|FiatToken|EIP3009|ECRecover/i, 'TOKEN_AUTHORIZATION_FAILED'],
  [/transfer amount exceeds balance/i, 'INSUFFICIENT_BALANCE'],
  [/transfer amount exceeds allowance/i, 'ALLOWANCE_REQUIRED'],
];

/** Errors not in the interface ABIs that can still bubble up through the vault (decode with these too). */
export const EXTRA_ERRORS_ABI = parseAbi([
  'error EnforcedPause()',
  'error ExpectedPause()',
  'error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)',
  'error ReentrancyGuardReentrantCall()',
  'error SafeERC20FailedOperation(address token)',
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error CallerMustBePayee()',
  'error AuthorizationNotYetValid()',
  'error AuthorizationExpired()',
  'error AuthorizationAlreadyUsed()',
  'error InvalidAuthorizationSignature()',
  'error ECDSAInvalidSignature()',
  'error ECDSAInvalidSignatureLength(uint256 length)',
  'error ECDSAInvalidSignatureS(bytes32 s)',
]);
```

> `ISwapAdapter` errors (`OnlyVault`, `TargetNotAllowed`, `SwapCallFailed`, `NoRate`, `InsufficientOutput`) are
> already in the generated `swapAdapterAbi`; B5 merges all ABIs for decoding.

**File: `packages/shared/src/api.ts`** — the complete HTTP contract (Part IV documents each endpoint with these names)

```ts
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
export const zRouteName = z.enum(['DIRECT', 'SWAP', 'CROSSCHAIN']);
export const zMerchantStatusName = z.enum(['NONE', 'PENDING', 'ACTIVE', 'SUSPENDED', 'REVOKED']);
export const zLifecycle = z.enum([
  'DRAFT', 'SUBMITTED', 'COMMITTED', 'AWAITING_DEPOSIT', 'PROCESSING', 'SETTLED', 'UNDERPAID',
  'RECONCILIATION_REQUIRED', 'EXPIRED', 'REFUNDED', 'FAILED',
]);
export type Lifecycle = z.infer<typeof zLifecycle>;
export type RouteName = z.infer<typeof zRouteName>;

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
  fields: z.any(), // QuoteHashFields (see quote-hash.ts) — kept as any to avoid a zod mirror drifting from the TS type
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
```

**Edit (the one sanctioned edit to an A-owned file): `packages/shared/src/index.ts`** — uncomment the four B lines
and post "uncommented B exports in shared/index.ts" in chat:

```ts
export * from './canonical';
export * from './quote-hash';
export * from './errors';
export * from './api';
```

**File: `packages/shared/test/b-owned.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { keccak256, toBytes } from 'viem';
import { canonicalJson, quoteHash, profileHash, CONTRACT_ERROR_TO_CODE, API_ERROR, zWireIntent } from '../src';

describe('canonicalJson', () => {
  it('sorts keys deeply, drops undefined, stringifies bigint', () => {
    expect(canonicalJson({ b: 1, a: { d: 2n, c: undefined, b: [3, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"b":[3,{"y":2,"z":1}],"d":"2"},"b":1}',
    );
  });
  it('is stable regardless of insertion order', () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });
  it('rejects NaN', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
  });
});

describe('quoteHash', () => {
  it('= keccak256(utf8(canonicalJson(fields)))', () => {
    const f = {
      v: 1 as const, chainId: 10143, route: 'SWAP' as const, provider: 'mock' as const, quoteId: 'mock:25000',
      inputToken: '0x0000000000000000000000000000000000000001' as const,
      payoutToken: '0x0000000000000000000000000000000000000002' as const, amountOut: '12000000',
      maxAmountIn: '482400000000000000000', depositAddress: null, recipient: null, originAsset: null,
      originAmountIn: null, deadline: 1800000000,
    };
    expect(quoteHash(f)).toBe(keccak256(toBytes(canonicalJson(f))));
    expect(quoteHash({ ...f, maxAmountIn: '1' })).not.toBe(quoteHash(f));
  });
  it('profileHash is order independent', () => {
    const p = { displayName: 'Cafe', category: 'food', city: 'Chennai', country: 'IN', logoUrl: '' };
    expect(profileHash(p)).toBe(profileHash({ logoUrl: '', country: 'IN', city: 'Chennai', category: 'food', displayName: 'Cafe' }));
  });
});

describe('error map', () => {
  it('every mapped code exists in API_ERROR', () => {
    for (const code of Object.values(CONTRACT_ERROR_TO_CODE)) expect(API_ERROR[code]).toBeDefined();
  });
  it('covers all 25 vault errors + 10 registry errors', () => {
    const vault = ['MerchantNotActive', 'KeyVersionMismatch', 'InvoiceMismatch', 'PayoutTokenMismatch', 'PayoutTokenNotAllowed',
      'AmountMismatch', 'InvoiceExpired', 'IntentExpired', 'InvalidMerchantSignature', 'InvalidPayerSignature', 'NonceAlreadyUsed',
      'InvoiceNotOpen', 'RouteMismatch', 'InputTokenNotAllowed', 'AmountAboveCap', 'Underpaid', 'SwapOutputTooLow',
      'IntentNotCommitted', 'IntentAlreadyExists', 'RefundNotYetAllowed', 'IntentNotTerminal', 'AlreadyAttested', 'NoSwapAdapter',
      'InvalidFee', 'ZeroAddress'];
    const registry = ['MerchantAlreadyExists', 'MerchantNotFound', 'MerchantIsRevoked', 'InvalidOwnerSignature',
      'InvalidPayoutSignature', 'SignatureExpired', 'BadNonce', 'PayoutTokenNotAllowed', 'ZeroAddress', 'InvalidStatusTransition'];
    for (const e of [...vault, ...registry]) expect(CONTRACT_ERROR_TO_CODE[e], e).toBeDefined();
  });
});

describe('zod wire', () => {
  it('lowercases addresses and rejects numeric uint256', () => {
    const ok = zWireIntent.parse({
      merchantId: '0x' + 'AB'.repeat(32), invoiceId: '0x' + '01'.repeat(32), payer: '0x' + 'CD'.repeat(20),
      payoutToken: '0x' + '11'.repeat(20), amountOut: '1', route: 0, inputToken: '0x' + '11'.repeat(20), maxAmountIn: '1',
      quoteHash: '0x' + '00'.repeat(32), refundTo: '0x' + 'CD'.repeat(20), expiresAt: '1', nonce: '5', keyVersion: 1,
    });
    expect(ok.payer).toBe('0x' + 'cd'.repeat(20));
    expect(() => zWireIntent.parse({ ...ok, amountOut: 1 })).toThrow();
  });
});
```

**Commands**

```bash
pnpm shared:test       # golden (5) + b-owned (8)
pnpm --filter @scanpay/shared typecheck
```

**Exit checks**
- [ ] 13 tests pass
- [ ] FE engineer told: "`@scanpay/shared` now exports api.ts schemas — use `zPrepareRes.parse()` etc."

**Commit:** `feat(shared): canonical json, quote hash, error map, API zod contract`

---

### Phase B3 — Chain contexts + relayer

**Goal:** one `ChainCtx` per enabled chain (clients, operator account, addresses, features) and a single `relay()`
that every write goes through. **Time:** 60 min. **Depends on:** B1, I0 (I1 for running).

**File: `services/api/src/chains.ts`**

```ts
import {
  createPublicClient, createWalletClient, http, nonceManager, type Address, type Chain, type PublicClient,
  type WalletClient, type Transport, type Account,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { foundry, monad, monadTestnet } from 'viem/chains';
import { getDeployment, hasDeployment, type Deployment, type TokenKey, type TokenInfo } from '@scanpay/shared';
import { operatorKeyFor, type Env } from './env';
import { Mutex } from './util/mutex';

export interface ChainFeatures {
  direct: boolean;
  swap: boolean;
  crosschain: 'live' | 'simulated' | 'off';
  faucet: boolean;
  attackLab: boolean;
  indexer: boolean;
}

export interface ChainCtx {
  chainId: number;
  chain: Chain;
  isMainnet: boolean;
  deployment: Deployment;
  vault: Address;
  registry: Address;
  adapter: Address | null;
  adapterKind: 'mock' | 'kuru' | 'none';
  public: PublicClient<Transport, Chain>;
  wallet: WalletClient<Transport, Chain, Account>;
  operator: PrivateKeyAccount;
  sendLock: Mutex;
  features: ChainFeatures;
  explorerTx: (hash: string) => string | null;
  explorerAddress: (addr: string) => string | null;
  token: (key: TokenKey) => TokenInfo | undefined;
  tokenByAddress: (addr: string) => { key: TokenKey; token: TokenInfo } | null;
}

const CHAINS: Record<number, Chain> = { 31337: foundry, 10143: monadTestnet, 143: monad };

function rpcFor(env: Env, chainId: number) {
  if (chainId === 31337) return env.LOCAL_RPC;
  if (chainId === 10143) return env.MONAD_TESTNET_RPC;
  return env.MONAD_MAINNET_RPC;
}

const ctxs = new Map<number, ChainCtx>();

export function initChains(env: Env): Map<number, ChainCtx> {
  for (const chainId of env.ENABLED_CHAINS) {
    if (!hasDeployment(chainId)) throw new Error(`No deployments/${chainId}.json — ask A (or run pnpm chain:local)`);
    const deployment = getDeployment(chainId);
    const chain = CHAINS[chainId];
    const transport = http(rpcFor(env, chainId), { retryCount: 2, timeout: 15_000 });
    const operator = privateKeyToAccount(operatorKeyFor(env, chainId)!, { nonceManager });
    if (operator.address.toLowerCase() !== deployment.roles.operator.toLowerCase()) {
      throw new Error(
        `Operator key for ${chainId} is ${operator.address} but deployments/${chainId}.json roles.operator is ${deployment.roles.operator}`,
      );
    }
    const isMainnet = chainId === 143;
    const adapterKind = deployment.contracts.SwapAdapter.kind;
    const explorer = deployment.explorer;
    const ctx: ChainCtx = {
      chainId,
      chain,
      isMainnet,
      deployment,
      vault: deployment.contracts.IntentVault.address,
      registry: deployment.contracts.MerchantRegistry.address,
      adapter: adapterKind === 'none' ? null : deployment.contracts.SwapAdapter.address,
      adapterKind,
      public: createPublicClient({ chain, transport }) as PublicClient<Transport, Chain>,
      wallet: createWalletClient({ chain, transport, account: operator }),
      operator,
      sendLock: new Mutex(),
      features: {
        direct: Object.values(deployment.tokens).some((t) => t?.roles.includes('direct')),
        swap: adapterKind !== 'none' || Object.values(deployment.tokens).some((t) => t?.roles.includes('swapIn')),
        crosschain: deployment.config.crossChainInputToken
          ? isMainnet
            ? env.AURORA_API_KEY || env.ONECLICK_JWT
              ? 'live'
              : 'off'
            : 'simulated'
          : 'off',
        faucet: !isMainnet && Object.values(deployment.tokens).some((t) => t?.isMock),
        attackLab: !isMainnet && env.ATTACK_LAB_ENABLED,
        indexer: Boolean(env.ENVIO_GRAPHQL_URL) && chainId !== 31337,
      },
      explorerTx: (h) => (explorer ? `${explorer}/tx/${h}` : null),
      explorerAddress: (a) => (explorer ? `${explorer}/address/${a}` : null),
      token: (key) => deployment.tokens[key],
      tokenByAddress: (addr) => {
        for (const [key, t] of Object.entries(deployment.tokens) as [TokenKey, TokenInfo][]) {
          if (t.address.toLowerCase() === addr.toLowerCase()) return { key, token: t };
        }
        return null;
      },
    };
    ctxs.set(chainId, ctx);
  }
  return ctxs;
}

export function chainCtx(chainId: number): ChainCtx {
  const c = ctxs.get(chainId);
  if (!c) throw Object.assign(new Error(`chain ${chainId} not enabled`), { apiCode: 'CHAIN_NOT_ENABLED' });
  return c;
}

export function allChains(): ChainCtx[] {
  return [...ctxs.values()];
}
```

**File: `services/api/src/util/mutex.ts`**

```ts
/** Minimal FIFO async mutex: serializes operator sends per chain so nonces are assigned in order. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const prev = this.tail;
    this.tail = prev.then(() => next);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
```

**File: `services/api/src/relayer.ts`**

```ts
import type { Abi, Address, Hex, TransactionReceipt } from 'viem';
import { EXTRA_ERRORS_ABI, intentVaultAbi, merchantRegistryAbi, swapAdapterAbi } from '@scanpay/shared';
import type { ChainCtx } from './chains';
import { ApiError, decodeChainError } from './errors';
import { log } from './log';

/** Every error any of our contracts (or the tokens/adapters they call) can revert with. */
export const DECODE_ABI = [
  ...intentVaultAbi,
  ...merchantRegistryAbi.filter((x) => x.type === 'error'),
  ...swapAdapterAbi.filter((x) => x.type === 'error'),
  ...EXTRA_ERRORS_ABI,
] as unknown as Abi;

export interface RelayCall {
  address: Address;
  abi: Abi | readonly unknown[];
  functionName: string;
  args: readonly unknown[];
  label: string; // for logs + audit
}

export interface RelayResult {
  hash: Hex;
  receipt: TransactionReceipt;
}

/** Simulate with the full error ABI so reverts decode to names (R4). Throws ApiError. */
export async function simulate(ctx: ChainCtx, call: RelayCall, from: Address = ctx.operator.address) {
  try {
    return await ctx.public.simulateContract({
      address: call.address,
      abi: [...(call.abi as Abi), ...DECODE_ABI] as Abi,
      functionName: call.functionName as never,
      args: call.args as never,
      account: from,
    });
  } catch (e) {
    throw decodeChainError(e);
  }
}

/**
 * The only way B writes to chain (R3): simulate -> estimateGas*1.2 -> send (serialized per chain) -> wait.
 * Returns once mined. Throws ApiError on simulate failure or on-chain revert.
 */
export async function relay(ctx: ChainCtx, call: RelayCall): Promise<RelayResult> {
  const hash = await ctx.sendLock.run(async () => {
    await simulate(ctx, call);
    let gas: bigint;
    try {
      gas = await ctx.public.estimateContractGas({
        address: call.address,
        abi: [...(call.abi as Abi), ...DECODE_ABI] as Abi,
        functionName: call.functionName as never,
        args: call.args as never,
        account: ctx.operator,
      });
    } catch (e) {
      throw decodeChainError(e);
    }
    const h = await ctx.wallet.writeContract({
      address: call.address,
      abi: call.abi as Abi,
      functionName: call.functionName as never,
      args: call.args as never,
      gas: (gas * 12n) / 10n,
      chain: ctx.chain,
      account: ctx.operator,
    } as never);
    log.info({ chainId: ctx.chainId, label: call.label, hash: h, gas: gas.toString() }, 'relay sent');
    return h;
  });
  const receipt = await ctx.public.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== 'success') {
    throw new ApiError('CHAIN_REVERT', `${call.label} reverted on-chain`, { txHash: hash });
  }
  return { hash, receipt };
}

/**
 * Broadcast a tx that we EXPECT to revert (Attack Lab evidence). Skips simulation, uses a fixed gas limit
 * so the revert lands on-chain with a hash judges can click.
 */
export async function broadcastExpectRevert(ctx: ChainCtx, call: RelayCall, gas = 400_000n): Promise<Hex> {
  return ctx.sendLock.run(async () =>
    ctx.wallet.writeContract({
      address: call.address,
      abi: call.abi as Abi,
      functionName: call.functionName as never,
      args: call.args as never,
      gas,
      chain: ctx.chain,
      account: ctx.operator,
    } as never),
  );
}

/** Native MON transfer (gas drip). */
export async function sendNative(ctx: ChainCtx, to: Address, value: bigint, label: string): Promise<RelayResult> {
  const hash = await ctx.sendLock.run(() =>
    ctx.wallet.sendTransaction({ to, value, gas: 21_000n, chain: ctx.chain, account: ctx.operator } as never),
  );
  log.info({ chainId: ctx.chainId, label, hash }, 'native sent');
  const receipt = await ctx.public.waitForTransactionReceipt({ hash, timeout: 60_000 });
  return { hash, receipt };
}
```

> Why the mutex wraps simulate + estimate + send but **not** the wait: the nonce is consumed at send; waiting outside
> the lock lets the next payment be sent while the previous one confirms (Monad blocks are ~400 ms, so this matters
> under a demo with several judges paying at once).

**Exit checks**
- [ ] `pnpm --filter @scanpay/api typecheck` passes
- [ ] With I1 running: a scratch call `initChains(loadEnv())` logs no operator-mismatch error for 31337

**Commit:** `feat(api): chain contexts, mutex, relayer with simulate + gas×1.2`

---

### Phase B4 — MongoDB models

**Goal:** every collection with indexes; one file. **Time:** 45 min. **Depends on:** B1.

**File: `services/api/src/db/models.ts`**

```ts
import mongoose, { Schema, type InferSchemaType } from 'mongoose';

const lc = { type: String, lowercase: true, trim: true };

// ---------------- Merchant (mirror of registry + off-chain profile) ----------------
const MerchantSchema = new Schema(
  {
    chainId: { type: Number, required: true },
    merchantId: { ...lc, required: true },
    owner: { ...lc, required: true },
    salt: { ...lc, required: true },
    payoutWallet: { ...lc, required: true },
    invoiceSigner: { ...lc, required: true },
    payoutToken: { ...lc, required: true },
    keyVersion: { type: Number, required: true, default: 1 },
    status: { type: String, enum: ['NONE', 'PENDING', 'ACTIVE', 'SUSPENDED', 'REVOKED'], required: true },
    metadataHash: { ...lc, required: true },
    profile: {
      displayName: String,
      category: String,
      city: String,
      country: String,
      logoUrl: String,
    },
    registeredAt: { type: Number, required: true }, // unix seconds (block time)
    registeredTx: { ...lc },
  },
  { timestamps: true },
);
MerchantSchema.index({ chainId: 1, merchantId: 1 }, { unique: true });
MerchantSchema.index({ chainId: 1, owner: 1 });
MerchantSchema.index({ chainId: 1, status: 1 });

// ---------------- Invoice (merchant-signed, stored for the QR link) ----------------
const InvoiceSchema = new Schema(
  {
    shortCode: { type: String, required: true, unique: true },
    chainId: { type: Number, required: true },
    merchantId: { ...lc, required: true },
    invoiceId: { ...lc, required: true },
    invoice: { type: Schema.Types.Mixed, required: true }, // Wire<InvoiceMessage>
    merchantSig: { ...lc, required: true },
    memo: { type: String, default: null },
    fiat: { currency: String, amount: String },
    requestId: { type: String, default: null },
    expiresAt: { type: Number, required: true },
    paidIntentId: { ...lc, default: null },
    state: { type: String, enum: ['OPEN', 'RESERVED', 'PAID', 'EXPIRED'], default: 'OPEN' },
  },
  { timestamps: true },
);
InvoiceSchema.index({ chainId: 1, merchantId: 1, invoiceId: 1 }, { unique: true });
InvoiceSchema.index({ chainId: 1, merchantId: 1, createdAt: -1 });

// ---------------- InvoiceRequest (static QR: customer asks, merchant terminal signs) ----------------
const InvoiceRequestSchema = new Schema(
  {
    requestId: { type: String, required: true, unique: true },
    chainId: { type: Number, required: true },
    merchantId: { ...lc, required: true },
    amount: { type: String, required: true },
    note: { type: String, default: null },
    status: { type: String, enum: ['PENDING', 'FULFILLED', 'CANCELLED', 'EXPIRED'], default: 'PENDING' },
    shortCode: { type: String, default: null },
    expiresAt: { type: Number, required: true },
  },
  { timestamps: true },
);
InvoiceRequestSchema.index({ chainId: 1, merchantId: 1, status: 1, createdAt: -1 });

// ---------------- Intent (draft + lifecycle + every tx) ----------------
const IntentSchema = new Schema(
  {
    draftId: { type: String, required: true, unique: true },
    chainId: { type: Number, required: true },
    intentId: { ...lc, required: true },
    route: { type: String, enum: ['DIRECT', 'SWAP', 'CROSSCHAIN'], required: true },
    lifecycle: {
      type: String,
      required: true,
      enum: ['DRAFT', 'SUBMITTED', 'COMMITTED', 'AWAITING_DEPOSIT', 'PROCESSING', 'SETTLED', 'UNDERPAID',
        'RECONCILIATION_REQUIRED', 'EXPIRED', 'REFUNDED', 'FAILED'],
    },
    shortCode: { type: String, required: true },
    merchantId: { ...lc, required: true },
    invoiceId: { ...lc, required: true },
    payer: { ...lc, required: true },
    intent: { type: Schema.Types.Mixed, required: true }, // Wire<PaymentIntentMessage>
    invoice: { type: Schema.Types.Mixed, required: true },
    merchantSig: { ...lc, required: true },
    payerSig: { ...lc, default: null },
    receiveAuthSig: { ...lc, default: null },
    quote: { type: Schema.Types.Mixed, default: null }, // { fields, hash, simulated, raw? }
    forwarder: { ...lc, default: null },
    crosschain: {
      mode: { type: String, enum: ['live', 'simulated'], default: undefined },
      provider: String,
      depositAddress: String,
      originAssetId: String,
      originSymbol: String,
      originDecimals: Number,
      originAmountIn: String,
      deadline: Number,
      correlationId: String,
      providerStatus: String,
      providerUpdatedAt: Number,
      providerSuccessAt: Number,
      originTxHashes: [String],
      destinationTxHashes: [String],
      sourceChainId: Number,
      userSourceTx: String,
      lastBalance: String,
    },
    txs: {
      submit: { ...lc, default: null },
      commit: { ...lc, default: null },
      settle: { ...lc, default: null },
      refund: { ...lc, default: null },
      attest: { ...lc, default: null },
    },
    onchain: {
      fee: String,
      inputAmount: String,
      excessRefunded: String,
      netToMerchant: String,
      settledAt: Number,
      settledBlock: Number,
      refundAmount: String,
    },
    error: { code: String, message: String },
    timeline: [{ at: Number, status: String, note: String, _id: false }],
    expiresAt: { type: Number, required: true },
    draftExpiresAt: { type: Number, required: true },
    attackLab: { type: Boolean, default: false },
  },
  { timestamps: true },
);
IntentSchema.index({ chainId: 1, intentId: 1 }, { unique: true });
IntentSchema.index({ chainId: 1, merchantId: 1, createdAt: -1 });
IntentSchema.index({ lifecycle: 1, route: 1 });

// ---------------- Audit, idempotency, drips, cursors, attack lab ----------------
const AuditLogSchema = new Schema(
  {
    at: { type: Date, default: Date.now },
    actor: String, // 'admin' | 'relayer' | 'worker' | 'public'
    action: String,
    chainId: Number,
    ref: String,
    data: Schema.Types.Mixed,
  },
  { versionKey: false },
);
AuditLogSchema.index({ at: -1 });

const IdempotencySchema = new Schema({
  key: { type: String, required: true, unique: true },
  route: String,
  requestHash: String,
  state: { type: String, enum: ['IN_PROGRESS', 'DONE'], default: 'IN_PROGRESS' },
  statusCode: Number,
  response: Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 },
});

const DripLogSchema = new Schema({
  chainId: Number,
  address: { ...lc },
  kind: { type: String, enum: ['faucet', 'gas'] },
  txHash: String,
  at: { type: Date, default: Date.now },
});
DripLogSchema.index({ chainId: 1, address: 1, kind: 1, at: -1 });

const CursorSchema = new Schema({ chainId: { type: Number, unique: true }, lastBlock: Number });

const LabStateSchema = new Schema({
  chainId: { type: Number, unique: true },
  merchantId: String,
  keys: { owner: String, payout: String, signer: String, payer: String, attacker: String }, // TESTNET-ONLY demo keys
});

export const Merchant = mongoose.model('Merchant', MerchantSchema);
export const Invoice = mongoose.model('Invoice', InvoiceSchema);
export const InvoiceRequest = mongoose.model('InvoiceRequest', InvoiceRequestSchema);
export const Intent = mongoose.model('Intent', IntentSchema);
export const AuditLog = mongoose.model('AuditLog', AuditLogSchema);
export const Idempotency = mongoose.model('Idempotency', IdempotencySchema);
export const DripLog = mongoose.model('DripLog', DripLogSchema);
export const Cursor = mongoose.model('Cursor', CursorSchema);
export const LabState = mongoose.model('LabState', LabStateSchema);

export type MerchantDoc = InferSchemaType<typeof MerchantSchema>;
export type InvoiceDoc = InferSchemaType<typeof InvoiceSchema>;
export type IntentDoc = InferSchemaType<typeof IntentSchema> & { _id: mongoose.Types.ObjectId };

export async function audit(actor: string, action: string, chainId: number | null, ref: string, data: unknown) {
  await AuditLog.create({ actor, action, chainId, ref, data });
}
```

**File: `services/api/src/db/connect.ts`**

```ts
import mongoose from 'mongoose';
import { log } from '../log';

export async function connectDb(uri: string) {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  await mongoose.connection.syncIndexes();
  log.info({ db: mongoose.connection.name }, 'mongo connected');
}

export const dbUp = () => mongoose.connection.readyState === 1;
```

**Exit checks**
- [ ] Typecheck passes
- [ ] (after B6) collections + indexes visible in Mongo after first boot

**Commit:** `feat(api): mongo models + indexes`

---

### Phase B5 — Errors: `ApiError` + chain error decoding

**Goal:** one error type for the whole service and a decoder that turns any viem error into an ICD error code.
**Time:** 40 min. **Depends on:** B2, B3.

**File: `services/api/src/errors.ts`**

```ts
import { BaseError, ContractFunctionRevertedError, decodeErrorResult, type Abi, type Hex } from 'viem';
import { API_ERROR, CONTRACT_ERROR_TO_CODE, REVERT_STRING_RULES, type ApiErrorCode } from '@scanpay/shared';

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly http: number;
  readonly details?: unknown;
  readonly errorName?: string;

  constructor(code: ApiErrorCode, message?: string, details?: unknown, errorName?: string) {
    super(message ?? API_ERROR[code].message);
    this.code = code;
    this.http = API_ERROR[code].http;
    this.details = details;
    this.errorName = errorName;
  }
}

export const notFound = (code: ApiErrorCode = 'NOT_FOUND', msg?: string) => new ApiError(code, msg);

/** Lazily bound to avoid an import cycle with relayer.ts */
let decodeAbi: Abi | null = null;
export function setDecodeAbi(abi: Abi) {
  decodeAbi = abi;
}

/** Turn anything thrown by viem (simulate/estimate/write) into an ApiError with the Solidity error name. */
export function decodeChainError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof BaseError) {
    const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (reverted) {
      const name = reverted.data?.errorName;
      if (name && name !== 'Error') {
        const code = CONTRACT_ERROR_TO_CODE[name] ?? 'CHAIN_REVERT';
        return new ApiError(code, undefined, { args: stringifyArgs(reverted.data?.args) }, name);
      }
      const reason = reverted.reason ?? (reverted.data?.args?.[0] as string | undefined);
      if (reason) {
        for (const [re, code] of REVERT_STRING_RULES) if (re.test(reason)) return new ApiError(code, undefined, { reason }, 'Error');
        return new ApiError('CHAIN_REVERT', undefined, { reason }, 'Error');
      }
      // Unknown selector: try our full ABI on the raw data
      const raw = (reverted as unknown as { raw?: Hex }).raw ?? (reverted.cause as { data?: Hex } | undefined)?.data;
      if (raw && decodeAbi) {
        try {
          const d = decodeErrorResult({ abi: decodeAbi, data: raw });
          const code = CONTRACT_ERROR_TO_CODE[d.errorName] ?? 'CHAIN_REVERT';
          return new ApiError(code, undefined, { args: stringifyArgs(d.args) }, d.errorName);
        } catch {
          /* fall through */
        }
      }
    }
    return new ApiError('CHAIN_REVERT', undefined, { shortMessage: e.shortMessage });
  }
  return new ApiError('INTERNAL', undefined, { message: (e as Error)?.message });
}

function stringifyArgs(args: unknown): unknown {
  if (!args) return undefined;
  return JSON.parse(JSON.stringify(args, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}
```

Add one line to `relayer.ts` after `DECODE_ABI` is defined:

```ts
import { setDecodeAbi } from './errors';
setDecodeAbi(DECODE_ABI);
```

**File: `services/api/test/unit/errors.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { BaseError, ContractFunctionRevertedError, encodeErrorResult } from 'viem';
import { intentVaultAbi } from '@scanpay/shared';
import { decodeChainError } from '../../src/errors';
import { DECODE_ABI } from '../../src/relayer';

function revert(errorName: string, args: unknown[]) {
  const data = encodeErrorResult({ abi: DECODE_ABI, errorName, args } as never);
  return new BaseError('x', { cause: new ContractFunctionRevertedError({ abi: DECODE_ABI, data, functionName: 'payDirect' }) });
}

describe('decodeChainError', () => {
  it('maps NonceAlreadyUsed -> REPLAY_BLOCKED (409)', () => {
    const e = decodeChainError(revert('NonceAlreadyUsed', ['0x0000000000000000000000000000000000000001', 5n]));
    expect(e.code).toBe('REPLAY_BLOCKED');
    expect(e.http).toBe(409);
    expect(e.errorName).toBe('NonceAlreadyUsed');
  });
  it('maps EnforcedPause -> PAUSED', () => {
    expect(decodeChainError(revert('EnforcedPause', [])).code).toBe('PAUSED');
  });
  it('maps mock-token InvalidAuthorizationSignature -> TOKEN_AUTHORIZATION_FAILED', () => {
    expect(decodeChainError(revert('InvalidAuthorizationSignature', [])).code).toBe('TOKEN_AUTHORIZATION_FAILED');
  });
  it('maps Error(string) FiatToken reason', () => {
    const data = encodeErrorResult({
      abi: [{ type: 'error', name: 'Error', inputs: [{ name: 'message', type: 'string' }] }],
      errorName: 'Error', args: ['FiatTokenV2: invalid signature'],
    });
    const err = new BaseError('x', { cause: new ContractFunctionRevertedError({ abi: intentVaultAbi, data, functionName: 'payDirect' }) });
    expect(decodeChainError(err).code).toBe('TOKEN_AUTHORIZATION_FAILED');
  });
});
```

**Exit checks**
- [ ] `pnpm --filter @scanpay/api test` → 4 passed

**Commit:** `feat(api): ApiError + chain revert decoding to ICD codes`

---

### Phase B6 — Fastify app, plugins, `/health`, `/v1/config`

**Goal:** the HTTP server with request ids, CORS, rate limits, a single error handler, an idempotency helper, a
`parse()` helper for zod, and the first two endpoints. **Time:** 60 min. **Depends on:** B3–B5.

**File: `services/api/src/http/parse.ts`**

```ts
import type { ZodTypeAny, z } from 'zod';
import { ApiError } from '../errors';

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new ApiError('VALIDATION_ERROR', undefined, r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return r.data;
}
```

**File: `services/api/src/http/idempotency.ts`**

```ts
import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Idempotency } from '../db/models';
import { ApiError } from '../errors';

/**
 * Wrap a POST handler: same Idempotency-Key + same body -> same response (even after a crash mid-way the client
 * gets 409 IDEMPOTENCY_CONFLICT while IN_PROGRESS). Same key + different body -> 409.
 */
export async function withIdempotency<T>(
  req: FastifyRequest,
  reply: FastifyReply,
  required: boolean,
  handler: () => Promise<T>,
): Promise<T | undefined> {
  const key = req.headers['idempotency-key'];
  if (!key || Array.isArray(key)) {
    if (required) throw new ApiError('VALIDATION_ERROR', 'Idempotency-Key header is required');
    return handler();
  }
  const requestHash = createHash('sha256').update(JSON.stringify(req.body ?? {})).digest('hex');
  try {
    await Idempotency.create({ key, route: req.routeOptions.url, requestHash });
  } catch {
    const existing = await Idempotency.findOne({ key }).lean();
    if (!existing || existing.requestHash !== requestHash) throw new ApiError('IDEMPOTENCY_CONFLICT', 'Idempotency-Key reused with a different body');
    if (existing.state === 'IN_PROGRESS') throw new ApiError('IDEMPOTENCY_CONFLICT');
    reply.code(existing.statusCode ?? 200);
    return existing.response as T;
  }
  try {
    const res = await handler();
    await Idempotency.updateOne({ key }, { state: 'DONE', statusCode: reply.statusCode || 200, response: res });
    return res;
  } catch (e) {
    await Idempotency.deleteOne({ key }); // allow a clean retry after a failure
    throw e;
  }
}
```

**File: `services/api/src/http/auth.ts`**

```ts
import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { ApiError } from '../errors';

let adminToken = '';
export const setAdminToken = (t: string) => (adminToken = t);

export function requireAdmin(req: FastifyRequest) {
  const h = req.headers.authorization ?? '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  const a = Buffer.from(token);
  const b = Buffer.from(adminToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ApiError('UNAUTHORIZED');
}
```

**File: `services/api/src/http/app.ts`**

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { ApiError, decodeChainError } from '../errors';
import type { Env } from '../env';
import { log } from '../log';
import { setAdminToken } from './auth';
import { healthRoutes } from './routes/health';
import { configRoutes } from './routes/config';

export async function buildApp(env: Env): Promise<FastifyInstance> {
  setAdminToken(env.ADMIN_TOKEN);
  const app = Fastify({
    loggerInstance: log,
    genReqId: () => randomUUID(),
    trustProxy: true,
    bodyLimit: 256 * 1024,
  });

  await app.register(cors, {
    origin: env.CORS_ORIGINS.split(',').map((s) => s.trim()),
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'idempotency-key'],
  });
  await app.register(rateLimit, { max: 240, timeWindow: '1 minute' });

  app.setErrorHandler((err, req, reply) => {
    let e: ApiError;
    if (err instanceof ApiError) e = err;
    else if ((err as { statusCode?: number }).statusCode === 429) e = new ApiError('RATE_LIMITED');
    else if ((err as { apiCode?: string }).apiCode === 'CHAIN_NOT_ENABLED') e = new ApiError('CHAIN_NOT_ENABLED');
    else if ((err as { validation?: unknown }).validation) e = new ApiError('VALIDATION_ERROR', err.message);
    else e = decodeChainError(err);
    if (e.http >= 500) req.log.error({ err }, 'request failed');
    reply.code(e.http).send({
      error: {
        code: e.code,
        message: e.message,
        details: e.errorName ? { errorName: e.errorName, ...(e.details as object) } : e.details,
        requestId: req.id,
      },
    });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found', requestId: req.id } }),
  );

  await app.register(healthRoutes);
  await app.register(configRoutes, { env });
  // later phases register more route plugins here (see B7..B27)
  return app;
}
```

**File: `services/api/src/http/routes/health.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import { allChains } from '../../chains';
import { dbUp } from '../../db/connect';

const started = Date.now();

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async () => {
    const chains = await Promise.all(
      allChains().map(async (c) => {
        const [block, bal] = await Promise.allSettled([c.public.getBlockNumber(), c.public.getBalance({ address: c.operator.address })]);
        return {
          chainId: c.chainId,
          block: block.status === 'fulfilled' ? block.value.toString() : null,
          operator: c.operator.address.toLowerCase(),
          operatorBalance: bal.status === 'fulfilled' ? bal.value.toString() : null,
        };
      }),
    );
    return { ok: dbUp() && chains.every((c) => c.block !== null), version: process.env.RAILWAY_GIT_COMMIT_SHA ?? 'dev', uptimeSec: Math.round((Date.now() - started) / 1000), mongo: dbUp() ? 'up' : 'down', chains };
  });
}
```

**File: `services/api/src/http/routes/config.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import { ICD_VERSION, type ConfigRes } from '@scanpay/shared';
import { allChains } from '../../chains';
import type { Env } from '../../env';

export async function configRoutes(app: FastifyInstance, opts: { env: Env }) {
  app.get('/v1/config', async (): Promise<ConfigRes> => ({
    icdVersion: ICD_VERSION,
    publicAppUrl: opts.env.PUBLIC_APP_URL,
    chains: allChains().map((c) => ({ chainId: c.chainId, deployment: c.deployment, features: c.features })),
  }));
}
```

**File: `services/api/src/index.ts`** (replace)

```ts
import { loadEnv } from './env';
import { log } from './log';
import { initChains } from './chains';
import { connectDb } from './db/connect';
import { buildApp } from './http/app';

const env = loadEnv();
initChains(env);
await connectDb(env.MONGODB_URI);
const app = await buildApp(env);
await app.listen({ port: env.PORT, host: '0.0.0.0' });
log.info({ port: env.PORT, chains: env.ENABLED_CHAINS }, 'scanpay api listening');
// B20 starts the worker here: startWorker(env)

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    log.info({ sig }, 'shutting down');
    await app.close();
    process.exit(0);
  });
}
```

**Commands**

```bash
pnpm chain:local                                  # terminal 1 (from I1)
cd services/api && pnpm dev                       # terminal 2
curl -s localhost:8787/health | jq
curl -s localhost:8787/v1/config | jq '.chains[0].features, .chains[0].deployment.contracts'
curl -s localhost:8787/nope | jq
```

**Exit checks**
- [ ] `/health` → `ok: true`, chain 31337 block number, operator balance
- [ ] `/v1/config` → features `{direct:true, swap:true, crosschain:"simulated", faucet:true, attackLab:true, indexer:false}`
- [ ] Unknown route → `{"error":{"code":"NOT_FOUND",…,"requestId":…}}`

**Commit:** `feat(api): fastify app, error handler, idempotency, health, config`

---

### Phase B7 — Event bus, views, FX

**Goal:** three small building blocks used by every later phase: an in-process event bus (feeds SSE), view
builders (DB/chain → API shapes), and the USD→fiat rate for display. **Time:** 45 min. **Depends on:** B6.

**File: `services/api/src/bus.ts`**

```ts
import { EventEmitter } from 'node:events';
import type { SseEvent } from '@scanpay/shared';

/** In-process pub/sub. API and worker run in ONE process (ICD §0.1), so no Redis is needed. */
const emitter = new EventEmitter();
emitter.setMaxListeners(1000);

export const channel = {
  merchant: (chainId: number, merchantId: string) => `merchant:${chainId}:${merchantId.toLowerCase()}`,
  intent: (chainId: number, intentId: string) => `intent:${chainId}:${intentId.toLowerCase()}`,
  invoice: (shortCode: string) => `invoice:${shortCode}`,
  request: (requestId: string) => `request:${requestId}`,
};

export function publish(ch: string, ev: SseEvent) {
  emitter.emit(ch, ev);
}

export function subscribe(ch: string, fn: (ev: SseEvent) => void): () => void {
  emitter.on(ch, fn);
  return () => emitter.off(ch, fn);
}
```

**File: `services/api/src/util/time.ts`**

```ts
export const nowSec = () => Math.floor(Date.now() / 1000);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
```

**File: `services/api/src/util/ids.ts`**

```ts
import { randomBytes } from 'node:crypto';

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o/1/l/i — readable aloud

export function shortCode(len = 10): string {
  const bytes = randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

export const newId = (prefix: string) => `${prefix}_${randomBytes(12).toString('hex')}`;
```

**File: `services/api/src/services/views.ts`**

```ts
import type { Hex } from 'viem';
import {
  merchantRegistryAbi, intentVaultAbi, profileHash, MERCHANT_STATUS_NAME, INVOICE_STATE,
  type MerchantRecord, type MerchantView, type InvoiceView, type IntentView, type PaymentView, type Profile,
} from '@scanpay/shared';
import type { ChainCtx } from '../chains';
import { Invoice, Merchant, type IntentDoc } from '../db/models';
import { nowSec } from '../util/time';

export async function readMerchant(ctx: ChainCtx, merchantId: Hex): Promise<MerchantRecord> {
  return (await ctx.public.readContract({
    address: ctx.registry,
    abi: merchantRegistryAbi,
    functionName: 'getMerchant',
    args: [merchantId],
  })) as MerchantRecord;
}

/** Chain is authoritative for keys/status; Mongo adds the off-chain profile (verified against metadataHash). */
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
    status: MERCHANT_STATUS_NAME[Number(m.status)],
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

export async function invoiceView(ctx: ChainCtx, doc: InstanceType<typeof Invoice> | Record<string, any>): Promise<InvoiceView> {
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
```

**File: `services/api/src/services/fx.ts`**

```ts
import { ApiError } from '../errors';

type Rate = { rate: number; asOf: string; source: string; fetchedAt: number };
const cache = new Map<string, Rate>();
const TTL_MS = 10 * 60 * 1000;

async function fetchJson(url: string) {
  const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.json() as Promise<any>;
}

/** USD -> quote currency, for DISPLAY ONLY (amounts on-chain are always token units). */
export async function usdTo(quote: string) {
  const q = quote.toUpperCase();
  if (!/^[A-Z]{3}$/.test(q)) throw new ApiError('VALIDATION_ERROR', 'quote must be a 3-letter currency code');
  if (q === 'USD') return { base: 'USD' as const, quote: q, rate: 1, asOf: new Date().toISOString(), source: 'identity', stale: false };
  const hit = cache.get(q);
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) return { base: 'USD' as const, quote: q, ...pick(hit), stale: false };
  try {
    const j = await fetchJson(`https://api.frankfurter.app/latest?from=USD&to=${q}`);
    const rate = Number(j.rates?.[q]);
    if (!rate) throw new Error('no rate');
    const v = { rate, asOf: String(j.date), source: 'frankfurter (ECB)', fetchedAt: Date.now() };
    cache.set(q, v);
    return { base: 'USD' as const, quote: q, ...pick(v), stale: false };
  } catch {
    try {
      const j = await fetchJson('https://open.er-api.com/v6/latest/USD');
      const rate = Number(j.rates?.[q]);
      if (!rate) throw new Error('no rate');
      const v = { rate, asOf: String(j.time_last_update_utc), source: 'open.er-api.com', fetchedAt: Date.now() };
      cache.set(q, v);
      return { base: 'USD' as const, quote: q, ...pick(v), stale: false };
    } catch {
      if (hit) return { base: 'USD' as const, quote: q, ...pick(hit), stale: true };
      throw new ApiError('PROVIDER_UNAVAILABLE', 'FX rate unavailable');
    }
  }
}

const pick = (r: Rate) => ({ rate: r.rate, asOf: r.asOf, source: r.source });
```

**File: `services/api/src/http/routes/fx.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import { usdTo } from '../../services/fx';

export async function fxRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { quote?: string } }>('/v1/fx', async (req) => usdTo(req.query.quote ?? 'INR'));
}
```

Register in `app.ts`: `await app.register(fxRoutes);`

**Commands / Exit checks**
- [ ] `curl -s 'localhost:8787/v1/fx?quote=INR' | jq` → `rate` ≈ 83–90, `stale: false`
- [ ] `curl -s 'localhost:8787/v1/fx?quote=EUR' | jq .rate` → < 1
- [ ] Typecheck passes

**Commit:** `feat(api): event bus, view builders, FX endpoint`

---

### Phase B8 — Merchant registration (relayed, dual signature)

**Goal:** `POST /v1/merchants/register` — verify both signatures and the profile hash off-chain, relay
`registerMerchant`, store the profile, and (testnet/local only) auto-approve. **Time:** 60 min. **Depends on:** B7.

Verifier policy (state it in the README trust model):
- **local / testnet:** the operator auto-approves right after registration, so judges can try the merchant flow alone.
- **mainnet:** merchants stay `PENDING` until an admin approves via `/v1/admin/...` (FE admin page).

**File: `services/api/src/services/merchants.ts`**

```ts
import type { Hex } from 'viem';
import {
  buildPayoutUpdateTypedData, buildRegistrationTypedData, buildSignerRotationTypedData, computeMerchantId,
  fromWirePayoutUpdate, fromWireRegistration, fromWireSignerRotation, merchantRegistryAbi, profileHash,
  MERCHANT_STATUS, MERCHANT_STATUS_NAME, type Profile,
} from '@scanpay/shared';
import { z } from 'zod';
import type { zPayoutReq, zRegisterReq, zRotateReq } from '@scanpay/shared';
import type { ChainCtx } from '../chains';
import { audit, Merchant } from '../db/models';
import { ApiError } from '../errors';
import { relay } from '../relayer';
import { nowSec } from '../util/time';
import { merchantView, readMerchant } from './views';
import { channel, publish } from '../bus';

async function ownerNonce(ctx: ChainCtx, owner: Hex): Promise<bigint> {
  return (await ctx.public.readContract({
    address: ctx.registry, abi: merchantRegistryAbi, functionName: 'ownerNonce', args: [owner],
  })) as bigint;
}

async function verify(ctx: ChainCtx, address: Hex, typedData: any, signature: Hex): Promise<boolean> {
  // publicClient.verifyTypedData handles EOAs AND ERC-1271/6492 smart accounts
  return ctx.public.verifyTypedData({ address, signature, ...typedData });
}

export async function registerMerchant(ctx: ChainCtx, req: z.infer<typeof zRegisterReq>) {
  const reg = fromWireRegistration(req.registration);
  if (profileHash(req.profile).toLowerCase() !== reg.metadataHash.toLowerCase()) throw new ApiError('PROFILE_HASH_MISMATCH');
  if (reg.deadline < BigInt(nowSec())) throw new ApiError('SIGNATURE_EXPIRED');
  if (!ctx.tokenByAddress(reg.payoutToken)?.token.roles.includes('payout')) throw new ApiError('PAYOUT_TOKEN_NOT_ALLOWED');
  const expected = await ownerNonce(ctx, reg.owner);
  if (expected !== reg.nonce) throw new ApiError('BAD_NONCE', undefined, { expected: expected.toString() });

  const td = buildRegistrationTypedData(ctx.chainId, ctx.registry, reg);
  if (!(await verify(ctx, reg.owner, td, req.ownerSig))) throw new ApiError('INVALID_OWNER_SIGNATURE');
  if (!(await verify(ctx, reg.payoutWallet, td, req.payoutSig))) throw new ApiError('INVALID_PAYOUT_SIGNATURE');

  const merchantId = computeMerchantId(reg.owner, reg.salt).toLowerCase() as Hex;
  const { hash, receipt } = await relay(ctx, {
    address: ctx.registry, abi: merchantRegistryAbi, functionName: 'registerMerchant',
    args: [reg, req.ownerSig, req.payoutSig], label: 'registerMerchant',
  });
  const block = await ctx.public.getBlock({ blockNumber: receipt.blockNumber });

  await Merchant.updateOne(
    { chainId: ctx.chainId, merchantId },
    {
      $set: {
        owner: reg.owner.toLowerCase(), salt: reg.salt.toLowerCase(), payoutWallet: reg.payoutWallet.toLowerCase(),
        invoiceSigner: reg.invoiceSigner.toLowerCase(), payoutToken: reg.payoutToken.toLowerCase(), keyVersion: 1,
        status: 'PENDING', metadataHash: reg.metadataHash.toLowerCase(), profile: req.profile as Profile,
        registeredAt: Number(block.timestamp), registeredTx: hash,
      },
    },
    { upsert: true },
  );
  await audit('relayer', 'merchant.register', ctx.chainId, merchantId, { txHash: hash, owner: reg.owner });

  let approveTxHash: Hex | null = null;
  let status: (typeof MERCHANT_STATUS_NAME)[number] = 'PENDING';
  if (!ctx.isMainnet) {
    const r = await setStatus(ctx, merchantId, MERCHANT_STATUS.ACTIVE, 'auto-approve (testnet policy)');
    approveTxHash = r.txHash;
    status = 'ACTIVE';
  }
  return { merchantId, txHash: hash, status, autoApproved: !ctx.isMainnet, approveTxHash };
}

export async function setStatus(ctx: ChainCtx, merchantId: Hex, newStatus: number, reason: string) {
  const { hash } = await relay(ctx, {
    address: ctx.registry, abi: merchantRegistryAbi, functionName: 'setMerchantStatus',
    args: [merchantId, newStatus], label: `setMerchantStatus(${newStatus})`,
  });
  const name = MERCHANT_STATUS_NAME[newStatus];
  await Merchant.updateOne({ chainId: ctx.chainId, merchantId: merchantId.toLowerCase() }, { $set: { status: name } });
  await audit('admin', 'merchant.status', ctx.chainId, merchantId, { txHash: hash, status: name, reason });
  const view = await merchantView(ctx, merchantId);
  if (view) publish(channel.merchant(ctx.chainId, merchantId), { type: 'merchant.updated', merchant: view });
  return { txHash: hash, status: name };
}

export async function rotateSigner(ctx: ChainCtx, req: z.infer<typeof zRotateReq>) {
  const r = fromWireSignerRotation(req.rotation);
  const m = await readMerchant(ctx, r.merchantId);
  if (m.status === 0) throw new ApiError('MERCHANT_NOT_FOUND');
  if (m.status === MERCHANT_STATUS.REVOKED) throw new ApiError('MERCHANT_REVOKED');
  const expected = await ownerNonce(ctx, m.owner);
  if (expected !== r.nonce) throw new ApiError('BAD_NONCE', undefined, { expected: expected.toString() });
  const td = buildSignerRotationTypedData(ctx.chainId, ctx.registry, r);
  if (!(await verify(ctx, m.owner, td, req.ownerSig))) throw new ApiError('INVALID_OWNER_SIGNATURE');

  const { hash } = await relay(ctx, {
    address: ctx.registry, abi: merchantRegistryAbi, functionName: 'rotateInvoiceSigner',
    args: [r, req.ownerSig], label: 'rotateInvoiceSigner',
  });
  const after = await readMerchant(ctx, r.merchantId);
  await Merchant.updateOne(
    { chainId: ctx.chainId, merchantId: r.merchantId.toLowerCase() },
    { $set: { invoiceSigner: r.newSigner.toLowerCase(), keyVersion: Number(after.keyVersion) } },
  );
  await audit('relayer', 'merchant.rotate', ctx.chainId, r.merchantId, { txHash: hash, keyVersion: Number(after.keyVersion) });
  return { merchantId: r.merchantId.toLowerCase() as Hex, txHash: hash, keyVersion: Number(after.keyVersion) };
}

export async function updatePayout(ctx: ChainCtx, req: z.infer<typeof zPayoutReq>) {
  const u = fromWirePayoutUpdate(req.update);
  const m = await readMerchant(ctx, u.merchantId);
  if (m.status === 0) throw new ApiError('MERCHANT_NOT_FOUND');
  if (m.status === MERCHANT_STATUS.REVOKED) throw new ApiError('MERCHANT_REVOKED');
  const expected = await ownerNonce(ctx, m.owner);
  if (expected !== u.nonce) throw new ApiError('BAD_NONCE', undefined, { expected: expected.toString() });
  const td = buildPayoutUpdateTypedData(ctx.chainId, ctx.registry, u);
  if (!(await verify(ctx, m.owner, td, req.ownerSig))) throw new ApiError('INVALID_OWNER_SIGNATURE');
  if (!(await verify(ctx, u.payoutWallet, td, req.payoutSig))) throw new ApiError('INVALID_PAYOUT_SIGNATURE');

  const { hash } = await relay(ctx, {
    address: ctx.registry, abi: merchantRegistryAbi, functionName: 'updatePayout',
    args: [u, req.ownerSig, req.payoutSig], label: 'updatePayout',
  });
  const after = await readMerchant(ctx, u.merchantId);
  await Merchant.updateOne(
    { chainId: ctx.chainId, merchantId: u.merchantId.toLowerCase() },
    { $set: { payoutWallet: u.payoutWallet.toLowerCase(), payoutToken: u.payoutToken.toLowerCase(), keyVersion: Number(after.keyVersion) } },
  );
  await audit('relayer', 'merchant.payout', ctx.chainId, u.merchantId, { txHash: hash });
  return { merchantId: u.merchantId.toLowerCase() as Hex, txHash: hash, keyVersion: Number(after.keyVersion) };
}
```

> The payout-token line is a fast pre-check against `deployments.tokens[*].roles`; the authoritative check is the
> registry's `PayoutTokenNotAllowed` revert (surfaced by `simulate`).

**File: `services/api/src/http/routes/merchants.ts`** (B8 part; B10/B11 add to this file)

```ts
import type { FastifyInstance } from 'fastify';
import { zRegisterReq, zRotateReq, zPayoutReq } from '@scanpay/shared';
import { chainCtx } from '../../chains';
import { parse } from '../parse';
import { withIdempotency } from '../idempotency';
import { registerMerchant, rotateSigner, updatePayout } from '../../services/merchants';

export async function merchantRoutes(app: FastifyInstance) {
  app.post('/v1/merchants/register', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) =>
    withIdempotency(req, reply, false, async () => {
      const body = parse(zRegisterReq, req.body);
      return registerMerchant(chainCtx(body.chainId), body);
    }),
  );

  app.post('/v1/merchants/rotate-signer', async (req, reply) =>
    withIdempotency(req, reply, false, async () => {
      const body = parse(zRotateReq, req.body);
      return rotateSigner(chainCtx(body.chainId), body);
    }),
  );

  app.post('/v1/merchants/update-payout', async (req, reply) =>
    withIdempotency(req, reply, false, async () => {
      const body = parse(zPayoutReq, req.body);
      return updatePayout(chainCtx(body.chainId), body);
    }),
  );
}
```

Register in `app.ts`: `await app.register(merchantRoutes);`

**Test it with a script instead of curl** (signatures are needed) — **File: `services/api/scripts/dev-register.ts`**:

```ts
// tsx --env-file=../../.env scripts/dev-register.ts 31337
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { buildRegistrationTypedData, getDeployment, getToken, profileHash, randomBytes32, toWireRegistration } from '@scanpay/shared';

const chainId = Number(process.argv[2] ?? 31337);
const api = process.env.API ?? 'http://localhost:8787';
const d = getDeployment(chainId);
const owner = privateKeyToAccount(generatePrivateKey());
const payout = privateKeyToAccount(generatePrivateKey());
const signer = privateKeyToAccount(generatePrivateKey());
const profile = { displayName: 'Dev Cafe', category: 'food', city: 'Chennai', country: 'IN', logoUrl: '' };
const reg = {
  owner: owner.address, salt: randomBytes32(), payoutWallet: payout.address, invoiceSigner: signer.address,
  payoutToken: getToken(chainId, 'USDC').address, metadataHash: profileHash(profile), nonce: 0n,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
};
const td = buildRegistrationTypedData(chainId, d.contracts.MerchantRegistry.address, reg);
const res = await fetch(`${api}/v1/merchants/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    chainId, registration: toWireRegistration(reg), profile,
    ownerSig: await owner.signTypedData(td), payoutSig: await payout.signTypedData(td),
  }),
});
console.log(res.status, await res.json());
console.log('SIGNER_PK (keep for dev-invoice):', '(regenerate per run)');
```

**Exit checks**
- [ ] `dev-register.ts 31337` → `200 {merchantId, txHash, status:"ACTIVE", autoApproved:true, approveTxHash}`
- [ ] Changing one profile field after hashing → `422 PROFILE_HASH_MISMATCH`
- [ ] Signing payout with the owner key → `422 INVALID_PAYOUT_SIGNATURE` (off-chain pre-check)
- [ ] Mongo `merchants` has the doc with `profile.displayName = "Dev Cafe"`

**Commit:** `feat(api): relayed merchant registration with dual-signature + profile hash checks`

---

### Phase B9 — Admin (verifier) endpoints

**Goal:** list pending merchants and approve / suspend / revoke / reactivate them (FE admin page). **Time:** 30 min.
**Depends on:** B8.

**File: `services/api/src/http/routes/admin.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Hex } from 'viem';
import { zBytes32, zChainId, MERCHANT_STATUS } from '@scanpay/shared';
import { chainCtx } from '../../chains';
import { Merchant } from '../../db/models';
import { requireAdmin } from '../auth';
import { parse } from '../parse';
import { setStatus } from '../../services/merchants';
import { merchantView } from '../../services/views';

const ACTIONS = { approve: MERCHANT_STATUS.ACTIVE, reactivate: MERCHANT_STATUS.ACTIVE, suspend: MERCHANT_STATUS.SUSPENDED, revoke: MERCHANT_STATUS.REVOKED } as const;

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req) => {
    if (req.url.startsWith('/v1/admin')) requireAdmin(req);
  });

  app.get('/v1/admin/merchants', async (req) => {
    const q = parse(z.object({ chainId: zChainId, status: z.string().optional() }), req.query);
    const docs = await Merchant.find({ chainId: q.chainId, ...(q.status ? { status: q.status } : {}) })
      .sort({ createdAt: -1 }).limit(200).lean();
    const ctx = chainCtx(q.chainId);
    const merchants = (await Promise.all(docs.map((d) => merchantView(ctx, d.merchantId as Hex)))).filter(Boolean);
    return { merchants };
  });

  app.post('/v1/admin/merchants/:chainId/:merchantId/:action', async (req) => {
    const p = parse(
      z.object({ chainId: zChainId, merchantId: zBytes32, action: z.enum(['approve', 'reactivate', 'suspend', 'revoke']) }),
      req.params,
    );
    return setStatus(chainCtx(p.chainId), p.merchantId, ACTIONS[p.action], `admin:${p.action}`);
  });
}
```

Register in `app.ts`: `await app.register(adminRoutes);`

**Commands**

```bash
curl -s -X POST localhost:8787/v1/admin/merchants/31337/<merchantId>/suspend -H "authorization: Bearer $ADMIN_TOKEN" | jq
curl -s -X POST localhost:8787/v1/admin/merchants/31337/<merchantId>/suspend -H "authorization: Bearer $ADMIN_TOKEN" | jq   # 409 INVALID_STATUS_TRANSITION
curl -s localhost:8787/v1/admin/merchants?chainId=31337 | jq   # 401
```

**Exit checks**
- [ ] Suspend → `{txHash, status:"SUSPENDED"}`; second suspend → `409 INVALID_STATUS_TRANSITION` (decoded from simulate)
- [ ] Missing/wrong bearer → `401 UNAUTHORIZED`

**Commit:** `feat(api): admin verifier endpoints`

---

### Phase B10 — Key rotation + payout update endpoints

Already implemented in `services/merchants.ts` (B8) and routed in `routes/merchants.ts`. This phase is the test.
**Time:** 20 min. **Depends on:** B8.

**File: `services/api/scripts/dev-rotate.ts`**

```ts
// Registers a merchant, then rotates its invoice key and prints keyVersion 1 -> 2.
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  buildRegistrationTypedData, buildSignerRotationTypedData, getDeployment, getToken, profileHash, randomBytes32,
  toWireRegistration, toWireSignerRotation, computeMerchantId,
} from '@scanpay/shared';

const chainId = Number(process.argv[2] ?? 31337);
const api = process.env.API ?? 'http://localhost:8787';
const reg_ = getDeployment(chainId).contracts.MerchantRegistry.address;
const owner = privateKeyToAccount(generatePrivateKey());
const payout = privateKeyToAccount(generatePrivateKey());
const profile = { displayName: 'Rotate Cafe', category: 'food', city: 'Pune', country: 'IN', logoUrl: '' };
const post = async (path: string, body: unknown) => {
  const r = await fetch(`${api}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const reg = {
  owner: owner.address, salt: randomBytes32(), payoutWallet: payout.address,
  invoiceSigner: privateKeyToAccount(generatePrivateKey()).address, payoutToken: getToken(chainId, 'USDC').address,
  metadataHash: profileHash(profile), nonce: 0n, deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
};
const td = buildRegistrationTypedData(chainId, reg_, reg);
console.log(await post('/v1/merchants/register', {
  chainId, registration: toWireRegistration(reg), profile,
  ownerSig: await owner.signTypedData(td), payoutSig: await payout.signTypedData(td),
}));
const rot = {
  merchantId: computeMerchantId(owner.address, reg.salt), newSigner: privateKeyToAccount(generatePrivateKey()).address,
  nonce: 1n, deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
};
console.log(await post('/v1/merchants/rotate-signer', {
  chainId, rotation: toWireSignerRotation(rot), ownerSig: await owner.signTypedData(buildSignerRotationTypedData(chainId, reg_, rot)),
}));
```

**Exit checks**
- [ ] Output shows `keyVersion: 2`
- [ ] Re-sending the same rotation → `409 BAD_NONCE` with `details.expected = "2"`

**Commit:** `test(api): dev scripts for registration and key rotation`

---

### Phase B11 — Merchant reads + Envio client

**Goal:** merchant profile, by-owner list, payments, stats, key history — **Envio first, Mongo fallback**.
**Time:** 75 min. **Depends on:** B8 (I3 for Envio; works without it).

**File: `services/api/src/services/envio.ts`**

```ts
import type { Hex } from 'viem';
import { log } from '../log';

let url: string | undefined;
export const setEnvioUrl = (u?: string) => (url = u);
export const envioEnabled = () => Boolean(url);

export async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  if (!url) throw new Error('envio disabled');
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(6000),
  });
  const j = (await r.json()) as { data?: T; errors?: { message: string }[] };
  if (!r.ok || j.errors?.length) {
    log.warn({ status: r.status, errors: j.errors }, 'envio query failed');
    throw new Error(j.errors?.[0]?.message ?? `envio ${r.status}`);
  }
  return j.data!;
}

export const eid = (chainId: number, hex: string) => `${chainId}_${hex.toLowerCase()}`;

// ---- Backend A §A21 "GraphQL contract for Backend B" (Q1–Q6). Keep in sync. ----
export const Q1_MERCHANT = /* GraphQL */ `
query Merchant($id: String!) { Merchant(where: { id: { _eq: $id } }) {
  id chainId merchantId owner payoutWallet invoiceSigner payoutToken metadataHash status statusName keyVersion
  registeredAt registeredTx updatedAt paymentCount settledVolume netReceived feesPaid } }`;

export const Q2_MERCHANT_INTENTS = /* GraphQL */ `
query MerchantIntents($chainId: Int!, $merchantId: String!, $limit: Int!, $offset: Int!) {
  Intent(where: { chainId: { _eq: $chainId }, merchantId: { _eq: $merchantId } },
         order_by: { committedAt: desc }, limit: $limit, offset: $offset) {
    id intentId payer invoiceId route routeName status inputToken payoutToken amountOut fee netToMerchant
    inputAmount excessRefunded forwarder committedAt committedTx settledAt settledTx refundedAt refundTx
    sourceChainId sourceTxHash } }`;

export const Q3_INTENT = /* GraphQL */ `
query IntentById($id: String!) { Intent(where: { id: { _eq: $id } }) {
  id chainId intentId merchantId payer invoiceId route routeName status inputToken payoutToken amountOut fee
  netToMerchant inputAmount excessRefunded forwarder payoutWallet expiresAt quoteHash committedAt committedTx
  committedBlock settledAt settledTx settledBlock refundedAt refundTx refundTo refundAmount rescuedAmount
  sourceChainId sourceTxHash providerRef attester attestedTx
  merchant { merchantId status statusName keyVersion payoutWallet owner } } }`;

export const Q4_DAILY = /* GraphQL */ `
query MerchantDaily($chainId: Int!, $merchantId: String!, $since: numeric!) {
  MerchantDailyStat(where: { chainId: { _eq: $chainId }, merchantId: { _eq: $merchantId }, dayStart: { _gte: $since } },
                    order_by: { dayStart: asc }) { dayStart payments volume net } }`;

export const Q5_KEYS = /* GraphQL */ `
query MerchantKeys($id: String!) { MerchantKeyEvent(where: { merchant_id: { _eq: $id } }, order_by: { timestamp: asc }) {
  kind keyVersion invoiceSigner payoutWallet payoutToken fromStatus toStatus by timestamp txHash } }`;

export const Q6_STATS = /* GraphQL */ `
query Stats($chainId: String!) { ProtocolStat(where: { id: { _eq: $chainId } }) {
  merchants activeMerchants intents settled refunded volume fees crossChainSettled } }`;

export type EnvioIntent = {
  id: string; intentId: Hex; payer: Hex; invoiceId: Hex; route: number; routeName: string; status: string;
  inputToken: Hex; payoutToken: Hex; amountOut: string; fee: string | null; netToMerchant: string | null;
  inputAmount: string | null; committedAt: string; committedTx: Hex; settledAt: string | null; settledTx: Hex | null;
  sourceChainId: string | null; sourceTxHash: Hex | null;
};
```

**File: `services/api/src/services/merchantReads.ts`**

```ts
import type { Hex } from 'viem';
import type { PaymentView } from '@scanpay/shared';
import type { ChainCtx } from '../chains';
import { Intent, Merchant } from '../db/models';
import { ApiError } from '../errors';
import { log } from '../log';
import { eid, envioEnabled, gql, Q1_MERCHANT, Q2_MERCHANT_INTENTS, Q4_DAILY, Q5_KEYS, Q6_STATS, type EnvioIntent } from './envio';
import { merchantView, paymentViewFromIntent } from './views';

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
```

Add to **`routes/merchants.ts`**:

```ts
import { z } from 'zod';
import { zAddress, zBytes32, zChainId } from '@scanpay/shared';
import { getMerchantOr404, merchantKeys, merchantPayments, merchantsByOwner, merchantStats, protocolStats } from '../../services/merchantReads';

// inside merchantRoutes(app):
  const P = z.object({ chainId: zChainId, merchantId: zBytes32 });

  app.get('/v1/merchants/by-owner/:chainId/:owner', async (req) => {
    const p = parse(z.object({ chainId: zChainId, owner: zAddress }), req.params);
    return merchantsByOwner(chainCtx(p.chainId), p.owner);
  });

  app.get('/v1/merchants/:chainId/:merchantId', async (req) => {
    const p = parse(P, req.params);
    return getMerchantOr404(chainCtx(p.chainId), p.merchantId);
  });

  app.get('/v1/merchants/:chainId/:merchantId/payments', async (req) => {
    const p = parse(P, req.params);
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), offset: z.coerce.number().int().min(0).default(0) }), req.query);
    return merchantPayments(chainCtx(p.chainId), p.merchantId, q.limit, q.offset);
  });

  app.get('/v1/merchants/:chainId/:merchantId/stats', async (req) => {
    const p = parse(P, req.params);
    const q = parse(z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }), req.query);
    return merchantStats(chainCtx(p.chainId), p.merchantId, q.days);
  });

  app.get('/v1/merchants/:chainId/:merchantId/keys', async (req) => {
    const p = parse(P, req.params);
    return merchantKeys(chainCtx(p.chainId), p.merchantId);
  });

  app.get('/v1/stats/:chainId', async (req) => {
    const p = parse(z.object({ chainId: zChainId }), req.params);
    return protocolStats(chainCtx(p.chainId));
  });
```

In `index.ts`, after `loadEnv()`: `setEnvioUrl(env.ENVIO_GRAPHQL_URL);`

**Exit checks**
- [ ] `GET /v1/merchants/31337/<id>` → `status:"ACTIVE"`, `profileVerified:true`
- [ ] `GET /v1/merchants/by-owner/31337/<owner>` lists it
- [ ] `/payments` and `/stats` return `source:"db"` locally and `source:"envio"` on testnet after I3
- [ ] Stopping Envio (bad URL) → still 200 with `source:"db"`

**Commit:** `feat(api): merchant reads with envio-first, mongo fallback`

---

### Phase B12 — Invoices, invoice requests (static QR), QR resolve

**Goal:** store merchant-signed invoices behind short links; static-QR flow where the customer requests an amount
and the merchant terminal signs it; resolve any scanned QR into "verified merchant / unknown". **Time:** 90 min.
**Depends on:** B11.

QR formats (FE renders these; `/v1/qr/resolve` parses them):

| QR | Payload | Created by |
|---|---|---|
| Invoice (dynamic) | `${PUBLIC_APP_URL}/pay/<shortCode>` | merchant terminal per sale |
| Merchant (static, printed) | `${PUBLIC_APP_URL}/m/<chainId>/<merchantId>` | merchant once |

**File: `services/api/src/services/invoices.ts`**

```ts
import type { Hex } from 'viem';
import {
  buildInvoiceTypedData, fromWireInvoice, intentVaultAbi, MERCHANT_STATUS, INVOICE_STATE, type zCreateInvoiceReq,
  type zInvoiceRequestReq,
} from '@scanpay/shared';
import type { z } from 'zod';
import type { ChainCtx } from '../chains';
import { Invoice, InvoiceRequest } from '../db/models';
import { ApiError } from '../errors';
import { channel, publish } from '../bus';
import { newId, shortCode } from '../util/ids';
import { nowSec } from '../util/time';
import { invoiceOnchainState, invoiceView, merchantView, readMerchant } from './views';

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
  });
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

// ---------------- static QR: invoice requests ----------------

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

// ---------------- QR resolve ----------------

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
```

**File: `services/api/src/http/routes/invoices.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zBytes32, zChainId, zCreateInvoiceReq, zInvoiceRequestReq } from '@scanpay/shared';
import { chainCtx } from '../../chains';
import { parse } from '../parse';
import { withIdempotency } from '../idempotency';
import {
  createInvoice, createInvoiceRequest, getInvoice, getInvoiceRequest, listInvoiceRequests, listMerchantInvoices, resolveQr,
} from '../../services/invoices';

export async function invoiceRoutes(app: FastifyInstance) {
  app.post('/v1/invoices', async (req, reply) =>
    withIdempotency(req, reply, false, async () => {
      const body = parse(zCreateInvoiceReq, req.body);
      reply.code(201);
      return createInvoice(chainCtx(body.chainId), body);
    }),
  );

  app.get('/v1/invoices/:shortCode', async (req) => {
    const p = parse(z.object({ shortCode: z.string().regex(/^[a-z0-9]{6,16}$/) }), req.params);
    return getInvoice(null, p.shortCode, chainCtx);
  });

  app.get('/v1/merchants/:chainId/:merchantId/invoices', async (req) => {
    const p = parse(z.object({ chainId: zChainId, merchantId: zBytes32 }), req.params);
    return listMerchantInvoices(chainCtx(p.chainId), p.merchantId);
  });

  app.post('/v1/invoice-requests', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = parse(zInvoiceRequestReq, req.body);
    reply.code(201);
    return createInvoiceRequest(chainCtx(body.chainId), body);
  });

  app.get('/v1/invoice-requests/:requestId', async (req) => {
    const p = parse(z.object({ requestId: z.string().min(5).max(64) }), req.params);
    return getInvoiceRequest(p.requestId);
  });

  app.get('/v1/merchants/:chainId/:merchantId/invoice-requests', async (req) => {
    const p = parse(z.object({ chainId: zChainId, merchantId: zBytes32 }), req.params);
    return listInvoiceRequests(chainCtx(p.chainId), p.merchantId);
  });

  app.get('/v1/qr/resolve', async (req) => {
    const q = parse(z.object({ data: z.string().min(1).max(512) }), req.query);
    return resolveQr(q.data, chainCtx);
  });
}
```

Register in `app.ts`: `await app.register(invoiceRoutes);` and in `index.ts`: `setPublicAppUrl(env.PUBLIC_APP_URL);`

**File: `services/api/scripts/dev-invoice.ts`** — registers a merchant (keys kept in memory) and creates an invoice;
prints the short code for the next phases. Reused by B16–B18 scripts.

```ts
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  buildInvoiceTypedData, buildRegistrationTypedData, computeMerchantId, getDeployment, getToken, profileHash,
  randomBytes32, toWireInvoice, toWireRegistration, type TokenKey,
} from '@scanpay/shared';

export async function devMerchantAndInvoice(chainId: number, amount: bigint, payoutKey: TokenKey = 'USDC', api = process.env.API ?? 'http://localhost:8787') {
  const d = getDeployment(chainId);
  const owner = privateKeyToAccount(generatePrivateKey());
  const payout = privateKeyToAccount(generatePrivateKey());
  const signer = privateKeyToAccount(generatePrivateKey());
  const profile = { displayName: 'Dev Shop', category: 'retail', city: 'Bengaluru', country: 'IN', logoUrl: '' };
  const payoutToken = getToken(chainId, payoutKey).address;
  const reg = {
    owner: owner.address, salt: randomBytes32(), payoutWallet: payout.address, invoiceSigner: signer.address, payoutToken,
    metadataHash: profileHash(profile), nonce: 0n, deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
  };
  const td = buildRegistrationTypedData(chainId, d.contracts.MerchantRegistry.address, reg);
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${api}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(`${path} ${r.status} ${JSON.stringify(j)}`);
    return j;
  };
  await post('/v1/merchants/register', {
    chainId, registration: toWireRegistration(reg), profile,
    ownerSig: await owner.signTypedData(td), payoutSig: await payout.signTypedData(td),
  });
  const merchantId = computeMerchantId(owner.address, reg.salt);
  const invoice = {
    merchantId, invoiceId: randomBytes32(), payoutToken, amount, expiresAt: BigInt(Math.floor(Date.now() / 1000) + 900), keyVersion: 1,
  };
  const merchantSig = await signer.signTypedData(buildInvoiceTypedData(chainId, d.contracts.IntentVault.address, invoice));
  const created = await post('/v1/invoices', { chainId, invoice: toWireInvoice(invoice), merchantSig, memo: 'dev order', fiat: { currency: 'INR', amount: '1000.00' } });
  return { merchantId, shortCode: created.shortCode as string, payoutWallet: payout.address, signer };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await devMerchantAndInvoice(Number(process.argv[2] ?? 31337), 12_000_000n);
  console.log(r.shortCode, r.merchantId);
}
```

**Exit checks**
- [ ] `dev-invoice.ts 31337` prints a short code; `GET /v1/invoices/<code>` → `state:"OPEN"`, merchant `ACTIVE`
- [ ] Re-signing with a random key → `422 INVALID_MERCHANT_SIGNATURE`
- [ ] `GET /v1/qr/resolve?data=http://localhost:3000/pay/<code>` → `kind:"invoice", verified:true`
- [ ] `GET /v1/qr/resolve?data=https://evil.example/pay/<code>` → `verified:false` with the "points to evil.example" warning
- [ ] `GET /v1/qr/resolve?data=http://localhost:3000/m/31337/0x<random 64 hex>` → warning "not registered"
- [ ] `POST /v1/invoice-requests` then `GET /v1/merchants/31337/<id>/invoice-requests` lists it

**Commit:** `feat(api): invoices, static-QR invoice requests, QR resolve`

---

### Phase B13 — Routes + quote engine (DIRECT · SWAP mock/Kuru · CROSSCHAIN placeholder)

**Goal:** given an invoice, say which payment methods are available and price them. SWAP quotes come from the mock
adapter's on-chain `quoteIn` (local/testnet) or Kuru Flow (mainnet). **Time:** 90 min. **Depends on:** B12.

#### B13.1 Pricing rules (memorize; they become `maxAmountIn` and the payer signs it)

| Route | `inputToken` | `maxAmountIn` | `quoteHash` | Intent `expiresAt` |
|---|---|---|---|---|
| DIRECT | = payout token | = `amountOut` | `0x00…00` | `min(invoice.expiresAt, now + 600)` |
| SWAP, same token (non-3009 fallback) | = payout token | = `amountOut` | hash(fields, provider `none`) | `min(invoice.expiresAt, now + 300)` |
| SWAP via mock | chosen token | `ceil(quoteIn × 1.005)` | hash(fields, provider `mock`) | `min(invoice.expiresAt, now + 300)` |
| SWAP via Kuru | chosen token | exact-in amount whose Kuru `minOut ≥ amountOut` (+1% buffer) | hash(fields, provider `kuru`) | `min(invoice.expiresAt, now + 120)` |
| CROSSCHAIN, payout = USDC | USDC (cc input) | = `amountOut` | hash(fields, provider `aurora`/`oneclick`/`simulated`) | provider deadline (≤ 25 min) |
| CROSSCHAIN, payout = AUSD | USDC (cc input) | `ceil(amountOut × 1.003)` | same | same |

**File: `services/api/src/services/payable.ts`** — the one place that decides whether an invoice can be paid

```ts
import type { Hex } from 'viem';
import { fromWireInvoice, MERCHANT_STATUS, INVOICE_STATE, type InvoiceMessage } from '@scanpay/shared';
import { chainCtx, type ChainCtx } from '../chains';
import { Invoice } from '../db/models';
import { ApiError } from '../errors';
import { nowSec } from '../util/time';
import { invoiceOnchainState, readMerchant } from './views';

export interface Payable {
  ctx: ChainCtx;
  doc: Awaited<ReturnType<typeof Invoice.findOne>> & Record<string, any>;
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
```

**File: `services/api/src/services/kuru.ts`**

```ts
import { encodeAbiParameters, getAddress, type Address, type Hex } from 'viem';
import type { ChainCtx } from '../chains';
import { ApiError } from '../errors';
import { log } from '../log';
import { sleep } from '../util/time';

type KuruQuote = { output: bigint; minOut: bigint; target: Address; callData: Hex; raw: unknown };

let token: { value: string; exp: number } | null = null;
let lastCall = 0;

async function spaced<T>(fn: () => Promise<T>): Promise<T> {
  const wait = lastCall + 1100 - Date.now(); // Kuru Flow: 1 request / second per token
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  return fn();
}

async function getToken(ctx: ChainCtx): Promise<string> {
  if (token && token.exp > Date.now() + 30_000) return token.value;
  const api = ctx.deployment.external.kuruFlowApi!;
  const r = await spaced(() =>
    fetch(`${api}/api/generate-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_address: ctx.adapter }),
      signal: AbortSignal.timeout(8000),
    }),
  );
  if (!r.ok) throw new ApiError('QUOTE_FAILED', `kuru token ${r.status}`);
  const j = (await r.json()) as { token: string; expires_at?: number | string };
  const exp = j.expires_at ? (typeof j.expires_at === 'number' ? j.expires_at * 1000 : Date.parse(j.expires_at)) : Date.now() + 10 * 60_000;
  token = { value: j.token, exp };
  return j.token;
}

export async function kuruQuote(ctx: ChainCtx, tokenIn: Address, tokenOut: Address, amountIn: bigint, slippageBps = 50): Promise<KuruQuote> {
  if (ctx.adapterKind !== 'kuru' || !ctx.adapter) throw new ApiError('SWAP_UNAVAILABLE');
  const api = ctx.deployment.external.kuruFlowApi!;
  const bearer = await getToken(ctx);
  const r = await spaced(() =>
    fetch(`${api}/api/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({
        userAddress: ctx.adapter, // output lands in OUR adapter (ICD §0.7.4 swapData rule)
        tokenIn: getAddress(tokenIn),
        tokenOut: getAddress(tokenOut),
        amount: amountIn.toString(),
        slippageTolerance: slippageBps,
      }),
      signal: AbortSignal.timeout(8000),
    }),
  );
  if (!r.ok) throw new ApiError('QUOTE_FAILED', `kuru quote ${r.status}`);
  const q = (await r.json()) as any;
  const to = getAddress(q.transaction?.to);
  if (!ctx.deployment.external.kuruTargets.map((x) => x.toLowerCase()).includes(to.toLowerCase())) {
    throw new ApiError('SWAP_UNAVAILABLE', `kuru target ${to} not allow-listed`);
  }
  if (q.transaction?.value && BigInt(q.transaction.value) !== 0n) throw new ApiError('SWAP_UNAVAILABLE', 'native-value quote');
  const cd = String(q.transaction.calldata);
  return { output: BigInt(q.output), minOut: BigInt(q.minOut), target: to, callData: (cd.startsWith('0x') ? cd : `0x${cd}`) as Hex, raw: q };
}

/** Kuru is exact-input; find an input that yields minOut >= amountOut (two quotes max). */
export async function kuruExactOut(ctx: ChainCtx, tokenIn: Address, tokenOut: Address, amountOut: bigint) {
  const inT = ctx.tokenByAddress(tokenIn)?.token;
  const outT = ctx.tokenByAddress(tokenOut)?.token;
  if (!inT || !outT) throw new ApiError('INPUT_TOKEN_NOT_ALLOWED');
  // first guess from display prices (+2%)
  const outUsd = (Number(amountOut) / 10 ** outT.decimals) * outT.usdPrice;
  let guess = BigInt(Math.ceil((outUsd / inT.usdPrice) * 1.02 * 10 ** inT.decimals));
  let q = await kuruQuote(ctx, tokenIn, tokenOut, guess);
  if (q.minOut < amountOut) {
    guess = (guess * amountOut * 1010n) / (q.minOut * 1000n) + 1n; // scale + 1%
    q = await kuruQuote(ctx, tokenIn, tokenOut, guess);
    if (q.minOut < amountOut) throw new ApiError('QUOTE_FAILED', 'kuru liquidity insufficient');
  }
  const estimatedIn = (guess * amountOut) / q.output + 1n;
  log.info({ tokenIn, tokenOut, amountOut: amountOut.toString(), maxIn: guess.toString() }, 'kuru exact-out');
  return { maxAmountIn: guess, estimatedIn, quoteId: `kuru:${q.output}:${q.minOut}` };
}

/** Fresh swapData at submit time (Kuru calldata expires fast). Vault re-checks amounts anyway. */
export async function kuruSwapData(ctx: ChainCtx, tokenIn: Address, tokenOut: Address, amountIn: bigint, requiredOut: bigint): Promise<Hex> {
  const q = await kuruQuote(ctx, tokenIn, tokenOut, amountIn);
  if (q.minOut < requiredOut) throw new ApiError('SWAP_OUTPUT_TOO_LOW', undefined, { minOut: q.minOut.toString(), required: requiredOut.toString() });
  return encodeAbiParameters([{ type: 'address' }, { type: 'bytes' }], [q.target, q.callData]);
}
```

**File: `services/api/src/services/quotes.ts`**

```ts
import type { Address, Hex } from 'viem';
import {
  computeIntentId, mockSwapAdapterAbi, quoteHash, ZERO_BYTES32, intentVaultAbi,
  type QuoteHashFields, type RouteName, type TokenKey, type InvoiceMessage,
} from '@scanpay/shared';
import type { ChainCtx } from '../chains';
import { ApiError } from '../errors';
import { nowSec } from '../util/time';
import { kuruExactOut } from './kuru';
import { auroraQuote, auroraEnabled, originAssets, providerName, type OriginAsset } from './aurora';

export interface PricedRoute {
  route: RouteName;
  provider: QuoteHashFields['provider'] | 'none';
  inputToken: Address;
  inputTokenKey: TokenKey | null;
  amountOut: bigint;
  maxAmountIn: bigint;
  estimatedIn: bigint;
  intentExpiresAt: bigint;
  fields: QuoteHashFields | null;
  hash: Hex;
  simulated: boolean;
  crosschain: null | {
    forwarder: Address; depositAddress: string; originAssetId: string | null; originSymbol: string | null;
    originDecimals: number | null; originAmountIn: bigint | null; deadline: number; correlationId: string | null;
    mode: 'live' | 'simulated'; raw: unknown;
  };
}

const minBig = (a: bigint, b: bigint) => (a < b ? a : b);

// ------------------------------------------------------------------ availability

export async function routesFor(ctx: ChainCtx, invoice: InvoiceMessage) {
  const payout = ctx.tokenByAddress(invoice.payoutToken);
  const payoutKey = payout?.key ?? null;
  const directOk = Boolean(payout?.token.roles.includes('direct') && payout.token.supports3009);
  const swapTokens = (Object.entries(ctx.deployment.tokens) as [TokenKey, NonNullable<(typeof ctx.deployment.tokens)[TokenKey]>][])
    .filter(([k, t]) => t.roles.includes('swapIn') && (k !== payoutKey || !t.supports3009))
    .filter(([k]) => k === payoutKey || ctx.adapterKind !== 'none')
    .map(([k]) => k);
  const ccKey = ctx.deployment.config.crossChainInputToken;
  const ccSameToken = ccKey !== null && ctx.token(ccKey)?.address.toLowerCase() === invoice.payoutToken.toLowerCase();
  const ccMode = ctx.features.crosschain;
  const ccAvailable = ccMode !== 'off' && (ccSameToken || ctx.adapterKind !== 'none');
  let assets: OriginAsset[] = [];
  let ccReason: string | null = ccAvailable ? null : ccMode === 'off' ? 'Cross-chain provider not configured' : 'No swap path to payout token';
  if (ccAvailable) {
    try {
      assets = ccMode === 'live' ? await originAssets() : SIMULATED_ORIGINS;
    } catch {
      ccReason = 'Cross-chain provider unavailable';
    }
  }
  return {
    chainId: ctx.chainId,
    amountOut: invoice.amount.toString(),
    payoutTokenKey: payoutKey,
    direct: { available: directOk, tokens: directOk && payoutKey ? [payoutKey] : [], reason: directOk ? null : 'Gasless signature transfer not supported for this token' },
    swap: { available: swapTokens.length > 0, tokens: swapTokens, reason: swapTokens.length ? null : 'No swap route' },
    crosschain: { available: ccAvailable && assets.length > 0, mode: ccMode, originAssets: assets, reason: ccReason },
  };
}

export const SIMULATED_ORIGINS: OriginAsset[] = [
  { assetId: 'simulated:base:usdc', blockchain: 'base', symbol: 'USDC', decimals: 6, priceUsd: 1, evmChainId: 8453, contractAddress: null },
  { assetId: 'simulated:arb:usdc', blockchain: 'arb', symbol: 'USDC', decimals: 6, priceUsd: 1, evmChainId: 42161, contractAddress: null },
  { assetId: 'simulated:eth:eth', blockchain: 'eth', symbol: 'ETH', decimals: 18, priceUsd: 2500, evmChainId: 1, contractAddress: null },
];

// ------------------------------------------------------------------ pricing

export async function priceDirect(ctx: ChainCtx, invoice: InvoiceMessage): Promise<PricedRoute> {
  const payout = ctx.tokenByAddress(invoice.payoutToken);
  if (!payout?.token.supports3009 || !payout.token.roles.includes('direct')) throw new ApiError('ROUTE_UNAVAILABLE');
  return {
    route: 'DIRECT', provider: 'none', inputToken: invoice.payoutToken, inputTokenKey: payout.key, amountOut: invoice.amount,
    maxAmountIn: invoice.amount, estimatedIn: invoice.amount,
    intentExpiresAt: minBig(invoice.expiresAt, BigInt(nowSec() + 600)), fields: null, hash: ZERO_BYTES32, simulated: false,
    crosschain: null,
  };
}

export async function priceSwap(ctx: ChainCtx, invoice: InvoiceMessage, inputKey: TokenKey): Promise<PricedRoute> {
  const input = ctx.token(inputKey);
  if (!input || !input.roles.includes('swapIn')) throw new ApiError('INPUT_TOKEN_NOT_ALLOWED');
  const same = input.address.toLowerCase() === invoice.payoutToken.toLowerCase();
  let provider: QuoteHashFields['provider'];
  let maxAmountIn: bigint;
  let estimatedIn: bigint;
  let quoteId: string;
  let ttl = 300;
  if (same) {
    provider = 'none'; maxAmountIn = invoice.amount; estimatedIn = invoice.amount; quoteId = 'same-token';
  } else if (ctx.adapterKind === 'mock') {
    const [needed, rate] = await Promise.all([
      ctx.public.readContract({ address: ctx.adapter!, abi: mockSwapAdapterAbi, functionName: 'quoteIn', args: [input.address, invoice.payoutToken, invoice.amount] }) as Promise<bigint>,
      ctx.public.readContract({ address: ctx.adapter!, abi: mockSwapAdapterAbi, functionName: 'rateE18', args: [input.address, invoice.payoutToken] }) as Promise<bigint>,
    ]);
    provider = 'mock'; estimatedIn = needed; maxAmountIn = (needed * 10050n + 9999n) / 10000n; quoteId = `mock:${rate}`;
  } else if (ctx.adapterKind === 'kuru') {
    const k = await kuruExactOut(ctx, input.address, invoice.payoutToken, invoice.amount);
    provider = 'kuru'; maxAmountIn = k.maxAmountIn; estimatedIn = k.estimatedIn; quoteId = k.quoteId; ttl = 120;
  } else {
    throw new ApiError('SWAP_UNAVAILABLE');
  }
  const intentExpiresAt = minBig(invoice.expiresAt, BigInt(nowSec() + ttl));
  const fields: QuoteHashFields = {
    v: 1, chainId: ctx.chainId, route: 'SWAP', provider, quoteId,
    inputToken: input.address.toLowerCase() as Address, payoutToken: invoice.payoutToken.toLowerCase() as Address,
    amountOut: invoice.amount.toString(), maxAmountIn: maxAmountIn.toString(), depositAddress: null, recipient: null,
    originAsset: null, originAmountIn: null, deadline: Number(intentExpiresAt),
  };
  return {
    route: 'SWAP', provider, inputToken: input.address, inputTokenKey: inputKey, amountOut: invoice.amount, maxAmountIn,
    estimatedIn, intentExpiresAt, fields, hash: quoteHash(fields), simulated: provider === 'mock', crosschain: null,
  };
}

/**
 * CROSSCHAIN pricing needs the intent identity first (forwarder = f(intentId)), so the caller passes the
 * partially-built intent (merchantId, invoiceId, payer, nonce). `dry` = preview without a real deposit address.
 */
export async function priceCrossChain(
  ctx: ChainCtx,
  invoice: InvoiceMessage,
  id: { payer: Address; nonce: bigint },
  origin: { assetId: string; refundTo: string } | null,
  dry: boolean,
): Promise<PricedRoute> {
  const ccKey = ctx.deployment.config.crossChainInputToken;
  const cc = ccKey ? ctx.token(ccKey) : undefined;
  if (!cc || ctx.features.crosschain === 'off') throw new ApiError('ROUTE_UNAVAILABLE');
  const same = cc.address.toLowerCase() === invoice.payoutToken.toLowerCase();
  if (!same && ctx.adapterKind === 'none') throw new ApiError('ROUTE_UNAVAILABLE', 'No swap path from USDC to payout token');
  const maxAmountIn = same ? invoice.amount : (invoice.amount * 1003n + 999n) / 1000n;

  const intentId = computeIntentId({ merchantId: invoice.merchantId, invoiceId: invoice.invoiceId, payer: id.payer, nonce: id.nonce });
  const forwarder = (await ctx.public.readContract({
    address: ctx.vault, abi: intentVaultAbi, functionName: 'forwarderOf', args: [intentId],
  })) as Address;

  const mode = ctx.features.crosschain; // 'live' | 'simulated'
  let crosschain: NonNullable<PricedRoute['crosschain']>;
  let provider: QuoteHashFields['provider'];
  if (mode === 'live') {
    if (!origin) throw new ApiError('VALIDATION_ERROR', 'origin.assetId and origin.refundTo are required for cross-chain');
    if (!auroraEnabled()) throw new ApiError('PROVIDER_UNAVAILABLE');
    const q = await auroraQuote({
      dry, originAsset: origin.assetId, refundTo: origin.refundTo, recipient: forwarder,
      destinationAsset: ctx.deployment.external.auroraMonadUsdcAssetId!, amountOut: maxAmountIn,
    });
    const asset = (await originAssets()).find((a) => a.assetId === origin.assetId) ?? null;
    provider = providerName()!;
    crosschain = {
      forwarder, depositAddress: q.depositAddress ?? '(preview)', originAssetId: origin.assetId, originSymbol: asset?.symbol ?? null,
      originDecimals: asset?.decimals ?? null, originAmountIn: q.amountIn, deadline: q.deadline, correlationId: q.correlationId,
      mode: 'live', raw: q.raw,
    };
  } else {
    const asset = SIMULATED_ORIGINS.find((a) => a.assetId === origin?.assetId) ?? SIMULATED_ORIGINS[0];
    provider = 'simulated';
    crosschain = {
      forwarder, depositAddress: forwarder, originAssetId: asset.assetId, originSymbol: asset.symbol, originDecimals: asset.decimals,
      originAmountIn: BigInt(Math.ceil((Number(maxAmountIn) / 10 ** cc.decimals / (asset.priceUsd ?? 1)) * 10 ** asset.decimals)),
      deadline: nowSec() + 20 * 60, correlationId: `sim:${intentId}`, mode: 'simulated', raw: null,
    };
  }
  const intentExpiresAt = BigInt(crosschain.deadline);
  const fields: QuoteHashFields = {
    v: 1, chainId: ctx.chainId, route: 'CROSSCHAIN', provider, quoteId: crosschain.correlationId ?? `sim:${intentId}`,
    inputToken: cc.address.toLowerCase() as Address, payoutToken: invoice.payoutToken.toLowerCase() as Address,
    amountOut: invoice.amount.toString(), maxAmountIn: maxAmountIn.toString(), depositAddress: crosschain.depositAddress,
    recipient: forwarder.toLowerCase() as Address, originAsset: crosschain.originAssetId,
    originAmountIn: crosschain.originAmountIn?.toString() ?? null, deadline: crosschain.deadline,
  };
  return {
    route: 'CROSSCHAIN', provider, inputToken: cc.address, inputTokenKey: ccKey, amountOut: invoice.amount, maxAmountIn,
    estimatedIn: maxAmountIn, intentExpiresAt, fields, hash: quoteHash(fields), simulated: mode === 'simulated', crosschain,
  };
}
```

> Why `intentExpiresAt = provider deadline` for cross-chain: the vault lets **anyone** refund at
> `expiresAt + refundDelay` (3600 s mainnet). Tying `expiresAt` to Aurora's deadline guarantees the solver has either
> delivered or refunded on the source side before the Monad refund opens.

**Exit checks** (after B14 compiles)
- [ ] Typecheck passes
- [ ] Unit test (write it): `priceSwap` with mock adapter for 12 tUSDC from tMON → `estimatedIn = 480e18`, `maxAmountIn = 482.4e18`

**Commit:** `feat(api): payable checks, kuru client, quote engine`

---

### Phase B14 — Aurora Swap API client (+ 1Click fallback)

**Goal:** tokens list, quote, deposit submit, status — against Aurora's Swap API (`https://intents-api.aurora.dev`,
key in path) with the NEAR 1Click API as a drop-in fallback (same schema). **Time:** 60 min. **Depends on:** B13.

Endpoints (verified from docs.intents.aurora.dev / 1Click OpenAPI):

| Op | Aurora | 1Click fallback |
|---|---|---|
| tokens | `GET /api/tokens/{key}` → `{ tokens: [...] }` | `GET /v0/tokens` → `[...]` |
| quote | `POST /api/quote/{key}` | `POST /v0/quote` (`Authorization: Bearer <JWT>`) |
| deposit submit | `POST /api/deposit/submit/{key}` `{txHash, depositAddress}` | `POST /v0/deposit/submit` |
| status | `GET /api/status/{key}?depositAddress=` | `GET /v0/status?depositAddress=` |

Status enum: `PENDING_DEPOSIT, KNOWN_DEPOSIT_TX, PROCESSING, SUCCESS, INCOMPLETE_DEPOSIT, REFUNDED, FAILED`.

**File: `services/api/src/services/aurora.ts`**

```ts
import { ApiError } from '../errors';
import { log } from '../log';

const AURORA = 'https://intents-api.aurora.dev';
const ONECLICK = 'https://1click.chaindefuser.com';

let auroraKey: string | undefined;
let oneClickJwt: string | undefined;
export function configureAurora(key?: string, jwt?: string) {
  auroraKey = key;
  oneClickJwt = jwt;
}
export const auroraEnabled = () => Boolean(auroraKey || oneClickJwt);
export const providerName = (): 'aurora' | 'oneclick' | null => (auroraKey ? 'aurora' : oneClickJwt ? 'oneclick' : null);

function url(op: 'tokens' | 'quote' | 'submit' | 'status', qs = '') {
  if (auroraKey) {
    const path = { tokens: 'tokens', quote: 'quote', submit: 'deposit/submit', status: 'status' }[op];
    return `${AURORA}/api/${path}/${auroraKey}${qs}`;
  }
  const path = { tokens: 'tokens', quote: 'quote', submit: 'deposit/submit', status: 'status' }[op];
  return `${ONECLICK}/v0/${path}${qs}`;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (!auroraKey && oneClickJwt) h.authorization = `Bearer ${oneClickJwt}`;
  return h;
}

async function call<T>(u: string, init?: RequestInit): Promise<T> {
  const r = await fetch(u, { ...init, headers: headers(), signal: AbortSignal.timeout(12_000) });
  const text = await r.text();
  if (!r.ok) {
    log.warn({ status: r.status, body: text.slice(0, 500) }, 'intents api error');
    if (r.status === 429) throw new ApiError('RATE_LIMITED', 'Cross-chain provider rate limit');
    throw new ApiError('PROVIDER_UNAVAILABLE', `intents api ${r.status}: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text) as T;
}

// ------------------------------------------------------------------ tokens

export interface OriginAsset {
  assetId: string;
  blockchain: string;
  symbol: string;
  decimals: number;
  priceUsd: number | null;
  evmChainId: number | null;
  contractAddress: string | null;
}

export const EVM_CHAIN_IDS: Record<string, number> = { eth: 1, base: 8453, arb: 42161, op: 10, pol: 137, bsc: 56, avax: 43114 };
const ALLOWED_SYMBOLS = new Set(['USDC', 'USDT', 'ETH', 'WETH', 'BNB', 'POL', 'AVAX', 'DAI']);

let tokensCache: { at: number; assets: OriginAsset[] } | null = null;

export async function originAssets(): Promise<OriginAsset[]> {
  if (tokensCache && Date.now() - tokensCache.at < 10 * 60_000) return tokensCache.assets;
  const raw = await call<any>(url('tokens'));
  const list: any[] = Array.isArray(raw) ? raw : raw.tokens ?? [];
  const assets = list
    .filter((t) => t.blockchain !== 'monad' && EVM_CHAIN_IDS[t.blockchain] !== undefined && ALLOWED_SYMBOLS.has(String(t.symbol).toUpperCase()))
    .map((t) => ({
      assetId: t.assetId as string,
      blockchain: t.blockchain as string,
      symbol: String(t.symbol).toUpperCase(),
      decimals: Number(t.decimals),
      priceUsd: t.price != null ? Number(t.price) : null,
      evmChainId: EVM_CHAIN_IDS[t.blockchain] ?? null,
      contractAddress: t.contractAddress ?? null,
    }))
    .sort((a, b) => (a.symbol === 'USDC' ? -1 : 0) - (b.symbol === 'USDC' ? -1 : 0) || a.blockchain.localeCompare(b.blockchain));
  tokensCache = { at: Date.now(), assets };
  return assets;
}

export function evmChainIdOfAsset(assetId: string | null | undefined): number {
  if (!assetId) return 0;
  const m = assetId.match(/^nep141:([a-z]+)[-.]/) ?? assetId.match(/^simulated:([a-z]+):/);
  if (m && EVM_CHAIN_IDS[m[1]]) return EVM_CHAIN_IDS[m[1]];
  const hot = assetId.match(/^nep245:v2_1\.omni\.hot\.tg:(\d+)_/);
  if (hot) return Number(hot[1]);
  return 0;
}

// ------------------------------------------------------------------ quote

export interface AuroraQuote {
  depositAddress: string | null;
  amountIn: bigint | null;
  maxAmountIn: bigint | null;
  deadline: number;
  correlationId: string | null;
  raw: unknown;
}

export async function auroraQuote(p: {
  dry: boolean;
  originAsset: string;
  refundTo: string;
  recipient: string; // forwarder on Monad
  destinationAsset: string; // Monad USDC assetId
  amountOut: bigint; // EXACT_OUTPUT on Monad
}): Promise<AuroraQuote> {
  const deadlineIso = new Date(Date.now() + 25 * 60_000).toISOString();
  const body = {
    dry: p.dry,
    swapType: 'EXACT_OUTPUT',
    slippageTolerance: 100, // bps on the INPUT side for EXACT_OUTPUT
    originAsset: p.originAsset,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: p.destinationAsset,
    amount: p.amountOut.toString(),
    refundTo: p.refundTo,
    refundType: 'ORIGIN_CHAIN',
    recipient: p.recipient,
    recipientType: 'DESTINATION_CHAIN',
    deadline: deadlineIso,
    quoteWaitingTimeMs: 3000,
  };
  const r = await call<any>(url('quote'), { method: 'POST', body: JSON.stringify(body) });
  const q = r.quote ?? {};
  // EXACT_OUTPUT: the customer must send amountIn (provider adds a buffer; excess above need is refunded by the solver)
  return {
    depositAddress: q.depositAddress ?? null,
    amountIn: q.amountIn ? BigInt(q.amountIn) : null,
    maxAmountIn: q.maxAmountIn ? BigInt(q.maxAmountIn) : null,
    deadline: q.deadline ? Math.floor(Date.parse(q.deadline) / 1000) : Math.floor(Date.parse(deadlineIso) / 1000),
    correlationId: r.correlationId ?? null,
    raw: r,
  };
}

// ------------------------------------------------------------------ deposit submit + status

export async function auroraSubmitDeposit(depositAddress: string, txHash: string) {
  return call<any>(url('submit'), { method: 'POST', body: JSON.stringify({ txHash, depositAddress }) });
}

export interface ProviderStatus {
  status: 'PENDING_DEPOSIT' | 'KNOWN_DEPOSIT_TX' | 'PROCESSING' | 'SUCCESS' | 'INCOMPLETE_DEPOSIT' | 'REFUNDED' | 'FAILED' | string;
  originTxHashes: string[];
  destinationTxHashes: string[];
  raw: unknown;
}

export async function auroraStatus(depositAddress: string): Promise<ProviderStatus> {
  const r = await call<any>(url('status', `?depositAddress=${encodeURIComponent(depositAddress)}`));
  const sd = r.swapDetails ?? {};
  return {
    status: r.status,
    originTxHashes: (sd.originChainTxHashes ?? []).map((x: any) => x.hash ?? x),
    destinationTxHashes: (sd.destinationChainTxHashes ?? []).map((x: any) => x.hash ?? x),
    raw: r,
  };
}
```

In `index.ts`: `configureAurora(env.AURORA_API_KEY, env.ONECLICK_JWT);`

**File: `services/api/scripts/aurora-dry.ts`** — quick manual check (mainnet assets; no funds move)

```ts
import { configureAurora, originAssets, auroraQuote } from '../src/services/aurora';
configureAurora(process.env.AURORA_API_KEY, process.env.ONECLICK_JWT);
const assets = await originAssets();
console.log(assets.slice(0, 8));
const baseUsdc = assets.find((a) => a.blockchain === 'base' && a.symbol === 'USDC')!;
const q = await auroraQuote({
  dry: true, originAsset: baseUsdc.assetId, refundTo: '0x000000000000000000000000000000000000dEaD',
  recipient: '0x000000000000000000000000000000000000dEaD',
  destinationAsset: 'nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx', amountOut: 1_000_000n,
});
console.log({ amountIn: q.amountIn?.toString(), deadline: new Date(q.deadline * 1000).toISOString(), correlationId: q.correlationId });
```

**Commands**

```bash
cd services/api && tsx --env-file=../../.env scripts/aurora-dry.ts
```

**Exit checks**
- [ ] Prints ≥ 5 origin assets including Base USDC and Arbitrum USDC
- [ ] Dry quote for 1.00 USDC on Monad returns `amountIn` ≈ 1.00–1.02 USDC on Base
- [ ] With `AURORA_API_KEY` unset and `ONECLICK_JWT` set, the same script works (fallback path)

**Commit:** `feat(api): aurora swap api client with 1click fallback`

---

### Phase B15 — `GET /v1/routes`, `POST /v1/quotes`, `POST /v1/intents/prepare`

**Goal:** the customer app's three read/prepare calls. `prepare` creates a server-side **DRAFT** that freezes the
intent the customer is about to sign. **Time:** 90 min. **Depends on:** B13, B14.

**File: `services/api/src/services/wallet.ts`** (start it now with one function; B17 adds the rest of the file)

```ts
import type { ChainCtx } from '../chains';

const APPROVE_GAS = 80_000n;

/** MON needed for one approve at current gas price, ×2 headroom (Monad bills the full gas limit). */
export async function dripAmount(ctx: ChainCtx): Promise<bigint> {
  const gp = await ctx.public.getGasPrice();
  return APPROVE_GAS * gp * 2n;
}
```

**File: `services/api/src/services/intents.ts`**

```ts
import type { Address, Hex } from 'viem';
import {
  computeIntentId, erc20Abi, randomNonce, toWireIntent, ROUTE, type PaymentIntentMessage, type zPrepareReq, type zQuoteReq,
} from '@scanpay/shared';
import type { z } from 'zod';
import { Intent } from '../db/models';
import { ApiError } from '../errors';
import { newId } from '../util/ids';
import { nowSec } from '../util/time';
import { loadPayable } from './payable';
import { priceCrossChain, priceDirect, priceSwap, routesFor, type PricedRoute } from './quotes';
import { dripAmount } from './wallet';

export async function getRoutes(shortCode: string) {
  const p = await loadPayable(shortCode);
  return { shortCode, ...(await routesFor(p.ctx, p.invoice)) };
}

export async function previewQuote(req: z.infer<typeof zQuoteReq>) {
  const p = await loadPayable(req.shortCode);
  let priced: PricedRoute;
  if (req.route === 'DIRECT') priced = await priceDirect(p.ctx, p.invoice);
  else if (req.route === 'SWAP') {
    if (!req.inputTokenKey) throw new ApiError('VALIDATION_ERROR', 'inputTokenKey required for SWAP');
    priced = await priceSwap(p.ctx, p.invoice, req.inputTokenKey);
  } else {
    priced = await priceCrossChain(
      p.ctx, p.invoice, { payer: req.payer, nonce: 0n },
      req.originAssetId ? { assetId: req.originAssetId, refundTo: req.payer } : null, true,
    );
  }
  return {
    route: priced.route, provider: priced.provider, inputToken: priced.inputToken.toLowerCase(), inputTokenKey: priced.inputTokenKey,
    amountOut: priced.amountOut.toString(), maxAmountIn: priced.maxAmountIn.toString(), estimatedIn: priced.estimatedIn.toString(),
    originAssetId: priced.crosschain?.originAssetId ?? null, originAmountIn: priced.crosschain?.originAmountIn?.toString() ?? null,
    expiresAt: Number(priced.intentExpiresAt), feeBps: p.ctx.deployment.config.feeBps, simulated: priced.simulated,
  };
}

export async function prepare(req: z.infer<typeof zPrepareReq>) {
  const p = await loadPayable(req.shortCode);
  const { ctx, invoice } = p;
  const nonce = randomNonce();
  const payer = req.payer as Address;

  let priced: PricedRoute;
  if (req.route === 'DIRECT') priced = await priceDirect(ctx, invoice);
  else if (req.route === 'SWAP') {
    if (!req.inputTokenKey) throw new ApiError('VALIDATION_ERROR', 'inputTokenKey required for SWAP');
    priced = await priceSwap(ctx, invoice, req.inputTokenKey);
  } else {
    priced = await priceCrossChain(ctx, invoice, { payer, nonce }, req.origin ?? null, false);
  }
  if (Number(priced.intentExpiresAt) < nowSec() + 60) throw new ApiError('INVOICE_EXPIRED', 'Not enough time left to pay this invoice');

  const intent: PaymentIntentMessage = {
    merchantId: invoice.merchantId,
    invoiceId: invoice.invoiceId,
    payer,
    payoutToken: invoice.payoutToken,
    amountOut: invoice.amount,
    route: ROUTE[req.route],
    inputToken: priced.inputToken,
    maxAmountIn: priced.maxAmountIn,
    quoteHash: priced.hash,
    refundTo: payer, // Monad-side refunds (excess, unused input, cross-chain refunds) go back to the payer's account
    expiresAt: priced.intentExpiresAt,
    nonce,
    keyVersion: invoice.keyVersion,
  };
  const intentId = computeIntentId(intent).toLowerCase() as Hex;
  const draftId = newId('drf');
  const now = nowSec();

  // SWAP: allowance status for the one-time approve
  let swap: null | { spender: Hex; allowance: string; needsApproval: boolean; dripAvailable: boolean } = null;
  if (req.route === 'SWAP') {
    const allowance = (await ctx.public.readContract({
      address: priced.inputToken, abi: erc20Abi, functionName: 'allowance', args: [payer, ctx.vault],
    })) as bigint;
    const needsApproval = allowance < priced.maxAmountIn;
    const nativeBal = needsApproval ? await ctx.public.getBalance({ address: payer }) : 0n;
    swap = {
      spender: ctx.vault.toLowerCase() as Hex,
      allowance: allowance.toString(),
      needsApproval,
      dripAvailable: needsApproval && nativeBal < (await dripAmount(ctx)),
    };
  }

  const cc = priced.crosschain;
  await Intent.create({
    draftId,
    chainId: ctx.chainId,
    intentId,
    route: req.route,
    lifecycle: 'DRAFT',
    shortCode: req.shortCode,
    merchantId: invoice.merchantId.toLowerCase(),
    invoiceId: invoice.invoiceId.toLowerCase(),
    payer: payer.toLowerCase(),
    intent: toWireIntent(intent),
    invoice: p.doc.invoice,
    merchantSig: p.merchantSig,
    quote: priced.fields ? { fields: priced.fields, hash: priced.hash, simulated: priced.simulated } : null,
    forwarder: cc?.forwarder.toLowerCase() ?? null,
    crosschain: cc
      ? {
          mode: cc.mode, provider: priced.provider, depositAddress: cc.depositAddress, originAssetId: cc.originAssetId ?? undefined,
          originSymbol: cc.originSymbol ?? undefined, originDecimals: cc.originDecimals ?? undefined,
          originAmountIn: cc.originAmountIn?.toString(), deadline: cc.deadline, correlationId: cc.correlationId ?? undefined,
          providerStatus: cc.mode === 'live' ? 'PENDING_DEPOSIT' : undefined, originTxHashes: [], destinationTxHashes: [],
        }
      : undefined,
    expiresAt: Number(intent.expiresAt),
    draftExpiresAt: Math.min(Number(intent.expiresAt) - 30, now + 10 * 60),
    timeline: [{ at: now, status: 'DRAFT', note: `prepared ${req.route}${priced.simulated ? ' (simulated provider)' : ''}` }],
  });

  const payoutToken = ctx.tokenByAddress(invoice.payoutToken)?.token;
  return {
    draftId,
    chainId: ctx.chainId,
    intentId,
    vault: ctx.vault.toLowerCase() as Hex,
    intent: toWireIntent(intent),
    invoice: p.doc.invoice,
    merchantSig: p.merchantSig,
    quote: priced.fields ? { fields: priced.fields, hash: priced.hash, simulated: priced.simulated } : null,
    signing: {
      intent: true as const,
      receiveAuth:
        req.route === 'DIRECT' && payoutToken?.eip712
          ? { token: invoice.payoutToken.toLowerCase() as Hex, domain: payoutToken.eip712 }
          : null,
    },
    swap,
    crosschain: cc
      ? {
          mode: cc.mode, forwarder: cc.forwarder.toLowerCase() as Hex, depositAddress: cc.depositAddress,
          originAssetId: cc.originAssetId, originSymbol: cc.originSymbol, originAmountIn: cc.originAmountIn?.toString() ?? null,
          originDecimals: cc.originDecimals, deadline: cc.deadline,
        }
      : null,
    expiresAt: Number(intent.expiresAt),
  };
}
```

**How FE signs a prepared draft (put this snippet in the FE doc too):**

```ts
const r = zPrepareRes.parse(await api.post('/v1/intents/prepare', body));
const intent = fromWireIntent(r.intent);
const payerSig = await account.signTypedData(buildIntentTypedData(r.chainId, r.vault, intent));
let receiveAuthSig: Hex | undefined;
if (r.signing.receiveAuth) {
  const digest = intentDigest(r.chainId, r.vault, intent);
  receiveAuthSig = await account.signTypedData(
    buildReceiveAuthTypedData(r.chainId, { address: r.signing.receiveAuth.token, eip712: r.signing.receiveAuth.domain },
      receiveAuthForIntent(intent, digest, r.vault)));
}
await api.post('/v1/intents/submit', { draftId: r.draftId, payerSig, receiveAuthSig }, { 'Idempotency-Key': r.draftId });
```

**File: `services/api/src/http/routes/payments.ts`** (B15 part; B16–B19 extend)

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zPrepareReq, zQuoteReq } from '@scanpay/shared';
import { parse } from '../parse';
import { getRoutes, prepare, previewQuote } from '../../services/intents';

export async function paymentRoutes(app: FastifyInstance) {
  app.get('/v1/routes', async (req) => {
    const q = parse(z.object({ shortCode: z.string().regex(/^[a-z0-9]{6,16}$/) }), req.query);
    return getRoutes(q.shortCode);
  });

  app.post('/v1/quotes', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) =>
    previewQuote(parse(zQuoteReq, req.body)),
  );

  app.post('/v1/intents/prepare', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    reply.code(201);
    return prepare(parse(zPrepareReq, req.body));
  });
}
```

Register in `app.ts`: `await app.register(paymentRoutes);`

**Exit checks**
- [ ] `GET /v1/routes?shortCode=<code>` (local) → `direct.tokens:["USDC"]`, `swap.tokens` includes `"MON"` and `"AUSD"`, `crosschain.mode:"simulated"`
- [ ] `POST /v1/quotes {route:"SWAP", inputTokenKey:"MON"}` → `estimatedIn:"480000000000000000000"`
- [ ] `POST /v1/intents/prepare {route:"DIRECT"}` → `signing.receiveAuth.domain.name = "ScanPay Test USDC"`, `quote: null`
- [ ] Prepare CROSSCHAIN (local) → `crosschain.forwarder` equals `cast call <vault> "forwarderOf(bytes32)(address)" <intentId>`
- [ ] Mongo `intents` has a `DRAFT` doc per prepare

**Commit:** `feat(api): routes, quote preview, intent prepare (draft)`

---

### Phase B16 — Submit DIRECT + settlement bookkeeping from receipts

**Goal:** `POST /v1/intents/submit` for DIRECT; plus the shared function that applies vault events (from a receipt
now, from the follower in B20) — the **only** code path that writes `SETTLED`. **Time:** 75 min. **Depends on:** B15.

**File: `services/api/src/services/settlement.ts`**

```ts
import { decodeEventLog, type Hex, type Log, type TransactionReceipt } from 'viem';
import { intentVaultAbi, merchantRegistryAbi, MERCHANT_STATUS_NAME } from '@scanpay/shared';
import type { ChainCtx } from '../chains';
import { Intent, Invoice, Merchant, type IntentDoc } from '../db/models';
import { channel, publish } from '../bus';
import { intentView, paymentViewFromIntent } from './views';
import { log } from '../log';

const OPEN_CC = ['COMMITTED', 'AWAITING_DEPOSIT', 'PROCESSING', 'UNDERPAID', 'RECONCILIATION_REQUIRED', 'EXPIRED'];

type Meta = { txHash: Hex; blockNumber: bigint; timestamp: number };

export async function pushLifecycle(chainId: number, intentId: string, lifecycle: string, note: string, set: Record<string, unknown> = {}, onlyFrom?: string[]) {
  const filter: Record<string, unknown> = { chainId, intentId: intentId.toLowerCase() };
  if (onlyFrom) filter.lifecycle = { $in: onlyFrom };
  const doc = await Intent.findOneAndUpdate(
    filter,
    { $set: { lifecycle, ...set }, $push: { timeline: { at: Math.floor(Date.now() / 1000), status: lifecycle, note } } },
    { new: true },
  ).lean();
  return doc as IntentDoc | null;
}

function emitIntent(ctx: ChainCtx, d: IntentDoc | null) {
  if (!d) return;
  publish(channel.intent(ctx.chainId, d.intentId), { type: 'intent.updated', intent: intentView(ctx, d) });
}

/** Apply ONE decoded vault/registry log. Idempotent: re-applying the same log changes nothing. */
export async function applyLog(ctx: ChainCtx, log_: Log, meta: Meta) {
  const isVault = log_.address.toLowerCase() === ctx.vault.toLowerCase();
  const isRegistry = log_.address.toLowerCase() === ctx.registry.toLowerCase();
  if (!isVault && !isRegistry) return;
  let ev: { eventName: string; args: any };
  try {
    ev = decodeEventLog({ abi: isVault ? intentVaultAbi : merchantRegistryAbi, data: log_.data, topics: log_.topics }) as any;
  } catch {
    return;
  }
  const a = ev.args;
  switch (ev.eventName) {
    // ---------------------------------------------------------------- vault
    case 'IntentCommitted': {
      if (Number(a.route) === 2) {
        const d = await pushLifecycle(ctx.chainId, a.intentId, 'AWAITING_DEPOSIT', 'committed on-chain; waiting for deposit',
          { 'txs.commit': meta.txHash, forwarder: String(a.forwarder).toLowerCase() }, ['DRAFT', 'SUBMITTED', 'COMMITTED']);
        emitIntent(ctx, d);
      }
      await Invoice.updateOne({ chainId: ctx.chainId, merchantId: String(a.merchantId).toLowerCase(), invoiceId: String(a.invoiceId).toLowerCase(), state: 'OPEN' }, { $set: { state: 'RESERVED' } });
      break;
    }
    case 'PaymentSettled': {
      const fee = BigInt(a.fee);
      const d = await pushLifecycle(ctx.chainId, a.intentId, 'SETTLED', `settled on-chain (block ${meta.blockNumber})`, {
        'txs.settle': meta.txHash,
        'onchain.fee': fee.toString(),
        'onchain.inputAmount': BigInt(a.inputAmount).toString(),
        'onchain.excessRefunded': BigInt(a.excessRefunded).toString(),
        'onchain.netToMerchant': (BigInt(a.amountOut) - fee).toString(),
        'onchain.settledAt': meta.timestamp,
        'onchain.settledBlock': Number(meta.blockNumber),
        error: null,
      }, ['DRAFT', 'SUBMITTED', ...OPEN_CC]);
      const inv = await Invoice.findOneAndUpdate(
        { chainId: ctx.chainId, merchantId: String(a.merchantId).toLowerCase(), invoiceId: String(a.invoiceId).toLowerCase() },
        { $set: { state: 'PAID', paidIntentId: String(a.intentId).toLowerCase() } },
        { new: true },
      ).lean();
      emitIntent(ctx, d);
      if (d) publish(channel.merchant(ctx.chainId, d.merchantId), { type: 'payment.settled', payment: paymentViewFromIntent(d) });
      if (inv) publish(channel.invoice(inv.shortCode), { type: 'invoice.updated', shortCode: inv.shortCode, state: 'PAID' });
      log.info({ chainId: ctx.chainId, intentId: a.intentId, tx: meta.txHash }, 'PaymentSettled');
      break;
    }
    case 'IntentRefunded': {
      const d = await pushLifecycle(ctx.chainId, a.intentId, 'REFUNDED', `refunded ${a.amount} to ${a.refundTo}`, {
        'txs.refund': meta.txHash, 'onchain.refundAmount': BigInt(a.amount).toString(),
      }, OPEN_CC);
      if (d) {
        await Invoice.updateOne({ chainId: ctx.chainId, merchantId: d.merchantId, invoiceId: d.invoiceId }, { $set: { state: 'OPEN' } });
      }
      emitIntent(ctx, d);
      break;
    }
    case 'SourceAttested': {
      const d = await Intent.findOneAndUpdate(
        { chainId: ctx.chainId, intentId: String(a.intentId).toLowerCase() },
        { $set: { 'txs.attest': meta.txHash, 'crosschain.sourceChainId': Number(a.sourceChainId) } },
        { new: true },
      ).lean();
      emitIntent(ctx, d as IntentDoc | null);
      break;
    }
    // ---------------------------------------------------------------- registry
    case 'MerchantRegistered': {
      await Merchant.updateOne(
        { chainId: ctx.chainId, merchantId: String(a.merchantId).toLowerCase() },
        {
          $setOnInsert: {
            owner: String(a.owner).toLowerCase(), salt: String(a.salt).toLowerCase(), payoutWallet: String(a.payoutWallet).toLowerCase(),
            invoiceSigner: String(a.invoiceSigner).toLowerCase(), payoutToken: String(a.payoutToken).toLowerCase(), keyVersion: 1,
            status: 'PENDING', metadataHash: String(a.metadataHash).toLowerCase(), registeredAt: meta.timestamp, registeredTx: meta.txHash,
          },
        },
        { upsert: true },
      );
      break;
    }
    case 'MerchantStatusChanged':
      await Merchant.updateOne({ chainId: ctx.chainId, merchantId: String(a.merchantId).toLowerCase() }, { $set: { status: MERCHANT_STATUS_NAME[Number(a.newStatus)] } });
      break;
    case 'InvoiceSignerRotated':
      await Merchant.updateOne({ chainId: ctx.chainId, merchantId: String(a.merchantId).toLowerCase() }, { $set: { invoiceSigner: String(a.invoiceSigner).toLowerCase(), keyVersion: Number(a.keyVersion) } });
      break;
    case 'PayoutUpdated':
      await Merchant.updateOne({ chainId: ctx.chainId, merchantId: String(a.merchantId).toLowerCase() }, { $set: { payoutWallet: String(a.payoutWallet).toLowerCase(), payoutToken: String(a.payoutToken).toLowerCase(), keyVersion: Number(a.keyVersion) } });
      break;
    default:
      break;
  }
}

export async function applyReceipt(ctx: ChainCtx, receipt: TransactionReceipt) {
  const block = await ctx.public.getBlock({ blockNumber: receipt.blockNumber });
  for (const l of receipt.logs) {
    await applyLog(ctx, l as Log, { txHash: receipt.transactionHash, blockNumber: receipt.blockNumber, timestamp: Number(block.timestamp) });
  }
}
```

**File: `services/api/src/services/submit.ts`**

```ts
import type { Hex } from 'viem';
import {
  buildIntentTypedData, buildReceiveAuthTypedData, fromWireIntent, fromWireInvoice, intentDigest, intentVaultAbi,
  receiveAuthForIntent, splitSignature, type zSubmitReq,
} from '@scanpay/shared';
import type { z } from 'zod';
import { chainCtx, type ChainCtx } from '../chains';
import { Intent, audit, type IntentDoc } from '../db/models';
import { ApiError } from '../errors';
import { relay } from '../relayer';
import { nowSec } from '../util/time';
import { applyReceipt, pushLifecycle } from './settlement';
import { submitSwap } from './submitSwap';
import { submitCrossChain } from './submitCrossChain';

export function submitResult(d: IntentDoc, txHash: Hex | null) {
  return {
    chainId: d.chainId, intentId: d.intentId as Hex, lifecycle: d.lifecycle as any, txHash,
    forwarder: (d.forwarder as Hex) ?? null, depositAddress: d.crosschain?.depositAddress ?? null,
  };
}

export async function submit(req: z.infer<typeof zSubmitReq>) {
  const draft = (await Intent.findOne({ draftId: req.draftId }).lean()) as IntentDoc | null;
  if (!draft) throw new ApiError('INTENT_NOT_FOUND');
  if (draft.lifecycle !== 'DRAFT') return submitResult(draft, (draft.txs?.submit ?? draft.txs?.commit ?? null) as Hex | null);
  if (draft.draftExpiresAt < nowSec()) throw new ApiError('DRAFT_EXPIRED');

  const ctx = chainCtx(draft.chainId);
  const intent = fromWireIntent(draft.intent);
  const invoice = fromWireInvoice(draft.invoice);

  // R5: pre-check the payer signature off-chain for a fast, friendly error
  const okSig = await ctx.public.verifyTypedData({
    address: intent.payer, signature: req.payerSig, ...buildIntentTypedData(ctx.chainId, ctx.vault, intent),
  });
  if (!okSig) throw new ApiError('INVALID_PAYER_SIGNATURE');
  await Intent.updateOne({ draftId: req.draftId }, { $set: { payerSig: req.payerSig, receiveAuthSig: req.receiveAuthSig ?? null } });

  try {
    if (draft.route === 'DIRECT') return await submitDirect(ctx, draft, intent, invoice, req);
    if (draft.route === 'SWAP') return await submitSwap(ctx, draft, intent, invoice, req.payerSig);
    return await submitCrossChain(ctx, draft, intent, invoice, req.payerSig);
  } catch (e) {
    if (e instanceof ApiError) {
      const d = await pushLifecycle(ctx.chainId, draft.intentId, 'FAILED', `${e.code}${e.errorName ? ` (${e.errorName})` : ''}`, {
        error: { code: e.code, message: e.message },
      }, ['DRAFT', 'SUBMITTED']);
      await audit('relayer', 'intent.failed', ctx.chainId, draft.intentId, { code: e.code, errorName: e.errorName });
      void d;
    }
    throw e;
  }
}

async function submitDirect(
  ctx: ChainCtx, draft: IntentDoc, intent: ReturnType<typeof fromWireIntent>, invoice: ReturnType<typeof fromWireInvoice>,
  req: z.infer<typeof zSubmitReq>,
) {
  if (!req.receiveAuthSig) throw new ApiError('VALIDATION_ERROR', 'receiveAuthSig is required for DIRECT');
  const token = ctx.tokenByAddress(intent.payoutToken)?.token;
  if (!token?.eip712) throw new ApiError('ROUTE_UNAVAILABLE');
  const msg = receiveAuthForIntent(intent, intentDigest(ctx.chainId, ctx.vault, intent), ctx.vault);
  const okAuth = await ctx.public.verifyTypedData({
    address: intent.payer, signature: req.receiveAuthSig, ...buildReceiveAuthTypedData(ctx.chainId, token, msg),
  });
  if (!okAuth) throw new ApiError('TOKEN_AUTHORIZATION_FAILED', 'Transfer authorization signature does not match');

  const { hash, receipt } = await relay(ctx, {
    address: ctx.vault, abi: intentVaultAbi, functionName: 'payDirect',
    args: [intent, invoice, draft.merchantSig, req.payerSig, splitSignature(req.receiveAuthSig)],
    label: 'payDirect',
  });
  await pushLifecycle(ctx.chainId, draft.intentId, 'SUBMITTED', 'payDirect mined', { 'txs.submit': hash }, ['DRAFT']);
  await applyReceipt(ctx, receipt); // PaymentSettled in the same receipt -> SETTLED
  const d = (await Intent.findOne({ draftId: draft.draftId }).lean()) as IntentDoc;
  await audit('relayer', 'intent.direct', ctx.chainId, draft.intentId, { txHash: hash });
  return submitResult(d, hash);
}
```

> `splitSignature` returns `{v, r, s}` — exactly the `Auth3009` tuple viem expects.

**File: `services/api/src/http/routes/payments.ts`** — add:

```ts
import { zSubmitReq } from '@scanpay/shared';
import { withIdempotency } from '../idempotency';
import { submit } from '../../services/submit';

  app.post('/v1/intents/submit', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) =>
    withIdempotency(req, reply, true, async () => submit(parse(zSubmitReq, req.body))),
  );
```

**File: `services/api/scripts/dev-pay-direct.ts`**

```ts
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { buildIntentTypedData, buildReceiveAuthTypedData, fromWireIntent, intentDigest, receiveAuthForIntent } from '@scanpay/shared';
import { devMerchantAndInvoice } from './dev-invoice';

const chainId = Number(process.argv[2] ?? 31337);
const api = process.env.API ?? 'http://localhost:8787';
const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${api}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};

const payer = privateKeyToAccount(generatePrivateKey());
console.log('faucet', (await post('/v1/faucet', { chainId, address: payer.address })).status); // B25; skip until then and mint via cast
const { shortCode } = await devMerchantAndInvoice(chainId, 12_000_000n);
const prep = (await post('/v1/intents/prepare', { shortCode, route: 'DIRECT', payer: payer.address })).body;
const intent = fromWireIntent(prep.intent);
const payerSig = await payer.signTypedData(buildIntentTypedData(chainId, prep.vault, intent));
const receiveAuthSig = await payer.signTypedData(
  buildReceiveAuthTypedData(chainId, { address: prep.signing.receiveAuth.token, eip712: prep.signing.receiveAuth.domain },
    receiveAuthForIntent(intent, intentDigest(chainId, prep.vault, intent), prep.vault)),
);
const res = await post('/v1/intents/submit', { draftId: prep.draftId, payerSig, receiveAuthSig }, { 'idempotency-key': prep.draftId });
console.log(res.status, res.body);
const again = await post('/v1/intents/submit', { draftId: prep.draftId, payerSig, receiveAuthSig }, { 'idempotency-key': prep.draftId });
console.log('idempotent replay ->', again.status, again.body.lifecycle);
```

Until B25 exists, fund the payer manually: `cast send <tUSDC> "mint(address,uint256)" <payer> 100000000 --private-key $OPERATOR_PRIVATE_KEY_LOCAL --rpc-url http://127.0.0.1:8545`
(the script prints the payer address if you add a `console.log(payer.address)` before the faucet line).

**Exit checks**
- [ ] `dev-pay-direct.ts 31337` → `200 {lifecycle:"SETTLED", txHash:…}`; replay with same key → same body (idempotent)
- [ ] `GET /v1/invoices/<code>` → `state:"PAID"`
- [ ] Merchant payout wallet balance = 11.964 tUSDC (`cast call <tUSDC> "balanceOf(address)(uint256)" <payout>`)
- [ ] Submitting a payer signature from another key → `422 INVALID_PAYER_SIGNATURE` and the draft stays `DRAFT` (pre-check, no tx)

**Commit:** `feat(api): DIRECT submit, receipt-driven settlement bookkeeping`

---

### Phase B17 — Submit SWAP + allowance + gas drip

**Goal:** the SWAP route end-to-end, including the one-time `approve(vault)` that a gasless Mera account can only
send if B drips a little MON first. **Time:** 75 min. **Depends on:** B16.

**File: `services/api/src/services/wallet.ts`**

```ts
import type { Address, Hex } from 'viem';
import { erc20Abi, mockStableTokenAbi, type TokenKey } from '@scanpay/shared';
import type { ChainCtx } from '../chains';
import { DripLog, audit } from '../db/models';
import { ApiError } from '../errors';
import { relay, sendNative } from '../relayer';

const DAY_MS = 24 * 3600 * 1000;
const APPROVE_GAS = 80_000n;

/** MON needed for one approve at current gas price, ×2 headroom (Monad bills the full gas limit). */
export async function dripAmount(ctx: ChainCtx): Promise<bigint> {
  const gp = await ctx.public.getGasPrice();
  return APPROVE_GAS * gp * 2n;
}

export async function allowanceOf(ctx: ChainCtx, token: Address, owner: Address) {
  const [allowance, balance] = await Promise.all([
    ctx.public.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, ctx.vault] }) as Promise<bigint>,
    ctx.public.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }) as Promise<bigint>,
  ]);
  return { tokenKey: ctx.tokenByAddress(token)?.key ?? null, spender: ctx.vault.toLowerCase() as Hex, allowance: allowance.toString(), balance: balance.toString() };
}

export async function gasDrip(ctx: ChainCtx, address: Address, tokenKey: TokenKey) {
  const token = ctx.token(tokenKey);
  if (!token?.roles.includes('swapIn')) throw new ApiError('INPUT_TOKEN_NOT_ALLOWED');
  const allowance = (await ctx.public.readContract({ address: token.address, abi: erc20Abi, functionName: 'allowance', args: [address, ctx.vault] })) as bigint;
  if (allowance > 10n ** 30n) throw new ApiError('DRIP_NOT_NEEDED', 'Already approved');
  const need = await dripAmount(ctx);
  const bal = await ctx.public.getBalance({ address });
  if (bal >= need) throw new ApiError('DRIP_NOT_NEEDED');
  const recent = await DripLog.findOne({ chainId: ctx.chainId, address: address.toLowerCase(), kind: 'gas', at: { $gt: new Date(Date.now() - DAY_MS) } });
  if (recent) throw new ApiError('FAUCET_LIMIT', 'Gas drip already used today');
  const amount = need - bal;
  const { hash } = await sendNative(ctx, address, amount, 'gas-drip');
  await DripLog.create({ chainId: ctx.chainId, address: address.toLowerCase(), kind: 'gas', txHash: hash });
  await audit('relayer', 'gas.drip', ctx.chainId, address, { amount: amount.toString(), hash });
  return { txHash: hash, amountWei: amount.toString() };
}

/** Testnet faucet: mints mock tokens with the operator's MINTER_ROLE. */
export async function faucet(ctx: ChainCtx, address: Address) {
  if (ctx.isMainnet || !ctx.features.faucet) throw new ApiError('TESTNET_ONLY');
  const recent = await DripLog.findOne({ chainId: ctx.chainId, address: address.toLowerCase(), kind: 'faucet', at: { $gt: new Date(Date.now() - DAY_MS) } });
  if (recent) throw new ApiError('FAUCET_LIMIT');
  const plan: Partial<Record<TokenKey, bigint>> = {};
  for (const [k, t] of Object.entries(ctx.deployment.tokens) as [TokenKey, NonNullable<(typeof ctx.deployment.tokens)[TokenKey]>][]) {
    if (!t.isMock) continue;
    plan[k] = k === 'MON' ? 2_000n * 10n ** BigInt(t.decimals) : 100n * 10n ** BigInt(t.decimals);
  }
  const txHashes: Hex[] = [];
  for (const [k, amt] of Object.entries(plan) as [TokenKey, bigint][]) {
    const { hash } = await relay(ctx, {
      address: ctx.token(k)!.address, abi: mockStableTokenAbi, functionName: 'mint', args: [address, amt], label: `faucet ${k}`,
    });
    txHashes.push(hash);
  }
  // a little MON for the one-time SWAP approve, so the faucet alone makes every route usable
  const need = await dripAmount(ctx);
  if ((await ctx.public.getBalance({ address })) < need) txHashes.push((await sendNative(ctx, address, need, 'faucet-gas')).hash);
  await DripLog.create({ chainId: ctx.chainId, address: address.toLowerCase(), kind: 'faucet', txHash: txHashes[0] });
  return { txHashes, amounts: Object.fromEntries(Object.entries(plan).map(([k, v]) => [k, v!.toString()])) };
}
```

**File: `services/api/src/services/submitSwap.ts`**

```ts
import type { Hex } from 'viem';
import { erc20Abi, intentVaultAbi, type InvoiceMessage, type PaymentIntentMessage } from '@scanpay/shared';
import type { ChainCtx } from '../chains';
import { Intent, audit, type IntentDoc } from '../db/models';
import { ApiError } from '../errors';
import { relay } from '../relayer';
import { kuruSwapData } from './kuru';
import { applyReceipt, pushLifecycle } from './settlement';
import { submitResult } from './submit';

export async function submitSwap(ctx: ChainCtx, draft: IntentDoc, intent: PaymentIntentMessage, invoice: InvoiceMessage, payerSig: Hex) {
  const same = intent.inputToken.toLowerCase() === intent.payoutToken.toLowerCase();
  const pullAmount = same ? intent.amountOut : intent.maxAmountIn;
  const [allowance, balance] = await Promise.all([
    ctx.public.readContract({ address: intent.inputToken, abi: erc20Abi, functionName: 'allowance', args: [intent.payer, ctx.vault] }) as Promise<bigint>,
    ctx.public.readContract({ address: intent.inputToken, abi: erc20Abi, functionName: 'balanceOf', args: [intent.payer] }) as Promise<bigint>,
  ]);
  if (allowance < pullAmount) throw new ApiError('ALLOWANCE_REQUIRED', undefined, { allowance: allowance.toString(), needed: pullAmount.toString() });
  if (balance < pullAmount) throw new ApiError('INSUFFICIENT_BALANCE', undefined, { balance: balance.toString(), needed: pullAmount.toString() });

  let swapData: Hex = '0x';
  if (!same && ctx.adapterKind === 'kuru') {
    swapData = await kuruSwapData(ctx, intent.inputToken, intent.payoutToken, intent.maxAmountIn, intent.amountOut);
  }
  const { hash, receipt } = await relay(ctx, {
    address: ctx.vault, abi: intentVaultAbi, functionName: 'paySwap',
    args: [intent, invoice, draft.merchantSig, payerSig, swapData], label: 'paySwap',
  });
  await pushLifecycle(ctx.chainId, draft.intentId, 'SUBMITTED', 'paySwap mined', { 'txs.submit': hash }, ['DRAFT']);
  await applyReceipt(ctx, receipt);
  await audit('relayer', 'intent.swap', ctx.chainId, draft.intentId, { txHash: hash });
  return submitResult((await Intent.findOne({ draftId: draft.draftId }).lean()) as IntentDoc, hash);
}
```

**Add to `routes/payments.ts`:**

```ts
import { zAddress, zChainId, zDripReq, zFaucetReq } from '@scanpay/shared';
import { chainCtx } from '../../chains';
import { allowanceOf, faucet, gasDrip } from '../../services/wallet';

  app.get('/v1/allowance', async (req) => {
    const q = parse(z.object({ chainId: zChainId, token: zAddress, owner: zAddress }), req.query);
    return allowanceOf(chainCtx(q.chainId), q.token, q.owner);
  });

  app.post('/v1/gas/drip', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const b = parse(zDripReq, req.body);
    return gasDrip(chainCtx(b.chainId), b.address, b.tokenKey);
  });

  app.post('/v1/faucet', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const b = parse(zFaucetReq, req.body);
    return faucet(chainCtx(b.chainId), b.address);
  });
```

**Customer flow for SWAP (FE doc mirrors this):** `prepare` → if `swap.needsApproval`: if `swap.dripAvailable` call
`/v1/gas/drip`; customer sends `approve(vault, maxUint256)` from their Mera account (one tx, ever, per token) →
sign intent → `submit`.

**File: `services/api/scripts/dev-pay-swap.ts`**

```ts
import { createWalletClient, http, maxUint256 } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { foundry, monadTestnet } from 'viem/chains';
import { buildIntentTypedData, erc20Abi, fromWireIntent, getToken } from '@scanpay/shared';
import { devMerchantAndInvoice } from './dev-invoice';

const chainId = Number(process.argv[2] ?? 31337);
const api = process.env.API ?? 'http://localhost:8787';
const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${api}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};
const payer = privateKeyToAccount(generatePrivateKey());
console.log('faucet', (await post('/v1/faucet', { chainId, address: payer.address })).body);
const { shortCode } = await devMerchantAndInvoice(chainId, 12_000_000n);
const prep = (await post('/v1/intents/prepare', { shortCode, route: 'SWAP', inputTokenKey: 'MON', payer: payer.address })).body;
console.log('needsApproval', prep.swap.needsApproval, 'maxAmountIn', prep.intent.maxAmountIn);
const w = createWalletClient({ account: payer, chain: chainId === 10143 ? monadTestnet : foundry, transport: http(chainId === 10143 ? process.env.MONAD_TESTNET_RPC : 'http://127.0.0.1:8545') });
await w.writeContract({ address: getToken(chainId, 'MON').address, abi: erc20Abi, functionName: 'approve', args: [prep.vault, maxUint256] });
await new Promise((r) => setTimeout(r, 1500));
const payerSig = await payer.signTypedData(buildIntentTypedData(chainId, prep.vault, fromWireIntent(prep.intent)));
console.log(await post('/v1/intents/submit', { draftId: prep.draftId, payerSig }, { 'idempotency-key': prep.draftId }));
```

**Exit checks**
- [ ] `dev-pay-swap.ts 31337` → `SETTLED`; payer spent exactly 480 tMON (balance check), 2.4 tMON stayed
- [ ] Submitting without approve → `409 ALLOWANCE_REQUIRED` (pre-check) and the draft is `FAILED`
- [ ] `/v1/gas/drip` twice for the same address → second is `409 DRIP_NOT_NEEDED` or `429 FAUCET_LIMIT`
- [ ] `/v1/faucet` on chain 143 → `403 TESTNET_ONLY`

**Commit:** `feat(api): SWAP submit, allowance, gas drip, testnet faucet`

---

### Phase B18 — Submit CROSSCHAIN (commit) + simulated deposit

**Goal:** commit the intent on Monad so its forwarder exists, return the source-chain deposit instructions; on
testnet, a labelled "simulate solver delivery" endpoint. **Time:** 60 min. **Depends on:** B16.

**File: `services/api/src/services/submitCrossChain.ts`**

```ts
import type { Address, Hex } from 'viem';
import { intentVaultAbi, mockStableTokenAbi, type InvoiceMessage, type PaymentIntentMessage } from '@scanpay/shared';
import { chainCtx, type ChainCtx } from '../chains';
import { Intent, audit, type IntentDoc } from '../db/models';
import { ApiError } from '../errors';
import { relay } from '../relayer';
import { applyReceipt, pushLifecycle } from './settlement';
import { submitResult } from './submit';

export async function submitCrossChain(ctx: ChainCtx, draft: IntentDoc, intent: PaymentIntentMessage, invoice: InvoiceMessage, payerSig: Hex) {
  const { hash, receipt } = await relay(ctx, {
    address: ctx.vault, abi: intentVaultAbi, functionName: 'commitCrossChain',
    args: [intent, invoice, draft.merchantSig, payerSig], label: 'commitCrossChain',
  });
  await pushLifecycle(ctx.chainId, draft.intentId, 'COMMITTED', 'commitCrossChain mined', { 'txs.commit': hash }, ['DRAFT']);
  await applyReceipt(ctx, receipt); // IntentCommitted -> AWAITING_DEPOSIT
  await audit('relayer', 'intent.commit', ctx.chainId, draft.intentId, { txHash: hash });
  return submitResult((await Intent.findOne({ draftId: draft.draftId }).lean()) as IntentDoc, hash);
}

const OPEN = ['AWAITING_DEPOSIT', 'PROCESSING', 'UNDERPAID', 'RECONCILIATION_REQUIRED', 'EXPIRED'];

/** Testnet/local only: plays the Aurora solver by minting the cross-chain input token to the forwarder. */
export async function simulateDeposit(chainId: number, intentId: Hex, amount?: bigint) {
  const ctx = chainCtx(chainId);
  if (ctx.isMainnet) throw new ApiError('TESTNET_ONLY');
  const d = (await Intent.findOne({ chainId, intentId: intentId.toLowerCase() }).lean()) as IntentDoc | null;
  if (!d) throw new ApiError('INTENT_NOT_FOUND');
  if (d.route !== 'CROSSCHAIN' || d.crosschain?.mode !== 'simulated') throw new ApiError('WRONG_STATE', 'Not a simulated cross-chain payment');
  if (!OPEN.includes(d.lifecycle)) throw new ApiError('WRONG_STATE');
  const value = amount ?? BigInt(d.intent.maxAmountIn);
  const { hash } = await relay(ctx, {
    address: d.intent.inputToken as Address, abi: mockStableTokenAbi, functionName: 'mint', args: [d.forwarder as Address, value],
    label: 'simulated solver delivery',
  });
  await pushLifecycle(chainId, intentId, 'PROCESSING', `simulated solver delivered ${value} to forwarder`, {
    'crosschain.destinationTxHashes': [hash],
  }, ['AWAITING_DEPOSIT', 'UNDERPAID']);
  await audit('relayer', 'intent.simulateDeposit', chainId, intentId, { txHash: hash, amount: value.toString() });
  return { txHash: hash };
}
```

**Add to `routes/payments.ts`:**

```ts
import { zBytes32, zSimulateDepositReq } from '@scanpay/shared';
import { simulateDeposit } from '../../services/submitCrossChain';

  app.post('/v1/intents/:chainId/:intentId/simulate-deposit', async (req) => {
    const p = parse(z.object({ chainId: zChainId, intentId: zBytes32 }), req.params);
    const b = parse(zSimulateDepositReq, req.body ?? {});
    return simulateDeposit(p.chainId, p.intentId, b.amount ? BigInt(b.amount) : undefined);
  });
```

**Exit checks** (full settle needs the worker from B21 — this phase only checks commit + deposit)
- [ ] Prepare + submit CROSSCHAIN on local → `lifecycle:"AWAITING_DEPOSIT"`, `forwarder` has code (`cast code`)
- [ ] `simulate-deposit` → forwarder holds `maxAmountIn` tUSDC; intent `PROCESSING`
- [ ] `simulate-deposit` on 143 → `403 TESTNET_ONLY`

**Commit:** `feat(api): cross-chain commit + simulated solver delivery (testnet)`

---

### Phase B19 — Source-tx submit, intent read

**Goal:** the customer (or FE automatically, after the wallet send on the source chain) tells us the deposit tx so
Aurora processes it faster; plus `GET /v1/intents/:chainId/:intentId`. **Time:** 30 min. **Depends on:** B18, B14.

**Add to `services/submitCrossChain.ts`:**

```ts
import { auroraSubmitDeposit } from './aurora';
import { intentView } from './views';

export async function postSourceTx(chainId: number, intentId: Hex, txHash: string) {
  const ctx = chainCtx(chainId);
  const d = (await Intent.findOne({ chainId, intentId: intentId.toLowerCase() }).lean()) as IntentDoc | null;
  if (!d || d.route !== 'CROSSCHAIN') throw new ApiError('INTENT_NOT_FOUND');
  if (!OPEN.includes(d.lifecycle)) throw new ApiError('WRONG_STATE');
  await Intent.updateOne({ _id: d._id }, { $set: { 'crosschain.userSourceTx': txHash } });
  let providerStatus: string | null = d.crosschain?.providerStatus ?? null;
  if (d.crosschain?.mode === 'live' && d.crosschain.depositAddress) {
    const r = await auroraSubmitDeposit(d.crosschain.depositAddress, txHash);
    providerStatus = r?.status ?? providerStatus;
  }
  await pushLifecycle(chainId, intentId, 'PROCESSING', `customer submitted source tx ${txHash.slice(0, 12)}…`, {}, ['AWAITING_DEPOSIT']);
  void ctx;
  return { ok: true, providerStatus };
}

export async function readIntent(chainId: number, intentId: Hex) {
  const ctx = chainCtx(chainId);
  const d = (await Intent.findOne({ chainId, intentId: intentId.toLowerCase() }).lean()) as IntentDoc | null;
  if (!d) throw new ApiError('INTENT_NOT_FOUND');
  return intentView(ctx, d);
}
```

**Add to `routes/payments.ts`:**

```ts
import { zSourceTxReq } from '@scanpay/shared';
import { postSourceTx, readIntent } from '../../services/submitCrossChain';

  app.post('/v1/intents/:chainId/:intentId/source-tx', async (req) => {
    const p = parse(z.object({ chainId: zChainId, intentId: zBytes32 }), req.params);
    const b = parse(zSourceTxReq, req.body);
    return postSourceTx(p.chainId, p.intentId, b.txHash);
  });

  app.get('/v1/intents/:chainId/:intentId', async (req) => {
    const p = parse(z.object({ chainId: zChainId, intentId: zBytes32 }), req.params);
    return readIntent(p.chainId, p.intentId);
  });
```

**Exit checks**
- [ ] `GET /v1/intents/31337/<id>` → full `IntentView` with `timeline` of DRAFT → COMMITTED → AWAITING_DEPOSIT → PROCESSING
- [ ] `source-tx` on a DIRECT intent → `404 INTENT_NOT_FOUND`

**Commit:** `feat(api): source-tx submit + intent read`

---

### Phase B20 — Event follower (vault + registry logs → Mongo → SSE)

**Goal:** a per-chain log follower that applies every vault/registry event through `applyLog` (B16). It is what makes
`SETTLED` appear for payments that B didn't relay (e.g. a keeper settled a cross-chain intent) and keeps Mongo
consistent after restarts. **Time:** 60 min. **Depends on:** B16.

**File: `services/api/src/worker/follower.ts`**

```ts
import type { Log } from 'viem';
import type { ChainCtx } from '../chains';
import { Cursor } from '../db/models';
import { log } from '../log';
import { applyLog } from '../services/settlement';
import { sleep } from '../util/time';

const POLL_MS = 800;

export async function runFollower(ctx: ChainCtx, signal: AbortSignal) {
  let chunk = 100n; // Monad public RPCs cap eth_getLogs ranges; adaptively shrink on error
  let cur = await Cursor.findOne({ chainId: ctx.chainId }).lean();
  if (!cur) {
    const start = BigInt(Math.max(0, ctx.deployment.startBlock - 1));
    await Cursor.create({ chainId: ctx.chainId, lastBlock: Number(start) });
    cur = { chainId: ctx.chainId, lastBlock: Number(start) } as any;
  }
  let last = BigInt(cur!.lastBlock!);
  const tsCache = new Map<bigint, number>();
  log.info({ chainId: ctx.chainId, from: last.toString() }, 'follower start');

  while (!signal.aborted) {
    try {
      const head = await ctx.public.getBlockNumber();
      if (last >= head) {
        await sleep(POLL_MS);
        continue;
      }
      const from = last + 1n;
      const to = head - from + 1n > chunk ? from + chunk - 1n : head;
      const logs = (await ctx.public.getLogs({ address: [ctx.vault, ctx.registry], fromBlock: from, toBlock: to })) as Log[];
      for (const l of logs) {
        const bn = l.blockNumber!;
        let ts = tsCache.get(bn);
        if (ts === undefined) {
          ts = Number((await ctx.public.getBlock({ blockNumber: bn })).timestamp);
          tsCache.set(bn, ts);
          if (tsCache.size > 500) tsCache.delete(tsCache.keys().next().value!);
        }
        await applyLog(ctx, l, { txHash: l.transactionHash!, blockNumber: bn, timestamp: ts });
      }
      last = to;
      await Cursor.updateOne({ chainId: ctx.chainId }, { $set: { lastBlock: Number(last) } });
      if (chunk < 100n) chunk *= 2n;
      if (head - last > 1000n && Number(last) % 10_000 < Number(chunk)) log.info({ chainId: ctx.chainId, last: last.toString(), head: head.toString() }, 'follower catching up');
    } catch (e) {
      log.warn({ chainId: ctx.chainId, err: (e as Error).message, chunk: chunk.toString() }, 'follower error');
      if (chunk > 1n) chunk /= 2n;
      await sleep(1500);
    }
  }
}
```

**File: `services/api/src/worker/index.ts`** (B21 adds the cross-chain loop)

```ts
import { allChains } from '../chains';
import { log } from '../log';
import { runFollower } from './follower';

const controller = new AbortController();

export function startWorker() {
  for (const ctx of allChains()) {
    void runFollower(ctx, controller.signal).catch((e) => log.error({ e, chainId: ctx.chainId }, 'follower crashed'));
  }
  log.info('worker started');
}

export const stopWorker = () => controller.abort();
```

In `index.ts`: after `app.listen(...)` add `startWorker();` and in the signal handler call `stopWorker()` first.

**Exit checks**
- [ ] Restart the API after a DIRECT payment: cursor resumes (log "follower start from N"), no duplicate timeline entries
- [ ] A merchant registered **outside** the API (A's `seed-demo.ts`) appears in Mongo `merchants` within 2 s
- [ ] `cast send` a `settleCrossChain` manually for a funded intent → the API's intent flips to `SETTLED` via the follower

**Commit:** `feat(worker): event follower with adaptive log ranges and persisted cursor`

---

### Phase B21 — Cross-chain watcher (settle · underpaid · reconcile · expire · refund · attest)

**Goal:** drive every open cross-chain intent to a terminal state using **only** on-chain facts for money decisions;
provider status is informational. **Time:** 2 h. **Depends on:** B18, B20, B14.

#### B21.1 The decision function (pure — unit-tested in B28)

**File: `services/api/src/worker/decide.ts`**

```ts
import type { Lifecycle } from '@scanpay/shared';

export interface CcState {
  lifecycle: Lifecycle;
  required: bigint; // intent.maxAmountIn
  balance: bigint; // forwarder balance of the cross-chain input token
  now: number;
  expiresAt: number;
  refundAt: number; // expiresAt + refundDelay
  providerStatus: string | null;
  providerSuccessAt: number | null;
  destinationMismatch: boolean; // provider's destination tx has no transfer to our forwarder
}

export type CcAction =
  | { kind: 'settle' }
  | { kind: 'refund' }
  | { kind: 'mark'; lifecycle: Lifecycle; note: string }
  | { kind: 'none' };

export const RECONCILE_GRACE_SEC = 90;

/** Money first (settle/refund are contract-checked), then informational status. One action per tick. */
export function decideCrossChain(s: CcState): CcAction {
  if (s.balance >= s.required) return { kind: 'settle' };
  if (s.now >= s.refundAt) return { kind: 'refund' };

  const providerClaimsDone = s.providerStatus === 'SUCCESS' && s.providerSuccessAt !== null && s.now - s.providerSuccessAt > RECONCILE_GRACE_SEC;
  if ((s.destinationMismatch || providerClaimsDone) && s.lifecycle !== 'RECONCILIATION_REQUIRED') {
    return {
      kind: 'mark',
      lifecycle: 'RECONCILIATION_REQUIRED',
      note: `provider reports SUCCESS but forwarder holds ${s.balance} of ${s.required}${s.destinationMismatch ? ' (destination tx does not pay our forwarder)' : ''}`,
    };
  }
  if (s.lifecycle === 'RECONCILIATION_REQUIRED') return { kind: 'none' };
  if (s.balance > 0n && s.lifecycle !== 'UNDERPAID') {
    return { kind: 'mark', lifecycle: 'UNDERPAID', note: `received ${s.balance} of ${s.required}` };
  }
  if (s.balance > 0n) return { kind: 'none' };
  if (s.now > s.expiresAt && (s.lifecycle === 'AWAITING_DEPOSIT' || s.lifecycle === 'PROCESSING')) {
    return { kind: 'mark', lifecycle: 'EXPIRED', note: 'quote deadline passed; still settleable until refund opens' };
  }
  if (s.lifecycle === 'AWAITING_DEPOSIT' && (s.providerStatus === 'KNOWN_DEPOSIT_TX' || s.providerStatus === 'PROCESSING')) {
    return { kind: 'mark', lifecycle: 'PROCESSING', note: `provider: ${s.providerStatus}` };
  }
  return { kind: 'none' };
}
```

#### B21.2 The loop

**File: `services/api/src/worker/crosschain.ts`**

```ts
import { decodeEventLog, erc20Abi, keccak256, toBytes, type Address, type Hex } from 'viem';
import { intentVaultAbi, INTENT_STATUS, type Lifecycle } from '@scanpay/shared';
import { allChains, chainCtx, type ChainCtx } from '../chains';
import { Intent, audit, type IntentDoc } from '../db/models';
import { ApiError } from '../errors';
import { log } from '../log';
import { relay } from '../relayer';
import { auroraStatus, evmChainIdOfAsset } from '../services/aurora';
import { kuruSwapData } from '../services/kuru';
import { applyReceipt, pushLifecycle } from '../services/settlement';
import { channel, publish } from '../bus';
import { intentView } from '../services/views';
import { nowSec, sleep } from '../util/time';
import { decideCrossChain } from './decide';

const TICK_MS = 4000;
const PROVIDER_POLL_SEC = 15;
export const OPEN_CC: Lifecycle[] = ['AWAITING_DEPOSIT', 'PROCESSING', 'UNDERPAID', 'RECONCILIATION_REQUIRED', 'EXPIRED'];
const inFlight = new Set<string>();

export async function runCrossChain(signal: AbortSignal) {
  while (!signal.aborted) {
    for (const ctx of allChains()) {
      if (ctx.features.crosschain === 'off') continue;
      try {
        const docs = (await Intent.find({ chainId: ctx.chainId, route: 'CROSSCHAIN', lifecycle: { $in: OPEN_CC } }).lean()) as IntentDoc[];
        for (const d of docs) await processOne(ctx, d).catch((e) => log.warn({ intentId: d.intentId, err: (e as Error).message }, 'cc tick failed'));
        await attestPending(ctx);
      } catch (e) {
        log.warn({ chainId: ctx.chainId, err: (e as Error).message }, 'cc loop error');
      }
    }
    await sleep(TICK_MS);
  }
}

/** Also called directly by the webhook (B26) and the Attack Lab (B25). */
export async function processOne(ctx: ChainCtx, d: IntentDoc) {
  const key = `${ctx.chainId}:${d.intentId}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try {
    const rec = (await ctx.public.readContract({ address: ctx.vault, abi: intentVaultAbi, functionName: 'getIntent', args: [d.intentId as Hex] })) as { status: number };
    if (Number(rec.status) !== INTENT_STATUS.COMMITTED) return; // follower will apply the terminal event

    const inputToken = d.intent.inputToken as Address;
    const forwarder = d.forwarder as Address;
    const balance = (await ctx.public.readContract({ address: inputToken, abi: erc20Abi, functionName: 'balanceOf', args: [forwarder] })) as bigint;
    if (String(balance) !== (d.crosschain?.lastBalance ?? '0')) {
      const upd = await Intent.findOneAndUpdate({ _id: d._id }, { $set: { 'crosschain.lastBalance': balance.toString() } }, { new: true }).lean();
      if (upd) publish(channel.intent(ctx.chainId, d.intentId), { type: 'intent.updated', intent: intentView(ctx, upd as IntentDoc) });
    }

    // provider status (live only; informational)
    let providerStatus = d.crosschain?.providerStatus ?? null;
    let providerSuccessAt = d.crosschain?.providerSuccessAt ?? null;
    let destinationMismatch = false;
    const now = nowSec();
    if (d.crosschain?.mode === 'live' && d.crosschain.depositAddress && now - (d.crosschain.providerUpdatedAt ?? 0) >= PROVIDER_POLL_SEC) {
      try {
        const st = await auroraStatus(d.crosschain.depositAddress);
        providerStatus = st.status;
        if (st.status === 'SUCCESS' && !providerSuccessAt) providerSuccessAt = now;
        await Intent.updateOne({ _id: d._id }, {
          $set: {
            'crosschain.providerStatus': st.status, 'crosschain.providerUpdatedAt': now, 'crosschain.providerSuccessAt': providerSuccessAt,
            'crosschain.originTxHashes': st.originTxHashes, 'crosschain.destinationTxHashes': st.destinationTxHashes,
            'crosschain.sourceChainId': evmChainIdOfAsset(d.crosschain.originAssetId),
          },
        });
        if (st.status === 'SUCCESS' && balance < BigInt(d.intent.maxAmountIn)) {
          destinationMismatch = await destinationDoesNotPayForwarder(ctx, st.destinationTxHashes, inputToken, forwarder);
        }
      } catch (e) {
        log.warn({ intentId: d.intentId, err: (e as Error).message }, 'provider status failed');
      }
    }

    const expiresAt = Number(d.intent.expiresAt);
    const action = decideCrossChain({
      lifecycle: d.lifecycle as Lifecycle,
      required: BigInt(d.intent.maxAmountIn),
      balance,
      now,
      expiresAt,
      refundAt: expiresAt + ctx.deployment.config.refundDelaySec,
      providerStatus,
      providerSuccessAt,
      destinationMismatch,
    });

    if (action.kind === 'settle') {
      const same = inputToken.toLowerCase() === (d.intent.payoutToken as string).toLowerCase();
      const swapData: Hex = !same && ctx.adapterKind === 'kuru'
        ? await kuruSwapData(ctx, inputToken, d.intent.payoutToken as Address, balance, BigInt(d.intent.amountOut))
        : '0x';
      try {
        const { hash, receipt } = await relay(ctx, {
          address: ctx.vault, abi: intentVaultAbi, functionName: 'settleCrossChain', args: [d.intentId, swapData], label: 'settleCrossChain',
        });
        await applyReceipt(ctx, receipt);
        await audit('worker', 'cc.settle', ctx.chainId, d.intentId, { txHash: hash, balance: balance.toString() });
      } catch (e) {
        const err = e instanceof ApiError ? e : null;
        await Intent.updateOne({ _id: d._id }, { $set: { error: { code: err?.code ?? 'CHAIN_REVERT', message: err?.message ?? String(e) } } });
        log.warn({ intentId: d.intentId, code: err?.code, errorName: err?.errorName }, 'settle failed; will retry');
      }
    } else if (action.kind === 'refund') {
      const { hash, receipt } = await relay(ctx, {
        address: ctx.vault, abi: intentVaultAbi, functionName: 'refundCrossChain', args: [d.intentId], label: 'refundCrossChain',
      });
      await applyReceipt(ctx, receipt);
      await audit('worker', 'cc.refund', ctx.chainId, d.intentId, { txHash: hash });
    } else if (action.kind === 'mark') {
      const upd = await pushLifecycle(ctx.chainId, d.intentId, action.lifecycle, action.note, {}, OPEN_CC);
      if (upd) publish(channel.intent(ctx.chainId, d.intentId), { type: 'intent.updated', intent: intentView(ctx, upd) });
    }
  } finally {
    inFlight.delete(key);
  }
}

/** If the provider names destination txs, at least one must contain a Transfer(token -> our forwarder). */
async function destinationDoesNotPayForwarder(ctx: ChainCtx, hashes: string[], token: Address, forwarder: Address) {
  const evmHashes = hashes.filter((h) => /^0x[0-9a-fA-F]{64}$/.test(h));
  if (evmHashes.length === 0) return false; // nothing to check yet
  for (const h of evmHashes) {
    try {
      const r = await ctx.public.getTransactionReceipt({ hash: h as Hex });
      for (const l of r.logs) {
        if (l.address.toLowerCase() !== token.toLowerCase()) continue;
        try {
          const ev = decodeEventLog({ abi: erc20Abi, data: l.data, topics: l.topics });
          if (ev.eventName === 'Transfer' && (ev.args as any).to.toLowerCase() === forwarder.toLowerCase()) return false;
        } catch { /* not a Transfer */ }
      }
    } catch { /* tx not on this chain / not found */ }
  }
  return true;
}

/** After settlement: record which source-chain tx funded it (the one operator-attested fact). */
async function attestPending(ctx: ChainCtx) {
  const docs = (await Intent.find({
    chainId: ctx.chainId, route: 'CROSSCHAIN', lifecycle: 'SETTLED', 'txs.attest': null, attackLab: { $ne: true },
  }).limit(5).lean()) as IntentDoc[];
  for (const d of docs) {
    let sourceChainId: bigint;
    let sourceTx: Hex;
    let providerRef: Hex;
    if (d.crosschain?.mode === 'live') {
      const h = d.crosschain.originTxHashes?.[0];
      if (!h) continue; // provider hasn't told us yet
      sourceChainId = BigInt(evmChainIdOfAsset(d.crosschain.originAssetId));
      sourceTx = /^0x[0-9a-fA-F]{64}$/.test(h) ? (h as Hex) : keccak256(toBytes(h)); // non-EVM ids are hashed
      providerRef = keccak256(toBytes(d.crosschain.correlationId ?? d.crosschain.depositAddress ?? ''));
    } else {
      const h = d.crosschain?.destinationTxHashes?.[0];
      if (!h) continue;
      sourceChainId = BigInt(ctx.chainId); // simulated solver: the "source" is the mint on this chain — labelled as such
      sourceTx = h as Hex;
      providerRef = keccak256(toBytes('simulated'));
    }
    try {
      const { hash, receipt } = await relay(ctx, {
        address: ctx.vault, abi: intentVaultAbi, functionName: 'attestSource', args: [d.intentId, sourceChainId, sourceTx, providerRef], label: 'attestSource',
      });
      await applyReceipt(ctx, receipt);
      await audit('worker', 'cc.attest', ctx.chainId, d.intentId, { txHash: hash });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'ALREADY_ATTESTED') await Intent.updateOne({ _id: d._id }, { $set: { 'txs.attest': '0x' } });
      else log.warn({ intentId: d.intentId, err: (e as Error).message }, 'attest failed');
    }
  }
}

export async function processByDepositAddress(depositAddress: string) {
  const d = (await Intent.findOne({ 'crosschain.depositAddress': depositAddress, lifecycle: { $in: OPEN_CC } }).lean()) as IntentDoc | null;
  if (d) await processOne(chainCtx(d.chainId), d);
}
```

Update **`worker/index.ts`**:

```ts
import { runCrossChain } from './crosschain';
// inside startWorker(), after the follower loop:
  void runCrossChain(controller.signal).catch((e) => log.error({ e }, 'cross-chain loop crashed'));
```

**Exit checks** (local, simulated mode)
- [ ] Prepare+submit CROSSCHAIN → `simulate-deposit` → within ~5 s the intent is `SETTLED`, then `txs.attest` is set
- [ ] `simulate-deposit` with `amount` = half → `UNDERPAID`; second half → `SETTLED`
- [ ] No deposit, `REFUND_DELAY_SEC=120` locally: after `expiresAt` → `EXPIRED`; after `expiresAt+120` → `REFUNDED`
      (use `cast rpc evm_increaseTime 1500 && cast rpc evm_mine` on anvil to skip time)
- [ ] AUSD merchant + cross-chain → payout arrives in tAUSD (mock swap) and unused tUSDC is refunded to the payer

**Commit:** `feat(worker): cross-chain watcher — settle, underpaid, reconcile, expire, refund, attest`

---

### Phase B22 — SSE streams

**Goal:** real-time updates for the merchant terminal ("Paid ✓"), the customer's payment screen, and the static-QR
request handshake. **Time:** 40 min. **Depends on:** B21.

**File: `services/api/src/http/routes/stream.ts`**

```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Hex } from 'viem';
import { zBytes32, zChainId, type SseEvent } from '@scanpay/shared';
import { chainCtx } from '../../chains';
import { channel, subscribe } from '../../bus';
import { Intent, type IntentDoc } from '../../db/models';
import { intentView } from '../../services/views';
import { parse } from '../parse';

let allowed: string[] = [];
export const setSseOrigins = (o: string[]) => (allowed = o);

function openSse(req: FastifyRequest, reply: FastifyReply, ch: string, initial: SseEvent[] = []) {
  reply.hijack(); // we write the raw stream ourselves (so CORS headers must be set here too)
  const origin = req.headers.origin;
  const res = reply.raw;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...(origin && allowed.includes(origin) ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}),
  });
  const send = (ev: SseEvent) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  for (const ev of initial) send(ev);
  const unsub = subscribe(ch, send);
  const hb = setInterval(() => send({ type: 'ping', at: Date.now() }), 15_000);
  req.raw.on('close', () => {
    clearInterval(hb);
    unsub();
  });
}

export async function streamRoutes(app: FastifyInstance) {
  app.get('/v1/intents/:chainId/:intentId/stream', async (req, reply) => {
    const p = parse(z.object({ chainId: zChainId, intentId: zBytes32 }), req.params);
    const ctx = chainCtx(p.chainId);
    const d = (await Intent.findOne({ chainId: p.chainId, intentId: p.intentId }).lean()) as IntentDoc | null;
    openSse(req, reply, channel.intent(p.chainId, p.intentId), d ? [{ type: 'intent.updated', intent: intentView(ctx, d) }] : []);
  });

  app.get('/v1/merchants/:chainId/:merchantId/stream', async (req, reply) => {
    const p = parse(z.object({ chainId: zChainId, merchantId: zBytes32 }), req.params);
    chainCtx(p.chainId);
    openSse(req, reply, channel.merchant(p.chainId, p.merchantId as Hex));
  });

  app.get('/v1/invoices/:shortCode/stream', async (req, reply) => {
    const p = parse(z.object({ shortCode: z.string().regex(/^[a-z0-9]{6,16}$/) }), req.params);
    openSse(req, reply, channel.invoice(p.shortCode));
  });

  app.get('/v1/invoice-requests/:requestId/stream', async (req, reply) => {
    const p = parse(z.object({ requestId: z.string().min(5).max(64) }), req.params);
    openSse(req, reply, channel.request(p.requestId));
  });
}
```

Register in `app.ts`: `setSseOrigins(env.CORS_ORIGINS.split(',').map((s) => s.trim())); await app.register(streamRoutes);`
Exempt SSE routes from the global rate limit by adding `{ config: { rateLimit: false } }` is **not** needed — one
request opens a long stream.

**Exit checks**
- [ ] `curl -N localhost:8787/v1/merchants/31337/<id>/stream` then run `dev-pay-direct.ts` → an `event: payment.settled` line appears
- [ ] `curl -N …/intents/31337/<id>/stream` on a cross-chain intent shows `intent.updated` for each lifecycle change
- [ ] From the FE origin, `new EventSource(url)` connects without a CORS error

**Commit:** `feat(api): SSE streams for merchant, intent, invoice, invoice-request`

---

### Phase B23 — Verify endpoint (the three proofs, recomputed)

**Goal:** `GET /v1/verify/:chainId/:intentId` — recompute every proof from chain data (+ stored signatures) and
present them as checklists for the receipt/verify page. **Time:** 75 min. **Depends on:** B21, B11.

**File: `services/api/src/services/verify.ts`**

```ts
import { decodeEventLog, recoverTypedDataAddress, type Hex } from 'viem';
import {
  buildIntentTypedData, buildInvoiceTypedData, computeIntentId, fromWireIntent, fromWireInvoice, intentVaultAbi, quoteHash,
  INTENT_STATUS, MERCHANT_STATUS_NAME, ZERO_BYTES32, type IntentRecord, type VerifyRes,
} from '@scanpay/shared';
import { chainCtx } from '../chains';
import { Intent, type IntentDoc } from '../db/models';
import { eid, envioEnabled, gql, Q3_INTENT } from './envio';
import { merchantKeys } from './merchantReads';
import { merchantView, readMerchant } from './views';

type Check = { label: string; ok: boolean | null; detail: string };
const section = (checks: Check[]) => ({ ok: checks.some((c) => c.ok === false) ? false : checks.every((c) => c.ok === true) ? true : null, checks });
const eq = (a?: string | null, b?: string | null) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

export async function verifyIntent(chainId: number, intentId: Hex): Promise<VerifyRes> {
  const ctx = chainCtx(chainId);
  const rec = (await ctx.public.readContract({ address: ctx.vault, abi: intentVaultAbi, functionName: 'getIntent', args: [intentId] })) as IntentRecord;
  const links = { commitTx: null as string | null, settleTx: null as string | null, vault: ctx.explorerAddress(ctx.vault) ?? ctx.vault, registry: ctx.explorerAddress(ctx.registry) ?? ctx.registry };
  if (Number(rec.status) === INTENT_STATUS.NONE) {
    return { chainId, intentId, verdict: 'NOT_FOUND', proofs: { merchant: section([]), intent: section([]), settlement: section([]) }, links, trustNotes: ['No payment with this id exists on-chain.'] };
  }
  const doc = (await Intent.findOne({ chainId, intentId: intentId.toLowerCase() }).lean()) as IntentDoc | null;
  let settleTx = (doc?.txs?.settle ?? null) as Hex | null;
  let commitTx = (doc?.txs?.commit ?? doc?.txs?.submit ?? null) as Hex | null;
  if ((!settleTx || !commitTx) && envioEnabled() && ctx.features.indexer) {
    try {
      const r = await gql<{ Intent: any[] }>(Q3_INTENT, { id: eid(chainId, intentId) });
      settleTx ??= r.Intent[0]?.settledTx ?? null;
      commitTx ??= r.Intent[0]?.committedTx ?? null;
    } catch { /* optional */ }
  }
  links.commitTx = commitTx ? ctx.explorerTx(commitTx) ?? commitTx : null;
  links.settleTx = settleTx ? ctx.explorerTx(settleTx) ?? settleTx : null;

  // ---------------- proof of merchant ----------------
  const m = await readMerchant(ctx, rec.merchantId);
  const mv = await merchantView(ctx, rec.merchantId);
  const merchantChecks: Check[] = [
    { label: 'Merchant is registered on-chain', ok: Number(m.status) !== 0, detail: `merchantId ${rec.merchantId}` },
    { label: 'Merchant status today', ok: MERCHANT_STATUS_NAME[Number(m.status)] === 'ACTIVE' ? true : null, detail: MERCHANT_STATUS_NAME[Number(m.status)] },
    { label: 'Payout wallet locked at payment time', ok: true, detail: `${rec.payoutWallet}${eq(rec.payoutWallet, m.payoutWallet) ? '' : ' (merchant has changed payout since)'}` },
    { label: 'Public profile matches signed hash', ok: mv ? mv.profileVerified : null, detail: mv?.profile?.displayName ?? 'no profile' },
  ];

  // ---------------- proof of intent ----------------
  const intentChecks: Check[] = [];
  if (doc?.payerSig) {
    const intent = fromWireIntent(doc.intent);
    const invoice = fromWireInvoice(doc.invoice);
    intentChecks.push({ label: 'Intent id derives from the signed intent', ok: eq(computeIntentId(intent), intentId), detail: 'keccak256(merchantId, invoiceId, payer, nonce)' });
    const payer = await recoverTypedDataAddress({ ...buildIntentTypedData(chainId, ctx.vault, intent), signature: doc.payerSig as Hex });
    intentChecks.push({ label: 'Customer signed exactly these terms', ok: eq(payer, rec.payer), detail: `signer ${payer}` });
    const invSigner = await recoverTypedDataAddress({ ...buildInvoiceTypedData(chainId, ctx.vault, invoice), signature: doc.merchantSig as Hex });
    let expectedSigner: string | null = Number(m.keyVersion) === invoice.keyVersion ? m.invoiceSigner : null;
    if (!expectedSigner) {
      const keys = await merchantKeys(ctx, rec.merchantId);
      expectedSigner = [...keys.events].reverse().find((e) => e.keyVersion === invoice.keyVersion && e.invoiceSigner)?.invoiceSigner ?? null;
    }
    intentChecks.push({ label: `Invoice signed by the merchant's key v${invoice.keyVersion}`, ok: expectedSigner ? eq(invSigner, expectedSigner) : null, detail: `signer ${invSigner}` });
    intentChecks.push({ label: 'Amount and currency match the invoice', ok: invoice.amount === BigInt(rec.amountOut) && eq(invoice.payoutToken, rec.payoutToken), detail: `${rec.amountOut} of ${rec.payoutToken}` });
  } else {
    intentChecks.push({ label: 'Signatures verified by the contract at commit', ok: true, detail: 'IntentVault rejects any payment whose merchant or customer signature does not match (no off-chain copy stored for this payment)' });
  }
  if (Number(rec.route) === 0) {
    intentChecks.push({ label: 'No quote involved (direct stablecoin)', ok: rec.quoteHash.toLowerCase() === ZERO_BYTES32, detail: rec.quoteHash });
  } else if (doc?.quote?.fields) {
    intentChecks.push({ label: 'Quote the customer signed is the one used', ok: eq(quoteHash(doc.quote.fields), rec.quoteHash), detail: `${doc.quote.fields.provider} quote ${rec.quoteHash.slice(0, 12)}…` });
  }

  // ---------------- proof of settlement ----------------
  const settlementChecks: Check[] = [];
  const status = Number(rec.status);
  if (status === INTENT_STATUS.SETTLED && settleTx) {
    const receipt = await ctx.public.getTransactionReceipt({ hash: settleTx });
    const ev = receipt.logs
      .filter((l) => eq(l.address, ctx.vault))
      .map((l) => { try { return decodeEventLog({ abi: intentVaultAbi, data: l.data, topics: l.topics }); } catch { return null; } })
      .find((e) => e?.eventName === 'PaymentSettled' && eq((e.args as any).intentId, intentId));
    const a = (ev?.args ?? {}) as any;
    settlementChecks.push({ label: 'PaymentSettled event emitted by the vault', ok: Boolean(ev), detail: `tx ${settleTx}` });
    settlementChecks.push({ label: 'Paid to the registered payout wallet', ok: eq(a.payoutWallet, rec.payoutWallet), detail: String(a.payoutWallet ?? '') });
    settlementChecks.push({ label: 'Merchant received amount − fee', ok: ev ? BigInt(a.amountOut) - BigInt(a.fee) === BigInt(rec.amountOut) - BigInt(rec.fee) : false, detail: ev ? `${BigInt(a.amountOut) - BigInt(a.fee)} (fee ${a.fee})` : '' });
    if (ev && BigInt(a.excessRefunded) > 0n) settlementChecks.push({ label: 'Excess returned to customer', ok: true, detail: String(a.excessRefunded) });
  } else if (status === INTENT_STATUS.SETTLED) {
    settlementChecks.push({ label: 'Settled on-chain', ok: true, detail: `settledAt ${rec.settledAt}` });
  } else if (status === INTENT_STATUS.COMMITTED) {
    settlementChecks.push({ label: 'Waiting for funds', ok: null, detail: 'committed; not settled yet' });
  } else if (status === INTENT_STATUS.REFUNDED) {
    settlementChecks.push({ label: 'Refunded to customer', ok: true, detail: 'nothing reached the merchant' });
  }
  const trustNotes = ['Merchant approval is done by the ScanPay verifier (operator).'];
  if (Number(rec.route) === 2) {
    settlementChecks.push({ label: 'Funds were in the per-payment deposit address (contract-checked)', ok: status === INTENT_STATUS.SETTLED ? true : null, detail: doc?.forwarder ?? '' });
    settlementChecks.push({
      label: 'Source-chain transaction (operator attestation)',
      ok: rec.sourceTxHash !== ZERO_BYTES32 ? null : null,
      detail: rec.sourceTxHash !== ZERO_BYTES32 ? `chain ${rec.sourceChainId} · ${rec.sourceTxHash}` : 'not attested yet',
    });
    trustNotes.push('Which source-chain transaction funded this payment is attested by the operator; the Monad settlement itself is contract-enforced.');
    if (doc?.crosschain?.mode === 'simulated') trustNotes.push('Testnet: the cross-chain solver was simulated (tokens minted to the deposit address).');
  }

  const proofs = { merchant: section(merchantChecks), intent: section(intentChecks), settlement: section(settlementChecks) };
  const anyFalse = [proofs.merchant, proofs.intent, proofs.settlement].some((s) => s.checks.some((c) => c.ok === false && !c.label.startsWith('Merchant status')));
  const verdict: VerifyRes['verdict'] = anyFalse ? 'FAILED' : status === INTENT_STATUS.SETTLED ? 'VERIFIED' : status === INTENT_STATUS.REFUNDED ? 'REFUNDED' : 'PENDING';
  return { chainId, intentId, verdict, proofs, links, trustNotes };
}
```

**File: `services/api/src/http/routes/verify.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zBytes32, zChainId } from '@scanpay/shared';
import { parse } from '../parse';
import { verifyIntent } from '../../services/verify';

export async function verifyRoutes(app: FastifyInstance) {
  app.get('/v1/verify/:chainId/:intentId', async (req) => {
    const p = parse(z.object({ chainId: zChainId, intentId: zBytes32 }), req.params);
    return verifyIntent(p.chainId, p.intentId);
  });
}
```

Register in `app.ts`.

**Exit checks**
- [ ] DIRECT payment → `verdict:"VERIFIED"`, every check `ok:true` except "Merchant status today" (true while active)
- [ ] Cross-chain simulated → `VERIFIED` + trust note about simulation + attestation detail
- [ ] Random intent id → `NOT_FOUND`
- [ ] After rotating the merchant key, verifying an older payment still shows "Invoice signed by the merchant's key v1: ok"

**Commit:** `feat(api): verify endpoint recomputing the three proofs`

---

### Phase B24 — Attack Lab: demo identities + legit payment builders

**Goal:** a per-chain demo merchant and payer whose keys live server-side (**testnet/local only**), plus helpers that
build a fully valid payment we can then corrupt. **Time:** 45 min. **Depends on:** B16.

**File: `services/api/src/attack/lab.ts`**

```ts
import type { Hex, PrivateKeyAccount } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  buildIntentTypedData, buildInvoiceTypedData, buildReceiveAuthTypedData, buildRegistrationTypedData, computeMerchantId,
  intentDigest, merchantRegistryAbi, mockStableTokenAbi, profileHash, randomBytes32, randomNonce, receiveAuthForIntent,
  splitSignature, MERCHANT_STATUS, ROUTE, ZERO_BYTES32, erc20Abi,
  type InvoiceMessage, type PaymentIntentMessage, type Auth3009Like,
} from './lab-imports';
import type { ChainCtx } from '../chains';
import { LabState, Merchant } from '../db/models';
import { ApiError } from '../errors';
import { relay } from '../relayer';
import { applyReceipt } from '../services/settlement';
import { nowSec } from '../util/time';

export interface Lab {
  merchantId: Hex;
  owner: PrivateKeyAccount;
  payout: PrivateKeyAccount;
  signer: PrivateKeyAccount;
  payer: PrivateKeyAccount;
  attacker: PrivateKeyAccount;
}

const cache = new Map<number, Lab>();
const PROFILE = { displayName: 'Attack Lab Café', category: 'demo', city: 'Monad', country: 'IN', logoUrl: '' };

export async function getLab(ctx: ChainCtx): Promise<Lab> {
  if (ctx.isMainnet || !ctx.features.attackLab) throw new ApiError('ATTACK_LAB_DISABLED');
  const hit = cache.get(ctx.chainId);
  if (hit) return hit;

  let st = await LabState.findOne({ chainId: ctx.chainId }).lean();
  if (!st) {
    const keys = { owner: generatePrivateKey(), payout: generatePrivateKey(), signer: generatePrivateKey(), payer: generatePrivateKey(), attacker: generatePrivateKey() };
    await LabState.create({ chainId: ctx.chainId, keys });
    st = (await LabState.findOne({ chainId: ctx.chainId }).lean())!;
  }
  const k = st.keys as Record<string, Hex>;
  const lab: Lab = {
    merchantId: '0x' as Hex,
    owner: privateKeyToAccount(k.owner), payout: privateKeyToAccount(k.payout), signer: privateKeyToAccount(k.signer),
    payer: privateKeyToAccount(k.payer), attacker: privateKeyToAccount(k.attacker),
  };
  const salt = ('0x' + '1ab'.padEnd(64, '0')) as Hex; // fixed salt -> fixed merchantId per chain
  lab.merchantId = computeMerchantId(lab.owner.address, salt).toLowerCase() as Hex;

  const m = (await ctx.public.readContract({ address: ctx.registry, abi: merchantRegistryAbi, functionName: 'getMerchant', args: [lab.merchantId] })) as any;
  if (Number(m.status) === 0) {
    const usdc = ctx.token('USDC')!;
    const reg = {
      owner: lab.owner.address, salt, payoutWallet: lab.payout.address, invoiceSigner: lab.signer.address, payoutToken: usdc.address,
      metadataHash: profileHash(PROFILE), nonce: (await ctx.public.readContract({ address: ctx.registry, abi: merchantRegistryAbi, functionName: 'ownerNonce', args: [lab.owner.address] })) as bigint,
      deadline: BigInt(nowSec() + 600),
    };
    const td = buildRegistrationTypedData(ctx.chainId, ctx.registry, reg);
    const r1 = await relay(ctx, { address: ctx.registry, abi: merchantRegistryAbi, functionName: 'registerMerchant', args: [reg, await lab.owner.signTypedData(td), await lab.payout.signTypedData(td)], label: 'lab register' });
    await applyReceipt(ctx, r1.receipt); // inserts the Merchant doc (same path the follower uses)
    const r2 = await relay(ctx, { address: ctx.registry, abi: merchantRegistryAbi, functionName: 'setMerchantStatus', args: [lab.merchantId, MERCHANT_STATUS.ACTIVE], label: 'lab approve' });
    await applyReceipt(ctx, r2.receipt);
  }
  await Merchant.updateOne({ chainId: ctx.chainId, merchantId: lab.merchantId }, { $set: { profile: PROFILE } });
  cache.set(ctx.chainId, lab);
  return lab;
}

/** Keep the lab payer funded with tUSDC (operator is MINTER on testnet mocks). */
export async function fundPayer(ctx: ChainCtx, lab: Lab, min = 100_000_000n) {
  const usdc = ctx.token('USDC')!;
  const bal = (await ctx.public.readContract({ address: usdc.address, abi: erc20Abi, functionName: 'balanceOf', args: [lab.payer.address] })) as bigint;
  if (bal < min) await relay(ctx, { address: usdc.address, abi: mockStableTokenAbi, functionName: 'mint', args: [lab.payer.address, min * 10n], label: 'lab fund payer' });
}

export interface LegitPayment {
  invoice: InvoiceMessage;
  intent: PaymentIntentMessage;
  merchantSig: Hex;
  payerSig: Hex;
  auth: Auth3009Like;
}

/** A completely valid DIRECT payment (1.00 tUSDC) — scenarios corrupt one thing. */
export async function legitDirect(ctx: ChainCtx, lab: Lab, invoicePatch: Partial<InvoiceMessage> = {}): Promise<LegitPayment> {
  const usdc = ctx.token('USDC')!;
  const now = BigInt(nowSec());
  const invoice: InvoiceMessage = {
    merchantId: lab.merchantId, invoiceId: randomBytes32(), payoutToken: usdc.address, amount: 1_000_000n, expiresAt: now + 900n, keyVersion: 1,
    ...invoicePatch,
  };
  const intent: PaymentIntentMessage = {
    merchantId: invoice.merchantId, invoiceId: invoice.invoiceId, payer: lab.payer.address, payoutToken: invoice.payoutToken,
    amountOut: invoice.amount, route: ROUTE.DIRECT, inputToken: invoice.payoutToken, maxAmountIn: invoice.amount, quoteHash: ZERO_BYTES32,
    refundTo: lab.payer.address, expiresAt: now + 600n, nonce: randomNonce(), keyVersion: invoice.keyVersion,
  };
  return sign(ctx, lab, invoice, intent);
}

export async function sign(ctx: ChainCtx, lab: Lab, invoice: InvoiceMessage, intent: PaymentIntentMessage, signerAcct = lab.signer): Promise<LegitPayment> {
  const usdc = ctx.token('USDC')!;
  const merchantSig = await signerAcct.signTypedData(buildInvoiceTypedData(ctx.chainId, ctx.vault, invoice));
  const payerSig = await lab.payer.signTypedData(buildIntentTypedData(ctx.chainId, ctx.vault, intent));
  const auth = splitSignature(await lab.payer.signTypedData(
    buildReceiveAuthTypedData(ctx.chainId, usdc, receiveAuthForIntent(intent, intentDigest(ctx.chainId, ctx.vault, intent), ctx.vault)),
  ));
  return { invoice, intent, merchantSig, payerSig, auth };
}
```

**File: `services/api/src/attack/lab-imports.ts`**

```ts
export * from '@scanpay/shared';
export type Auth3009Like = { v: number; r: `0x${string}`; s: `0x${string}` };
```

**Exit checks**
- [ ] First call to `getLab(ctx)` on local registers "Attack Lab Café" (`GET /v1/merchants/31337/<labId>` → ACTIVE)
- [ ] A second process restart reuses the same merchant (keys from `labstates` collection)
- [ ] `getLab` on 143 throws `ATTACK_LAB_DISABLED`

**Commit:** `feat(attack-lab): demo identities and legit payment builders (testnet only)`

---

### Phase B25 — Attack Lab: scenarios + endpoints

**Goal:** eight scenarios that each perform a real attack against the deployed contracts and report what stopped
it. Default = simulation (free, instant); `broadcast:true` sends the reverting tx on-chain for a clickable proof.
**Time:** 2 h. **Depends on:** B24, B21, B23.

| id | Attack | Defense (proof layer) | Expected |
|---|---|---|---|
| `tamper_amount` | relayer raises the amount in invoice **and** intent after signing | merchant signature (intent) | `InvalidMerchantSignature` |
| `tamper_destination` | relayer redirects the refund/“destination” address | payer signature covers every address (intent); payout comes from registry (merchant) | `InvalidPayerSignature` |
| `replay` | resubmit a payment that already settled | one-time nonce (intent) | `NonceAlreadyUsed` |
| `expired` | pay a QR that expired | invoice expiry (intent) | `InvoiceExpired` |
| `unregistered_qr` | attacker prints a look-alike QR with their own key | registry status (merchant) | `MerchantNotActive` |
| `fake_provider_success` | provider/webhook claims "SUCCESS", no funds arrive | forwarder balance check (settlement) | `Underpaid` + lifecycle `RECONCILIATION_REQUIRED` |
| `forged_settlement_hash` | attacker posts a fake "settled" tx hash / tries to attest | only vault events count; `ATTESTER_ROLE` (settlement) | `AccessControlUnauthorizedAccount` + verify `NOT_FOUND` |
| `wrong_token` | swap the payout currency in the intent | token binding (intent) | `PayoutTokenMismatch` |

**File: `services/api/src/attack/scenarios.ts`**

```ts
import { keccak256, toBytes, type Hex } from 'viem';
import { intentVaultAbi, randomBytes32, randomNonce, toWireIntent, toWireInvoice, ROUTE, type ScenarioId, type AttackResult } from '@scanpay/shared';
import type { ChainCtx } from '../chains';
import { Intent, audit, type IntentDoc } from '../db/models';
import { ApiError } from '../errors';
import { broadcastExpectRevert, relay, simulate, type RelayCall } from '../relayer';
import { processOne } from '../worker/crosschain';
import { verifyIntent } from '../services/verify';
import { newId } from '../util/ids';
import { nowSec } from '../util/time';
import { fundPayer, getLab, legitDirect, sign, type Lab } from './lab';

export const SCENARIOS: Record<ScenarioId, { title: string; attack: string; defense: string; expectedError: string; proofLayer: 'merchant' | 'intent' | 'settlement' }> = {
  tamper_amount: { title: 'Change the amount after signing', attack: 'A malicious relayer turns a 1.00 payment into 100.00 in both the invoice and the intent.', defense: "The invoice is signed by the merchant's invoice key; any change breaks the signature.", expectedError: 'InvalidMerchantSignature', proofLayer: 'intent' },
  tamper_destination: { title: 'Redirect the money', attack: 'The relayer swaps the refund/destination address for its own.', defense: 'Every address is inside the customer-signed intent, and the payout wallet comes from the on-chain registry — there is no destination field to edit.', expectedError: 'InvalidPayerSignature', proofLayer: 'intent' },
  replay: { title: 'Replay a paid payment', attack: 'Resubmit a payment that already settled to charge the customer twice.', defense: 'Each intent carries a one-time nonce burned on first use.', expectedError: 'NonceAlreadyUsed', proofLayer: 'intent' },
  expired: { title: 'Pay an expired QR', attack: 'Use an old QR whose price is stale.', defense: 'Invoices and intents expire on-chain.', expectedError: 'InvoiceExpired', proofLayer: 'intent' },
  unregistered_qr: { title: 'Fake merchant QR', attack: 'Print a look-alike QR signed by an unregistered key.', defense: 'The vault only pays ACTIVE merchants from the registry.', expectedError: 'MerchantNotActive', proofLayer: 'merchant' },
  fake_provider_success: { title: '"Provider says paid"', attack: 'A webhook claims the cross-chain swap succeeded, but no funds arrived.', defense: 'Settlement reads the deposit-address balance; claims cannot settle.', expectedError: 'Underpaid', proofLayer: 'settlement' },
  forged_settlement_hash: { title: 'Forged settlement proof', attack: 'Show a fake "settled" tx hash and try to attest a source tx.', defense: 'Only the vault’s PaymentSettled event counts; attestation is role-gated and never settles.', expectedError: 'AccessControlUnauthorizedAccount', proofLayer: 'settlement' },
  wrong_token: { title: 'Wrong currency', attack: 'Pay the invoice in a different token than the merchant asked for.', defense: 'The payout token is bound in invoice, intent and registry.', expectedError: 'PayoutTokenMismatch', proofLayer: 'intent' },
};

type Observed = { errorName: string | null; apiCode: string | null; message: string; txHash: Hex | null };

async function attempt(ctx: ChainCtx, call: RelayCall, broadcast: boolean, from?: Hex): Promise<Observed> {
  try {
    await simulate(ctx, call, from);
    return { errorName: null, apiCode: null, message: 'NOT BLOCKED — simulation succeeded', txHash: null };
  } catch (e) {
    const err = e as ApiError;
    let txHash: Hex | null = null;
    if (broadcast && !from) {
      txHash = await broadcastExpectRevert(ctx, call);
      await ctx.public.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 }).catch(() => null);
    }
    return { errorName: err.errorName ?? null, apiCode: err.code ?? null, message: err.message, txHash };
  }
}

const payDirectCall = (ctx: ChainCtx, p: Awaited<ReturnType<typeof legitDirect>>): RelayCall => ({
  address: ctx.vault, abi: intentVaultAbi, functionName: 'payDirect',
  args: [p.intent, p.invoice, p.merchantSig, p.payerSig, p.auth], label: 'attack:payDirect',
});

export async function runScenario(ctx: ChainCtx, id: ScenarioId, broadcast: boolean): Promise<AttackResult> {
  const t0 = Date.now();
  const lab = await getLab(ctx);
  await fundPayer(ctx, lab);
  let obs: Observed;

  switch (id) {
    case 'tamper_amount': {
      const p = await legitDirect(ctx, lab);
      p.invoice = { ...p.invoice, amount: 100_000_000n };
      p.intent = { ...p.intent, amountOut: 100_000_000n, maxAmountIn: 100_000_000n };
      obs = await attempt(ctx, payDirectCall(ctx, p), broadcast);
      break;
    }
    case 'tamper_destination': {
      const p = await legitDirect(ctx, lab);
      p.intent = { ...p.intent, refundTo: lab.attacker.address };
      obs = await attempt(ctx, payDirectCall(ctx, p), broadcast);
      break;
    }
    case 'replay': {
      const p = await legitDirect(ctx, lab);
      await relay(ctx, { ...payDirectCall(ctx, p), label: 'attack:replay:first (legit)' });
      obs = await attempt(ctx, payDirectCall(ctx, p), broadcast);
      break;
    }
    case 'expired': {
      const base = await legitDirect(ctx, lab);
      const invoice = { ...base.invoice, expiresAt: BigInt(nowSec() - 60) };
      const p = await sign(ctx, lab, invoice, base.intent);
      obs = await attempt(ctx, payDirectCall(ctx, p), broadcast);
      break;
    }
    case 'unregistered_qr': {
      const fakeMerchant = keccak256(toBytes(`fake:${lab.attacker.address}:${Date.now()}`));
      const base = await legitDirect(ctx, lab, { merchantId: fakeMerchant });
      const p = await sign(ctx, lab, base.invoice, base.intent, lab.attacker);
      obs = await attempt(ctx, payDirectCall(ctx, p), broadcast);
      break;
    }
    case 'wrong_token': {
      const ausd = ctx.token('AUSD');
      if (!ausd) throw new ApiError('ROUTE_UNAVAILABLE', 'AUSD not configured');
      const p = await legitDirect(ctx, lab);
      p.intent = { ...p.intent, payoutToken: ausd.address, inputToken: ausd.address };
      obs = await attempt(ctx, payDirectCall(ctx, p), broadcast);
      break;
    }
    case 'fake_provider_success': {
      // 1) a REAL cross-chain commit (forwarder exists, no funds)
      const usdc = ctx.token('USDC')!;
      const now = BigInt(nowSec());
      const invoice = { merchantId: lab.merchantId, invoiceId: randomBytes32(), payoutToken: usdc.address, amount: 1_000_000n, expiresAt: now + 900n, keyVersion: 1 };
      const intent = {
        merchantId: invoice.merchantId, invoiceId: invoice.invoiceId, payer: lab.payer.address, payoutToken: usdc.address,
        amountOut: invoice.amount, route: ROUTE.CROSSCHAIN, inputToken: usdc.address, maxAmountIn: invoice.amount,
        quoteHash: keccak256(toBytes('attack-lab')), refundTo: lab.payer.address, expiresAt: now + 900n, nonce: randomNonce(), keyVersion: 1,
      };
      const p = await sign(ctx, lab, invoice, intent);
      const { hash, receipt } = await relay(ctx, { address: ctx.vault, abi: intentVaultAbi, functionName: 'commitCrossChain', args: [p.intent, p.invoice, p.merchantSig, p.payerSig], label: 'attack:commit' });
      const intentId = (await ctx.public.readContract({ address: ctx.vault, abi: intentVaultAbi, functionName: 'computeIntentId', args: [p.intent] })) as Hex;
      const forwarder = (await ctx.public.readContract({ address: ctx.vault, abi: intentVaultAbi, functionName: 'forwarderOf', args: [intentId] })) as Hex;
      // 2) inject the fake provider claim exactly where the watcher reads it
      await Intent.create({
        draftId: newId('lab'), chainId: ctx.chainId, intentId: intentId.toLowerCase(), route: 'CROSSCHAIN', lifecycle: 'PROCESSING',
        shortCode: 'attacklab', merchantId: lab.merchantId, invoiceId: invoice.invoiceId.toLowerCase(), payer: lab.payer.address.toLowerCase(),
        intent: toWireIntent(p.intent), invoice: toWireInvoice(p.invoice), merchantSig: p.merchantSig, payerSig: p.payerSig,
        forwarder: forwarder.toLowerCase(), attackLab: true,
        crosschain: { mode: 'simulated', provider: 'simulated', depositAddress: forwarder, providerStatus: 'SUCCESS', providerSuccessAt: nowSec() - 120, originTxHashes: [], destinationTxHashes: [] },
        txs: { commit: hash }, expiresAt: Number(intent.expiresAt), draftExpiresAt: nowSec(),
        timeline: [{ at: nowSec(), status: 'PROCESSING', note: 'ATTACK: provider webhook claims SUCCESS' }],
      });
      void receipt;
      // 3) the watcher reacts; settlement is impossible
      const doc = (await Intent.findOne({ chainId: ctx.chainId, intentId: intentId.toLowerCase() }).lean()) as IntentDoc;
      await processOne(ctx, doc);
      const after = (await Intent.findOne({ chainId: ctx.chainId, intentId: intentId.toLowerCase() }).lean()) as IntentDoc;
      const settle = await attempt(ctx, { address: ctx.vault, abi: intentVaultAbi, functionName: 'settleCrossChain', args: [intentId, '0x'], label: 'attack:settle' }, broadcast);
      obs = { ...settle, message: `${settle.message} · lifecycle is ${after.lifecycle} (never SETTLED)` };
      break;
    }
    case 'forged_settlement_hash': {
      const fakeIntent = randomBytes32();
      const v = await verifyIntent(ctx.chainId, fakeIntent);
      const call: RelayCall = { address: ctx.vault, abi: intentVaultAbi, functionName: 'attestSource', args: [fakeIntent, 8453n, randomBytes32(), randomBytes32()], label: 'attack:attest' };
      const r = await attempt(ctx, call, false, lab.attacker.address);
      obs = { ...r, message: `${r.message} · verify page for a forged id says ${v.verdict}` };
      break;
    }
    default:
      throw new ApiError('VALIDATION_ERROR', 'unknown scenario');
  }

  const meta = SCENARIOS[id];
  const blocked = obs.errorName !== null && (obs.errorName === meta.expectedError || obs.apiCode !== null);
  const result: AttackResult = {
    scenario: id, ...meta, outcome: blocked ? 'BLOCKED' : 'NOT_BLOCKED',
    observed: { errorName: obs.errorName, apiCode: obs.apiCode, message: obs.message },
    txHash: obs.txHash, explorerUrl: obs.txHash ? ctx.explorerTx(obs.txHash) : null, durationMs: Date.now() - t0,
  };
  await audit('public', 'attackLab.run', ctx.chainId, id, result);
  return result;
}
```

> `blocked` is true when the expected error fired, or any decoded contract error fired (for example on a chain where
> AUSD isn't configured, `wrong_token` may hit `PayoutTokenNotAllowed` first — still blocked, and the UI shows the
> actual error name). The e2e test (B29) asserts the **exact** expected names on local.

**File: `services/api/src/http/routes/attack.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zAttackRunReq, zChainId, type ScenarioId } from '@scanpay/shared';
import { chainCtx } from '../../chains';
import { ApiError } from '../../errors';
import { parse } from '../parse';
import { runScenario, SCENARIOS } from '../../attack/scenarios';

export async function attackRoutes(app: FastifyInstance) {
  app.get('/v1/attack-lab/scenarios', async (req) => {
    const q = parse(z.object({ chainId: zChainId }), req.query);
    const ctx = chainCtx(q.chainId);
    if (!ctx.features.attackLab) throw new ApiError('ATTACK_LAB_DISABLED');
    return { scenarios: (Object.keys(SCENARIOS) as ScenarioId[]).map((id) => ({ id, ...SCENARIOS[id] })) };
  });

  app.post('/v1/attack-lab/run', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const b = parse(zAttackRunReq, req.body);
    const ctx = chainCtx(b.chainId);
    if (!ctx.features.attackLab) throw new ApiError('ATTACK_LAB_DISABLED');
    return runScenario(ctx, b.scenario, b.broadcast);
  });
}
```

Register in `app.ts`.

**Exit checks**
- [ ] Each of the 8 scenarios on local returns `outcome:"BLOCKED"` with the expected `errorName`
- [ ] `replay` with `broadcast:true` on testnet returns a `txHash` whose explorer page shows a **failed** tx with `NonceAlreadyUsed` — paste it into the README proof table
- [ ] `fake_provider_success` leaves the lab intent in `RECONCILIATION_REQUIRED`, never `SETTLED`
- [ ] `/v1/attack-lab/run` on 143 → `403 ATTACK_LAB_DISABLED`

**Commit:** `feat(attack-lab): 8 live attack scenarios against deployed contracts`

---

### Phase B26 — Provider webhook (never trusted) + audit read

**Goal:** accept Aurora/1Click callbacks if configured, record them, and only use them as a **hint to look at the
chain sooner**. **Time:** 20 min. **Depends on:** B21.

**File: `services/api/src/http/routes/providers.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AuditLog, audit } from '../../db/models';
import { requireAdmin } from '../auth';
import { parse } from '../parse';
import { processByDepositAddress } from '../../worker/crosschain';

export async function providerRoutes(app: FastifyInstance) {
  app.post('/v1/providers/aurora/webhook', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const body = (req.body ?? {}) as Record<string, any>;
    const depositAddress: string | undefined = body.depositAddress ?? body.quoteResponse?.quote?.depositAddress;
    await audit('provider', 'webhook.received', null, depositAddress ?? 'unknown', { status: body.status, untrusted: true });
    // The claim itself changes NOTHING. It only makes the watcher re-check balances/status now.
    if (depositAddress) void processByDepositAddress(depositAddress);
    return { received: true };
  });

  app.get('/v1/admin/audit', async (req) => {
    requireAdmin(req);
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    return { items: await AuditLog.find().sort({ at: -1 }).limit(q.limit).lean() };
  });
}
```

Register in `app.ts`.

**Exit checks**
- [ ] `curl -X POST …/webhook -d '{"status":"SUCCESS","depositAddress":"<forwarder or deposit addr>"}'` → `{received:true}`; the intent does **not** become `SETTLED`
- [ ] `/v1/admin/audit` with bearer shows the webhook entry with `untrusted: true`

**Commit:** `feat(api): untrusted provider webhook + audit log read`

---

### Phase B27 — `verify-receipt` CLI (trust-but-verify without our API)

**Goal:** a judge (or anyone) can check a payment straight from the chain, without trusting our server. It takes the
intent id (and optionally the settle tx hash from anywhere — explorer, Envio, our API) and re-derives the facts.
**Time:** 30 min. **Depends on:** B23.

**File: `services/api/scripts/verify-receipt.ts`**

```ts
// Usage: pnpm --filter @scanpay/api verify-receipt <chainId> <intentId> [settleTxHash]
// Talks ONLY to a Monad RPC (and, if no tx hash is given, to the public Envio endpoint to find it).
import { createPublicClient, decodeEventLog, http, type Hex } from 'viem';
import { foundry, monad, monadTestnet } from 'viem/chains';
import { getDeployment, intentVaultAbi, merchantRegistryAbi, INTENT_STATUS_NAME, MERCHANT_STATUS_NAME, ROUTE_NAME } from '@scanpay/shared';

const [chainIdArg, intentId, txArg] = process.argv.slice(2);
if (!chainIdArg || !intentId) {
  console.error('usage: verify-receipt <chainId> <intentId> [settleTxHash]');
  process.exit(2);
}
const chainId = Number(chainIdArg);
const chain = chainId === 143 ? monad : chainId === 10143 ? monadTestnet : foundry;
const rpc = chainId === 143 ? process.env.MONAD_MAINNET_RPC : chainId === 10143 ? process.env.MONAD_TESTNET_RPC : 'http://127.0.0.1:8545';
const d = getDeployment(chainId);
const pub = createPublicClient({ chain, transport: http(rpc) });
const ok = (b: boolean) => (b ? '✅' : '❌');

const rec = (await pub.readContract({ address: d.contracts.IntentVault.address, abi: intentVaultAbi, functionName: 'getIntent', args: [intentId as Hex] })) as any;
console.log(`\nIntent ${intentId} on chain ${chainId}`);
console.log(`  status ${INTENT_STATUS_NAME[Number(rec.status)]} · route ${ROUTE_NAME[Number(rec.route)]} · amountOut ${rec.amountOut} · fee ${rec.fee}`);
if (Number(rec.status) === 0) {
  console.log('❌ no such payment on-chain');
  process.exit(1);
}

const m = (await pub.readContract({ address: d.contracts.MerchantRegistry.address, abi: merchantRegistryAbi, functionName: 'getMerchant', args: [rec.merchantId] })) as any;
console.log(`\nProof of merchant`);
console.log(`  ${ok(Number(m.status) !== 0)} merchant ${rec.merchantId} is registered (status today: ${MERCHANT_STATUS_NAME[Number(m.status)]})`);
console.log(`  ✅ payout wallet locked at payment: ${rec.payoutWallet}`);

let tx = txArg as Hex | undefined;
if (!tx && process.env.ENVIO_GRAPHQL_URL) {
  const r = await fetch(process.env.ENVIO_GRAPHQL_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: `{ Intent(where:{id:{_eq:"${chainId}_${intentId.toLowerCase()}"}}){ settledTx } }` }),
  });
  tx = ((await r.json()) as any).data?.Intent?.[0]?.settledTx ?? undefined;
}
console.log(`\nProof of settlement`);
if (Number(rec.status) !== 2) {
  console.log(`  … not settled (${INTENT_STATUS_NAME[Number(rec.status)]})`);
  process.exit(0);
}
if (!tx) {
  console.log('  (pass the settle tx hash to check the event)');
  process.exit(0);
}
const receipt = await pub.getTransactionReceipt({ hash: tx });
const ev = receipt.logs
  .filter((l) => l.address.toLowerCase() === d.contracts.IntentVault.address.toLowerCase())
  .map((l) => { try { return decodeEventLog({ abi: intentVaultAbi, data: l.data, topics: l.topics }); } catch { return null; } })
  .find((e) => e?.eventName === 'PaymentSettled' && (e.args as any).intentId.toLowerCase() === intentId.toLowerCase());
const a = (ev?.args ?? {}) as any;
console.log(`  ${ok(Boolean(ev))} PaymentSettled emitted by IntentVault ${d.contracts.IntentVault.address} in ${tx}`);
console.log(`  ${ok(a.payoutWallet?.toLowerCase() === rec.payoutWallet.toLowerCase())} paid to ${a.payoutWallet}`);
console.log(`  ✅ merchant net ${BigInt(a.amountOut ?? 0) - BigInt(a.fee ?? 0)} · fee ${a.fee} · excess refunded ${a.excessRefunded}`);
if (Number(rec.route) === 2) {
  console.log(`  ℹ source tx (operator attestation): chain ${rec.sourceChainId} · ${rec.sourceTxHash}`);
}
console.log('');
```

**Exit checks**
- [ ] `pnpm --filter @scanpay/api verify-receipt 10143 <intentId> <tx>` prints all ✅ for a real testnet payment
- [ ] README gets a "Verify any payment yourself" snippet (send to A for the README)

**Commit:** `feat(api): verify-receipt CLI`

---

### Phase B28 — Unit tests

**Goal:** fast tests that need no chain: error decoding (B5), watcher decisions, canonical/quote hash (in shared).
**Time:** 30 min. **Depends on:** B21.

**File: `services/api/test/unit/decide.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { decideCrossChain, RECONCILE_GRACE_SEC, type CcState } from '../../src/worker/decide';

const base: CcState = {
  lifecycle: 'AWAITING_DEPOSIT', required: 100n, balance: 0n, now: 1000, expiresAt: 2000, refundAt: 5600,
  providerStatus: 'PENDING_DEPOSIT', providerSuccessAt: null, destinationMismatch: false,
};

describe('decideCrossChain', () => {
  it('settles as soon as balance >= required (even after expiry)', () => {
    expect(decideCrossChain({ ...base, balance: 100n }).kind).toBe('settle');
    expect(decideCrossChain({ ...base, balance: 150n, now: 3000, lifecycle: 'EXPIRED' }).kind).toBe('settle');
  });
  it('refunds once refundAt is reached and balance is short', () => {
    expect(decideCrossChain({ ...base, now: 5600 }).kind).toBe('refund');
    expect(decideCrossChain({ ...base, now: 5600, balance: 50n }).kind).toBe('refund');
  });
  it('never trusts provider SUCCESS: flags reconciliation after grace', () => {
    const s = { ...base, lifecycle: 'PROCESSING' as const, providerStatus: 'SUCCESS', providerSuccessAt: 1000 - RECONCILE_GRACE_SEC - 1 };
    const a = decideCrossChain(s);
    expect(a).toMatchObject({ kind: 'mark', lifecycle: 'RECONCILIATION_REQUIRED' });
    expect(decideCrossChain({ ...s, providerSuccessAt: 990 }).kind).not.toBe('settle');
  });
  it('destination mismatch -> reconciliation immediately', () => {
    expect(decideCrossChain({ ...base, destinationMismatch: true })).toMatchObject({ lifecycle: 'RECONCILIATION_REQUIRED' });
  });
  it('partial -> UNDERPAID once', () => {
    expect(decideCrossChain({ ...base, balance: 40n })).toMatchObject({ lifecycle: 'UNDERPAID' });
    expect(decideCrossChain({ ...base, balance: 40n, lifecycle: 'UNDERPAID' }).kind).toBe('none');
  });
  it('expiry marks EXPIRED but keeps it settleable', () => {
    expect(decideCrossChain({ ...base, now: 2001 })).toMatchObject({ lifecycle: 'EXPIRED' });
  });
  it('provider progress moves AWAITING_DEPOSIT -> PROCESSING', () => {
    expect(decideCrossChain({ ...base, providerStatus: 'KNOWN_DEPOSIT_TX' })).toMatchObject({ lifecycle: 'PROCESSING' });
  });
});
```

**Commands**

```bash
pnpm --filter @scanpay/api test
pnpm shared:test
```

**Exit checks**
- [ ] api unit: errors (4) + decide (7) pass; shared: 13 pass

**Commit:** `test(api): unit tests for revert decoding and cross-chain decisions`

---

### Phase B29 — End-to-end tests against anvil (whole system, in-process)

**Goal:** one command proves every route, the worker, verify and the Attack Lab against the real contracts on a local
chain — the regression net for the demo. **Time:** 90 min. **Depends on:** B26, I1.

First, split booting out of `index.ts` so tests can boot the app in-process.

**File: `services/api/src/boot.ts`**

```ts
import mongoose from 'mongoose';
import type { Env } from './env';
import { initChains } from './chains';
import { connectDb } from './db/connect';
import { buildApp } from './http/app';
import { setEnvioUrl } from './services/envio';
import { configureAurora } from './services/aurora';
import { setPublicAppUrl } from './services/invoices';
import { startWorker, stopWorker } from './worker';
import { log } from './log';

export async function boot(env: Env, opts: { listen?: boolean; worker?: boolean } = {}) {
  setEnvioUrl(env.ENVIO_GRAPHQL_URL);
  configureAurora(env.AURORA_API_KEY, env.ONECLICK_JWT);
  setPublicAppUrl(env.PUBLIC_APP_URL);
  initChains(env);
  await connectDb(env.MONGODB_URI);
  const app = await buildApp(env);
  if (opts.listen !== false) {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    log.info({ port: env.PORT, chains: env.ENABLED_CHAINS }, 'scanpay api listening');
  }
  if (opts.worker !== false) startWorker();
  return {
    app,
    close: async () => {
      stopWorker();
      await app.close();
      await mongoose.disconnect();
    },
  };
}
```

**File: `services/api/src/index.ts`** (final)

```ts
import { loadEnv } from './env';
import { boot } from './boot';
import { log } from './log';

const env = loadEnv();
const { close } = await boot(env);
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    log.info({ sig }, 'shutting down');
    await close();
    process.exit(0);
  });
}
```

**File: `services/api/test/e2e/flow.test.ts`**

```ts
// Requires: `pnpm chain:local` running (anvil + deployments/31337.json). Mongo is in-memory.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createWalletClient, http, maxUint256, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import {
  buildIntentTypedData, buildInvoiceTypedData, buildReceiveAuthTypedData, buildRegistrationTypedData, computeMerchantId,
  erc20Abi, fromWireIntent, getDeployment, getToken, intentDigest, profileHash, randomBytes32, receiveAuthForIntent,
  toWireInvoice, toWireRegistration, type TokenKey,
} from '@scanpay/shared';
import type { FastifyInstance } from 'fastify';
import { loadEnv } from '../../src/env';
import { boot } from '../../src/boot';

const CHAIN = 31337;
const d = getDeployment(CHAIN);
let mongo: MongoMemoryServer;
let app: FastifyInstance;
let close: () => Promise<void>;

const post = async (url: string, payload: unknown, headers: Record<string, string> = {}) => {
  const r = await app.inject({ method: 'POST', url, payload: payload as any, headers });
  return { status: r.statusCode, body: r.json() as any };
};
const get = async (url: string) => {
  const r = await app.inject({ method: 'GET', url });
  return { status: r.statusCode, body: r.json() as any };
};
const waitFor = async (fn: () => Promise<boolean>, ms = 20_000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('timeout');
};

async function newMerchant(payoutKey: TokenKey = 'USDC') {
  const owner = privateKeyToAccount(generatePrivateKey());
  const payout = privateKeyToAccount(generatePrivateKey());
  const signer = privateKeyToAccount(generatePrivateKey());
  const profile = { displayName: 'E2E Shop', category: 'test', city: 'Test', country: 'IN', logoUrl: '' };
  const reg = {
    owner: owner.address, salt: randomBytes32(), payoutWallet: payout.address, invoiceSigner: signer.address,
    payoutToken: getToken(CHAIN, payoutKey).address, metadataHash: profileHash(profile), nonce: 0n,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
  };
  const td = buildRegistrationTypedData(CHAIN, d.contracts.MerchantRegistry.address, reg);
  const r = await post('/v1/merchants/register', {
    chainId: CHAIN, registration: toWireRegistration(reg), profile,
    ownerSig: await owner.signTypedData(td), payoutSig: await payout.signTypedData(td),
  });
  expect(r.status).toBe(200);
  expect(r.body.status).toBe('ACTIVE');
  return { merchantId: computeMerchantId(owner.address, reg.salt), signer, payout, payoutToken: reg.payoutToken };
}

async function newInvoice(m: Awaited<ReturnType<typeof newMerchant>>, amount: bigint) {
  const invoice = { merchantId: m.merchantId, invoiceId: randomBytes32(), payoutToken: m.payoutToken, amount, expiresAt: BigInt(Math.floor(Date.now() / 1000) + 900), keyVersion: 1 };
  const merchantSig = await m.signer.signTypedData(buildInvoiceTypedData(CHAIN, d.contracts.IntentVault.address, invoice));
  const r = await post('/v1/invoices', { chainId: CHAIN, invoice: toWireInvoice(invoice), merchantSig });
  expect(r.status).toBe(201);
  return r.body.shortCode as string;
}

async function newPayer() {
  const payer = privateKeyToAccount(generatePrivateKey());
  const f = await post('/v1/faucet', { chainId: CHAIN, address: payer.address });
  expect(f.status).toBe(200);
  return payer;
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  const env = loadEnv({
    ...process.env,
    NODE_ENV: 'test', MONGODB_URI: mongo.getUri(), ENABLED_CHAINS: '31337', ADMIN_TOKEN: 'e2e-admin-token-123456',
    OPERATOR_PRIVATE_KEY_LOCAL: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    ATTACK_LAB_ENABLED: 'true', PUBLIC_APP_URL: 'http://localhost:3000', ENVIO_GRAPHQL_URL: '', AURORA_API_KEY: '', ONECLICK_JWT: '',
  });
  ({ app, close } = await boot(env, { listen: false, worker: true }));
}, 60_000);

afterAll(async () => {
  await close();
  await mongo.stop();
});

describe('e2e on anvil', () => {
  it('config exposes local features', async () => {
    const r = await get('/v1/config');
    expect(r.body.chains[0].features).toMatchObject({ direct: true, swap: true, crosschain: 'simulated', faucet: true, attackLab: true });
  });

  it('DIRECT: prepare -> sign -> submit -> SETTLED -> VERIFIED', async () => {
    const m = await newMerchant();
    const code = await newInvoice(m, 12_000_000n);
    const payer = await newPayer();
    const prep = (await post('/v1/intents/prepare', { shortCode: code, route: 'DIRECT', payer: payer.address })).body;
    const intent = fromWireIntent(prep.intent);
    const payerSig = await payer.signTypedData(buildIntentTypedData(CHAIN, prep.vault, intent));
    const receiveAuthSig = await payer.signTypedData(buildReceiveAuthTypedData(
      CHAIN, { address: prep.signing.receiveAuth.token, eip712: prep.signing.receiveAuth.domain },
      receiveAuthForIntent(intent, intentDigest(CHAIN, prep.vault, intent), prep.vault)));
    const s = await post('/v1/intents/submit', { draftId: prep.draftId, payerSig, receiveAuthSig }, { 'idempotency-key': prep.draftId });
    expect(s.status).toBe(200);
    expect(s.body.lifecycle).toBe('SETTLED');
    expect((await get(`/v1/invoices/${code}`)).body.state).toBe('PAID');
    const v = (await get(`/v1/verify/${CHAIN}/${prep.intentId}`)).body;
    expect(v.verdict).toBe('VERIFIED');
    // paying the same invoice again is refused before any tx
    const again = await post('/v1/intents/prepare', { shortCode: code, route: 'DIRECT', payer: payer.address });
    expect(again.body.error.code).toBe('INVOICE_ALREADY_PAID');
  });

  it('SWAP: tMON -> tUSDC with one-time approve', async () => {
    const m = await newMerchant();
    const code = await newInvoice(m, 12_000_000n);
    const payer = await newPayer();
    const prep = (await post('/v1/intents/prepare', { shortCode: code, route: 'SWAP', inputTokenKey: 'MON', payer: payer.address })).body;
    expect(prep.swap.needsApproval).toBe(true);
    const w = createWalletClient({ account: payer, chain: foundry, transport: http('http://127.0.0.1:8545') });
    await w.writeContract({ address: getToken(CHAIN, 'MON').address, abi: erc20Abi, functionName: 'approve', args: [prep.vault, maxUint256] });
    const payerSig = await payer.signTypedData(buildIntentTypedData(CHAIN, prep.vault, fromWireIntent(prep.intent)));
    const s = await post('/v1/intents/submit', { draftId: prep.draftId, payerSig }, { 'idempotency-key': prep.draftId });
    expect(s.body.lifecycle).toBe('SETTLED');
  });

  it('CROSSCHAIN (simulated): commit -> solver delivery -> watcher settles -> AUSD payout', async () => {
    const m = await newMerchant('AUSD');
    const code = await newInvoice(m, 5_000_000n);
    const payer = await newPayer();
    const prep = (await post('/v1/intents/prepare', { shortCode: code, route: 'CROSSCHAIN', payer: payer.address, origin: { assetId: 'simulated:base:usdc', refundTo: payer.address } })).body;
    const payerSig = await payer.signTypedData(buildIntentTypedData(CHAIN, prep.vault, fromWireIntent(prep.intent)));
    const s = await post('/v1/intents/submit', { draftId: prep.draftId, payerSig }, { 'idempotency-key': prep.draftId });
    expect(s.body.lifecycle).toBe('AWAITING_DEPOSIT');
    expect(s.body.forwarder).toBe(prep.crosschain.forwarder);
    const dep = await post(`/v1/intents/${CHAIN}/${prep.intentId}/simulate-deposit`, {});
    expect(dep.status).toBe(200);
    await waitFor(async () => (await get(`/v1/intents/${CHAIN}/${prep.intentId}`)).body.lifecycle === 'SETTLED');
    const v = (await get(`/v1/verify/${CHAIN}/${prep.intentId}`)).body;
    expect(v.verdict).toBe('VERIFIED');
  }, 40_000);

  it('Attack Lab: all 8 scenarios are BLOCKED with the expected revert', async () => {
    const list = (await get(`/v1/attack-lab/scenarios?chainId=${CHAIN}`)).body.scenarios as { id: string; expectedError: string }[];
    expect(list).toHaveLength(8);
    for (const s of list) {
      const r = (await post('/v1/attack-lab/run', { chainId: CHAIN, scenario: s.id })).body;
      expect(r.outcome, s.id).toBe('BLOCKED');
      expect(r.observed.errorName, s.id).toBe(s.expectedError);
    }
  }, 120_000);

  it('rejects a tampered payer signature off-chain (no tx)', async () => {
    const m = await newMerchant();
    const code = await newInvoice(m, 1_000_000n);
    const payer = await newPayer();
    const other = privateKeyToAccount(generatePrivateKey());
    const prep = (await post('/v1/intents/prepare', { shortCode: code, route: 'DIRECT', payer: payer.address })).body;
    const bad = await other.signTypedData(buildIntentTypedData(CHAIN, prep.vault, fromWireIntent(prep.intent)));
    const s = await post('/v1/intents/submit', { draftId: prep.draftId, payerSig: bad, receiveAuthSig: bad }, { 'idempotency-key': `${prep.draftId}-x` });
    expect(s.status).toBe(422);
    expect(s.body.error.code).toBe('INVALID_PAYER_SIGNATURE');
  });
});
```

**File: `services/api/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 60_000 } });
```

**Commands**

```bash
pnpm chain:local                      # terminal 1 (fresh anvil)
pnpm --filter @scanpay/api test:e2e   # terminal 2
```

**Exit checks**
- [ ] 6 e2e tests pass on a fresh anvil
- [ ] Run twice in a row without restarting anvil → still pass (no state assumptions)
- [ ] Paste the summary into `docs/txt/test-summary.txt` (A puts the totals in the README)

**Commit:** `test(api): end-to-end flows + attack lab against anvil`

---

### Phase B30 — Deploy to Railway → **I5**

**Goal:** a public HTTPS API for the FE and judges, configured for testnet (mainnet added at B31).
**Time:** 45 min. **Depends on:** B29, I2, I3.

**File: `services/api/Dockerfile`**

```dockerfile
FROM node:22-slim
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY . .
# install only the API and its workspace deps (shared); devDeps included because we run via tsx
RUN pnpm install --frozen-lockfile --filter "@scanpay/api..."
ENV NODE_ENV=production
EXPOSE 8787
CMD ["pnpm", "--filter", "@scanpay/api", "start"]
```

**File: `.dockerignore`** (repo root — send A a PR since A owns root files)

```text
**/node_modules
contracts/out
contracts/cache
contracts/lib
contracts/broadcast
indexer/generated
indexer/build
apps/web/.next
.git
.env
```

**Railway setup**

1. New project → Deploy from GitHub repo `scanpay-guard` → Settings:
   - Root directory: `/` (repo root) · Builder: **Dockerfile** · Dockerfile path: `services/api/Dockerfile`
   - Healthcheck path: `/health` · Restart policy: on failure
2. Variables:

| Var | Value |
|---|---|
| `MONGODB_URI` | Atlas URI |
| `ENABLED_CHAINS` | `10143` (→ `10143,143` at B31) |
| `OPERATOR_PRIVATE_KEY_TESTNET` | testnet operator key |
| `OPERATOR_PRIVATE_KEY_MAINNET` | (B31) |
| `MONAD_TESTNET_RPC` / `MONAD_MAINNET_RPC` | `https://testnet-rpc.monad.xyz` / `https://rpc.monad.xyz` |
| `ADMIN_TOKEN` | random 32 chars (share with FE privately for the admin page) |
| `AURORA_API_KEY` / `ONECLICK_JWT` | from B0 |
| `ENVIO_GRAPHQL_URL` | from A's I3 message |
| `PUBLIC_APP_URL` | FE Vercel URL (exact, no trailing slash) |
| `CORS_ORIGINS` | `https://<vercel-app>,http://localhost:3000` |
| `ATTACK_LAB_ENABLED` | `true` |
| `PORT` | `8787` (Railway also injects `PORT`; ours reads it) |

3. Generate a domain (`*.up.railway.app`). Deploy.

**Commands**

```bash
API=https://<your>.up.railway.app
curl -s $API/health | jq
curl -s $API/v1/config | jq '.chains[] | {chainId, features}'
API=$API pnpm --filter @scanpay/api exec tsx scripts/dev-pay-direct.ts 10143     # real testnet payment through Railway
curl -s -X POST $API/v1/attack-lab/run -H 'content-type: application/json' -d '{"chainId":10143,"scenario":"replay","broadcast":true}' | jq
```

**Exit checks**
- [ ] `/health` → `ok:true`, chain 10143 block number, operator balance
- [ ] `dev-pay-direct.ts 10143` against Railway → `SETTLED`; `/v1/merchants/10143/<id>/payments` → `source:"envio"` within ~10 s
- [ ] Replay broadcast tx visible as failed on testnet.monadscan.com
- [ ] Railway logs show the follower and cross-chain loop running

**Commit:** `chore(api): Dockerfile + Railway deployment`

### ✅ Checkpoint **I5** — post in team chat

```
I5 READY — API
NEXT_PUBLIC_API_URL=https://<your>.up.railway.app
GET /v1/config → chains [10143] (+143 after mainnet runbook)
Contract: @scanpay/shared api.ts (zod) — see Backend B Part IV for every endpoint
SSE: /v1/merchants/:chainId/:merchantId/stream, /v1/intents/:chainId/:intentId/stream, /v1/invoices/:code/stream, /v1/invoice-requests/:id/stream
Admin token: sent privately
```

---

### Phase B31 — Mainnet: read-only smoke, then the live proof payments

**Goal:** enable chain 143 and produce the mainnet evidence: one real Aurora cross-chain payment (Base USDC → Monad,
merchant paid in AUSD via Kuru) and one DIRECT USDC payment. **Time:** 2 h. **Depends on:** I4, B30.

#### B31.1 Read-only smoke (the I4 acceptance command)

**File: `services/api/scripts/smoke-mainnet-readonly.ts`**

```ts
// pnpm --filter @scanpay/api smoke:mainnet-readonly
import { createPublicClient, domainSeparator, http, keccak256, parseAbi, toBytes, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monad } from 'viem/chains';
import { getDeployment, intentVaultAbi } from '@scanpay/shared';
import { configureAurora, originAssets, auroraQuote } from '../src/services/aurora';

const d = getDeployment(143);
const pub = createPublicClient({ chain: monad, transport: http(process.env.MONAD_MAINNET_RPC ?? 'https://rpc.monad.xyz') });
const results: [string, boolean, string][] = [];
const check = async (label: string, fn: () => Promise<[boolean, string]>) => {
  try {
    const [ok, detail] = await fn();
    results.push([label, ok, detail]);
  } catch (e) {
    results.push([label, false, (e as Error).message.slice(0, 160)]);
  }
};
const roleAbi = parseAbi(['function hasRole(bytes32,address) view returns (bool)', 'function DOMAIN_SEPARATOR() view returns (bytes32)']);
const vault = d.contracts.IntentVault.address;
const registry = d.contracts.MerchantRegistry.address;

await check('RPC reachable', async () => [true, `block ${await pub.getBlockNumber()}`]);
await check('operator key matches deployment', async () => {
  const pk = process.env.OPERATOR_PRIVATE_KEY_MAINNET as `0x${string}` | undefined;
  if (!pk) return [false, 'OPERATOR_PRIVATE_KEY_MAINNET missing'];
  const a = privateKeyToAccount(pk).address;
  return [a.toLowerCase() === d.roles.operator.toLowerCase(), a];
});
await check('operator MON balance ≥ 1', async () => {
  const b = await pub.getBalance({ address: d.roles.operator });
  return [b >= 10n ** 18n, `${Number(b) / 1e18} MON`];
});
await check('operator has VERIFIER_ROLE', async () => [
  (await pub.readContract({ address: registry, abi: roleAbi, functionName: 'hasRole', args: [keccak256(toBytes('VERIFIER_ROLE')), d.roles.operator] })) as boolean, registry,
]);
await check('operator has ATTESTER_ROLE', async () => [
  (await pub.readContract({ address: vault, abi: roleAbi, functionName: 'hasRole', args: [keccak256(toBytes('ATTESTER_ROLE')), d.roles.operator] })) as boolean, vault,
]);
await check('vault cross-chain input = USDC', async () => {
  const t = (await pub.readContract({ address: vault, abi: intentVaultAbi, functionName: 'crossChainInputToken' })) as Address;
  return [t.toLowerCase() === d.tokens.USDC!.address.toLowerCase(), t];
});
for (const key of ['USDC', 'AUSD'] as const) {
  const t = d.tokens[key];
  if (!t?.supports3009 || !t.eip712) continue;
  await check(`${key} EIP-712 domain (name/version in deployments) matches token`, async () => {
    const onchain = (await pub.readContract({ address: t.address, abi: roleAbi, functionName: 'DOMAIN_SEPARATOR' })) as string;
    const ours = domainSeparator({ domain: { name: t.eip712!.name, version: t.eip712!.version, chainId: 143, verifyingContract: t.address } });
    return [onchain.toLowerCase() === ours.toLowerCase(), `${t.eip712!.name} v${t.eip712!.version}`];
  });
}
configureAurora(process.env.AURORA_API_KEY, process.env.ONECLICK_JWT);
await check('Aurora tokens include Base USDC', async () => {
  const a = await originAssets();
  return [a.some((x) => x.blockchain === 'base' && x.symbol === 'USDC'), `${a.length} origin assets`];
});
await check('Aurora dry quote Base USDC → Monad USDC (1.00) to a forwarder-shaped recipient', async () => {
  const base = (await originAssets()).find((x) => x.blockchain === 'base' && x.symbol === 'USDC')!;
  const q = await auroraQuote({ dry: true, originAsset: base.assetId, refundTo: d.roles.operator, recipient: vault, destinationAsset: d.external.auroraMonadUsdcAssetId!, amountOut: 1_000_000n });
  return [q.amountIn !== null, `amountIn ${q.amountIn}`];
});
if (d.contracts.SwapAdapter.kind === 'kuru') {
  await check('Kuru quote USDC → AUSD routes through an allow-listed target', async () => {
    const tok = await fetch(`${d.external.kuruFlowApi}/api/generate-token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_address: d.contracts.SwapAdapter.address }) }).then((r) => r.json() as any);
    await new Promise((r) => setTimeout(r, 1100));
    const q = await fetch(`${d.external.kuruFlowApi}/api/quote`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok.token}` },
      body: JSON.stringify({ userAddress: d.contracts.SwapAdapter.address, tokenIn: d.tokens.USDC!.address, tokenOut: d.tokens.AUSD!.address, amount: '1000000', slippageTolerance: 50 }),
    }).then((r) => r.json() as any);
    const to = String(q.transaction?.to ?? '').toLowerCase();
    return [d.external.kuruTargets.map((x) => x.toLowerCase()).includes(to), `out ${q.output} → ${to}`];
  });
}
if (process.env.ENVIO_GRAPHQL_URL) {
  await check('Envio indexes chain 143', async () => {
    const r = await fetch(process.env.ENVIO_GRAPHQL_URL!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ ProtocolStat(where:{id:{_eq:"143"}}){ id } }' }) }).then((x) => x.json() as any);
    return [!r.errors, JSON.stringify(r.data ?? r.errors).slice(0, 80)];
  });
}

for (const [label, ok, detail] of results) console.log(`${ok ? '✅' : '❌'} ${label} — ${detail}`);
process.exit(results.every((r) => r[1]) ? 0 : 1);
```

> The `DOMAIN_SEPARATOR` check is the single most important mainnet check: it proves the `eip712.name/version`
> A wrote into `143.json` are exactly what USDC/AUSD use, so DIRECT signatures will be accepted.

#### B31.2 Enable mainnet on Railway

Set `OPERATOR_PRIVATE_KEY_MAINNET`, `ENABLED_CHAINS=10143,143`, redeploy. Check `/v1/config` lists 143 with
`features.crosschain:"live"`, `faucet:false`, `attackLab:false`.

#### B31.3 Live proof runbook (do it together with FE on phones; record the screen)

| # | Step | Who | Expected |
|---|---|---|---|
| 1 | `smoke:mainnet-readonly` all ✅ | B | exit 0 |
| 2 | Merchant onboarding on mainnet in the PWA (real Mera passkey on a phone; payout token **AUSD**) | FE + teammate | `POST /v1/merchants/register` → `PENDING` |
| 3 | Admin approves (admin page or `curl -X POST $API/v1/admin/merchants/143/<id>/approve -H "authorization: Bearer $ADMIN_TOKEN"`) | B | `ACTIVE` |
| 4 | Merchant creates a **2.00 AUSD** invoice (≤ cap 25) | teammate | QR shown |
| 5 | Customer scans → **Pay from another chain** → Base · USDC → app shows deposit address + amount (≈ 2.01 USDC) | teammate 2 | `AWAITING_DEPOSIT`; forwarder deployed (commit tx) |
| 6 | Customer sends that USDC on Base to the deposit address (any Base wallet) and pastes/auto-posts the tx hash | teammate 2 | `PROCESSING`; Aurora status `KNOWN_DEPOSIT_TX` → `SUCCESS` |
| 7 | Watcher sees forwarder balance ≥ required → `settleCrossChain` with Kuru USDC→AUSD swapData | B (automatic) | `SETTLED`; merchant phone flips to "Paid ✓" |
| 8 | Worker attests the Base source tx | automatic | `txs.attest` set; verify page shows "chain 8453 · 0x…" |
| 9 | DIRECT proof: second invoice **1.00 USDC** to a USDC merchant (or the same merchant after a payout update), customer pays with Monad USDC (needs ≥ 1 USDC on Monad in their Mera account — send it from an exchange/bridge beforehand) | team | `SETTLED` in one tx |
| 10 | Copy every tx hash into the README proof table (send to A) + Aurora explorer link `https://explorer.near-intents.org/?depositAddress=<addr>` | B | |

**If something goes wrong on mainnet**

| Symptom | Action |
|---|---|
| Aurora quote fails / no deposit address | retry; switch to 1Click (`AURORA_API_KEY=` empty, `ONECLICK_JWT` set); last resort: present testnet simulated flow + mainnet DIRECT |
| Deposit arrived but settle reverts `SWAP_OUTPUT_TOO_LOW` | watcher retries with a fresh Kuru quote every tick; if persistent, A can `setAmountCap` / you can wait; funds are safe in the forwarder |
| `UNDERPAID` (solver delivered less) | wait for a top-up or let the refund window open (expiresAt + 3600) — the watcher refunds automatically |
| Anything unexplained | A pauses the vault (`cast send <vault> "pause()"`); refunds still work while paused |

**Exit checks**
- [ ] `smoke:mainnet-readonly` → exit 0 (send screenshot to A: this is I4 acceptance)
- [ ] One mainnet cross-chain payment `SETTLED` with `verdict:"VERIFIED"` and an attested source tx
- [ ] One mainnet DIRECT payment `SETTLED`
- [ ] README proof table rows filled (via A)

**Commit:** `chore(api): mainnet smoke script + runbook evidence`

---

## Part IV — API reference (§B-API)

Base URL: `NEXT_PUBLIC_API_URL`. All bodies JSON. Schemas are the zod objects in `@scanpay/shared/src/api.ts`
(names in the table). Wire rule: uint256/uint64 → decimal string, uint8/uint32 → number, hex lowercase.

**Error body (every non-2xx):**

```json
{ "error": { "code": "REPLAY_BLOCKED", "message": "This payment was already used.", "details": { "errorName": "NonceAlreadyUsed", "args": ["0x…", "5"] }, "requestId": "uuid" } }
```

**Headers:** `Idempotency-Key` (required on `/v1/intents/submit`, optional on other POSTs — use the `draftId` or a
UUID); `Authorization: Bearer <ADMIN_TOKEN>` on `/v1/admin/*`.

| # | Method & path | Auth | Request (zod) | Response (zod) | Main errors |
|---|---|---|---|---|---|
| 1 | `GET /health` | – | – | `zHealthRes` | – |
| 2 | `GET /v1/config` | – | – | `zConfigRes` | – |
| 3 | `GET /v1/fx?quote=INR` | – | query | `zFxRes` | `PROVIDER_UNAVAILABLE` |
| 4 | `POST /v1/merchants/register` | – | `zRegisterReq` | `zRegisterRes` | `PROFILE_HASH_MISMATCH`, `BAD_NONCE`, `INVALID_OWNER_SIGNATURE`, `INVALID_PAYOUT_SIGNATURE`, `MERCHANT_EXISTS`, `PAYOUT_TOKEN_NOT_ALLOWED`, `SIGNATURE_EXPIRED` |
| 5 | `POST /v1/merchants/rotate-signer` | – | `zRotateReq` | `zKeyChangeRes` | `BAD_NONCE`, `INVALID_OWNER_SIGNATURE`, `MERCHANT_REVOKED` |
| 6 | `POST /v1/merchants/update-payout` | – | `zPayoutReq` | `zKeyChangeRes` | + `INVALID_PAYOUT_SIGNATURE` |
| 7 | `GET /v1/merchants/:chainId/:merchantId` | – | params | `zMerchantView` | `MERCHANT_NOT_FOUND` |
| 8 | `GET /v1/merchants/by-owner/:chainId/:owner` | – | params | `zMerchantsRes` | – |
| 9 | `GET /v1/merchants/:chainId/:merchantId/payments?limit&offset` | – | query | `zPaymentsRes` | – |
| 10 | `GET /v1/merchants/:chainId/:merchantId/stats?days` | – | query | `zStatsRes` | – |
| 11 | `GET /v1/merchants/:chainId/:merchantId/keys` | – | – | `zKeyEventsRes` | – |
| 12 | `GET /v1/merchants/:chainId/:merchantId/invoices` | – | – | `zInvoiceListRes` | – |
| 13 | `GET /v1/merchants/:chainId/:merchantId/invoice-requests` | – | – | `zInvoiceRequestListRes` | – |
| 14 | `GET /v1/merchants/:chainId/:merchantId/stream` | – | SSE | events `payment.settled`, `merchant.updated`, `invoice_request.created`, `ping` | – |
| 15 | `GET /v1/admin/merchants?chainId&status` | admin | query | `zMerchantsRes` | `UNAUTHORIZED` |
| 16 | `POST /v1/admin/merchants/:chainId/:merchantId/:action` (`approve`/`reactivate`/`suspend`/`revoke`) | admin | params | `zAdminActionRes` | `INVALID_STATUS_TRANSITION` |
| 17 | `GET /v1/admin/audit?limit` | admin | query | `{items}` | – |
| 18 | `POST /v1/invoices` | – | `zCreateInvoiceReq` | `zInvoiceCreatedRes` (201) | `MERCHANT_NOT_ACTIVE`, `MERCHANT_KEYS_CHANGED`, `INVALID_MERCHANT_SIGNATURE`, `AMOUNT_ABOVE_CAP`, `INVOICE_EXPIRED` |
| 19 | `GET /v1/invoices/:shortCode` | – | – | `zInvoiceView` | `INVOICE_NOT_FOUND` |
| 20 | `GET /v1/invoices/:shortCode/stream` | – | SSE | `invoice.updated` | – |
| 21 | `POST /v1/invoice-requests` | – | `zInvoiceRequestReq` | `zInvoiceRequestRes` (201) | `MERCHANT_NOT_ACTIVE` |
| 22 | `GET /v1/invoice-requests/:requestId` | – | – | `zInvoiceRequestRes` | `NOT_FOUND` |
| 23 | `GET /v1/invoice-requests/:requestId/stream` | – | SSE | `invoice.updated` (when fulfilled) | – |
| 24 | `GET /v1/qr/resolve?data=` | – | query | `zQrResolveRes` | – |
| 25 | `GET /v1/routes?shortCode=` | – | query | `zRoutesRes` | `INVOICE_*`, `MERCHANT_*` |
| 26 | `POST /v1/quotes` | – | `zQuoteReq` | `zQuoteRes` | `ROUTE_UNAVAILABLE`, `QUOTE_FAILED`, `PROVIDER_UNAVAILABLE` |
| 27 | `POST /v1/intents/prepare` | – | `zPrepareReq` | `zPrepareRes` (201) | as 25/26 |
| 28 | `POST /v1/intents/submit` | Idempotency-Key | `zSubmitReq` | `zSubmitRes` | `DRAFT_EXPIRED`, `INVALID_PAYER_SIGNATURE`, `TOKEN_AUTHORIZATION_FAILED`, `ALLOWANCE_REQUIRED`, `INSUFFICIENT_BALANCE`, `SWAP_OUTPUT_TOO_LOW`, every contract code |
| 29 | `GET /v1/intents/:chainId/:intentId` | – | – | `zIntentView` | `INTENT_NOT_FOUND` |
| 30 | `GET /v1/intents/:chainId/:intentId/stream` | – | SSE | `intent.updated` | – |
| 31 | `POST /v1/intents/:chainId/:intentId/source-tx` | – | `zSourceTxReq` | `{ok, providerStatus}` | `WRONG_STATE` |
| 32 | `POST /v1/intents/:chainId/:intentId/simulate-deposit` | – (testnet) | `zSimulateDepositReq` | `zTxRes` | `TESTNET_ONLY`, `WRONG_STATE` |
| 33 | `GET /v1/verify/:chainId/:intentId` | – | – | `zVerifyRes` | – |
| 34 | `GET /v1/allowance?chainId&token&owner` | – | query | `zAllowanceRes` | – |
| 35 | `POST /v1/gas/drip` | – | `zDripReq` | `zDripRes` | `DRIP_NOT_NEEDED`, `FAUCET_LIMIT` |
| 36 | `POST /v1/faucet` | – (testnet) | `zFaucetReq` | `zFaucetRes` | `TESTNET_ONLY`, `FAUCET_LIMIT` |
| 37 | `GET /v1/attack-lab/scenarios?chainId` | – (testnet) | query | `zScenariosRes` | `ATTACK_LAB_DISABLED` |
| 38 | `POST /v1/attack-lab/run` | – (testnet) | `zAttackRunReq` | `zAttackResult` | `ATTACK_LAB_DISABLED` |
| 39 | `POST /v1/providers/aurora/webhook` | – | any | `{received:true}` | – |
| 40 | `GET /v1/stats/:chainId` | – | – | `zProtocolStatsRes` | – |

**SSE format:** `event: <type>\ndata: <json SseEvent>\n\n`; heartbeat `ping` every 15 s. Reconnect with
`EventSource` defaults; after reconnect, fetch the REST resource once to resync.

**Customer happy paths (FE sequence)**

```
DIRECT      GET /v1/qr/resolve → GET /v1/invoices/:code → GET /v1/routes → POST /v1/intents/prepare{DIRECT}
            → sign intent + receiveAuth → POST /v1/intents/submit → (SETTLED in response) → GET /v1/verify
SWAP        … prepare{SWAP,inputTokenKey} → [needsApproval: POST /v1/gas/drip if dripAvailable → approve tx]
            → sign intent → submit → SETTLED
CROSSCHAIN  … POST /v1/quotes (preview per origin asset) → prepare{CROSSCHAIN,origin} → sign intent → submit (AWAITING_DEPOSIT)
            → show deposit address/amount → customer pays on source chain → POST source-tx → SSE intent.updated … SETTLED
            (testnet: "Simulate solver delivery" → POST simulate-deposit)
Static QR   GET /v1/qr/resolve (merchant) → POST /v1/invoice-requests → SSE /v1/invoice-requests/:id/stream
            (merchant terminal gets invoice_request.created → signs → POST /v1/invoices{requestId}) → shortCode → DIRECT/SWAP/CC
```

---

## Part V — Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Boot: "Operator key for X is … but roles.operator is …" | wrong key for that chain, or A deployed with another `OPERATOR_ADDRESS` | use the key whose address A used; or A re-grants roles to your address |
| Boot: "No deployments/X.json" | I1/I2 not pulled | `git pull && pnpm install`; local: `pnpm chain:local` |
| Every relayed tx fails `CHAIN_REVERT` with `AccessControlUnauthorizedAccount` | operator lacks VERIFIER/ATTESTER/MINTER | A: `cast send <registry> "grantRole(bytes32,address)" $(cast keccak VERIFIER_ROLE) <operator>` |
| `INVALID_MERCHANT_SIGNATURE` for invoices that FE signed | FE used wrong vault address or chainId in the domain | FE must use `zPrepareRes.vault`/`deployment.contracts.IntentVault.address` and the invoice's chainId |
| `TOKEN_AUTHORIZATION_FAILED` on DIRECT | receiveAuth not bound to the intent digest, or wrong token domain | use `receiveAuthForIntent(intent, intentDigest(...), vault)` and `signing.receiveAuth.domain` |
| DIRECT on mainnet always fails | wrong `eip712` name/version in `143.json` | run `smoke:mainnet-readonly`; A fixes `143.json` + `deployments:build` (no redeploy) |
| `insufficient funds for gas * price + value` | operator out of MON | fund operator; `/health` shows the balance |
| Nonce too low / replacement underpriced | two API instances share one operator key | run exactly **one** Railway replica |
| Follower spams "follower error … range" | RPC log-range cap | it halves automatically; if stuck at 1, switch RPC (`rpc-testnet.monadinfra.com`) |
| Payments list shows `source:"db"` on testnet | Envio URL unset/down | check `ENVIO_GRAPHQL_URL`; fallback is by design |
| SSE disconnects every ~60 s on Railway | proxy idle timeout | heartbeat is 15 s; ensure no compression middleware buffers the stream |
| CORS error on EventSource | origin not in `CORS_ORIGINS` | add exact origin (scheme + host, no trailing slash) |
| Kuru `QUOTE_FAILED 429` | 1 RPS limit | `spaced()` enforces 1.1 s; don't run two instances |
| Aurora `PROVIDER_UNAVAILABLE 401/403` | bad key | regenerate in studio.aurora.dev; or use `ONECLICK_JWT` |
| Cross-chain stuck `PROCESSING`, forwarder empty, provider `SUCCESS` | solver delivered elsewhere | watcher marks `RECONCILIATION_REQUIRED` after 90 s; refund opens at `expiresAt + refundDelay` |
| `UNDERPAID` on AUSD payout | Aurora delivered `amountOut` but `maxAmountIn` included the 0.3% swap buffer | expected only if the quote was for the wrong amount — B always requests `maxAmountIn`; check `quote.fields.maxAmountIn` vs Aurora request |
| Attack Lab `NOT_BLOCKED` | scenario built an accidentally valid tx (state drift) | rerun; if persistent it's a real bug — stop and tell A |
| e2e fails on 2nd run | anvil state from a previous suite | tests are state-independent; restart anvil if deployments changed |

---

## Part VI — Final checklist (Backend B)

**Code**
- [x] `pnpm --filter @scanpay/api typecheck` clean — 0 errors
- [x] 42 tests pass — 7 unit (`test/unit/errors.test.ts`) + 35 integration (`test/integration/app.test.ts`)
- [x] No private keys in git; `.env` ignored; `LabState` only on testnet/local (code-enforced)

**Behavior**
- [x] Only `PaymentSettled` writes `SETTLED` (`services/settlement.ts` `applyLog` is the only writer)
- [x] Every relayed tx uses `relay()` (`relayer.ts` — simulate → estimateGas×1.2 → send)
- [x] All contract errors map to friendly codes (`errors.ts` `decodeChainError` + `CONTRACT_ERROR_TO_CODE`)
- [x] Faucet/attack lab/simulated deposits return 403 on chain 143 (`features.attackLab` is false on mainnet deployment)

**Deployment**
- [x] `railway.toml` at repo root — nixpacks build, healthcheck on `/health`, restart on failure
- [ ] Railway service live: set `ENABLED_CHAINS=10143` after Backend A deploys testnet contracts
- [ ] Operator balances: testnet ≥ 3 MON (check `/health` before the video)
- [ ] `NEXT_PUBLIC_API_URL` given to FE; admin token shared privately

**Evidence (to A for README)**
- [ ] Testnet: DIRECT, SWAP, simulated CROSSCHAIN, Attack Lab replay (broadcast) tx hashes
- [ ] `INTENT_ID=0x... pnpm verify-receipt` output for one testnet payment
- [ ] API section for README: endpoints summary (Part IV table link), trust notes

**Handoffs**
- [ ] I5 posted; FE confirmed `/v1/config` works from the Vercel origin

---

## Part VII — Implementation log (what was actually built)

All phases B0 – B25 are implemented. Files are under `services/api/` unless noted.

### Shared package additions (`packages/shared/src/`)

| File | What B owns |
|---|---|
| `a-stubs.ts` | ABIs (`intentVaultAbi`, `merchantRegistryAbi`, `erc20Abi`, etc.), deployment configs for 31337/10143, all typed-data builders, `computeMerchantId`, `computeIntentId`, `quoteHash`, `intentDigest`, `profileHash`, constants |
| `api.ts` | Zod schemas for every request/response shape + `export type TokenKey` |
| `canonical.ts` | `fromWireIntent`, `fromWireInvoice`, `toWireIntent` converters |
| `quote-hash.ts` | `quoteHash(fields)` |
| `errors.ts` | `API_ERROR` map, `CONTRACT_ERROR_TO_CODE`, `EXTRA_ERRORS_ABI` |

### HTTP layer (`src/http/`)

| File | Routes |
|---|---|
| `routes/health.ts` | `GET /health` |
| `routes/config.ts` | `GET /v1/config` |
| `routes/fx.ts` | `GET /v1/fx` |
| `routes/merchants.ts` | register, rotate-signer, update-payout, by-owner, get, payments, stats, keys, `/v1/stats/:chainId` |
| `routes/invoices.ts` | create, get by shortCode, list for merchant, invoice-requests CRUD, QR resolve |
| `routes/payments.ts` | routes, quotes, prepare, submit, intent by ID, simulate-deposit, source-tx, allowance, gas drip, faucet |
| `routes/stream.ts` | SSE streams for intent / merchant / invoice / invoice-request |
| `routes/verify.ts` | `GET /v1/verify/:chainId/:intentId` |
| `routes/attack.ts` | scenarios list, run, lab state |
| `routes/admin.ts` | merchant list + approve/suspend/revoke (Bearer auth) |
| `app.ts` | Fastify boot, CORS, rate-limit, error handler, not-found handler |
| `auth.ts` | `requireAdmin` |
| `idempotency.ts` | `withIdempotency` |
| `parse.ts` | Zod parse → 400 on failure |

### Services (`src/services/`)

| File | What it does |
|---|---|
| `merchants.ts` | `registerMerchant`, `rotateSigner`, `updatePayout`, `setStatus` — relay registry txs |
| `merchantReads.ts` | `getMerchantOr404`, `merchantsByOwner`, `merchantPayments`, `merchantStats`, `merchantKeys`, `protocolStats` |
| `invoices.ts` | `createInvoice`, `getInvoice`, `createInvoiceRequest`, `resolveQr` |
| `intents.ts` | `getRoutes`, `previewQuote`, `prepare` — build draft intent, compute intentId, store in DB |
| `quotes.ts` | `priceDirect`, `priceSwap`, `priceCrossChain`, `routesFor` |
| `submit.ts` | `submit` — validate payer sig, dispatch to submitDirect/Swap/CrossChain |
| `submitSwap.ts` | allowance check → fresh swap quote → `vault.paySwap` |
| `submitCrossChain.ts` | `vault.commitCrossChain`, `simulateDeposit`, `postSourceTx`, `readIntent` |
| `settlement.ts` | `pushLifecycle`, `applyLog` (decodes all vault + registry events), `applyReceipt` |
| `verify.ts` | 3-layer proof: merchant sig, intent sig + quoteHash + on-chain state + intentDigest, settlement |
| `views.ts` | `merchantView`, `invoiceView`, `intentView`, `paymentViewFromIntent`, `readMerchant` |
| `wallet.ts` | `gasDrip` (MON for approval), `faucet` (tUSDC/tAUSD mint) |
| `aurora.ts` | `auroraQuote`, `auroraSubmitDeposit`, `auroraStatus`, `originAssets`, `configureAurora` |
| `kuru.ts` | `kuruExactOut` |
| `fx.ts` | `usdTo` — frankfurter.app → open.er-api.com fallback → cached |
| `envio.ts` | GraphQL queries for HyperIndex; fallback to MongoDB |
| `payable.ts` | `loadPayable` — resolve shortCode → invoice + ctx |

### Worker (`src/worker/`)

| File | What it does |
|---|---|
| `follower.ts` | Per-chain log poller in 500-block batches; persists cursor in `Cursor` collection |
| `decide.ts` | Pure `decideCrossChain(doc, balance, now)` → `settle \| refund \| wait \| attest` |
| `crosschain.ts` | Every 15 s: open CC intents → `decideCrossChain` → relay settle/refund/attest; polls aurora status |
| `index.ts` | `startWorker()` / `stopWorker()` using `AbortController` |

### Attack Lab (`src/attack/`)

| File | What it does |
|---|---|
| `lab.ts` | `getLab`, `fundPayer`, `ensureMerchantRegistered`, `legitInvoice`, `legitIntent` — deterministic keys from `LabState` |
| `scenarios.ts` | 8 scenarios: `tamper_amount`, `tamper_destination`, `replay`, `expired`, `unregistered_qr`, `fake_provider_success`, `forged_settlement_hash`, `wrong_token` |

### Infrastructure

| File | What it does |
|---|---|
| `src/chains.ts` | `initChains`, `chainCtx`, `allChains`; `ChainCtx` interface with `chain`, `walletFrom`, `token`, `tokenByAddress`, `explorerTx/Address` |
| `src/relayer.ts` | `relay` (simulate → gas×1.2 → send → wait); `broadcastExpectRevert`; `throwDecoded` |
| `src/errors.ts` | `ApiError`, `decodeChainError` (returns `null` for unknown), `notFound`, `setDecodeAbi` |
| `src/db/models.ts` | All Mongoose schemas + indexes; TTL `expireAt` on draft intents |
| `src/db/connect.ts` | `connectDb`, `dbUp` |
| `src/env.ts` | `loadEnv` (zod), `operatorKeyFor` |
| `src/log.ts` | pino — pretty in dev, JSON in prod, redacts auth headers + private keys |
| `src/bus.ts` | In-process `EventEmitter` for SSE fan-out |
| `src/index.ts` | Full boot: DB → chains → aurora → envio → buildApp → listen → startWorker → SIGINT/SIGTERM |
| `railway.toml` | nixpacks build, `/health` healthcheck, restart policy |

### Scripts (`scripts/`)

| Script | Run with |
|---|---|
| `dev-register.ts` | `pnpm dev-register` — register a test merchant on local |
| `dev-rotate.ts` | `pnpm dev-rotate` — rotate invoice signer |
| `dev-invoice.ts` | `pnpm dev-invoice` — create invoice, print shortCode + QR URL |
| `dev-pay-direct.ts` | `pnpm dev-pay-direct` — full DIRECT flow (prepare → sign → submit → verify) |
| `dev-pay-swap.ts` | `pnpm dev-pay-swap` — full SWAP flow |
| `aurora-dry.ts` | `pnpm aurora-dry` — dry-run Aurora quote (needs `AURORA_API_KEY`) |
| `smoke-mainnet-readonly.ts` | `pnpm smoke:mainnet-readonly` — read-only health check against live chains |
| `verify-receipt.ts` | `INTENT_ID=0x... pnpm verify-receipt` — 3-layer proof against DB + chain |

### Tests

| Path | Count | What it covers |
|---|---|---|
| `test/unit/errors.test.ts` | 7 | `ApiError` HTTP codes, `decodeChainError` null returns, `notFound` |
| `test/integration/app.test.ts` | 35 | Every major endpoint via `app.inject()` — uses `mongodb-memory-server` + `vi.mock` for chain RPCs |

```
pnpm test              # unit only (fast, no MongoDB binary)
pnpm test:ci           # same — for CI pipelines
pnpm test:integration  # full integration suite
pnpm test:all          # all 42
```
