// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Testnet/local only fixed-rate swap. rateE18 = tokenOut base units per 1 tokenIn base unit, scaled 1e18.
interface IMockSwapAdapter {
    function rateE18(address tokenIn, address tokenOut) external view returns (uint256);
    function quoteOut(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256);
    function quoteIn(address tokenIn, address tokenOut, uint256 amountOut) external view returns (uint256);
    function setRate(address tokenIn, address tokenOut, uint256 rate) external;
}
