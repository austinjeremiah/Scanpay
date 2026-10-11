// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VaultBase} from "./utils/VaultBase.sol";
import {FakeRouter, ShortChangeAdapter} from "./utils/FakeRouter.sol";
import {IIntentVault} from "../src/interfaces/IIntentVault.sol";
import {ISwapAdapter} from "../src/interfaces/ISwapAdapter.sol";
import {KuruFlowAdapter} from "../src/adapters/KuruFlowAdapter.sol";
import "../src/libraries/ScanPayTypes.sol";

contract IntentVaultSwapTest is VaultBase {
    uint256 internal constant MON_NEEDED = 480e18; // 12 USDC / 0.025
    uint256 internal constant MON_MAX = 500e18; // B adds a buffer; 20 MON comes back

    function _swapIntent(address input, uint256 maxIn) internal returns (Invoice memory inv, PaymentIntent memory p) {
        inv = _invoice(keccak256(abi.encode("swap", nextNonce)));
        p = _intent(inv, ROUTE_SWAP, input, maxIn);
    }

    function _paySwap(Invoice memory inv, PaymentIntent memory p) internal returns (bytes32) {
        return vault.paySwap(p, inv, _merchantSig(inv), _payerSig(p), "");
    }

    function test_swap_monToUsdc_exactOutputWithRefund() public {
        vm.prank(payer);
        mon.approve(address(vault), type(uint256).max); // the one-time approve (operator drips gas for it)
        (Invoice memory inv, PaymentIntent memory p) = _swapIntent(address(mon), MON_MAX);
        uint256 monBefore = mon.balanceOf(payer);

        vm.prank(operator);
        bytes32 id = _paySwap(inv, p);

        assertEq(mon.balanceOf(payer), monBefore - MON_NEEDED, "only needed MON spent");
        assertEq(usdc.balanceOf(payoutWallet), AMOUNT - FEE);
        assertEq(usdc.balanceOf(feeRecipient), FEE);
        assertEq(usdc.balanceOf(address(vault)), 0);
        assertEq(mon.balanceOf(address(vault)), 0);
        IntentRecord memory r = vault.getIntent(id);
        assertEq(r.status, INTENT_SETTLED);
        assertEq(r.inputAmount, MON_NEEDED);
        assertEq(r.inputToken, address(mon));
    }

    function test_swap_usdcToAusdMerchant() public {
        bytes32 m2 = _registerAndApprove(keccak256("shop-ausd"), address(ausd));
        Invoice memory inv = _invoiceFor(m2, keccak256("x"), address(ausd), AMOUNT);
        PaymentIntent memory p = _intent(inv, ROUTE_SWAP, address(usdc), AMOUNT + 50_000);
        vm.prank(payer);
        usdc.approve(address(vault), type(uint256).max);
        vault.paySwap(p, inv, _merchantSig(inv), _payerSig(p), "");
        assertEq(ausd.balanceOf(payoutWallet), AMOUNT - FEE);
        assertEq(usdc.balanceOf(payer), 1_000e6 - AMOUNT, "1:1, buffer refunded");
    }

    function test_swap_sameToken_pullsExactlyAmountOut() public {
        vm.prank(payer);
        usdc.approve(address(vault), type(uint256).max);
        (Invoice memory inv, PaymentIntent memory p) = _swapIntent(address(usdc), AMOUNT * 2);
        _paySwap(inv, p);
        assertEq(usdc.balanceOf(payer), 1_000e6 - AMOUNT);
        assertEq(usdc.balanceOf(payoutWallet), AMOUNT - FEE);
    }

    function test_swap_revert_noAllowance() public {
        (Invoice memory inv, PaymentIntent memory p) = _swapIntent(address(mon), MON_MAX);
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        vm.expectRevert(); // ERC20InsufficientAllowance
        vault.paySwap(p, inv, ms, ps, "");
    }

    function test_swap_revert_allowanceUnusableWithoutPayerSig() public {
        // Approving the vault does NOT let anyone else spend: attacker signs an intent naming the payer.
        vm.prank(payer);
        mon.approve(address(vault), type(uint256).max);
        (Invoice memory inv, PaymentIntent memory p) = _swapIntent(address(mon), MON_MAX);
        bytes memory ms = _merchantSig(inv);
        bytes memory forged = _sign(ATTACKER_PK, vault.hashIntent(p));
        vm.expectRevert(IIntentVault.InvalidPayerSignature.selector);
        vault.paySwap(p, inv, ms, forged, "");
    }

    function test_swap_revert_maxInTooLow() public {
        vm.prank(payer);
        mon.approve(address(vault), type(uint256).max);
        (Invoice memory inv, PaymentIntent memory p) = _swapIntent(address(mon), 400e18);
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        vm.expectRevert(abi.encodeWithSelector(ISwapAdapter.InsufficientOutput.selector, 10e6, AMOUNT));
        vault.paySwap(p, inv, ms, ps, "");
    }

    function test_swap_revert_noAdapter() public {
        vm.prank(admin);
        vault.setSwapAdapter(address(0));
        vm.prank(payer);
        mon.approve(address(vault), type(uint256).max);
        (Invoice memory inv, PaymentIntent memory p) = _swapIntent(address(mon), MON_MAX);
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        vm.expectRevert(IIntentVault.NoSwapAdapter.selector);
        vault.paySwap(p, inv, ms, ps, "");
    }

    function test_swap_revert_shortChangingAdapterCaught() public {
        ShortChangeAdapter bad = new ShortChangeAdapter(address(vault));
        vm.prank(admin);
        usdc.mint(address(bad), 1_000e6);
        vm.prank(admin);
        vault.setSwapAdapter(address(bad));
        vm.prank(payer);
        mon.approve(address(vault), type(uint256).max);
        (Invoice memory inv, PaymentIntent memory p) = _swapIntent(address(mon), MON_MAX);
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.SwapOutputTooLow.selector, AMOUNT - 1, AMOUNT));
        vault.paySwap(p, inv, ms, ps, "");
    }

    function test_swap_revert_inputTokenNotAllowed() public {
        vm.prank(admin);
        vault.setInputTokenAllowed(address(mon), ROUTE_SWAP, false);
        (Invoice memory inv, PaymentIntent memory p) = _swapIntent(address(mon), MON_MAX);
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.InputTokenNotAllowed.selector, address(mon), ROUTE_SWAP));
        vault.paySwap(p, inv, ms, ps, "");
    }

    function test_swap_revert_zeroMaxIn() public {
        (Invoice memory inv, PaymentIntent memory p) = _swapIntent(address(mon), 0);
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        vm.expectRevert(IIntentVault.AmountMismatch.selector);
        vault.paySwap(p, inv, ms, ps, "");
    }

    // ------------------------------------------------------------ Kuru adapter wired into the vault

    function test_kuru_viaVault_surplusRefunded() public {
        FakeRouter router = new FakeRouter();
        vm.prank(admin);
        usdc.mint(address(router), 1_000e6);
        address[] memory targets = new address[](1);
        targets[0] = address(router);
        KuruFlowAdapter kuru = new KuruFlowAdapter(admin, address(vault), targets);
        vm.prank(admin);
        vault.setSwapAdapter(address(kuru));

        vm.prank(payer);
        mon.approve(address(vault), type(uint256).max);
        (Invoice memory inv, PaymentIntent memory p) = _swapIntent(address(mon), MON_MAX);
        // exact-input aggregator: all 500 MON in, 12.5 USDC out (0.5 positive surplus)
        bytes memory swapData = abi.encode(
            address(router), abi.encodeCall(FakeRouter.swap, (address(mon), address(usdc), MON_MAX, 12_500_000))
        );
        uint256 payerUsdcBefore = usdc.balanceOf(payer);
        bytes32 id = vault.paySwap(p, inv, _merchantSig(inv), _payerSig(p), swapData);

        assertEq(usdc.balanceOf(payoutWallet), AMOUNT - FEE);
        assertEq(usdc.balanceOf(payer), payerUsdcBefore + 500_000, "surplus payout token refunded");
        assertEq(mon.allowance(address(kuru), address(router)), 0, "approval reset");
        assertEq(usdc.balanceOf(address(kuru)), 0);
        assertEq(vault.getIntent(id).inputAmount, MON_MAX);
    }
}

contract KuruFlowAdapterTest is VaultBase {
    FakeRouter internal router;
    KuruFlowAdapter internal kuru;

    function setUp() public override {
        super.setUp();
        router = new FakeRouter();
        vm.prank(admin);
        usdc.mint(address(router), 1_000e6);
        address[] memory targets = new address[](1);
        targets[0] = address(router);
        kuru = new KuruFlowAdapter(admin, address(this), targets); // this test plays vault
        vm.prank(admin);
        mon.mint(address(kuru), 100e18); // "vault already transferred amountIn"
    }

    function _data(uint256 amountIn, uint256 out) internal view returns (bytes memory) {
        return abi.encode(address(router), abi.encodeCall(FakeRouter.swap, (address(mon), address(usdc), amountIn, out)));
    }

    function test_swap_happy_leftoverReturned() public {
        address leftoverTo = makeAddr("leftover");
        uint256 out = kuru.swap(address(mon), address(usdc), 100e18, 2e6, _data(80e18, 2e6), address(this), leftoverTo);
        assertEq(out, 2e6);
        assertEq(usdc.balanceOf(address(this)), 2e6);
        assertEq(mon.balanceOf(leftoverTo), 20e18);
    }

    function test_swap_revert_onlyVault() public {
        vm.prank(attacker);
        vm.expectRevert(ISwapAdapter.OnlyVault.selector);
        kuru.swap(address(mon), address(usdc), 100e18, 2e6, _data(100e18, 2e6), attacker, attacker);
    }

    function test_swap_revert_targetNotAllowed() public {
        bytes memory data = abi.encode(address(usdc), abi.encodeWithSignature("transfer(address,uint256)", attacker, 1));
        vm.expectRevert(abi.encodeWithSelector(ISwapAdapter.TargetNotAllowed.selector, address(usdc)));
        kuru.swap(address(mon), address(usdc), 100e18, 1, data, address(this), address(this));
    }

    function test_swap_revert_callFails() public {
        bytes memory data = abi.encode(address(router), abi.encodeCall(FakeRouter.boom, ()));
        vm.expectRevert(); // SwapCallFailed(reason)
        kuru.swap(address(mon), address(usdc), 100e18, 1, data, address(this), address(this));
    }

    function test_swap_revert_insufficientOutput() public {
        vm.expectRevert(abi.encodeWithSelector(ISwapAdapter.InsufficientOutput.selector, 1e6, 2e6));
        kuru.swap(address(mon), address(usdc), 100e18, 2e6, _data(100e18, 1e6), address(this), address(this));
    }

    function test_admin_targets() public {
        vm.prank(attacker);
        vm.expectRevert();
        kuru.setTargetAllowed(attacker, true);
        vm.prank(admin);
        kuru.setTargetAllowed(address(router), false);
        assertFalse(kuru.allowedTarget(address(router)));
    }
}
