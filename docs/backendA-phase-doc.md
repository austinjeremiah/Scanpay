# Backend A — Phase Log

Running record of the chain layer build. One entry per phase, written after the phase is committed.
Source of truth for the spec: `docs/ScanPay-Guard-Backend-A-Chain.md`.

**Legend:** ✅ done · 🔜 next · ⏸ blocked

---

## Status

| Phase | Title | Status | Commit |
|---|---|---|---|
| A0 | Machine setup and keys | ✅ | — (no code) |
| A1 | Monorepo skeleton | ✅ | `a16861a` |
| — | Restructure into `backend/` | ✅ | `49458ed` |
| A2 | On-chain address verification | ✅ | `b8c1bf1` |
| A3 | Foundry project | ✅ | `9d5d8b3` |
| A4 | ScanPayTypes.sol | ✅ | `260b7ed` |
| A5 | Interfaces | ✅ | `e8d4002` |
| A6 | `@scanpay/shared` package | ✅ | `5de4058` |
| A7 | Golden vectors → **I0** | ✅ | `16fd7ee` |
| **I0** | **Checkpoint — handoff to B + FE** | ✅ **REACHED** | |
| A8 | MerchantRegistry | ✅ | `c7ebc36` |
| A9 | Mock tokens + MockSwapAdapter | ✅ | `cf25271` |
| A10 | Registry + mock token tests | ✅ | `93c37f4` |
| A11 | DepositForwarder | ✅ | `63bcb6a` |
| A12 | **IntentVault** (core) | ✅ | `b45c335` |
| A13 | Vault fixture + DIRECT tests | ✅ | `72e1bb3` |
| A14 | KuruFlowAdapter + SWAP tests | 🔜 | |

**Checkpoints:** **I0 ✅ reached** · I1 (A18) · I2 (A19) · I3 (A22) · I4 (A23)

---

## What is still needed from the outside

| Needed | For | Status |
|---|---|---|
| `OPERATOR_ADDRESS` from Backend B | A19 testnet deploy | ⏸ not received |
| B to add 2 rows to ICD §0.8 (see A5) | I0 handoff | ⏸ raise at I0 |
| Faucet real testnet USDC into operator wallet | A19 demo funding | ⏸ faucet.circle.com, 10/24h |
| Deployer keystore (`cast wallet import scanpay-deployer`) | A19 | ⏸ not created |
| Funded testnet MON | A19 | ⏸ |
| `ENVIO_API_TOKEN` | A22 | ⏸ |
| ~3 real MON on mainnet | A23 deploy gas | ⏸ |
| ~$1 real USDC on mainnet (demo wallet) | A23 demo | ⏸ swap from MON via Kuru |
| ~$1 real **Agora AUSD** on mainnet (demo wallet) | A23 demo | ⏸ swap from MON via Kuru |

Nothing is needed before A19.

---

## A0 — Machine setup

Tool versions in use:

| Tool | Version | Note |
|---|---|---|
| forge / cast / anvil | **1.8.5** | `foundryup` alone installed a stale 1.5.1; needed `foundryup --install v1.8.5` |
| node | 24.13.1 | doc says 22.x; `engines` is `>=22` so fine |
| pnpm | 9.12.0 | pinned via `packageManager`, corepack fetches it |
| docker | 29.2.1 | only needed at A22 |

---

## A1 — Monorepo skeleton · `a16861a`

Root workspace: `package.json`, `pnpm-workspace.yaml`, `LICENSE` (MIT), `.env.example` (all 24 ICD §0.11 vars), `README.md` skeleton, `.gitignore`.

**Verified:** `pnpm install` passes · corepack honours the 9.12.0 pin · `.env` is refused by git while `.env.example` is tracked (tested with a real throwaway `.env`).

### Restructure · `49458ed`
All backend code moved under `backend/`; `frontend/` became a sibling (later deleted by Austin). Root stays the pnpm workspace root so `LICENSE`/`README.md` remain at repo root where judges and GitHub expect them.

Consequence for every later phase: doc commands that say `cd contracts` mean `cd backend/contracts`. `fs_permissions` paths (`../deployments`, `../packages/shared/...`) still resolve correctly.

---

## A2 — On-chain address verification · `b8c1bf1`

Ran `backend/contracts/script/VerifyAddresses.sh` against live Monad mainnet + testnet. Full output: `docs/address-verification-20261011.txt`.

**Finding 1 — AUSD supports EIP-3009.** The doc assumed it might not ("AUSD stays payout-only"). It returns the exact standard typehash `0xd099cc98…`, so AUSD is a first-class *payment* token on the DIRECT route. Strengthens the Agora bounty.

**Finding 2 — the trap.** AUSD's EIP-712 domain name is **`"Agora Dollar"`**, not `"AUSD"`. Its `name()` returns `"AUSD"`, so the obvious copy would have made every AUSD DIRECT payment revert inside the token.

Because that value is unforgiving, both domain separators were **reconstructed** from typehash + name + version + chainId + address and compared to the on-chain `DOMAIN_SEPARATOR()`:

| Token | eip712 name | version | separator | verified |
|---|---|---|---|---|
| USDC | `USDC` | `2` | `0xfe22123e…93c6` | ✅ |
| AUSD | `Agora Dollar` | `1` | `0x99506344…cafe` | ✅ |

**Other results:** Kuru Flow entrypoint + router both have code → mainnet SWAP enabled, adapter gets deployed. WMON, WETH, Permit2 all present. Testnet external tokens live but unused (we deploy our own mocks).

All six config decisions for `config/143.json` (A18) are recorded at the bottom of the verification file.

**Deviation:** the doc's script had a `cast call` for `authorizationState` with no arguments (always errors) followed by a duplicate unlabelled call. Replaced with one labelled call.

---

## A3 — Foundry project · `9d5d8b3`

Foundry project at `backend/contracts`: OZ **v5.1.0** (`69c8def5`) + forge-std **1.17.0**, `remappings.txt`, `package.json` (`@scanpay/contracts`), scaffold dirs.

**Exit checks:** ✅ `forge build` · ✅ `network = "monad"`

**Deviations — three, all doc errors:**
1. `metadata = true` is **not a real Foundry key** (warns `unknown config`). Correct key is `cbor_metadata`. Also added `extra_output = ["metadata"]` since A19 needs Sourcify verification. Config is now warning-free.
2. `metadata_hash` → `bytecode_hash = "none"` (the doc's own troubleshooting predicted this).
3. **Submodule inconsistency.** `forge init --no-git` vendored forge-std as plain files but `forge install` made OZ a **git submodule** — a judge cloning without `--recursive` would get a failed build. Converted OZ to vendored files so `git clone && forge build` works unaided. `foundry.lock` still records the pin.

**Verified beyond the doc:** an empty build proves nothing, so a throwaway contract importing every OZ v5 module the real contracts need (`AccessControl`, `SignatureChecker`, `EIP712`, `Clones` incl. `predictDeterministicAddress`, `SafeERC20`, `ReentrancyGuard`, `Pausable`) was compiled under via-IR, and the artifact inspected to confirm `viaIR: true`, `bytecodeHash: none`, `useLiteralContent: true`, solc `0.8.28`. Then deleted.

Commit is large (789 files) — one-time cost of vendoring the libs.

---

## A4 — ScanPayTypes.sol · `260b7ed`

`src/libraries/ScanPayTypes.sol`: 15 enum constants, 8 structs, 5 typehashes, 7 functions (185 lines).

**Exit checks:** ✅ compiles · ✅ 12 `keccak256(` (needed ≥ 7)

**Method:** extracted the block programmatically from the ICD rather than retyping — a single transposed field would produce valid-looking signatures that every verifier rejects, and compilation would not catch it.

**Verified:** field order lives in three places that must agree, all checked independently —

| Check | Result |
|---|---|
| typehash string vs struct declaration | ✅ 5/5 |
| `abi.encode(...)` arg order vs struct | ✅ 5/5 |
| Solidity vs ICD §0.5 (independent doc section) | ✅ 5/5 |

ID derivations match ICD §0.6 exactly.

Canonical typehashes (reference for A6/A7):

```
Invoice         0xd63d6529b50f53e4ca6b35e58f257db7c7210264696b66ca427d596e7d31bd42
PaymentIntent   0x460d2498b979834478bea201c4b789b0523751e49ecb0fb89556975dece780c5
Registration    0xbc667a2238a350806a7f0f03829e5174a8759f10a54ae8c8e3ecba003ad4c96c
SignerRotation  0xad8a50ee56b8550178717903d6893f3c16b9040e4ba6020afdb7f7ad9e96c3da
PayoutUpdate    0x3c77f64467e5c911ce3e1766c949012c39b72bca3be26d7e43d0f8801909f501
```

No deviations — ICD §0.7.1 was correct.

---

## A5 — Interfaces · `e8d4002`

Six interface files in `src/interfaces/`, extracted programmatically from ICD §0.7.2–§0.7.4:

| File | Lines |
|---|---|
| `IMerchantRegistry.sol` | 47 |
| `IIntentVault.sol` | 130 |
| `ISwapAdapter.sol` | 24 |
| `IERC3009.sol` | 18 |
| `IMockStableToken.sol` | 11 |
| `IMockSwapAdapter.sol` | 10 |

**Exit checks — all four exact:** ✅ compiles · ✅ 11 events · ✅ 25 errors · ✅ 31 functions on `IIntentVault`.

Hitting all three ABI counts exactly is meaningful: it says the ICD's vault surface is internally complete and the extraction was faithful. Registry ABI: 5 events, 10 errors, 12 functions.

### Finding — two errors are unmapped in ICD §0.8 (for I0)

The ABIs declare **33** distinct errors; ICD §0.8 maps **31**. Unmapped:

| Error | Thrown by | Reachable by B? |
|---|---|---|
| `ZeroAddress()` | `IIntentVault`, `IMerchantRegistry` | **yes** — B relays `registerMerchant`; a zero payout wallet hits it |
| `InvalidFee(uint16)` | `IIntentVault` | no — `setFee` is CONFIG_ROLE, owned by A |

**Impact is low**, because §0.8 ends with `anything else → CHAIN_REVERT 502`. So nothing breaks; a merchant who registers a zero address just gets a generic 502 instead of a clear 422.

**Not fixed unilaterally.** §0.8 is B-owned (`packages/shared/src/errors.ts`) and the ICD requires any change to be made in *both* docs with an `ICD_VERSION` bump plus a team-chat note. Raise at I0: suggest `ZeroAddress → ZERO_ADDRESS (422)` and `InvalidFee → INVALID_FEE (422)`.

No deviations — ICD §0.7.2–§0.7.4 were correct.

---

## A6 — `@scanpay/shared` · `5de4058`

11 files extracted programmatically from the doc: `package.json`, `tsconfig.json`, `constants.ts`, `types.ts`, `eip712.ts` (201 lines), `ids.ts`, `wire.ts`, `generated/deployments.ts` (placeholder, A18 overwrites), `generated/abis.ts` (3130 lines, generated), `index.ts`, `scripts/print-deployment.ts`, plus `contracts/scripts/export-abis.ts`.

`pnpm install` links 3 workspace projects. `export-abis.ts` relative paths (`../out`, `../../packages/shared/...`) resolve correctly from `backend/contracts/scripts` — the restructure holds.

**Exit checks:** ✅ `abis.ts` contains `intentVaultAbi` · ✅ `typecheck` passes · ✅ 18 events (needed ≥ 16). All 7 ABIs exported.

### Verification beyond the doc

**TS type definitions == Solidity typehashes.** Computed the typehash from each viem type object and compared against the canonical `cast keccak` values from A4 — **6/6 byte-identical**. This is the core risk A7 exists to catch, so it is now de-risked a phase early.

Worth noting: `ReceiveWithAuthorization` resolves to `0xd099cc98…`, the same value **mainnet USDC and AUSD returned live in A2**. Three independent sources agree — the TS constant, the Solidity typehash, and the real tokens.

**ID helpers == Solidity.** `computeMerchantId` and `computeIntentId` compared against `cast keccak` of the same `abi.encode`:

```
merchantId  0x9a7fd51e3516636ce56cd86ca26b3582921bd8701844d7bce1514d799576abd2   (TS == SOL)
intentId    0x9f27f3e7a9b29bd9062e88c6aa3d6251792a4817f5efe0d62d222a830d86a45e   (TS == SOL)
```

**Wire lowercasing is safe.** `toWireIntent` lowercases addresses, so a round-trip is not string-equal to checksummed input. The doc asserts this is harmless because EIP-712 encodes addresses as 20 bytes. Verified rather than assumed: the same intent signed with checksummed vs lowercase addresses produces digest `0x3e96bdeb…bfb7` **both times**.

**Full ICD §0.10 surface present.** Checked all 47 promised exports resolve through `src/index.ts` — none missing (66 exports total).

### Deviation

`out/IERC20.sol/IERC20.json` did not exist, because nothing in our source imported OZ's `IERC20` — the doc predicted this and sanctions adding the import to `IMockStableToken.sol`. Done. Confirmed `IMockStableToken`'s own ABI is **unchanged** before and after (`authorizationState, balanceOf, decimals, mint, receiveWithAuthorization`), so the verbatim ICD extraction from A5 stays sound.

---

## A7 — Golden vectors · `16fd7ee` → **CHECKPOINT I0**

`contracts/test/GoldenVectors.t.sol` (123 lines) generates `packages/shared/test-vectors/eip712.json`; `packages/shared/test/golden.test.ts` (101 lines) re-derives everything in TypeScript and asserts equality.

**Exit checks:** ✅ fixture exists and is committed · ✅ `pnpm shared:test` → **5 passed** · ✅ keys are test-only constants

### What the 5 tests actually prove

They assert **signatures**, not merely digests — the full signing path agrees across languages, which is stronger than the doc's framing:

| # | Test | Asserts |
|---|---|---|
| 1 | merchantId | `computeMerchantId` == Solidity |
| 2 | invoice | struct hash + digest + **merchant signature** |
| 3 | intent | struct hash + digest + intentId + **payer signature** |
| 4 | registration | digest + **owner signature** |
| 5 | EIP-3009 | digest + signature + v/r/s split, nonce bound to intent digest |

Test 5 is the important one. It confirms in both languages that the authorization carries `nonce = intentDigest`, `to = vault`, `value = amountOut`, `validAfter = 0`, `validBefore = intent.expiresAt` — exactly ICD §0.5. That nonce binding is replay defense **T3**: the authorization is worthless for any other payment.

### Verification beyond the doc

**The fixture is deterministic.** Regenerated it and compared SHA-256 — byte-identical (`d5dc8aa5…`). A drifting fixture would cause mysterious failures in B's and FE's test suites later.

**Keys are safe to publish.** `payerKey=0xa11ce`, `ownerKey=0xc0ffee`, `merchantSignerKey=0xb0b` — tiny constants, verified numerically rather than by eyeballing.

**I0 acceptance run from a clean install.** Deleted all `node_modules`, ran `pnpm install && pnpm shared:test` — the exact command B and FE will run. 5 passed.

No deviations.

### I0 handoff message (for team chat)

```
I0 READY (ICD v1)
- contracts/src/libraries/ScanPayTypes.sol + 6 interfaces committed
- @scanpay/shared: constants, types, eip712, ids, wire, generated ABIs, golden vectors
- verify: pnpm install && pnpm shared:test   -> 5 passed
- NOTE paths: repo is restructured, backend code lives under backend/
  (shared = backend/packages/shared, contracts = backend/contracts)
- NOTE for B: ICD §0.8 is missing 2 error mappings that exist in the ABIs:
  ZeroAddress (reachable via registerMerchant) and InvalidFee (admin-only).
  Suggest ZERO_ADDRESS (422) and INVALID_FEE (422). Needs ICD_VERSION bump if adopted.
- NOTE for B+FE: AUSD mainnet DOES support EIP-3009, and its EIP-712 domain
  name is "Agora Dollar", NOT "AUSD". Use deployments.tokens.AUSD.eip712.
B: you can now write against intentVaultAbi / merchantRegistryAbi. Local chain (I1) next.
```

---

## A8 — MerchantRegistry · `c7ebc36`

`src/MerchantRegistry.sol`, 170 lines. First real contract. Roles: `DEFAULT_ADMIN_ROLE`, `CONFIG_ROLE` (payout-token allowlist), `VERIFIER_ROLE` (status).

**Exit checks:** ✅ no shadowing/unreachable warnings · ✅ 7,388 B runtime (limit 128 KB) · ✅ 22 functions (needed ≥ 12)

Side evidence: `forge build --sizes` reports a **runtime margin of 123,684 B**, i.e. 128 KB − 7,388. That confirms `network = "monad"` is genuinely applying Monad's 128 KB contract limit rather than Ethereum's 24 KB — the A3 config is live, not merely accepted.

### Cross-language check

A **deployed** registry's `hashRegistration()` was compared against TypeScript's `registrationDigest()` for the same Registration and the same contract address:

```
0x536a5b01609eccfeec2ea002c2cbc9ad87dec4e2359d56ea27a89f5f941e8a33   (both)
```

Its EIP-712 domain reads `name = "ScanPayRegistry"`, `version = "1"` — matching `REGISTRY_DOMAIN_NAME` / `DOMAIN_VERSION` in the shared constants. This goes beyond A7's golden vectors, which used a hardcoded placeholder address; here the verifying contract is a real deployment.

### Code review notes

Design rules confirmed present in the implementation:

- one nonce counter per **owner**, shared by Registration / SignerRotation / PayoutUpdate (`_useNonce` reverts `BadNonce(expected, provided)`)
- registration requires owner **and** payout-wallet signatures over the **same** digest — threat **T7**, nobody can name someone else's wallet as payout
- new merchants start `PENDING` with `keyVersion = 1`
- both rotation paths bump `keyVersion`, so old invoices die — threat **T6**
- `_live()` permits `SUSPENDED` merchants to rotate keys / fix payout, but blocks `REVOKED` (terminal, `_validTransition` returns false from `REVOKED`)
- `getMerchant` on an unknown id returns the zero struct rather than reverting
- authority comes only from signatures, never `msg.sender` — any relayer can submit

### forge lint warnings — reviewed, not silenced

Foundry 1.8 emits 8 **lint** warnings (not compiler warnings; the build succeeds). All reviewed and benign:

| Lint | Count | Assessment |
|---|---|---|
| `block-timestamp` | 3 | deadline comparisons. Monad has 1-second granularity and deadlines are minutes out; validator skew is irrelevant at this scale |
| `reentrancy-events` | 3 | events emitted after `SignatureChecker.isValidSignatureNow`, which makes an external call only for ERC-1271 contract signers |
| `unsafe-typecast` | 2 | `uint64(block.timestamp)` — overflows in the year ~584 billion |

The `reentrancy-events` case was traced properly. A malicious ERC-1271 owner contract could reenter `registerMerchant` during its own signature check. The reentrant call cannot forge another merchant: `merchantId = keccak(owner, salt)` binds to the owner, and `_useNonce` has already consumed the nonce. The worst outcome is a duplicate `MerchantRegistered` log for the attacker's **own** merchantId, with last-write-wins state. The A21 indexer is idempotent on merchantId, so it converges. Not worth contorting the code for.

Left verbatim rather than adding `forge-lint: disable` comments — the warnings are informational, and the exit check concerns shadowing/unreachable code, of which there are none.

No deviations.

---

## A9 — Mock tokens + MockSwapAdapter · `cf25271`

Three contracts: `mocks/MockStableToken.sol` (125 lines, tUSDC/tAUSD), `mocks/MockERC20.sol` (25, tMON 18-dec), `adapters/MockSwapAdapter.sol` (67).

**Exit checks:** ✅ compiles · ✅ all 4 required functions in the ABI · ✅ 3009 typehash == `0xd099cc98…13de8`

### Scope reminder (asked during this phase)

These exist on **local (31337) and testnet (10143) only**. Mainnet (143) uses the real Circle USDC and real Agora AUSD verified in A2 — we deploy no tokens there. They are labelled `isMock: true` in `deployments/10143.json`, carry `t`-prefixed symbols, and get stated in the README.

They exist because Circle's testnet USDC cannot be minted by us, so a freshly-created passkey wallet could never be funded — making the demo unrecordable. `MINTER_ROLE` on our own token solves that.

### Verified: the mock behaves like real USDC

The point of the mock is that it is **not** a stub — if it faked EIP-3009, the vault's DIRECT route tests would prove nothing. Smoke-tested the security-relevant behaviour (scratch test, removed afterwards; A10 writes the committed suite):

| Property | Result |
|---|---|
| domain separator reconstructs from `(name, "1", chainId, address)` | ✅ — same method used against live mainnet USDC in A2 |
| happy-path `receiveWithAuthorization` moves funds, marks nonce used | ✅ |
| replay of the same nonce reverts | ✅ **T3** |
| caller other than the payee reverts | ✅ **T22** (front-running protection) |
| expired `validBefore` reverts | ✅ |

### MockSwapAdapter review

- `onlyVault` guard present (`msg.sender != vault` → `OnlyVault`) — **T15**
- `quoteIn` rounds **up** (`(amountOut * 1e18 + rate - 1) / rate`) while `quoteOut` floors, so `quoteOut(quoteIn(x)) >= x` — the swap can never under-deliver to the merchant

No deviations.

---

## DECISION — testnet uses REAL Circle USDC (supersedes part of A9)

Raised by Austin: *"why don't we use the official testnet tokens?"* Re-investigated on-chain rather than trusting the doc. **The doc's premise was partly wrong, and so was my restatement of it.**

| Testnet token | Exists | EIP-3009 | Obtainable |
|---|---|---|---|
| Circle USDC `0x534b…43A3` | ✅ 9.2B supply | ✅ standard typehash | ✅ **faucet.circle.com, 10 / 24 h, no account** |
| Agora AUSD `0xa901…22dC` | ✅ 1.3B supply | ✅ standard typehash | ❌ no faucet, no mint path |

Corrections to the record:
- A9's note "there is no AUSD on testnet" (repeated from doc §A9) is **false** — it exists and works.
- "Circle's testnet USDC can't be minted by our faucet" is true (masterMinter `0x87f2…D437`, our allowance `0`) but **misleading**: Circle runs a public faucet that covers Monad testnet.

Both domain separators verified by reconstruction, as in A2:

| Token | eip712 name | version | separator | match |
|---|---|---|---|---|
| testnet USDC | `USDC` | `2` | `0xf1090f5a…a48d` | ✅ |
| testnet AUSD | `Agora Dollar` | `1` | `0x7ff7d6b4…3ea1` | ✅ |

Note testnet AUSD carries the **same `"Agora Dollar"` trap** as mainnet.

### Decision → drives `config/10143.json` in A18

| Chain | USDC | AUSD | MON |
|---|---|---|---|
| local 31337 | mock | mock | mock |
| **testnet 10143** | **REAL Circle `0x534b…43A3`** | mock `tAUSD` | mock `tMON` |
| mainnet 143 | REAL | REAL | — |

Testnet USDC entry: `isMock: false`, `eip712 {name:"USDC", version:"2"}`, `supports3009: true`, roles `[payout, direct, swapIn, crosschainIn]`.

**Funding model changes for A18/A19 and for Backend B:** the operator cannot mint USDC on testnet. Faucet 10 USDC / 24 h into the operator wallet; B's faucet endpoint **transfers** a small amount per demo wallet instead of minting. Minting still applies to `tAUSD` and `tMON`, where the operator holds `MINTER_ROLE`.

The mock contracts from A9 all stay — they are still used for AUSD, MON, and the whole of local 31337.

---

## DECISION — mainnet demo uses REAL Agora AUSD

Austin, 2026-10-11. The mainnet demo will include a **real Agora AUSD payment**, not just USDC.

Rationale: AUSD is the most differentiated part of the submission (Agora bounty, $10K). A real AUSD transfer on mainnet, visible on monadscan.com, is a materially stronger claim than a payment in a token we minted ourselves. A2 already proved mainnet AUSD supports EIP-3009, so the one-transaction zero-gas DIRECT route works for it.

**Budget (all mainnet, ~$5 total):** ~3 MON deploy gas (~$0.08) · ~$1 USDC demo wallet · ~$1 AUSD demo wallet · ~$2 buffer for re-shoots. Mainnet `amountCap` is 25 units, so small balances are sufficient.

**Acquisition:** buy MON, swap small amounts to USDC and AUSD on Kuru — the same aggregator integrated at A24. Doing so doubles as a live check that Kuru routes both tokens before the adapter depends on it.

**Timing: A23.** Nothing to buy before then.

### Resulting demo token story

| Shot | Chain | Token | Real |
|---|---|---|---|
| Hero payment | mainnet 143 | Circle USDC | ✅ |
| AUSD payment | mainnet 143 | Agora AUSD | ✅ |
| Repeatable flow | testnet 10143 | Circle USDC | ✅ |
| SWAP route input | testnet 10143 | `tMON` | mock |
| AUSD on testnet | testnet 10143 | `tAUSD` | mock |

Every stablecoin a judge sees moving is real. Only the swap *input* token is mocked, and only on testnet. README states that testnet AUSD is mocked because Agora operates no testnet faucet — verified in the addendum to `docs/address-verification-20261011.txt`.

---

## SWAP + CROSSCHAIN reality check (asked during A10)

Verified rather than trusted, since the doc had already been wrong twice.

**Kuru (SWAP):** both Flow addresses have code on mainnet and **no code on testnet**. The mock adapter is the only option on 10143, not a convenience.

| Address | mainnet 143 | testnet 10143 |
|---|---|---|
| Flow entrypoint `0xb3e6…13cb` | code (6,504) | **NO CODE** |
| Flow router `0x0d3a…FFa2` | code (12,764) | **NO CODE** |

**Aurora (CROSSCHAIN):** queried the live 1Click `/v0/tokens` API — **204 tokens across 37 chains, zero testnets**. So cross-chain cannot exist on 10143 at all; the route is kept there only so the "fake provider success" attack test can run.

Two findings worth carrying forward:

1. **The doc undersells cross-chain.** It names 6 source chains; the live API supports **37**, including `btc`, `sol`, `xrp`, `ton`, `sui`, `aptos`, `near`, `tron`, `cardano` alongside the EVM set. A customer can pay a Monad merchant **from Bitcoin or Solana**. Stronger Aurora-bounty claim — use it in the A26 README.
2. **Asset IDs confirmed live.** `USDC on Monad = nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx`, exactly as the doc states. Aurora also carries MON and USDT0 on Monad but **no AUSD** — confirming why the vault must swap arriving USDC into AUSD for AUSD merchants.

### Agreed strategy

- **testnet** = end-to-end testing and re-shootable footage (real Circle USDC + mocks for AUSD/MON/swap)
- **mainnet** = the demo of every capability for real: USDC, AUSD, Kuru swap, Aurora cross-chain

---

## A10 — Registry + mock token tests · `93c37f4`

`test/utils/RegistryBase.sol` (101 lines, shared fixture — A13's vault fixture extends it), `test/MerchantRegistry.t.sol` (285), `test/MockStableToken.t.sol` (91).

**Exit checks:** ✅ 26 registry tests (needed ≥ 24) · ✅ 7 mock-token tests (doc said 6) · ✅ `MerchantRegistry.sol` **100.00% lines (80/80)**, gate was ≥ 95%

**33 tests, 0 failed.** Coverage detail for the registry: 100% lines, 100% functions (16/16), 66.67% branches (16/24 — branches are not gated by the doc, which asks for lines only).

`MockStableToken.sol` reaches 90% lines; `MockSwapAdapter.sol` is 0% and gets covered in A14 with the SWAP-route tests.

### Deviation — `forge coverage` needs `--ir-minimum`

`forge coverage` disables the optimizer and via-IR for accurate reports, which makes `GoldenVectors.t.sol` fail to compile with **stack too deep**. The doc's exit-check command therefore does not work as written.

Fix: add `--ir-minimum` (Foundry's own suggested flag — enables via-IR at minimum optimization). Working command:

```bash
forge coverage --ir-minimum --match-contract 'MerchantRegistryTest|MockStableTokenTest' --report summary
```

This applies to every later coverage run, including the Part VI final checklist (Registry ≥ 95%, Vault ≥ 95%).

---

## A11 — DepositForwarder · `63bcb6a`

`src/DepositForwarder.sol` — 27 lines, the smallest contract in the project and one of the most important. `test/DepositForwarder.t.sol`, 4 tests.

**Exit checks:** ✅ 4 tests pass · ✅ `test_clone_predictableAndSweepable` proves deposit-before-deploy works

Full suite after this phase: **38 tests, 0 failed** across 4 suites.

### Why it exists

One EIP-1167 clone per cross-chain intent at `CREATE2(salt = intentId)`. That address is what Backend B hands Aurora as the `recipient`. Because each intent gets its own address, the vault proves *which* intent a deposit belongs to **by reading a balance** — no memo, no off-chain matching, and B cannot mis-attribute a deposit even if it tried.

### The property that matters

`test_clone_predictableAndSweepable` tests the real Aurora race rather than a simplification: it mints tokens to the **predicted address before any contract exists there**, then deploys the clone and sweeps. Aurora's solver can deliver before our commit transaction lands, and CREATE2 means the funds are already waiting at the right address when the clone appears.

### Design review

- `vault` is an `immutable` baked into the implementation's runtime bytecode. Clones `delegatecall` into that code, so **every clone reports the same vault** — the access check cannot be bypassed by deploying a rogue clone.
- `sweep` on a zero balance is a **no-op, not a revert** — needed for the rescue path, which must stay callable when nothing has arrived.
- Guard `msg.sender != vault → OnlyVault`, covered by `test_sweep_onlyVault`.

Related troubleshooting entry (ICD Part V): funds sent to the vault instead of the forwarder are lost to the vault, so **B must only ever use the address returned by `forwarderOf(intentId)`** — a contract call, not an off-chain computation.

No deviations.

### Process note — two self-inflicted issues this phase

1. **Over-broad `sed`.** Backfilling the commit hash with `sed s/PENDING/<hash>/g` also rewrote the literal word `PENDING` inside the A8 section ("new merchants start `PENDING`"), corrupting it. Repaired here. Future phases write the hash directly rather than substituting a common word.
2. **Failed push short-circuited an `&&` chain**, so the A11 log was never written while its commit still landed. Caught by verifying the doc after the fact.

### Note — frontend work landed on main

`sylesh7` pushed 158 files under `frontend/` (commits `dcad335`, `ef0100a`, `90e76a1`) while this phase was in progress. No overlap with `backend/` or `docs/`; rebased cleanly. The `frontend/` directory deleted earlier in the session is back, now owned by the frontend engineer.

---

## A12 — IntentVault · `b45c335`

`src/IntentVault.sol` — **439 lines**, the core contract. Proof of intent + proof of settlement.

**Exit checks:** ✅ compiles under via-IR, no stack-too-deep · ✅ **19,237 B** runtime (< 24 KB portable limit; 111,835 B margin against Monad's 128 KB) · ✅ 17 events (needed ≥ 11) · ✅ every `IIntentVault` function implemented — enforced by the compiler, since an unimplemented one would make the contract abstract

ABI: 17 events, 35 errors, 44 functions. Full suite still **38 passed, 0 failed** (vault tests arrive in A13–A15).

### `_verify` check order matches the spec exactly

The doc fixes a precise order because B's error mapping and the A13–A16 tests both depend on which error fires first. Verified line by line — all six groups in sequence:

| Group | Order in code |
|---|---|
| 1 shape | `RouteMismatch` → `InvoiceMismatch` → `PayoutTokenMismatch` → `AmountMismatch` → `ZeroAddress` |
| 2 time | `InvoiceExpired` → `IntentExpired` |
| 3 merchant | `MerchantNotActive` → `KeyVersionMismatch`(invoice) → `KeyVersionMismatch`(intent) → `PayoutTokenMismatch`(vs registry) → `PayoutTokenNotAllowed` → `AmountAboveCap` |
| 4 input | `InputTokenNotAllowed` → `InputTokenNotAllowed`(DIRECT needs input==payout) → `AmountMismatch`(maxAmountIn rule) |
| 5 sigs | `InvalidMerchantSignature` → `InvalidPayerSignature` |
| 6 one-time | `NonceAlreadyUsed` → `InvoiceNotOpen` → `IntentAlreadyExists` |

### Money movement review (`_settle`)

- Destination is `r.payoutWallet`, snapshotted from **the registry** at verify time (`payoutWallet = m.payoutWallet`, line 350) — never from the intent or the caller.
- **The entire contract contains exactly three `safeTransfer` destinations:** `r.payoutWallet` (registry snapshot), `feeRecipient` (admin config), `r.refundTo` (inside the payer-signed intent). **No caller-controlled destination exists anywhere** — threat **T2** holds structurally, not just by convention.
- Accounting balances exactly: `(amountOut − fee) + fee + excess == available`. The vault transfers out precisely what it took in, which is what makes the A17 "never holds funds" invariant (**T17**) provable.
- State is written **before** transfers (CEI), and `invoiceState` moves to `PAID` in the same step.
- Fee is floor division from `amountOut`, so the merchant receives `amountOut − fee`.

### Pause semantics — verified, not assumed

| Entry point | Modifiers |
|---|---|
| `payDirect` / `paySwap` / `commitCrossChain` / `settleCrossChain` | `whenNotPaused nonReentrant` |
| **`refundCrossChain`** / **`rescue`** | `nonReentrant` **only** |

Pausing halts new payments but **can never trap user funds** — threat **T12**. 6 `nonReentrant` guards total (**T16**).

No deviations.

---

## A13 — Vault fixture + DIRECT route tests · `72e1bb3`

`test/utils/VaultBase.sol` (128 lines, extends `RegistryBase` — live merchant, funded payer, configured vault) and `test/IntentVault.Direct.t.sol` (340 lines).

**Exit checks:** ✅ **30 DIRECT tests** pass (needed ≥ 28) · ✅ gas recorded in `docs/gas.md`

Full suite: **68 tests, 0 failed** across 5 suites. The vault now has real coverage for the first time.

Threats exercised here: **T1** tampered amount, **T2** redirect attempt, **T3** replay, **T4** invoice paid twice, **T5** unregistered merchant, **T6** key rotation invalidating old invoices, **T8** expiry, **T18** fee cap, **T19** amount cap + pause.

### Finding — the gas-report median is a trap for Backend B

`forge test --gas-report` aggregates **every** call to a function, and most DIRECT tests are deliberate reverts, which are cheap. The raw report for `payDirect`:

| | Min | Avg | Median | Max | Calls |
|---|---|---|---|---|---|
| all 29 calls (mostly reverts) | 44,720 | 221,909 | **108,604** | 554,084 | 29 |

Filtering to calls that actually settle:

| | Min | Avg | Max |
|---|---|---|---|
| successful settlements only | **505,484** | **529,784** | **554,084** |

The doc's exit check says to record "the `payDirect` median" in `docs/gas.md`. Recording 108,604 would be actively harmful: **Monad bills the gas limit**, B sets `gas = estimate × 1.2`, and a 108k fallback would make every real payment run out of gas.

`docs/gas.md` therefore records the **successful-path** figures, with the trap written out explicitly, and recommends a **700,000** fallback for `payDirect` (554,084 × 1.2 ≈ 665k, rounded up). `paySwap` and the cross-chain calls get measured in A14/A15.

### Deviation

The doc asks for the median; recorded the successful-path max/avg instead, with the reasoning in `docs/gas.md`. Recording the literal median would have handed B a number that breaks payments.
