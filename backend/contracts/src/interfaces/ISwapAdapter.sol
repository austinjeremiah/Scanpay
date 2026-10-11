// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Vault transfers `amountIn` of tokenIn to the adapter BEFORE calling swap().
/// Adapter must send >= minOut tokenOut to `recipient` and any unused tokenIn to `leftoverTo`.
interface ISwapAdapter {
    error OnlyVault();
    error TargetNotAllowed(address target);
    error SwapCallFailed(bytes reason);
    error NoRate(address tokenIn, address tokenOut);
    error InsufficientOutput(uint256 out, uint256 minOut);

    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        bytes calldata data,
        address recipient,
        address leftoverTo
    ) external returns (uint256 out);

    function vault() external view returns (address);
}
