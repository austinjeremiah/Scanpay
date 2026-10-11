// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISwapAdapter} from "../../src/interfaces/ISwapAdapter.sol";

/// Pretends to be Kuru: pulls `amountIn` from msg.sender via allowance, pays `out` from its own balance.
contract FakeRouter {
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 out) external {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).transfer(msg.sender, out);
    }

    function boom() external pure {
        revert("kuru: boom");
    }
}

/// Malicious/buggy adapter: returns less than minOut WITHOUT reverting (the vault must catch it).
contract ShortChangeAdapter is ISwapAdapter {
    address public immutable vault;

    constructor(address vault_) {
        vault = vault_;
    }

    function swap(address, address tokenOut, uint256, uint256 minOut, bytes calldata, address recipient, address)
        external
        returns (uint256)
    {
        IERC20(tokenOut).transfer(recipient, minOut - 1);
        return minOut; // lies about output
    }
}
