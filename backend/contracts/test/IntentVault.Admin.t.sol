// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VaultBase} from "./utils/VaultBase.sol";
import {IntentVault} from "../src/IntentVault.sol";
import {IIntentVault} from "../src/interfaces/IIntentVault.sol";
import {IMerchantRegistry} from "../src/interfaces/IMerchantRegistry.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import "../src/libraries/ScanPayTypes.sol";

/// Admin / config surface left uncovered by the route suites (A13-A15).
/// Not in the build doc; added because `unpause()` and `setRefundDelay()` had zero coverage,
/// and a broken unpause would make a pause unrecoverable.
contract IntentVaultAdminTest is VaultBase {
    // ---------------- constructor guards ----------------

    function test_ctor_revert_zeroAdmin() public {
        vm.expectRevert(IIntentVault.ZeroAddress.selector);
        new IntentVault(address(0), IMerchantRegistry(address(registry)), feeRecipient, FEE_BPS, REFUND_DELAY);
    }

    function test_ctor_revert_zeroRegistry() public {
        vm.expectRevert(IIntentVault.ZeroAddress.selector);
        new IntentVault(admin, IMerchantRegistry(address(0)), feeRecipient, FEE_BPS, REFUND_DELAY);
    }

    function test_ctor_revert_zeroFeeRecipient() public {
        vm.expectRevert(IIntentVault.ZeroAddress.selector);
        new IntentVault(admin, IMerchantRegistry(address(registry)), address(0), FEE_BPS, REFUND_DELAY);
    }

    function test_ctor_revert_feeAboveMax() public {
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.InvalidFee.selector, uint16(101)));
        new IntentVault(admin, IMerchantRegistry(address(registry)), feeRecipient, 101, REFUND_DELAY);
    }

    // ---------------- pause / unpause round trip ----------------

    /// A pause must be recoverable, otherwise the operator can brick payments permanently.
    function test_pause_thenUnpause_restoresPayments() public {
        vm.prank(admin);
        vault.pause();
        assertTrue(vault.paused(), "should be paused");

        vm.prank(admin);
        vault.unpause();
        assertFalse(vault.paused(), "should be unpaused");

        // a DIRECT payment works again after unpause
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("admin-inv"));
        vault.payDirect(p, inv, _merchantSig(inv), _payerSig(p), _auth(p));
        assertEq(uint8(vault.getIntent(vault.computeIntentId(p)).status), INTENT_SETTLED);
    }

    function test_unpause_revert_notPauser() public {
        vm.prank(admin);
        vault.pause();
        vm.prank(payer);
        vm.expectRevert();
        vault.unpause();
    }

    // ---------------- setRefundDelay ----------------

    function test_setRefundDelay_updatesAndEmits() public {
        vm.expectEmit(false, false, false, true, address(vault));
        emit IIntentVault.RefundDelayUpdated(7200);
        vm.prank(admin);
        vault.setRefundDelay(7200);
        assertEq(vault.refundDelay(), 7200);
    }

    function test_setRefundDelay_revert_notConfig() public {
        vm.prank(payer);
        vm.expectRevert();
        vault.setRefundDelay(7200);
    }

    // ---------------- zero-address guards on setters ----------------

    function test_setFee_revert_zeroRecipient() public {
        vm.prank(admin);
        vm.expectRevert(IIntentVault.ZeroAddress.selector);
        vault.setFee(10, address(0));
    }

    /// `setInputTokenAllowed` is the one config setter that DOES guard zero.
    function test_setInputTokenAllowed_revert_zeroToken() public {
        vm.prank(admin);
        vm.expectRevert(IIntentVault.ZeroAddress.selector);
        vault.setInputTokenAllowed(address(0), ROUTE_SWAP, true);
    }

    /// Documents actual behaviour: setAmountCap and setCrossChainInputToken accept address(0).
    /// Both are CONFIG_ROLE-only, so this is an admin footgun rather than an attack surface.
    /// setCrossChainInputToken(0) would make cross-chain commits fail later rather than at config time.
    function test_zeroAddress_acceptedBy_capAndCrossChainToken() public {
        vm.startPrank(admin);
        vault.setAmountCap(address(0), 1);
        assertEq(vault.amountCap(address(0)), 1, "cap on address(0) is accepted");
        vault.setCrossChainInputToken(address(0));
        assertEq(vault.crossChainInputToken(), address(0), "zero cross-chain token is accepted");
        vm.stopPrank();
    }
}
