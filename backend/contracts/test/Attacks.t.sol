// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VaultBase} from "./utils/VaultBase.sol";
import {ReentrantAdapter} from "./utils/ReentrantAdapter.sol";
import {IIntentVault} from "../src/interfaces/IIntentVault.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../src/libraries/ScanPayTypes.sol";

contract AttacksTest is VaultBase {
    function test_attack_tamper_amount() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("a1"));
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);

        // (a) only the intent amount changes
        PaymentIntent memory p1 = p;
        p1.amountOut = AMOUNT * 10;
        vm.expectRevert(IIntentVault.AmountMismatch.selector);
        vault.payDirect(p1, inv, ms, ps, a);

        // (b) both change -> merchant signature breaks
        Invoice memory inv2 = inv;
        inv2.amount = AMOUNT * 10;
        p1.maxAmountIn = AMOUNT * 10;
        vm.expectRevert(IIntentVault.InvalidMerchantSignature.selector);
        vault.payDirect(p1, inv2, ms, ps, a);
    }

    function test_attack_tamper_destination() public {
        // A forged/edited QR can't carry a destination: the intent has no payout field, the vault reads the
        // registry. Even an attacker-relayed payment lands in the registered payout wallet.
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("a2"));
        vm.prank(attacker);
        bytes32 id = _payDirect(inv, p);
        assertEq(vault.getIntent(id).payoutWallet, payoutWallet);
        assertEq(usdc.balanceOf(attacker), 0);
        assertEq(usdc.balanceOf(payoutWallet), AMOUNT - FEE);
    }

    function test_attack_replay() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("a3"));
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        vault.payDirect(p, inv, ms, ps, a);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.NonceAlreadyUsed.selector, payer, p.nonce));
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_attack_expired() public {
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256("a4"));
        inv.expiresAt = uint64(block.timestamp - 1);
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        vm.expectRevert(IIntentVault.InvoiceExpired.selector);
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_attack_unregistered_qr() public {
        bytes32 fakeMerchant = keccak256(abi.encode(attacker, bytes32("fake-shop")));
        Invoice memory inv = _invoiceFor(fakeMerchant, keccak256("a5"), address(usdc), AMOUNT);
        inv.keyVersion = 1;
        PaymentIntent memory p = _intent(inv, ROUTE_DIRECT, address(usdc), AMOUNT);
        bytes memory ms = _sign(ATTACKER_PK, vault.hashInvoice(inv));
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.MerchantNotActive.selector, fakeMerchant, MERCHANT_NONE));
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_attack_fake_provider_success() public {
        Invoice memory inv = _invoice(keccak256("a6"));
        PaymentIntent memory p = _intent(inv, ROUTE_CROSSCHAIN, address(usdc), AMOUNT);
        (bytes32 id,) = vault.commitCrossChain(p, inv, _merchantSig(inv), _payerSig(p));
        // Backend B receives a "SUCCESS" webhook. There is no function that accepts it. Settle needs funds:
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.Underpaid.selector, 0, AMOUNT));
        vault.settleCrossChain(id, "");
        assertEq(vault.getIntent(id).status, INTENT_COMMITTED);
    }

    function test_attack_forged_settlement_hash() public {
        Invoice memory inv = _invoice(keccak256("a7"));
        PaymentIntent memory p = _intent(inv, ROUTE_CROSSCHAIN, address(usdc), AMOUNT);
        (bytes32 id,) = vault.commitCrossChain(p, inv, _merchantSig(inv), _payerSig(p));

        vm.prank(attacker);
        vm.expectRevert(); // not ATTESTER_ROLE
        vault.attestSource(id, 8453, keccak256("forged"), bytes32(0));

        vm.prank(operator); // even the legit attester can't settle by attesting
        vault.attestSource(id, 8453, keccak256("real"), bytes32(0));
        assertEq(vault.getIntent(id).status, INTENT_COMMITTED);
        assertEq(usdc.balanceOf(payoutWallet), 0);
    }

    function test_attack_wrong_token() public {
        Invoice memory inv = _invoice(keccak256("a8"));
        PaymentIntent memory p = _intent(inv, ROUTE_DIRECT, address(ausd), AMOUNT);
        p.payoutToken = address(ausd);
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);
        vm.expectRevert(IIntentVault.PayoutTokenMismatch.selector);
        vault.payDirect(p, inv, ms, ps, a);
    }

    function test_attack_cross_merchant_signature() public {
        bytes32 m2 = _registerAndApprove(keccak256("shop-2"), address(usdc));
        (Invoice memory inv1, PaymentIntent memory p1) = _direct(keccak256("a9"));
        bytes memory ps1 = _payerSig(p1);

        Invoice memory inv2 = _invoiceFor(m2, inv1.invoiceId, address(usdc), AMOUNT);
        PaymentIntent memory p2 = p1;
        p2.merchantId = m2;
        bytes memory ms2 = _merchantSig(inv2);
        Auth3009 memory a = _auth(p2);
        vm.expectRevert(IIntentVault.InvalidPayerSignature.selector);
        vault.payDirect(p2, inv2, ms2, ps1, a);
    }

    function test_attack_reentrancy() public {
        bytes32 m2 = _registerAndApprove(keccak256("shop-ausd"), address(ausd));
        ReentrantAdapter evil = new ReentrantAdapter(address(vault));
        vm.startPrank(admin);
        ausd.mint(address(evil), 1_000e6);
        vault.setSwapAdapter(address(evil));
        vm.stopPrank();

        Invoice memory inv = _invoiceFor(m2, keccak256("a10"), address(ausd), AMOUNT);
        PaymentIntent memory p = _intent(inv, ROUTE_CROSSCHAIN, address(usdc), AMOUNT);
        (bytes32 id, address fwd) = vault.commitCrossChain(p, inv, _merchantSig(inv), _payerSig(p));
        vm.prank(admin);
        usdc.mint(fwd, AMOUNT);
        evil.setTarget(id);

        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        vault.settleCrossChain(id, "");
    }
}
