// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";
import {IMockSwapAdapter} from "../interfaces/IMockSwapAdapter.sol";

/// @title MockSwapAdapter — fixed-rate exact-output swap (local + testnet only)
/// @dev rateE18(tokenIn, tokenOut) = tokenOut base units per 1 tokenIn base unit, scaled by 1e18.
///      Example: tMON(18) -> tUSDC(6) at $0.025/MON:  1e18 tMON-wei = 25_000 tUSDC-units  => rate = 25_000.
///               tUSDC(6) -> tAUSD(6) at 1:1                                               => rate = 1e18.
contract MockSwapAdapter is ISwapAdapter, IMockSwapAdapter, AccessControl {
    using SafeERC20 for IERC20;

    address public immutable vault;
    mapping(address tokenIn => mapping(address tokenOut => uint256)) public rateE18;

    event RateSet(address indexed tokenIn, address indexed tokenOut, uint256 rateE18);
    event Swapped(address indexed tokenIn, address indexed tokenOut, uint256 amountInUsed, uint256 amountOut);

    constructor(address admin, address vault_) {
        vault = vault_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function setRate(address tokenIn, address tokenOut, uint256 rate) external onlyRole(DEFAULT_ADMIN_ROLE) {
        rateE18[tokenIn][tokenOut] = rate;
        emit RateSet(tokenIn, tokenOut, rate);
    }

    function quoteOut(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256) {
        uint256 rate = rateE18[tokenIn][tokenOut];
        if (rate == 0) revert NoRate(tokenIn, tokenOut);
        return (amountIn * rate) / 1e18;
    }

    /// @notice Input needed for `amountOut` (rounded UP so quoteOut(quoteIn(x)) >= x).
    function quoteIn(address tokenIn, address tokenOut, uint256 amountOut) public view returns (uint256) {
        uint256 rate = rateE18[tokenIn][tokenOut];
        if (rate == 0) revert NoRate(tokenIn, tokenOut);
        return (amountOut * 1e18 + rate - 1) / rate;
    }

    /// @dev Vault has already transferred `amountIn` of tokenIn to this adapter.
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        bytes calldata, /* data: unused for the mock (always 0x) */
        address recipient,
        address leftoverTo
    ) external returns (uint256 out) {
        if (msg.sender != vault) revert OnlyVault();
        uint256 needed = quoteIn(tokenIn, tokenOut, minOut);
        if (needed > amountIn) revert InsufficientOutput(quoteOut(tokenIn, tokenOut, amountIn), minOut);

        out = minOut;
        IERC20(tokenOut).safeTransfer(recipient, out);
        uint256 leftover = amountIn - needed;
        if (leftover != 0) IERC20(tokenIn).safeTransfer(leftoverTo, leftover);
        emit Swapped(tokenIn, tokenOut, needed, out);
    }
}
