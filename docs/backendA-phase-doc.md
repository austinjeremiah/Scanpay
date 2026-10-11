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
| A10 | Registry + mock token tests | 🔜 | |

**Checkpoints:** **I0 ✅ reached** · I1 (A18) · I2 (A19) · I3 (A22) · I4 (A23)

---

## What is still needed from the outside

| Needed | For | Status |
|---|---|---|
| `OPERATOR_ADDRESS` from Backend B | A19 testnet deploy | ⏸ not received |
| B to add 2 rows to ICD §0.8 (see A5) | I0 handoff | ⏸ raise at I0 |
| Deployer keystore (`cast wallet import scanpay-deployer`) | A19 | ⏸ not created |
| Funded testnet MON | A19 | ⏸ |
| `ENVIO_API_TOKEN` | A22 | ⏸ |
| ~3 real MON on mainnet | A23 | ⏸ |

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
