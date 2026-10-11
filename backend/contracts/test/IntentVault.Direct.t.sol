// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VaultBase} from "./utils/VaultBase.sol";
import {IIntentVault} from "../src/interfaces/IIntentVault.sol";
import {MockStableToken} from "../src/mocks/MockStableToken.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import "../src/libraries/ScanPayTypes.sol";

contract IntentVaultDirectTest is VaultBase {
    function test_direct_happyPath_balancesAndRecord() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        uint256 payerBefore = usdc.balanceOf(payer);

        vm.prank(operator); // relayer
        bytes32 id = _payDirect(inv, p);

        assertEq(id, vault.computeIntentId(p));
        assertEq(usdc.balanceOf(payer), payerBefore - AMOUNT, "payer debited exactly amountOut");
        assertEq(usdc.balanceOf(payoutWallet), AMOUNT - FEE, "merchant net");
        assertEq(usdc.balanceOf(feeRecipient), FEE, "fee");
        assertEq(usdc.balanceOf(address(vault)), 0, "vault holds nothing");

        IntentRecord memory r = vault.getIntent(id);
        assertEq(r.status, INTENT_SETTLED);
        assertEq(r.route, ROUTE_DIRECT);
        assertEq(r.payoutWallet, payoutWallet);
        assertEq(r.fee, FEE);
        assertEq(r.inputAmount, AMOUNT);
        assertEq(r.settledAt, block.timestamp);
        assertEq(vault.invoiceState(merchantId, inv.invoiceId), INVOICE_PAID);
        assertTrue(vault.usedNonce(payer, p.nonce));
        assertTrue(usdc.authorizationState(payer, vault.hashIntent(p)), "3009 nonce == intent digest");
    }

    function test_direct_emitsCommittedThenSettled() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        bytes32 id = vault.computeIntentId(p);

        vm.expectEmit(true, true, true, true, address(vault));
        emit IIntentVault.IntentCommitted(
            id, merchantId, payer, inv.invoiceId, ROUTE_DIRECT, address(usdc), address(usdc), AMOUNT,
            address(0), payoutWallet, p.expiresAt, bytes32(0)
        );
        vm.expectEmit(true, true, true, true, address(vault));
        emit IIntentVault.PaymentSettled(
            id, merchantId, payer, inv.invoiceId, ROUTE_DIRECT, address(usdc), AMOUNT, FEE, payoutWallet,
            address(usdc), AMOUNT, 0
        );
        _payDirect(inv, p);
    }

    function test_direct_maliciousRelayerCannotRedirect() public {
        // The relayer is the attacker here; funds still land in the registry's payout wallet.
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        vm.prank(attacker);
        _payDirect(inv, p);
        assertEq(usdc.balanceOf(attacker), 0);
        assertEq(usdc.balanceOf(payoutWallet), AMOUNT - FEE);
    }

    function test_direct_zeroFee() public {
        vm.prank(admin);
        vault.setFee(0, feeRecipient);
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        _payDirect(inv, p);
        assertEq(usdc.balanceOf(payoutWallet), AMOUNT);
        assertEq(usdc.balanceOf(feeRecipient), 0);
    }

    function test_direct_ausdMerchant() public {
        bytes32 m2 = _registerAndApprove(keccak256("shop-ausd"), address(ausd));
        Invoice memory inv = _invoiceFor(m2, keccak256("a-1"), address(ausd), AMOUNT);
        PaymentIntent memory p = _intent(inv, ROUTE_DIRECT, address(ausd), AMOUNT);
        _payDirect(inv, p);
        assertEq(ausd.balanceOf(payoutWallet), AMOUNT - FEE);
    }

    // ------------------------------------------------------------ one-time use

    function test_direct_revert_replaySameIntent() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        vault.payDirect(p, inv, ms, ps, a);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.NonceAlreadyUsed.selector, payer, p.nonce));
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_direct_revert_invoicePaidTwice() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        _payDirect(inv, p);
        PaymentIntent memory p2 = _intent(inv, ROUTE_DIRECT, address(usdc), AMOUNT); // fresh nonce
        Auth3009 memory a2 = _auth(p2);
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p2);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.InvoiceNotOpen.selector, INVOICE_PAID));
        vault.payDirect(p2, inv, ms, ps, a2);
    }

    // ------------------------------------------------------------ tampering

    function test_direct_revert_tamperedAmountInIntentOnly() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        p.amountOut = 1;
        vm.expectRevert(IIntentVault.AmountMismatch.selector);
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_direct_revert_tamperedAmountBoth() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        inv.amount = 1;
        p.amountOut = 1;
        p.maxAmountIn = 1;
        vm.expectRevert(IIntentVault.InvalidMerchantSignature.selector);
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_direct_revert_tamperedRefundTo() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        p.refundTo = attacker;
        vm.expectRevert(IIntentVault.InvalidPayerSignature.selector);
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_direct_revert_invoiceSignedByAttacker() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        bytes memory forged = _sign(ATTACKER_PK, vault.hashInvoice(inv));
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        vm.expectRevert(IIntentVault.InvalidMerchantSignature.selector);
        vault.payDirect(p, inv, forged, ps, a);
    }

    function test_direct_revert_badAuthorization() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        Auth3009 memory a = _auth(p);
        a.s = bytes32(uint256(a.s) ^ 1);
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        vm.expectRevert(); // token-level error (InvalidAuthorizationSignature or ECDSA) -> TOKEN_AUTHORIZATION_FAILED
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_direct_revert_wrongRoute() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        p.route = ROUTE_SWAP;
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.RouteMismatch.selector, ROUTE_DIRECT, ROUTE_SWAP));
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_direct_revert_inputDiffersFromPayout() public {
        Invoice memory inv = _invoice(keccak256("inv-1"));
        PaymentIntent memory p = _intent(inv, ROUTE_DIRECT, address(ausd), AMOUNT); // ausd is DIRECT-allowed
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.InputTokenNotAllowed.selector, address(ausd), ROUTE_DIRECT));
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_direct_revert_maxAmountInBelowAmount() public {
        Invoice memory inv = _invoice(keccak256("inv-1"));
        PaymentIntent memory p = _intent(inv, ROUTE_DIRECT, address(usdc), AMOUNT - 1);
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        vm.expectRevert(IIntentVault.AmountMismatch.selector);
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_direct_revert_payoutTokenNotMerchants() public {
        Invoice memory inv = _invoiceFor(merchantId, keccak256("inv-1"), address(ausd), AMOUNT); // merchant wants USDC
        PaymentIntent memory p = _intent(inv, ROUTE_DIRECT, address(ausd), AMOUNT);
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        vm.expectRevert(IIntentVault.PayoutTokenMismatch.selector);
        vault.payDirect(p, inv, ms, ps, a);
    }

    // ------------------------------------------------------------ time + merchant state

    function test_direct_revert_invoiceExpired() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        vm.warp(inv.expiresAt + 1);
        vm.expectRevert(IIntentVault.InvoiceExpired.selector);
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_direct_revert_intentExpired() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        vm.warp(p.expiresAt + 1); // intent (10 min) expires before invoice (15 min)
        vm.expectRevert(IIntentVault.IntentExpired.selector);
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_direct_revert_merchantSuspended() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        vm.prank(operator);
        registry.setMerchantStatus(merchantId, MERCHANT_SUSPENDED);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.MerchantNotActive.selector, merchantId, MERCHANT_SUSPENDED));
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_direct_revert_unregisteredMerchant() public {
        bytes32 fakeId = keccak256("not-registered");
        Invoice memory inv = _invoiceFor(fakeId, keccak256("inv-1"), address(usdc), AMOUNT);
        PaymentIntent memory p = _intent(inv, ROUTE_DIRECT, address(usdc), AMOUNT);
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.MerchantNotActive.selector, fakeId, MERCHANT_NONE));
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_direct_revert_keyRotatedInvalidatesOldInvoice() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        _rotate(merchantId, SIGNER2_PK);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.KeyVersionMismatch.selector, uint32(2), uint32(1)));
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_direct_afterRotation_newKeyWorks_oldKeyFails() public {
        _rotate(merchantId, SIGNER2_PK);
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-2")); // keyVersion 2
        bytes memory oldSig = _sign(SIGNER_PK, vault.hashInvoice(inv));
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        vm.expectRevert(IIntentVault.InvalidMerchantSignature.selector);
        vault.payDirect(p, inv, oldSig, ps, a);
        vault.payDirect(p, inv, _sign(SIGNER2_PK, vault.hashInvoice(inv)), ps, a);
        assertEq(usdc.balanceOf(payoutWallet), AMOUNT - FEE);
    }

    function test_direct_revert_payoutTokenDelisted() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        vm.prank(admin);
        registry.setPayoutTokenAllowed(address(usdc), false);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.PayoutTokenNotAllowed.selector, address(usdc)));
        vault.payDirect(p, inv, ms, ps, a);
    }

    // ------------------------------------------------------------ config guards

    function test_direct_revert_aboveCap() public {
        vm.prank(admin);
        vault.setAmountCap(address(usdc), 10e6);
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.AmountAboveCap.selector, AMOUNT, 10e6));
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_direct_revert_inputNotAllowed() public {
        vm.prank(admin);
        vault.setInputTokenAllowed(address(usdc), ROUTE_DIRECT, false);
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.InputTokenNotAllowed.selector, address(usdc), ROUTE_DIRECT));
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_direct_revert_paused() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        vm.prank(admin);
        vault.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_setFee_revert_aboveMax() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.InvalidFee.selector, uint16(101)));
        vault.setFee(101, feeRecipient);
    }

    function test_setInputTokenAllowed_revert_crosschainRoute() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.RouteMismatch.selector, ROUTE_SWAP, ROUTE_CROSSCHAIN));
        vault.setInputTokenAllowed(address(usdc), ROUTE_CROSSCHAIN, true);
    }

    function test_views_isInputTokenAllowed() public view {
        assertTrue(vault.isInputTokenAllowed(address(usdc), ROUTE_DIRECT));
        assertTrue(vault.isInputTokenAllowed(address(mon), ROUTE_SWAP));
        assertFalse(vault.isInputTokenAllowed(address(mon), ROUTE_DIRECT));
        assertTrue(vault.isInputTokenAllowed(address(usdc), ROUTE_CROSSCHAIN));
        assertFalse(vault.isInputTokenAllowed(address(ausd), ROUTE_CROSSCHAIN));
    }

    function test_hashIntent_matchesManual() public {
        (, PaymentIntent memory p) = _direct(keccak256("inv-1"));
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ScanPayGuard"),
                keccak256("1"),
                block.chainid,
                address(vault)
            )
        );
        assertEq(vault.hashIntent(p), keccak256(abi.encodePacked("\x19\x01", domain, ScanPayTypes.hashIntent(p))));
    }
}
