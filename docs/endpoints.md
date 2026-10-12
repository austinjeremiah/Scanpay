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
| **hosted (Envio Cloud)** | _pending — paste the URL here once the dashboard shows "Synced"_ |

Deploy branch: **`envio`** (pushed). Random pushes to `main` do not redeploy.

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

## Monad mainnet (143) — not deployed yet (A23)

| Thing | Value |
|---|---|
| RPC | `https://rpc.monad.xyz` |
| Explorer | https://monadscan.com |
| USDC | `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` (eip712 `USDC` / `2`) |
| AUSD | `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a` (eip712 **`Agora Dollar`** / `1`) |
| amountCap | 1 USDC / 1 AUSD (hard blast-radius cap) |
