// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IBondEngineStaking {
    function stake(uint256 amount) external;
    function unstake(uint256 amount) external;
    function claimRewards() external returns (uint256);
    function earned(address user) external view returns (uint256);
    function staked(address user) external view returns (uint256);
}

/// @title StakedNadir (sNADIR)
/// @notice Liquid staking receipt for the NADIR BondEngine. Deposit NADIR, receive sNADIR 1:1; the contract holds
///         one staking position in the engine and streams the ETH it earns to sNADIR holders pro-rata.
///         Transferable: rewards follow the balance. No owner, no fees, no pause. Unstake any time, 1:1.
contract StakedNadir is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable nadir;
    IBondEngineStaking public immutable engine;

    uint256 public accEthPerShare; // 1e18 precision
    uint256 public totalEthDistributed;
    mapping(address => uint256) public rewardDebt;
    mapping(address => uint256) public owedEth;

    event Staked(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount);
    event Claimed(address indexed user, uint256 eth);
    event Synced(uint256 eth, uint256 accEthPerShare);

    error ZeroAmount();
    error TransferFailed();
    error OnlyEngine();

    constructor(address nadir_, address engine_) ERC20("Staked NADIR", "sNADIR") {
        nadir = IERC20(nadir_);
        engine = IBondEngineStaking(engine_);
        IERC20(nadir_).forceApprove(engine_, type(uint256).max);
    }

    // ------------------------------------------------------------------ views
    function pendingEth(address user) external view returns (uint256) {
        uint256 acc = accEthPerShare;
        uint256 supply = totalSupply();
        if (supply > 0) acc += (engine.earned(address(this)) * 1e18) / supply;
        return owedEth[user] + (balanceOf(user) * acc) / 1e18 - rewardDebt[user];
    }

    function totalStakedInEngine() external view returns (uint256) {
        return engine.staked(address(this));
    }

    // ------------------------------------------------------------------ actions
    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _sync();
        nadir.safeTransferFrom(msg.sender, address(this), amount);
        engine.stake(amount);
        _mint(msg.sender, amount);
        emit Staked(msg.sender, amount);
    }

    function unstake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _sync();
        _burn(msg.sender, amount);
        engine.unstake(amount);
        nadir.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    function claim() external nonReentrant returns (uint256 amount) {
        _sync();
        _accrue(msg.sender);
        rewardDebt[msg.sender] = (balanceOf(msg.sender) * accEthPerShare) / 1e18;
        amount = owedEth[msg.sender];
        if (amount == 0) return 0;
        owedEth[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Claimed(msg.sender, amount);
    }

    /// @notice Pulls the ETH earned by the pooled stake from the engine and credits it to holders. Permissionless.
    function sync() external nonReentrant {
        _sync();
    }

    // ------------------------------------------------------------------ internals
    function _sync() internal {
        uint256 supply = totalSupply();
        if (supply == 0) return;
        if (engine.earned(address(this)) == 0) return;
        uint256 before = address(this).balance;
        engine.claimRewards();
        uint256 got = address(this).balance - before;
        if (got == 0) return;
        accEthPerShare += (got * 1e18) / supply;
        totalEthDistributed += got;
        emit Synced(got, accEthPerShare);
    }

    function _accrue(address user) internal {
        uint256 owed = (balanceOf(user) * accEthPerShare) / 1e18 - rewardDebt[user];
        if (owed > 0) owedEth[user] += owed;
    }

    /// @dev rewards follow balances: pull what the pool earned so far, then settle both sides before any
    ///      mint, burn or transfer (stake/unstake already synced; plain transfers sync here)
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) _sync();
        if (from != address(0)) _accrue(from);
        if (to != address(0)) _accrue(to);
        super._update(from, to, value);
        if (from != address(0)) rewardDebt[from] = (balanceOf(from) * accEthPerShare) / 1e18;
        if (to != address(0)) rewardDebt[to] = (balanceOf(to) * accEthPerShare) / 1e18;
    }

    receive() external payable {
        if (msg.sender != address(engine)) revert OnlyEngine();
    }
}
