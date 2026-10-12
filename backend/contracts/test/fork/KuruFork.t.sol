// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {KuruFlowAdapter} from "../../src/adapters/KuruFlowAdapter.sol";

/// Run:  KURU_SWAPDATA=0x… KURU_AMOUNT_IN=… KURU_MIN_OUT=… forge test --match-contract KuruForkTest \
///       --fork-url $MONAD_MAINNET_RPC -vv
/// The quote must have been generated seconds ago (prices move). Skips when env is missing.
contract KuruForkTest is Test {
    address constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address constant AUSD = 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a;

    function test_fork_kuru_usdcToAusd() public {
        bytes memory swapData = vm.envOr("KURU_SWAPDATA", bytes(""));
        if (swapData.length == 0 || block.chainid != 143) {
            console2.log("skipped: set KURU_SWAPDATA and --fork-url mainnet");
            return;
        }
        uint256 amountIn = vm.envUint("KURU_AMOUNT_IN");
        uint256 minOut = vm.envUint("KURU_MIN_OUT");
        string memory dep = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/143.json"));
        KuruFlowAdapter adapter = KuruFlowAdapter(vm.parseJsonAddress(dep, ".contracts.SwapAdapter.address"));
        address vault = adapter.vault();

        deal(USDC, address(adapter), amountIn); // "vault already transferred amountIn"
        address refundTo = makeAddr("refundTo");
        uint256 before = IERC20(AUSD).balanceOf(vault);
        vm.prank(vault);
        uint256 out = adapter.swap(USDC, AUSD, amountIn, minOut, swapData, vault, refundTo);
        assertGe(out, minOut);
        assertEq(IERC20(AUSD).balanceOf(vault) - before, out);
        (address target,) = abi.decode(swapData, (address, bytes));
        assertEq(IERC20(USDC).allowance(address(adapter), target), 0, "approval reset");
        assertEq(IERC20(AUSD).balanceOf(address(adapter)), 0, "adapter keeps nothing");
        console2.log("kuru out", out);
    }
}
