#!/usr/bin/env bash
# Starts anvil in the foreground on :8545 with the Monad execution network if supported.
set -euo pipefail
NET_FLAG=""
if anvil --help 2>/dev/null | grep -q -- "--network"; then NET_FLAG="--network monad"; fi
exec anvil --host 127.0.0.1 --port 8545 --chain-id 31337 $NET_FLAG
