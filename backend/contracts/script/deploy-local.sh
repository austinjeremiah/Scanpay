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
