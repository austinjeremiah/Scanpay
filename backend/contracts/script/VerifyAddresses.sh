#!/usr/bin/env bash
# Usage: MONAD_MAINNET_RPC=... MONAD_TESTNET_RPC=... bash backend/contracts/script/VerifyAddresses.sh
set -uo pipefail
M=${MONAD_MAINNET_RPC:-https://rpc.monad.xyz}
T=${MONAD_TESTNET_RPC:-https://testnet-rpc.monad.xyz}

code() { # name addr rpc
  local c; c=$(cast code "$2" --rpc-url "$3" 2>&1)
  if [[ "$c" == "0x" || -z "$c" ]]; then echo "❌ $1 $2  (NO CODE)"; else echo "✅ $1 $2  (${#c} hex chars)"; fi
}
call() { # label addr sig rpc
  local out; out=$(cast call "$2" "$3" --rpc-url "$4" 2>&1)
  echo "   $1 → $out"
}

echo "=== Monad mainnet (143) chainId: $(cast chain-id --rpc-url "$M") ==="
code USDC               0x754704Bc059F8C67012fEd69BC8A327a5aafb603 "$M"
call "USDC name"        0x754704Bc059F8C67012fEd69BC8A327a5aafb603 "name()(string)" "$M"
call "USDC version"     0x754704Bc059F8C67012fEd69BC8A327a5aafb603 "version()(string)" "$M"
call "USDC decimals"    0x754704Bc059F8C67012fEd69BC8A327a5aafb603 "decimals()(uint8)" "$M"
call "USDC RWA_TYPEHASH" 0x754704Bc059F8C67012fEd69BC8A327a5aafb603 "RECEIVE_WITH_AUTHORIZATION_TYPEHASH()(bytes32)" "$M"
echo -n "   USDC authState(0x..01, 0x..01) → "
cast call 0x754704Bc059F8C67012fEd69BC8A327a5aafb603 "authorizationState(address,bytes32)(bool)" 0x0000000000000000000000000000000000000001 0x0000000000000000000000000000000000000000000000000000000000000001 --rpc-url "$M" 2>&1

code AUSD               0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a "$M"
call "AUSD name"        0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a "name()(string)" "$M"
call "AUSD decimals"    0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a "decimals()(uint8)" "$M"
call "AUSD RWA_TYPEHASH" 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a "RECEIVE_WITH_AUTHORIZATION_TYPEHASH()(bytes32)" "$M"
call "AUSD eip712Domain" 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a "eip712Domain()(bytes1,string,string,uint256,address,bytes32,uint256[])" "$M"
echo -n "   AUSD authState(0x..01, 0x..01) → "
cast call 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a "authorizationState(address,bytes32)(bool)" 0x0000000000000000000000000000000000000001 0x0000000000000000000000000000000000000000000000000000000000000001 --rpc-url "$M" 2>&1

code WMON               0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A "$M"
code WETH               0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242 "$M"
code KuruFlowEntrypoint 0xb3e6778480b2E488385E8205eA05E20060B813cb "$M"
code KuruFlowRouter     0x0d3a1BE29E9dEd63c7a5678b31e847D68F71FFa2 "$M"
code Permit2            0x000000000022d473030f116ddee9f6b43ac78ba3 "$M"

echo
echo "=== Monad testnet (10143) chainId: $(cast chain-id --rpc-url "$T") ==="
echo "(informational only — testnet uses our own mock tokens)"
code CircleTestUSDC     0x534b2f3A21130d7a60830c2Df862319e593943A3 "$T"
code AgoraTestAUSD      0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC "$T"
code WMON_test          0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541 "$T"
