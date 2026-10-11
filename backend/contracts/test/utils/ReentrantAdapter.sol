// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISwapAdapter} from "../../src/interfaces/ISwapAdapter.sol";
import {IIntentVault} from "../../src/interfaces/IIntentVault.sol";

/// Tries to call settleCrossChain from inside swap(). Must be blocked by nonReentrant.
contract ReentrantAdapter is ISwapAdapter {
    address public immutable vault;
    bytes32 public target;

    constructor(address vault_) {
        vault = vault_;
    }

    function setTarget(bytes32 id) external {
        target = id;
    }

    function swap(address, address tokenOut, uint256, uint256 minOut, bytes calldata, address recipient, address)
        external
        returns (uint256)
    {
        IIntentVault(vault).settleCrossChain(target, "");
        IERC20(tokenOut).transfer(recipient, minOut);
        return minOut;
    }
}
