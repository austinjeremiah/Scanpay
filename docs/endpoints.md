# ScanPay Guard — endpoints

## Monad testnet (10143) — the demo chain

| Thing | Value |
|---|---|
| RPC | `https://testnet-rpc.monad.xyz` |
| Explorer | https://testnet.monadscan.com |
| MerchantRegistry | `0x2725111582b68539df62d57f579eafcebfb870b0` |
| IntentVault | `0xa952e8ac92bce001b5ef4ddb1a4027a7b9d2868e` |
| DepositForwarderImpl | `0xacbed31d720e3792078be35ac6772a43120be585` |
| SwapAdapter (mock) | `0x36e1c5c4c98365e83de24f6bc15671561450064c` |
| tUSDC | `0xa5e36c82195b38105f0918fba71e4d3f3f51a1f5` |
| tAUSD | `0x7cdf8e230f6fdf66ae50019ba9fbe3f4dddb3199` |
| tMON | `0xf9545590ac904f767fae01565c7076e217279616` |
| startBlock | 70485353 |
| admin / operator / feeRecipient | `0xcd8f91dc7929e973ddc071838904434297ab4673` |

All 7 contracts verified (Sourcify / MonadVision).

## Envio GraphQL

| Env | URL |
|---|---|
| local (`envio dev`) | `http://localhost:8080/v1/graphql` (admin secret `testing`) |
| **hosted (Envio Cloud)** | `https://indexer.dev.hyperindex.xyz/247ade4/v1/graphql` (public, no auth) |

Deploy branch: **`envio`** (pushed). Random pushes to `main` do not redeploy.

Verified live: returns merchant `0xf749e131…` ACTIVE, paymentCount 1, netReceived 1226310, feesPaid 3690,
and `ProtocolStat` id `10143` settled 1 / volume 1230000 / fees 3690.

Data source on Cloud is **RPC**, not HyperSync: HyperSync needs `ENVIO_API_TOKEN`, and environment variables
are a paid feature on the free Development tier. Local `envio dev` does use HyperSync (token in `.env`).
Indexed results are identical either way.

**Envio Cloud dashboard settings** — note the root directory differs from the build doc:

| Setting | Value |
|---|---|
| root directory | **`backend/indexer`** (doc says `indexer`; this repo nests it under `backend/`) |
| config file | `config.yaml` |
| deploy branch | `envio` |
| env vars | `ENVIO_API_TOKEN` |

**Redeploy rule:** after any contract redeploy →
`pnpm deployments:build <chainId>` → `INDEX_CHAINS=<chainId> pnpm --filter @scanpay/indexer gen:config`
→ commit → `git push origin main:envio`.

## Monad mainnet (143) — LIVE

| Thing | Value |
|---|---|
| RPC | `https://rpc.monad.xyz` |
| Explorer | https://monadscan.com |
| MerchantRegistry | `0x2725111582b68539df62d57f579eafcebfb870b0` |
| IntentVault | `0xa952e8ac92bce001b5ef4ddb1a4027a7b9d2868e` |
| DepositForwarderImpl | `0xacbed31d720e3792078be35ac6772a43120be585` |
| **SwapAdapter (kuru)** | `0xa5e36c82195b38105f0918fba71e4d3f3f51a1f5` |
| USDC (real, Circle) | `0x754704bc059f8c67012fed69bc8a327a5aafb603` — eip712 `USDC` / `2` |
| AUSD (real, Agora) | `0x00000000efe302beaa2b3e6e1b18d08d69a9012a` — eip712 **`Agora Dollar`** / `1` |
| WMON / WETH | `0x3bd359c1119da7da1d913d1c4d2b7c461115433a` / `0xee8c0e9f1bffb4eb878d8f15f368a02a35481242` |
| startBlock | 112857175 |
| feeBps / refundDelay | 30 / 3600 |
| **amountCap** | **1 USDC / 1 AUSD** — hard on-chain blast-radius cap |

No mocks on mainnet: every token is the real deployed asset (`isMock: false`) and the swap
adapter is the Kuru one, validated against the live aggregator on a fork (see
`docs/evidence/kuru-fork.txt`).

Contract addresses match testnet because the deployer's nonce sequence is identical on both
chains — same deployer, same order, so CREATE yields the same addresses. Expected, not a bug.
