// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {RegistryBase} from "./utils/RegistryBase.sol";
import {MockStableToken} from "../src/mocks/MockStableToken.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

contract MockStableTokenTest is RegistryBase {
    address internal receiver;

    function setUp() public override {
        super.setUp();
        receiver = makeAddr("receiver");
        vm.prank(admin);
        usdc.mint(payer, 100e6);
    }

    function _rwaDigest(address to, uint256 value, uint256 validBefore, bytes32 nonce) internal view returns (bytes32) {
        bytes32 structHash =
            keccak256(abi.encode(usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), payer, to, value, 0, validBefore, nonce));
        return keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
    }

    function test_metadata() public view {
        assertEq(usdc.decimals(), 6);
        assertEq(usdc.version(), "1");
        assertEq(usdc.name(), "ScanPay Test USDC");
        assertEq(
            usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
            0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8
        );
        assertEq(mon.decimals(), 18);
    }

    function test_mint_onlyMinter() public {
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, attacker, usdc.MINTER_ROLE())
        );
        vm.prank(attacker);
        usdc.mint(attacker, 1);
    }

    function test_receiveWithAuthorization_happy() public {
        bytes32 nonce = keccak256("n1");
        uint256 validBefore = block.timestamp + 60;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PAYER_PK, _rwaDigest(receiver, 10e6, validBefore, nonce));
        vm.prank(receiver);
        usdc.receiveWithAuthorization(payer, receiver, 10e6, 0, validBefore, nonce, v, r, s);
        assertEq(usdc.balanceOf(receiver), 10e6);
        assertTrue(usdc.authorizationState(payer, nonce));
    }

    function test_receiveWithAuthorization_revert_callerNotPayee() public {
        bytes32 nonce = keccak256("n1");
        uint256 validBefore = block.timestamp + 60;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PAYER_PK, _rwaDigest(receiver, 10e6, validBefore, nonce));
        vm.expectRevert(MockStableToken.CallerMustBePayee.selector);
        vm.prank(attacker); // front-runner can't steal the authorization
        usdc.receiveWithAuthorization(payer, receiver, 10e6, 0, validBefore, nonce, v, r, s);
    }

    function test_receiveWithAuthorization_revert_replay() public {
        bytes32 nonce = keccak256("n1");
        uint256 validBefore = block.timestamp + 60;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PAYER_PK, _rwaDigest(receiver, 1e6, validBefore, nonce));
        vm.startPrank(receiver);
        usdc.receiveWithAuthorization(payer, receiver, 1e6, 0, validBefore, nonce, v, r, s);
        vm.expectRevert(MockStableToken.AuthorizationAlreadyUsed.selector);
        usdc.receiveWithAuthorization(payer, receiver, 1e6, 0, validBefore, nonce, v, r, s);
        vm.stopPrank();
    }

    function test_receiveWithAuthorization_revert_expired() public {
        bytes32 nonce = keccak256("n1");
        uint256 validBefore = block.timestamp + 60;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PAYER_PK, _rwaDigest(receiver, 1e6, validBefore, nonce));
        vm.warp(validBefore);
        vm.expectRevert(MockStableToken.AuthorizationExpired.selector);
        vm.prank(receiver);
        usdc.receiveWithAuthorization(payer, receiver, 1e6, 0, validBefore, nonce, v, r, s);
    }

    function test_receiveWithAuthorization_revert_wrongValue() public {
        bytes32 nonce = keccak256("n1");
        uint256 validBefore = block.timestamp + 60;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PAYER_PK, _rwaDigest(receiver, 1e6, validBefore, nonce));
        vm.expectRevert(MockStableToken.InvalidAuthorizationSignature.selector);
        vm.prank(receiver);
        usdc.receiveWithAuthorization(payer, receiver, 2e6, 0, validBefore, nonce, v, r, s);
    }
}
