const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const Q96 = 1n << 96n;
const sqrtP = (tokensPerEthSqrt) => BigInt(tokensPerEthSqrt) * Q96; // sqrt(tokens per ETH) * 2^96
const HOUR = 3600;

const PARAMS = {
  maxBonusBps: 5000,
  bandBps: 5000,
  entryBurnBps: 100,
  penaltyBps: 2000,
  releaseBps: 1000,
  stakingShareBps: 5000,
  window: 24,
  vestEpochs: 3,
  minSamples: 2,
};

async function deployAll() {
  const [deployer, guardian, treasury, alice, bob, keeper] = await ethers.getSigners();
  const Token = await ethers.getContractFactory("MockERC20");
  const token = await Token.deploy();
  const SV = await ethers.getContractFactory("MockStateView");
  const stateView = await SV.deploy();
  const PM = await ethers.getContractFactory("MockPoolManager");
  const pm = await PM.deploy(await token.getAddress(), ethers.parseEther("1000000")); // 1M tokens per ETH
  await token.mint(await pm.getAddress(), ethers.parseEther("500000000")); // pool inventory
  const Engine = await ethers.getContractFactory("BondEngine");
  const engine = await Engine.deploy(
    await token.getAddress(), await pm.getAddress(), await stateView.getAddress(),
    ethers.ZeroAddress, 0, 200, guardian.address, HOUR, PARAMS
  );
  const Escrow = await ethers.getContractFactory("MockEscrow");
  const escrow = await Escrow.deploy();
  const Splitter = await ethers.getContractFactory("FeeSplitter");
  const splitter = await Splitter.deploy(await escrow.getAddress(), treasury.address, 6000);
  await splitter.setProtocol(await engine.getAddress());
  for (const u of [alice, bob]) await token.mint(u.address, ethers.parseEther("10000000"));
  return { deployer, guardian, treasury, alice, bob, keeper, token, stateView, pm, engine, escrow, splitter };
}

async function warmup(ctx, samples = PARAMS.minSamples) {
  await ctx.stateView.set(sqrtP(1000)); // 1M tokens per ETH
  await ctx.engine.start();
  for (let i = 1; i < samples; i++) {
    await time.increase(HOUR);
    await ctx.engine.poke();
  }
}

describe("FeeSplitter", () => {
  it("splits 60/40 between treasury and protocol, permissionlessly", async () => {
    const c = await deployAll();
    await c.escrow.credit(await c.splitter.getAddress(), { value: ethers.parseEther("10") });
    expect(await c.splitter.pending()).to.equal(ethers.parseEther("10"));
    const before = await ethers.provider.getBalance(c.treasury.address);
    await c.splitter.connect(c.keeper).harvest();
    const after = await ethers.provider.getBalance(c.treasury.address);
    expect(after - before).to.equal(ethers.parseEther("6"));
    expect(await c.engine.ethReserve()).to.equal(ethers.parseEther("4")); // no stakers yet -> all to reserve
    expect(await c.splitter.totalToProtocol()).to.equal(ethers.parseEther("4"));
  });

  it("protocol can be set only once and only by deployer", async () => {
    const c = await deployAll();
    await expect(c.splitter.setProtocol(c.alice.address)).to.be.revertedWithCustomError(c.splitter, "AlreadySet");
    const Splitter = await ethers.getContractFactory("FeeSplitter");
    const s2 = await Splitter.deploy(await c.escrow.getAddress(), c.treasury.address, 6000);
    await expect(s2.connect(c.alice).setProtocol(c.alice.address)).to.be.revertedWithCustomError(s2, "NotDeployer");
    await expect(s2.harvest()).to.be.revertedWithCustomError(s2, "ProtocolNotSet");
  });
});

describe("BondEngine", () => {
  it("computes poolId like Uniswap v4 (REVENANT pool on Robinhood Chain)", async () => {
    const Engine = await ethers.getContractFactory("BondEngine");
    const [, guardian] = await ethers.getSigners();
    const e = await Engine.deploy(
      "0x848d3FC2660084b32971c1F58Ae46103d2B324AC", ethers.ZeroAddress, ethers.ZeroAddress,
      "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044", 0, 200, guardian.address, HOUR, PARAMS
    );
    expect(await e.poolId()).to.equal("0x6f97f95759ffcce8a2b3f0b666dde8e05cbd895712245b5a5708c2603bd9105d");
  });

  it("does not start before the pool is initialized", async () => {
    const c = await deployAll();
    await expect(c.engine.start()).to.be.revertedWithCustomError(c.engine, "PoolNotLive");
    await c.stateView.set(sqrtP(1000));
    await c.engine.start();
    expect(await c.engine.started()).to.equal(true);
    expect(await c.engine.spot()).to.equal(1000000n * Q96);
    await expect(c.engine.poke()).to.be.revertedWithCustomError(c.engine, "EpochNotOver");
  });

  it("bonus grows with the discount to target and bonds pay out FIFO after vesting", async () => {
    const c = await deployAll();
    await warmup(c, 3);
    expect(await c.engine.discountBps()).to.equal(0);
    await expect(c.engine.connect(c.alice).bond(1n, 0)).to.be.revertedWithCustomError(c.engine, "NoDiscount");

    // price drops: 1.5625M tokens per ETH  -> discount = 1 - 1/1.5625 = 36%
    await c.stateView.set(sqrtP(1250));
    expect(await c.engine.discountBps()).to.equal(3600);
    expect(await c.engine.bonusBps()).to.equal(3600);

    const amt = ethers.parseEther("1000000");
    await c.token.connect(c.alice).approve(await c.engine.getAddress(), amt);
    await expect(c.engine.connect(c.alice).bond(amt, 3700)).to.be.revertedWithCustomError(c.engine, "BonusTooLow");
    await c.engine.connect(c.alice).bond(amt, 3500);
    const b = await c.engine.bonds(0);
    const principal = amt - amt / 100n; // 1% burned
    expect(b.principal).to.equal(principal);
    expect(b.payout).to.equal((principal * 13600n) / 10000n);
    expect(await c.token.balanceOf("0x000000000000000000000000000000000000dEaD")).to.equal(amt / 100n);
    expect(await c.engine.crypt()).to.equal(principal);

    // not matured yet: settle pays nothing
    await c.engine.settle(10);
    expect(await c.engine.queueHead()).to.equal(0);

    // fund the crypt through buybacks: 4 ETH reserve, 10% per epoch at 1M tokens/ETH = 400k tokens/epoch
    await c.deployer.sendTransaction({ to: await c.engine.getAddress(), value: ethers.parseEther("4") });
    for (let i = 0; i < 3; i++) { await time.increase(HOUR); await c.engine.connect(c.keeper).poke(); }
    expect(await c.engine.totalBoughtBack()).to.be.gt(ethers.parseEther("1000000"));

    const before = await c.token.balanceOf(c.alice.address);
    await c.engine.settle(10);
    const after = await c.token.balanceOf(c.alice.address);
    expect(after - before).to.equal(b.payout);
    expect(await c.engine.queueHead()).to.equal(1);
    expect(await c.engine.bondedOutstanding()).to.equal(0);
  });

  it("exit before maturity refunds principal minus 20% penalty", async () => {
    const c = await deployAll();
    await warmup(c, 3);
    await c.stateView.set(sqrtP(1250));
    const amt = ethers.parseEther("1000");
    await c.token.connect(c.bob).approve(await c.engine.getAddress(), amt);
    await c.engine.connect(c.bob).bond(amt, 0);
    const principal = amt - amt / 100n;
    const before = await c.token.balanceOf(c.bob.address);
    await c.engine.connect(c.bob).exit(0);
    expect((await c.token.balanceOf(c.bob.address)) - before).to.equal((principal * 8000n) / 10000n);
    expect(await c.engine.crypt()).to.equal((principal * 2000n) / 10000n); // penalty stays
    await expect(c.engine.connect(c.bob).exit(0)).to.be.revertedWithCustomError(c.engine, "BondClosed");
    await expect(c.engine.connect(c.alice).exit(0)).to.be.revertedWithCustomError(c.engine, "NotOwner");
  });

  it("stakers earn ETH pro-rata from the protocol share", async () => {
    const c = await deployAll();
    await warmup(c);
    const eng = await c.engine.getAddress();
    await c.token.connect(c.alice).approve(eng, ethers.parseEther("300"));
    await c.token.connect(c.bob).approve(eng, ethers.parseEther("100"));
    await c.engine.connect(c.alice).stake(ethers.parseEther("300"));
    await c.engine.connect(c.bob).stake(ethers.parseEther("100"));
    // 4 ETH arrives (the 40% of a 10 ETH harvest): 50% to stakers, 50% to reserve
    await c.escrow.credit(await c.splitter.getAddress(), { value: ethers.parseEther("10") });
    await c.splitter.harvest();
    expect(await c.engine.ethReserve()).to.equal(ethers.parseEther("2"));
    expect(await c.engine.earned(c.alice.address)).to.equal(ethers.parseEther("1.5"));
    expect(await c.engine.earned(c.bob.address)).to.equal(ethers.parseEther("0.5"));
    const before = await ethers.provider.getBalance(c.bob.address);
    const tx = await c.engine.connect(c.bob).claimRewards();
    const rc = await tx.wait();
    const gas = rc.gasUsed * rc.gasPrice;
    expect((await ethers.provider.getBalance(c.bob.address)) - before + gas).to.equal(ethers.parseEther("0.5"));
    await c.engine.connect(c.bob).unstake(ethers.parseEther("100"));
    expect(await c.engine.staked(c.bob.address)).to.equal(0);
    // the keeper tip comes out of the reserve
    await time.increase(HOUR);
    const kb = await ethers.provider.getBalance(c.keeper.address);
    const ptx = await c.engine.connect(c.keeper).poke();
    const prc = await ptx.wait();
    expect((await ethers.provider.getBalance(c.keeper.address)) - kb + prc.gasUsed * prc.gasPrice).to.be.gt(0);
  });

  it("pause blocks only new entries, expires alone, and params are timelocked", async () => {
    const c = await deployAll();
    await warmup(c, 3);
    await c.stateView.set(sqrtP(1250));
    const eng = await c.engine.getAddress();
    await c.token.connect(c.alice).approve(eng, ethers.parseEther("1000"));
    await c.engine.connect(c.alice).stake(ethers.parseEther("500"));
    await expect(c.engine.connect(c.alice).pause(3600)).to.be.revertedWithCustomError(c.engine, "NotGuardian");
    await expect(c.engine.connect(c.guardian).pause(8 * 24 * 3600)).to.be.revertedWithCustomError(c.engine, "PauseTooLong");
    await c.engine.connect(c.guardian).pause(2 * 3600);
    expect(await c.engine.isPaused()).to.equal(true);
    await expect(c.engine.connect(c.alice).stake(1n)).to.be.revertedWithCustomError(c.engine, "EntriesPaused");
    await expect(c.engine.connect(c.alice).bond(1n, 0)).to.be.revertedWithCustomError(c.engine, "EntriesPaused");
    await c.engine.connect(c.alice).unstake(ethers.parseEther("500")); // never blocked
    await time.increase(HOUR); await c.engine.poke();                    // never blocked
    await time.increase(2 * HOUR);
    expect(await c.engine.isPaused()).to.equal(false);

    const p = { ...PARAMS, maxBonusBps: 2000 };
    await expect(c.engine.connect(c.alice).proposeParams(p)).to.be.revertedWithCustomError(c.engine, "NotGuardian");
    await c.engine.connect(c.guardian).proposeParams(p);
    await expect(c.engine.executeParams()).to.be.revertedWithCustomError(c.engine, "TooEarly");
    await time.increase(48 * HOUR);
    await c.engine.executeParams();
    expect((await c.engine.params()).maxBonusBps).to.equal(2000);
    await expect(c.engine.connect(c.guardian).proposeParams({ ...PARAMS, bandBps: 0 })).to.be.revertedWithCustomError(c.engine, "BadParams");
  });
});
