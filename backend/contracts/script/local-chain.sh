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
