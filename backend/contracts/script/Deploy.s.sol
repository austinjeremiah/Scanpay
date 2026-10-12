// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {MerchantRegistry} from "../src/MerchantRegistry.sol";
import {IntentVault} from "../src/IntentVault.sol";
import {IMerchantRegistry} from "../src/interfaces/IMerchantRegistry.sol";
import {MockStableToken} from "../src/mocks/MockStableToken.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockSwapAdapter} from "../src/adapters/MockSwapAdapter.sol";
import {KuruFlowAdapter} from "../src/adapters/KuruFlowAdapter.sol";
import "../src/libraries/ScanPayTypes.sol";

/// Usage (env: ADMIN_ADDRESS, OPERATOR_ADDRESS, FEE_RECIPIENT, FEE_BPS, REFUND_DELAY_SEC):
///   forge script script/Deploy.s.sol:Deploy --rpc-url <local|monad_testnet|monad_mainnet> --broadcast ...
/// Reads  contracts/config/{chainid}.json
/// Writes deployments/raw/{chainid}.json  (then run: pnpm deployments:build {chainid})
contract Deploy is Script {
    using stdJson for string;

    string[6] internal KEYS = ["USDC", "AUSD", "MON", "WMON", "WETH", "USDT0"];

    struct Ctx {
        address admin;
        address operator;
        address feeRecipient;
        uint16 feeBps;
        uint64 refundDelay;
        string cfg;
        MerchantRegistry registry;
        IntentVault vault;
        address adapter;
        string adapterKind;
    }

    mapping(string => address) internal tokenAddr;

    function run() external {
        Ctx memory c;
        c.admin = vm.envAddress("ADMIN_ADDRESS");
        c.operator = vm.envAddress("OPERATOR_ADDRESS");
        c.feeRecipient = vm.envAddress("FEE_RECIPIENT");
        c.feeBps = uint16(vm.envUint("FEE_BPS"));
        c.refundDelay = uint64(vm.envUint("REFUND_DELAY_SEC"));
        c.cfg = vm.readFile(string.concat(vm.projectRoot(), "/config/", vm.toString(block.chainid), ".json"));
        c.adapterKind = c.cfg.readString(".swapAdapterKind");

        console2.log("chainId", block.chainid);
        console2.log("admin", c.admin);
        console2.log("operator", c.operator);

        vm.startBroadcast();

        // 1. core
        c.registry = new MerchantRegistry(c.admin);
        c.vault = new IntentVault(c.admin, IMerchantRegistry(address(c.registry)), c.feeRecipient, c.feeBps, c.refundDelay);

        // 2. tokens (deploy mocks where address is null)
        for (uint256 i; i < KEYS.length; ++i) {
            string memory k = KEYS[i];
            string memory base = string.concat(".tokens.", k);
            if (!vm.keyExistsJson(c.cfg, base)) continue;
            if (_isMock(c.cfg, k)) {
                string memory kind = c.cfg.readString(string.concat(base, ".mock"));
                string memory name = c.cfg.readString(string.concat(base, ".name"));
                string memory symbol = c.cfg.readString(string.concat(base, ".symbol"));
                uint8 dec = uint8(c.cfg.readUint(string.concat(base, ".decimals")));
                address t = keccak256(bytes(kind)) == keccak256("stable")
                    ? address(new MockStableToken(name, symbol, dec, c.admin))
                    : address(new MockERC20(name, symbol, dec, c.admin));
                tokenAddr[k] = t;
            } else {
                tokenAddr[k] = c.cfg.readAddress(string.concat(base, ".address"));
            }
        }

        // 3. swap adapter
        if (keccak256(bytes(c.adapterKind)) == keccak256("mock")) {
            MockSwapAdapter m = new MockSwapAdapter(c.admin, address(c.vault));
            c.adapter = address(m);
            _mockRatesAndLiquidity(c, m);
        } else if (keccak256(bytes(c.adapterKind)) == keccak256("kuru")) {
            address[] memory targets = c.cfg.readAddressArray(".external.kuruTargets");
            require(targets.length > 0, "kuru: no targets");
            c.adapter = address(new KuruFlowAdapter(c.admin, address(c.vault), targets));
        }
        if (c.adapter != address(0)) c.vault.setSwapAdapter(c.adapter);

        // 4. roles per token
        for (uint256 i; i < KEYS.length; ++i) {
            string memory k = KEYS[i];
            if (tokenAddr[k] == address(0)) continue;
            string memory base = string.concat(".tokens.", k);
            string[] memory roles = c.cfg.readStringArray(string.concat(base, ".roles"));
            bool s3009 = c.cfg.readBool(string.concat(base, ".supports3009"));
            for (uint256 j; j < roles.length; ++j) {
                bytes32 r = keccak256(bytes(roles[j]));
                if (r == keccak256("payout")) c.registry.setPayoutTokenAllowed(tokenAddr[k], true);
                else if (r == keccak256("direct") && s3009) c.vault.setInputTokenAllowed(tokenAddr[k], ROUTE_DIRECT, true);
                else if (r == keccak256("swapIn") && c.adapter != address(0)) {
                    c.vault.setInputTokenAllowed(tokenAddr[k], ROUTE_SWAP, true);
                }
            }
            string memory capKey = string.concat(".amountCaps.", k);
            if (vm.keyExistsJson(c.cfg, capKey)) {
                uint256 cap = vm.parseUint(c.cfg.readString(capKey));
                if (cap != 0) c.vault.setAmountCap(tokenAddr[k], cap);
            }
        }

        // 5. cross-chain input
        string memory ccKey = c.cfg.readString(".crossChainInputToken");
        if (tokenAddr[ccKey] != address(0)) c.vault.setCrossChainInputToken(tokenAddr[ccKey]);

        // 6. operator roles (B's hot key)
        c.registry.grantRole(c.registry.VERIFIER_ROLE(), c.operator);
        c.vault.grantRole(c.vault.ATTESTER_ROLE(), c.operator);
        for (uint256 i; i < KEYS.length; ++i) {
            address t = tokenAddr[KEYS[i]];
            if (t == address(0)) continue;
            if (_isMock(c.cfg, KEYS[i])) {
                MockStableToken(t).grantRole(keccak256("MINTER_ROLE"), c.operator); // same role id on MockERC20
            }
        }

        vm.stopBroadcast();

        _writeRaw(c);
    }

    function _mockRatesAndLiquidity(Ctx memory c, MockSwapAdapter m) internal {
        // rates: array of {in,out,rateE18}
        uint256 n = _arrayLen(c.cfg, ".mockRates");
        for (uint256 i; i < n; ++i) {
            string memory b = string.concat(".mockRates[", vm.toString(i), "]");
            address tin = tokenAddr[c.cfg.readString(string.concat(b, ".in"))];
            address tout = tokenAddr[c.cfg.readString(string.concat(b, ".out"))];
            uint256 rate = vm.parseUint(c.cfg.readString(string.concat(b, ".rateE18")));
            m.setRate(tin, tout, rate);
        }
        for (uint256 i; i < KEYS.length; ++i) {
            string memory key = string.concat(".mockLiquidity.", KEYS[i]);
            if (!vm.keyExistsJson(c.cfg, key) || tokenAddr[KEYS[i]] == address(0)) continue;
            uint256 amt = vm.parseUint(c.cfg.readString(key));
            MockStableToken(tokenAddr[KEYS[i]]).mint(address(m), amt); // admin (= broadcaster) holds MINTER
        }
    }

    function _arrayLen(string memory json, string memory key) internal view returns (uint256 n) {
        while (vm.keyExistsJson(json, string.concat(key, "[", vm.toString(n), "]"))) n++;
    }

    /// A token is deployed as a mock iff its config entry has a "mock" key ("stable" | "erc20").
    function _isMock(string memory json, string memory key) internal view returns (bool) {
        return vm.keyExistsJson(json, string.concat(".tokens.", key, ".mock"));
    }

    function _writeRaw(Ctx memory c) internal {
        string memory t = "tokens";
        string memory tokensJson = "{}";
        for (uint256 i; i < KEYS.length; ++i) {
            if (tokenAddr[KEYS[i]] != address(0)) tokensJson = vm.serializeAddress(t, KEYS[i], tokenAddr[KEYS[i]]);
        }
        string memory o = "raw";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeAddress(o, "MerchantRegistry", address(c.registry));
        vm.serializeAddress(o, "IntentVault", address(c.vault));
        vm.serializeAddress(o, "DepositForwarderImpl", c.vault.forwarderImplementation());
        vm.serializeAddress(o, "SwapAdapter", c.adapter);
        vm.serializeString(o, "swapAdapterKind", c.adapter == address(0) ? "none" : c.adapterKind);
        vm.serializeAddress(o, "admin", c.admin);
        vm.serializeAddress(o, "operator", c.operator);
        vm.serializeAddress(o, "feeRecipient", c.feeRecipient);
        vm.serializeUint(o, "feeBps", c.feeBps);
        vm.serializeUint(o, "refundDelaySec", c.refundDelay);
        string memory out = vm.serializeString(o, "tokens", tokensJson);
        string memory path = string.concat(vm.projectRoot(), "/../deployments/raw/", vm.toString(block.chainid), ".json");
        vm.writeJson(out, path);
        console2.log("wrote", path);
    }
}
