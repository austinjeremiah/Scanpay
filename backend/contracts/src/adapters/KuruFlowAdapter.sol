// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";

/// @title KuruFlowAdapter — executes a Kuru Flow aggregator quote on behalf of IntentVault (mainnet)
/// @notice swapData = abi.encode(address target, bytes callData) where target/callData come from Kuru /api/quote
///         generated with userAddress = this adapter. Only allow-listed targets may be called.
contract KuruFlowAdapter is ISwapAdapter, AccessControl {
    using SafeERC20 for IERC20;

    address public immutable vault;
    mapping(address target => bool) public allowedTarget;
    /// @notice Optional spender to approve instead of the call target (address(0) = approve target).
    address public approvalSpender;

    event TargetAllowed(address indexed target, bool allowed);
    event ApprovalSpenderSet(address spender);
    event KuruSwap(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 out, uint256 leftover);

    constructor(address admin, address vault_, address[] memory targets) {
        vault = vault_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        for (uint256 i; i < targets.length; ++i) {
            allowedTarget[targets[i]] = true;
            emit TargetAllowed(targets[i], true);
        }
    }

    function setTargetAllowed(address target, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        allowedTarget[target] = allowed;
        emit TargetAllowed(target, allowed);
    }

    function setApprovalSpender(address spender) external onlyRole(DEFAULT_ADMIN_ROLE) {
        approvalSpender = spender;
        emit ApprovalSpenderSet(spender);
    }

    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        bytes calldata data,
        address recipient,
        address leftoverTo
    ) external returns (uint256 out) {
        if (msg.sender != vault) revert OnlyVault();
        (address target, bytes memory callData) = abi.decode(data, (address, bytes));
        if (!allowedTarget[target]) revert TargetNotAllowed(target);

        address spender = approvalSpender == address(0) ? target : approvalSpender;
        IERC20 inToken = IERC20(tokenIn);
        IERC20 outToken = IERC20(tokenOut);

        uint256 outBefore = outToken.balanceOf(address(this));
        inToken.forceApprove(spender, amountIn);
        (bool ok, bytes memory ret) = target.call(callData);
        if (!ok) revert SwapCallFailed(ret);
        inToken.forceApprove(spender, 0);

        out = outToken.balanceOf(address(this)) - outBefore;
        if (out < minOut) revert InsufficientOutput(out, minOut);
        outToken.safeTransfer(recipient, out);

        uint256 leftover = inToken.balanceOf(address(this));
        if (leftover != 0) inToken.safeTransfer(leftoverTo, leftover);
        emit KuruSwap(tokenIn, tokenOut, amountIn, out, leftover);
    }
}
