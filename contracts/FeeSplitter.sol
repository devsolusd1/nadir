// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPonsFeeEscrow} from "./interfaces/IPonsFeeEscrow.sol";

/// @title FeeSplitter
/// @notice Set this contract as `creatorFeeRecipient` when launching on Pons v2.
///         Anyone can call harvest(): it claims the accrued ETH from the Pons FeeEscrow and splits it
///         `treasuryBps` to the treasury (fixed at deploy) and the rest to the protocol (set once).
///         There is no owner, no withdraw and no way to change the shares after deploy.
contract FeeSplitter is ReentrancyGuard {
    IPonsFeeEscrow public immutable escrow;
    address public immutable treasury;
    address public immutable deployer;
    uint16 public immutable treasuryBps;
    address public protocol;

    uint256 public totalHarvested;
    uint256 public totalToTreasury;
    uint256 public totalToProtocol;

    event ProtocolSet(address indexed protocol);
    event Harvested(address indexed caller, uint256 total, uint256 toTreasury, uint256 toProtocol);

    error AlreadySet();
    error NotDeployer();
    error ZeroAddress();
    error ProtocolNotSet();
    error NothingToHarvest();
    error TransferFailed();
    error BadBps();

    constructor(address escrow_, address treasury_, uint16 treasuryBps_) {
        if (escrow_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (treasuryBps_ > 10_000) revert BadBps();
        escrow = IPonsFeeEscrow(escrow_);
        treasury = treasury_;
        treasuryBps = treasuryBps_;
        deployer = msg.sender;
    }

    /// @notice One-shot wiring of the protocol address (deployed after the Pons launch, once token + pool exist).
    function setProtocol(address protocol_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (protocol != address(0)) revert AlreadySet();
        if (protocol_ == address(0)) revert ZeroAddress();
        protocol = protocol_;
        emit ProtocolSet(protocol_);
    }

    /// @notice ETH accrued on the escrow and not yet claimed.
    function pending() external view returns (uint256) {
        return escrow.balanceOf(address(this));
    }

    /// @notice Claims from the escrow and distributes. Permissionless.
    function harvest() external nonReentrant returns (uint256 total) {
        if (protocol == address(0)) revert ProtocolNotSet();
        if (escrow.balanceOf(address(this)) > 0) escrow.claim();
        total = address(this).balance;
        if (total == 0) revert NothingToHarvest();
        uint256 toTreasury = (total * treasuryBps) / 10_000;
        uint256 toProtocol = total - toTreasury;
        totalHarvested += total;
        totalToTreasury += toTreasury;
        totalToProtocol += toProtocol;
        (bool ok1, ) = treasury.call{value: toTreasury}("");
        if (!ok1) revert TransferFailed();
        (bool ok2, ) = protocol.call{value: toProtocol}("");
        if (!ok2) revert TransferFailed();
        emit Harvested(msg.sender, total, toTreasury, toProtocol);
    }

    receive() external payable {}
}
