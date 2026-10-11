// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC3009} from "./IERC3009.sol";
// Pulls OpenZeppelin's IERC20 into the build so scripts/export-abis.ts can emit erc20Abi.
// Does not change this interface's own ABI.
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Testnet/local only. Mintable by MINTER_ROLE (the operator = faucet).
interface IMockStableToken is IERC3009 {
    function mint(address to, uint256 amount) external;
    function decimals() external view returns (uint8);
    function balanceOf(address) external view returns (uint256);
}
