// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title DepositForwarder — implementation behind every per-intent clone
/// @notice `vault` is an immutable baked into the implementation bytecode; EIP-1167 clones delegatecall into this
///         code, so every clone reports the same vault and only that vault can move funds out.
contract DepositForwarder {
    using SafeERC20 for IERC20;

    address public immutable vault;

    error OnlyVault();

    constructor(address vault_) {
        vault = vault_;
    }

    /// @notice Move this forwarder's entire balance of `token` to `to`. Returns the amount moved (0 is fine).
    function sweep(address token, address to) external returns (uint256 amount) {
        if (msg.sender != vault) revert OnlyVault();
        amount = IERC20(token).balanceOf(address(this));
        if (amount != 0) IERC20(token).safeTransfer(to, amount);
    }
}
