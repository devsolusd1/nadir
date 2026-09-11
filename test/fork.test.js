// Run with:  FORK=1 npx hardhat test test/fork.test.js
// Exercises a real buyback through the Pons v2 MemeHook pool of REVENANT on Robinhood Chain mainnet.
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { time, setBalance } = require("@nomicfoundation/hardhat-network-helpers");

const REVENANT = "0x848d3FC2660084b32971c1F58Ae46103d2B324AC";
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const STATE_VIEW = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
const MEME_HOOK = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044";

const PARAMS = { maxBonusBps: 5000, bandBps: 5000, entryBurnBps: 100, penaltyBps: 2000, releaseBps: 1000, stakingShareBps: 5000, window: 24, vestEpochs: 24, minSamples: 6 };

(process.env.FORK ? describe : describe.skip)("fork: real buyback on the REVENANT v4 pool", () => {
  it("starts from the live pool price and buys tokens through the Pons hook", async () => {
    const [deployer, guardian] = await ethers.getSigners();
    const Engine = await ethers.getContractFactory("BondEngine");
    const engine = await Engine.deploy(REVENANT, POOL_MANAGER, STATE_VIEW, MEME_HOOK, 0, 200, guardian.address, 3600, PARAMS);
    const spot = await engine.spot();
    console.log("    spot tokens/ETH:", Number(spot * 1000000n / (1n << 96n)) / 1e6);
    expect(spot).to.be.gt(0);
    await engine.start();
    await setBalance(deployer.address, ethers.parseEther("100"));
    await deployer.sendTransaction({ to: await engine.getAddress(), value: ethers.parseEther("0.1") });
    await time.increase(3600);
    const tx = await engine.poke();
    const rc = await tx.wait();
    const ev = rc.logs.map((l) => { try { return engine.interface.parseLog(l); } catch { return null; } }).filter(Boolean).find((e) => e.name === "Buyback");
    console.log("    buyback:", ethers.formatEther(ev.args.ethIn), "ETH ->", ethers.formatEther(ev.args.tokensOut), "REVENANT");
    expect(ev.args.tokensOut).to.be.gt(0);
    expect(await engine.crypt()).to.equal(ev.args.tokensOut);
    const token = await ethers.getContractAt("MockERC20", REVENANT);
    expect(await token.balanceOf(await engine.getAddress())).to.equal(ev.args.tokensOut);
  });
});
