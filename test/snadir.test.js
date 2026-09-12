const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const Q96 = 1n << 96n;
const HOUR = 3600;
const PARAMS = { maxBonusBps: 5000, bandBps: 5000, entryBurnBps: 100, penaltyBps: 2000, releaseBps: 1000, stakingShareBps: 5000, window: 24, vestEpochs: 3, minSamples: 2 };

describe("StakedNadir (sNADIR)", () => {
  async function setup() {
    const [deployer, guardian, treasury, alice, bob] = await ethers.getSigners();
    const token = await (await ethers.getContractFactory("MockERC20")).deploy();
    const sv = await (await ethers.getContractFactory("MockStateView")).deploy();
    const pm = await (await ethers.getContractFactory("MockPoolManager")).deploy(await token.getAddress(), ethers.parseEther("1000000"));
    await token.mint(await pm.getAddress(), ethers.parseEther("1000000000"));
    const engine = await (await ethers.getContractFactory("BondEngine")).deploy(await token.getAddress(), await pm.getAddress(), await sv.getAddress(), ethers.ZeroAddress, 0, 200, guardian.address, HOUR, PARAMS);
    const s = await (await ethers.getContractFactory("StakedNadir")).deploy(await token.getAddress(), await engine.getAddress());
    for (const u of [alice, bob]) { await token.mint(u.address, ethers.parseEther("1000")); await token.connect(u).approve(await s.getAddress(), ethers.MaxUint256); }
    return { deployer, alice, bob, token, engine, s };
  }

  it("mints 1:1, stakes into the engine, streams ETH pro-rata and follows transfers", async () => {
    const c = await setup();
    await c.s.connect(c.alice).stake(ethers.parseEther("300"));
    await c.s.connect(c.bob).stake(ethers.parseEther("100"));
    expect(await c.s.balanceOf(c.alice.address)).to.equal(ethers.parseEther("300"));
    expect(await c.engine.staked(await c.s.getAddress())).to.equal(ethers.parseEther("400"));
    expect(await c.engine.totalStaked()).to.equal(ethers.parseEther("400"));

    // 4 ETH reaches the engine (protocol share): 50% to stakers -> 2 ETH for the sNADIR pool
    await c.deployer.sendTransaction({ to: await c.engine.getAddress(), value: ethers.parseEther("4") });
    expect(await c.s.pendingEth(c.alice.address)).to.equal(ethers.parseEther("1.5"));
    expect(await c.s.pendingEth(c.bob.address)).to.equal(ethers.parseEther("0.5"));

    // alice transfers 100 sNADIR to bob: her accrued 1.5 stays hers; future rewards split 200/200
    await c.s.connect(c.alice).transfer(c.bob.address, ethers.parseEther("100"));
    await c.deployer.sendTransaction({ to: await c.engine.getAddress(), value: ethers.parseEther("2") }); // +1 ETH to stakers
    expect(await c.s.pendingEth(c.alice.address)).to.equal(ethers.parseEther("2.0"));
    expect(await c.s.pendingEth(c.bob.address)).to.equal(ethers.parseEther("1.0"));

    const before = await ethers.provider.getBalance(c.bob.address);
    const tx = await c.s.connect(c.bob).claim(); const rc = await tx.wait();
    expect((await ethers.provider.getBalance(c.bob.address)) - before + rc.gasUsed * rc.gasPrice).to.equal(ethers.parseEther("1.0"));
    expect(await c.s.pendingEth(c.bob.address)).to.equal(0);

    // unstake 1:1 any time; rewards untouched
    await c.s.connect(c.alice).unstake(ethers.parseEther("200"));
    expect(await c.token.balanceOf(c.alice.address)).to.equal(ethers.parseEther("900"));
    expect(await c.s.balanceOf(c.alice.address)).to.equal(0);
    expect(await c.s.pendingEth(c.alice.address)).to.equal(ethers.parseEther("2.0"));
    await c.s.connect(c.alice).claim();
    expect(await c.s.pendingEth(c.alice.address)).to.equal(0);
    // nothing stranded
    expect(await ethers.provider.getBalance(await c.s.getAddress())).to.equal(0);
  });

  it("rejects ETH from anyone but the engine and zero amounts", async () => {
    const c = await setup();
    await expect(c.deployer.sendTransaction({ to: await c.s.getAddress(), value: 1n })).to.be.revertedWithCustomError(c.s, "OnlyEngine");
    await expect(c.s.connect(c.alice).stake(0)).to.be.revertedWithCustomError(c.s, "ZeroAmount");
  });
});
