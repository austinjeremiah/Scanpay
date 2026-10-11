// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VaultBase} from "./utils/VaultBase.sol";
import {IIntentVault} from "../src/interfaces/IIntentVault.sol";
import {DepositForwarder} from "../src/DepositForwarder.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import "../src/libraries/ScanPayTypes.sol";

contract IntentVaultCrossChainTest is VaultBase {
    address internal keeper; // anyone

    function setUp() public override {
        super.setUp();
        keeper = makeAddr("keeper");
    }

    function _cc(Invoice memory inv, uint256 maxIn) internal returns (PaymentIntent memory p, bytes32 id, address fwd) {
        p = _intent(inv, ROUTE_CROSSCHAIN, address(usdc), maxIn);
        vm.prank(operator);
        (id, fwd) = vault.commitCrossChain(p, inv, _merchantSig(inv), _payerSig(p));
    }

    function _solverDelivers(address fwd, uint256 amount) internal {
        vm.prank(admin);
        usdc.mint(fwd, amount);
    }

    // ------------------------------------------------------------ commit

    function test_commit_deploysPredictedForwarderAndReserves() public {
        Invoice memory inv = _invoice(keccak256("cc-1"));
        PaymentIntent memory p = _intent(inv, ROUTE_CROSSCHAIN, address(usdc), AMOUNT);
        bytes32 expectedId = vault.computeIntentId(p);
        address predicted = vault.forwarderOf(expectedId);
        assertEq(predicted.code.length, 0);

        vm.expectEmit(true, true, true, true, address(vault));
        emit IIntentVault.IntentCommitted(
            expectedId, merchantId, payer, inv.invoiceId, ROUTE_CROSSCHAIN, address(usdc), address(usdc), AMOUNT,
            predicted, payoutWallet, p.expiresAt, keccak256("quote")
        );
        (bytes32 id, address fwd) = vault.commitCrossChain(p, inv, _merchantSig(inv), _payerSig(p));

        assertEq(id, expectedId);
        assertEq(fwd, predicted);
        assertGt(fwd.code.length, 0);
        assertEq(DepositForwarder(fwd).vault(), address(vault));
        IntentRecord memory r = vault.getIntent(id);
        assertEq(r.status, INTENT_COMMITTED);
        assertEq(r.inputAmount, AMOUNT, "required deposit");
        assertEq(vault.invoiceState(merchantId, inv.invoiceId), INVOICE_RESERVED);
    }

    function test_commit_revert_inputNotCrossChainToken() public {
        Invoice memory inv = _invoice(keccak256("cc-1"));
        PaymentIntent memory p = _intent(inv, ROUTE_CROSSCHAIN, address(ausd), AMOUNT);
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        vm.expectRevert(
            abi.encodeWithSelector(IIntentVault.InputTokenNotAllowed.selector, address(ausd), ROUTE_CROSSCHAIN)
        );
        vault.commitCrossChain(p, inv, ms, ps);
    }

    function test_commit_revert_secondPayerWhileReserved() public {
        Invoice memory inv = _invoice(keccak256("cc-1"));
        _cc(inv, AMOUNT);
        PaymentIntent memory p2 = _intent(inv, ROUTE_CROSSCHAIN, address(usdc), AMOUNT);
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p2);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.InvoiceNotOpen.selector, INVOICE_RESERVED));
        vault.commitCrossChain(p2, inv, ms, ps);
    }

    // ------------------------------------------------------------ settle

    function test_settle_exactDeposit_permissionless() public {
        Invoice memory inv = _invoice(keccak256("cc-1"));
        (, bytes32 id, address fwd) = _cc(inv, AMOUNT);
        _solverDelivers(fwd, AMOUNT);

        vm.prank(keeper);
        vault.settleCrossChain(id, "");

        assertEq(usdc.balanceOf(payoutWallet), AMOUNT - FEE);
        assertEq(usdc.balanceOf(feeRecipient), FEE);
        assertEq(usdc.balanceOf(fwd), 0);
        assertEq(usdc.balanceOf(address(vault)), 0);
        assertEq(vault.getIntent(id).status, INTENT_SETTLED);
        assertEq(vault.invoiceState(merchantId, inv.invoiceId), INVOICE_PAID);
    }

    function test_settle_depositBeforeCommit() public {
        Invoice memory inv = _invoice(keccak256("cc-1"));
        PaymentIntent memory p = _intent(inv, ROUTE_CROSSCHAIN, address(usdc), AMOUNT);
        address fwd = vault.forwarderOf(vault.computeIntentId(p));
        _solverDelivers(fwd, AMOUNT); // solver was faster than our commit tx
        (bytes32 id,) = vault.commitCrossChain(p, inv, _merchantSig(inv), _payerSig(p));
        vault.settleCrossChain(id, "");
        assertEq(usdc.balanceOf(payoutWallet), AMOUNT - FEE);
    }

    function test_settle_overDeposit_excessToRefundTo() public {
        Invoice memory inv = _invoice(keccak256("cc-1"));
        (, bytes32 id, address fwd) = _cc(inv, AMOUNT);
        _solverDelivers(fwd, AMOUNT + 777);
        uint256 payerBefore = usdc.balanceOf(payer);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IIntentVault.PaymentSettled(
            id, merchantId, payer, inv.invoiceId, ROUTE_CROSSCHAIN, address(usdc), AMOUNT, FEE, payoutWallet,
            address(usdc), AMOUNT + 777, 777
        );
        vault.settleCrossChain(id, "");
        assertEq(usdc.balanceOf(payer), payerBefore + 777);
    }

    function test_settle_revert_underpaid_thenTopUpWorks() public {
        Invoice memory inv = _invoice(keccak256("cc-1"));
        (, bytes32 id, address fwd) = _cc(inv, AMOUNT);
        _solverDelivers(fwd, AMOUNT - 1);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.Underpaid.selector, AMOUNT - 1, AMOUNT));
        vault.settleCrossChain(id, "");
        _solverDelivers(fwd, 1);
        vault.settleCrossChain(id, "");
        assertEq(vault.getIntent(id).status, INTENT_SETTLED);
    }

    function test_settle_revert_noFunds_fakeProviderSuccess() public {
        // "Provider says SUCCESS" is meaningless: with nothing in the forwarder, settle is impossible.
        Invoice memory inv = _invoice(keccak256("cc-1"));
        (, bytes32 id,) = _cc(inv, AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.Underpaid.selector, 0, AMOUNT));
        vault.settleCrossChain(id, "");
    }

    function test_settle_lateDeliveryAfterExpiryStillSettles() public {
        Invoice memory inv = _invoice(keccak256("cc-1"));
        (PaymentIntent memory p, bytes32 id, address fwd) = _cc(inv, AMOUNT);
        vm.warp(p.expiresAt + 30); // before expiresAt + refundDelay
        _solverDelivers(fwd, AMOUNT);
        vault.settleCrossChain(id, "");
        assertEq(vault.getIntent(id).status, INTENT_SETTLED);
    }

    function test_settle_usdcToAusdMerchant_viaSwap() public {
        bytes32 m2 = _registerAndApprove(keccak256("shop-ausd"), address(ausd));
        Invoice memory inv = _invoiceFor(m2, keccak256("cc-ausd"), address(ausd), AMOUNT);
        uint256 maxIn = AMOUNT + 36_000; // B requests 0.3% buffer of USDC from Aurora
        (, bytes32 id, address fwd) = _cc(inv, maxIn);
        _solverDelivers(fwd, maxIn);
        uint256 payerUsdcBefore = usdc.balanceOf(payer);

        vault.settleCrossChain(id, "");

        assertEq(ausd.balanceOf(payoutWallet), AMOUNT - FEE);
        assertEq(usdc.balanceOf(payer), payerUsdcBefore + 36_000, "unused USDC refunded");
        IntentRecord memory r = vault.getIntent(id);
        assertEq(r.inputAmount, AMOUNT, "1:1 used exactly AMOUNT");
        assertEq(usdc.balanceOf(address(vault)) + ausd.balanceOf(address(vault)), 0);
    }

    function test_settle_revert_twice() public {
        Invoice memory inv = _invoice(keccak256("cc-1"));
        (, bytes32 id, address fwd) = _cc(inv, AMOUNT);
        _solverDelivers(fwd, AMOUNT);
        vault.settleCrossChain(id, "");
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.IntentNotCommitted.selector, id));
        vault.settleCrossChain(id, "");
    }

    function test_settle_revert_unknownIntent() public {
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.IntentNotCommitted.selector, bytes32(uint256(42))));
        vault.settleCrossChain(bytes32(uint256(42)), "");
    }

    function test_settle_revert_paused() public {
        Invoice memory inv = _invoice(keccak256("cc-1"));
        (, bytes32 id, address fwd) = _cc(inv, AMOUNT);
        _solverDelivers(fwd, AMOUNT);
        vm.prank(admin);
        vault.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.settleCrossChain(id, "");
    }

    // ------------------------------------------------------------ refund

    function test_refund_revert_tooEarly() public {
        Invoice memory inv = _invoice(keccak256("cc-1"));
        (PaymentIntent memory p, bytes32 id,) = _cc(inv, AMOUNT);
        uint256 allowedAt = uint256(p.expiresAt) + REFUND_DELAY;
        vm.warp(allowedAt - 1);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.RefundNotYetAllowed.selector, allowedAt));
        vault.refundCrossChain(id);
    }

    function test_refund_partialDeposit_reopensInvoice_evenWhilePaused() public {
        Invoice memory inv = _invoice(keccak256("cc-1"));
        (PaymentIntent memory p, bytes32 id, address fwd) = _cc(inv, AMOUNT);
        _solverDelivers(fwd, 5e6);
        vm.prank(admin);
        vault.pause();
        vm.warp(uint256(p.expiresAt) + REFUND_DELAY);
        uint256 payerBefore = usdc.balanceOf(payer);

        vm.expectEmit(true, true, false, true, address(vault));
        emit IIntentVault.IntentRefunded(id, payer, address(usdc), 5e6);
        vm.prank(keeper);
        vault.refundCrossChain(id);

        assertEq(usdc.balanceOf(payer), payerBefore + 5e6);
        assertEq(vault.getIntent(id).status, INTENT_REFUNDED);
        assertEq(vault.invoiceState(merchantId, inv.invoiceId), INVOICE_OPEN);
        assertTrue(vault.usedNonce(payer, p.nonce), "nonce stays burned");
    }

    function test_refund_thenInvoicePayableAgain() public {
        Invoice memory inv = _invoice(keccak256("cc-1"));
        inv.expiresAt = uint64(block.timestamp + 2 hours);
        (PaymentIntent memory p, bytes32 id,) = _cc(inv, AMOUNT);
        vm.warp(uint256(p.expiresAt) + REFUND_DELAY);
        vault.refundCrossChain(id);

        PaymentIntent memory p2 = _intent(inv, ROUTE_DIRECT, address(usdc), AMOUNT);
        vault.payDirect(p2, inv, _merchantSig(inv), _payerSig(p2), _auth(p2));
        assertEq(vault.invoiceState(merchantId, inv.invoiceId), INVOICE_PAID);
    }

    function test_refund_revert_afterSettle() public {
        Invoice memory inv = _invoice(keccak256("cc-1"));
        (PaymentIntent memory p, bytes32 id, address fwd) = _cc(inv, AMOUNT);
        _solverDelivers(fwd, AMOUNT);
        vault.settleCrossChain(id, "");
        vm.warp(uint256(p.expiresAt) + REFUND_DELAY);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.IntentNotCommitted.selector, id));
        vault.refundCrossChain(id);
    }

    function test_refund_revert_onDirectIntent() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        bytes32 id = _payDirect(inv, p);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.IntentNotCommitted.selector, id));
        vault.refundCrossChain(id);
    }

    // ------------------------------------------------------------ rescue

    function test_rescue_lateDepositAfterSettle() public {
        Invoice memory inv = _invoice(keccak256("cc-1"));
        (, bytes32 id, address fwd) = _cc(inv, AMOUNT);
        _solverDelivers(fwd, AMOUNT);
        vault.settleCrossChain(id, "");
        _solverDelivers(fwd, 3e6); // duplicate delivery
        uint256 payerBefore = usdc.balanceOf(payer);
        vm.prank(keeper);
        vault.rescue(id, address(usdc));
        assertEq(usdc.balanceOf(payer), payerBefore + 3e6);
    }

    function test_rescue_wrongTokenAfterRefund() public {
        Invoice memory inv = _invoice(keccak256("cc-1"));
        (PaymentIntent memory p, bytes32 id, address fwd) = _cc(inv, AMOUNT);
        vm.warp(uint256(p.expiresAt) + REFUND_DELAY);
        vault.refundCrossChain(id);
        vm.prank(admin);
        mon.mint(fwd, 7e18);
        vault.rescue(id, address(mon));
        assertEq(mon.balanceOf(fwd), 0);
    }

    function test_rescue_revert_whileCommitted() public {
        Invoice memory inv = _invoice(keccak256("cc-1"));
        (, bytes32 id,) = _cc(inv, AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.IntentNotTerminal.selector, id));
        vault.rescue(id, address(usdc));
    }

    // ------------------------------------------------------------ attest

    function test_attest_onlyAttester_once_noStatusChange() public {
        Invoice memory inv = _invoice(keccak256("cc-1"));
        (, bytes32 id,) = _cc(inv, AMOUNT);
        bytes32 src = keccak256("base-tx");
        bytes32 attesterRole = vault.ATTESTER_ROLE(); // read BEFORE vm.prank (a prank applies to the next call)

        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, attacker, attesterRole)
        );
        vm.prank(attacker);
        vault.attestSource(id, 8453, src, bytes32("corr-1"));

        vm.expectEmit(true, true, false, true, address(vault));
        emit IIntentVault.SourceAttested(id, 8453, src, bytes32("corr-1"), operator);
        vm.prank(operator);
        vault.attestSource(id, 8453, src, bytes32("corr-1"));

        IntentRecord memory r = vault.getIntent(id);
        assertEq(r.sourceChainId, 8453);
        assertEq(r.sourceTxHash, src);
        assertEq(r.status, INTENT_COMMITTED, "attestation never settles");

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.AlreadyAttested.selector, id));
        vault.attestSource(id, 8453, src, bytes32("corr-1"));
    }

    function test_attest_revert_nonCrossChain() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        bytes32 id = _payDirect(inv, p);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.IntentNotCommitted.selector, id));
        vault.attestSource(id, 1, bytes32(uint256(1)), bytes32(0));
    }
}
