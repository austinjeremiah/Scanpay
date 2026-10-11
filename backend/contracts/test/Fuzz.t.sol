// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VaultBase} from "./utils/VaultBase.sol";
import {IIntentVault} from "../src/interfaces/IIntentVault.sol";
import "../src/libraries/ScanPayTypes.sol";

contract FuzzTest is VaultBase {
    function testFuzz_direct_anyAmount_feeSplitExact(uint256 amount, uint16 fee) public {
        amount = bound(amount, 1, 1_000e6);
        fee = uint16(bound(fee, 0, 100));
        vm.prank(admin);
        vault.setFee(fee, feeRecipient);

        Invoice memory inv = _invoiceFor(merchantId, keccak256(abi.encode(amount, fee)), address(usdc), amount);
        PaymentIntent memory p = _intent(inv, ROUTE_DIRECT, address(usdc), amount);
        bytes32 id = _payDirect(inv, p);

        uint256 expectedFee = (amount * fee) / 10_000;
        assertEq(usdc.balanceOf(payoutWallet), amount - expectedFee);
        assertEq(usdc.balanceOf(feeRecipient), expectedFee);
        assertEq(usdc.balanceOf(payoutWallet) + usdc.balanceOf(feeRecipient), amount);
        assertEq(vault.getIntent(id).fee, expectedFee);
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    function testFuzz_crossChain_anyOverDeposit(uint256 extra) public {
        extra = bound(extra, 0, 1_000_000e6);
        Invoice memory inv = _invoice(keccak256(abi.encode("cc", extra)));
        PaymentIntent memory p = _intent(inv, ROUTE_CROSSCHAIN, address(usdc), AMOUNT);
        (bytes32 id, address fwd) = vault.commitCrossChain(p, inv, _merchantSig(inv), _payerSig(p));
        vm.prank(admin);
        usdc.mint(fwd, AMOUNT + extra);
        uint256 payerBefore = usdc.balanceOf(payer);
        vault.settleCrossChain(id, "");
        assertEq(usdc.balanceOf(payer) - payerBefore, extra);
        assertEq(usdc.balanceOf(payoutWallet), AMOUNT - FEE);
        assertEq(usdc.balanceOf(address(vault)), 0);
        assertEq(usdc.balanceOf(fwd), 0);
    }

    function testFuzz_crossChain_underDepositAlwaysReverts(uint256 dep) public {
        dep = bound(dep, 0, AMOUNT - 1);
        Invoice memory inv = _invoice(keccak256(abi.encode("under", dep)));
        PaymentIntent memory p = _intent(inv, ROUTE_CROSSCHAIN, address(usdc), AMOUNT);
        (bytes32 id, address fwd) = vault.commitCrossChain(p, inv, _merchantSig(inv), _payerSig(p));
        vm.prank(admin);
        usdc.mint(fwd, dep);
        vm.expectRevert(abi.encodeWithSelector(IIntentVault.Underpaid.selector, dep, AMOUNT));
        vault.settleCrossChain(id, "");
    }

    /// Changing ANY single signed intent field after signing must revert (never pay).
    function testFuzz_tamperAnyIntentField(uint8 field, uint256 noise) public {
        field = uint8(bound(field, 0, 12));
        noise = bound(noise, 1, type(uint64).max);
        (Invoice memory inv, PaymentIntent memory p) = _direct(keccak256(abi.encode("t", field, noise)));
        bytes memory ms = _merchantSig(inv);
        bytes memory ps = _payerSig(p);
        Auth3009 memory a = _auth(p);

        if (field == 0) p.merchantId = bytes32(uint256(p.merchantId) ^ noise);
        else if (field == 1) p.invoiceId = bytes32(uint256(p.invoiceId) ^ noise);
        else if (field == 2) p.payer = address(uint160(uint160(p.payer) ^ uint160(noise)));
        else if (field == 3) p.payoutToken = address(ausd);
        else if (field == 4) p.amountOut = p.amountOut + noise;
        else if (field == 5) p.route = ROUTE_SWAP;
        else if (field == 6) p.inputToken = address(mon);
        else if (field == 7) p.maxAmountIn = p.maxAmountIn + noise;
        else if (field == 8) p.quoteHash = bytes32(noise);
        else if (field == 9) p.refundTo = address(uint160(noise));
        else if (field == 10) p.expiresAt = p.expiresAt + uint64(noise % 1000) + 1;
        else if (field == 11) p.nonce = p.nonce + noise;
        else p.keyVersion = p.keyVersion + 1;

        uint256 before = usdc.balanceOf(payoutWallet);
        vm.expectRevert();
        vault.payDirect(p, inv, ms, ps, a);
        assertEq(usdc.balanceOf(payoutWallet), before);
    }
}
