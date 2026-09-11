// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PoolKey, SwapParams, IPoolManager, IUnlockCallback, IStateView} from "./interfaces/IUniswapV4.sol";

/// @title BondEngine
/// @notice Bond + stake engine for a fixed-supply token trading on a Uniswap v4 pool (ETH / token).
///
///  Oracle   : one price sample per epoch read from the v4 StateView; `target` = mean of the last `window` samples.
///  Bond     : when spot is below target, deposit token -> bond with a bonus that grows with the discount
///             (0 at target, `maxBonusBps` at `bandBps` below target). A slice of the entry is burned. Bonds vest
///             `vestEpochs` epochs and are paid FIFO from the crypt (principal + buybacks + exit penalties).
///  Buyback  : ETH sent to this contract (from the FeeSplitter) is split: `stakingShareBps` to stakers as ETH
///             rewards, the rest to `ethReserve`. Every epoch `releaseBps` of the reserve buys token on the v4
///             pool and the tokens go to the crypt, funding bond payouts.
///  Stake    : stake token, earn ETH. No lock, no penalty.
///  Safety   : no admin can move user funds. The guardian can only pause NEW entries for at most 7 days at a
///             time (unstake, exit, settle and claims never pause) and propose parameter changes that execute
///             after a 48h timelock. Addresses and pool are immutable.
contract BondEngine is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ immutables
    IERC20 public immutable token;
    IPoolManager public immutable poolManager;
    IStateView public immutable stateView;
    address public immutable hooks;
    uint24 public immutable poolFee;
    int24 public immutable poolTickSpacing;
    bytes32 public immutable poolId;
    address public immutable guardian;
    uint64 public immutable epochLength;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint160 internal constant MIN_SQRT_PRICE_PLUS_ONE = 4295128740;
    uint16 public constant MAX_SAMPLES = 168;
    uint64 public constant PARAMS_DELAY = 48 hours;
    uint64 public constant MAX_PAUSE = 7 days;
    uint16 public constant TIP_BPS = 10; // 0.1% of the reserve per poke
    uint256 public constant TIP_CAP = 0.005 ether;

    // ------------------------------------------------------------------ params (timelocked)
    struct Params {
        uint16 maxBonusBps;     // bonus at full band discount              e.g. 5000 = +50%
        uint16 bandBps;         // discount at which max bonus is reached   e.g. 5000 = 50% below target
        uint16 entryBurnBps;    // burned on bond entry                     e.g. 100  = 1%
        uint16 penaltyBps;      // penalty on early exit                    e.g. 2000 = 20%
        uint16 releaseBps;      // share of ethReserve bought back per epoch e.g. 1000 = 10%
        uint16 stakingShareBps; // share of incoming ETH paid to stakers    e.g. 5000 = 50%
        uint16 window;          // samples used for target                  e.g. 24 (1 day at 1h epochs)
        uint16 vestEpochs;      // epochs until a bond matures              e.g. 24
        uint16 minSamples;      // samples required before bonds open       e.g. 6
    }
    Params public params;
    Params public pendingParams;
    uint64 public paramsExecutableAt;

    // ------------------------------------------------------------------ pause (entries only)
    uint64 public pausedUntil;

    // ------------------------------------------------------------------ oracle
    bool public started;
    uint64 public lastSampleAt;
    uint32 public epoch;
    uint32 public sampleCursor;
    uint32 public sampleCount;
    uint256[MAX_SAMPLES] internal samples; // tokens per ETH, Q96

    // ------------------------------------------------------------------ reserves
    uint256 public ethReserve;
    uint256 public crypt;
    uint256 public totalStaked;
    uint256 public totalBurned;
    uint256 public totalBoughtBack;

    // ------------------------------------------------------------------ bonds
    struct Bond {
        address owner;
        uint128 principal;
        uint128 payout;
        uint32 createdEpoch;
        uint32 maturityEpoch;
        bool closed;
    }
    Bond[] public bonds;
    uint256 public queueHead;
    uint256 public bondedOutstanding;
    mapping(address => uint256[]) internal bondsByOwner;

    // ------------------------------------------------------------------ staking (ETH rewards)
    uint256 public accRewardPerShare; // 1e18
    mapping(address => uint256) public staked;
    mapping(address => uint256) public rewardDebt;
    mapping(address => uint256) public pendingEth;

    // ------------------------------------------------------------------ events / errors
    event Started(uint256 tokensPerEthQ96);
    event Poked(address indexed keeper, uint32 epoch, uint256 spot, uint256 target, uint256 tip);
    event Buyback(uint256 ethIn, uint256 tokensOut);
    event Bonded(uint256 indexed id, address indexed owner, uint256 amountIn, uint256 burned, uint256 principal, uint256 payout, uint16 bonusBps, uint32 maturityEpoch);
    event Settled(uint256 indexed id, address indexed owner, uint256 payout);
    event Exited(uint256 indexed id, address indexed owner, uint256 refund, uint256 penalty);
    event Staked(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount);
    event RewardsClaimed(address indexed user, uint256 eth);
    event EthReceived(address indexed from, uint256 amount, uint256 toStakers, uint256 toReserve);
    event Paused(uint64 until);
    event Unpaused();
    event ParamsProposed(Params p, uint64 executableAt);
    event ParamsExecuted(Params p);

    error NotGuardian();
    error NotStarted();
    error AlreadyStarted();
    error PoolNotLive();
    error EpochNotOver();
    error EntriesPaused();
    error NotEnoughSamples();
    error NoDiscount();
    error BonusTooLow();
    error ZeroAmount();
    error NotOwner();
    error BondClosed();
    error CryptDepleted();
    error NotPoolManager();
    error BadDelta();
    error BadParams();
    error NothingPending();
    error TooEarly();
    error PauseTooLong();
    error TransferFailed();

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    modifier whenNotPaused() {
        if (block.timestamp < pausedUntil) revert EntriesPaused();
        _;
    }

    constructor(
        address token_,
        address poolManager_,
        address stateView_,
        address hooks_,
        uint24 poolFee_,
        int24 tickSpacing_,
        address guardian_,
        uint64 epochLength_,
        Params memory p
    ) {
        token = IERC20(token_);
        poolManager = IPoolManager(poolManager_);
        stateView = IStateView(stateView_);
        hooks = hooks_;
        poolFee = poolFee_;
        poolTickSpacing = tickSpacing_;
        guardian = guardian_;
        epochLength = epochLength_;
        poolId = keccak256(abi.encode(PoolKey(address(0), token_, poolFee_, tickSpacing_, hooks_)));
        _validate(p);
        params = p;
    }

    // ------------------------------------------------------------------ views
    function poolKey() public view returns (PoolKey memory) {
        return PoolKey(address(0), address(token), poolFee, poolTickSpacing, hooks);
    }

    /// @return tokensPerEthQ96 current pool price as tokens per ETH in Q96 (0 if pool not initialized)
    function spot() public view returns (uint256 tokensPerEthQ96) {
        (uint160 sqrtP, , , ) = stateView.getSlot0(poolId);
        if (sqrtP == 0) return 0;
        tokensPerEthQ96 = Math.mulDiv(uint256(sqrtP), uint256(sqrtP), 1 << 96);
    }

    /// @return mean of the last `window` samples (tokens per ETH, Q96)
    function target() public view returns (uint256) {
        uint32 n = params.window;
        if (n > sampleCount) n = sampleCount;
        if (n == 0) return 0;
        uint256 sum;
        for (uint32 i = 1; i <= n; i++) {
            sum += samples[(sampleCursor - i) % MAX_SAMPLES];
        }
        return sum / n;
    }

    /// @return bps the token is below target (0 when at or above target)
    function discountBps() public view returns (uint16) {
        uint256 s = spot();
        uint256 t = target();
        if (s == 0 || t == 0 || s <= t) return 0;
        return uint16(((s - t) * 10_000) / s);
    }

    /// @return current bond bonus in bps
    function bonusBps() public view returns (uint16) {
        uint256 d = discountBps();
        if (d == 0) return 0;
        if (d > params.bandBps) d = params.bandBps;
        return uint16((uint256(params.maxBonusBps) * d) / params.bandBps);
    }

    function isPaused() public view returns (bool) {
        return block.timestamp < pausedUntil;
    }

    function bondsLength() external view returns (uint256) {
        return bonds.length;
    }

    function bondIdsOf(address owner) external view returns (uint256[] memory) {
        return bondsByOwner[owner];
    }

    function sampleAt(uint32 i) external view returns (uint256) {
        return samples[i % MAX_SAMPLES];
    }

    function earned(address user) public view returns (uint256) {
        return pendingEth[user] + (staked[user] * accRewardPerShare) / 1e18 - rewardDebt[user];
    }

    // ------------------------------------------------------------------ lifecycle
    /// @notice Opens the engine once the v4 pool is live (after Pons graduation). Permissionless.
    function start() external {
        if (started) revert AlreadyStarted();
        uint256 s = spot();
        if (s == 0) revert PoolNotLive();
        started = true;
        _pushSample(s);
        lastSampleAt = uint64(block.timestamp);
        emit Started(s);
    }

    /// @notice Advances one epoch: samples price, buys back with `releaseBps` of the reserve, tips the caller.
    function poke() external nonReentrant {
        if (!started) revert NotStarted();
        if (block.timestamp < lastSampleAt + epochLength) revert EpochNotOver();
        uint256 s = spot();
        if (s == 0) revert PoolNotLive();
        _pushSample(s);
        lastSampleAt = uint64(block.timestamp);
        epoch += 1;

        uint256 amt = (ethReserve * params.releaseBps) / 10_000;
        if (amt > 0) {
            ethReserve -= amt;
            uint256 out = _buyback(amt);
            crypt += out;
            totalBoughtBack += out;
            emit Buyback(amt, out);
        }

        uint256 tip = Math.min((ethReserve * TIP_BPS) / 10_000, TIP_CAP);
        if (tip > 0) {
            ethReserve -= tip;
            (bool ok, ) = msg.sender.call{value: tip}("");
            if (!ok) revert TransferFailed();
        }
        emit Poked(msg.sender, epoch, s, target(), tip);
    }

    // ------------------------------------------------------------------ bonds
    function bond(uint256 amount, uint16 minBonusBps) external nonReentrant whenNotPaused returns (uint256 id) {
        if (!started) revert NotStarted();
        if (amount == 0) revert ZeroAmount();
        if (sampleCount < params.minSamples) revert NotEnoughSamples();
        uint16 b = bonusBps();
        if (b == 0) revert NoDiscount();
        if (b < minBonusBps) revert BonusTooLow();

        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 burn = (amount * params.entryBurnBps) / 10_000;
        if (burn > 0) {
            token.safeTransfer(DEAD, burn);
            totalBurned += burn;
        }
        uint256 principal = amount - burn;
        uint256 payout = (principal * (10_000 + uint256(b))) / 10_000;
        crypt += principal;
        bondedOutstanding += payout;

        id = bonds.length;
        uint32 maturity = epoch + params.vestEpochs;
        bonds.push(Bond(msg.sender, uint128(principal), uint128(payout), epoch, maturity, false));
        bondsByOwner[msg.sender].push(id);
        emit Bonded(id, msg.sender, amount, burn, principal, payout, b, maturity);
    }

    /// @notice Pays matured bonds in FIFO order while the crypt can cover them. Permissionless.
    function settle(uint256 maxBonds) external nonReentrant returns (uint256 paid) {
        uint256 i = queueHead;
        uint256 n = bonds.length;
        while (i < n && paid < maxBonds) {
            Bond storage b = bonds[i];
            if (b.closed) {
                i++;
                continue;
            }
            if (epoch < b.maturityEpoch) break;
            if (crypt < b.payout) break;
            b.closed = true;
            crypt -= b.payout;
            bondedOutstanding -= b.payout;
            token.safeTransfer(b.owner, b.payout);
            emit Settled(i, b.owner, b.payout);
            paid++;
            i++;
        }
        queueHead = i;
    }

    /// @notice Cancel a bond before it is settled: principal minus penalty comes back, penalty stays in the crypt.
    function exit(uint256 id) external nonReentrant {
        Bond storage b = bonds[id];
        if (b.owner != msg.sender) revert NotOwner();
        if (b.closed) revert BondClosed();
        uint256 penalty = (uint256(b.principal) * params.penaltyBps) / 10_000;
        uint256 refund = uint256(b.principal) - penalty;
        if (crypt < refund) revert CryptDepleted();
        b.closed = true;
        crypt -= refund;
        bondedOutstanding -= b.payout;
        token.safeTransfer(msg.sender, refund);
        emit Exited(id, msg.sender, refund, penalty);
    }

    // ------------------------------------------------------------------ staking
    function stake(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        _accrue(msg.sender);
        token.safeTransferFrom(msg.sender, address(this), amount);
        staked[msg.sender] += amount;
        totalStaked += amount;
        rewardDebt[msg.sender] = (staked[msg.sender] * accRewardPerShare) / 1e18;
        emit Staked(msg.sender, amount);
    }

    function unstake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _accrue(msg.sender);
        staked[msg.sender] -= amount;
        totalStaked -= amount;
        rewardDebt[msg.sender] = (staked[msg.sender] * accRewardPerShare) / 1e18;
        token.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    function claimRewards() external nonReentrant returns (uint256 amount) {
        _accrue(msg.sender);
        rewardDebt[msg.sender] = (staked[msg.sender] * accRewardPerShare) / 1e18;
        amount = pendingEth[msg.sender];
        if (amount == 0) return 0;
        pendingEth[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit RewardsClaimed(msg.sender, amount);
    }

    // ------------------------------------------------------------------ guardian
    function pause(uint64 duration) external onlyGuardian {
        if (duration > MAX_PAUSE) revert PauseTooLong();
        pausedUntil = uint64(block.timestamp) + duration;
        emit Paused(pausedUntil);
    }

    function unpause() external onlyGuardian {
        pausedUntil = uint64(block.timestamp);
        emit Unpaused();
    }

    function proposeParams(Params calldata p) external onlyGuardian {
        _validate(p);
        pendingParams = p;
        paramsExecutableAt = uint64(block.timestamp) + PARAMS_DELAY;
        emit ParamsProposed(p, paramsExecutableAt);
    }

    function executeParams() external {
        if (paramsExecutableAt == 0) revert NothingPending();
        if (block.timestamp < paramsExecutableAt) revert TooEarly();
        params = pendingParams;
        paramsExecutableAt = 0;
        emit ParamsExecuted(params);
    }

    // ------------------------------------------------------------------ ETH in
    receive() external payable {
        uint256 toStakers = (msg.value * params.stakingShareBps) / 10_000;
        if (totalStaked == 0) toStakers = 0;
        if (toStakers > 0) accRewardPerShare += (toStakers * 1e18) / totalStaked;
        ethReserve += msg.value - toStakers;
        emit EthReceived(msg.sender, msg.value, toStakers, msg.value - toStakers);
    }

    // ------------------------------------------------------------------ v4 swap
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        uint256 ethIn = abi.decode(data, (uint256));
        int256 delta = poolManager.swap(
            poolKey(),
            SwapParams({zeroForOne: true, amountSpecified: -int256(ethIn), sqrtPriceLimitX96: MIN_SQRT_PRICE_PLUS_ONE}),
            ""
        );
        int128 a0 = int128(delta >> 128);
        int128 a1 = int128(delta);
        if (a0 >= 0 || a1 <= 0) revert BadDelta();
        poolManager.settle{value: uint256(uint128(-a0))}();
        uint256 out = uint256(uint128(a1));
        poolManager.take(address(token), address(this), out);
        return abi.encode(out);
    }

    // ------------------------------------------------------------------ internals
    function _buyback(uint256 ethIn) internal returns (uint256 out) {
        bytes memory r = poolManager.unlock(abi.encode(ethIn));
        out = abi.decode(r, (uint256));
    }

    function _pushSample(uint256 v) internal {
        samples[sampleCursor % MAX_SAMPLES] = v;
        sampleCursor += 1;
        if (sampleCount < MAX_SAMPLES) sampleCount += 1;
    }

    function _accrue(address user) internal {
        uint256 owed = (staked[user] * accRewardPerShare) / 1e18 - rewardDebt[user];
        if (owed > 0) pendingEth[user] += owed;
    }

    function _validate(Params memory p) internal pure {
        if (
            p.maxBonusBps > 10_000 || p.bandBps == 0 || p.bandBps > 10_000 || p.entryBurnBps > 1_000 ||
            p.penaltyBps > 5_000 || p.releaseBps > 10_000 || p.stakingShareBps > 10_000 ||
            p.window == 0 || p.window > MAX_SAMPLES || p.vestEpochs == 0 || p.minSamples == 0
        ) revert BadParams();
    }
}
