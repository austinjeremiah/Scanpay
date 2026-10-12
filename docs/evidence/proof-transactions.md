# Proof transactions

Every payment route, proven end-to-end through the API's HTTP routes against live
contracts. Each one was produced by `backend/services/api/scripts/e2e-routes.ts`,
which registers a merchant, signs an invoice, prepares and submits the payment,
then asks `GET /v1/verify/:chainId/:intentId` to recompute the three proofs.

The merchant payout wallet is a freshly generated address in every run, so funds
always move between different accounts — never back to the payer.

## Monad mainnet (143)

| Route | Amount | Merchant received | Verify | Tx |
|---|---|---|---|---|
| DIRECT | 0.05 USDC | 0.04985 | **VERIFIED** | [`0x623eaa04…`](https://monadscan.com/tx/0x623eaa049e1868b16e80dfbd3ed05778140fc8604ef6e89748084aa268405e92) |
| SWAP (real Kuru) | 0.816 WMON → 0.02 USDC | 0.01994 | **VERIFIED** | [`0x7054d8d5…`](https://monadscan.com/tx/0x7054d8d5337f548c9b6278300c842a2f31370a728ce1738e9e1d741e0522c1ed) |
| CROSSCHAIN (real Aurora/1Click, from Base) | 0.2 USDC | 0.1994 | **VERIFIED** | commit [`0x89316949…`](https://monadscan.com/tx/0x89316949d6b44a71f95f46a46dbd0904b711e39b41e752f74b5da45f883c7bb3) · settle [`0x9634d8b0…`](https://monadscan.com/tx/0x9634d8b08dac7a0a2042fb76fcabd7dbdedede5aee68bef0ca155486ee602be7) |

### The cross-chain payment in full

The customer paid on **Base**, the merchant was paid on **Monad**, and the customer
signed exactly once.

| Step | Where | Evidence |
|---|---|---|
| intent committed, forwarder derived | Monad | `0x89316949…`, forwarder `0x779e6850e4cb090525f084c02f15b39758dd63fd` |
| customer sends USDC | Base | `0xca16195819d7973c1c1001f3a2361b5a3d9b57e0173d97371f50aa450af071fb` — 0.203127 USDC to the 1Click deposit address `0x2e8952626135a79ACcf0A4121d9798331266132b` |
| solver bridges Base → NEAR intents → Monad | — | 1Click `depositedAmount` 203127, `amountOut` 200000, intent hash `3ekAkNDk2ARmgwbT3EEFNNhLrLztNnHJ2udRyQ8tbWfd` |
| vault checks the forwarder balance and settles | Monad | `0x9634d8b0…` — fee 600, net 199400 |

On-chain settlement maths, recomputed by the verifier: `amount 200000 = fee 600 + net 199400`
(0.30%). The vault held nothing afterwards.

**Timing:** DIRECT and SWAP settle in about a second. The cross-chain leg took ~25
minutes end-to-end, nearly all of it the external solver bridging — commit and settle
on Monad are one transaction each. Demo accordingly: start cross-chain first, show the
instant routes while it travels.

**Bridge minimum:** 1Click rejects anything under ~0.15 USDC
(`Amount is too low for bridge, try at least 149982`), which is why the cross-chain
proof is 0.2 USDC rather than the 0.02 used for the others.

## Monad testnet (10143)

| Route | Merchant received | Verify |
|---|---|---|
| DIRECT | 1.22631 USDC | **VERIFIED** |
| SWAP (mock adapter) | 1.22631 USDC (paid 49.446 tMON) | **VERIFIED** |
| CROSSCHAIN (simulated solver) | 1.22631 USDC | **VERIFIED** |

Testnet tokens are our own `MockStableToken` deployments, chosen so a Monad testnet
reset cannot break the demo. The contracts are byte-identical to mainnet and all
verified on Sourcify.

## Reproducing

```bash
pnpm --filter @scanpay/api exec tsx --env-file=../../../.env scripts/e2e-routes.ts 10143 all
```
