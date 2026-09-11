// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Pons v2 FeeEscrow (Robinhood Chain: 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e)
interface IPonsFeeEscrow {
    function balanceOf(address recipient) external view returns (uint256);
    function claim() external returns (uint256);
}
