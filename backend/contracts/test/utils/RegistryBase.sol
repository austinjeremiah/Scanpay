// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import "../../src/libraries/ScanPayTypes.sol";
import {MerchantRegistry} from "../../src/MerchantRegistry.sol";
import {MockStableToken} from "../../src/mocks/MockStableToken.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";

abstract contract RegistryBase is Test {
    // Deterministic test keys (never used outside tests)
    uint256 internal constant OWNER_PK = 0xC0FFEE;
    uint256 internal constant PAYOUT_PK = 0xBEEF01;
    uint256 internal constant SIGNER_PK = 0xB0B;
    uint256 internal constant SIGNER2_PK = 0xB0B2;
    uint256 internal constant PAYOUT2_PK = 0xBEEF02;
    uint256 internal constant PAYER_PK = 0xA11CE;
    uint256 internal constant ATTACKER_PK = 0xBAD;

    uint64 internal constant T0 = 1_760_000_000; // 2025-10-09, any fixed time works
    bytes32 internal constant SALT = keccak256("shop-1");
    bytes32 internal constant PROFILE_HASH = keccak256("profile-v1");

    address internal admin;
    address internal operator;
    address internal feeRecipient;
    address internal owner;
    address internal payoutWallet;
    address internal invoiceSigner;
    address internal payer;
    address internal attacker;

    MerchantRegistry internal registry;
    MockStableToken internal usdc;
    MockStableToken internal ausd;
    MockERC20 internal mon;

    function setUp() public virtual {
        vm.warp(T0);
        admin = makeAddr("admin");
        operator = makeAddr("operator");
        feeRecipient = makeAddr("feeRecipient");
        owner = vm.addr(OWNER_PK);
        payoutWallet = vm.addr(PAYOUT_PK);
        invoiceSigner = vm.addr(SIGNER_PK);
        payer = vm.addr(PAYER_PK);
        attacker = vm.addr(ATTACKER_PK);

        vm.startPrank(admin);
        registry = new MerchantRegistry(admin);
        usdc = new MockStableToken("ScanPay Test USDC", "tUSDC", 6, admin);
        ausd = new MockStableToken("ScanPay Test AUSD", "tAUSD", 6, admin);
        mon = new MockERC20("ScanPay Test MON", "tMON", 18, admin);
        registry.setPayoutTokenAllowed(address(usdc), true);
        registry.setPayoutTokenAllowed(address(ausd), true);
        registry.grantRole(registry.VERIFIER_ROLE(), operator);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- signing helpers

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _registration(bytes32 salt, address token, uint256 nonce) internal view returns (Registration memory) {
        return Registration({
            owner: owner,
            salt: salt,
            payoutWallet: payoutWallet,
            invoiceSigner: invoiceSigner,
            payoutToken: token,
            metadataHash: PROFILE_HASH,
            nonce: nonce,
            deadline: uint64(block.timestamp + 1 hours)
        });
    }

    function _register(bytes32 salt, address token) internal returns (bytes32 id) {
        Registration memory r = _registration(salt, token, registry.ownerNonce(owner));
        bytes32 d = registry.hashRegistration(r);
        id = registry.registerMerchant(r, _sign(OWNER_PK, d), _sign(PAYOUT_PK, d));
    }

    function _registerAndApprove(bytes32 salt, address token) internal returns (bytes32 id) {
        id = _register(salt, token);
        vm.prank(operator);
        registry.setMerchantStatus(id, MERCHANT_ACTIVE);
    }

    function _rotate(bytes32 id, uint256 newSignerPk) internal {
        SignerRotation memory r = SignerRotation({
            merchantId: id,
            newSigner: vm.addr(newSignerPk),
            nonce: registry.ownerNonce(owner),
            deadline: uint64(block.timestamp + 1 hours)
        });
        registry.rotateInvoiceSigner(r, _sign(OWNER_PK, registry.hashSignerRotation(r)));
    }
}
