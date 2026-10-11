// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {RegistryBase} from "./utils/RegistryBase.sol";
import {IMerchantRegistry} from "../src/interfaces/IMerchantRegistry.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import "../src/libraries/ScanPayTypes.sol";

contract MerchantRegistryTest is RegistryBase {
    // ------------------------------------------------------------ registration

    function test_register_storesMerchantPending() public {
        bytes32 id = _register(SALT, address(usdc));
        assertEq(id, keccak256(abi.encode(owner, SALT)), "merchantId derivation");
        Merchant memory m = registry.getMerchant(id);
        assertEq(m.owner, owner);
        assertEq(m.payoutWallet, payoutWallet);
        assertEq(m.invoiceSigner, invoiceSigner);
        assertEq(m.payoutToken, address(usdc));
        assertEq(m.keyVersion, 1);
        assertEq(m.status, MERCHANT_PENDING);
        assertEq(m.registeredAt, T0);
        assertEq(m.metadataHash, PROFILE_HASH);
        assertEq(registry.ownerNonce(owner), 1);
    }

    function test_register_emitsEvents() public {
        Registration memory r = _registration(SALT, address(usdc), 0);
        bytes32 d = registry.hashRegistration(r);
        bytes32 id = registry.computeMerchantId(owner, SALT);

        vm.expectEmit(true, true, false, true, address(registry));
        emit IMerchantRegistry.MerchantRegistered(
            id, owner, SALT, payoutWallet, invoiceSigner, address(usdc), PROFILE_HASH
        );
        vm.expectEmit(true, true, false, true, address(registry));
        emit IMerchantRegistry.MerchantStatusChanged(id, MERCHANT_NONE, MERCHANT_PENDING, attacker);

        vm.prank(attacker); // any relayer may submit
        registry.registerMerchant(r, _sign(OWNER_PK, d), _sign(PAYOUT_PK, d));
    }

    function test_register_revert_expired() public {
        Registration memory r = _registration(SALT, address(usdc), 0);
        r.deadline = uint64(block.timestamp - 1);
        bytes32 d = registry.hashRegistration(r);
        vm.expectRevert(IMerchantRegistry.SignatureExpired.selector);
        registry.registerMerchant(r, _sign(OWNER_PK, d), _sign(PAYOUT_PK, d));
    }

    function test_register_revert_zeroAddress() public {
        Registration memory r = _registration(SALT, address(usdc), 0);
        r.invoiceSigner = address(0);
        bytes32 d = registry.hashRegistration(r);
        vm.expectRevert(IMerchantRegistry.ZeroAddress.selector);
        registry.registerMerchant(r, _sign(OWNER_PK, d), _sign(PAYOUT_PK, d));
    }

    function test_register_revert_tokenNotAllowed() public {
        Registration memory r = _registration(SALT, address(mon), 0);
        bytes32 d = registry.hashRegistration(r);
        vm.expectRevert(abi.encodeWithSelector(IMerchantRegistry.PayoutTokenNotAllowed.selector, address(mon)));
        registry.registerMerchant(r, _sign(OWNER_PK, d), _sign(PAYOUT_PK, d));
    }

    function test_register_revert_badNonce() public {
        Registration memory r = _registration(SALT, address(usdc), 5);
        bytes32 d = registry.hashRegistration(r);
        vm.expectRevert(abi.encodeWithSelector(IMerchantRegistry.BadNonce.selector, 0, 5));
        registry.registerMerchant(r, _sign(OWNER_PK, d), _sign(PAYOUT_PK, d));
    }

    function test_register_revert_replaySameSignedMessage() public {
        Registration memory r = _registration(SALT, address(usdc), 0);
        bytes32 d = registry.hashRegistration(r);
        bytes memory o = _sign(OWNER_PK, d);
        bytes memory p = _sign(PAYOUT_PK, d);
        registry.registerMerchant(r, o, p);
        vm.expectRevert(abi.encodeWithSelector(IMerchantRegistry.BadNonce.selector, 1, 0));
        registry.registerMerchant(r, o, p);
    }

    function test_register_revert_duplicateMerchant() public {
        _register(SALT, address(usdc));
        Registration memory r = _registration(SALT, address(usdc), 1); // fresh nonce, same salt
        bytes32 d = registry.hashRegistration(r);
        bytes32 id = registry.computeMerchantId(owner, SALT);
        vm.expectRevert(abi.encodeWithSelector(IMerchantRegistry.MerchantAlreadyExists.selector, id));
        registry.registerMerchant(r, _sign(OWNER_PK, d), _sign(PAYOUT_PK, d));
    }

    function test_register_revert_ownerSigFromWrongKey() public {
        Registration memory r = _registration(SALT, address(usdc), 0);
        bytes32 d = registry.hashRegistration(r);
        vm.expectRevert(IMerchantRegistry.InvalidOwnerSignature.selector);
        registry.registerMerchant(r, _sign(ATTACKER_PK, d), _sign(PAYOUT_PK, d));
    }

    function test_register_revert_payoutSigMissing() public {
        // Proves an attacker can't register someone else's wallet as payout without that wallet's signature.
        Registration memory r = _registration(SALT, address(usdc), 0);
        bytes32 d = registry.hashRegistration(r);
        vm.expectRevert(IMerchantRegistry.InvalidPayoutSignature.selector);
        registry.registerMerchant(r, _sign(OWNER_PK, d), _sign(OWNER_PK, d));
    }

    function test_register_revert_tamperedAfterSigning() public {
        Registration memory r = _registration(SALT, address(usdc), 0);
        bytes32 d = registry.hashRegistration(r);
        bytes memory o = _sign(OWNER_PK, d);
        bytes memory p = _sign(PAYOUT_PK, d);
        r.payoutWallet = attacker; // relayer swaps payout wallet
        vm.expectRevert(IMerchantRegistry.InvalidOwnerSignature.selector);
        registry.registerMerchant(r, o, p);
    }

    // ------------------------------------------------------------ status

    function test_status_verifierApproves() public {
        bytes32 id = _register(SALT, address(usdc));
        vm.expectEmit(true, true, false, true, address(registry));
        emit IMerchantRegistry.MerchantStatusChanged(id, MERCHANT_PENDING, MERCHANT_ACTIVE, operator);
        vm.prank(operator);
        registry.setMerchantStatus(id, MERCHANT_ACTIVE);
        assertEq(registry.getMerchant(id).status, MERCHANT_ACTIVE);
    }

    function test_status_revert_notVerifier() public {
        bytes32 id = _register(SALT, address(usdc));
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, attacker, registry.VERIFIER_ROLE()
            )
        );
        vm.prank(attacker);
        registry.setMerchantStatus(id, MERCHANT_ACTIVE);
    }

    function test_status_revert_unknownMerchant() public {
        vm.expectRevert(abi.encodeWithSelector(IMerchantRegistry.MerchantNotFound.selector, bytes32(uint256(1))));
        vm.prank(operator);
        registry.setMerchantStatus(bytes32(uint256(1)), MERCHANT_ACTIVE);
    }

    function test_status_fullLifecycle() public {
        bytes32 id = _registerAndApprove(SALT, address(usdc));
        vm.startPrank(operator);
        registry.setMerchantStatus(id, MERCHANT_SUSPENDED);
        registry.setMerchantStatus(id, MERCHANT_ACTIVE);
        registry.setMerchantStatus(id, MERCHANT_REVOKED);
        vm.expectRevert(
            abi.encodeWithSelector(IMerchantRegistry.InvalidStatusTransition.selector, MERCHANT_REVOKED, MERCHANT_ACTIVE)
        );
        registry.setMerchantStatus(id, MERCHANT_ACTIVE);
        vm.stopPrank();
    }

    function test_status_revert_pendingToSuspended() public {
        bytes32 id = _register(SALT, address(usdc));
        vm.expectRevert(
            abi.encodeWithSelector(
                IMerchantRegistry.InvalidStatusTransition.selector, MERCHANT_PENDING, MERCHANT_SUSPENDED
            )
        );
        vm.prank(operator);
        registry.setMerchantStatus(id, MERCHANT_SUSPENDED);
    }

    function test_status_revert_toNoneOrUnknownValue() public {
        bytes32 id = _registerAndApprove(SALT, address(usdc));
        vm.startPrank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(IMerchantRegistry.InvalidStatusTransition.selector, MERCHANT_ACTIVE, MERCHANT_NONE)
        );
        registry.setMerchantStatus(id, MERCHANT_NONE);
        vm.expectRevert(abi.encodeWithSelector(IMerchantRegistry.InvalidStatusTransition.selector, MERCHANT_ACTIVE, 9));
        registry.setMerchantStatus(id, 9);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ rotation

    function test_rotate_bumpsKeyVersion() public {
        bytes32 id = _registerAndApprove(SALT, address(usdc));
        vm.expectEmit(true, false, false, true, address(registry));
        emit IMerchantRegistry.InvoiceSignerRotated(id, vm.addr(SIGNER2_PK), 2);
        _rotate(id, SIGNER2_PK);
        Merchant memory m = registry.getMerchant(id);
        assertEq(m.invoiceSigner, vm.addr(SIGNER2_PK));
        assertEq(m.keyVersion, 2);
        assertEq(registry.ownerNonce(owner), 2);
    }

    function test_rotate_revert_notOwnerSig() public {
        bytes32 id = _registerAndApprove(SALT, address(usdc));
        SignerRotation memory r = SignerRotation(id, attacker, 1, uint64(block.timestamp + 60));
        bytes32 d = registry.hashSignerRotation(r);
        vm.expectRevert(IMerchantRegistry.InvalidOwnerSignature.selector);
        registry.rotateInvoiceSigner(r, _sign(SIGNER_PK, d)); // invoice key may NOT rotate itself
    }

    function test_rotate_revert_revoked() public {
        bytes32 id = _registerAndApprove(SALT, address(usdc));
        vm.prank(operator);
        registry.setMerchantStatus(id, MERCHANT_REVOKED);
        SignerRotation memory r = SignerRotation(id, vm.addr(SIGNER2_PK), 1, uint64(block.timestamp + 60));
        bytes32 d = registry.hashSignerRotation(r);
        vm.expectRevert(abi.encodeWithSelector(IMerchantRegistry.MerchantIsRevoked.selector, id));
        registry.rotateInvoiceSigner(r, _sign(OWNER_PK, d));
    }

    function test_rotate_allowedWhileSuspended() public {
        bytes32 id = _registerAndApprove(SALT, address(usdc));
        vm.prank(operator);
        registry.setMerchantStatus(id, MERCHANT_SUSPENDED);
        _rotate(id, SIGNER2_PK); // suspended merchant can rotate a leaked key before being re-activated
        assertEq(registry.getMerchant(id).keyVersion, 2);
    }

    // ------------------------------------------------------------ payout update

    function test_updatePayout_requiresNewWalletSig() public {
        bytes32 id = _registerAndApprove(SALT, address(usdc));
        address newWallet = vm.addr(PAYOUT2_PK);
        PayoutUpdate memory u = PayoutUpdate(id, newWallet, address(ausd), 1, uint64(block.timestamp + 60));
        bytes32 d = registry.hashPayoutUpdate(u);

        vm.expectRevert(IMerchantRegistry.InvalidPayoutSignature.selector);
        registry.updatePayout(u, _sign(OWNER_PK, d), _sign(PAYOUT_PK, d)); // old wallet's sig is not enough

        vm.expectEmit(true, false, false, true, address(registry));
        emit IMerchantRegistry.PayoutUpdated(id, newWallet, address(ausd), 2);
        registry.updatePayout(u, _sign(OWNER_PK, d), _sign(PAYOUT2_PK, d));

        Merchant memory m = registry.getMerchant(id);
        assertEq(m.payoutWallet, newWallet);
        assertEq(m.payoutToken, address(ausd));
        assertEq(m.keyVersion, 2);
    }

    function test_updatePayout_revert_tokenNotAllowed() public {
        bytes32 id = _registerAndApprove(SALT, address(usdc));
        PayoutUpdate memory u = PayoutUpdate(id, payoutWallet, address(mon), 1, uint64(block.timestamp + 60));
        bytes32 d = registry.hashPayoutUpdate(u);
        vm.expectRevert(abi.encodeWithSelector(IMerchantRegistry.PayoutTokenNotAllowed.selector, address(mon)));
        registry.updatePayout(u, _sign(OWNER_PK, d), _sign(PAYOUT_PK, d));
    }

    // ------------------------------------------------------------ config + views

    function test_setPayoutTokenAllowed_onlyConfig() public {
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, attacker, registry.CONFIG_ROLE())
        );
        vm.prank(attacker);
        registry.setPayoutTokenAllowed(address(mon), true);

        vm.expectEmit(true, false, false, true, address(registry));
        emit IMerchantRegistry.PayoutTokenAllowed(address(mon), true);
        vm.prank(admin);
        registry.setPayoutTokenAllowed(address(mon), true);
        assertTrue(registry.isPayoutTokenAllowed(address(mon)));
    }

    function test_getMerchant_unknownReturnsZero() public view {
        Merchant memory m = registry.getMerchant(keccak256("nope"));
        assertEq(m.status, MERCHANT_NONE);
        assertEq(m.owner, address(0));
    }

    function test_hashRegistration_matchesManualDigest() public view {
        Registration memory r = _registration(SALT, address(usdc), 0);
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ScanPayRegistry"),
                keccak256("1"),
                block.chainid,
                address(registry)
            )
        );
        bytes32 expected = keccak256(abi.encodePacked("\x19\x01", domain, ScanPayTypes.hashRegistration(r)));
        assertEq(registry.hashRegistration(r), expected);
    }
}
