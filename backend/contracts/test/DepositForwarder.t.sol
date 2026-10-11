// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {DepositForwarder} from "../src/DepositForwarder.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

contract DepositForwarderTest is Test {
    DepositForwarder internal impl;
    MockERC20 internal token;
    address internal to = makeAddr("to");

    function setUp() public {
        impl = new DepositForwarder(address(this)); // this test contract plays "vault"
        token = new MockERC20("T", "T", 6, address(this));
    }

    function test_clone_predictableAndSweepable() public {
        bytes32 salt = keccak256("intent-1");
        address predicted = Clones.predictDeterministicAddress(address(impl), salt, address(this));

        token.mint(predicted, 5e6); // deposit BEFORE the clone exists (Aurora may be faster than commit)
        address clone = Clones.cloneDeterministic(address(impl), salt);
        assertEq(clone, predicted);
        assertEq(DepositForwarder(clone).vault(), address(this));

        uint256 moved = DepositForwarder(clone).sweep(address(token), to);
        assertEq(moved, 5e6);
        assertEq(token.balanceOf(to), 5e6);
        assertEq(token.balanceOf(clone), 0);
    }

    function test_sweep_onlyVault() public {
        address clone = Clones.cloneDeterministic(address(impl), keccak256("x"));
        vm.prank(makeAddr("attacker"));
        vm.expectRevert(DepositForwarder.OnlyVault.selector);
        DepositForwarder(clone).sweep(address(token), to);
    }

    function test_sweep_zeroBalanceIsNoop() public {
        address clone = Clones.cloneDeterministic(address(impl), keccak256("y"));
        assertEq(DepositForwarder(clone).sweep(address(token), to), 0);
    }

    function test_nativeTransferReverts() public {
        address clone = Clones.cloneDeterministic(address(impl), keccak256("z"));
        vm.deal(address(this), 1 ether);
        (bool ok,) = clone.call{value: 1}("");
        assertFalse(ok);
    }
}
