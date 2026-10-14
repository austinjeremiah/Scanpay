# ScanPay docs

Documentation is grouped by file type.

```
docs/
├── md/       Markdown: specs, runbook, logs, references, evidence
├── txt/      Plain-text output captured from tools
└── assets/   Images used by the main README
```

## `md/` — Markdown

| File | What it is |
|---|---|
| [`RUNBOOK.md`](md/RUNBOOK.md) | How to run and operate the stack |
| [`endpoints.md`](md/endpoints.md) | Deployed URLs and service endpoints |
| [`gas.md`](md/gas.md) | Gas measurements and fallback limits for the relayer |
| [`ScanPay-Guard-Backend-A-Chain.md`](md/ScanPay-Guard-Backend-A-Chain.md) | Build spec: contracts, shared SDK, deployments, indexer |
| [`ScanPay-Guard-Backend-B-Services.md`](md/ScanPay-Guard-Backend-B-Services.md) | Build spec: API, relayer, quotes, settlement watcher, Attack Lab |
| [`ScanPay-Guard-Frontend.md`](md/ScanPay-Guard-Frontend.md) | Build spec: the passkey app, page by page |
| [`backendA-phase-doc.md`](md/backendA-phase-doc.md) | Phase log for the chain layer |
| [`backend-b-progress.md`](md/backend-b-progress.md) | Progress log for the services layer |
| [`evidence/proof-transactions.md`](md/evidence/proof-transactions.md) | Mainnet and testnet proof transactions for every payment route |

## `txt/` — plain text

| File | What it is |
|---|---|
| [`test-summary.txt`](txt/test-summary.txt) | `forge test` results and coverage summary |
| [`address-verification-20261011.txt`](txt/address-verification-20261011.txt) | On-chain check of the token and Kuru addresses used on Monad |
| [`evidence/kuru-fork.txt`](txt/evidence/kuru-fork.txt) | Output of the Kuru swap run against a mainnet fork |

## `assets/`

Logos, sponsor logos and screenshots referenced by the [main README](../README.md).
