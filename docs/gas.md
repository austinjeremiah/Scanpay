# Gas reference (Backend A → Backend B)

Measured with `forge test --gas-report` on the local EVM at Solidity 0.8.28, via-IR, optimizer 200 runs.
Regenerate after any contract change.

> **Monad charges on the gas LIMIT, not gas used** (ICD §0.3). Every relayed transaction must set
> `gas = estimate × 1.2`, never a blind default. These figures are the fallback for when estimation fails.

## ⚠️ Do not use the gas-report median

`forge test --gas-report` aggregates **every** call to a function, and most tests are deliberate reverts,
which are cheap. For `payDirect` across the whole DIRECT suite the report shows:

| | Min | Avg | Median | Max | Calls |
|---|---|---|---|---|---|
| `payDirect` (all 29 calls, mostly reverts) | 44,720 | 221,909 | **108,604** | 554,084 | 29 |

Taking 108,604 as a fallback would make real payments run **out of gas**. Filter to the calls that
actually settle:

| | Min | Avg | Max | Calls |
|---|---|---|---|---|
| `payDirect` (successful settlements only) | **505,484** | **529,784** | **554,084** | 2 |

## Recommended fallback gas limits (A13 measurements)

| Operation | Observed max | × 1.2 | Suggested fallback |
|---|---|---|---|
| `payDirect` (DIRECT route, full settle) | 554,084 | 664,901 | **700,000** |
| `paySwap` | — | — | measured in A14 |
| `commitCrossChain` | — | — | measured in A15 |
| `settleCrossChain` | — | — | measured in A15 |

The successful path is dominated by: EIP-3009 `receiveWithAuthorization` on the token (signature recovery +
balance writes), two ECDSA recoveries in `_verify`, the `IntentRecord` storage write, and up to three ERC-20
transfers in `_settle`.

## Other vault functions (A13)

| Function | Median |
|---|---|
| `hashIntent` (view) | 1,809 |
| `hashInvoice` (view) | 1,864 |
| `computeIntentId` (pure) | 1,885 |
| `getIntent` (view) | 12,069 |
| `invoiceState` (view) | 9,115 |
| `pause` | 59,156 |
| `setAmountCap` | 59,488 |

## Contract sizes

| Contract | Runtime (B) | Margin vs Monad 128 KB |
|---|---|---|
| `IntentVault` | 19,237 | 111,835 |
| `MerchantRegistry` | 7,388 | 123,684 |
| `DepositForwarder` | 540 | 130,532 |
