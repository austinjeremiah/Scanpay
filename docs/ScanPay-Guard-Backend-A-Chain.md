# ScanPay Guard — Backend A: Chain Layer (Contracts · Shared SDK · Deployments · Envio)

> **Scan. Verify. Pay. Know it arrived.**
> Monad Metropolis · Track 02 Consumer Products & Payments · build doc for the **Backend A** engineer.
> Companion docs: **Backend B — Services** (API, relayer, quotes, watcher) and **Frontend** (written next).

| | |
|---|---|
| Owner | Backend A (contracts + indexer + shared SDK) |
| You hand off to | Backend B at checkpoints **I0, I1, I2, I3, I4** (§0.13) |
| Deadline | **Tue 13 Oct 2026, 23:59 ET = Wed 14 Oct 09:29 IST** (submission form closes; video ≤ 3:00) |
| Your freeze | **Mon 12 Oct 22:00 IST** — no contract redeploys after this |
| Networks | local anvil (31337) → Monad testnet (10143) → Monad mainnet (143) |
| Stack | Foundry ≥ 1.8.0 (`network = "monad"`), Solidity 0.8.28, OpenZeppelin v5.1.0, Node 22, pnpm 9, viem ≥ 2.40, Envio HyperIndex v3 |

---

## Table of contents

- [Part I — Context you must read once](#part-i--context-you-must-read-once)
  - [I.1 What we are building (60-second version)](#i1-what-we-are-building-60-second-version)
  - [I.2 The three proofs and where each lives on-chain](#i2-the-three-proofs-and-where-each-lives-on-chain)
  - [I.3 Payment routes](#i3-payment-routes)
  - [I.4 Sponsor bounties this layer must satisfy](#i4-sponsor-bounties-this-layer-must-satisfy)
  - [I.5 Hackathon rules that affect your code](#i5-hackathon-rules-that-affect-your-code)
  - [I.6 Verified facts vs things you verify in Phase A2](#i6-verified-facts-vs-things-you-verify-in-phase-a2)
  - [I.7 Schedule](#i7-schedule)
- [Part II — Interface Control Document (shared with Backend B)](#0-interface-control-document-icd--identical-in-backend-a-and-backend-b)
- [Part III — Build phases A0 → A27](#part-iii--build-phases)
- [Part IV — Threat model → test mapping](#part-iv--threat-model--test-mapping)
- [Part V — Troubleshooting](#part-v--troubleshooting)
- [Part VI — Final checklist](#part-vi--final-checklist)

---

## Part I — Context you must read once

### I.1 What we are building (60-second version)

A customer scans a merchant's QR, sees **who** they are paying (verified on-chain), **what** they are paying (a
merchant-signed invoice), picks how to pay (a stablecoin on Monad, another Monad token, or a token on another chain
via Aurora Intents), approves with **Face ID** (a Mera passkey — no seed phrase, no extension, no gas), and the
merchant receives their chosen stablecoin (USDC or AUSD) on Monad. A Monad contract **enforces** that the money only
reaches the merchant if it matches exactly what the customer signed, and emits a receipt anyone can verify.

Your layer is the part that makes the guarantees real:

```
                          ┌──────────────────────── Monad ────────────────────────┐
 merchant app ─sign──►    │  MerchantRegistry      (proof of merchant)            │
 customer app ─sign──►    │  IntentVault           (proof of intent + settlement) │
 Backend B relayer ─tx──► │    ├─ payDirect   (EIP-3009, one tx)                  │
                          │    ├─ paySwap     (allowance + swap adapter, one tx)  │
 Aurora solver ─USDC───►  │    ├─ forwarder clone per intent (CREATE2)            │
                          │    ├─ settleCrossChain / refundCrossChain / rescue    │
                          │    └─ attestSource (operator-attested source tx)      │
                          │  SwapAdapter: MockSwapAdapter (test) / KuruFlowAdapter│
                          └───────────────────────────────────────────────────────┘
                                         │ events
                                         ▼
                               Envio HyperIndex (10143 + 143) ──► GraphQL ──► Backend B ──► app
```

### I.2 The three proofs and where each lives on-chain

| Proof | Question | Enforced by | Code |
|---|---|---|---|
| **Merchant** | Who am I paying? | `MerchantRegistry`: merchant registered with **owner sig + payout-wallet sig**, approved by verifier, `keyVersion` bumps on any key/payout change | A8 |
| **Intent** | What did I authorize? | `IntentVault._verify`: invoice signed by merchant's current invoice key; intent signed by payer; amounts/tokens/ids must match; expiry; one-time nonce; one-time invoice | A12 |
| **Settlement** | Where did the money go? | `IntentVault._settle`: pays the **snapshotted** payout wallet exactly `amountOut − fee`, refunds excess to payer, emits `PaymentSettled`. Cross-chain: the vault itself checks the forwarder balance — **no backend can mark a payment settled** | A12–A15 |

Trust boundary we state honestly in the README: on the cross-chain route, *which source-chain transaction funded the
deposit* is an **operator attestation** (`attestSource`). Everything that happens on Monad is contract-enforced.

### I.3 Payment routes

| Route | Customer pays with | Mechanism | Tx count | Gas paid by |
|---|---|---|---|---|
| `DIRECT` (0) | USDC or AUSD on Monad (same as merchant payout token) | Customer signs `PaymentIntent` + EIP-3009 `ReceiveWithAuthorization` whose **nonce = intent digest** → vault pulls exact amount | 1 relayed tx | Operator (Backend B) |
| `SWAP` (1) | Any allow-listed Monad token (tMON on testnet; WMON/WETH/USDC/AUSD on mainnet) | One-time `approve(vault)` by customer (operator drips dust MON for that one tx); then intent signature lets vault pull `maxAmountIn`, swap via adapter, pay exactly `amountOut`, refund excess | 1 relayed tx (+1 one-time approve) | Operator |
| `CROSSCHAIN` (2) | Any token Aurora quotes on Base/Arbitrum/Ethereum/Optimism/Polygon/BSC | Intent committed first → Aurora `EXACT_OUTPUT` quote whose **recipient = forwarder clone address** → solver delivers USDC → anyone calls `settleCrossChain` → vault checks balance, swaps to AUSD if needed, pays | 2 Monad txs (commit + settle) + customer's source-chain transfer | Operator on Monad; customer on source chain |

`CROSSCHAIN` works on **mainnet only** (Aurora/1Click have no testnet). On testnet the vault still accepts
`commitCrossChain` with `crossChainInputToken = tUSDC` so the **Attack Lab "fake provider success"** scenario runs.

### I.4 Sponsor bounties this layer must satisfy

| Bounty | What your layer contributes |
|---|---|
| Agora — Best Cross-Border Payments App ($10K) | AUSD is a first-class payout token; real AUSD on mainnet; `DIRECT` route uses AUSD's EIP-3009 if supported (A2 verifies) |
| Monad — Best Mera-Powered UX ($2.5K) | Contracts accept plain EOA signatures (Mera accounts) via `SignatureChecker`; zero gas for users |
| Monad — Mera: One Passkey, Many Keys ($2.5K) | Registry stores **role-separated keys**: `owner`, `payoutWallet`, `invoiceSigner` (+ rotation with `keyVersion`) — FE derives all from one passkey |
| Aurora Intents — Bring Any-Chain Liquidity ($5K) | Per-intent CREATE2 forwarder is the Aurora `recipient`; vault settles from it |
| Envio — Best Use of Envio ($1K) | Multichain HyperIndex powering merchant history, live feed, verify page |
| Track 02 judging: Monad Integration 20% | Contracts on testnet **and** mainnet, verified, real txs, "why Monad" section |

### I.5 Hackathon rules that affect your code

From the official Rules & Guidelines (v3.0) as quoted by public Metropolis repos (dashboard is login-gated):
- **Open source, OSI license, public GitHub** → `LICENSE` (MIT) at repo root in Phase A1.
- **Commit history across the build window** → commit at the end of every phase (commands included).
- **AI tool disclosure in README** → Phase A26.
- **Monad integration evidence**: contract addresses / tx hashes; mainnet or testnet; explain why Monad → A26.
- **Judges review non-confidentially** → never commit keys. Foundry keystore only; `.env` is git-ignored.

### I.6 Verified facts vs things you verify in Phase A2

Verified from official docs on 2026-10-10:

| Fact | Value | Source |
|---|---|---|
| Monad mainnet USDC | `0x754704Bc059F8C67012fEd69BC8A327a5aafb603`, 6 dec, Circle native | Monad token list, Circle |
| Monad mainnet AUSD | `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a`, 6 dec, LayerZero OFT; Agora docs: ERC-2612, ERC-3009, ERC-1271 | Monad token list, Agora docs |
| Monad mainnet WMON / WETH | `0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A` / `0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242` | Monad token list |
| Kuru mainnet Flow entrypoint / Flow router | `0xb3e6778480b2E488385E8205eA05E20060B813cb` / `0x0d3a1BE29E9dEd63c7a5678b31e847D68F71FFa2` | docs.kuru.io |
| Kuru Flow API | `POST https://ws.kuru.io/api/generate-token`, `POST /api/quote` → `transaction{to, calldata (no 0x), value}` | docs.monad.xyz Kuru guide |
| Aurora Monad USDC assetId | `nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx` | 1Click `/v0/tokens` (live) |
| AUSD **not** in Aurora/1Click token list | cross-chain always lands **USDC**; vault swaps to AUSD on Monad | 1Click `/v0/tokens` |
| Envio Monad HyperSync | chain 143 supported; testnet supported; `ENVIO_API_TOKEN` required | docs.envio.dev |
| USDC v2.2 | permit / transferWithAuthorization / **receiveWithAuthorization** accept ERC-1271 too | Circle blog |

Not verifiable from our research sandbox (RPC blocked) — **you verify in Phase A2 with `cast`**, and the doc gives the
fallback for each:

| Check | If it fails |
|---|---|
| USDC mainnet exposes `RECEIVE_WITH_AUTHORIZATION_TYPEHASH()` and `version()` | mainnet DIRECT disabled for USDC (`supports3009:false`) → customers use SWAP/CROSSCHAIN |
| AUSD mainnet exposes `RECEIVE_WITH_AUTHORIZATION_TYPEHASH()` | AUSD DIRECT disabled; AUSD stays payout-only |
| Kuru Flow entrypoint/router have code on 143 | mainnet SWAP + AUSD payout for cross-chain disabled; mainnet payout token = USDC only |
| Testnet: we **always** deploy our own `MockStableToken` (tUSDC, tAUSD) + `MockERC20` (tMON) + `MockSwapAdapter` | — (no dependency on stale post-reset testnet addresses) |

### I.7 Schedule

All times IST. Phases are small on purpose: each ends with **Exit checks** and a **commit**.

| Block | Phases | Ends with |
|---|---|---|
| Sat 16:30 → 21:00 | A0 – A7 | **I0** (interfaces + shared SDK + golden vectors) |
| Sat 21:00 → 01:30 | A8 – A11 | Registry + mocks + forwarder tested |
| Sun 08:00 → 13:00 | A12 – A15 | Vault complete, all routes tested |
| Sun 13:00 → 15:00 | A16 – A19 | Attack + fuzz suites, **I1** local, **I2** testnet |
| Sun 15:00 → 22:00 | A20 – A22 | **I3** Envio on testnet |
| Mon 09:00 → 14:00 | A23 – A25 | **I4** mainnet + Kuru smoke + Envio mainnet |
| Mon 14:00 → 22:00 | A26 – A27 | README evidence, freeze; then help FE/B with integration + video |

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
- **Exit checks** – all must pass before the commit. If one fails, fix it before moving on.
- **Commit** – exact message. Push after every commit (commit history is judged).

---

### Phase A0 — Machine setup and keys

**Goal:** every tool installed at the right version; deployer keystore created; operator address received from B.
**Time:** 20 min. **Depends on:** nothing.

**Commands**

```bash
# Foundry (official installer). Must be >= 1.8.0 for `network = "monad"`.
curl -L https://foundry.paradigm.xyz | bash
foundryup
forge --version          # forge Version: 1.8.x or newer

# Node 22 + pnpm 9
node --version           # v22.x
corepack enable
corepack prepare pnpm@9.12.0 --activate
pnpm --version           # 9.12.0

# Docker (only for Envio local dev, Phase A22)
docker --version
```

**Deployer key (you own it; never leaves your machine):**

```bash
cast wallet new                                   # prints Address + Private key — copy both somewhere safe offline
cast wallet import scanpay-deployer --interactive # paste the private key, set a password
cast wallet address --account scanpay-deployer    # prints your ADMIN_ADDRESS
```

**Operator key (Backend B owns it):** ask B for the **address only** of `OPERATOR_PRIVATE_KEY_TESTNET` and
`OPERATOR_PRIVATE_KEY_MAINNET`. They can be the same key for the hackathon. You need the address before A19.

**Fund (later, before A19/A23):**
- Testnet: `https://faucet.monad.xyz` → send MON to deployer address.
- Mainnet: ~3 MON to the deployer (deploy + config ≈ < 1 MON at the 100 MON-gwei min base fee; MON ≈ $0.025 → under $0.10).

**Exit checks**
- [ ] `forge --version` ≥ 1.8.0
- [ ] `node --version` is 22.x, `pnpm --version` is 9.x
- [ ] `cast wallet address --account scanpay-deployer` prints an address
- [ ] B has sent you the operator address(es)

**Commit:** nothing to commit.

---

### Phase A1 — Monorepo skeleton (you create it for everyone)

**Goal:** a pnpm workspace with every top-level folder, license, gitignore, env template.
**Time:** 25 min. **Depends on:** A0.

**Commands**

```bash
mkdir scanpay-guard && cd scanpay-guard
git init -b main
mkdir -p contracts indexer packages/shared/src/generated packages/shared/test-vectors packages/shared/scripts \
         services/api apps/web deployments/raw docs
```

**File: `package.json`**

```json
{
  "name": "scanpay-guard",
  "private": true,
  "packageManager": "pnpm@9.12.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "chain:anvil": "bash contracts/script/anvil.sh",
    "chain:deploy-local": "bash contracts/script/deploy-local.sh",
    "chain:local": "bash contracts/script/local-chain.sh",
    "contracts:build": "cd contracts && forge build",
    "contracts:test": "cd contracts && forge test -vv",
    "abis:export": "pnpm --filter @scanpay/contracts export:abis",
    "deployments:build": "pnpm --filter @scanpay/contracts build:deployments",
    "shared:test": "pnpm --filter @scanpay/shared test",
    "indexer:config": "pnpm --filter @scanpay/indexer gen:config"
  }
}
```

**File: `pnpm-workspace.yaml`**

```yaml
packages:
  - "contracts"
  - "indexer"
  - "packages/*"
  - "services/*"
  - "apps/*"
```

**File: `.gitignore`**

```gitignore
node_modules/
.env
.env.*
!.env.example
*.log
.DS_Store

# foundry
contracts/out/
contracts/cache/
contracts/broadcast/*/31337/
contracts/broadcast/**/dry-run/

# envio
indexer/generated/
indexer/.envio/
indexer/build/

# next
apps/web/.next/
apps/web/out/

# local deployments (anvil changes every restart) — testnet/mainnet ARE committed
deployments/31337.json
deployments/raw/31337.json
```

**File: `LICENSE`** — MIT (required: Rules §7.2 open source).

```text
MIT License

Copyright (c) 2026 ScanPay Guard contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

**File: `.env.example`** — every variable from ICD §0.11 (values empty). B and FE append nothing; they edit this
file only via PR to you.

```dotenv
# ---------- shared ----------
MONAD_TESTNET_RPC=https://testnet-rpc.monad.xyz
MONAD_MAINNET_RPC=https://rpc.monad.xyz
PUBLIC_APP_URL=http://localhost:3000

# ---------- Backend A ----------
DEPLOYER_ACCOUNT=scanpay-deployer
ADMIN_ADDRESS=
OPERATOR_ADDRESS=
FEE_RECIPIENT=
FEE_BPS=30
REFUND_DELAY_SEC=600
MONADSCAN_API_KEY=
ENVIO_API_TOKEN=

# ---------- Backend B ----------
PORT=8787
MONGODB_URI=mongodb://127.0.0.1:27017/scanpay
CORS_ORIGINS=http://localhost:3000
ENABLED_CHAINS=31337,10143
OPERATOR_PRIVATE_KEY_LOCAL=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
OPERATOR_PRIVATE_KEY_TESTNET=
OPERATOR_PRIVATE_KEY_MAINNET=
ADMIN_TOKEN=
AURORA_API_KEY=
ONECLICK_JWT=
ENVIO_GRAPHQL_URL=http://localhost:8080/v1/graphql
ATTACK_LAB_ENABLED=true

# ---------- Frontend ----------
NEXT_PUBLIC_API_URL=http://localhost:8787
```

> `OPERATOR_PRIVATE_KEY_LOCAL` is anvil's well-known account #1 key (public, local only). Its address
> `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` is the local `OPERATOR_ADDRESS`.

**File: `README.md`** (skeleton — A26 fills the evidence sections; B/FE add their sections by PR)

```markdown
# ScanPay Guard — Scan. Verify. Pay. Know it arrived.

QR payments on Monad with three proofs: proof of merchant, proof of intent, proof of settlement.
Monad Metropolis · Track 02 Consumer Products & Payments.

## Repo map
- `contracts/` — Solidity (Foundry): MerchantRegistry, IntentVault, DepositForwarder, swap adapters
- `indexer/` — Envio HyperIndex (Monad testnet + mainnet)
- `packages/shared/` — typed-data, ABIs, deployments shared by every app
- `services/api/` — API + relayer + settlement watcher
- `apps/web/` — Mera passkey PWA (customer + merchant terminal)

## Deployments
(filled in Phase A26)

## Why Monad
(filled in Phase A26)

## Trust model
(filled in Phase A26)

## AI tools disclosure (Rules §4.1.4)
(filled in Phase A26)

## License
MIT
```

**Commands**

```bash
git add -A
git commit -m "chore: monorepo skeleton, license, env template"
# create the public GitHub repo (name: scanpay-guard), then:
git remote add origin git@github.com:<org-or-user>/scanpay-guard.git
git push -u origin main
```

**Exit checks**
- [ ] `pnpm install` at root succeeds (no packages yet is fine)
- [ ] Repo is **public** on GitHub; LICENSE visible
- [ ] B and FE engineers have cloned it

**Commit:** `chore: monorepo skeleton, license, env template`

---

### Phase A2 — On-chain address verification (Phase-0 truth check)

**Goal:** confirm every external address our mainnet config depends on actually has code and the expected functions,
and record the answers in `contracts/config/143.json`. **Time:** 20 min. **Depends on:** A1.

**File: `contracts/script/VerifyAddresses.sh`**

```bash
#!/usr/bin/env bash
# Usage: MONAD_MAINNET_RPC=... MONAD_TESTNET_RPC=... bash contracts/script/VerifyAddresses.sh
set -uo pipefail
M=${MONAD_MAINNET_RPC:-https://rpc.monad.xyz}
T=${MONAD_TESTNET_RPC:-https://testnet-rpc.monad.xyz}

code() { # name addr rpc
  local c; c=$(cast code "$2" --rpc-url "$3" 2>&1)
  if [[ "$c" == "0x" || -z "$c" ]]; then echo "❌ $1 $2  (NO CODE)"; else echo "✅ $1 $2  (${#c} hex chars)"; fi
}
call() { # label addr sig rpc
  local out; out=$(cast call "$2" "$3" --rpc-url "$4" 2>&1)
  echo "   $1 → $out"
}

echo "=== Monad mainnet (143) chainId: $(cast chain-id --rpc-url "$M") ==="
code USDC               0x754704Bc059F8C67012fEd69BC8A327a5aafb603 "$M"
call "USDC name"        0x754704Bc059F8C67012fEd69BC8A327a5aafb603 "name()(string)" "$M"
call "USDC version"     0x754704Bc059F8C67012fEd69BC8A327a5aafb603 "version()(string)" "$M"
call "USDC decimals"    0x754704Bc059F8C67012fEd69BC8A327a5aafb603 "decimals()(uint8)" "$M"
call "USDC RWA_TYPEHASH" 0x754704Bc059F8C67012fEd69BC8A327a5aafb603 "RECEIVE_WITH_AUTHORIZATION_TYPEHASH()(bytes32)" "$M"
call "USDC authState"   0x754704Bc059F8C67012fEd69BC8A327a5aafb603 "authorizationState(address,bytes32)(bool)" "$M" 2>/dev/null
cast call 0x754704Bc059F8C67012fEd69BC8A327a5aafb603 "authorizationState(address,bytes32)(bool)" 0x0000000000000000000000000000000000000001 0x0000000000000000000000000000000000000000000000000000000000000001 --rpc-url "$M"

code AUSD               0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a "$M"
call "AUSD name"        0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a "name()(string)" "$M"
call "AUSD decimals"    0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a "decimals()(uint8)" "$M"
call "AUSD RWA_TYPEHASH" 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a "RECEIVE_WITH_AUTHORIZATION_TYPEHASH()(bytes32)" "$M"
call "AUSD eip712Domain" 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a "eip712Domain()(bytes1,string,string,uint256,address,bytes32,uint256[])" "$M"
cast call 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a "authorizationState(address,bytes32)(bool)" 0x0000000000000000000000000000000000000001 0x0000000000000000000000000000000000000000000000000000000000000001 --rpc-url "$M"

code WMON               0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A "$M"
code WETH               0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242 "$M"
code KuruFlowEntrypoint 0xb3e6778480b2E488385E8205eA05E20060B813cb "$M"
code KuruFlowRouter     0x0d3a1BE29E9dEd63c7a5678b31e847D68F71FFa2 "$M"
code Permit2            0x000000000022d473030f116ddee9f6b43ac78ba3 "$M"

echo
echo "=== Monad testnet (10143) chainId: $(cast chain-id --rpc-url "$T") ==="
echo "(informational only — testnet uses our own mock tokens)"
code CircleTestUSDC     0x534b2f3A21130d7a60830c2Df862319e593943A3 "$T"
code AgoraTestAUSD      0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC "$T"
code WMON_test          0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541 "$T"
```

**Commands**

```bash
set -a; source .env; set +a
bash contracts/script/VerifyAddresses.sh | tee docs/txt/address-verification-$(date +%Y%m%d).txt
```

**How to read the output → what to write in `contracts/config/143.json` (Phase A18 creates that file):**

| Output | Config decision |
|---|---|
| `USDC RWA_TYPEHASH` returns `0xd099cc98…` (any 32-byte value) **and** `authorizationState` returns `false` | `tokens.USDC.supports3009 = true`, `inputAllow.DIRECT` includes `USDC` |
| USDC `version` prints e.g. `"2"` and `name` prints e.g. `"USDC"` | copy both exactly into `tokens.USDC.eip712` — **a wrong name/version = every DIRECT payment fails** |
| AUSD RWA_TYPEHASH reverts | `tokens.AUSD.supports3009 = false`; AUSD not in `inputAllow.DIRECT` (AUSD stays a payout token) |
| AUSD RWA works | read `eip712Domain` (name, version) → `tokens.AUSD.eip712`; add `AUSD` to `inputAllow.DIRECT` |
| Kuru entrypoint or router ❌ | `external.kuruTargets = []` → no adapter is deployed → mainnet SWAP disabled, mainnet payout tokens must be `USDC` only for cross-chain |
| WMON/WETH ❌ | remove from `inputAllow.SWAP` |

> The RECEIVE_WITH_AUTHORIZATION typehash is `keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")`
> = `0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8`. If the token returns this exact value, it is the standard EIP-3009.

**Exit checks**
- [ ] File `docs/txt/address-verification-YYYYMMDD.txt` committed
- [ ] You know the 6 decisions in the table above (write them down; A18 uses them)

**Commit:** `chore: phase-0 on-chain address verification output`

---

### Phase A3 — Foundry project

**Goal:** compiling Foundry project with OZ v5.1.0, Monad execution network, verification-friendly metadata.
**Time:** 20 min. **Depends on:** A1.

**Commands**

```bash
cd contracts
forge init --no-git --force .        # creates src/ test/ script/ lib/forge-std (we delete Counter files next)
rm -f src/Counter.sol test/Counter.t.sol script/Counter.s.sol
forge install OpenZeppelin/openzeppelin-contracts@v5.1.0
# if your Foundry version asks, add --no-commit to the line above
ls lib/                              # forge-std  openzeppelin-contracts
mkdir -p src/libraries src/interfaces src/adapters src/mocks test/utils test/fork config scripts
cd ..
```

**File: `contracts/foundry.toml`**

```toml
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
test = "test"
script = "script"
solc_version = "0.8.28"
evm_version = "cancun"
optimizer = true
optimizer_runs = 200
via_ir = true
# Monad execution environment (gas model, 128KB size limit, precompiles) — Foundry >= 1.8
network = "monad"
# Verification-friendly metadata (per docs.monad.xyz verify guide)
metadata = true
metadata_hash = "none"
use_literal_content = true
fs_permissions = [
  { access = "read", path = "./config" },
  { access = "read", path = "./broadcast" },
  { access = "read-write", path = "../deployments" },
  { access = "read-write", path = "../packages/shared/test-vectors" },
]

[profile.default.fuzz]
runs = 512

[profile.default.invariant]
runs = 64
depth = 64
fail_on_revert = false

[rpc_endpoints]
local = "http://127.0.0.1:8545"
monad_testnet = "${MONAD_TESTNET_RPC}"
monad_mainnet = "${MONAD_MAINNET_RPC}"
```

> If your Foundry prints `unknown key metadata_hash`, replace that line with `bytecode_hash = "none"` (same meaning).

**File: `contracts/remappings.txt`**

```text
@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/
forge-std/=lib/forge-std/src/
```

**File: `contracts/package.json`** (TS helper scripts only)

```json
{
  "name": "@scanpay/contracts",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "forge build",
    "test": "forge test -vv",
    "export:abis": "forge build && tsx scripts/export-abis.ts",
    "build:deployments": "tsx scripts/build-deployments.ts",
    "kuru:quote": "tsx scripts/kuru-quote.ts"
  },
  "dependencies": {
    "@scanpay/shared": "workspace:*",
    "viem": "^2.40.0"
  },
  "devDependencies": {
    "@types/node": "^22.9.0",
    "tsx": "^4.19.2",
    "typescript": "^5.6.3"
  }
}
```

**Exit checks**
- [ ] `cd contracts && forge build` → "No files changed, compilation skipped" or success with 0 sources (fine)
- [ ] `forge config | grep network` shows `network = "monad"`

**Commit:** `chore(contracts): foundry project with OZ v5.1.0 and monad network`

---

### Phase A4 — `ScanPayTypes.sol` (the struct + typehash library)

**Goal:** one Solidity file that defines every struct, constant and typehash, shared by every contract and test.
**Time:** 20 min. **Depends on:** A3.

**File: `contracts/src/libraries/ScanPayTypes.sol`** — copy **ICD §0.7.1 verbatim**. Do not reorder any struct
field: the EIP-712 type strings, the TypeScript types (A6) and the ABI tuple order all depend on it.

**Commands**

```bash
cd contracts && forge build
```

**Exit checks**
- [ ] Compiles
- [ ] `grep -c "keccak256(" src/libraries/ScanPayTypes.sol` ≥ 7

**Commit:** `feat(contracts): ScanPayTypes structs, enums, typehashes`

---

### Phase A5 — Interfaces

**Goal:** the six interface files that define the public surface (functions, events, errors). B's ABIs come from
these, so they must be complete *before* implementations exist. **Time:** 25 min. **Depends on:** A4.

**Files** — copy verbatim from the ICD:
- `contracts/src/interfaces/IMerchantRegistry.sol` ← ICD §0.7.2
- `contracts/src/interfaces/IIntentVault.sol` ← ICD §0.7.3
- `contracts/src/interfaces/ISwapAdapter.sol` ← ICD §0.7.4 (first block)
- `contracts/src/interfaces/IERC3009.sol` ← ICD §0.7.4 (second block)
- `contracts/src/interfaces/IMockStableToken.sol` ← ICD §0.7.4 (third block)
- `contracts/src/interfaces/IMockSwapAdapter.sol` ← ICD §0.7.4 (fourth block)

**Commands**

```bash
cd contracts && forge build
ls out/IIntentVault.sol/IIntentVault.json out/IMerchantRegistry.sol/IMerchantRegistry.json
```

**Exit checks**
- [ ] Compiles
- [ ] `jq '.abi | map(select(.type=="event")) | length' out/IIntentVault.sol/IIntentVault.json` → `11`
- [ ] `jq '.abi | map(select(.type=="error")) | length' out/IIntentVault.sol/IIntentVault.json` → `25`
- [ ] `jq '.abi | map(select(.type=="function")) | length' out/IIntentVault.sol/IIntentVault.json` → `31`

**Commit:** `feat(contracts): public interfaces (registry, vault, adapters, 3009, mocks)`

---

### Phase A6 — `@scanpay/shared` package (A-owned files) + ABI export

**Goal:** the TypeScript package every app imports: constants, types, EIP-712 builders, id helpers, wire
converters, generated ABIs and a placeholder deployments map. **Time:** 60 min. **Depends on:** A5.

**File: `packages/shared/package.json`**

```json
{
  "name": "@scanpay/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "viem": "^2.40.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.9.0",
    "tsx": "^4.19.2",
    "typescript": "^5.6.3",
    "vitest": "^2.1.4"
  }
}
```

> No build step: apps import TypeScript source directly (B runs on `tsx`; FE uses Next `transpilePackages`).

**File: `packages/shared/tsconfig.json`**

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

**File: `packages/shared/src/constants.ts`**

```ts
export const ICD_VERSION = 1 as const;

export const ROUTE = { DIRECT: 0, SWAP: 1, CROSSCHAIN: 2 } as const;
export type RouteName = keyof typeof ROUTE;
export const ROUTE_NAME: Record<number, RouteName> = { 0: 'DIRECT', 1: 'SWAP', 2: 'CROSSCHAIN' };

export const INTENT_STATUS = { NONE: 0, COMMITTED: 1, SETTLED: 2, REFUNDED: 3 } as const;
export const INTENT_STATUS_NAME: Record<number, keyof typeof INTENT_STATUS> = {
  0: 'NONE', 1: 'COMMITTED', 2: 'SETTLED', 3: 'REFUNDED',
};

export const INVOICE_STATE = { OPEN: 0, RESERVED: 1, PAID: 2 } as const;

export const MERCHANT_STATUS = { NONE: 0, PENDING: 1, ACTIVE: 2, SUSPENDED: 3, REVOKED: 4 } as const;
export const MERCHANT_STATUS_NAME: Record<number, keyof typeof MERCHANT_STATUS> = {
  0: 'NONE', 1: 'PENDING', 2: 'ACTIVE', 3: 'SUSPENDED', 4: 'REVOKED',
};

export const CHAIN_IDS = { local: 31337, testnet: 10143, mainnet: 143 } as const;
export type NetworkName = keyof typeof CHAIN_IDS;

export const VAULT_DOMAIN_NAME = 'ScanPayGuard' as const;
export const REGISTRY_DOMAIN_NAME = 'ScanPayRegistry' as const;
export const DOMAIN_VERSION = '1' as const;

export const ZERO_BYTES32 =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as const;
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

/** keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)") */
export const RECEIVE_WITH_AUTHORIZATION_TYPEHASH =
  '0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8' as const;
```

**File: `packages/shared/src/types.ts`**

```ts
import type { Address, Hex } from 'viem';
export type { Address, Hex };

export type TokenKey = 'USDC' | 'AUSD' | 'MON' | 'WMON' | 'WETH' | 'USDT0';
export type TokenRole = 'payout' | 'direct' | 'swapIn' | 'crosschainIn';

/** Mirrors Solidity struct Invoice (field order matters). */
export interface InvoiceMessage {
  merchantId: Hex;
  invoiceId: Hex;
  payoutToken: Address;
  amount: bigint;
  expiresAt: bigint; // uint64 unix seconds
  keyVersion: number; // uint32
}

/** Mirrors Solidity struct PaymentIntent (field order matters). */
export interface PaymentIntentMessage {
  merchantId: Hex;
  invoiceId: Hex;
  payer: Address;
  payoutToken: Address;
  amountOut: bigint;
  route: number; // uint8
  inputToken: Address;
  maxAmountIn: bigint;
  quoteHash: Hex;
  refundTo: Address;
  expiresAt: bigint; // uint64
  nonce: bigint;
  keyVersion: number; // uint32
}

export interface RegistrationMessage {
  owner: Address;
  salt: Hex;
  payoutWallet: Address;
  invoiceSigner: Address;
  payoutToken: Address;
  metadataHash: Hex;
  nonce: bigint;
  deadline: bigint; // uint64
}

export interface SignerRotationMessage {
  merchantId: Hex;
  newSigner: Address;
  nonce: bigint;
  deadline: bigint;
}

export interface PayoutUpdateMessage {
  merchantId: Hex;
  payoutWallet: Address;
  payoutToken: Address;
  nonce: bigint;
  deadline: bigint;
}

export interface ReceiveAuthMessage {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

/** Return type of IntentVault.getIntent (viem decodes struct as object). */
export interface IntentRecord {
  payer: Address;
  route: number;
  status: number;
  expiresAt: bigint;
  committedAt: bigint;
  settledAt: bigint;
  merchantId: Hex;
  invoiceId: Hex;
  payoutToken: Address;
  inputToken: Address;
  payoutWallet: Address;
  refundTo: Address;
  amountOut: bigint;
  inputAmount: bigint;
  fee: bigint;
  quoteHash: Hex;
  sourceChainId: bigint;
  sourceTxHash: Hex;
}

/** Return type of MerchantRegistry.getMerchant. */
export interface MerchantRecord {
  owner: Address;
  payoutWallet: Address;
  invoiceSigner: Address;
  payoutToken: Address;
  keyVersion: number;
  status: number;
  registeredAt: bigint;
  metadataHash: Hex;
}

export interface TokenInfo {
  address: Address;
  symbol: string;
  displaySymbol: string;
  decimals: number;
  eip712: { name: string; version: string } | null;
  supports3009: boolean;
  isMock: boolean;
  usdPrice: number;
  roles: TokenRole[];
}

export interface DeployedContract {
  address: Address;
  deployBlock?: number;
  deployTx?: Hex;
}

export interface Deployment {
  schemaVersion: 1;
  chainId: number;
  network: 'local' | 'testnet' | 'mainnet';
  generatedAt: string;
  startBlock: number;
  explorer: string | null;
  contracts: {
    MerchantRegistry: DeployedContract;
    IntentVault: DeployedContract;
    DepositForwarderImpl: DeployedContract;
    SwapAdapter: DeployedContract & { kind: 'mock' | 'kuru' | 'none' };
  };
  roles: { admin: Address; operator: Address; feeRecipient: Address };
  config: {
    feeBps: number;
    refundDelaySec: number;
    crossChainInputToken: TokenKey | null;
    amountCaps: Partial<Record<TokenKey, string>>;
  };
  tokens: Partial<Record<TokenKey, TokenInfo>>;
  external: {
    kuruFlowApi: string | null;
    kuruTargets: Address[];
    auroraMonadUsdcAssetId: string | null;
  };
}
```

**File: `packages/shared/src/eip712.ts`**

```ts
import {
  hashTypedData,
  hashStruct,
  parseSignature,
  type Address,
  type Hex,
  type TypedDataDomain,
} from 'viem';
import { DOMAIN_VERSION, REGISTRY_DOMAIN_NAME, VAULT_DOMAIN_NAME } from './constants';
import type {
  InvoiceMessage,
  PaymentIntentMessage,
  PayoutUpdateMessage,
  ReceiveAuthMessage,
  RegistrationMessage,
  SignerRotationMessage,
  TokenInfo,
} from './types';

// ---------------- types (field order == Solidity type string) ----------------

export const invoiceTypes = {
  Invoice: [
    { name: 'merchantId', type: 'bytes32' },
    { name: 'invoiceId', type: 'bytes32' },
    { name: 'payoutToken', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'keyVersion', type: 'uint32' },
  ],
} as const;

export const paymentIntentTypes = {
  PaymentIntent: [
    { name: 'merchantId', type: 'bytes32' },
    { name: 'invoiceId', type: 'bytes32' },
    { name: 'payer', type: 'address' },
    { name: 'payoutToken', type: 'address' },
    { name: 'amountOut', type: 'uint256' },
    { name: 'route', type: 'uint8' },
    { name: 'inputToken', type: 'address' },
    { name: 'maxAmountIn', type: 'uint256' },
    { name: 'quoteHash', type: 'bytes32' },
    { name: 'refundTo', type: 'address' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
    { name: 'keyVersion', type: 'uint32' },
  ],
} as const;

export const registrationTypes = {
  Registration: [
    { name: 'owner', type: 'address' },
    { name: 'salt', type: 'bytes32' },
    { name: 'payoutWallet', type: 'address' },
    { name: 'invoiceSigner', type: 'address' },
    { name: 'payoutToken', type: 'address' },
    { name: 'metadataHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const;

export const signerRotationTypes = {
  SignerRotation: [
    { name: 'merchantId', type: 'bytes32' },
    { name: 'newSigner', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const;

export const payoutUpdateTypes = {
  PayoutUpdate: [
    { name: 'merchantId', type: 'bytes32' },
    { name: 'payoutWallet', type: 'address' },
    { name: 'payoutToken', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const;

export const receiveWithAuthorizationTypes = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

// ---------------- domains ----------------

export function vaultDomain(chainId: number, vault: Address) {
  return { name: VAULT_DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract: vault } as const satisfies TypedDataDomain;
}

export function registryDomain(chainId: number, registry: Address) {
  return { name: REGISTRY_DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract: registry } as const satisfies TypedDataDomain;
}

export function tokenDomain(chainId: number, token: Pick<TokenInfo, 'address' | 'eip712'>) {
  if (!token.eip712) throw new Error(`token ${token.address} has no EIP-712 domain (not 3009-capable)`);
  return {
    name: token.eip712.name,
    version: token.eip712.version,
    chainId,
    verifyingContract: token.address,
  } as const satisfies TypedDataDomain;
}

// ---------------- full typed-data payloads (pass straight to account.signTypedData) ----------------

export function buildInvoiceTypedData(chainId: number, vault: Address, message: InvoiceMessage) {
  return { domain: vaultDomain(chainId, vault), types: invoiceTypes, primaryType: 'Invoice' as const, message };
}

export function buildIntentTypedData(chainId: number, vault: Address, message: PaymentIntentMessage) {
  return { domain: vaultDomain(chainId, vault), types: paymentIntentTypes, primaryType: 'PaymentIntent' as const, message };
}

export function buildRegistrationTypedData(chainId: number, registry: Address, message: RegistrationMessage) {
  return { domain: registryDomain(chainId, registry), types: registrationTypes, primaryType: 'Registration' as const, message };
}

export function buildSignerRotationTypedData(chainId: number, registry: Address, message: SignerRotationMessage) {
  return { domain: registryDomain(chainId, registry), types: signerRotationTypes, primaryType: 'SignerRotation' as const, message };
}

export function buildPayoutUpdateTypedData(chainId: number, registry: Address, message: PayoutUpdateMessage) {
  return { domain: registryDomain(chainId, registry), types: payoutUpdateTypes, primaryType: 'PayoutUpdate' as const, message };
}

export function buildReceiveAuthTypedData(
  chainId: number,
  token: Pick<TokenInfo, 'address' | 'eip712'>,
  message: ReceiveAuthMessage,
) {
  return {
    domain: tokenDomain(chainId, token),
    types: receiveWithAuthorizationTypes,
    primaryType: 'ReceiveWithAuthorization' as const,
    message,
  };
}

/** The 3009 message for a DIRECT payment is fully determined by the intent + its digest. */
export function receiveAuthForIntent(
  intent: PaymentIntentMessage,
  intentDigestHex: Hex,
  vault: Address,
): ReceiveAuthMessage {
  return {
    from: intent.payer,
    to: vault,
    value: intent.amountOut,
    validAfter: 0n,
    validBefore: intent.expiresAt,
    nonce: intentDigestHex,
  };
}

// ---------------- digests ----------------

export const invoiceDigest = (chainId: number, vault: Address, m: InvoiceMessage): Hex =>
  hashTypedData(buildInvoiceTypedData(chainId, vault, m));

export const intentDigest = (chainId: number, vault: Address, m: PaymentIntentMessage): Hex =>
  hashTypedData(buildIntentTypedData(chainId, vault, m));

export const registrationDigest = (chainId: number, registry: Address, m: RegistrationMessage): Hex =>
  hashTypedData(buildRegistrationTypedData(chainId, registry, m));

export const signerRotationDigest = (chainId: number, registry: Address, m: SignerRotationMessage): Hex =>
  hashTypedData(buildSignerRotationTypedData(chainId, registry, m));

export const payoutUpdateDigest = (chainId: number, registry: Address, m: PayoutUpdateMessage): Hex =>
  hashTypedData(buildPayoutUpdateTypedData(chainId, registry, m));

export const receiveAuthDigest = (
  chainId: number,
  token: Pick<TokenInfo, 'address' | 'eip712'>,
  m: ReceiveAuthMessage,
): Hex => hashTypedData(buildReceiveAuthTypedData(chainId, token, m));

export const invoiceStructHash = (m: InvoiceMessage): Hex =>
  hashStruct({ data: m, primaryType: 'Invoice', types: invoiceTypes });

export const intentStructHash = (m: PaymentIntentMessage): Hex =>
  hashStruct({ data: m, primaryType: 'PaymentIntent', types: paymentIntentTypes });

// ---------------- signatures ----------------

/** 65-byte 0x signature -> {v,r,s} for IntentVault.payDirect's Auth3009 tuple. */
export function splitSignature(sig: Hex): { v: number; r: Hex; s: Hex } {
  const p = parseSignature(sig);
  const v = p.v !== undefined ? Number(p.v) : p.yParity + 27;
  return { v, r: p.r, s: p.s };
}
```

**File: `packages/shared/src/ids.ts`**

```ts
import { encodeAbiParameters, keccak256, toHex, type Address, type Hex } from 'viem';
import type { PaymentIntentMessage } from './types';

/** keccak256(abi.encode(owner, salt)) — matches ScanPayTypes.computeMerchantId */
export function computeMerchantId(owner: Address, salt: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [owner, salt]));
}

/** keccak256(abi.encode(merchantId, invoiceId, payer, nonce)) — matches ScanPayTypes.computeIntentId */
export function computeIntentId(i: Pick<PaymentIntentMessage, 'merchantId' | 'invoiceId' | 'payer' | 'nonce'>): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }],
      [i.merchantId, i.invoiceId, i.payer, i.nonce],
    ),
  );
}

export function randomBytes32(): Hex {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return toHex(b);
}

/** Random uint256 nonce (unordered nonces: usedNonce[payer][nonce]). */
export function randomNonce(): bigint {
  return BigInt(randomBytes32());
}
```

**File: `packages/shared/src/wire.ts`**

```ts
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
```

> Note: `getAddress` returns checksummed; we lowercase it for the wire. viem accepts lowercase addresses in
> typed data and contract calls, so digests are identical (EIP-712 encodes addresses as 20 bytes, case-irrelevant).

**File: `packages/shared/src/generated/deployments.ts`** — placeholder (A18 overwrites it via the generator)

```ts
// AUTO-GENERATED by contracts/scripts/build-deployments.ts — DO NOT EDIT
import type { Deployment, TokenKey, TokenInfo, Address } from '../types';

export const DEPLOYMENTS: Record<number, Deployment> = {};

export function getDeployment(chainId: number): Deployment {
  const d = DEPLOYMENTS[chainId];
  if (!d) throw new Error(`No deployment for chainId ${chainId}. Run pnpm deployments:build ${chainId}`);
  return d;
}

export function hasDeployment(chainId: number): boolean {
  return Boolean(DEPLOYMENTS[chainId]);
}

export function getToken(chainId: number, key: TokenKey): TokenInfo {
  const t = getDeployment(chainId).tokens[key];
  if (!t) throw new Error(`Token ${key} not configured on chain ${chainId}`);
  return t;
}

export function findTokenByAddress(chainId: number, address: Address): { key: TokenKey; token: TokenInfo } | null {
  const tokens = getDeployment(chainId).tokens;
  for (const [key, token] of Object.entries(tokens) as [TokenKey, TokenInfo][]) {
    if (token.address.toLowerCase() === address.toLowerCase()) return { key, token };
  }
  return null;
}
```

**File: `contracts/scripts/export-abis.ts`**

```ts
// Reads Foundry artifacts and writes packages/shared/src/generated/abis.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../out');
const target = resolve(here, '../../packages/shared/src/generated/abis.ts');

const ARTIFACTS: Array<[exportName: string, file: string, contract: string]> = [
  ['merchantRegistryAbi', 'IMerchantRegistry.sol', 'IMerchantRegistry'],
  ['intentVaultAbi', 'IIntentVault.sol', 'IIntentVault'],
  ['swapAdapterAbi', 'ISwapAdapter.sol', 'ISwapAdapter'],
  ['erc3009Abi', 'IERC3009.sol', 'IERC3009'],
  ['mockStableTokenAbi', 'IMockStableToken.sol', 'IMockStableToken'],
  ['mockSwapAdapterAbi', 'IMockSwapAdapter.sol', 'IMockSwapAdapter'],
  ['erc20Abi', 'IERC20.sol', 'IERC20'],
];

let ts = '// AUTO-GENERATED by contracts/scripts/export-abis.ts — DO NOT EDIT\n\n';
for (const [name, file, contract] of ARTIFACTS) {
  const json = JSON.parse(readFileSync(resolve(out, file, `${contract}.json`), 'utf8'));
  if (!Array.isArray(json.abi) || json.abi.length === 0) throw new Error(`empty abi for ${contract}`);
  ts += `export const ${name} = ${JSON.stringify(json.abi, null, 2)} as const;\n\n`;
}
writeFileSync(target, ts);
console.log(`wrote ${target}`);
```

> `IERC20` comes from OpenZeppelin and is compiled because our interfaces/contracts import it. If
> `out/IERC20.sol/IERC20.json` is missing at I0 time, add `import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";`
> to `IMockStableToken.sol` (harmless) and rebuild.

**File: `packages/shared/src/index.ts`**

```ts
export * from './constants';
export * from './types';
export * from './eip712';
export * from './ids';
export * from './wire';
export * from './generated/abis';
export * from './generated/deployments';
// B-owned (created by B in Phase B2; until then these lines stay commented out):
// export * from './canonical';
// export * from './quote-hash';
// export * from './errors';
// export * from './api';
```

**File: `packages/shared/scripts/print-deployment.ts`**

```ts
import { getDeployment } from '../src/generated/deployments';
const chainId = Number(process.argv[2] ?? '10143');
const d = getDeployment(chainId);
console.log(JSON.stringify({ chainId, contracts: d.contracts, tokens: Object.fromEntries(Object.entries(d.tokens).map(([k, t]) => [k, t!.address])) }, null, 2));
```

**Commands**

```bash
pnpm install
pnpm abis:export
pnpm --filter @scanpay/shared typecheck
```

**Exit checks**
- [ ] `packages/shared/src/generated/abis.ts` exists and contains `export const intentVaultAbi`
- [ ] `pnpm --filter @scanpay/shared typecheck` passes
- [ ] `grep -c '"type": "event"' packages/shared/src/generated/abis.ts` ≥ 16

**Commit:** `feat(shared): constants, types, eip712 builders, ids, wire, generated abis`

---

### Phase A7 — Golden vectors (Solidity ⇄ TypeScript digest equality) → **I0**

**Goal:** prove that the Solidity typehashes/digests and the TS builders produce **byte-identical** digests and
signatures. This single test removes the #1 wiring bug class. **Time:** 45 min. **Depends on:** A6.

**File: `contracts/test/GoldenVectors.t.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import "../src/libraries/ScanPayTypes.sol";

contract GoldenVectorsTest is Test {
    bytes32 constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 constant RWA_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    uint256 constant CHAIN_ID = 10143;
    address constant VAULT = 0x1111111111111111111111111111111111111111;
    address constant REGISTRY = 0x2222222222222222222222222222222222222222;
    address constant TOKEN = 0x3333333333333333333333333333333333333333;
    string constant TOKEN_NAME = "ScanPay Test USDC";
    string constant TOKEN_VERSION = "1";
    uint256 constant PAYER_KEY = 0xA11CE;
    uint256 constant MERCHANT_SIGNER_KEY = 0xB0B;
    uint256 constant OWNER_KEY = 0xC0FFEE;

    function _domain(string memory name, string memory version, address verifying) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(version)), CHAIN_ID, verifying)
        );
    }

    function _digest(bytes32 domainSep, bytes32 structHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
    }

    function _sig(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_writeGoldenVectors() public {
        address payer = vm.addr(PAYER_KEY);
        address owner = vm.addr(OWNER_KEY);
        bytes32 vaultDomain = _domain("ScanPayGuard", "1", VAULT);
        bytes32 registryDomain = _domain("ScanPayRegistry", "1", REGISTRY);
        bytes32 tokenDomain = _domain(TOKEN_NAME, TOKEN_VERSION, TOKEN);

        bytes32 salt = keccak256("salt-1");
        bytes32 merchantId = ScanPayTypes.computeMerchantId(owner, salt);

        Invoice memory inv = Invoice({
            merchantId: merchantId,
            invoiceId: keccak256("invoice-1"),
            payoutToken: TOKEN,
            amount: 12_000_000,
            expiresAt: 1_800_000_000,
            keyVersion: 3
        });
        bytes32 invStruct = ScanPayTypes.hashInvoice(inv);
        bytes32 invDigest = _digest(vaultDomain, invStruct);

        PaymentIntent memory p = PaymentIntent({
            merchantId: merchantId,
            invoiceId: inv.invoiceId,
            payer: payer,
            payoutToken: TOKEN,
            amountOut: 12_000_000,
            route: ROUTE_DIRECT,
            inputToken: TOKEN,
            maxAmountIn: 12_000_000,
            quoteHash: bytes32(0),
            refundTo: payer,
            expiresAt: 1_800_000_000,
            nonce: 0xdeadbeef,
            keyVersion: 3
        });
        bytes32 pStruct = ScanPayTypes.hashIntent(p);
        bytes32 pDigest = _digest(vaultDomain, pStruct);
        bytes32 intentId = ScanPayTypes.computeIntentId(p);

        Registration memory reg = Registration({
            owner: owner,
            salt: salt,
            payoutWallet: address(0xBEEF),
            invoiceSigner: vm.addr(MERCHANT_SIGNER_KEY),
            payoutToken: TOKEN,
            metadataHash: keccak256("profile"),
            nonce: 0,
            deadline: 1_800_000_000
        });
        bytes32 regDigest = _digest(registryDomain, ScanPayTypes.hashRegistration(reg));

        bytes32 rwaStruct = keccak256(abi.encode(RWA_TYPEHASH, payer, VAULT, uint256(12_000_000), uint256(0), uint256(1_800_000_000), pDigest));
        bytes32 rwaDigest = _digest(tokenDomain, rwaStruct);

        // ---- JSON (all numbers as strings to avoid JS precision loss) ----
        string memory o = "v";
        vm.serializeString(o, "chainId", vm.toString(CHAIN_ID));
        vm.serializeAddress(o, "vault", VAULT);
        vm.serializeAddress(o, "registry", REGISTRY);
        vm.serializeAddress(o, "token", TOKEN);
        vm.serializeString(o, "tokenName", TOKEN_NAME);
        vm.serializeString(o, "tokenVersion", TOKEN_VERSION);
        vm.serializeBytes32(o, "payerKey", bytes32(PAYER_KEY));
        vm.serializeBytes32(o, "merchantSignerKey", bytes32(MERCHANT_SIGNER_KEY));
        vm.serializeBytes32(o, "ownerKey", bytes32(OWNER_KEY));
        vm.serializeAddress(o, "payer", payer);
        vm.serializeAddress(o, "owner", owner);
        vm.serializeBytes32(o, "salt", salt);
        vm.serializeBytes32(o, "merchantId", merchantId);
        vm.serializeBytes32(o, "invoiceId", inv.invoiceId);
        vm.serializeBytes32(o, "invoiceStructHash", invStruct);
        vm.serializeBytes32(o, "invoiceDigest", invDigest);
        vm.serializeBytes(o, "merchantSig", _sig(MERCHANT_SIGNER_KEY, invDigest));
        vm.serializeBytes32(o, "intentStructHash", pStruct);
        vm.serializeBytes32(o, "intentDigest", pDigest);
        vm.serializeBytes32(o, "intentId", intentId);
        vm.serializeBytes(o, "payerSig", _sig(PAYER_KEY, pDigest));
        vm.serializeBytes32(o, "registrationDigest", regDigest);
        vm.serializeBytes(o, "ownerRegSig", _sig(OWNER_KEY, regDigest));
        vm.serializeBytes32(o, "receiveAuthDigest", rwaDigest);
        string memory json = vm.serializeBytes(o, "receiveAuthSig", _sig(PAYER_KEY, rwaDigest));
        vm.writeJson(json, "../packages/shared/test-vectors/eip712.json");
    }
}
```

**File: `packages/shared/test/golden.test.ts`**

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { keccak256, toBytes, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  buildIntentTypedData,
  buildInvoiceTypedData,
  buildReceiveAuthTypedData,
  buildRegistrationTypedData,
  computeIntentId,
  computeMerchantId,
  intentDigest,
  intentStructHash,
  invoiceDigest,
  invoiceStructHash,
  receiveAuthDigest,
  receiveAuthForIntent,
  registrationDigest,
  splitSignature,
  ROUTE,
  ZERO_BYTES32,
} from '../src';

const v = JSON.parse(readFileSync(resolve(__dirname, '../test-vectors/eip712.json'), 'utf8'));
const chainId = Number(v.chainId);
const payer = v.payer as Address;
const token = { address: v.token as Address, eip712: { name: v.tokenName, version: v.tokenVersion } };

const invoice = {
  merchantId: v.merchantId as Hex,
  invoiceId: keccak256(toBytes('invoice-1')),
  payoutToken: v.token as Address,
  amount: 12_000_000n,
  expiresAt: 1_800_000_000n,
  keyVersion: 3,
};

const intent = {
  merchantId: v.merchantId as Hex,
  invoiceId: invoice.invoiceId,
  payer,
  payoutToken: v.token as Address,
  amountOut: 12_000_000n,
  route: ROUTE.DIRECT,
  inputToken: v.token as Address,
  maxAmountIn: 12_000_000n,
  quoteHash: ZERO_BYTES32,
  refundTo: payer,
  expiresAt: 1_800_000_000n,
  nonce: 0xdeadbeefn,
  keyVersion: 3,
};

describe('golden vectors (Solidity == TypeScript)', () => {
  it('merchantId', () => {
    expect(computeMerchantId(v.owner, v.salt)).toBe(v.merchantId);
  });
  it('invoice struct + digest + merchant signature', async () => {
    expect(invoice.invoiceId).toBe(v.invoiceId);
    expect(invoiceStructHash(invoice)).toBe(v.invoiceStructHash);
    expect(invoiceDigest(chainId, v.vault, invoice)).toBe(v.invoiceDigest);
    const signer = privateKeyToAccount(v.merchantSignerKey);
    const sig = await signer.signTypedData(buildInvoiceTypedData(chainId, v.vault, invoice));
    expect(sig).toBe(v.merchantSig);
  });
  it('intent struct + digest + id + payer signature', async () => {
    expect(intentStructHash(intent)).toBe(v.intentStructHash);
    expect(intentDigest(chainId, v.vault, intent)).toBe(v.intentDigest);
    expect(computeIntentId(intent)).toBe(v.intentId);
    const acct = privateKeyToAccount(v.payerKey);
    expect(acct.address.toLowerCase()).toBe(payer.toLowerCase());
    const sig = await acct.signTypedData(buildIntentTypedData(chainId, v.vault, intent));
    expect(sig).toBe(v.payerSig);
  });
  it('registration digest + owner signature', async () => {
    const reg = {
      owner: v.owner as Address,
      salt: v.salt as Hex,
      payoutWallet: '0x000000000000000000000000000000000000beef' as Address,
      invoiceSigner: privateKeyToAccount(v.merchantSignerKey).address,
      payoutToken: v.token as Address,
      metadataHash: keccak256(toBytes('profile')),
      nonce: 0n,
      deadline: 1_800_000_000n,
    };
    expect(registrationDigest(chainId, v.registry, reg)).toBe(v.registrationDigest);
    const sig = await privateKeyToAccount(v.ownerKey).signTypedData(buildRegistrationTypedData(chainId, v.registry, reg));
    expect(sig).toBe(v.ownerRegSig);
  });
  it('EIP-3009 receiveWithAuthorization bound to intent digest', async () => {
    const msg = receiveAuthForIntent(intent, v.intentDigest, v.vault);
    expect(receiveAuthDigest(chainId, token, msg)).toBe(v.receiveAuthDigest);
    const sig = await privateKeyToAccount(v.payerKey).signTypedData(buildReceiveAuthTypedData(chainId, token, msg));
    expect(sig).toBe(v.receiveAuthSig);
    const { v: vv, r, s } = splitSignature(sig);
    expect([27, 28]).toContain(vv);
    expect(r).toMatch(/^0x[0-9a-f]{64}$/);
    expect(s).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
```

**File: `packages/shared/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
```

**Commands**

```bash
cd contracts && forge test --match-contract GoldenVectorsTest -vv && cd ..
cat packages/shared/test-vectors/eip712.json | head -20
pnpm shared:test
```

**Exit checks**
- [ ] `packages/shared/test-vectors/eip712.json` exists (committed — it is a fixture)
- [ ] `pnpm shared:test` → **5 passed**
- [ ] Private keys in the vector file are test-only constants (0xA11CE etc.) — safe to commit

**Commit:** `test(shared): golden EIP-712 vectors, solidity == typescript`

### ✅ Checkpoint **I0** — post in team chat

```
I0 READY (ICD v1)
- contracts/src/libraries/ScanPayTypes.sol + 6 interfaces committed
- @scanpay/shared: constants, types, eip712, ids, wire, generated ABIs, golden vectors
- verify: pnpm install && pnpm shared:test   → 5 passed
B: you can now write against intentVaultAbi / merchantRegistryAbi. Local chain (I1) ETA Sun 10:00.
```

---

### Phase A8 — `MerchantRegistry` (proof of merchant)

**Goal:** the contract that answers "who am I paying?": merchants register with **two signatures** (owner key +
payout key over the same digest), a verifier approves them, and every key/payout change bumps `keyVersion` so old
invoices die automatically. **Time:** 60 min. **Depends on:** A5.

Design rules (do not deviate; B and FE rely on them):

| Rule | Why |
|---|---|
| `merchantId = keccak256(abi.encode(owner, salt))` | deterministic; FE can show the id before the tx lands |
| One nonce counter per **owner** (`ownerNonce(owner)`) used by `Registration`, `SignerRotation`, `PayoutUpdate` | FE always reads `ownerNonce(owner)` right before signing; a signed message can never be replayed |
| Registration needs `ownerSig` **and** `payoutSig` over the **same** digest | proves the merchant controls the payout wallet (no typo / no hijack) — "Many Keys" bounty |
| New merchants start `PENDING`, `keyVersion = 1` | the verifier (operator, Backend B) flips to `ACTIVE` |
| `rotateInvoiceSigner` and `updatePayout` bump `keyVersion` | every invoice/intent signed under the old version fails with `KeyVersionMismatch` |
| Anyone can submit the tx (relayer) | merchants are gasless; authority comes from signatures, never from `msg.sender` |
| `getMerchant` of an unknown id returns an all-zero struct (`status = 0 NONE`), it does **not** revert | B and the vault treat `status != ACTIVE` uniformly |
| Status transitions: `PENDING→ACTIVE|REVOKED`, `ACTIVE→SUSPENDED|REVOKED`, `SUSPENDED→ACTIVE|REVOKED`; `REVOKED` is terminal | |
| Roles: `DEFAULT_ADMIN_ROLE`, `CONFIG_ROLE` (payout-token allowlist), `VERIFIER_ROLE` (status) | deployer = admin; operator gets `VERIFIER_ROLE` in A18 |

**File: `contracts/src/MerchantRegistry.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {IMerchantRegistry} from "./interfaces/IMerchantRegistry.sol";
import "./libraries/ScanPayTypes.sol";

/// @title MerchantRegistry — proof of merchant for ScanPay Guard
/// @notice Stores role-separated merchant keys (owner, payout wallet, invoice signer) derived by the merchant app
///         from ONE Mera passkey. Every key/payout change bumps keyVersion, invalidating old invoices.
contract MerchantRegistry is IMerchantRegistry, EIP712, AccessControl {
    bytes32 public constant VERIFIER_ROLE = keccak256("VERIFIER_ROLE");
    bytes32 public constant CONFIG_ROLE = keccak256("CONFIG_ROLE");

    mapping(bytes32 merchantId => Merchant) private _merchants;
    mapping(address token => bool) private _payoutTokenAllowed;
    mapping(address owner => uint256) private _ownerNonce;

    constructor(address admin) EIP712("ScanPayRegistry", "1") {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CONFIG_ROLE, admin);
        _grantRole(VERIFIER_ROLE, admin);
    }

    // ------------------------------------------------------------------ merchant actions (relayed)

    /// @inheritdoc IMerchantRegistry
    function registerMerchant(Registration calldata r, bytes calldata ownerSig, bytes calldata payoutSig)
        external
        returns (bytes32 merchantId)
    {
        if (block.timestamp > r.deadline) revert SignatureExpired();
        if (r.owner == address(0) || r.payoutWallet == address(0) || r.invoiceSigner == address(0)) {
            revert ZeroAddress();
        }
        if (!_payoutTokenAllowed[r.payoutToken]) revert PayoutTokenNotAllowed(r.payoutToken);
        _useNonce(r.owner, r.nonce);

        merchantId = ScanPayTypes.computeMerchantId(r.owner, r.salt);
        if (_merchants[merchantId].status != MERCHANT_NONE) revert MerchantAlreadyExists(merchantId);

        bytes32 digest = _hashTypedDataV4(ScanPayTypes.hashRegistration(r));
        if (!SignatureChecker.isValidSignatureNow(r.owner, digest, ownerSig)) revert InvalidOwnerSignature();
        if (!SignatureChecker.isValidSignatureNow(r.payoutWallet, digest, payoutSig)) revert InvalidPayoutSignature();

        _merchants[merchantId] = Merchant({
            owner: r.owner,
            payoutWallet: r.payoutWallet,
            invoiceSigner: r.invoiceSigner,
            payoutToken: r.payoutToken,
            keyVersion: 1,
            status: MERCHANT_PENDING,
            registeredAt: uint64(block.timestamp),
            metadataHash: r.metadataHash
        });

        emit MerchantRegistered(
            merchantId, r.owner, r.salt, r.payoutWallet, r.invoiceSigner, r.payoutToken, r.metadataHash
        );
        emit MerchantStatusChanged(merchantId, MERCHANT_NONE, MERCHANT_PENDING, msg.sender);
    }

    /// @inheritdoc IMerchantRegistry
    function rotateInvoiceSigner(SignerRotation calldata r, bytes calldata ownerSig) external {
        Merchant storage m = _live(r.merchantId);
        if (block.timestamp > r.deadline) revert SignatureExpired();
        if (r.newSigner == address(0)) revert ZeroAddress();
        _useNonce(m.owner, r.nonce);

        bytes32 digest = _hashTypedDataV4(ScanPayTypes.hashSignerRotation(r));
        if (!SignatureChecker.isValidSignatureNow(m.owner, digest, ownerSig)) revert InvalidOwnerSignature();

        m.invoiceSigner = r.newSigner;
        m.keyVersion += 1;
        emit InvoiceSignerRotated(r.merchantId, r.newSigner, m.keyVersion);
    }

    /// @inheritdoc IMerchantRegistry
    function updatePayout(PayoutUpdate calldata u, bytes calldata ownerSig, bytes calldata payoutSig) external {
        Merchant storage m = _live(u.merchantId);
        if (block.timestamp > u.deadline) revert SignatureExpired();
        if (u.payoutWallet == address(0)) revert ZeroAddress();
        if (!_payoutTokenAllowed[u.payoutToken]) revert PayoutTokenNotAllowed(u.payoutToken);
        _useNonce(m.owner, u.nonce);

        bytes32 digest = _hashTypedDataV4(ScanPayTypes.hashPayoutUpdate(u));
        if (!SignatureChecker.isValidSignatureNow(m.owner, digest, ownerSig)) revert InvalidOwnerSignature();
        if (!SignatureChecker.isValidSignatureNow(u.payoutWallet, digest, payoutSig)) revert InvalidPayoutSignature();

        m.payoutWallet = u.payoutWallet;
        m.payoutToken = u.payoutToken;
        m.keyVersion += 1;
        emit PayoutUpdated(u.merchantId, u.payoutWallet, u.payoutToken, m.keyVersion);
    }

    // ------------------------------------------------------------------ verifier / config

    /// @inheritdoc IMerchantRegistry
    function setMerchantStatus(bytes32 merchantId, uint8 newStatus) external onlyRole(VERIFIER_ROLE) {
        Merchant storage m = _merchants[merchantId];
        uint8 prev = m.status;
        if (prev == MERCHANT_NONE) revert MerchantNotFound(merchantId);
        if (!_validTransition(prev, newStatus)) revert InvalidStatusTransition(prev, newStatus);
        m.status = newStatus;
        emit MerchantStatusChanged(merchantId, prev, newStatus, msg.sender);
    }

    /// @inheritdoc IMerchantRegistry
    function setPayoutTokenAllowed(address token, bool allowed) external onlyRole(CONFIG_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        _payoutTokenAllowed[token] = allowed;
        emit PayoutTokenAllowed(token, allowed);
    }

    // ------------------------------------------------------------------ views

    function getMerchant(bytes32 merchantId) external view returns (Merchant memory) {
        return _merchants[merchantId];
    }

    function isPayoutTokenAllowed(address token) external view returns (bool) {
        return _payoutTokenAllowed[token];
    }

    function ownerNonce(address owner) external view returns (uint256) {
        return _ownerNonce[owner];
    }

    function computeMerchantId(address owner, bytes32 salt) external pure returns (bytes32) {
        return ScanPayTypes.computeMerchantId(owner, salt);
    }

    function hashRegistration(Registration calldata r) external view returns (bytes32 digest) {
        return _hashTypedDataV4(ScanPayTypes.hashRegistration(r));
    }

    function hashSignerRotation(SignerRotation calldata r) external view returns (bytes32 digest) {
        return _hashTypedDataV4(ScanPayTypes.hashSignerRotation(r));
    }

    function hashPayoutUpdate(PayoutUpdate calldata u) external view returns (bytes32 digest) {
        return _hashTypedDataV4(ScanPayTypes.hashPayoutUpdate(u));
    }

    // ------------------------------------------------------------------ internal

    function _useNonce(address owner, uint256 provided) private {
        uint256 expected = _ownerNonce[owner];
        if (provided != expected) revert BadNonce(expected, provided);
        _ownerNonce[owner] = expected + 1;
    }

    /// @dev Merchant must exist and not be revoked (suspended merchants may still rotate keys / fix payout).
    function _live(bytes32 merchantId) private view returns (Merchant storage m) {
        m = _merchants[merchantId];
        if (m.status == MERCHANT_NONE) revert MerchantNotFound(merchantId);
        if (m.status == MERCHANT_REVOKED) revert MerchantIsRevoked(merchantId);
    }

    function _validTransition(uint8 from, uint8 to) private pure returns (bool) {
        if (from == MERCHANT_PENDING) return to == MERCHANT_ACTIVE || to == MERCHANT_REVOKED;
        if (from == MERCHANT_ACTIVE) return to == MERCHANT_SUSPENDED || to == MERCHANT_REVOKED;
        if (from == MERCHANT_SUSPENDED) return to == MERCHANT_ACTIVE || to == MERCHANT_REVOKED;
        return false;
    }
}
```

> **Order of checks is part of the contract.** Tests in A10 and B's error mapping assume this order:
> `SignatureExpired` → `ZeroAddress` → `PayoutTokenNotAllowed` → `BadNonce` → `MerchantAlreadyExists` →
> `InvalidOwnerSignature` → `InvalidPayoutSignature`. Don't reshuffle.

**Commands**

```bash
cd contracts && forge build --sizes | grep -E "MerchantRegistry|Contract"
```

**Exit checks**
- [ ] Compiles with zero warnings about shadowing / unreachable code
- [ ] `forge build --sizes` shows `MerchantRegistry` well under 24 KB (Monad allows 128 KB; we stay portable)
- [ ] `forge inspect MerchantRegistry abi | jq 'map(select(.type=="function")) | length'` ≥ 12 (interface 12 + role helpers)

**Commit:** `feat(contracts): MerchantRegistry with dual-sig registration, rotation, payout update`

---

### Phase A9 — Mock tokens + `MockSwapAdapter` (testnet + local liquidity)

**Goal:** deterministic testnet/local tokens that behave like the real ones where it matters (6-dec stablecoins with
**EIP-3009 `receiveWithAuthorization`** and EIP-2612 permit; an 18-dec tMON) and a fixed-rate swap adapter.
**Time:** 50 min. **Depends on:** A5.

Why mocks on testnet (decided in I.6): the Dec-2025 testnet reset made third-party testnet addresses unreliable,
Circle's testnet USDC can't be minted by our faucet, and there is no AUSD on testnet. Mocks give the judges a
one-tap faucet and give us exact control for the Attack Lab.

**File: `contracts/src/mocks/MockStableToken.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {IMockStableToken} from "../interfaces/IMockStableToken.sol";

/// @title MockStableToken — tUSDC / tAUSD for local + Monad testnet
/// @notice ERC-20 + EIP-2612 + EIP-3009 (transfer/receiveWithAuthorization), FiatToken-compatible semantics:
///         - EIP-712 domain = (name, "1", chainId, address(this))
///         - receiveWithAuthorization requires msg.sender == to (front-running safe)
///         - validAfter < block.timestamp < validBefore
///         - signatures verified with SignatureChecker (EOA or ERC-1271), like USDC v2.2
contract MockStableToken is ERC20, ERC20Permit, AccessControl, IMockStableToken {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    /// = 0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    uint8 private immutable _decimals;
    mapping(address authorizer => mapping(bytes32 nonce => bool)) private _authorizationStates;

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    error CallerMustBePayee();
    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error AuthorizationAlreadyUsed();
    error InvalidAuthorizationSignature();

    constructor(string memory name_, string memory symbol_, uint8 decimals_, address admin)
        ERC20(name_, symbol_)
        ERC20Permit(name_)
    {
        _decimals = decimals_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
    }

    /// @notice FiatToken exposes version(); our token domain version is "1".
    function version() external pure returns (string memory) {
        return "1";
    }

    function decimals() public view override(ERC20, IMockStableToken) returns (uint8) {
        return _decimals;
    }

    function balanceOf(address account) public view override(ERC20, IMockStableToken) returns (uint256) {
        return super.balanceOf(account);
    }

    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

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
    ) external {
        if (to != msg.sender) revert CallerMustBePayee();
        _useAuthorization(
            RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, abi.encodePacked(r, s, v)
        );
        _transfer(from, to, value);
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        _useAuthorization(
            TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, abi.encodePacked(r, s, v)
        );
        _transfer(from, to, value);
    }

    function _useAuthorization(
        bytes32 typehash,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) private {
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        if (_authorizationStates[from][nonce]) revert AuthorizationAlreadyUsed();

        bytes32 digest =
            _hashTypedDataV4(keccak256(abi.encode(typehash, from, to, value, validAfter, validBefore, nonce)));
        if (!SignatureChecker.isValidSignatureNow(from, digest, signature)) revert InvalidAuthorizationSignature();

        _authorizationStates[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
    }
}
```

> Domain check: `ERC20Permit(name_)` sets the EIP-712 domain to `(name_, "1")`. So the deployments JSON field
> `tokens.USDC.eip712 = { "name": "ScanPay Test USDC", "version": "1" }` is exactly right — A18's generator writes
> it from the same constants used here.

**File: `contracts/src/mocks/MockERC20.sol`** (tMON — no 3009, used for the SWAP route)

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title MockERC20 — tMON for local + Monad testnet (mint signature identical to MockStableToken.mint)
contract MockERC20 is ERC20, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_, address admin) ERC20(name_, symbol_) {
        _decimals = decimals_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }
}
```

> B's faucet mints tMON with `mockStableTokenAbi`'s `mint(address,uint256)` — same selector, works on both mocks.

**File: `contracts/src/adapters/MockSwapAdapter.sol`**

Behaviour = **exact-output** swap at a fixed rate: it uses only as much input as needed to produce `minOut`, sends
exactly `minOut` to `recipient` from its own liquidity, and returns the unused input to `leftoverTo`. This is what
lets the Attack Lab and the UI show "you paid 480 MON, 20 MON refunded".

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";
import {IMockSwapAdapter} from "../interfaces/IMockSwapAdapter.sol";

/// @title MockSwapAdapter — fixed-rate exact-output swap (local + testnet only)
/// @dev rateE18(tokenIn, tokenOut) = tokenOut base units per 1 tokenIn base unit, scaled by 1e18.
///      Example: tMON(18) -> tUSDC(6) at $0.025/MON:  1e18 tMON-wei = 25_000 tUSDC-units  => rate = 25_000.
///               tUSDC(6) -> tAUSD(6) at 1:1                                               => rate = 1e18.
contract MockSwapAdapter is ISwapAdapter, IMockSwapAdapter, AccessControl {
    using SafeERC20 for IERC20;

    address public immutable vault;
    mapping(address tokenIn => mapping(address tokenOut => uint256)) public rateE18;

    event RateSet(address indexed tokenIn, address indexed tokenOut, uint256 rateE18);
    event Swapped(address indexed tokenIn, address indexed tokenOut, uint256 amountInUsed, uint256 amountOut);

    constructor(address admin, address vault_) {
        vault = vault_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function setRate(address tokenIn, address tokenOut, uint256 rate) external onlyRole(DEFAULT_ADMIN_ROLE) {
        rateE18[tokenIn][tokenOut] = rate;
        emit RateSet(tokenIn, tokenOut, rate);
    }

    function quoteOut(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256) {
        uint256 rate = rateE18[tokenIn][tokenOut];
        if (rate == 0) revert NoRate(tokenIn, tokenOut);
        return (amountIn * rate) / 1e18;
    }

    /// @notice Input needed for `amountOut` (rounded UP so quoteOut(quoteIn(x)) >= x).
    function quoteIn(address tokenIn, address tokenOut, uint256 amountOut) public view returns (uint256) {
        uint256 rate = rateE18[tokenIn][tokenOut];
        if (rate == 0) revert NoRate(tokenIn, tokenOut);
        return (amountOut * 1e18 + rate - 1) / rate;
    }

    /// @dev Vault has already transferred `amountIn` of tokenIn to this adapter.
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        bytes calldata, /* data: unused for the mock (always 0x) */
        address recipient,
        address leftoverTo
    ) external returns (uint256 out) {
        if (msg.sender != vault) revert OnlyVault();
        uint256 needed = quoteIn(tokenIn, tokenOut, minOut);
        if (needed > amountIn) revert InsufficientOutput(quoteOut(tokenIn, tokenOut, amountIn), minOut);

        out = minOut;
        IERC20(tokenOut).safeTransfer(recipient, out);
        uint256 leftover = amountIn - needed;
        if (leftover != 0) IERC20(tokenIn).safeTransfer(leftoverTo, leftover);
        emit Swapped(tokenIn, tokenOut, needed, out);
    }
}
```

**Rates the deploy script sets (A18) — B's quote service uses `quoteIn` on-chain, so these are the only source of truth:**

| tokenIn → tokenOut | `rateE18` | Meaning |
|---|---|---|
| tMON → tUSDC | `25000` | 1 MON = 0.025 USDC |
| tMON → tAUSD | `25000` | 1 MON = 0.025 AUSD |
| tUSDC → tAUSD | `1000000000000000000` | 1:1 |
| tAUSD → tUSDC | `1000000000000000000` | 1:1 |
| tUSDC → tMON | `40000000000000000000000000000000` (4e31) | 1 USDC = 40 MON (rarely used) |

**Commands**

```bash
cd contracts && forge build
```

**Exit checks**
- [ ] Compiles
- [ ] `forge inspect MockStableToken abi | jq -r '.[].name' | grep -E "^receiveWithAuthorization$|^authorizationState$|^version$|^DOMAIN_SEPARATOR$"` prints all 4
- [ ] `cast keccak "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"` = `0xd099cc98…13de8`

**Commit:** `feat(contracts): mock stablecoins with EIP-3009, mock tMON, fixed-rate MockSwapAdapter`

---

### Phase A10 — Registry + mock token tests

**Goal:** prove every registry rule and the 3009 mock semantics before the vault depends on them. **Time:** 70 min.
**Depends on:** A8, A9.

**File: `contracts/test/utils/RegistryBase.sol`** — shared fixture (the vault fixture in A13 extends it)

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import "../../src/libraries/ScanPayTypes.sol";
import {MerchantRegistry} from "../../src/MerchantRegistry.sol";
import {MockStableToken} from "../../src/mocks/MockStableToken.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";

abstract contract RegistryBase is Test {
    // Deterministic test keys (never used outside tests)
    uint256 internal constant OWNER_PK = 0xC0FFEE;
    uint256 internal constant PAYOUT_PK = 0xBEEF01;
    uint256 internal constant SIGNER_PK = 0xB0B;
    uint256 internal constant SIGNER2_PK = 0xB0B2;
    uint256 internal constant PAYOUT2_PK = 0xBEEF02;
    uint256 internal constant PAYER_PK = 0xA11CE;
    uint256 internal constant ATTACKER_PK = 0xBAD;

    uint64 internal constant T0 = 1_760_000_000; // 2025-10-09, any fixed time works
    bytes32 internal constant SALT = keccak256("shop-1");
    bytes32 internal constant PROFILE_HASH = keccak256("profile-v1");

    address internal admin;
    address internal operator;
    address internal feeRecipient;
    address internal owner;
    address internal payoutWallet;
    address internal invoiceSigner;
    address internal payer;
    address internal attacker;

    MerchantRegistry internal registry;
    MockStableToken internal usdc;
    MockStableToken internal ausd;
    MockERC20 internal mon;

    function setUp() public virtual {
        vm.warp(T0);
        admin = makeAddr("admin");
        operator = makeAddr("operator");
        feeRecipient = makeAddr("feeRecipient");
        owner = vm.addr(OWNER_PK);
        payoutWallet = vm.addr(PAYOUT_PK);
        invoiceSigner = vm.addr(SIGNER_PK);
        payer = vm.addr(PAYER_PK);
        attacker = vm.addr(ATTACKER_PK);

        vm.startPrank(admin);
        registry = new MerchantRegistry(admin);
        usdc = new MockStableToken("ScanPay Test USDC", "tUSDC", 6, admin);
        ausd = new MockStableToken("ScanPay Test AUSD", "tAUSD", 6, admin);
        mon = new MockERC20("ScanPay Test MON", "tMON", 18, admin);
        registry.setPayoutTokenAllowed(address(usdc), true);
        registry.setPayoutTokenAllowed(address(ausd), true);
        registry.grantRole(registry.VERIFIER_ROLE(), operator);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- signing helpers

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _registration(bytes32 salt, address token, uint256 nonce) internal view returns (Registration memory) {
        return Registration({
            owner: owner,
            salt: salt,
            payoutWallet: payoutWallet,
            invoiceSigner: invoiceSigner,
            payoutToken: token,
            metadataHash: PROFILE_HASH,
            nonce: nonce,
            deadline: uint64(block.timestamp + 1 hours)
        });
    }

    function _register(bytes32 salt, address token) internal returns (bytes32 id) {
        Registration memory r = _registration(salt, token, registry.ownerNonce(owner));
        bytes32 d = registry.hashRegistration(r);
        id = registry.registerMerchant(r, _sign(OWNER_PK, d), _sign(PAYOUT_PK, d));
    }

    function _registerAndApprove(bytes32 salt, address token) internal returns (bytes32 id) {
        id = _register(salt, token);
        vm.prank(operator);
        registry.setMerchantStatus(id, MERCHANT_ACTIVE);
    }

    function _rotate(bytes32 id, uint256 newSignerPk) internal {
        SignerRotation memory r = SignerRotation({
            merchantId: id,
            newSigner: vm.addr(newSignerPk),
            nonce: registry.ownerNonce(owner),
            deadline: uint64(block.timestamp + 1 hours)
        });
        registry.rotateInvoiceSigner(r, _sign(OWNER_PK, registry.hashSignerRotation(r)));
    }
}
```

**File: `contracts/test/MerchantRegistry.t.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {RegistryBase} from "./utils/RegistryBase.sol";
import {IMerchantRegistry} from "../src/interfaces/IMerchantRegistry.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import "../src/libraries/ScanPayTypes.sol";

contract MerchantRegistryTest is RegistryBase {
    // ------------------------------------------------------------ registration

    function test_register_storesMerchantPending() public {
        bytes32 id = _register(SALT, address(usdc));
        assertEq(id, keccak256(abi.encode(owner, SALT)), "merchantId derivation");
        Merchant memory m = registry.getMerchant(id);
        assertEq(m.owner, owner);
        assertEq(m.payoutWallet, payoutWallet);
        assertEq(m.invoiceSigner, invoiceSigner);
        assertEq(m.payoutToken, address(usdc));
        assertEq(m.keyVersion, 1);
        assertEq(m.status, MERCHANT_PENDING);
        assertEq(m.registeredAt, T0);
        assertEq(m.metadataHash, PROFILE_HASH);
        assertEq(registry.ownerNonce(owner), 1);
    }

    function test_register_emitsEvents() public {
        Registration memory r = _registration(SALT, address(usdc), 0);
        bytes32 d = registry.hashRegistration(r);
        bytes32 id = registry.computeMerchantId(owner, SALT);

        vm.expectEmit(true, true, false, true, address(registry));
        emit IMerchantRegistry.MerchantRegistered(
            id, owner, SALT, payoutWallet, invoiceSigner, address(usdc), PROFILE_HASH
        );
        vm.expectEmit(true, true, false, true, address(registry));
        emit IMerchantRegistry.MerchantStatusChanged(id, MERCHANT_NONE, MERCHANT_PENDING, attacker);

        vm.prank(attacker); // any relayer may submit
        registry.registerMerchant(r, _sign(OWNER_PK, d), _sign(PAYOUT_PK, d));
    }

    function test_register_revert_expired() public {
        Registration memory r = _registration(SALT, address(usdc), 0);
        r.deadline = uint64(block.timestamp - 1);
        bytes32 d = registry.hashRegistration(r);
        vm.expectRevert(IMerchantRegistry.SignatureExpired.selector);
        registry.registerMerchant(r, _sign(OWNER_PK, d), _sign(PAYOUT_PK, d));
    }

    function test_register_revert_zeroAddress() public {
        Registration memory r = _registration(SALT, address(usdc), 0);
        r.invoiceSigner = address(0);
        bytes32 d = registry.hashRegistration(r);
        vm.expectRevert(IMerchantRegistry.ZeroAddress.selector);
        registry.registerMerchant(r, _sign(OWNER_PK, d), _sign(PAYOUT_PK, d));
    }

    function test_register_revert_tokenNotAllowed() public {
        Registration memory r = _registration(SALT, address(mon), 0);
        bytes32 d = registry.hashRegistration(r);
        vm.expectRevert(abi.encodeWithSelector(IMerchantRegistry.PayoutTokenNotAllowed.selector, address(mon)));
        registry.registerMerchant(r, _sign(OWNER_PK, d), _sign(PAYOUT_PK, d));
    }

    function test_register_revert_badNonce() public {
        Registration memory r = _registration(SALT, address(usdc), 5);
        bytes32 d = registry.hashRegistration(r);
        vm.expectRevert(abi.encodeWithSelector(IMerchantRegistry.BadNonce.selector, 0, 5));
        registry.registerMerchant(r, _sign(OWNER_PK, d), _sign(PAYOUT_PK, d));
    }

    function test_register_revert_replaySameSignedMessage() public {
        Registration memory r = _registration(SALT, address(usdc), 0);
        bytes32 d = registry.hashRegistration(r);
        bytes memory o = _sign(OWNER_PK, d);
        bytes memory p = _sign(PAYOUT_PK, d);
        registry.registerMerchant(r, o, p);
        vm.expectRevert(abi.encodeWithSelector(IMerchantRegistry.BadNonce.selector, 1, 0));
        registry.registerMerchant(r, o, p);
    }

    function test_register_revert_duplicateMerchant() public {
        _register(SALT, address(usdc));
        Registration memory r = _registration(SALT, address(usdc), 1); // fresh nonce, same salt
        bytes32 d = registry.hashRegistration(r);
        bytes32 id = registry.computeMerchantId(owner, SALT);
        vm.expectRevert(abi.encodeWithSelector(IMerchantRegistry.MerchantAlreadyExists.selector, id));
        registry.registerMerchant(r, _sign(OWNER_PK, d), _sign(PAYOUT_PK, d));
    }

    function test_register_revert_ownerSigFromWrongKey() public {
        Registration memory r = _registration(SALT, address(usdc), 0);
        bytes32 d = registry.hashRegistration(r);
        vm.expectRevert(IMerchantRegistry.InvalidOwnerSignature.selector);
        registry.registerMerchant(r, _sign(ATTACKER_PK, d), _sign(PAYOUT_PK, d));
    }

    function test_register_revert_payoutSigMissing() public {
        // Proves an attacker can't register someone else's wallet as payout without that wallet's signature.
        Registration memory r = _registration(SALT, address(usdc), 0);
        bytes32 d = registry.hashRegistration(r);
        vm.expectRevert(IMerchantRegistry.InvalidPayoutSignature.selector);
        registry.registerMerchant(r, _sign(OWNER_PK, d), _sign(OWNER_PK, d));
    }

    function test_register_revert_tamperedAfterSigning() public {
        Registration memory r = _registration(SALT, address(usdc), 0);
        bytes32 d = registry.hashRegistration(r);
        bytes memory o = _sign(OWNER_PK, d);
        bytes memory p = _sign(PAYOUT_PK, d);
        r.payoutWallet = attacker; // relayer swaps payout wallet
        vm.expectRevert(IMerchantRegistry.InvalidOwnerSignature.selector);
        registry.registerMerchant(r, o, p);
    }

    // ------------------------------------------------------------ status

    function test_status_verifierApproves() public {
        bytes32 id = _register(SALT, address(usdc));
        vm.expectEmit(true, true, false, true, address(registry));
        emit IMerchantRegistry.MerchantStatusChanged(id, MERCHANT_PENDING, MERCHANT_ACTIVE, operator);
        vm.prank(operator);
        registry.setMerchantStatus(id, MERCHANT_ACTIVE);
        assertEq(registry.getMerchant(id).status, MERCHANT_ACTIVE);
    }

    function test_status_revert_notVerifier() public {
        bytes32 id = _register(SALT, address(usdc));
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, attacker, registry.VERIFIER_ROLE()
            )
        );
        vm.prank(attacker);
        registry.setMerchantStatus(id, MERCHANT_ACTIVE);
    }

    function test_status_revert_unknownMerchant() public {
        vm.expectRevert(abi.encodeWithSelector(IMerchantRegistry.MerchantNotFound.selector, bytes32(uint256(1))));
        vm.prank(operator);
        registry.setMerchantStatus(bytes32(uint256(1)), MERCHANT_ACTIVE);
    }

    function test_status_fullLifecycle() public {
        bytes32 id = _registerAndApprove(SALT, address(usdc));
        vm.startPrank(operator);
        registry.setMerchantStatus(id, MERCHANT_SUSPENDED);
        registry.setMerchantStatus(id, MERCHANT_ACTIVE);
        registry.setMerchantStatus(id, MERCHANT_REVOKED);
        vm.expectRevert(
            abi.encodeWithSelector(IMerchantRegistry.InvalidStatusTransition.selector, MERCHANT_REVOKED, MERCHANT_ACTIVE)
        );
        registry.setMerchantStatus(id, MERCHANT_ACTIVE);
        vm.stopPrank();
    }

    function test_status_revert_pendingToSuspended() public {
        bytes32 id = _register(SALT, address(usdc));
        vm.expectRevert(
            abi.encodeWithSelector(
                IMerchantRegistry.InvalidStatusTransition.selector, MERCHANT_PENDING, MERCHANT_SUSPENDED
            )
        );
        vm.prank(operator);
        registry.setMerchantStatus(id, MERCHANT_SUSPENDED);
    }

    function test_status_revert_toNoneOrUnknownValue() public {
        bytes32 id = _registerAndApprove(SALT, address(usdc));
        vm.startPrank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(IMerchantRegistry.InvalidStatusTransition.selector, MERCHANT_ACTIVE, MERCHANT_NONE)
        );
        registry.setMerchantStatus(id, MERCHANT_NONE);
        vm.expectRevert(abi.encodeWithSelector(IMerchantRegistry.InvalidStatusTransition.selector, MERCHANT_ACTIVE, 9));
        registry.setMerchantStatus(id, 9);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ rotation

    function test_rotate_bumpsKeyVersion() public {
        bytes32 id = _registerAndApprove(SALT, address(usdc));
        vm.expectEmit(true, false, false, true, address(registry));
        emit IMerchantRegistry.InvoiceSignerRotated(id, vm.addr(SIGNER2_PK), 2);
        _rotate(id, SIGNER2_PK);
        Merchant memory m = registry.getMerchant(id);
        assertEq(m.invoiceSigner, vm.addr(SIGNER2_PK));
        assertEq(m.keyVersion, 2);
        assertEq(registry.ownerNonce(owner), 2);
    }

    function test_rotate_revert_notOwnerSig() public {
        bytes32 id = _registerAndApprove(SALT, address(usdc));
        SignerRotation memory r = SignerRotation(id, attacker, 1, uint64(block.timestamp + 60));
        bytes32 d = registry.hashSignerRotation(r);
        vm.expectRevert(IMerchantRegistry.InvalidOwnerSignature.selector);
        registry.rotateInvoiceSigner(r, _sign(SIGNER_PK, d)); // invoice key may NOT rotate itself
    }

    function test_rotate_revert_revoked() public {
        bytes32 id = _registerAndApprove(SALT, address(usdc));
        vm.prank(operator);
        registry.setMerchantStatus(id, MERCHANT_REVOKED);
        SignerRotation memory r = SignerRotation(id, vm.addr(SIGNER2_PK), 1, uint64(block.timestamp + 60));
        bytes32 d = registry.hashSignerRotation(r);
        vm.expectRevert(abi.encodeWithSelector(IMerchantRegistry.MerchantIsRevoked.selector, id));
        registry.rotateInvoiceSigner(r, _sign(OWNER_PK, d));
    }

    function test_rotate_allowedWhileSuspended() public {
        bytes32 id = _registerAndApprove(SALT, address(usdc));
        vm.prank(operator);
        registry.setMerchantStatus(id, MERCHANT_SUSPENDED);
        _rotate(id, SIGNER2_PK); // suspended merchant can rotate a leaked key before being re-activated
        assertEq(registry.getMerchant(id).keyVersion, 2);
    }

    // ------------------------------------------------------------ payout update

    function test_updatePayout_requiresNewWalletSig() public {
        bytes32 id = _registerAndApprove(SALT, address(usdc));
        address newWallet = vm.addr(PAYOUT2_PK);
        PayoutUpdate memory u = PayoutUpdate(id, newWallet, address(ausd), 1, uint64(block.timestamp + 60));
        bytes32 d = registry.hashPayoutUpdate(u);

        vm.expectRevert(IMerchantRegistry.InvalidPayoutSignature.selector);
        registry.updatePayout(u, _sign(OWNER_PK, d), _sign(PAYOUT_PK, d)); // old wallet's sig is not enough

        vm.expectEmit(true, false, false, true, address(registry));
        emit IMerchantRegistry.PayoutUpdated(id, newWallet, address(ausd), 2);
        registry.updatePayout(u, _sign(OWNER_PK, d), _sign(PAYOUT2_PK, d));

        Merchant memory m = registry.getMerchant(id);
        assertEq(m.payoutWallet, newWallet);
        assertEq(m.payoutToken, address(ausd));
        assertEq(m.keyVersion, 2);
    }

    function test_updatePayout_revert_tokenNotAllowed() public {
        bytes32 id = _registerAndApprove(SALT, address(usdc));
        PayoutUpdate memory u = PayoutUpdate(id, payoutWallet, address(mon), 1, uint64(block.timestamp + 60));
        bytes32 d = registry.hashPayoutUpdate(u);
        vm.expectRevert(abi.encodeWithSelector(IMerchantRegistry.PayoutTokenNotAllowed.selector, address(mon)));
        registry.updatePayout(u, _sign(OWNER_PK, d), _sign(PAYOUT_PK, d));
    }

    // ------------------------------------------------------------ config + views

    function test_setPayoutTokenAllowed_onlyConfig() public {
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, attacker, registry.CONFIG_ROLE())
        );
        vm.prank(attacker);
        registry.setPayoutTokenAllowed(address(mon), true);

        vm.expectEmit(true, false, false, true, address(registry));
        emit IMerchantRegistry.PayoutTokenAllowed(address(mon), true);
        vm.prank(admin);
        registry.setPayoutTokenAllowed(address(mon), true);
        assertTrue(registry.isPayoutTokenAllowed(address(mon)));
    }

    function test_getMerchant_unknownReturnsZero() public view {
        Merchant memory m = registry.getMerchant(keccak256("nope"));
        assertEq(m.status, MERCHANT_NONE);
        assertEq(m.owner, address(0));
    }

    function test_hashRegistration_matchesManualDigest() public view {
        Registration memory r = _registration(SALT, address(usdc), 0);
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ScanPayRegistry"),
                keccak256("1"),
                block.chainid,
                address(registry)
            )
        );
        bytes32 expected = keccak256(abi.encodePacked("\x19\x01", domain, ScanPayTypes.hashRegistration(r)));
        assertEq(registry.hashRegistration(r), expected);
    }
}
```

**File: `contracts/test/MockStableToken.t.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {RegistryBase} from "./utils/RegistryBase.sol";
import {MockStableToken} from "../src/mocks/MockStableToken.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

contract MockStableTokenTest is RegistryBase {
    address internal receiver;

    function setUp() public override {
        super.setUp();
        receiver = makeAddr("receiver");
        vm.prank(admin);
        usdc.mint(payer, 100e6);
    }

    function _rwaDigest(address to, uint256 value, uint256 validBefore, bytes32 nonce) internal view returns (bytes32) {
        bytes32 structHash =
            keccak256(abi.encode(usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), payer, to, value, 0, validBefore, nonce));
        return keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
    }

    function test_metadata() public view {
        assertEq(usdc.decimals(), 6);
        assertEq(usdc.version(), "1");
        assertEq(usdc.name(), "ScanPay Test USDC");
        assertEq(
            usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
            0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8
        );
        assertEq(mon.decimals(), 18);
    }

    function test_mint_onlyMinter() public {
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, attacker, usdc.MINTER_ROLE())
        );
        vm.prank(attacker);
        usdc.mint(attacker, 1);
    }

    function test_receiveWithAuthorization_happy() public {
        bytes32 nonce = keccak256("n1");
        uint256 validBefore = block.timestamp + 60;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PAYER_PK, _rwaDigest(receiver, 10e6, validBefore, nonce));
        vm.prank(receiver);
        usdc.receiveWithAuthorization(payer, receiver, 10e6, 0, validBefore, nonce, v, r, s);
        assertEq(usdc.balanceOf(receiver), 10e6);
        assertTrue(usdc.authorizationState(payer, nonce));
    }

    function test_receiveWithAuthorization_revert_callerNotPayee() public {
        bytes32 nonce = keccak256("n1");
        uint256 validBefore = block.timestamp + 60;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PAYER_PK, _rwaDigest(receiver, 10e6, validBefore, nonce));
        vm.expectRevert(MockStableToken.CallerMustBePayee.selector);
        vm.prank(attacker); // front-runner can't steal the authorization
        usdc.receiveWithAuthorization(payer, receiver, 10e6, 0, validBefore, nonce, v, r, s);
    }

    function test_receiveWithAuthorization_revert_replay() public {
        bytes32 nonce = keccak256("n1");
        uint256 validBefore = block.timestamp + 60;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PAYER_PK, _rwaDigest(receiver, 1e6, validBefore, nonce));
        vm.startPrank(receiver);
        usdc.receiveWithAuthorization(payer, receiver, 1e6, 0, validBefore, nonce, v, r, s);
        vm.expectRevert(MockStableToken.AuthorizationAlreadyUsed.selector);
        usdc.receiveWithAuthorization(payer, receiver, 1e6, 0, validBefore, nonce, v, r, s);
        vm.stopPrank();
    }

    function test_receiveWithAuthorization_revert_expired() public {
        bytes32 nonce = keccak256("n1");
        uint256 validBefore = block.timestamp + 60;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PAYER_PK, _rwaDigest(receiver, 1e6, validBefore, nonce));
        vm.warp(validBefore);
        vm.expectRevert(MockStableToken.AuthorizationExpired.selector);
        vm.prank(receiver);
        usdc.receiveWithAuthorization(payer, receiver, 1e6, 0, validBefore, nonce, v, r, s);
    }

    function test_receiveWithAuthorization_revert_wrongValue() public {
        bytes32 nonce = keccak256("n1");
        uint256 validBefore = block.timestamp + 60;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PAYER_PK, _rwaDigest(receiver, 1e6, validBefore, nonce));
        vm.expectRevert(MockStableToken.InvalidAuthorizationSignature.selector);
        vm.prank(receiver);
        usdc.receiveWithAuthorization(payer, receiver, 2e6, 0, validBefore, nonce, v, r, s);
    }
}
```

**Commands**

```bash
cd contracts && forge test --match-contract "MerchantRegistryTest|MockStableTokenTest" -vv
```

**Exit checks**
- [ ] All registry tests pass (≥ 24)
- [ ] All mock-token tests pass (6)
- [ ] `forge coverage --match-contract MerchantRegistryTest --report summary` shows `MerchantRegistry.sol` lines ≥ 95%

**Commit:** `test(contracts): registry lifecycle, dual-sig, rotation, payout update; 3009 mock semantics`

---

### Phase A11 — `DepositForwarder` (per-intent deposit address)

**Goal:** a tiny contract that only the vault can sweep. The vault deploys one EIP-1167 **clone per cross-chain
intent** at `CREATE2(salt = intentId)`. That address is the Aurora `recipient`. **Time:** 25 min. **Depends on:** A5.

Why a clone and not "send to the vault": with a per-intent address, the vault can prove *which* intent a deposit
belongs to by looking at a balance — no memo, no off-chain matching, and B can never mis-attribute a deposit.

**File: `contracts/src/DepositForwarder.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title DepositForwarder — implementation behind every per-intent clone
/// @notice `vault` is an immutable baked into the implementation bytecode; EIP-1167 clones delegatecall into this
///         code, so every clone reports the same vault and only that vault can move funds out.
contract DepositForwarder {
    using SafeERC20 for IERC20;

    address public immutable vault;

    error OnlyVault();

    constructor(address vault_) {
        vault = vault_;
    }

    /// @notice Move this forwarder's entire balance of `token` to `to`. Returns the amount moved (0 is fine).
    function sweep(address token, address to) external returns (uint256 amount) {
        if (msg.sender != vault) revert OnlyVault();
        amount = IERC20(token).balanceOf(address(this));
        if (amount != 0) IERC20(token).safeTransfer(to, amount);
    }
}
```

> No `receive()`/`fallback`: native MON sent to a forwarder reverts. Aurora delivers **ERC-20 USDC** on Monad, so
> this is intentional — B must never request native MON as the destination asset.

**File: `contracts/test/DepositForwarder.t.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {DepositForwarder} from "../src/DepositForwarder.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

contract DepositForwarderTest is Test {
    DepositForwarder internal impl;
    MockERC20 internal token;
    address internal to = makeAddr("to");

    function setUp() public {
        impl = new DepositForwarder(address(this)); // this test contract plays "vault"
        token = new MockERC20("T", "T", 6, address(this));
    }

    function test_clone_predictableAndSweepable() public {
        bytes32 salt = keccak256("intent-1");
        address predicted = Clones.predictDeterministicAddress(address(impl), salt, address(this));

        token.mint(predicted, 5e6); // deposit BEFORE the clone exists (Aurora may be faster than commit)
        address clone = Clones.cloneDeterministic(address(impl), salt);
        assertEq(clone, predicted);
        assertEq(DepositForwarder(clone).vault(), address(this));

        uint256 moved = DepositForwarder(clone).sweep(address(token), to);
        assertEq(moved, 5e6);
        assertEq(token.balanceOf(to), 5e6);
        assertEq(token.balanceOf(clone), 0);
    }

    function test_sweep_onlyVault() public {
        address clone = Clones.cloneDeterministic(address(impl), keccak256("x"));
        vm.prank(makeAddr("attacker"));
        vm.expectRevert(DepositForwarder.OnlyVault.selector);
        DepositForwarder(clone).sweep(address(token), to);
    }

    function test_sweep_zeroBalanceIsNoop() public {
        address clone = Clones.cloneDeterministic(address(impl), keccak256("y"));
        assertEq(DepositForwarder(clone).sweep(address(token), to), 0);
    }

    function test_nativeTransferReverts() public {
        address clone = Clones.cloneDeterministic(address(impl), keccak256("z"));
        vm.deal(address(this), 1 ether);
        (bool ok,) = clone.call{value: 1}("");
        assertFalse(ok);
    }
}
```

**Commands**

```bash
cd contracts && forge test --match-contract DepositForwarderTest -vv
```

**Exit checks**
- [ ] 4 tests pass
- [ ] `test_clone_predictableAndSweepable` proves deposit-before-deploy works (this is the Aurora race)

**Commit:** `feat(contracts): DepositForwarder clone implementation`

---

### Phase A12 — `IntentVault` (proof of intent + proof of settlement)

**Goal:** the core contract. It verifies the merchant-signed invoice and the payer-signed intent, enforces one-time
use, pulls funds by the route's mechanism, and pays the **registry-snapshotted** payout wallet. **Time:** 2 h.
**Depends on:** A8, A11.

#### A12.1 Semantics you must know before reading the code

| Topic | Rule |
|---|---|
| Who calls | Anyone (Backend B's relayer in practice). Authority = signatures. `msg.sender` is never trusted for money movement |
| Where money goes | Always `merchant.payoutWallet` **read from the registry at verify time** and stored in the record. Neither the relayer nor the payer can name a destination |
| Fee | `fee = amountOut × feeBps / 10_000` (floor), taken **from** `amountOut`. Merchant gets `amountOut − fee`. `feeBps ≤ 100` (1%) |
| Excess | Any payout-token surplus (cross-chain over-delivery, Kuru positive slippage) → `refundTo`. Unused input token → `refundTo` (by the adapter) |
| Vault balance | The vault **never holds funds between transactions** (invariant tested in A17). This is why balance-delta accounting is safe |
| `IntentCommitted` | Emitted for **every** route (DIRECT/SWAP in the same tx as `PaymentSettled`) so the indexer has one code path. `forwarder = address(0)` for DIRECT/SWAP |
| `IntentRecord.inputAmount` | While `COMMITTED`: the **required/max input** (= `intent.maxAmountIn`). After `SETTLED`: the input actually consumed. After `REFUNDED`: unchanged |
| `maxAmountIn` rules | If `inputToken == payoutToken`: must be `≥ amountOut` (DIRECT: set it `= amountOut`). Otherwise must be `> 0` |
| Cross-chain required deposit | `maxAmountIn` of `inputToken` (USDC) at the forwarder. B asks Aurora for **EXACT_OUTPUT = maxAmountIn** to the forwarder |
| Cross-chain settle timing | Allowed any time while `COMMITTED` (even after `expiresAt`) — a late solver delivery still pays the merchant. Refund only after `expiresAt + refundDelay`. Whoever calls first wins; B's watcher always tries settle first |
| Pause | `pause()` blocks `payDirect`, `paySwap`, `commitCrossChain`, `settleCrossChain`. **Never** blocks `refundCrossChain` or `rescue` (users can always get money back) |
| Invoice states | verify requires `OPEN`; open-record sets `RESERVED`; settle sets `PAID`; cross-chain refund sets back to `OPEN` |
| Nonces | `usedNonce[payer][nonce]` set at verify, **never cleared** (even on refund) |

Check order inside `_verify` (B maps errors in this order; tests depend on it):

```
1 shape     RouteMismatch → InvoiceMismatch → PayoutTokenMismatch → AmountMismatch(amountOut != invoice.amount or 0) → ZeroAddress(refundTo)
2 time      InvoiceExpired → IntentExpired
3 merchant  MerchantNotActive → KeyVersionMismatch(invoice) → KeyVersionMismatch(intent) → PayoutTokenMismatch(vs registry) → PayoutTokenNotAllowed → AmountAboveCap
4 input     InputTokenNotAllowed → InputTokenNotAllowed(DIRECT needs input==payout) → AmountMismatch(maxAmountIn rule)
5 sigs      InvalidMerchantSignature → InvalidPayerSignature
6 one-time  NonceAlreadyUsed → InvoiceNotOpen → IntentAlreadyExists
```

#### A12.2 Code

**File: `contracts/src/IntentVault.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IIntentVault} from "./interfaces/IIntentVault.sol";
import {IMerchantRegistry} from "./interfaces/IMerchantRegistry.sol";
import {ISwapAdapter} from "./interfaces/ISwapAdapter.sol";
import {IERC3009} from "./interfaces/IERC3009.sol";
import {DepositForwarder} from "./DepositForwarder.sol";
import "./libraries/ScanPayTypes.sol";

/// @title IntentVault — ScanPay Guard settlement contract
/// @notice Proof of intent: merchant-signed Invoice + payer-signed PaymentIntent, one-time nonce, one-time invoice.
///         Proof of settlement: funds can only reach the merchant's registered payout wallet, exactly amountOut − fee.
contract IntentVault is IIntentVault, EIP712, AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant CONFIG_ROLE = keccak256("CONFIG_ROLE");
    bytes32 public constant ATTESTER_ROLE = keccak256("ATTESTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    uint16 public constant MAX_FEE_BPS = 100;

    IMerchantRegistry public immutable registry;
    address public immutable forwarderImplementation;

    uint16 public feeBps;
    address public feeRecipient;
    address public swapAdapter;
    uint64 public refundDelay;
    address public crossChainInputToken;

    mapping(address token => uint256) public amountCap;
    mapping(address payer => mapping(uint256 nonce => bool)) public usedNonce;
    mapping(bytes32 merchantId => mapping(bytes32 invoiceId => uint8)) public invoiceState;
    mapping(address token => mapping(uint8 route => bool)) private _inputAllowed;
    mapping(bytes32 intentId => IntentRecord) private _intents;

    constructor(
        address admin,
        IMerchantRegistry registry_,
        address feeRecipient_,
        uint16 feeBps_,
        uint64 refundDelay_
    ) EIP712("ScanPayGuard", "1") {
        if (admin == address(0) || address(registry_) == address(0) || feeRecipient_ == address(0)) {
            revert ZeroAddress();
        }
        if (feeBps_ > MAX_FEE_BPS) revert InvalidFee(feeBps_);

        registry = registry_;
        forwarderImplementation = address(new DepositForwarder(address(this)));
        feeBps = feeBps_;
        feeRecipient = feeRecipient_;
        refundDelay = refundDelay_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CONFIG_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);

        emit FeeUpdated(feeBps_, feeRecipient_);
        emit RefundDelayUpdated(refundDelay_);
    }

    // =====================================================================================================
    // Payments
    // =====================================================================================================

    /// @notice DIRECT: payer's EIP-3009 ReceiveWithAuthorization (nonce = intent digest) moves exactly amountOut.
    function payDirect(
        PaymentIntent calldata intent,
        Invoice calldata invoice,
        bytes calldata merchantSig,
        bytes calldata payerSig,
        Auth3009 calldata auth
    ) external whenNotPaused nonReentrant returns (bytes32 intentId) {
        bytes32 digest;
        address payoutWallet;
        (intentId, digest, payoutWallet) = _verify(intent, invoice, merchantSig, payerSig, ROUTE_DIRECT);
        _openRecord(intentId, intent, payoutWallet, address(0));

        IERC20 token = IERC20(intent.payoutToken);
        uint256 before = token.balanceOf(address(this));
        // Reverts from the token bubble up unchanged -> B maps them to TOKEN_AUTHORIZATION_FAILED.
        IERC3009(intent.payoutToken).receiveWithAuthorization(
            intent.payer, address(this), intent.amountOut, 0, intent.expiresAt, digest, auth.v, auth.r, auth.s
        );
        uint256 received = token.balanceOf(address(this)) - before;
        if (received < intent.amountOut) revert Underpaid(received, intent.amountOut);

        _settle(intentId, received, received);
    }

    /// @notice SWAP: payer pre-approved the vault for inputToken. The signature authorizes pulling maxAmountIn,
    ///         swapping via the adapter to exactly >= amountOut, and refunding unused input to refundTo.
    ///         If inputToken == payoutToken, pulls exactly amountOut (allowance-based fallback for non-3009 tokens).
    function paySwap(
        PaymentIntent calldata intent,
        Invoice calldata invoice,
        bytes calldata merchantSig,
        bytes calldata payerSig,
        bytes calldata swapData
    ) external whenNotPaused nonReentrant returns (bytes32 intentId) {
        address payoutWallet;
        (intentId,, payoutWallet) = _verify(intent, invoice, merchantSig, payerSig, ROUTE_SWAP);

        if (intent.inputToken == intent.payoutToken) {
            _openRecord(intentId, intent, payoutWallet, address(0));
            IERC20(intent.payoutToken).safeTransferFrom(intent.payer, address(this), intent.amountOut);
            _settle(intentId, intent.amountOut, intent.amountOut);
            return intentId;
        }

        address adapter = swapAdapter;
        if (adapter == address(0)) revert NoSwapAdapter();
        _openRecord(intentId, intent, payoutWallet, address(0));

        IERC20 inToken = IERC20(intent.inputToken);
        inToken.safeTransferFrom(intent.payer, adapter, intent.maxAmountIn);
        uint256 refundBefore = inToken.balanceOf(intent.refundTo); // measured AFTER the pull (works if refundTo == payer)
        uint256 out = _swap(
            adapter, intent.inputToken, intent.payoutToken, intent.maxAmountIn, intent.amountOut, swapData, intent.refundTo
        );
        uint256 leftover = inToken.balanceOf(intent.refundTo) - refundBefore;

        _settle(intentId, out, intent.maxAmountIn - leftover);
    }

    /// @notice CROSSCHAIN step 1: lock the intent and deploy its deposit forwarder (the Aurora recipient).
    function commitCrossChain(
        PaymentIntent calldata intent,
        Invoice calldata invoice,
        bytes calldata merchantSig,
        bytes calldata payerSig
    ) external whenNotPaused nonReentrant returns (bytes32 intentId, address forwarder) {
        address payoutWallet;
        (intentId,, payoutWallet) = _verify(intent, invoice, merchantSig, payerSig, ROUTE_CROSSCHAIN);
        if (intent.inputToken != intent.payoutToken && swapAdapter == address(0)) revert NoSwapAdapter();

        forwarder = Clones.cloneDeterministic(forwarderImplementation, intentId);
        _openRecord(intentId, intent, payoutWallet, forwarder);
    }

    /// @notice CROSSCHAIN step 2 (permissionless): settle from the forwarder balance. No off-chain claim can
    ///         settle an intent — only tokens actually sitting in the forwarder.
    function settleCrossChain(bytes32 intentId, bytes calldata swapData) external whenNotPaused nonReentrant {
        IntentRecord storage r = _intents[intentId];
        if (r.route != ROUTE_CROSSCHAIN || r.status != INTENT_COMMITTED) revert IntentNotCommitted(intentId);

        DepositForwarder fwd = DepositForwarder(forwarderOf(intentId));
        address inputToken = r.inputToken;
        uint256 required = r.inputAmount; // = maxAmountIn while COMMITTED
        uint256 bal = IERC20(inputToken).balanceOf(address(fwd));
        if (bal < required) revert Underpaid(bal, required);

        if (inputToken == r.payoutToken) {
            fwd.sweep(inputToken, address(this));
            _settle(intentId, bal, bal);
        } else {
            address adapter = swapAdapter;
            if (adapter == address(0)) revert NoSwapAdapter();
            address refundTo = r.refundTo;
            fwd.sweep(inputToken, adapter);
            uint256 refundBefore = IERC20(inputToken).balanceOf(refundTo);
            uint256 out = _swap(adapter, inputToken, r.payoutToken, bal, r.amountOut, swapData, refundTo);
            uint256 leftover = IERC20(inputToken).balanceOf(refundTo) - refundBefore;
            _settle(intentId, out, bal - leftover);
        }
    }

    /// @notice CROSSCHAIN escape hatch (permissionless, works while paused): after expiresAt + refundDelay,
    ///         return whatever reached the forwarder to refundTo and reopen the invoice.
    function refundCrossChain(bytes32 intentId) external nonReentrant {
        IntentRecord storage r = _intents[intentId];
        if (r.route != ROUTE_CROSSCHAIN || r.status != INTENT_COMMITTED) revert IntentNotCommitted(intentId);
        uint256 allowedAt = uint256(r.expiresAt) + refundDelay;
        if (block.timestamp < allowedAt) revert RefundNotYetAllowed(allowedAt);

        r.status = INTENT_REFUNDED;
        invoiceState[r.merchantId][r.invoiceId] = INVOICE_OPEN;
        uint256 amount = DepositForwarder(forwarderOf(intentId)).sweep(r.inputToken, r.refundTo);
        emit IntentRefunded(intentId, r.refundTo, r.inputToken, amount);
    }

    /// @notice Late or wrong-token deposits to a finished intent's forwarder always go to refundTo (permissionless).
    function rescue(bytes32 intentId, address token) external nonReentrant {
        IntentRecord storage r = _intents[intentId];
        if (r.route != ROUTE_CROSSCHAIN || (r.status != INTENT_SETTLED && r.status != INTENT_REFUNDED)) {
            revert IntentNotTerminal(intentId);
        }
        uint256 amount = DepositForwarder(forwarderOf(intentId)).sweep(token, r.refundTo);
        emit ForwarderRescued(intentId, r.refundTo, token, amount);
    }

    /// @notice Operator attestation of which source-chain tx funded the deposit (the one trusted statement).
    ///         Does NOT change status and can't move funds.
    function attestSource(bytes32 intentId, uint256 sourceChainId, bytes32 sourceTxHash, bytes32 providerRef)
        external
        onlyRole(ATTESTER_ROLE)
    {
        IntentRecord storage r = _intents[intentId];
        if (r.route != ROUTE_CROSSCHAIN || r.status == INTENT_NONE) revert IntentNotCommitted(intentId);
        if (r.sourceTxHash != bytes32(0)) revert AlreadyAttested(intentId);
        r.sourceChainId = sourceChainId;
        r.sourceTxHash = sourceTxHash;
        emit SourceAttested(intentId, sourceChainId, sourceTxHash, providerRef, msg.sender);
    }

    // =====================================================================================================
    // Config
    // =====================================================================================================

    function setFee(uint16 feeBps_, address feeRecipient_) external onlyRole(CONFIG_ROLE) {
        if (feeBps_ > MAX_FEE_BPS) revert InvalidFee(feeBps_);
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        feeBps = feeBps_;
        feeRecipient = feeRecipient_;
        emit FeeUpdated(feeBps_, feeRecipient_);
    }

    /// @dev address(0) disables SWAP route and cross-token cross-chain settles.
    function setSwapAdapter(address adapter) external onlyRole(CONFIG_ROLE) {
        swapAdapter = adapter;
        emit SwapAdapterUpdated(adapter);
    }

    function setRefundDelay(uint64 refundDelay_) external onlyRole(CONFIG_ROLE) {
        refundDelay = refundDelay_;
        emit RefundDelayUpdated(refundDelay_);
    }

    /// @dev cap = 0 means unlimited. Mainnet sets small caps (A23).
    function setAmountCap(address token, uint256 cap) external onlyRole(CONFIG_ROLE) {
        amountCap[token] = cap;
        emit AmountCapUpdated(token, cap);
    }

    /// @dev Only DIRECT (0) and SWAP (1). CROSSCHAIN input is configured with setCrossChainInputToken.
    function setInputTokenAllowed(address token, uint8 route, bool allowed) external onlyRole(CONFIG_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        if (route > ROUTE_SWAP) revert RouteMismatch(ROUTE_SWAP, route);
        _inputAllowed[token][route] = allowed;
        emit InputTokenAllowed(token, route, allowed);
    }

    function setCrossChainInputToken(address token) external onlyRole(CONFIG_ROLE) {
        crossChainInputToken = token;
        emit CrossChainInputTokenUpdated(token);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // =====================================================================================================
    // Views
    // =====================================================================================================

    function isInputTokenAllowed(address token, uint8 route) public view returns (bool) {
        if (route == ROUTE_CROSSCHAIN) return token != address(0) && token == crossChainInputToken;
        return _inputAllowed[token][route];
    }

    function getIntent(bytes32 intentId) external view returns (IntentRecord memory) {
        return _intents[intentId];
    }

    function forwarderOf(bytes32 intentId) public view returns (address) {
        return Clones.predictDeterministicAddress(forwarderImplementation, intentId, address(this));
    }

    function hashInvoice(Invoice calldata invoice) external view returns (bytes32 digest) {
        return _hashTypedDataV4(ScanPayTypes.hashInvoice(invoice));
    }

    function hashIntent(PaymentIntent calldata intent) external view returns (bytes32 digest) {
        return _hashTypedDataV4(ScanPayTypes.hashIntent(intent));
    }

    function computeIntentId(PaymentIntent calldata intent) external pure returns (bytes32) {
        return ScanPayTypes.computeIntentId(intent);
    }

    // =====================================================================================================
    // Internal
    // =====================================================================================================

    function _verify(
        PaymentIntent calldata p,
        Invoice calldata inv,
        bytes calldata merchantSig,
        bytes calldata payerSig,
        uint8 route
    ) internal returns (bytes32 intentId, bytes32 intentDigest, address payoutWallet) {
        // 1. shape
        if (p.route != route) revert RouteMismatch(route, p.route);
        if (p.merchantId != inv.merchantId || p.invoiceId != inv.invoiceId) revert InvoiceMismatch();
        if (p.payoutToken != inv.payoutToken) revert PayoutTokenMismatch();
        if (p.amountOut != inv.amount || inv.amount == 0) revert AmountMismatch();
        if (p.refundTo == address(0)) revert ZeroAddress();

        // 2. time
        if (block.timestamp > inv.expiresAt) revert InvoiceExpired();
        if (block.timestamp > p.expiresAt) revert IntentExpired();

        // 3. merchant (registry is the single source of truth for keys + payout)
        Merchant memory m = registry.getMerchant(inv.merchantId);
        if (m.status != MERCHANT_ACTIVE) revert MerchantNotActive(inv.merchantId, m.status);
        if (inv.keyVersion != m.keyVersion) revert KeyVersionMismatch(m.keyVersion, inv.keyVersion);
        if (p.keyVersion != m.keyVersion) revert KeyVersionMismatch(m.keyVersion, p.keyVersion);
        if (inv.payoutToken != m.payoutToken) revert PayoutTokenMismatch();
        if (!registry.isPayoutTokenAllowed(inv.payoutToken)) revert PayoutTokenNotAllowed(inv.payoutToken);
        uint256 cap = amountCap[inv.payoutToken];
        if (cap != 0 && inv.amount > cap) revert AmountAboveCap(inv.amount, cap);

        // 4. input token
        if (!isInputTokenAllowed(p.inputToken, route)) revert InputTokenNotAllowed(p.inputToken, route);
        if (route == ROUTE_DIRECT && p.inputToken != p.payoutToken) revert InputTokenNotAllowed(p.inputToken, route);
        if (p.inputToken == p.payoutToken ? p.maxAmountIn < p.amountOut : p.maxAmountIn == 0) {
            revert AmountMismatch();
        }

        // 5. signatures (EOA or ERC-1271)
        bytes32 invoiceDigest = _hashTypedDataV4(ScanPayTypes.hashInvoice(inv));
        if (!SignatureChecker.isValidSignatureNow(m.invoiceSigner, invoiceDigest, merchantSig)) {
            revert InvalidMerchantSignature();
        }
        intentDigest = _hashTypedDataV4(ScanPayTypes.hashIntent(p));
        if (!SignatureChecker.isValidSignatureNow(p.payer, intentDigest, payerSig)) revert InvalidPayerSignature();

        // 6. one-time use
        if (usedNonce[p.payer][p.nonce]) revert NonceAlreadyUsed(p.payer, p.nonce);
        uint8 st = invoiceState[inv.merchantId][inv.invoiceId];
        if (st != INVOICE_OPEN) revert InvoiceNotOpen(st);
        intentId = ScanPayTypes.computeIntentId(p);
        if (_intents[intentId].status != INTENT_NONE) revert IntentAlreadyExists(intentId);

        usedNonce[p.payer][p.nonce] = true;
        payoutWallet = m.payoutWallet;
    }

    function _openRecord(bytes32 id, PaymentIntent calldata p, address payoutWallet, address forwarder) internal {
        IntentRecord storage r = _intents[id];
        r.payer = p.payer;
        r.route = p.route;
        r.status = INTENT_COMMITTED;
        r.expiresAt = p.expiresAt;
        r.committedAt = uint64(block.timestamp);
        r.merchantId = p.merchantId;
        r.invoiceId = p.invoiceId;
        r.payoutToken = p.payoutToken;
        r.inputToken = p.inputToken;
        r.payoutWallet = payoutWallet;
        r.refundTo = p.refundTo;
        r.amountOut = p.amountOut;
        r.inputAmount = p.maxAmountIn;
        r.quoteHash = p.quoteHash;

        invoiceState[p.merchantId][p.invoiceId] = INVOICE_RESERVED;

        emit IntentCommitted(
            id,
            p.merchantId,
            p.payer,
            p.invoiceId,
            p.route,
            p.inputToken,
            p.payoutToken,
            p.amountOut,
            forwarder,
            payoutWallet,
            p.expiresAt,
            p.quoteHash
        );
    }

    /// @param available payout-token amount the vault received for this intent in this tx (>= amountOut).
    /// @param inputUsed input-token amount actually consumed (for the record + event).
    function _settle(bytes32 id, uint256 available, uint256 inputUsed) internal {
        IntentRecord storage r = _intents[id];
        uint256 amountOut = r.amountOut;
        uint256 fee = (amountOut * feeBps) / 10_000;
        uint256 excess = available - amountOut; // callers guarantee available >= amountOut

        r.status = INTENT_SETTLED;
        r.settledAt = uint64(block.timestamp);
        r.fee = fee;
        r.inputAmount = inputUsed;
        invoiceState[r.merchantId][r.invoiceId] = INVOICE_PAID;

        IERC20 token = IERC20(r.payoutToken);
        token.safeTransfer(r.payoutWallet, amountOut - fee);
        if (fee != 0) token.safeTransfer(feeRecipient, fee);
        if (excess != 0) token.safeTransfer(r.refundTo, excess);

        emit PaymentSettled(
            id,
            r.merchantId,
            r.payer,
            r.invoiceId,
            r.route,
            r.payoutToken,
            amountOut,
            fee,
            r.payoutWallet,
            r.inputToken,
            inputUsed,
            excess
        );
    }

    /// @dev Adapter already holds amountIn. Output is measured by balance delta (vault holds nothing between txs).
    function _swap(
        address adapter,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        bytes calldata data,
        address leftoverTo
    ) internal returns (uint256 out) {
        IERC20 outToken = IERC20(tokenOut);
        uint256 before = outToken.balanceOf(address(this));
        ISwapAdapter(adapter).swap(tokenIn, tokenOut, amountIn, minOut, data, address(this), leftoverTo);
        out = outToken.balanceOf(address(this)) - before;
        if (out < minOut) revert SwapOutputTooLow(out, minOut);
    }
}
```

> **Non-interface errors** the vault can also revert with (OpenZeppelin): `EnforcedPause()` (paused),
> `AccessControlUnauthorizedAccount(address,bytes32)`, `ReentrancyGuardReentrantCall()`, `SafeERC20FailedOperation(address)`,
> `ERC20InsufficientAllowance(...)` / `ERC20InsufficientBalance(...)` (bubbled from the token on SWAP). These are not
> in the interface ABI, so B maps them to `CHAIN_REVERT` unless B adds them to its decode ABI (B-doc does: B5).
> Mock adapter errors (`InsufficientOutput`, `NoRate`) and token errors bubble up unchanged.

**Commands**

```bash
cd contracts && forge build --sizes | grep -E "IntentVault|DepositForwarder|Contract"
```

**Exit checks**
- [ ] Compiles (via-IR; no "stack too deep")
- [ ] `IntentVault` runtime size < 24 KB
- [ ] `forge inspect IntentVault abi | jq '[.[] | select(.type=="event")] | length'` ≥ 11 (+ OZ role/pause events)
- [ ] Every function in `IIntentVault` is implemented (compiler enforces — no `abstract` error)

**Commit:** `feat(contracts): IntentVault — verify, direct/swap/cross-chain settle, refund, rescue, attest`

---

### Phase A13 — Vault fixture + DIRECT route tests

**Goal:** a reusable fixture with a live merchant, funded payer and configured vault; then every DIRECT-route rule.
**Time:** 75 min. **Depends on:** A10, A12.

**File: `contracts/test/utils/VaultBase.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {RegistryBase} from "./RegistryBase.sol";
import "../../src/libraries/ScanPayTypes.sol";
import {IntentVault} from "../../src/IntentVault.sol";
import {IMerchantRegistry} from "../../src/interfaces/IMerchantRegistry.sol";
import {MockStableToken} from "../../src/mocks/MockStableToken.sol";
import {MockSwapAdapter} from "../../src/adapters/MockSwapAdapter.sol";

abstract contract VaultBase is RegistryBase {
    uint16 internal constant FEE_BPS = 30; // 0.30%
    uint64 internal constant REFUND_DELAY = 600;
    uint256 internal constant AMOUNT = 12_000_000; // 12.00 (6 dec)
    uint256 internal constant FEE = (AMOUNT * FEE_BPS) / 10_000; // 36_000

    IntentVault internal vault;
    MockSwapAdapter internal adapter;
    bytes32 internal merchantId; // ACTIVE, payout tUSDC
    uint256 internal nextNonce = 1;

    function setUp() public virtual override {
        super.setUp();
        vm.startPrank(admin);
        vault = new IntentVault(admin, IMerchantRegistry(address(registry)), feeRecipient, FEE_BPS, REFUND_DELAY);
        adapter = new MockSwapAdapter(admin, address(vault));

        vault.grantRole(vault.ATTESTER_ROLE(), operator);
        vault.setSwapAdapter(address(adapter));
        vault.setInputTokenAllowed(address(usdc), ROUTE_DIRECT, true);
        vault.setInputTokenAllowed(address(ausd), ROUTE_DIRECT, true);
        vault.setInputTokenAllowed(address(usdc), ROUTE_SWAP, true);
        vault.setInputTokenAllowed(address(ausd), ROUTE_SWAP, true);
        vault.setInputTokenAllowed(address(mon), ROUTE_SWAP, true);
        vault.setCrossChainInputToken(address(usdc));

        adapter.setRate(address(mon), address(usdc), 25_000);
        adapter.setRate(address(mon), address(ausd), 25_000);
        adapter.setRate(address(usdc), address(ausd), 1e18);
        adapter.setRate(address(ausd), address(usdc), 1e18);

        usdc.mint(address(adapter), 1_000_000e6);
        ausd.mint(address(adapter), 1_000_000e6);
        usdc.mint(payer, 1_000e6);
        ausd.mint(payer, 1_000e6);
        mon.mint(payer, 100_000e18);
        vm.stopPrank();

        merchantId = _registerAndApprove(SALT, address(usdc));
    }

    // ---------------------------------------------------------------- builders

    function _invoiceFor(bytes32 mId, bytes32 invoiceId, address token, uint256 amount)
        internal
        view
        returns (Invoice memory)
    {
        return Invoice({
            merchantId: mId,
            invoiceId: invoiceId,
            payoutToken: token,
            amount: amount,
            expiresAt: uint64(block.timestamp + 15 minutes),
            keyVersion: registry.getMerchant(mId).keyVersion
        });
    }

    function _invoice(bytes32 invoiceId) internal view returns (Invoice memory) {
        return _invoiceFor(merchantId, invoiceId, address(usdc), AMOUNT);
    }

    function _intent(Invoice memory inv, uint8 route, address inputToken, uint256 maxIn)
        internal
        returns (PaymentIntent memory p)
    {
        p = PaymentIntent({
            merchantId: inv.merchantId,
            invoiceId: inv.invoiceId,
            payer: payer,
            payoutToken: inv.payoutToken,
            amountOut: inv.amount,
            route: route,
            inputToken: inputToken,
            maxAmountIn: maxIn,
            quoteHash: route == ROUTE_DIRECT ? bytes32(0) : keccak256("quote"),
            refundTo: payer,
            expiresAt: uint64(block.timestamp + 10 minutes),
            nonce: nextNonce++,
            keyVersion: inv.keyVersion
        });
    }

    function _merchantSig(Invoice memory inv) internal view returns (bytes memory) {
        return _sign(SIGNER_PK, vault.hashInvoice(inv));
    }

    function _payerSig(PaymentIntent memory p) internal view returns (bytes memory) {
        return _sign(PAYER_PK, vault.hashIntent(p));
    }

    /// @dev EIP-3009 ReceiveWithAuthorization bound to the intent digest (ICD §0.5).
    function _auth(PaymentIntent memory p) internal view returns (Auth3009 memory a) {
        MockStableToken t = MockStableToken(p.payoutToken);
        bytes32 structHash = keccak256(
            abi.encode(
                t.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                p.payer,
                address(vault),
                p.amountOut,
                uint256(0),
                uint256(p.expiresAt),
                vault.hashIntent(p)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", t.DOMAIN_SEPARATOR(), structHash));
        (a.v, a.r, a.s) = vm.sign(PAYER_PK, digest);
    }

    function _direct(bytes32 invoiceId) internal returns (Invoice memory inv, PaymentIntent memory p) {
        inv = _invoice(invoiceId);
        p = _intent(inv, ROUTE_DIRECT, address(usdc), AMOUNT);
    }

    function _payDirect(Invoice memory inv, PaymentIntent memory p) internal returns (bytes32) {
        return vault.payDirect(p, inv, _merchantSig(inv), _payerSig(p), _auth(p));
    }
}
```

**File: `contracts/test/IntentVault.Direct.t.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VaultBase} from "./utils/VaultBase.sol";
import {IIntentVault} from "../src/interfaces/IIntentVault.sol";
import {MockStableToken} from "../src/mocks/MockStableToken.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import "../src/libraries/ScanPayTypes.sol";

contract IntentVaultDirectTest is VaultBase {
    function test_direct_happyPath_balancesAndRecord() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        uint256 payerBefore = usdc.balanceOf(payer);

        vm.prank(operator); // relayer
        bytes32 id = _payDirect(inv, p);

        assertEq(id, vault.computeIntentId(p));
        assertEq(usdc.balanceOf(payer), payerBefore - AMOUNT, "payer debited exactly amountOut");
        assertEq(usdc.balanceOf(payoutWallet), AMOUNT - FEE, "merchant net");
        assertEq(usdc.balanceOf(feeRecipient), FEE, "fee");
        assertEq(usdc.balanceOf(address(vault)), 0, "vault holds nothing");

        IntentRecord memory r = vault.getIntent(id);
        assertEq(r.status, INTENT_SETTLED);
        assertEq(r.route, ROUTE_DIRECT);
        assertEq(r.payoutWallet, payoutWallet);
        assertEq(r.fee, FEE);
        assertEq(r.inputAmount, AMOUNT);
        assertEq(r.settledAt, block.timestamp);
        assertEq(vault.invoiceState(merchantId, inv.invoiceId), INVOICE_PAID);
        assertTrue(vault.usedNonce(payer, p.nonce));
        assertTrue(usdc.authorizationState(payer, vault.hashIntent(p)), "3009 nonce == intent digest");
    }

    function test_direct_emitsCommittedThenSettled() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        bytes32 id = vault.computeIntentId(p);

        vm.expectEmit(true, true, true, true, address(vault));
        emit IIntentVault.IntentCommitted(
            id, merchantId, payer, inv.invoiceId, ROUTE_DIRECT, address(usdc), address(usdc), AMOUNT,
            address(0), payoutWallet, p.expiresAt, bytes32(0)
        );
        vm.expectEmit(true, true, true, true, address(vault));
        emit IIntentVault.PaymentSettled(
            id, merchantId, payer, inv.invoiceId, ROUTE_DIRECT, address(usdc), AMOUNT, FEE, payoutWallet,
            address(usdc), AMOUNT, 0
        );
        _payDirect(inv, p);
    }

    function test_direct_maliciousRelayerCannotRedirect() public {
        // The relayer is the attacker here; funds still land in the registry's payout wallet.
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        vm.prank(attacker);
        _payDirect(inv, p);
        assertEq(usdc.balanceOf(attacker), 0);
        assertEq(usdc.balanceOf(payoutWallet), AMOUNT - FEE);
    }

    function test_direct_zeroFee() public {
        vm.prank(admin);
        vault.setFee(0, feeRecipient);
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        _payDirect(inv, p);
        assertEq(usdc.balanceOf(payoutWallet), AMOUNT);
        assertEq(usdc.balanceOf(feeRecipient), 0);
    }

    function test_direct_ausdMerchant() public {
        bytes32 m2 = _registerAndApprove(keccak256("shop-ausd"), address(ausd));
        Invoice memory inv = _invoiceFor(m2, keccak256("a-1"), address(ausd), AMOUNT);
        PaymentIntent memory p = _intent(inv, ROUTE_DIRECT, address(ausd), AMOUNT);
        _payDirect(inv, p);
        assertEq(ausd.balanceOf(payoutWallet), AMOUNT - FEE);
    }

    // ------------------------------------------------------------ one-time use

    function test_direct_revert_replaySameIntent() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        vault.payDirect(p, inv, ms, ps, a);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.NonceAlreadyUsed.selector, payer, p.nonce));
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_direct_revert_invoicePaidTwice() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        _payDirect(inv, p);
        PaymentIntent memory p2 = _intent(inv, ROUTE_DIRECT, address(usdc), AMOUNT); // fresh nonce
        Auth3009 memory a2 = _auth(p2);
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p2);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.InvoiceNotOpen.selector, INVOICE_PAID));
        vault.payDirect(p2, inv, ms, ps, a2);
    }

    // ------------------------------------------------------------ tampering

    function test_direct_revert_tamperedAmountInIntentOnly() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        p.amountOut = 1;
        vm.expectRevert(IIntentVault.AmountMismatch.selector);
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_direct_revert_tamperedAmountBoth() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        inv.amount = 1;
        p.amountOut = 1;
        p.maxAmountIn = 1;
        vm.expectRevert(IIntentVault.InvalidMerchantSignature.selector);
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_direct_revert_tamperedRefundTo() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        p.refundTo = attacker;
        vm.expectRevert(IIntentVault.InvalidPayerSignature.selector);
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_direct_revert_invoiceSignedByAttacker() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        bytes memory forged = _sign(ATTACKER_PK, vault.hashInvoice(inv));
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        vm.expectRevert(IIntentVault.InvalidMerchantSignature.selector);
        vault.payDirect(p, inv, forged, ps, a);
    }

    function test_direct_revert_badAuthorization() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        Auth3009 memory a = _auth(p);
        a.s = bytes32(uint256(a.s) ^ 1);
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        vm.expectRevert(); // token-level error (InvalidAuthorizationSignature or ECDSA) -> TOKEN_AUTHORIZATION_FAILED
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_direct_revert_wrongRoute() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        p.route = ROUTE_SWAP;
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.RouteMismatch.selector, ROUTE_DIRECT, ROUTE_SWAP));
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_direct_revert_inputDiffersFromPayout() public {
        Invoice memory inv = _invoice(keccak256("inv-1"));
        PaymentIntent memory p = _intent(inv, ROUTE_DIRECT, address(ausd), AMOUNT); // ausd is DIRECT-allowed
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.InputTokenNotAllowed.selector, address(ausd), ROUTE_DIRECT));
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_direct_revert_maxAmountInBelowAmount() public {
        Invoice memory inv = _invoice(keccak256("inv-1"));
        PaymentIntent memory p = _intent(inv, ROUTE_DIRECT, address(usdc), AMOUNT - 1);
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        vm.expectRevert(IIntentVault.AmountMismatch.selector);
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_direct_revert_payoutTokenNotMerchants() public {
        Invoice memory inv = _invoiceFor(merchantId, keccak256("inv-1"), address(ausd), AMOUNT); // merchant wants USDC
        PaymentIntent memory p = _intent(inv, ROUTE_DIRECT, address(ausd), AMOUNT);
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        vm.expectRevert(IIntentVault.PayoutTokenMismatch.selector);
        vault.payDirect(p, inv, ms, ps, a);
    }

    // ------------------------------------------------------------ time + merchant state

    function test_direct_revert_invoiceExpired() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        vm.warp(inv.expiresAt + 1);
        vm.expectRevert(IIntentVault.InvoiceExpired.selector);
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_direct_revert_intentExpired() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        vm.warp(p.expiresAt + 1); // intent (10 min) expires before invoice (15 min)
        vm.expectRevert(IIntentVault.IntentExpired.selector);
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_direct_revert_merchantSuspended() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        vm.prank(operator);
        registry.setMerchantStatus(merchantId, MERCHANT_SUSPENDED);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.MerchantNotActive.selector, merchantId, MERCHANT_SUSPENDED));
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_direct_revert_unregisteredMerchant() public {
        bytes32 fakeId = keccak256("not-registered");
        Invoice memory inv = _invoiceFor(fakeId, keccak256("inv-1"), address(usdc), AMOUNT);
        PaymentIntent memory p = _intent(inv, ROUTE_DIRECT, address(usdc), AMOUNT);
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.MerchantNotActive.selector, fakeId, MERCHANT_NONE));
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_direct_revert_keyRotatedInvalidatesOldInvoice() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        _rotate(merchantId, SIGNER2_PK);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.KeyVersionMismatch.selector, uint32(2), uint32(1)));
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_direct_afterRotation_newKeyWorks_oldKeyFails() public {
        _rotate(merchantId, SIGNER2_PK);
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-2")); // keyVersion 2
        bytes memory oldSig = _sign(SIGNER_PK, vault.hashInvoice(inv));
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        vm.expectRevert(IIntentVault.InvalidMerchantSignature.selector);
        vault.payDirect(p, inv, oldSig, ps, a);
        vault.payDirect(p, inv, _sign(SIGNER2_PK, vault.hashInvoice(inv)), ps, a);
        assertEq(usdc.balanceOf(payoutWallet), AMOUNT - FEE);
    }

    function test_direct_revert_payoutTokenDelisted() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        vm.prank(admin);
        registry.setPayoutTokenAllowed(address(usdc), false);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.PayoutTokenNotAllowed.selector, address(usdc)));
        vault.payDirect(p, inv, ms, ps, a);
    }

    // ------------------------------------------------------------ config guards

    function test_direct_revert_aboveCap() public {
        vm.prank(admin);
        vault.setAmountCap(address(usdc), 10e6);
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.AmountAboveCap.selector, AMOUNT, 10e6));
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_direct_revert_inputNotAllowed() public {
        vm.prank(admin);
        vault.setInputTokenAllowed(address(usdc), ROUTE_DIRECT, false);
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.InputTokenNotAllowed.selector, address(usdc), ROUTE_DIRECT));
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_direct_revert_paused() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        vm.prank(admin);
        vault.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_setFee_revert_aboveMax() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.InvalidFee.selector, uint16(101)));
        vault.setFee(101, feeRecipient);
    }

    function test_setInputTokenAllowed_revert_crosschainRoute() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.RouteMismatch.selector, ROUTE_SWAP, ROUTE_CROSSCHAIN));
        vault.setInputTokenAllowed(address(usdc), ROUTE_CROSSCHAIN, true);
    }

    function test_views_isInputTokenAllowed() public view {
        assertTrue(vault.isInputTokenAllowed(address(usdc), ROUTE_DIRECT));
        assertTrue(vault.isInputTokenAllowed(address(mon), ROUTE_SWAP));
        assertFalse(vault.isInputTokenAllowed(address(mon), ROUTE_DIRECT));
        assertTrue(vault.isInputTokenAllowed(address(usdc), ROUTE_CROSSCHAIN));
        assertFalse(vault.isInputTokenAllowed(address(ausd), ROUTE_CROSSCHAIN));
    }

    function test_hashIntent_matchesManual() public {
        (, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ScanPayGuard"),
                keccak256("1"),
                block.chainid,
                address(vault)
            )
        );
        assertEq(vault.hashIntent(p), keccak256(abi.encodePacked("\x19\x01", domain, ScanPayTypes.hashIntent(p))));
    }
}
```

**Commands**

```bash
cd contracts && forge test --match-contract IntentVaultDirectTest -vv
forge test --match-contract IntentVaultDirectTest --gas-report | grep -A3 payDirect
```

**Exit checks**
- [ ] All DIRECT tests pass (≥ 28)
- [ ] Gas report: `payDirect` median recorded in `docs/gas.md` (B needs a sane fallback gas figure; Monad bills the **limit**)

**Commit:** `test(contracts): DIRECT route — happy path, replay, tamper, expiry, key rotation, caps, pause`

---

### Phase A14 — `KuruFlowAdapter` + SWAP route tests

**Goal:** the mainnet swap adapter (Kuru Flow aggregator with an allow-listed call target), plus SWAP tests on the
mock adapter and unit tests of the Kuru adapter against a fake router. **Time:** 90 min. **Depends on:** A13.

#### A14.1 How Kuru Flow fits

1. B calls `POST https://ws.kuru.io/api/quote` with **`userAddress = KuruFlowAdapter address`**, `tokenIn`,
   `tokenOut`, `amount` (= `maxAmountIn`), slippage.
2. Response `transaction{to, calldata (no 0x), value}`. B rejects the quote if `value != "0"` or `to` is not in
   `deployments.external.kuruTargets`.
3. `swapData = abi.encode(address to, bytes calldata)` → passed to `paySwap` / `settleCrossChain`.
4. Vault moves `amountIn` to the adapter, calls `swap`. Adapter approves `to`, calls it, checks output ≥ `minOut`,
   forwards output to the vault and leftovers to `refundTo`, resets approval to 0.
5. Kuru is exact-input: output may be > `amountOut` → vault refunds the surplus payout token to `refundTo`.

**File: `contracts/src/adapters/KuruFlowAdapter.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";

/// @title KuruFlowAdapter — executes a Kuru Flow aggregator quote on behalf of IntentVault (mainnet)
/// @notice swapData = abi.encode(address target, bytes callData) where target/callData come from Kuru /api/quote
///         generated with userAddress = this adapter. Only allow-listed targets may be called.
contract KuruFlowAdapter is ISwapAdapter, AccessControl {
    using SafeERC20 for IERC20;

    address public immutable vault;
    mapping(address target => bool) public allowedTarget;
    /// @notice Optional spender to approve instead of the call target (address(0) = approve target).
    address public approvalSpender;

    event TargetAllowed(address indexed target, bool allowed);
    event ApprovalSpenderSet(address spender);
    event KuruSwap(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 out, uint256 leftover);

    constructor(address admin, address vault_, address[] memory targets) {
        vault = vault_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        for (uint256 i; i < targets.length; ++i) {
            allowedTarget[targets[i]] = true;
            emit TargetAllowed(targets[i], true);
        }
    }

    function setTargetAllowed(address target, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        allowedTarget[target] = allowed;
        emit TargetAllowed(target, allowed);
    }

    function setApprovalSpender(address spender) external onlyRole(DEFAULT_ADMIN_ROLE) {
        approvalSpender = spender;
        emit ApprovalSpenderSet(spender);
    }

    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        bytes calldata data,
        address recipient,
        address leftoverTo
    ) external returns (uint256 out) {
        if (msg.sender != vault) revert OnlyVault();
        (address target, bytes memory callData) = abi.decode(data, (address, bytes));
        if (!allowedTarget[target]) revert TargetNotAllowed(target);

        address spender = approvalSpender == address(0) ? target : approvalSpender;
        IERC20 inToken = IERC20(tokenIn);
        IERC20 outToken = IERC20(tokenOut);

        uint256 outBefore = outToken.balanceOf(address(this));
        inToken.forceApprove(spender, amountIn);
        (bool ok, bytes memory ret) = target.call(callData);
        if (!ok) revert SwapCallFailed(ret);
        inToken.forceApprove(spender, 0);

        out = outToken.balanceOf(address(this)) - outBefore;
        if (out < minOut) revert InsufficientOutput(out, minOut);
        outToken.safeTransfer(recipient, out);

        uint256 leftover = inToken.balanceOf(address(this));
        if (leftover != 0) inToken.safeTransfer(leftoverTo, leftover);
        emit KuruSwap(tokenIn, tokenOut, amountIn, out, leftover);
    }
}
```

> Security note for the README: the adapter can only `call` allow-listed Kuru contracts, holds no funds between
> transactions, and the **vault re-checks the output** by balance delta. A malicious quote can at worst fail the tx.

**File: `contracts/test/utils/FakeRouter.sol`** (test-only helpers)

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISwapAdapter} from "../../src/interfaces/ISwapAdapter.sol";

/// Pretends to be Kuru: pulls `amountIn` from msg.sender via allowance, pays `out` from its own balance.
contract FakeRouter {
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 out) external {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).transfer(msg.sender, out);
    }

    function boom() external pure {
        revert("kuru: boom");
    }
}

/// Malicious/buggy adapter: returns less than minOut WITHOUT reverting (the vault must catch it).
contract ShortChangeAdapter is ISwapAdapter {
    address public immutable vault;

    constructor(address vault_) {
        vault = vault_;
    }

    function swap(address, address tokenOut, uint256, uint256 minOut, bytes calldata, address recipient, address)
        external
        returns (uint256)
    {
        IERC20(tokenOut).transfer(recipient, minOut - 1);
        return minOut; // lies about output
    }
}
```

**File: `contracts/test/IntentVault.Swap.t.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VaultBase} from "./utils/VaultBase.sol";
import {FakeRouter, ShortChangeAdapter} from "./utils/FakeRouter.sol";
import {IIntentVault} from "../src/interfaces/IIntentVault.sol";
import {ISwapAdapter} from "../src/interfaces/ISwapAdapter.sol";
import {KuruFlowAdapter} from "../src/adapters/KuruFlowAdapter.sol";
import "../src/libraries/ScanPayTypes.sol";

contract IntentVaultSwapTest is VaultBase {
    uint256 internal constant MON_NEEDED = 480e18; // 12 USDC / 0.025
    uint256 internal constant MON_MAX = 500e18; // B adds a buffer; 20 MON comes back

    function _swapIntent(address input, uint256 maxIn) internal returns (Invoice memory inv, PaymentIntent memory p) {
        inv = _invoice(keccak256(abi.encode("swap", nextNonce)));
        p = _intent(inv, ROUTE_SWAP, input, maxIn);
    }

    function _paySwap(Invoice memory inv, PaymentIntent memory p) internal returns (bytes32) {
        return vault.paySwap(p, inv, _merchantSig(inv), _payerSig(p), "");
    }

    function test_swap_monToUsdc_exactOutputWithRefund() public {
        vm.prank(payer);
        mon.approve(address(vault), type(uint256).max); // the one-time approve (operator drips gas for it)
        (Invoice memory inv, PaymentIntent memory p) = _swapIntent(address(mon), MON_MAX);
        uint256 monBefore = mon.balanceOf(payer);

        vm.prank(operator);
        bytes32 id = _paySwap(inv, p);

        assertEq(mon.balanceOf(payer), monBefore - MON_NEEDED, "only needed MON spent");
        assertEq(usdc.balanceOf(payoutWallet), AMOUNT - FEE);
        assertEq(usdc.balanceOf(feeRecipient), FEE);
        assertEq(usdc.balanceOf(address(vault)), 0);
        assertEq(mon.balanceOf(address(vault)), 0);
        IntentRecord memory r = vault.getIntent(id);
        assertEq(r.status, INTENT_SETTLED);
        assertEq(r.inputAmount, MON_NEEDED);
        assertEq(r.inputToken, address(mon));
    }

    function test_swap_usdcToAusdMerchant() public {
        bytes32 m2 = _registerAndApprove(keccak256("shop-ausd"), address(ausd));
        Invoice memory inv = _invoiceFor(m2, keccak256("x"), address(ausd), AMOUNT);
        PaymentIntent memory p = _intent(inv, ROUTE_SWAP, address(usdc), AMOUNT + 50_000);
        vm.prank(payer);
        usdc.approve(address(vault), type(uint256).max);
        vault.paySwap(p, inv, _merchantSig(inv), _payerSig(p), "");
        assertEq(ausd.balanceOf(payoutWallet), AMOUNT - FEE);
        assertEq(usdc.balanceOf(payer), 1_000e6 - AMOUNT, "1:1, buffer refunded");
    }

    function test_swap_sameToken_pullsExactlyAmountOut() public {
        vm.prank(payer);
        usdc.approve(address(vault), type(uint256).max);
        (Invoice memory inv, PaymentIntent memory p) = _swapIntent(address(usdc), AMOUNT * 2);
        _paySwap(inv, p);
        assertEq(usdc.balanceOf(payer), 1_000e6 - AMOUNT);
        assertEq(usdc.balanceOf(payoutWallet), AMOUNT - FEE);
    }

    function test_swap_revert_noAllowance() public {
        (Invoice memory inv, PaymentIntent memory p) = _swapIntent(address(mon), MON_MAX);
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        vm.expectRevert(); // ERC20InsufficientAllowance
        vault.paySwap(p, inv, ms, ps, "");
    }

    function test_swap_revert_allowanceUnusableWithoutPayerSig() public {
        // Approving the vault does NOT let anyone else spend: attacker signs an intent naming the payer.
        vm.prank(payer);
        mon.approve(address(vault), type(uint256).max);
        (Invoice memory inv, PaymentIntent memory p) = _swapIntent(address(mon), MON_MAX);
        bytes memory ms = _merchantSig(inv);
        bytes memory forged = _sign(ATTACKER_PK, vault.hashIntent(p));
        vm.expectRevert(IIntentVault.InvalidPayerSignature.selector);
        vault.paySwap(p, inv, ms, forged, "");
    }

    function test_swap_revert_maxInTooLow() public {
        vm.prank(payer);
        mon.approve(address(vault), type(uint256).max);
        (Invoice memory inv, PaymentIntent memory p) = _swapIntent(address(mon), 400e18);
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        vm.expectRevert(abi.encodeWithSelector(ISwapAdapter.InsufficientOutput.selector, 10e6, AMOUNT));
        vault.paySwap(p, inv, ms, ps, "");
    }

    function test_swap_revert_noAdapter() public {
        vm.prank(admin);
        vault.setSwapAdapter(address(0));
        vm.prank(payer);
        mon.approve(address(vault), type(uint256).max);
        (Invoice memory inv, PaymentIntent memory p) = _swapIntent(address(mon), MON_MAX);
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        vm.expectRevert(IIntentVault.NoSwapAdapter.selector);
        vault.paySwap(p, inv, ms, ps, "");
    }

    function test_swap_revert_shortChangingAdapterCaught() public {
        ShortChangeAdapter bad = new ShortChangeAdapter(address(vault));
        vm.prank(admin);
        usdc.mint(address(bad), 1_000e6);
        vm.prank(admin);
        vault.setSwapAdapter(address(bad));
        vm.prank(payer);
        mon.approve(address(vault), type(uint256).max);
        (Invoice memory inv, PaymentIntent memory p) = _swapIntent(address(mon), MON_MAX);
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.SwapOutputTooLow.selector, AMOUNT - 1, AMOUNT));
        vault.paySwap(p, inv, ms, ps, "");
    }

    function test_swap_revert_inputTokenNotAllowed() public {
        vm.prank(admin);
        vault.setInputTokenAllowed(address(mon), ROUTE_SWAP, false);
        (Invoice memory inv, PaymentIntent memory p) = _swapIntent(address(mon), MON_MAX);
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.InputTokenNotAllowed.selector, address(mon), ROUTE_SWAP));
        vault.paySwap(p, inv, ms, ps, "");
    }

    function test_swap_revert_zeroMaxIn() public {
        (Invoice memory inv, PaymentIntent memory p) = _swapIntent(address(mon), 0);
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        vm.expectRevert(IIntentVault.AmountMismatch.selector);
        vault.paySwap(p, inv, ms, ps, "");
    }

    // ------------------------------------------------------------ Kuru adapter wired into the vault

    function test_kuru_viaVault_surplusRefunded() public {
        FakeRouter router = new FakeRouter();
        vm.prank(admin);
        usdc.mint(address(router), 1_000e6);
        address[] memory targets = new address[](1);
        targets[0] = address(router);
        KuruFlowAdapter kuru = new KuruFlowAdapter(admin, address(vault), targets);
        vm.prank(admin);
        vault.setSwapAdapter(address(kuru));

        vm.prank(payer);
        mon.approve(address(vault), type(uint256).max);
        (Invoice memory inv, PaymentIntent memory p) = _swapIntent(address(mon), MON_MAX);
        // exact-input aggregator: all 500 MON in, 12.5 USDC out (0.5 positive surplus)
        bytes memory swapData = abi.encode(
            address(router), abi.encodeCall(FakeRouter.swap, (address(mon), address(usdc), MON_MAX, 12_500_000))
        );
        uint256 payerUsdcBefore = usdc.balanceOf(payer);
        bytes32 id = vault.paySwap(p, inv, _merchantSig(inv), _payerSig(p), swapData);

        assertEq(usdc.balanceOf(payoutWallet), AMOUNT - FEE);
        assertEq(usdc.balanceOf(payer), payerUsdcBefore + 500_000, "surplus payout token refunded");
        assertEq(mon.allowance(address(kuru), address(router)), 0, "approval reset");
        assertEq(usdc.balanceOf(address(kuru)), 0);
        assertEq(vault.getIntent(id).inputAmount, MON_MAX);
    }
}

contract KuruFlowAdapterTest is VaultBase {
    FakeRouter internal router;
    KuruFlowAdapter internal kuru;

    function setUp() public override {
        super.setUp();
        router = new FakeRouter();
        vm.prank(admin);
        usdc.mint(address(router), 1_000e6);
        address[] memory targets = new address[](1);
        targets[0] = address(router);
        kuru = new KuruFlowAdapter(admin, address(this), targets); // this test plays vault
        vm.prank(admin);
        mon.mint(address(kuru), 100e18); // "vault already transferred amountIn"
    }

    function _data(uint256 amountIn, uint256 out) internal view returns (bytes memory) {
        return abi.encode(address(router), abi.encodeCall(FakeRouter.swap, (address(mon), address(usdc), amountIn, out)));
    }

    function test_swap_happy_leftoverReturned() public {
        address leftoverTo = makeAddr("leftover");
        uint256 out = kuru.swap(address(mon), address(usdc), 100e18, 2e6, _data(80e18, 2e6), address(this), leftoverTo);
        assertEq(out, 2e6);
        assertEq(usdc.balanceOf(address(this)), 2e6);
        assertEq(mon.balanceOf(leftoverTo), 20e18);
    }

    function test_swap_revert_onlyVault() public {
        vm.prank(attacker);
        vm.expectRevert(ISwapAdapter.OnlyVault.selector);
        kuru.swap(address(mon), address(usdc), 100e18, 2e6, _data(100e18, 2e6), attacker, attacker);
    }

    function test_swap_revert_targetNotAllowed() public {
        bytes memory data = abi.encode(address(usdc), abi.encodeWithSignature("transfer(address,uint256)", attacker, 1));
        vm.expectRevert(abi.encodeWithSelector(ISwapAdapter.TargetNotAllowed.selector, address(usdc)));
        kuru.swap(address(mon), address(usdc), 100e18, 1, data, address(this), address(this));
    }

    function test_swap_revert_callFails() public {
        bytes memory data = abi.encode(address(router), abi.encodeCall(FakeRouter.boom, ()));
        vm.expectRevert(); // SwapCallFailed(reason)
        kuru.swap(address(mon), address(usdc), 100e18, 1, data, address(this), address(this));
    }

    function test_swap_revert_insufficientOutput() public {
        vm.expectRevert(abi.encodeWithSelector(ISwapAdapter.InsufficientOutput.selector, 1e6, 2e6));
        kuru.swap(address(mon), address(usdc), 100e18, 2e6, _data(100e18, 1e6), address(this), address(this));
    }

    function test_admin_targets() public {
        vm.prank(attacker);
        vm.expectRevert();
        kuru.setTargetAllowed(attacker, true);
        vm.prank(admin);
        kuru.setTargetAllowed(address(router), false);
        assertFalse(kuru.allowedTarget(address(router)));
    }
}
```

**Commands**

```bash
cd contracts && forge test --match-contract "IntentVaultSwapTest|KuruFlowAdapterTest" -vv
```

**Exit checks**
- [ ] All SWAP tests pass (11) and Kuru adapter tests pass (6)
- [ ] `test_swap_revert_allowanceUnusableWithoutPayerSig` passes — this is the README answer to "isn't an unlimited approve dangerous?"

**Commit:** `feat(contracts): KuruFlowAdapter; test(contracts): SWAP route + adapter unit tests`

---

### Phase A15 — CROSSCHAIN route tests

**Goal:** prove the forwarder flow end-to-end: commit → (deposit) → settle, plus underpaid, refund, rescue, attest and
the AUSD-payout swap path. **Time:** 75 min. **Depends on:** A13.

On local/testnet the "solver" is simulated by **minting tUSDC to the forwarder** — exactly what Aurora's solver does
on mainnet with real USDC. B's Attack Lab uses the same trick (via the operator's `MINTER_ROLE`).

**File: `contracts/test/IntentVault.CrossChain.t.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VaultBase} from "./utils/VaultBase.sol";
import {IIntentVault} from "../src/interfaces/IIntentVault.sol";
import {DepositForwarder} from "../src/DepositForwarder.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import "../src/libraries/ScanPayTypes.sol";

contract IntentVaultCrossChainTest is VaultBase {
    address internal keeper; // anyone

    function setUp() public override {
        super.setUp();
        keeper = makeAddr("keeper");
    }

    function _cc(Invoice memory inv, uint256 maxIn) internal returns (PaymentIntent memory p, bytes32 id, address fwd) {
        p = _intent(inv, ROUTE_CROSSCHAIN, address(usdc), maxIn);
        vm.prank(operator);
        (id, fwd) = vault.commitCrossChain(p, inv, _merchantSig(inv), _payerSig(p));
    }

    function _solverDelivers(address fwd, uint256 amount) internal {
        vm.prank(admin);
        usdc.mint(fwd, amount);
    }

    // ------------------------------------------------------------ commit

    function test_commit_deploysPredictedForwarderAndReserves() public {
        Invoice memory inv = _invoice(keccak256("cc-1"));
        PaymentIntent memory p = _intent(inv, ROUTE_CROSSCHAIN, address(usdc), AMOUNT);
        bytes32 expectedId = vault.computeIntentId(p);
        address predicted = vault.forwarderOf(expectedId);
        assertEq(predicted.code.length, 0);

        vm.expectEmit(true, true, true, true, address(vault));
        emit IIntentVault.IntentCommitted(
            expectedId, merchantId, payer, inv.invoiceId, ROUTE_CROSSCHAIN, address(usdc), address(usdc), AMOUNT,
            predicted, payoutWallet, p.expiresAt, keccak256("quote")
        );
        (bytes32 id, address fwd) = vault.commitCrossChain(p, inv, _merchantSig(inv), _payerSig(p));

        assertEq(id, expectedId);
        assertEq(fwd, predicted);
        assertGt(fwd.code.length, 0);
        assertEq(DepositForwarder(fwd).vault(), address(vault));
        IntentRecord memory r = vault.getIntent(id);
        assertEq(r.status, INTENT_COMMITTED);
        assertEq(r.inputAmount, AMOUNT, "required deposit");
        assertEq(vault.invoiceState(merchantId, inv.invoiceId), INVOICE_RESERVED);
    }

    function test_commit_revert_inputNotCrossChainToken() public {
        Invoice memory inv = _invoice(keccak256("cc-1"));
        PaymentIntent memory p = _intent(inv, ROUTE_CROSSCHAIN, address(ausd), AMOUNT);
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        vm.expectRevert(
            abi.encodeWithSelector(IIntentVault.InputTokenNotAllowed.selector, address(ausd), ROUTE_CROSSCHAIN)
        );
        vault.commitCrossChain(p, inv, ms, ps);
    }

    function test_commit_revert_secondPayerWhileReserved() public {
        Invoice memory inv = _invoice(keccak256("cc-1"));
        _cc(inv, AMOUNT);
        PaymentIntent memory p2 = _intent(inv, ROUTE_CROSSCHAIN, address(usdc), AMOUNT);
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p2);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.InvoiceNotOpen.selector, INVOICE_RESERVED));
        vault.commitCrossChain(p2, inv, ms, ps);
    }

    // ------------------------------------------------------------ settle

    function test_settle_exactDeposit_permissionless() public {
        Invoice memory inv = _invoice(keccak256("cc-1"));
        (, bytes32 id, address fwd) = _cc(inv, AMOUNT);
        _solverDelivers(fwd, AMOUNT);

        vm.prank(keeper);
        vault.settleCrossChain(id, "");

        assertEq(usdc.balanceOf(payoutWallet), AMOUNT - FEE);
        assertEq(usdc.balanceOf(feeRecipient), FEE);
        assertEq(usdc.balanceOf(fwd), 0);
        assertEq(usdc.balanceOf(address(vault)), 0);
        assertEq(vault.getIntent(id).status, INTENT_SETTLED);
        assertEq(vault.invoiceState(merchantId, inv.invoiceId), INVOICE_PAID);
    }

    function test_settle_depositBeforeCommit() public {
        Invoice memory inv = _invoice(keccak256("cc-1"));
        PaymentIntent memory p = _intent(inv, ROUTE_CROSSCHAIN, address(usdc), AMOUNT);
        address fwd = vault.forwarderOf(vault.computeIntentId(p));
        _solverDelivers(fwd, AMOUNT); // solver was faster than our commit tx
        (bytes32 id,) = vault.commitCrossChain(p, inv, _merchantSig(inv), _payerSig(p));
        vault.settleCrossChain(id, "");
        assertEq(usdc.balanceOf(payoutWallet), AMOUNT - FEE);
    }

    function test_settle_overDeposit_excessToRefundTo() public {
        Invoice memory inv = _invoice(keccak256("cc-1"));
        (, bytes32 id, address fwd) = _cc(inv, AMOUNT);
        _solverDelivers(fwd, AMOUNT + 777);
        uint256 payerBefore = usdc.balanceOf(payer);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IIntentVault.PaymentSettled(
            id, merchantId, payer, inv.invoiceId, ROUTE_CROSSCHAIN, address(usdc), AMOUNT, FEE, payoutWallet,
            address(usdc), AMOUNT + 777, 777
        );
        vault.settleCrossChain(id, "");
        assertEq(usdc.balanceOf(payer), payerBefore + 777);
    }

    function test_settle_revert_underpaid_thenTopUpWorks() public {
        Invoice memory inv = _invoice(keccak256("cc-1"));
        (, bytes32 id, address fwd) = _cc(inv, AMOUNT);
        _solverDelivers(fwd, AMOUNT - 1);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.Underpaid.selector, AMOUNT - 1, AMOUNT));
        vault.settleCrossChain(id, "");
        _solverDelivers(fwd, 1);
        vault.settleCrossChain(id, "");
        assertEq(vault.getIntent(id).status, INTENT_SETTLED);
    }

    function test_settle_revert_noFunds_fakeProviderSuccess() public {
        // "Provider says SUCCESS" is meaningless: with nothing in the forwarder, settle is impossible.
        Invoice memory inv = _invoice(keccak256("cc-1"));
        (, bytes32 id,) = _cc(inv, AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.Underpaid.selector, 0, AMOUNT));
        vault.settleCrossChain(id, "");
    }

    function test_settle_lateDeliveryAfterExpiryStillSettles() public {
        Invoice memory inv = _invoice(keccak256("cc-1"));
        (PaymentIntent memory p, bytes32 id, address fwd) = _cc(inv, AMOUNT);
        vm.warp(p.expiresAt + 30); // before expiresAt + refundDelay
        _solverDelivers(fwd, AMOUNT);
        vault.settleCrossChain(id, "");
        assertEq(vault.getIntent(id).status, INTENT_SETTLED);
    }

    function test_settle_usdcToAusdMerchant_viaSwap() public {
        bytes32 m2 = _registerAndApprove(keccak256("shop-ausd"), address(ausd));
        Invoice memory inv = _invoiceFor(m2, keccak256("cc-ausd"), address(ausd), AMOUNT);
        uint256 maxIn = AMOUNT + 36_000; // B requests 0.3% buffer of USDC from Aurora
        (, bytes32 id, address fwd) = _cc(inv, maxIn);
        _solverDelivers(fwd, maxIn);
        uint256 payerUsdcBefore = usdc.balanceOf(payer);

        vault.settleCrossChain(id, "");

        assertEq(ausd.balanceOf(payoutWallet), AMOUNT - FEE);
        assertEq(usdc.balanceOf(payer), payerUsdcBefore + 36_000, "unused USDC refunded");
        IntentRecord memory r = vault.getIntent(id);
        assertEq(r.inputAmount, AMOUNT, "1:1 used exactly AMOUNT");
        assertEq(usdc.balanceOf(address(vault)) + ausd.balanceOf(address(vault)), 0);
    }

    function test_settle_revert_twice() public {
        Invoice memory inv = _invoice(keccak256("cc-1"));
        (, bytes32 id, address fwd) = _cc(inv, AMOUNT);
        _solverDelivers(fwd, AMOUNT);
        vault.settleCrossChain(id, "");
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.IntentNotCommitted.selector, id));
        vault.settleCrossChain(id, "");
    }

    function test_settle_revert_unknownIntent() public {
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.IntentNotCommitted.selector, bytes32(uint256(42))));
        vault.settleCrossChain(bytes32(uint256(42)), "");
    }

    function test_settle_revert_paused() public {
        Invoice memory inv = _invoice(keccak256("cc-1"));
        (, bytes32 id, address fwd) = _cc(inv, AMOUNT);
        _solverDelivers(fwd, AMOUNT);
        vm.prank(admin);
        vault.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.settleCrossChain(id, "");
    }

    // ------------------------------------------------------------ refund

    function test_refund_revert_tooEarly() public {
        Invoice memory inv = _invoice(keccak256("cc-1"));
        (PaymentIntent memory p, bytes32 id,) = _cc(inv, AMOUNT);
        uint256 allowedAt = uint256(p.expiresAt) + REFUND_DELAY;
        vm.warp(allowedAt - 1);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.RefundNotYetAllowed.selector, allowedAt));
        vault.refundCrossChain(id);
    }

    function test_refund_partialDeposit_reopensInvoice_evenWhilePaused() public {
        Invoice memory inv = _invoice(keccak256("cc-1"));
        (PaymentIntent memory p, bytes32 id, address fwd) = _cc(inv, AMOUNT);
        _solverDelivers(fwd, 5e6);
        vm.prank(admin);
        vault.pause();
        vm.warp(uint256(p.expiresAt) + REFUND_DELAY);
        uint256 payerBefore = usdc.balanceOf(payer);

        vm.expectEmit(true, true, false, true, address(vault));
        emit IIntentVault.IntentRefunded(id, payer, address(usdc), 5e6);
        vm.prank(keeper);
        vault.refundCrossChain(id);

        assertEq(usdc.balanceOf(payer), payerBefore + 5e6);
        assertEq(vault.getIntent(id).status, INTENT_REFUNDED);
        assertEq(vault.invoiceState(merchantId, inv.invoiceId), INVOICE_OPEN);
        assertTrue(vault.usedNonce(payer, p.nonce), "nonce stays burned");
    }

    function test_refund_thenInvoicePayableAgain() public {
        Invoice memory inv = _invoice(keccak256("cc-1"));
        inv.expiresAt = uint64(block.timestamp + 2 hours);
        (PaymentIntent memory p, bytes32 id,) = _cc(inv, AMOUNT);
        vm.warp(uint256(p.expiresAt) + REFUND_DELAY);
        vault.refundCrossChain(id);

        PaymentIntent memory p2 = _intent(inv, ROUTE_DIRECT, address(usdc), AMOUNT);
        vault.payDirect(p2, inv, _merchantSig(inv), _payerSig(p2), _auth(p2));
        assertEq(vault.invoiceState(merchantId, inv.invoiceId), INVOICE_PAID);
    }

    function test_refund_revert_afterSettle() public {
        Invoice memory inv = _invoice(keccak256("cc-1"));
        (PaymentIntent memory p, bytes32 id, address fwd) = _cc(inv, AMOUNT);
        _solverDelivers(fwd, AMOUNT);
        vault.settleCrossChain(id, "");
        vm.warp(uint256(p.expiresAt) + REFUND_DELAY);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.IntentNotCommitted.selector, id));
        vault.refundCrossChain(id);
    }

    function test_refund_revert_onDirectIntent() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        bytes32 id = _payDirect(inv, p);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.IntentNotCommitted.selector, id));
        vault.refundCrossChain(id);
    }

    // ------------------------------------------------------------ rescue

    function test_rescue_lateDepositAfterSettle() public {
        Invoice memory inv = _invoice(keccak256("cc-1"));
        (, bytes32 id, address fwd) = _cc(inv, AMOUNT);
        _solverDelivers(fwd, AMOUNT);
        vault.settleCrossChain(id, "");
        _solverDelivers(fwd, 3e6); // duplicate delivery
        uint256 payerBefore = usdc.balanceOf(payer);
        vm.prank(keeper);
        vault.rescue(id, address(usdc));
        assertEq(usdc.balanceOf(payer), payerBefore + 3e6);
    }

    function test_rescue_wrongTokenAfterRefund() public {
        Invoice memory inv = _invoice(keccak256("cc-1"));
        (PaymentIntent memory p, bytes32 id, address fwd) = _cc(inv, AMOUNT);
        vm.warp(uint256(p.expiresAt) + REFUND_DELAY);
        vault.refundCrossChain(id);
        vm.prank(admin);
        mon.mint(fwd, 7e18);
        vault.rescue(id, address(mon));
        assertEq(mon.balanceOf(fwd), 0);
    }

    function test_rescue_revert_whileCommitted() public {
        Invoice memory inv = _invoice(keccak256("cc-1"));
        (, bytes32 id,) = _cc(inv, AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.IntentNotTerminal.selector, id));
        vault.rescue(id, address(usdc));
    }

    // ------------------------------------------------------------ attest

    function test_attest_onlyAttester_once_noStatusChange() public {
        Invoice memory inv = _invoice(keccak256("cc-1"));
        (, bytes32 id,) = _cc(inv, AMOUNT);
        bytes32 src = keccak256("base-tx");
        bytes32 attesterRole = vault.ATTESTER_ROLE(); // read BEFORE vm.prank (a prank applies to the next call)

        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, attacker, attesterRole)
        );
        vm.prank(attacker);
        vault.attestSource(id, 8453, src, bytes32("corr-1"));

        vm.expectEmit(true, true, false, true, address(vault));
        emit IIntentVault.SourceAttested(id, 8453, src, bytes32("corr-1"), operator);
        vm.prank(operator);
        vault.attestSource(id, 8453, src, bytes32("corr-1"));

        IntentRecord memory r = vault.getIntent(id);
        assertEq(r.sourceChainId, 8453);
        assertEq(r.sourceTxHash, src);
        assertEq(r.status, INTENT_COMMITTED, "attestation never settles");

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.AlreadyAttested.selector, id));
        vault.attestSource(id, 8453, src, bytes32("corr-1"));
    }

    function test_attest_revert_nonCrossChain() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        bytes32 id = _payDirect(inv, p);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.IntentNotCommitted.selector, id));
        vault.attestSource(id, 1, bytes32(uint256(1)), bytes32(0));
    }
}
```

**Commands**

```bash
cd contracts && forge test --match-contract IntentVaultCrossChainTest -vv
forge test -vv            # everything so far
```

**Exit checks**
- [ ] All cross-chain tests pass (≥ 22)
- [ ] Full suite green
- [ ] `forge coverage --report summary` → `IntentVault.sol` lines ≥ 95%, branches ≥ 85%

**Commit:** `test(contracts): CROSSCHAIN route — commit, settle, underpaid, swap-to-AUSD, refund, rescue, attest`

---

### Phase A16 — Attack suite (mirrors the Attack Lab, scenario by scenario)

**Goal:** one test per Attack Lab scenario that B exposes in the UI, so the demo can say "this exact attack is a
passing test in our repo". The names match B's scenario ids. **Time:** 45 min. **Depends on:** A15.

| Attack Lab id (B) | What the attacker does | Contract stops it with | Test |
|---|---|---|---|
| `tamper_amount` | relayer changes amount after the customer signed | `AmountMismatch` / `InvalidMerchantSignature` / `InvalidPayerSignature` | `test_attack_tamper_amount` |
| `tamper_destination` | relayer/QR swaps the payout wallet | destination is read from the registry; attacker gets 0 | `test_attack_tamper_destination` |
| `replay` | resubmit a settled payment | `NonceAlreadyUsed` | `test_attack_replay` |
| `expired` | pay a stale QR | `InvoiceExpired` | `test_attack_expired` |
| `unregistered_qr` | fake merchant QR with attacker's key | `MerchantNotActive(id, 0)` | `test_attack_unregistered_qr` |
| `fake_provider_success` | provider/webhook says SUCCESS, no funds | `Underpaid(0, required)` | `test_attack_fake_provider_success` |
| `forged_settlement_hash` | someone claims "settled" with a fake tx hash | only `PaymentSettled` from the vault counts; `attestSource` is role-gated and never settles | `test_attack_forged_settlement_hash` |
| `wrong_token` | pay with a different token than the invoice | `PayoutTokenMismatch` | `test_attack_wrong_token` |
| (extra) `stolen_signature_other_merchant` | reuse a payer signature for another merchant's invoice | `InvalidPayerSignature` | `test_attack_cross_merchant_signature` |
| (extra) `reentrancy` | malicious adapter re-enters the vault | `ReentrancyGuardReentrantCall` | `test_attack_reentrancy` |

**File: `contracts/test/utils/ReentrantAdapter.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISwapAdapter} from "../../src/interfaces/ISwapAdapter.sol";
import {IIntentVault} from "../../src/interfaces/IIntentVault.sol";

/// Tries to call settleCrossChain from inside swap(). Must be blocked by nonReentrant.
contract ReentrantAdapter is ISwapAdapter {
    address public immutable vault;
    bytes32 public target;

    constructor(address vault_) {
        vault = vault_;
    }

    function setTarget(bytes32 id) external {
        target = id;
    }

    function swap(address, address tokenOut, uint256, uint256 minOut, bytes calldata, address recipient, address)
        external
        returns (uint256)
    {
        IIntentVault(vault).settleCrossChain(target, "");
        IERC20(tokenOut).transfer(recipient, minOut);
        return minOut;
    }
}
```

**File: `contracts/test/Attacks.t.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VaultBase} from "./utils/VaultBase.sol";
import {ReentrantAdapter} from "./utils/ReentrantAdapter.sol";
import {IIntentVault} from "../src/interfaces/IIntentVault.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../src/libraries/ScanPayTypes.sol";

contract AttacksTest is VaultBase {
    function test_attack_tamper_amount() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("a1"));
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);

        // (a) only the intent amount changes
        PaymentIntent memory p1 = p;
        p1.amountOut = AMOUNT * 10;
        vm.expectRevert(IIntentVault.AmountMismatch.selector);
        vault.payDirect(p1, inv, ms, ps, a);

        // (b) both change -> merchant signature breaks
        Invoice memory inv2 = inv;
        inv2.amount = AMOUNT * 10;
        p1.maxAmountIn = AMOUNT * 10;
        vm.expectRevert(IIntentVault.InvalidMerchantSignature.selector);
        vault.payDirect(p1, inv2, ms, ps, a);
    }

    function test_attack_tamper_destination() public {
        // A forged/edited QR can't carry a destination: the intent has no payout field, the vault reads the
        // registry. Even an attacker-relayed payment lands in the registered payout wallet.
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("a2"));
        vm.prank(attacker);
        bytes32 id = _payDirect(inv, p);
        assertEq(vault.getIntent(id).payoutWallet, payoutWallet);
        assertEq(usdc.balanceOf(attacker), 0);
        assertEq(usdc.balanceOf(payoutWallet), AMOUNT - FEE);
    }

    function test_attack_replay() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("a3"));
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        vault.payDirect(p, inv, ms, ps, a);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.NonceAlreadyUsed.selector, payer, p.nonce));
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_attack_expired() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("a4"));
        inv.expiresAt = uint64(block.timestamp - 1);
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        vm.expectRevert(IIntentVault.InvoiceExpired.selector);
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_attack_unregistered_qr() public {
        bytes32 fakeMerchant = keccak256(abi.encode(attacker, bytes32("fake-shop")));
        Invoice memory inv = _invoiceFor(fakeMerchant, keccak256("a5"), address(usdc), AMOUNT);
        inv.keyVersion = 1;
        PaymentIntent memory p = _intent(inv, ROUTE_DIRECT, address(usdc), AMOUNT);
        bytes memory ms = _sign(ATTACKER_PK, vault.hashInvoice(inv));
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.MerchantNotActive.selector, fakeMerchant, MERCHANT_NONE));
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_attack_fake_provider_success() public {
        Invoice memory inv = _invoice(keccak256("a6"));
        PaymentIntent memory p = _intent(inv, ROUTE_CROSSCHAIN, address(usdc), AMOUNT);
        (bytes32 id,) = vault.commitCrossChain(p, inv, _merchantSig(inv), _payerSig(p));
        // Backend B receives a "SUCCESS" webhook. There is no function that accepts it. Settle needs funds:
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.Underpaid.selector, 0, AMOUNT));
        vault.settleCrossChain(id, "");
        assertEq(vault.getIntent(id).status, INTENT_COMMITTED);
    }

    function test_attack_forged_settlement_hash() public {
        Invoice memory inv = _invoice(keccak256("a7"));
        PaymentIntent memory p = _intent(inv, ROUTE_CROSSCHAIN, address(usdc), AMOUNT);
        (bytes32 id,) = vault.commitCrossChain(p, inv, _merchantSig(inv), _payerSig(p));

        vm.prank(attacker);
        vm.expectRevert(); // not ATTESTER_ROLE
        vault.attestSource(id, 8453, keccak256("forged"), bytes32(0));

        vm.prank(operator); // even the legit attester can't settle by attesting
        vault.attestSource(id, 8453, keccak256("real"), bytes32(0));
        assertEq(vault.getIntent(id).status, INTENT_COMMITTED);
        assertEq(usdc.balanceOf(payoutWallet), 0);
    }

    function test_attack_wrong_token() public {
        Invoice memory inv = _invoice(keccak256("a8"));
        PaymentIntent memory p = _intent(inv, ROUTE_DIRECT, address(ausd), AMOUNT);
        p.payoutToken = address(ausd);
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        vm.expectRevert(IIntentVault.PayoutTokenMismatch.selector);
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_attack_cross_merchant_signature() public {
        bytes32 m2 = _registerAndApprove(keccak256("shop-2"), address(usdc));
        (Invoice memory inv1, PaymentIntent memory p1) = _direct(keccak256("a9"));
        bytes memory ps1 = _payerSig(p1);

        Invoice memory inv2 = _invoiceFor(m2, inv1.invoiceId, address(usdc), AMOUNT);
        PaymentIntent memory p2 = p1;
        p2.merchantId = m2;
        bytes memory ms2 = _merchantSig(inv2);
        Auth3009 memory a = _auth(p2);
        vm.expectRevert(IIntentVault.InvalidPayerSignature.selector);
        vault.payDirect(p2, inv2, ms2, ps1, a);
    }

    function test_attack_reentrancy() public {
        bytes32 m2 = _registerAndApprove(keccak256("shop-ausd"), address(ausd));
        ReentrantAdapter evil = new ReentrantAdapter(address(vault));
        vm.startPrank(admin);
        ausd.mint(address(evil), 1_000e6);
        vault.setSwapAdapter(address(evil));
        vm.stopPrank();

        Invoice memory inv = _invoiceFor(m2, keccak256("a10"), address(ausd), AMOUNT);
        PaymentIntent memory p = _intent(inv, ROUTE_CROSSCHAIN, address(usdc), AMOUNT);
        (bytes32 id, address fwd) = vault.commitCrossChain(p, inv, _merchantSig(inv), _payerSig(p));
        vm.prank(admin);
        usdc.mint(fwd, AMOUNT);
        evil.setTarget(id);

        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        vault.settleCrossChain(id, "");
    }
}
```

**Commands**

```bash
cd contracts && forge test --match-contract AttacksTest -vv
```

**Exit checks**
- [ ] 10 attack tests pass
- [ ] Send B the table above (B's Attack Lab copy uses the same ids and revert names)

**Commit:** `test(contracts): attack suite mirroring the Attack Lab scenarios`

---

### Phase A17 — Fuzz + invariant tests

**Goal:** randomized evidence for the two money properties: (1) the vault never keeps funds, (2) everything that left
the payer for a settled intent equals merchant net + fee + refunds. **Time:** 60 min. **Depends on:** A16.

**File: `contracts/test/Fuzz.t.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VaultBase} from "./utils/VaultBase.sol";
import {IIntentVault} from "../src/interfaces/IIntentVault.sol";
import "../src/libraries/ScanPayTypes.sol";

contract FuzzTest is VaultBase {
    function testFuzz_direct_anyAmount_feeSplitExact(uint256 amount, uint16 fee) public {
        amount = bound(amount, 1, 1_000e6);
        fee = uint16(bound(fee, 0, 100));
        vm.prank(admin);
        vault.setFee(fee, feeRecipient);

        Invoice memory inv = _invoiceFor(merchantId, keccak256(abi.encode(amount, fee)), address(usdc), amount);
        PaymentIntent memory p = _intent(inv, ROUTE_DIRECT, address(usdc), amount);
        bytes32 id = _payDirect(inv, p);

        uint256 expectedFee = (amount * fee) / 10_000;
        assertEq(usdc.balanceOf(payoutWallet), amount - expectedFee);
        assertEq(usdc.balanceOf(feeRecipient), expectedFee);
        assertEq(usdc.balanceOf(payoutWallet) + usdc.balanceOf(feeRecipient), amount);
        assertEq(vault.getIntent(id).fee, expectedFee);
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    function testFuzz_crossChain_anyOverDeposit(uint256 extra) public {
        extra = bound(extra, 0, 1_000_000e6);
        Invoice memory inv = _invoice(keccak256(abi.encode("cc", extra)));
        PaymentIntent memory p = _intent(inv, ROUTE_CROSSCHAIN, address(usdc), AMOUNT);
        (bytes32 id, address fwd) = vault.commitCrossChain(p, inv, _merchantSig(inv), _payerSig(p));
        vm.prank(admin);
        usdc.mint(fwd, AMOUNT + extra);
        uint256 payerBefore = usdc.balanceOf(payer);
        vault.settleCrossChain(id, "");
        assertEq(usdc.balanceOf(payer) - payerBefore, extra);
        assertEq(usdc.balanceOf(payoutWallet), AMOUNT - FEE);
        assertEq(usdc.balanceOf(address(vault)), 0);
        assertEq(usdc.balanceOf(fwd), 0);
    }

    function testFuzz_crossChain_underDepositAlwaysReverts(uint256 dep) public {
        dep = bound(dep, 0, AMOUNT - 1);
        Invoice memory inv = _invoice(keccak256(abi.encode("under", dep)));
        PaymentIntent memory p = _intent(inv, ROUTE_CROSSCHAIN, address(usdc), AMOUNT);
        (bytes32 id, address fwd) = vault.commitCrossChain(p, inv, _merchantSig(inv), _payerSig(p));
        vm.prank(admin);
        usdc.mint(fwd, dep);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.Underpaid.selector, dep, AMOUNT));
        vault.settleCrossChain(id, "");
    }

    /// Changing ANY single signed intent field after signing must revert (never pay).
    function testFuzz_tamperAnyIntentField(uint8 field, uint256 noise) public {
        field = uint8(bound(field, 0, 12));
        noise = bound(noise, 1, type(uint64).max);
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256(abi.encode("t", field, noise)));
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);

        if (field == 0) p.merchantId = bytes32(uint256(p.merchantId) ^ noise);
        else if (field == 1) p.invoiceId = bytes32(uint256(p.invoiceId) ^ noise);
        else if (field == 2) p.payer = address(uint160(uint160(p.payer) ^ uint160(noise)));
        else if (field == 3) p.payoutToken = address(ausd);
        else if (field == 4) p.amountOut = p.amountOut + noise;
        else if (field == 5) p.route = ROUTE_SWAP;
        else if (field == 6) p.inputToken = address(mon);
        else if (field == 7) p.maxAmountIn = p.maxAmountIn + noise;
        else if (field == 8) p.quoteHash = bytes32(noise);
        else if (field == 9) p.refundTo = address(uint160(noise));
        else if (field == 10) p.expiresAt = p.expiresAt + uint64(noise % 1000) + 1;
        else if (field == 11) p.nonce = p.nonce + noise;
        else p.keyVersion = p.keyVersion + 1;

        uint256 before = usdc.balanceOf(payoutWallet);
        vm.expectRevert();
        vault.payDirect(p, inv, ms, ps, a);
        assertEq(usdc.balanceOf(payoutWallet), before);
    }
}
```

**File: `contracts/test/Invariant.t.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VaultBase} from "./utils/VaultBase.sol";
import {IntentVault} from "../src/IntentVault.sol";
import {MockStableToken} from "../src/mocks/MockStableToken.sol";
import "../src/libraries/ScanPayTypes.sol";

/// Random sequences of: direct pay, cross-chain commit, deposit, settle, refund, time travel.
contract VaultHandler is Test {
    IntentVault internal vault;
    MockStableToken internal usdc;
    address internal admin;
    bytes32 internal merchantId;
    uint32 internal keyVersion;
    uint256 internal signerPk;
    uint256 internal payerPk;
    address internal payer;

    bytes32[] public openCross;
    uint256 public ghostSettledAmountOut;
    uint256 public ghostIn; // everything that entered from payer/solver for settled or refunded intents
    uint256 public ghostOutToMerchantAndFee;
    uint256 public ghostRefunded;
    uint256 internal salt;

    constructor(
        IntentVault v,
        MockStableToken u,
        address admin_,
        bytes32 mId,
        uint32 kv,
        uint256 sPk,
        uint256 pPk
    ) {
        vault = v;
        usdc = u;
        admin = admin_;
        merchantId = mId;
        keyVersion = kv;
        signerPk = sPk;
        payerPk = pPk;
        payer = vm.addr(pPk);
    }

    function _sig(uint256 pk, bytes32 d) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, d);
        return abi.encodePacked(r, s, v);
    }

    function _build(uint256 amount, uint8 route) internal returns (Invoice memory inv, PaymentIntent memory p) {
        salt++;
        inv = Invoice(merchantId, keccak256(abi.encode("h", salt)), address(usdc), amount, uint64(block.timestamp + 900), keyVersion);
        p = PaymentIntent(
            merchantId, inv.invoiceId, payer, address(usdc), amount, route, address(usdc), amount,
            route == ROUTE_DIRECT ? bytes32(0) : keccak256("q"), payer, uint64(block.timestamp + 600), salt, keyVersion
        );
    }

    function payDirect(uint256 amount) external {
        amount = bound(amount, 1, 50e6);
        (Invoice memory inv, PaymentIntent memory p) = _build(amount, ROUTE_DIRECT);
        vm.prank(admin);
        usdc.mint(payer, amount);
        bytes32 digest = vault.hashIntent(p);
        bytes32 rwa = keccak256(
            abi.encodePacked(
                "\x19\x01",
                usdc.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), payer, address(vault), amount, uint256(0), uint256(p.expiresAt), digest))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerPk, rwa);
        vault.payDirect(p, inv, _sig(signerPk, vault.hashInvoice(inv)), _sig(payerPk, digest), Auth3009(v, r, s));
        ghostSettledAmountOut += amount;
        ghostIn += amount;
        ghostOutToMerchantAndFee += amount;
    }

    function commit(uint256 amount) external {
        amount = bound(amount, 1, 50e6);
        (Invoice memory inv, PaymentIntent memory p) = _build(amount, ROUTE_CROSSCHAIN);
        (bytes32 id,) =
            vault.commitCrossChain(p, inv, _sig(signerPk, vault.hashInvoice(inv)), _sig(payerPk, vault.hashIntent(p)));
        openCross.push(id);
    }

    function deposit(uint256 idx, uint256 amount) external {
        if (openCross.length == 0) return;
        bytes32 id = openCross[idx % openCross.length];
        amount = bound(amount, 0, 60e6);
        vm.prank(admin);
        usdc.mint(vault.forwarderOf(id), amount);
    }

    function settle(uint256 idx) external {
        if (openCross.length == 0) return;
        uint256 i = idx % openCross.length;
        bytes32 id = openCross[i];
        IntentRecord memory r = vault.getIntent(id);
        uint256 bal = usdc.balanceOf(vault.forwarderOf(id));
        if (bal < r.inputAmount) return;
        vault.settleCrossChain(id, "");
        ghostSettledAmountOut += r.amountOut;
        ghostIn += bal;
        ghostOutToMerchantAndFee += r.amountOut;
        ghostRefunded += bal - r.amountOut;
        _remove(i);
    }

    function refund(uint256 idx) external {
        if (openCross.length == 0) return;
        uint256 i = idx % openCross.length;
        bytes32 id = openCross[i];
        IntentRecord memory r = vault.getIntent(id);
        uint256 allowedAt = uint256(r.expiresAt) + vault.refundDelay();
        if (block.timestamp < allowedAt) vm.warp(allowedAt);
        uint256 bal = usdc.balanceOf(vault.forwarderOf(id));
        vault.refundCrossChain(id);
        ghostIn += bal;
        ghostRefunded += bal;
        _remove(i);
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 300));
    }

    function _remove(uint256 i) internal {
        openCross[i] = openCross[openCross.length - 1];
        openCross.pop();
    }
}

contract InvariantTest is VaultBase {
    VaultHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new VaultHandler(
            vault, usdc, admin, merchantId, registry.getMerchant(merchantId).keyVersion, SIGNER_PK, PAYER_PK
        );
        vm.prank(admin);
        usdc.grantRole(usdc.MINTER_ROLE(), address(handler));
        // handler mints through `admin` prank; MINTER also granted for safety
        targetContract(address(handler));
    }

    function invariant_vaultNeverHoldsFunds() public view {
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    function invariant_conservation() public view {
        // everything in = merchant net + fees + refunds (to payer)
        assertEq(handler.ghostIn(), handler.ghostOutToMerchantAndFee() + handler.ghostRefunded());
    }

    function invariant_merchantPlusFeeEqualsSettled() public view {
        assertEq(usdc.balanceOf(payoutWallet) + usdc.balanceOf(feeRecipient), handler.ghostSettledAmountOut());
    }
}
```

> Why the payer's own balance isn't asserted: payer = refundTo, and the payer also receives refunds, so the clean
> statement is about the merchant + fee side and the vault's zero balance.

**Commands**

```bash
cd contracts && forge test --match-contract "FuzzTest|InvariantTest" -vv
```

**Exit checks**
- [ ] 4 fuzz tests pass at 512 runs
- [ ] 3 invariants hold (64 runs × depth 64)
- [ ] `forge test` overall → **0 failed**; paste the summary line into `docs/txt/test-summary.txt`

**Commit:** `test(contracts): fuzz (fee split, tamper any field, deposits) + vault invariants`

---

### Phase A18 — Per-chain config, `Deploy.s.sol`, local chain, deployments generator → **I1**

**Goal:** one deploy script for all three chains, driven by `contracts/config/{chainId}.json`; one command that
boots anvil and deploys everything; a generator that writes `deployments/{chainId}.json` (ICD §0.9) and the TS
module B imports. **Time:** 2 h. **Depends on:** A17, A2 decisions.

#### A18.1 Config files

The config holds **everything the deployments JSON needs that isn't an address we deployed**. Token entries with
`"address": null` and a `"mock"` kind are deployed by the script; entries with an address are used as-is.

**File: `contracts/config/31337.json`**

```json
{
  "network": "local",
  "explorer": null,
  "swapAdapterKind": "mock",
  "crossChainInputToken": "USDC",
  "amountCaps": { "USDC": "0", "AUSD": "0" },
  "tokens": {
    "USDC": {
      "address": null, "mock": "stable", "name": "ScanPay Test USDC", "symbol": "tUSDC", "displaySymbol": "USDC",
      "decimals": 6, "eip712": { "name": "ScanPay Test USDC", "version": "1" }, "supports3009": true,
      "isMock": true, "usdPrice": 1, "roles": ["payout", "direct", "swapIn", "crosschainIn"]
    },
    "AUSD": {
      "address": null, "mock": "stable", "name": "ScanPay Test AUSD", "symbol": "tAUSD", "displaySymbol": "AUSD",
      "decimals": 6, "eip712": { "name": "ScanPay Test AUSD", "version": "1" }, "supports3009": true,
      "isMock": true, "usdPrice": 1, "roles": ["payout", "direct", "swapIn"]
    },
    "MON": {
      "address": null, "mock": "erc20", "name": "ScanPay Test MON", "symbol": "tMON", "displaySymbol": "MON",
      "decimals": 18, "eip712": null, "supports3009": false, "isMock": true, "usdPrice": 0.025, "roles": ["swapIn"]
    }
  },
  "mockRates": [
    { "in": "MON", "out": "USDC", "rateE18": "25000" },
    { "in": "MON", "out": "AUSD", "rateE18": "25000" },
    { "in": "USDC", "out": "AUSD", "rateE18": "1000000000000000000" },
    { "in": "AUSD", "out": "USDC", "rateE18": "1000000000000000000" },
    { "in": "USDC", "out": "MON", "rateE18": "40000000000000000000000000000000" }
  ],
  "mockLiquidity": { "USDC": "1000000000000", "AUSD": "1000000000000", "MON": "100000000000000000000000000" },
  "external": { "kuruFlowApi": null, "kuruTargets": [], "auroraMonadUsdcAssetId": null }
}
```

**File: `contracts/config/10143.json`** — same as 31337 except `network` and `explorer`:

```json
{
  "network": "testnet",
  "explorer": "https://testnet.monadscan.com",
  "swapAdapterKind": "mock",
  "crossChainInputToken": "USDC",
  "amountCaps": { "USDC": "0", "AUSD": "0" },
  "tokens": {
    "USDC": {
      "address": null, "mock": "stable", "name": "ScanPay Test USDC", "symbol": "tUSDC", "displaySymbol": "USDC",
      "decimals": 6, "eip712": { "name": "ScanPay Test USDC", "version": "1" }, "supports3009": true,
      "isMock": true, "usdPrice": 1, "roles": ["payout", "direct", "swapIn", "crosschainIn"]
    },
    "AUSD": {
      "address": null, "mock": "stable", "name": "ScanPay Test AUSD", "symbol": "tAUSD", "displaySymbol": "AUSD",
      "decimals": 6, "eip712": { "name": "ScanPay Test AUSD", "version": "1" }, "supports3009": true,
      "isMock": true, "usdPrice": 1, "roles": ["payout", "direct", "swapIn"]
    },
    "MON": {
      "address": null, "mock": "erc20", "name": "ScanPay Test MON", "symbol": "tMON", "displaySymbol": "MON",
      "decimals": 18, "eip712": null, "supports3009": false, "isMock": true, "usdPrice": 0.025, "roles": ["swapIn"]
    }
  },
  "mockRates": [
    { "in": "MON", "out": "USDC", "rateE18": "25000" },
    { "in": "MON", "out": "AUSD", "rateE18": "25000" },
    { "in": "USDC", "out": "AUSD", "rateE18": "1000000000000000000" },
    { "in": "AUSD", "out": "USDC", "rateE18": "1000000000000000000" },
    { "in": "USDC", "out": "MON", "rateE18": "40000000000000000000000000000000" }
  ],
  "mockLiquidity": { "USDC": "1000000000000", "AUSD": "1000000000000", "MON": "100000000000000000000000000" },
  "external": { "kuruFlowApi": null, "kuruTargets": [], "auroraMonadUsdcAssetId": null }
}
```

**File: `contracts/config/143.json`** — fill from your A2 output. Shown with the **expected** answers; flip the
marked fields if A2 said otherwise.

```json
{
  "network": "mainnet",
  "explorer": "https://monadscan.com",
  "swapAdapterKind": "kuru",
  "crossChainInputToken": "USDC",
  "amountCaps": { "USDC": "25000000", "AUSD": "25000000" },
  "tokens": {
    "USDC": {
      "address": "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", "symbol": "USDC", "displaySymbol": "USDC",
      "decimals": 6, "eip712": { "name": "<A2: USDC name()>", "version": "<A2: USDC version()>" },
      "supports3009": true, "isMock": false, "usdPrice": 1,
      "roles": ["payout", "direct", "swapIn", "crosschainIn"]
    },
    "AUSD": {
      "address": "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a", "symbol": "AUSD", "displaySymbol": "AUSD",
      "decimals": 6, "eip712": { "name": "<A2: eip712Domain name>", "version": "<A2: eip712Domain version>" },
      "supports3009": true, "isMock": false, "usdPrice": 1,
      "roles": ["payout", "direct", "swapIn"]
    },
    "WMON": {
      "address": "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A", "symbol": "WMON", "displaySymbol": "MON",
      "decimals": 18, "eip712": null, "supports3009": false, "isMock": false, "usdPrice": 0.025,
      "roles": ["swapIn"]
    },
    "WETH": {
      "address": "0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242", "symbol": "WETH", "displaySymbol": "ETH",
      "decimals": 18, "eip712": null, "supports3009": false, "isMock": false, "usdPrice": 2500,
      "roles": ["swapIn"]
    }
  },
  "mockRates": [],
  "mockLiquidity": {},
  "external": {
    "kuruFlowApi": "https://ws.kuru.io",
    "kuruTargets": ["0xb3e6778480b2E488385E8205eA05E20060B813cb", "0x0d3a1BE29E9dEd63c7a5678b31e847D68F71FFa2"],
    "auroraMonadUsdcAssetId": "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx"
  }
}
```

A2 decision → edit:

| A2 result | Edit in 143.json |
|---|---|
| USDC 3009 missing | `USDC.supports3009=false`, `USDC.eip712=null`, remove `"direct"` from USDC roles |
| AUSD 3009 missing | same for AUSD |
| Kuru has no code | `swapAdapterKind="none"`, `kuruTargets=[]`, remove `"swapIn"` from WMON/WETH; **AUSD payout stays allowed only if you accept AUSD merchants can't take cross-chain** (B hides CROSSCHAIN for AUSD merchants when `SwapAdapter.kind == "none"`) |
| `usdPrice` | display-only hints for B's quote UI (B fetches live prices for real quotes); update WETH to today's price |
| `amountCaps` | 25 USDC/AUSD per payment (in base units). Safety for a hackathon mainnet deploy |

**Rule the script enforces:** a role `"direct"` is applied only if `supports3009 == true`.

#### A18.2 Deploy script

**File: `contracts/script/Deploy.s.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {MerchantRegistry} from "../src/MerchantRegistry.sol";
import {IntentVault} from "../src/IntentVault.sol";
import {IMerchantRegistry} from "../src/interfaces/IMerchantRegistry.sol";
import {MockStableToken} from "../src/mocks/MockStableToken.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockSwapAdapter} from "../src/adapters/MockSwapAdapter.sol";
import {KuruFlowAdapter} from "../src/adapters/KuruFlowAdapter.sol";
import "../src/libraries/ScanPayTypes.sol";

/// Usage (env: ADMIN_ADDRESS, OPERATOR_ADDRESS, FEE_RECIPIENT, FEE_BPS, REFUND_DELAY_SEC):
///   forge script script/Deploy.s.sol:Deploy --rpc-url <local|monad_testnet|monad_mainnet> --broadcast ...
/// Reads  contracts/config/{chainid}.json
/// Writes deployments/raw/{chainid}.json  (then run: pnpm deployments:build {chainid})
contract Deploy is Script {
    using stdJson for string;

    string[6] internal KEYS = ["USDC", "AUSD", "MON", "WMON", "WETH", "USDT0"];

    struct Ctx {
        address admin;
        address operator;
        address feeRecipient;
        uint16 feeBps;
        uint64 refundDelay;
        string cfg;
        MerchantRegistry registry;
        IntentVault vault;
        address adapter;
        string adapterKind;
    }

    mapping(string => address) internal tokenAddr;

    function run() external {
        Ctx memory c;
        c.admin = vm.envAddress("ADMIN_ADDRESS");
        c.operator = vm.envAddress("OPERATOR_ADDRESS");
        c.feeRecipient = vm.envAddress("FEE_RECIPIENT");
        c.feeBps = uint16(vm.envUint("FEE_BPS"));
        c.refundDelay = uint64(vm.envUint("REFUND_DELAY_SEC"));
        c.cfg = vm.readFile(string.concat(vm.projectRoot(), "/config/", vm.toString(block.chainid), ".json"));
        c.adapterKind = c.cfg.readString(".swapAdapterKind");

        console2.log("chainId", block.chainid);
        console2.log("admin", c.admin);
        console2.log("operator", c.operator);

        vm.startBroadcast();

        // 1. core
        c.registry = new MerchantRegistry(c.admin);
        c.vault = new IntentVault(c.admin, IMerchantRegistry(address(c.registry)), c.feeRecipient, c.feeBps, c.refundDelay);

        // 2. tokens (deploy mocks where address is null)
        for (uint256 i; i < KEYS.length; ++i) {
            string memory k = KEYS[i];
            string memory base = string.concat(".tokens.", k);
            if (!vm.keyExistsJson(c.cfg, base)) continue;
            if (_isMock(c.cfg, k)) {
                string memory kind = c.cfg.readString(string.concat(base, ".mock"));
                string memory name = c.cfg.readString(string.concat(base, ".name"));
                string memory symbol = c.cfg.readString(string.concat(base, ".symbol"));
                uint8 dec = uint8(c.cfg.readUint(string.concat(base, ".decimals")));
                address t = keccak256(bytes(kind)) == keccak256("stable")
                    ? address(new MockStableToken(name, symbol, dec, c.admin))
                    : address(new MockERC20(name, symbol, dec, c.admin));
                tokenAddr[k] = t;
            } else {
                tokenAddr[k] = c.cfg.readAddress(string.concat(base, ".address"));
            }
        }

        // 3. swap adapter
        if (keccak256(bytes(c.adapterKind)) == keccak256("mock")) {
            MockSwapAdapter m = new MockSwapAdapter(c.admin, address(c.vault));
            c.adapter = address(m);
            _mockRatesAndLiquidity(c, m);
        } else if (keccak256(bytes(c.adapterKind)) == keccak256("kuru")) {
            address[] memory targets = c.cfg.readAddressArray(".external.kuruTargets");
            require(targets.length > 0, "kuru: no targets");
            c.adapter = address(new KuruFlowAdapter(c.admin, address(c.vault), targets));
        }
        if (c.adapter != address(0)) c.vault.setSwapAdapter(c.adapter);

        // 4. roles per token
        for (uint256 i; i < KEYS.length; ++i) {
            string memory k = KEYS[i];
            if (tokenAddr[k] == address(0)) continue;
            string memory base = string.concat(".tokens.", k);
            string[] memory roles = c.cfg.readStringArray(string.concat(base, ".roles"));
            bool s3009 = c.cfg.readBool(string.concat(base, ".supports3009"));
            for (uint256 j; j < roles.length; ++j) {
                bytes32 r = keccak256(bytes(roles[j]));
                if (r == keccak256("payout")) c.registry.setPayoutTokenAllowed(tokenAddr[k], true);
                else if (r == keccak256("direct") && s3009) c.vault.setInputTokenAllowed(tokenAddr[k], ROUTE_DIRECT, true);
                else if (r == keccak256("swapIn") && c.adapter != address(0)) {
                    c.vault.setInputTokenAllowed(tokenAddr[k], ROUTE_SWAP, true);
                }
            }
            string memory capKey = string.concat(".amountCaps.", k);
            if (vm.keyExistsJson(c.cfg, capKey)) {
                uint256 cap = vm.parseUint(c.cfg.readString(capKey));
                if (cap != 0) c.vault.setAmountCap(tokenAddr[k], cap);
            }
        }

        // 5. cross-chain input
        string memory ccKey = c.cfg.readString(".crossChainInputToken");
        if (tokenAddr[ccKey] != address(0)) c.vault.setCrossChainInputToken(tokenAddr[ccKey]);

        // 6. operator roles (B's hot key)
        c.registry.grantRole(c.registry.VERIFIER_ROLE(), c.operator);
        c.vault.grantRole(c.vault.ATTESTER_ROLE(), c.operator);
        for (uint256 i; i < KEYS.length; ++i) {
            address t = tokenAddr[KEYS[i]];
            if (t == address(0)) continue;
            if (_isMock(c.cfg, KEYS[i])) {
                MockStableToken(t).grantRole(keccak256("MINTER_ROLE"), c.operator); // same role id on MockERC20
            }
        }

        vm.stopBroadcast();

        _writeRaw(c);
    }

    function _mockRatesAndLiquidity(Ctx memory c, MockSwapAdapter m) internal {
        // rates: array of {in,out,rateE18}
        uint256 n = _arrayLen(c.cfg, ".mockRates");
        for (uint256 i; i < n; ++i) {
            string memory b = string.concat(".mockRates[", vm.toString(i), "]");
            address tin = tokenAddr[c.cfg.readString(string.concat(b, ".in"))];
            address tout = tokenAddr[c.cfg.readString(string.concat(b, ".out"))];
            uint256 rate = vm.parseUint(c.cfg.readString(string.concat(b, ".rateE18")));
            m.setRate(tin, tout, rate);
        }
        for (uint256 i; i < KEYS.length; ++i) {
            string memory key = string.concat(".mockLiquidity.", KEYS[i]);
            if (!vm.keyExistsJson(c.cfg, key) || tokenAddr[KEYS[i]] == address(0)) continue;
            uint256 amt = vm.parseUint(c.cfg.readString(key));
            MockStableToken(tokenAddr[KEYS[i]]).mint(address(m), amt); // admin (= broadcaster) holds MINTER
        }
    }

    function _arrayLen(string memory json, string memory key) internal view returns (uint256 n) {
        while (vm.keyExistsJson(json, string.concat(key, "[", vm.toString(n), "]"))) n++;
    }

    /// A token is deployed as a mock iff its config entry has a "mock" key ("stable" | "erc20").
    function _isMock(string memory json, string memory key) internal view returns (bool) {
        return vm.keyExistsJson(json, string.concat(".tokens.", key, ".mock"));
    }

    function _writeRaw(Ctx memory c) internal {
        string memory t = "tokens";
        string memory tokensJson = "{}";
        for (uint256 i; i < KEYS.length; ++i) {
            if (tokenAddr[KEYS[i]] != address(0)) tokensJson = vm.serializeAddress(t, KEYS[i], tokenAddr[KEYS[i]]);
        }
        string memory o = "raw";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeAddress(o, "MerchantRegistry", address(c.registry));
        vm.serializeAddress(o, "IntentVault", address(c.vault));
        vm.serializeAddress(o, "DepositForwarderImpl", c.vault.forwarderImplementation());
        vm.serializeAddress(o, "SwapAdapter", c.adapter);
        vm.serializeString(o, "swapAdapterKind", c.adapter == address(0) ? "none" : c.adapterKind);
        vm.serializeAddress(o, "admin", c.admin);
        vm.serializeAddress(o, "operator", c.operator);
        vm.serializeAddress(o, "feeRecipient", c.feeRecipient);
        vm.serializeUint(o, "feeBps", c.feeBps);
        vm.serializeUint(o, "refundDelaySec", c.refundDelay);
        string memory out = vm.serializeString(o, "tokens", tokensJson);
        string memory path = string.concat(vm.projectRoot(), "/../deployments/raw/", vm.toString(block.chainid), ".json");
        vm.writeJson(out, path);
        console2.log("wrote", path);
    }
}
```

Notes on the script:
- The broadcaster **must be the admin** (`--sender $ADMIN_ADDRESS`): it calls `setSwapAdapter`, `grantRole`, `mint`
  etc. right after deploying. `ADMIN_ADDRESS` must equal the keystore address.
- `MockStableToken` and `MockERC20` share `MINTER_ROLE = keccak256("MINTER_ROLE")`, `mint(address,uint256)` and
  `grantRole`, so the casts to `MockStableToken` are safe for both.
- Mock vs real token is decided by the presence of the `"mock"` key in the config entry (never by `address: null`,
  which JSON cheatcodes parse inconsistently across versions).
- If your forge-std is older and lacks `vm.keyExistsJson`, use `vm.keyExists` (same semantics).

#### A18.3 Local chain scripts

**File: `contracts/script/anvil.sh`**

```bash
#!/usr/bin/env bash
# Starts anvil in the foreground on :8545 with the Monad execution network if supported.
set -euo pipefail
NET_FLAG=""
if anvil --help 2>/dev/null | grep -q -- "--network"; then NET_FLAG="--network monad"; fi
exec anvil --host 127.0.0.1 --port 8545 --chain-id 31337 $NET_FLAG
```

**File: `contracts/script/deploy-local.sh`**

```bash
#!/usr/bin/env bash
# Deploys the full stack to a running anvil and regenerates deployments/31337.json + shared TS.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# anvil well-known accounts (public test keys — local only)
export ADMIN_ADDRESS=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266                    # #0
ADMIN_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
export OPERATOR_ADDRESS=0x70997970C51812dc3A010C7d01b50e0d17dc79C8                 # #1 (= B's OPERATOR_PRIVATE_KEY_LOCAL)
export FEE_RECIPIENT=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC                    # #2
export FEE_BPS=${FEE_BPS:-30}
export REFUND_DELAY_SEC=${REFUND_DELAY_SEC:-120}

cd "$ROOT/contracts"
forge script script/Deploy.s.sol:Deploy --rpc-url local --broadcast --private-key "$ADMIN_PK" --sender "$ADMIN_ADDRESS"
cd "$ROOT"
pnpm deployments:build 31337
echo "✅ local stack deployed. deployments/31337.json written."
```

**File: `contracts/script/local-chain.sh`**

```bash
#!/usr/bin/env bash
# One command for B/FE: boot anvil, deploy, keep anvil running (Ctrl+C stops it).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
bash "$ROOT/contracts/script/anvil.sh" > "$ROOT/contracts/anvil.log" 2>&1 &
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null || true' EXIT INT TERM

for i in $(seq 1 50); do
  if cast chain-id --rpc-url http://127.0.0.1:8545 >/dev/null 2>&1; then break; fi
  sleep 0.2
done
cast chain-id --rpc-url http://127.0.0.1:8545 >/dev/null || { echo "anvil did not start (see contracts/anvil.log)"; exit 1; }

bash "$ROOT/contracts/script/deploy-local.sh"
echo "anvil running (pid $ANVIL_PID). Logs: contracts/anvil.log. Ctrl+C to stop."
wait $ANVIL_PID
```

Add `contracts/anvil.log` to `.gitignore`.

#### A18.4 Deployments generator

**File: `contracts/scripts/build-deployments.ts`**

```ts
// Usage: pnpm deployments:build <chainId>
// Merges deployments/raw/<id>.json + contracts/config/<id>.json + broadcast receipts into deployments/<id>.json
// (ICD §0.9) and regenerates packages/shared/src/generated/deployments.ts from every deployments/*.json present.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress } from 'viem';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const chainId = Number(process.argv[2]);
if (!chainId) throw new Error('usage: build-deployments.ts <chainId>');

const raw = JSON.parse(readFileSync(resolve(root, `deployments/raw/${chainId}.json`), 'utf8'));
const cfg = JSON.parse(readFileSync(resolve(root, `contracts/config/${chainId}.json`), 'utf8'));
const lc = (a: string) => getAddress(a).toLowerCase();

// ---- deploy blocks + tx hashes from forge broadcast ----
type Receipt = { transactionHash: string; blockNumber: string };
type Tx = { hash: string; contractName: string | null; contractAddress: string | null; transactionType: string };
const runFile = resolve(root, `contracts/broadcast/Deploy.s.sol/${chainId}/run-latest.json`);
const blocks: Record<string, { deployBlock: number; deployTx: string }> = {};
if (existsSync(runFile)) {
  const run = JSON.parse(readFileSync(runFile, 'utf8')) as { transactions: Tx[]; receipts: Receipt[] };
  const blockOf = new Map(run.receipts.map((r) => [r.transactionHash.toLowerCase(), Number(BigInt(r.blockNumber))]));
  for (const tx of run.transactions) {
    if (tx.transactionType !== 'CREATE' || !tx.contractAddress || !tx.contractName) continue;
    const b = blockOf.get(tx.hash.toLowerCase());
    if (b === undefined) continue;
    blocks[lc(tx.contractAddress)] = { deployBlock: b, deployTx: tx.hash.toLowerCase() };
  }
} else {
  console.warn(`! ${runFile} not found — deployBlock/startBlock will be 0`);
}

const withBlock = (addr: string) => ({ address: lc(addr), ...(blocks[lc(addr)] ?? {}) });
const registry = withBlock(raw.MerchantRegistry);
const vault = withBlock(raw.IntentVault);
const startBlock = Math.min(
  ...[registry.deployBlock, vault.deployBlock].filter((x): x is number => typeof x === 'number'),
  Number.MAX_SAFE_INTEGER,
);

// ---- tokens: config metadata + deployed/configured addresses ----
const tokens: Record<string, unknown> = {};
for (const [key, t] of Object.entries<any>(cfg.tokens)) {
  const address = raw.tokens?.[key];
  if (!address) continue;
  tokens[key] = {
    address: lc(address),
    symbol: t.symbol,
    displaySymbol: t.displaySymbol,
    decimals: t.decimals,
    eip712: t.supports3009 ? t.eip712 : null,
    supports3009: Boolean(t.supports3009),
    isMock: Boolean(t.isMock),
    usdPrice: t.usdPrice,
    // drop "direct" when the token has no EIP-3009; drop "swapIn" when no swap adapter was deployed
    roles: (t.roles as string[]).filter((r) =>
      r === 'direct' ? Boolean(t.supports3009) : r === 'swapIn' ? raw.swapAdapterKind !== 'none' : true,
    ),
  };
}

const deployment = {
  schemaVersion: 1,
  chainId,
  network: cfg.network,
  generatedAt: new Date().toISOString(),
  startBlock: startBlock === Number.MAX_SAFE_INTEGER ? 0 : startBlock,
  explorer: cfg.explorer,
  contracts: {
    MerchantRegistry: registry,
    IntentVault: vault,
    DepositForwarderImpl: { address: lc(raw.DepositForwarderImpl) },
    SwapAdapter: {
      address: raw.swapAdapterKind === 'none' ? '0x0000000000000000000000000000000000000000' : lc(raw.SwapAdapter),
      kind: raw.swapAdapterKind,
      ...(raw.swapAdapterKind === 'none' ? {} : blocks[lc(raw.SwapAdapter)] ?? {}),
    },
  },
  roles: { admin: lc(raw.admin), operator: lc(raw.operator), feeRecipient: lc(raw.feeRecipient) },
  config: {
    feeBps: Number(raw.feeBps),
    refundDelaySec: Number(raw.refundDelaySec),
    crossChainInputToken: cfg.crossChainInputToken ?? null,
    amountCaps: cfg.amountCaps ?? {},
  },
  tokens,
  external: {
    kuruFlowApi: cfg.external?.kuruFlowApi ?? null,
    kuruTargets: (cfg.external?.kuruTargets ?? []).map(lc),
    auroraMonadUsdcAssetId: cfg.external?.auroraMonadUsdcAssetId ?? null,
  },
};

writeFileSync(resolve(root, `deployments/${chainId}.json`), JSON.stringify(deployment, null, 2) + '\n');
console.log(`wrote deployments/${chainId}.json`);

// ---- regenerate packages/shared/src/generated/deployments.ts ----
const all: Record<number, unknown> = {};
for (const f of readdirSync(resolve(root, 'deployments'))) {
  const m = f.match(/^(\d+)\.json$/);
  if (m) all[Number(m[1])] = JSON.parse(readFileSync(resolve(root, 'deployments', f), 'utf8'));
}
const ts = `// AUTO-GENERATED by contracts/scripts/build-deployments.ts — DO NOT EDIT
import type { Deployment, TokenKey, TokenInfo, Address } from '../types';

export const DEPLOYMENTS: Record<number, Deployment> = ${JSON.stringify(all, null, 2)} as unknown as Record<number, Deployment>;

export function getDeployment(chainId: number): Deployment {
  const d = DEPLOYMENTS[chainId];
  if (!d) throw new Error(\`No deployment for chainId \${chainId}. Run pnpm deployments:build \${chainId}\`);
  return d;
}

export function hasDeployment(chainId: number): boolean {
  return Boolean(DEPLOYMENTS[chainId]);
}

export function getToken(chainId: number, key: TokenKey): TokenInfo {
  const t = getDeployment(chainId).tokens[key];
  if (!t) throw new Error(\`Token \${key} not configured on chain \${chainId}\`);
  return t;
}

export function findTokenByAddress(chainId: number, address: Address): { key: TokenKey; token: TokenInfo } | null {
  const tokens = getDeployment(chainId).tokens;
  for (const [key, token] of Object.entries(tokens) as [TokenKey, TokenInfo][]) {
    if (token.address.toLowerCase() === address.toLowerCase()) return { key, token };
  }
  return null;
}
`;
writeFileSync(resolve(root, 'packages/shared/src/generated/deployments.ts'), ts);
console.log(`regenerated packages/shared/src/generated/deployments.ts (chains: ${Object.keys(all).join(', ')})`);
```

> `generated/deployments.ts` embeds **31337 too** when present. That's fine: anvil + the same deployer key + the
> same nonce sequence always yields the same addresses, so the committed local entry stays valid. B and FE never
> need to run the generator unless they redeploy local.

**Commands**

```bash
chmod +x contracts/script/*.sh
pnpm chain:local          # terminal 1 — leave running
# terminal 2:
cat deployments/31337.json | jq '.contracts, .tokens | keys'
pnpm --filter @scanpay/shared exec tsx scripts/print-deployment.ts 31337
cast call $(jq -r .contracts.IntentVault.address deployments/31337.json) "feeBps()(uint16)" --rpc-url http://127.0.0.1:8545
cast call $(jq -r .contracts.MerchantRegistry.address deployments/31337.json) \
  "hasRole(bytes32,address)(bool)" $(cast keccak VERIFIER_ROLE) 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 --rpc-url http://127.0.0.1:8545
```

**Exit checks**
- [ ] `pnpm chain:local` prints "✅ local stack deployed"
- [ ] `deployments/31337.json` validates against ICD §0.9 (keys present; addresses lowercase; `SwapAdapter.kind == "mock"`)
- [ ] `feeBps()` → `30`; operator has `VERIFIER_ROLE` → `true`; operator has tUSDC `MINTER_ROLE` → `true`
- [ ] `cast call <adapter> "quoteIn(address,address,uint256)(uint256)" <tMON> <tUSDC> 12000000` → `480000000000000000000`
- [ ] Re-running `pnpm chain:local` on a fresh anvil produces **identical addresses** (deterministic)

**Commit:** `feat(deploy): per-chain config, Deploy.s.sol, local chain scripts, deployments generator`

### ✅ Checkpoint **I1** — post in team chat

```
I1 READY
- pnpm chain:local → anvil :8545 + full stack + deployments/31337.json + shared generated/deployments.ts
- Operator (anvil #1, 0x7099…79C8) has VERIFIER (registry), ATTESTER (vault), MINTER (tUSDC/tAUSD/tMON)
- Mock rates: tMON→tUSDC 0.025, USDC↔AUSD 1:1. Cross-chain input token: tUSDC
- B: OPERATOR_PRIVATE_KEY_LOCAL = anvil key #1 (in .env.example)
```

---

### Phase A19 — Monad testnet deploy + verification → **I2**

**Goal:** the real demo deployment on 10143, verified on explorers, committed. **Time:** 45 min.
**Depends on:** A18, A0 (funded deployer, operator address from B).

**Commands**

```bash
set -a; source .env; set +a                       # ADMIN_ADDRESS, OPERATOR_ADDRESS (testnet), FEE_RECIPIENT, FEE_BPS=30, REFUND_DELAY_SEC=600
cast balance $ADMIN_ADDRESS --rpc-url $MONAD_TESTNET_RPC --ether     # > 1 MON

cd contracts
# dry run first (no --broadcast) — catches config/JSON mistakes for free
forge script script/Deploy.s.sol:Deploy --rpc-url monad_testnet --account $DEPLOYER_ACCOUNT --sender $ADMIN_ADDRESS -vvv

# real deploy (+ Sourcify/MonadVision verification in the same run)
forge script script/Deploy.s.sol:Deploy --rpc-url monad_testnet --account $DEPLOYER_ACCOUNT --sender $ADMIN_ADDRESS \
  --broadcast --slow \
  --verify --verifier sourcify --verifier-url https://sourcify-api-monad.blockvision.org/
cd ..
pnpm deployments:build 10143
```

Verify anything the run missed (the forwarder implementation is created inside the vault constructor, so verify it
by hand):

```bash
D=deployments/10143.json
V=$(jq -r .contracts.IntentVault.address $D)
forge verify-contract $(jq -r .contracts.DepositForwarderImpl.address $D) src/DepositForwarder.sol:DepositForwarder \
  --root contracts --chain 10143 --verifier sourcify --verifier-url https://sourcify-api-monad.blockvision.org/ \
  --constructor-args $(cast abi-encode "constructor(address)" $V)

# optional: Monadscan (Etherscan-style) too
forge verify-contract $V src/IntentVault.sol:IntentVault --root contracts --chain 10143 \
  --verifier etherscan --etherscan-api-key $MONADSCAN_API_KEY --watch \
  --constructor-args $(cast abi-encode "constructor(address,address,address,uint16,uint64)" \
     $ADMIN_ADDRESS $(jq -r .contracts.MerchantRegistry.address $D) $FEE_RECIPIENT $FEE_BPS $REFUND_DELAY_SEC)
```

Fund the operator (B's relayer pays every user's gas + drips MON for approvals):

```bash
cast send $OPERATOR_ADDRESS --value 5ether --account $DEPLOYER_ACCOUNT --rpc-url $MONAD_TESTNET_RPC
```

Smoke test on testnet (read-only + one mint):

```bash
D=deployments/10143.json
cast call $(jq -r .tokens.USDC.address $D) "name()(string)" --rpc-url $MONAD_TESTNET_RPC        # "ScanPay Test USDC"
cast call $(jq -r .contracts.IntentVault.address $D) "crossChainInputToken()(address)" --rpc-url $MONAD_TESTNET_RPC
cast call $(jq -r .contracts.SwapAdapter.address $D) "quoteIn(address,address,uint256)(uint256)" \
  $(jq -r .tokens.MON.address $D) $(jq -r .tokens.USDC.address $D) 12000000 --rpc-url $MONAD_TESTNET_RPC
```

**Exit checks**
- [ ] `deployments/10143.json` committed; `startBlock > 0`; all addresses lowercase
- [ ] MerchantRegistry, IntentVault, DepositForwarder, MockSwapAdapter, 3 mocks show **verified** on testnet.monadvision.com (Sourcify) — screenshot into `docs/evidence/`
- [ ] Operator balance ≥ 5 MON
- [ ] `quoteIn` returns `480000000000000000000`

**Commit:** `deploy: monad testnet (10143) — verified`

### ✅ Checkpoint **I2** — post in team chat

```
I2 READY — Monad testnet
- deployments/10143.json committed (pull + pnpm install)
- Registry 0x…  Vault 0x…  Adapter 0x… (mock)  tUSDC 0x…  tAUSD 0x…  tMON 0x…
- Operator 0x… funded 5 MON; has VERIFIER / ATTESTER / MINTER
- verify: pnpm --filter @scanpay/shared exec tsx scripts/print-deployment.ts 10143
```

---

### Phase A20 — Envio indexer: package, config generator, schema

**Goal:** a HyperIndex project whose `config.yaml` is **generated** from the ABIs and `deployments/*.json` (so the
indexer can never drift from the contracts), plus a schema shaped for the three screens B serves: merchant history,
live feed, verify page. **Time:** 60 min. **Depends on:** I2.

**Commands**

```bash
mkdir -p indexer/src/handlers indexer/scripts indexer/test
```

**File: `indexer/package.json`**

```json
{
  "name": "@scanpay/indexer",
  "private": true,
  "type": "module",
  "scripts": {
    "gen:config": "tsx scripts/gen-config.ts",
    "codegen": "envio codegen",
    "dev": "envio dev",
    "start": "envio start",
    "stop": "envio stop",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "envio": "^3.0.0"
  },
  "devDependencies": {
    "@scanpay/shared": "workspace:*",
    "@types/node": "^22.9.0",
    "tsx": "^4.19.2",
    "typescript": "^5.6.3",
    "yaml": "^2.6.0"
  }
}
```

> Pin `envio` to the exact version `pnpx envio --version` prints on the day (v3.x). If `pnpm install` can't find a v3,
> run `pnpx envio init` in a scratch folder, copy its `envio` version into this file, and delete the scratch folder.

**File: `indexer/tsconfig.json`**

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

**File: `indexer/scripts/gen-config.ts`**

```ts
// Generates indexer/config.yaml from @scanpay/shared ABIs + deployments/*.json.
// Usage: INDEX_CHAINS=10143,143 pnpm --filter @scanpay/indexer gen:config
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { intentVaultAbi, merchantRegistryAbi } from '@scanpay/shared';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const chains = (process.env.INDEX_CHAINS ?? '10143').split(',').map((s) => Number(s.trim())).filter(Boolean);

type AbiItem = { type: string; name?: string; inputs?: { name: string; type: string; indexed?: boolean }[] };

function eventSigs(abi: readonly AbiItem[], only?: string[]) {
  return abi
    .filter((x) => x.type === 'event' && (!only || only.includes(x.name!)))
    .map((e) => ({
      event: `${e.name}(${e.inputs!.map((i) => `${i.type}${i.indexed ? ' indexed' : ''} ${i.name}`).join(', ')})`,
    }));
}

const REGISTRY_EVENTS = ['MerchantRegistered', 'MerchantStatusChanged', 'InvoiceSignerRotated', 'PayoutUpdated', 'PayoutTokenAllowed'];
const VAULT_EVENTS = [
  'IntentCommitted', 'PaymentSettled', 'IntentRefunded', 'ForwarderRescued', 'SourceAttested',
  'FeeUpdated', 'SwapAdapterUpdated', 'RefundDelayUpdated', 'AmountCapUpdated', 'InputTokenAllowed',
  'CrossChainInputTokenUpdated',
];

const chainEntries = chains.map((id) => {
  const file = resolve(root, `deployments/${id}.json`);
  if (!existsSync(file)) throw new Error(`deployments/${id}.json missing — deploy first`);
  const d = JSON.parse(readFileSync(file, 'utf8'));
  const entry: Record<string, unknown> = {
    id,
    start_block: d.startBlock,
    contracts: [
      { name: 'MerchantRegistry', address: [d.contracts.MerchantRegistry.address] },
      { name: 'IntentVault', address: [d.contracts.IntentVault.address] },
    ],
  };
  if (id === 31337) {
    // local anvil has no HyperSync: index over RPC (Docker reaches the host via host.docker.internal)
    entry.rpc_config = { url: process.env.LOCAL_RPC_FOR_ENVIO ?? 'http://host.docker.internal:8545' };
  }
  return entry;
});

const config = {
  name: 'scanpay-guard',
  description: 'ScanPay Guard — merchants, payment intents, settlements on Monad',
  contracts: [
    { name: 'MerchantRegistry', events: eventSigs(merchantRegistryAbi as readonly AbiItem[], REGISTRY_EVENTS) },
    { name: 'IntentVault', events: eventSigs(intentVaultAbi as readonly AbiItem[], VAULT_EVENTS) },
  ],
  chains: chainEntries,
  address_format: 'lowercase',
};

const header = '# AUTO-GENERATED by indexer/scripts/gen-config.ts — DO NOT EDIT. Re-run after every deploy.\n';
writeFileSync(resolve(here, '../config.yaml'), header + stringify(config));
console.log(`wrote indexer/config.yaml for chains ${chains.join(', ')}`);
```

> **Why no `disable_default_cross_chain`:** every entity id is prefixed with `chainId_` and carries an explicit
> `chainId` field, so the same contract address on two chains can never collide, and the default (unordered) multichain
> mode stays the fastest. Don't add that flag.

**File: `indexer/schema.graphql`**

```graphql
# ids: always `${chainId}_${lowercaseHex}` (and `${chainId}_${txHash}_${logIndex}` for event rows)

type Merchant {
  id: ID!
  chainId: Int! @index
  merchantId: String! @index
  owner: String! @index
  salt: String!
  payoutWallet: String! @index
  invoiceSigner: String!
  payoutToken: String!
  metadataHash: String!
  status: Int!
  statusName: String!
  keyVersion: Int!
  registeredAt: BigInt!
  registeredTx: String!
  updatedAt: BigInt!
  paymentCount: Int!
  settledVolume: BigInt!
  netReceived: BigInt!
  feesPaid: BigInt!
  intents: [Intent!]! @derivedFrom(field: "merchant")
  keyEvents: [MerchantKeyEvent!]! @derivedFrom(field: "merchant")
}

type MerchantKeyEvent {
  id: ID!
  chainId: Int! @index
  merchant: Merchant!
  kind: String!            # REGISTERED | STATUS | SIGNER_ROTATED | PAYOUT_UPDATED
  keyVersion: Int!
  invoiceSigner: String
  payoutWallet: String
  payoutToken: String
  fromStatus: Int
  toStatus: Int
  by: String
  timestamp: BigInt!
  txHash: String!
  blockNumber: Int!
}

type Intent {
  id: ID!
  chainId: Int! @index
  intentId: String! @index
  merchant: Merchant!
  merchantId: String! @index
  payer: String! @index
  invoiceId: String! @index
  route: Int!
  routeName: String!
  status: String! @index   # COMMITTED | SETTLED | REFUNDED
  inputToken: String!
  payoutToken: String!
  amountOut: BigInt!
  forwarder: String
  payoutWallet: String!
  expiresAt: BigInt!
  quoteHash: String!
  committedAt: BigInt! @index
  committedTx: String!
  committedBlock: Int!
  settledAt: BigInt
  settledTx: String
  settledBlock: Int
  fee: BigInt
  netToMerchant: BigInt
  inputAmount: BigInt
  excessRefunded: BigInt
  refundedAt: BigInt
  refundTx: String
  refundTo: String
  refundAmount: BigInt
  rescuedAmount: BigInt!
  sourceChainId: BigInt
  sourceTxHash: String
  providerRef: String
  attester: String
  attestedTx: String
}

type MerchantDailyStat {
  id: ID!                  # `${chainId}_${merchantId}_${dayStartUnix}`
  chainId: Int! @index
  merchantId: String! @index
  dayStart: BigInt! @index
  payments: Int!
  volume: BigInt!
  net: BigInt!
}

type ProtocolStat {
  id: ID!                  # `${chainId}`
  chainId: Int!
  merchants: Int!
  activeMerchants: Int!
  intents: Int!
  settled: Int!
  refunded: Int!
  volume: BigInt!          # sum of amountOut (6-dec stables)
  fees: BigInt!
  crossChainSettled: Int!
}

type ConfigEvent {
  id: ID!
  chainId: Int! @index
  contract: String!
  kind: String!
  data: String!            # JSON
  timestamp: BigInt!
  txHash: String!
}
```

**Commands**

```bash
pnpm install
INDEX_CHAINS=10143 pnpm indexer:config
cat indexer/config.yaml | head -40
cd indexer && pnpm codegen && cd ..
```

**Exit checks**
- [ ] `indexer/config.yaml` lists 5 registry events and 11 vault events, chain 10143, testnet start block
- [ ] `pnpm codegen` succeeds (creates `indexer/generated/`, git-ignored)

**Commit:** `feat(indexer): generated envio config + schema`

---

### Phase A21 — Envio handlers + local run against testnet

**Goal:** handlers for every event, idempotent and side-effect free (Envio preloads handlers twice), then a local
run that indexes the real testnet deployment. **Time:** 90 min. **Depends on:** A20.

**File: `indexer/src/handlers/util.ts`**

```ts
export const ROUTE_NAME = ['DIRECT', 'SWAP', 'CROSSCHAIN'] as const;
export const MERCHANT_STATUS_NAME = ['NONE', 'PENDING', 'ACTIVE', 'SUSPENDED', 'REVOKED'] as const;
export const MERCHANT_ACTIVE = 2;

export const lc = (s: string) => s.toLowerCase();
export const eid = (chainId: number, hex: string) => `${chainId}_${lc(hex)}`;
export const logId = (chainId: number, txHash: string, logIndex: number) => `${chainId}_${lc(txHash)}_${logIndex}`;
export const dayStart = (ts: number | bigint) => (BigInt(ts) / 86_400n) * 86_400n;
export const num = (x: bigint | number) => Number(x);

export function emptyProtocolStat(chainId: number) {
  return {
    id: String(chainId),
    chainId,
    merchants: 0,
    activeMerchants: 0,
    intents: 0,
    settled: 0,
    refunded: 0,
    volume: 0n,
    fees: 0n,
    crossChainSettled: 0,
  };
}
```

**File: `indexer/src/handlers/MerchantRegistry.ts`**

```ts
import { indexer } from 'envio';
import { eid, emptyProtocolStat, lc, logId, MERCHANT_ACTIVE, MERCHANT_STATUS_NAME, num } from './util';

const FIELDS = { block: ['timestamp'], transaction: ['hash'] } as const;

indexer.onEvent(
  { contract: 'MerchantRegistry', event: 'MerchantRegistered', fields: FIELDS },
  async ({ event, context }) => {
    const p = event.params;
    const ts = BigInt(event.block.timestamp);
    const id = eid(event.chainId, p.merchantId);
    context.Merchant.set({
      id,
      chainId: event.chainId,
      merchantId: lc(p.merchantId),
      owner: lc(p.owner),
      salt: lc(p.salt),
      payoutWallet: lc(p.payoutWallet),
      invoiceSigner: lc(p.invoiceSigner),
      payoutToken: lc(p.payoutToken),
      metadataHash: lc(p.metadataHash),
      status: 1,
      statusName: 'PENDING',
      keyVersion: 1,
      registeredAt: ts,
      registeredTx: lc(event.transaction.hash),
      updatedAt: ts,
      paymentCount: 0,
      settledVolume: 0n,
      netReceived: 0n,
      feesPaid: 0n,
    });
    context.MerchantKeyEvent.set({
      id: logId(event.chainId, event.transaction.hash, event.logIndex),
      chainId: event.chainId,
      merchant_id: id,
      kind: 'REGISTERED',
      keyVersion: 1,
      invoiceSigner: lc(p.invoiceSigner),
      payoutWallet: lc(p.payoutWallet),
      payoutToken: lc(p.payoutToken),
      fromStatus: undefined,
      toStatus: undefined,
      by: undefined,
      timestamp: ts,
      txHash: lc(event.transaction.hash),
      blockNumber: event.block.number,
    });
    const stat = (await context.ProtocolStat.get(String(event.chainId))) ?? emptyProtocolStat(event.chainId);
    context.ProtocolStat.set({ ...stat, merchants: stat.merchants + 1 });
  },
);

indexer.onEvent(
  { contract: 'MerchantRegistry', event: 'MerchantStatusChanged', fields: FIELDS },
  async ({ event, context }) => {
    const p = event.params;
    const id = eid(event.chainId, p.merchantId);
    const m = await context.Merchant.get(id);
    if (!m) return; // MerchantRegistered always precedes in the same tx; defensive only
    const from = num(p.previousStatus);
    const to = num(p.newStatus);
    const ts = BigInt(event.block.timestamp);
    context.Merchant.set({ ...m, status: to, statusName: MERCHANT_STATUS_NAME[to] ?? 'UNKNOWN', updatedAt: ts });
    context.MerchantKeyEvent.set({
      id: logId(event.chainId, event.transaction.hash, event.logIndex),
      chainId: event.chainId,
      merchant_id: id,
      kind: 'STATUS',
      keyVersion: m.keyVersion,
      invoiceSigner: undefined,
      payoutWallet: undefined,
      payoutToken: undefined,
      fromStatus: from,
      toStatus: to,
      by: lc(p.by),
      timestamp: ts,
      txHash: lc(event.transaction.hash),
      blockNumber: event.block.number,
    });
    if (from === to) return;
    const stat = (await context.ProtocolStat.get(String(event.chainId))) ?? emptyProtocolStat(event.chainId);
    const delta = (to === MERCHANT_ACTIVE ? 1 : 0) - (from === MERCHANT_ACTIVE ? 1 : 0);
    if (delta !== 0) context.ProtocolStat.set({ ...stat, activeMerchants: stat.activeMerchants + delta });
  },
);

indexer.onEvent(
  { contract: 'MerchantRegistry', event: 'InvoiceSignerRotated', fields: FIELDS },
  async ({ event, context }) => {
    const p = event.params;
    const id = eid(event.chainId, p.merchantId);
    const m = await context.Merchant.get(id);
    if (!m) return;
    const ts = BigInt(event.block.timestamp);
    context.Merchant.set({ ...m, invoiceSigner: lc(p.invoiceSigner), keyVersion: num(p.keyVersion), updatedAt: ts });
    context.MerchantKeyEvent.set({
      id: logId(event.chainId, event.transaction.hash, event.logIndex),
      chainId: event.chainId,
      merchant_id: id,
      kind: 'SIGNER_ROTATED',
      keyVersion: num(p.keyVersion),
      invoiceSigner: lc(p.invoiceSigner),
      payoutWallet: undefined,
      payoutToken: undefined,
      fromStatus: undefined,
      toStatus: undefined,
      by: undefined,
      timestamp: ts,
      txHash: lc(event.transaction.hash),
      blockNumber: event.block.number,
    });
  },
);

indexer.onEvent(
  { contract: 'MerchantRegistry', event: 'PayoutUpdated', fields: FIELDS },
  async ({ event, context }) => {
    const p = event.params;
    const id = eid(event.chainId, p.merchantId);
    const m = await context.Merchant.get(id);
    if (!m) return;
    const ts = BigInt(event.block.timestamp);
    context.Merchant.set({
      ...m,
      payoutWallet: lc(p.payoutWallet),
      payoutToken: lc(p.payoutToken),
      keyVersion: num(p.keyVersion),
      updatedAt: ts,
    });
    context.MerchantKeyEvent.set({
      id: logId(event.chainId, event.transaction.hash, event.logIndex),
      chainId: event.chainId,
      merchant_id: id,
      kind: 'PAYOUT_UPDATED',
      keyVersion: num(p.keyVersion),
      invoiceSigner: undefined,
      payoutWallet: lc(p.payoutWallet),
      payoutToken: lc(p.payoutToken),
      fromStatus: undefined,
      toStatus: undefined,
      by: undefined,
      timestamp: ts,
      txHash: lc(event.transaction.hash),
      blockNumber: event.block.number,
    });
  },
);

indexer.onEvent(
  { contract: 'MerchantRegistry', event: 'PayoutTokenAllowed', fields: FIELDS },
  async ({ event, context }) => {
    context.ConfigEvent.set({
      id: logId(event.chainId, event.transaction.hash, event.logIndex),
      chainId: event.chainId,
      contract: 'MerchantRegistry',
      kind: 'PayoutTokenAllowed',
      data: JSON.stringify({ token: lc(event.params.token), allowed: event.params.allowed }),
      timestamp: BigInt(event.block.timestamp),
      txHash: lc(event.transaction.hash),
    });
  },
);
```

**File: `indexer/src/handlers/IntentVault.ts`**

```ts
import { indexer } from 'envio';
import { dayStart, eid, emptyProtocolStat, lc, logId, num, ROUTE_NAME } from './util';

const FIELDS = { block: ['timestamp'], transaction: ['hash'] } as const;
const ZERO = '0x0000000000000000000000000000000000000000';

indexer.onEvent({ contract: 'IntentVault', event: 'IntentCommitted', fields: FIELDS }, async ({ event, context }) => {
  const p = event.params;
  const route = num(p.route);
  const ts = BigInt(event.block.timestamp);
  context.Intent.set({
    id: eid(event.chainId, p.intentId),
    chainId: event.chainId,
    intentId: lc(p.intentId),
    merchant_id: eid(event.chainId, p.merchantId),
    merchantId: lc(p.merchantId),
    payer: lc(p.payer),
    invoiceId: lc(p.invoiceId),
    route,
    routeName: ROUTE_NAME[route] ?? 'UNKNOWN',
    status: 'COMMITTED',
    inputToken: lc(p.inputToken),
    payoutToken: lc(p.payoutToken),
    amountOut: p.amountOut,
    forwarder: lc(p.forwarder) === ZERO ? undefined : lc(p.forwarder),
    payoutWallet: lc(p.payoutWallet),
    expiresAt: p.expiresAt,
    quoteHash: lc(p.quoteHash),
    committedAt: ts,
    committedTx: lc(event.transaction.hash),
    committedBlock: event.block.number,
    settledAt: undefined,
    settledTx: undefined,
    settledBlock: undefined,
    fee: undefined,
    netToMerchant: undefined,
    inputAmount: undefined,
    excessRefunded: undefined,
    refundedAt: undefined,
    refundTx: undefined,
    refundTo: undefined,
    refundAmount: undefined,
    rescuedAmount: 0n,
    sourceChainId: undefined,
    sourceTxHash: undefined,
    providerRef: undefined,
    attester: undefined,
    attestedTx: undefined,
  });
  const stat = (await context.ProtocolStat.get(String(event.chainId))) ?? emptyProtocolStat(event.chainId);
  context.ProtocolStat.set({ ...stat, intents: stat.intents + 1 });
});

indexer.onEvent({ contract: 'IntentVault', event: 'PaymentSettled', fields: FIELDS }, async ({ event, context }) => {
  const p = event.params;
  const ts = BigInt(event.block.timestamp);
  const id = eid(event.chainId, p.intentId);
  const net = p.amountOut - p.fee;
  const intent = await context.Intent.get(id);
  if (intent) {
    context.Intent.set({
      ...intent,
      status: 'SETTLED',
      settledAt: ts,
      settledTx: lc(event.transaction.hash),
      settledBlock: event.block.number,
      fee: p.fee,
      netToMerchant: net,
      inputAmount: p.inputAmount,
      excessRefunded: p.excessRefunded,
    });
  }

  const mId = eid(event.chainId, p.merchantId);
  const m = await context.Merchant.get(mId);
  if (m) {
    context.Merchant.set({
      ...m,
      paymentCount: m.paymentCount + 1,
      settledVolume: m.settledVolume + p.amountOut,
      netReceived: m.netReceived + net,
      feesPaid: m.feesPaid + p.fee,
      updatedAt: ts,
    });
  }

  const day = dayStart(ts);
  const dId = `${mId}_${day}`;
  const d = (await context.MerchantDailyStat.get(dId)) ?? {
    id: dId,
    chainId: event.chainId,
    merchantId: lc(p.merchantId),
    dayStart: day,
    payments: 0,
    volume: 0n,
    net: 0n,
  };
  context.MerchantDailyStat.set({ ...d, payments: d.payments + 1, volume: d.volume + p.amountOut, net: d.net + net });

  const stat = (await context.ProtocolStat.get(String(event.chainId))) ?? emptyProtocolStat(event.chainId);
  context.ProtocolStat.set({
    ...stat,
    settled: stat.settled + 1,
    volume: stat.volume + p.amountOut,
    fees: stat.fees + p.fee,
    crossChainSettled: stat.crossChainSettled + (num(p.route) === 2 ? 1 : 0),
  });
});

indexer.onEvent({ contract: 'IntentVault', event: 'IntentRefunded', fields: FIELDS }, async ({ event, context }) => {
  const p = event.params;
  const id = eid(event.chainId, p.intentId);
  const intent = await context.Intent.get(id);
  if (intent) {
    context.Intent.set({
      ...intent,
      status: 'REFUNDED',
      refundedAt: BigInt(event.block.timestamp),
      refundTx: lc(event.transaction.hash),
      refundTo: lc(p.refundTo),
      refundAmount: p.amount,
    });
  }
  const stat = (await context.ProtocolStat.get(String(event.chainId))) ?? emptyProtocolStat(event.chainId);
  context.ProtocolStat.set({ ...stat, refunded: stat.refunded + 1 });
});

indexer.onEvent({ contract: 'IntentVault', event: 'ForwarderRescued', fields: FIELDS }, async ({ event, context }) => {
  const intent = await context.Intent.get(eid(event.chainId, event.params.intentId));
  if (intent) context.Intent.set({ ...intent, rescuedAmount: intent.rescuedAmount + event.params.amount });
});

indexer.onEvent({ contract: 'IntentVault', event: 'SourceAttested', fields: FIELDS }, async ({ event, context }) => {
  const p = event.params;
  const intent = await context.Intent.get(eid(event.chainId, p.intentId));
  if (!intent) return;
  context.Intent.set({
    ...intent,
    sourceChainId: p.sourceChainId,
    sourceTxHash: lc(p.sourceTxHash),
    providerRef: lc(p.providerRef),
    attester: lc(p.attester),
    attestedTx: lc(event.transaction.hash),
  });
});

// ---- config events → ConfigEvent rows (admin audit trail shown on the verify page) ----
const CONFIG_EVENTS = [
  'FeeUpdated',
  'SwapAdapterUpdated',
  'RefundDelayUpdated',
  'AmountCapUpdated',
  'InputTokenAllowed',
  'CrossChainInputTokenUpdated',
] as const;

for (const name of CONFIG_EVENTS) {
  indexer.onEvent({ contract: 'IntentVault', event: name, fields: FIELDS }, async ({ event, context }) => {
    context.ConfigEvent.set({
      id: logId(event.chainId, event.transaction.hash, event.logIndex),
      chainId: event.chainId,
      contract: 'IntentVault',
      kind: name,
      data: JSON.stringify(event.params, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
      timestamp: BigInt(event.block.timestamp),
      txHash: lc(event.transaction.hash),
    });
  });
}
```

> **If your installed Envio's generated types differ** (e.g. it still exposes the v2 style), the mapping is
> mechanical — same handler bodies, different registration:
> ```ts
> import { IntentVault } from 'generated';
> IntentVault.PaymentSettled.handler(async ({ event, context }) => { /* same body */ });
> ```
> and per-event field selection moves to `config.yaml` under each event: `field_selection: { transaction_fields: [hash], block_fields: [timestamp] }`
> (add that in `gen-config.ts`). Check `indexer/generated/` after `pnpm codegen` — it is the source of truth for names.
> Optional entity fields: if codegen types them as `T | undefined`, `undefined` is right; if `T | null`, replace
> `undefined` with `null`.

**GraphQL contract for Backend B** (B's `services/api/src/envio/queries.ts` uses exactly these; changing the schema
means changing this list in both docs):

```graphql
# Q1 merchant profile + totals
query Merchant($id: String!) { Merchant(where: { id: { _eq: $id } }) {
  id chainId merchantId owner payoutWallet invoiceSigner payoutToken metadataHash status statusName keyVersion
  registeredAt registeredTx updatedAt paymentCount settledVolume netReceived feesPaid } }

# Q2 merchant payments (history + live feed polling)
query MerchantIntents($chainId: Int!, $merchantId: String!, $limit: Int!, $offset: Int!) {
  Intent(where: { chainId: { _eq: $chainId }, merchantId: { _eq: $merchantId } },
         order_by: { committedAt: desc }, limit: $limit, offset: $offset) {
    id intentId payer invoiceId route routeName status inputToken payoutToken amountOut fee netToMerchant
    inputAmount excessRefunded forwarder committedAt committedTx settledAt settledTx refundedAt refundTx
    sourceChainId sourceTxHash } }

# Q3 one intent (verify page)
query IntentById($id: String!) { Intent(where: { id: { _eq: $id } }) {
  id chainId intentId merchantId payer invoiceId route routeName status inputToken payoutToken amountOut fee
  netToMerchant inputAmount excessRefunded forwarder payoutWallet expiresAt quoteHash committedAt committedTx
  committedBlock settledAt settledTx settledBlock refundedAt refundTx refundTo refundAmount rescuedAmount
  sourceChainId sourceTxHash providerRef attester attestedTx
  merchant { merchantId status statusName keyVersion payoutWallet owner } } }

# Q4 daily chart
query MerchantDaily($chainId: Int!, $merchantId: String!, $since: numeric!) {
  MerchantDailyStat(where: { chainId: { _eq: $chainId }, merchantId: { _eq: $merchantId }, dayStart: { _gte: $since } },
                    order_by: { dayStart: asc }) { dayStart payments volume net } }

# Q5 key history (Many-Keys story on the merchant page)
query MerchantKeys($id: String!) { MerchantKeyEvent(where: { merchant_id: { _eq: $id } }, order_by: { timestamp: asc }) {
  kind keyVersion invoiceSigner payoutWallet payoutToken fromStatus toStatus by timestamp txHash } }

# Q6 protocol stats (landing page)
query Stats($chainId: String!) { ProtocolStat(where: { id: { _eq: $chainId } }) {
  merchants activeMerchants intents settled refunded volume fees crossChainSettled } }
```

Notes for B: BigInt fields come back as **strings**; `$since` is a `numeric` (pass a string); ids are
`"<chainId>_<lowercase hex>"`. Envio's Hasura also exposes `Intent_by_pk(id:)` — Q3 uses `where` so it works on both
local and Cloud.

**Commands** (Docker running; `ENVIO_API_TOKEN` in `indexer/.env` — create it at envio.dev/app/api-tokens)

```bash
echo "ENVIO_API_TOKEN=$ENVIO_API_TOKEN" > indexer/.env
cd indexer && pnpm codegen && pnpm dev
# Hasura console: http://localhost:8080 (admin secret: testing)
```

Generate real data while it runs (in another terminal) — one registration + approval through `cast`, so the indexer
has something to show before B's API exists:

```bash
# uses the scripted demo merchant from Phase A21b below
pnpm --filter @scanpay/contracts exec tsx scripts/seed-demo.ts 10143
```

**File: `contracts/scripts/seed-demo.ts`** (A21b) — registers + approves a demo merchant and runs one DIRECT payment
using throwaway keys. It doubles as an **end-to-end wiring test of the shared SDK against the real deployment**.

```ts
// Usage: OPERATOR_PRIVATE_KEY=0x… tsx scripts/seed-demo.ts <chainId>
// The operator key pays gas, approves the merchant (VERIFIER) and mints test tokens (MINTER). Testnet/local only.
import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { foundry, monadTestnet } from 'viem/chains';
import {
  buildIntentTypedData, buildInvoiceTypedData, buildReceiveAuthTypedData, buildRegistrationTypedData,
  computeMerchantId, getDeployment, getToken, intentDigest, keccak256Utf8, merchantRegistryAbi, intentVaultAbi,
  mockStableTokenAbi, randomBytes32, randomNonce, receiveAuthForIntent, splitSignature, ROUTE, MERCHANT_STATUS, ZERO_BYTES32,
} from './seed-imports';

const chainId = Number(process.argv[2] ?? '31337');
const chain = chainId === 10143 ? monadTestnet : foundry;
const rpc = chainId === 10143 ? process.env.MONAD_TESTNET_RPC! : 'http://127.0.0.1:8545';
const d = getDeployment(chainId);
const operator = privateKeyToAccount(process.env.OPERATOR_PRIVATE_KEY as Hex);
const pub = createPublicClient({ chain, transport: http(rpc) });
const wallet = createWalletClient({ chain, transport: http(rpc), account: operator });

async function send(req: Parameters<typeof wallet.writeContract>[0]) {
  const { request } = await pub.simulateContract({ ...(req as any), account: operator });
  const gas = await pub.estimateContractGas({ ...(req as any), account: operator });
  const hash = await wallet.writeContract({ ...(request as any), gas: (gas * 12n) / 10n }); // Monad bills the limit
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`reverted ${hash}`);
  return hash;
}

const owner = privateKeyToAccount(generatePrivateKey());
const payout = privateKeyToAccount(generatePrivateKey());
const signer = privateKeyToAccount(generatePrivateKey());
const payer = privateKeyToAccount(generatePrivateKey());
const usdc = getToken(chainId, 'USDC');
const registry = d.contracts.MerchantRegistry.address;
const vault = d.contracts.IntentVault.address;

// 1. register (owner + payout sign the same digest)
const salt = randomBytes32();
const reg = {
  owner: owner.address, salt, payoutWallet: payout.address, invoiceSigner: signer.address, payoutToken: usdc.address,
  metadataHash: keccak256Utf8('{"displayName":"Seed Cafe"}'), nonce: 0n, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
};
const regTd = buildRegistrationTypedData(chainId, registry, reg);
await send({ address: registry, abi: merchantRegistryAbi, functionName: 'registerMerchant',
  args: [reg, await owner.signTypedData(regTd), await payout.signTypedData(regTd)] });
const merchantId = computeMerchantId(owner.address, salt);
await send({ address: registry, abi: merchantRegistryAbi, functionName: 'setMerchantStatus', args: [merchantId, MERCHANT_STATUS.ACTIVE] });
console.log('merchant', merchantId);

// 2. fund payer, pay 1.23 tUSDC DIRECT
await send({ address: usdc.address, abi: mockStableTokenAbi, functionName: 'mint', args: [payer.address, 5_000_000n] });
const now = BigInt(Math.floor(Date.now() / 1000));
const invoice = { merchantId, invoiceId: randomBytes32(), payoutToken: usdc.address, amount: 1_230_000n, expiresAt: now + 900n, keyVersion: 1 };
const intent = {
  merchantId, invoiceId: invoice.invoiceId, payer: payer.address, payoutToken: usdc.address, amountOut: invoice.amount,
  route: ROUTE.DIRECT, inputToken: usdc.address, maxAmountIn: invoice.amount, quoteHash: ZERO_BYTES32,
  refundTo: payer.address, expiresAt: now + 600n, nonce: randomNonce(), keyVersion: 1,
};
const merchantSig = await signer.signTypedData(buildInvoiceTypedData(chainId, vault, invoice));
const payerSig = await payer.signTypedData(buildIntentTypedData(chainId, vault, intent));
const auth = splitSignature(await payer.signTypedData(
  buildReceiveAuthTypedData(chainId, usdc, receiveAuthForIntent(intent, intentDigest(chainId, vault, intent), vault))));
const tx = await send({ address: vault, abi: intentVaultAbi, functionName: 'payDirect', args: [intent, invoice, merchantSig, payerSig, auth] });
console.log('payDirect', tx);
```

**File: `contracts/scripts/seed-imports.ts`**

```ts
export * from '@scanpay/shared';
import { keccak256, toBytes } from 'viem';
export const keccak256Utf8 = (s: string) => keccak256(toBytes(s));
```

> `send()` passes the struct objects straight to viem; viem encodes the tuples from the generated ABI. If this
> script succeeds, the shared SDK, ABIs, deployments JSON and contracts are wired correctly — **the single most
> valuable integration check in the project**. Run it on local (I1) too: `OPERATOR_PRIVATE_KEY=0x59c6…690d tsx scripts/seed-demo.ts 31337`.

**Exit checks**
- [ ] `seed-demo.ts 31337` and `seed-demo.ts 10143` both print a `payDirect` hash
- [ ] In Hasura (`localhost:8080`): `Merchant` has the seed merchant with `statusName: "ACTIVE"`, `paymentCount: 1`
- [ ] `Intent` row with `status: "SETTLED"`, `fee` = `3690` (1.23 × 0.30%), `netToMerchant` = `1226310`
- [ ] `ProtocolStat` id `"10143"` shows `settled ≥ 1`
- [ ] All 6 queries above run in the Hasura console without errors

**Commit:** `feat(indexer): handlers for registry + vault; seed-demo end-to-end script`

---

### Phase A22 — Envio Cloud (hosted) for testnet → **I3**

**Goal:** a public GraphQL endpoint B can call from Railway. **Time:** 40 min. **Depends on:** A21.

**Steps**

1. Commit `indexer/config.yaml` (generated, but Cloud doesn't run our generator — it must be in git).
2. https://envio.dev/app → sign in with GitHub → **Add indexer** → install the **Envio Deployments** GitHub app on
   the `scanpay-guard` repo.
3. Settings: root directory **`indexer`**, config file **`config.yaml`**, deploy branch **`envio`** (a dedicated
   branch so random pushes to `main` don't redeploy mid-demo).
4. Environment variables: `ENVIO_API_TOKEN`.
5. Push:

```bash
git checkout -b envio && git push -u origin envio && git checkout main
```

6. Wait for "Synced" (minutes for testnet). Copy the GraphQL endpoint URL.
7. Test from your laptop:

```bash
export ENVIO_GRAPHQL_URL=<cloud url>
curl -s $ENVIO_GRAPHQL_URL -H 'content-type: application/json' \
  -d '{"query":"{ Merchant(limit:1){ id statusName paymentCount } }"}' | jq
```

**Redeploy rule:** after any contract redeploy → `pnpm deployments:build` → `INDEX_CHAINS=… pnpm indexer:config` →
commit → `git push origin main:envio`.

**Exit checks**
- [ ] Cloud deployment status "Synced"
- [ ] curl returns the seed merchant
- [ ] URL pasted in team chat and in `docs/endpoints.md`

**Commit:** `chore(indexer): envio cloud deployment for monad testnet`

### ✅ Checkpoint **I3** — post in team chat

```
I3 READY — Envio (testnet)
ENVIO_GRAPHQL_URL=https://…/v1/graphql
Entities: Merchant, MerchantKeyEvent, Intent, MerchantDailyStat, ProtocolStat, ConfigEvent (ids "<chainId>_<hex>")
Queries B uses: A21 "GraphQL contract for Backend B" (Q1–Q6)
```

---

### Phase A23 — Monad mainnet deploy → **I4**

**Goal:** the same stack on 143 with real USDC/AUSD, Kuru adapter, conservative caps. **Time:** 45 min.
**Depends on:** A2 decisions written into `contracts/config/143.json`, A22.

**Pre-flight**

| Check | Command / value |
|---|---|
| Deployer funded (≥ 3 MON) | `cast balance $ADMIN_ADDRESS --rpc-url $MONAD_MAINNET_RPC --ether` |
| Mainnet operator address from B | `OPERATOR_ADDRESS` in `.env` = address of `OPERATOR_PRIVATE_KEY_MAINNET` |
| `REFUND_DELAY_SEC=3600` | longer than any Aurora quote deadline B requests (B uses ≤ 30 min) |
| `FEE_BPS=30` | same as testnet |
| `143.json` eip712 names/versions filled from A2 | **wrong value = every mainnet DIRECT payment fails** |

**Commands**

```bash
set -a; source .env; set +a
export REFUND_DELAY_SEC=3600
cd contracts
forge script script/Deploy.s.sol:Deploy --rpc-url monad_mainnet --account $DEPLOYER_ACCOUNT --sender $ADMIN_ADDRESS -vvv
forge script script/Deploy.s.sol:Deploy --rpc-url monad_mainnet --account $DEPLOYER_ACCOUNT --sender $ADMIN_ADDRESS \
  --broadcast --slow --verify --verifier sourcify --verifier-url https://sourcify-api-monad.blockvision.org/
cd ..
pnpm deployments:build 143

D=deployments/143.json
forge verify-contract $(jq -r .contracts.DepositForwarderImpl.address $D) src/DepositForwarder.sol:DepositForwarder \
  --root contracts --chain 143 --verifier sourcify --verifier-url https://sourcify-api-monad.blockvision.org/ \
  --constructor-args $(cast abi-encode "constructor(address)" $(jq -r .contracts.IntentVault.address $D))

cast send $OPERATOR_ADDRESS --value 3ether --account $DEPLOYER_ACCOUNT --rpc-url $MONAD_MAINNET_RPC
```

Read-only smoke:

```bash
V=$(jq -r .contracts.IntentVault.address deployments/143.json)
R=$(jq -r .contracts.MerchantRegistry.address deployments/143.json)
cast call $V "isInputTokenAllowed(address,uint8)(bool)" 0x754704Bc059F8C67012fEd69BC8A327a5aafb603 0 --rpc-url $MONAD_MAINNET_RPC  # true if USDC 3009
cast call $V "crossChainInputToken()(address)" --rpc-url $MONAD_MAINNET_RPC                                           # USDC
cast call $V "amountCap(address)(uint256)" 0x754704Bc059F8C67012fEd69BC8A327a5aafb603 --rpc-url $MONAD_MAINNET_RPC    # 25000000
cast call $R "isPayoutTokenAllowed(address)(bool)" 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a --rpc-url $MONAD_MAINNET_RPC # true
cast call $(jq -r .contracts.SwapAdapter.address deployments/143.json) \
  "allowedTarget(address)(bool)" 0xb3e6778480b2E488385E8205eA05E20060B813cb --rpc-url $MONAD_MAINNET_RPC            # true
```

**Exit checks**
- [ ] `deployments/143.json` committed; `SwapAdapter.kind == "kuru"` (or `"none"` per A2)
- [ ] All contracts verified on monadvision.com
- [ ] Every smoke call returns the expected value
- [ ] Operator has ≥ 3 MON on mainnet

**Commit:** `deploy: monad mainnet (143) — verified, capped`

### ✅ Checkpoint **I4** — post in team chat

```
I4 READY — Monad mainnet
- deployments/143.json committed (Registry, Vault, KuruFlowAdapter, real USDC/AUSD/WMON/WETH)
- caps: 25 USDC / 25 AUSD per payment; refundDelay 3600s
- Kuru targets allow-listed: entrypoint 0xb3e6…13cb, router 0x0d3a…FFa2
- B: run `pnpm --filter @scanpay/api smoke:mainnet-readonly`, then follow your mainnet runbook (B-doc)
```

---

### Phase A24 — Kuru quote script + mainnet fork smoke test

**Goal:** prove a real Kuru Flow quote executes through **our deployed adapter** before B spends real money.
**Time:** 45 min. **Depends on:** A23.

**File: `contracts/scripts/kuru-quote.ts`**

```ts
// Usage: tsx scripts/kuru-quote.ts <tokenIn> <tokenOut> <amountInBaseUnits> [slippageBps=50]
// Prints swapData = abi.encode(address target, bytes callData) for our KuruFlowAdapter (userAddress = adapter).
import { encodeAbiParameters, getAddress, type Hex } from 'viem';
import { getDeployment } from '@scanpay/shared';

const [tokenIn, tokenOut, amount, slippage = '50'] = process.argv.slice(2);
if (!tokenIn || !tokenOut || !amount) throw new Error('usage: kuru-quote.ts <tokenIn> <tokenOut> <amount> [slippageBps]');
const d = getDeployment(143);
const adapter = d.contracts.SwapAdapter.address;
const api = d.external.kuruFlowApi ?? 'https://ws.kuru.io';

const tokRes = await fetch(`${api}/api/generate-token`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ user_address: adapter }),
});
if (!tokRes.ok) throw new Error(`generate-token ${tokRes.status} ${await tokRes.text()}`);
const { token } = (await tokRes.json()) as { token: string };

await new Promise((r) => setTimeout(r, 1100)); // 1 RPS per token

const qRes = await fetch(`${api}/api/quote`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({
    userAddress: adapter,
    tokenIn: getAddress(tokenIn),
    tokenOut: getAddress(tokenOut),
    amount,
    slippageTolerance: Number(slippage),
  }),
});
if (!qRes.ok) throw new Error(`quote ${qRes.status} ${await qRes.text()}`);
const q = (await qRes.json()) as {
  status: string; output: string; minOut: string; transaction: { to: string; calldata: string; value: string };
};
const target = getAddress(q.transaction.to);
if (!d.external.kuruTargets.map((x) => x.toLowerCase()).includes(target.toLowerCase())) {
  throw new Error(`quote target ${target} not allow-listed`);
}
if (q.transaction.value && BigInt(q.transaction.value) !== 0n) throw new Error('native value quotes not supported');
const callData = (q.transaction.calldata.startsWith('0x') ? q.transaction.calldata : `0x${q.transaction.calldata}`) as Hex;
const swapData = encodeAbiParameters([{ type: 'address' }, { type: 'bytes' }], [target, callData]);
console.log(JSON.stringify({ output: q.output, minOut: q.minOut, target, swapData }, null, 2));
```

**File: `contracts/test/fork/KuruFork.t.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {KuruFlowAdapter} from "../../src/adapters/KuruFlowAdapter.sol";

/// Run:  KURU_SWAPDATA=0x… KURU_AMOUNT_IN=… KURU_MIN_OUT=… forge test --match-contract KuruForkTest \
///       --fork-url $MONAD_MAINNET_RPC -vv
/// The quote must have been generated seconds ago (prices move). Skips when env is missing.
contract KuruForkTest is Test {
    address constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address constant AUSD = 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a;

    function test_fork_kuru_usdcToAusd() public {
        bytes memory swapData = vm.envOr("KURU_SWAPDATA", bytes(""));
        if (swapData.length == 0 || block.chainid != 143) {
            console2.log("skipped: set KURU_SWAPDATA and --fork-url mainnet");
            return;
        }
        uint256 amountIn = vm.envUint("KURU_AMOUNT_IN");
        uint256 minOut = vm.envUint("KURU_MIN_OUT");
        string memory dep = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/143.json"));
        KuruFlowAdapter adapter = KuruFlowAdapter(vm.parseJsonAddress(dep, ".contracts.SwapAdapter.address"));
        address vault = adapter.vault();

        deal(USDC, address(adapter), amountIn); // "vault already transferred amountIn"
        address refundTo = makeAddr("refundTo");
        uint256 before = IERC20(AUSD).balanceOf(vault);
        vm.prank(vault);
        uint256 out = adapter.swap(USDC, AUSD, amountIn, minOut, swapData, vault, refundTo);
        assertGe(out, minOut);
        assertEq(IERC20(AUSD).balanceOf(vault) - before, out);
        (address target,) = abi.decode(swapData, (address, bytes));
        assertEq(IERC20(USDC).allowance(address(adapter), target), 0, "approval reset");
        assertEq(IERC20(AUSD).balanceOf(address(adapter)), 0, "adapter keeps nothing");
        console2.log("kuru out", out);
    }
}
```

**Commands**

```bash
cd contracts
Q=$(pnpm -s kuru:quote 0x754704Bc059F8C67012fEd69BC8A327a5aafb603 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a 1000000 50)
echo "$Q"
KURU_SWAPDATA=$(echo "$Q" | jq -r .swapData) KURU_AMOUNT_IN=1000000 KURU_MIN_OUT=$(echo "$Q" | jq -r .minOut) \
  forge test --match-contract KuruForkTest --fork-url $MONAD_MAINNET_RPC -vv
```

If `deal` fails on USDC (proxy storage layout), replace it with a whale transfer:
`vm.prank(<any USDC holder from monadscan>); IERC20(USDC).transfer(address(adapter), amountIn);`

If the swap reverts with an allowance error, Kuru pulls tokens through a different spender than `transaction.to`:
read the revert trace (`-vvvv`), find the `transferFrom` caller, and set it once on mainnet:
`cast send <adapter> "setApprovalSpender(address)" <spender> --account $DEPLOYER_ACCOUNT --rpc-url $MONAD_MAINNET_RPC`.

**Exit checks**
- [ ] Fork test passes with a fresh quote for USDC→AUSD 1.00
- [ ] Same for WMON→USDC (`kuru:quote <WMON> <USDC> 50000000000000000000`)
- [ ] Output pasted into `docs/txt/evidence/kuru-fork.txt`

**Commit:** `test(fork): kuru flow quote executes through deployed adapter`

---

### Phase A25 — Envio: add mainnet

**Goal:** one indexer serving 10143 + 143. **Time:** 20 min. **Depends on:** A23, A22.

```bash
INDEX_CHAINS=10143,143 pnpm indexer:config
cd indexer && pnpm codegen && pnpm dev     # local sanity: both chains sync, Ctrl+C
cd ..
git add indexer/config.yaml && git commit -m "feat(indexer): index monad mainnet + testnet"
git push origin main && git push origin main:envio
```

**Exit checks**
- [ ] Cloud shows both chains synced
- [ ] `ProtocolStat(where:{id:{_eq:"143"}})` returns a row after B's first mainnet payment

**Commit:** (in the commands above)

---

### Phase A26 — README evidence sections (judged)

**Goal:** fill the README sections judges read for "Monad Integration" and "Technical Excellence". **Time:** 60 min.
**Depends on:** A23–A25 (B and FE add their sections by PR).

Replace the placeholder sections from A1 with:

````markdown
## Deployments

| Contract | Monad testnet (10143) | Monad mainnet (143) |
|---|---|---|
| MerchantRegistry | [`0x…`](https://testnet.monadscan.com/address/0x…) | [`0x…`](https://monadscan.com/address/0x…) |
| IntentVault | [`0x…`](…) | [`0x…`](…) |
| DepositForwarder (impl) | [`0x…`](…) | [`0x…`](…) |
| Swap adapter | MockSwapAdapter [`0x…`](…) | KuruFlowAdapter [`0x…`](…) |
| Tokens | tUSDC / tAUSD / tMON (mocks with EIP-3009) | USDC `0x7547…b603`, AUSD `0x0000…012a` |

All contracts verified on MonadVision (Sourcify). Machine-readable: [`deployments/`](deployments/).
Indexer: Envio HyperIndex on Monad testnet + mainnet — GraphQL `<ENVIO URL>`.

### Proof transactions
| What | Network | Tx |
|---|---|---|
| Merchant registered (owner + payout dual signature) | testnet | `0x…` |
| DIRECT payment (EIP-3009, gasless) | testnet | `0x…` |
| SWAP payment (tMON → tUSDC) | testnet | `0x…` |
| Attack Lab: replay blocked (reverted `NonceAlreadyUsed`) | testnet | `0x…` |
| Cross-chain payment via Aurora Intents: commit → settle | mainnet | `0x…` / `0x…` |
| USDC → AUSD via Kuru inside settlement | mainnet | `0x…` |

## Why Monad
- **Sub-second finality (~400 ms blocks, 2-block finality)** — a QR payment confirms while the customer is still at
  the counter; the merchant terminal flips to "Paid ✓" from the on-chain event, not from a server claim.
- **Cheap execution** — the three proofs run fully on-chain per payment (2 EIP-712 checks, registry lookup,
  one-time nonce + invoice state, fee split) for a fraction of a cent, so we never cut security for cost.
- **EVM-equivalent** — OpenZeppelin, EIP-712, EIP-3009, CREATE2 clones and Foundry work unchanged
  (`network = "monad"` in Foundry ≥ 1.8).
- **Native stablecoins** — Circle USDC and Agora AUSD live on Monad; merchants are paid in either.
- **Ecosystem** — Kuru Flow for on-chain swaps, Aurora Intents for any-chain deposits, Envio HyperSync for indexing,
  Mera for passkey accounts.
- Monad specifics we handled: gas is charged on the **gas limit** (our relayer sets `estimate × 1.2`), 1-second
  `TIMESTAMP` granularity (expiries are minutes, never seconds).

## Trust model
| Claim | Enforced by | Trust needed |
|---|---|---|
| The merchant is who the QR says | `MerchantRegistry`: owner + payout-wallet signatures, verifier approval, `keyVersion` | Verifier (our operator) approves merchants — a real product would do KYB here |
| The amount/token/merchant are what the customer approved | `IntentVault._verify`: merchant-signed invoice + payer-signed intent, nonce, expiry | None (signatures) |
| Money only reaches the merchant's registered wallet, exactly once | `IntentVault._settle` + one-time nonce/invoice state | None |
| Cross-chain deposit arrived | Vault reads the per-intent forwarder balance | None — a provider "SUCCESS" cannot settle anything |
| Which source-chain tx funded it | `attestSource` by the operator (`ATTESTER_ROLE`) | Operator attestation (displayed as such) |
| Customer can always get cross-chain funds back | `refundCrossChain` / `rescue`, permissionless, work even when paused | None |
| Gasless UX | Relayer (operator) submits txs | Relayer can censor (not steal); anyone can submit the same signed payload |
| Admin powers | fee ≤ 1%, swap adapter, caps, pause | Admin can pause new payments and change the adapter; cannot move user funds |

## Security testing
`forge test` — <N> tests: unit, attack suite mirroring the Attack Lab (tamper amount/destination, replay, expired,
unregistered QR, fake provider success, forged settlement hash, wrong token, cross-merchant signature, reentrancy),
fuzz (any-field tamper, fee split, deposits) and invariants (vault never holds funds; conservation).
Golden EIP-712 vectors prove Solidity and TypeScript produce byte-identical digests.

## AI tools disclosure (Rules §4.1.4)
We used AI assistants (Claude) for: research summaries of sponsor docs, drafting build documents, boilerplate code,
and test scaffolding. All contract logic, security properties and integration decisions were reviewed, tested and
are owned by the team. <!-- each member: add the tools you used -->
````

**Exit checks**
- [ ] Every `0x…` replaced with a real, clickable address/tx
- [ ] Test count in "Security testing" matches `forge test` output
- [ ] B and FE notified to add API/frontend sections

**Commit:** `docs(readme): deployments, proof txs, why Monad, trust model, AI disclosure`

---

### Phase A27 — Freeze (Mon 22:00 IST)

**Goal:** stop changing the chain layer; tag a release judges can reproduce. **Time:** 30 min.

**Commands**

```bash
cd contracts && forge fmt --check && forge build && forge test && cd ..
pnpm shared:test
git tag -a v1.0.0-chain -m "ScanPay Guard chain layer — submission freeze"
git push origin v1.0.0-chain
```

**Rules after freeze**
- No contract redeploys. Config changes (caps, adapter, pause) only via `cast send` with a team-chat note.
- Bug in a contract after freeze → document it in README "Known limitations" instead of redeploying.
- You now help B with the mainnet cross-chain proof and FE with integration + video takes.

**Exit checks**
- [ ] Tag pushed; GitHub release notes link the README sections
- [ ] `git status` clean

---

## Part IV — Threat model → test mapping

| # | Threat | Mitigation | Test(s) |
|---|---|---|---|
| T1 | Relayer/QR changes amount | invoice + intent signed; `amountOut == invoice.amount` | `test_direct_revert_tamperedAmount*`, `test_attack_tamper_amount`, `testFuzz_tamperAnyIntentField` |
| T2 | Funds redirected to attacker | payout wallet from registry snapshot; intent has no destination field | `test_direct_maliciousRelayerCannotRedirect`, `test_attack_tamper_destination` |
| T3 | Replay of a payment | `usedNonce[payer][nonce]`; 3009 nonce = intent digest | `test_direct_revert_replaySameIntent`, `test_attack_replay`, `test_receiveWithAuthorization_revert_replay` |
| T4 | Invoice paid twice | `invoiceState` OPEN→RESERVED→PAID | `test_direct_revert_invoicePaidTwice`, `test_commit_revert_secondPayerWhileReserved` |
| T5 | Fake merchant QR | registry `status == ACTIVE` required | `test_direct_revert_unregisteredMerchant`, `test_attack_unregistered_qr` |
| T6 | Leaked invoice key | rotation bumps `keyVersion`; old invoices fail | `test_direct_revert_keyRotatedInvalidatesOldInvoice`, `test_direct_afterRotation_newKeyWorks_oldKeyFails` |
| T7 | Registering someone else's wallet as payout | payout wallet must co-sign | `test_register_revert_payoutSigMissing`, `test_updatePayout_requiresNewWalletSig` |
| T8 | Stale QR | `invoice.expiresAt`, `intent.expiresAt` | `test_direct_revert_invoiceExpired`, `test_direct_revert_intentExpired`, `test_attack_expired` |
| T9 | "Provider says paid" | settle only from forwarder balance | `test_settle_revert_noFunds_fakeProviderSuccess`, `test_attack_fake_provider_success` |
| T10 | Forged settlement proof | only vault events; attest role-gated, never settles | `test_attack_forged_settlement_hash`, `test_attest_onlyAttester_once_noStatusChange` |
| T11 | Underpaid cross-chain deposit | `Underpaid` revert; funds stay; top-up or refund | `test_settle_revert_underpaid_thenTopUpWorks`, `testFuzz_crossChain_underDepositAlwaysReverts` |
| T12 | Funds stuck in forwarder | permissionless refund after delay; rescue for late deposits; both work while paused | `test_refund_*`, `test_rescue_*` |
| T13 | Approved allowance abused | pull only with payer's signature | `test_swap_revert_allowanceUnusableWithoutPayerSig` |
| T14 | Bad swap execution | adapter min-out + vault balance-delta check | `test_swap_revert_shortChangingAdapterCaught`, `test_swap_revert_maxInTooLow` |
| T15 | Arbitrary call via adapter | target allowlist, only vault may call | `test_swap_revert_targetNotAllowed`, `test_swap_revert_onlyVault` |
| T16 | Reentrancy | `nonReentrant` on every state-changing entry | `test_attack_reentrancy` |
| T17 | Vault accumulates funds | in-tx settlement only | `invariant_vaultNeverHoldsFunds` |
| T18 | Fee abuse | `MAX_FEE_BPS = 100` | `test_setFee_revert_aboveMax`, `testFuzz_direct_anyAmount_feeSplitExact` |
| T19 | Mainnet blast radius | per-token `amountCap`, pause | `test_direct_revert_aboveCap`, `test_direct_revert_paused` |
| T20 | Payer signature reused for another merchant | merchantId inside signed intent | `test_attack_cross_merchant_signature` |
| T21 | Invoice griefing (reserve without paying) | reservation ends at `expiresAt + refundDelay`, then reopens | `test_refund_thenInvoicePayableAgain` |
| T22 | Front-running a 3009 authorization | `receiveWithAuthorization` requires `msg.sender == to` | `test_receiveWithAuthorization_revert_callerNotPayee` |

**Known limitations (state them in the README):** merchant verification is operator-approved (no KYB); source-chain
attribution is attested; the relayer can censor (not steal); `refundDelay` is read at refund time (admin could lengthen
it — capped by our own runbook); mainnet amounts capped at 25.

---

## Part V — Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `forge build`: `unknown key "network"` | Foundry < 1.8 | `foundryup` |
| `Stack too deep` | via-IR off | `via_ir = true` in `foundry.toml` |
| `metadata_hash` unknown | old key name | use `bytecode_hash = "none"` |
| Golden test digest mismatch | struct field order differs from type string | re-copy ICD §0.7.1; never reorder |
| `InvalidMerchantSignature` in seed/B but tests pass | wrong `chainId` or vault address in domain | sign with `getDeployment(chainId).contracts.IntentVault.address` and the live chainId |
| `KeyVersionMismatch` | invoice built before a rotation/payout update | B re-reads `getMerchant` before issuing invoices |
| DIRECT reverts inside token on mainnet | wrong `eip712.name/version` for USDC/AUSD | redo A2 calls; fix `143.json`; `pnpm deployments:build 143` (no redeploy needed — it's off-chain config) |
| `AuthorizationExpired` | `validBefore` must be > now; equal fails | intent `expiresAt` ≥ 60 s in the future |
| Deploy: `AccessControlUnauthorizedAccount` during setup | broadcaster ≠ `ADMIN_ADDRESS` | `--sender $ADMIN_ADDRESS` matching the keystore |
| Deploy: out of gas / stuck | Monad charges the limit; low balance | fund deployer; `--slow` |
| `vm.keyExistsJson` not found | old forge-std | `forge update foundry-rs/forge-std` or use `vm.keyExists` |
| Sourcify verify fails | metadata mismatch | `metadata=true`, `metadata_hash="none"`, `use_literal_content=true`; re-verify with same compiler settings |
| `deployments/31337.json` changes every run | anvil not fresh / extra txs before deploy | restart anvil; deploy first |
| Envio `codegen` fails on event signature | ABI changed after `gen-config` | `pnpm abis:export && pnpm indexer:config` |
| Envio: "HyperSync token required" | missing `ENVIO_API_TOKEN` | `indexer/.env` locally; Cloud env var |
| Envio: chain 10143 not supported by HyperSync | testnet HyperSync unavailable that day | in `gen-config.ts` add `rpc_config: { url: MONAD_TESTNET_RPC }` for 10143 (same as the 31337 branch) |
| Envio entity fields `null` vs `undefined` type errors | version difference | follow `indexer/generated/` types |
| Kuru quote 429 | 1 RPS limit | wait 1.1 s between calls; one token per adapter |
| Kuru fork: allowance error | spender ≠ target | `setApprovalSpender` (A24) |
| `settleCrossChain` → `Underpaid` with funds visible on explorer | funds sent to wrong address (e.g. vault) | compare with `forwarderOf(intentId)`; vault-sent funds are lost to the vault → B must only ever give Aurora the forwarder address |

---

## Part VI — Final checklist (Backend A)

**Contracts**
- [ ] `forge test` → 0 failed; count recorded in README
- [ ] Coverage: Registry ≥ 95% lines, Vault ≥ 95% lines
- [ ] Golden vectors pass in Solidity and TS
- [ ] No `console.log` / `console2` imports in `src/`

**Deployments**
- [ ] `deployments/10143.json` and `deployments/143.json` committed, generated (not hand-edited)
- [ ] All contracts verified on MonadVision (testnet + mainnet)
- [ ] Operator roles: VERIFIER, ATTESTER (both nets), MINTER (testnet mocks)
- [ ] Mainnet caps set; refund delay 3600

**Indexer**
- [ ] Envio Cloud synced on 10143 + 143; URL in `docs/endpoints.md`
- [ ] Q1–Q6 work against Cloud

**Handoffs**
- [ ] I0 ✅  I1 ✅  I2 ✅  I3 ✅  I4 ✅ posted in team chat

**Submission**
- [ ] README: deployments, proof txs, why Monad, trust model, security testing, AI disclosure
- [ ] LICENSE (MIT) at root; repo public
- [ ] Commits spread across the build window (one per phase)
- [ ] Tag `v1.0.0-chain`
