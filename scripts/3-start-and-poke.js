// Step 3: start the engine once the pool is live, then run this as a keeper (one call per hour).
//   ENGINE=0x... npx hardhat run scripts/3-start-and-poke.js --network robinhood          (one shot)
//   ENGINE=0x... LOOP=1 npx hardhat run scripts/3-start-and-poke.js --network robinhood   (keeps running)
// Anyone can call poke(); the caller receives a small ETH tip from the reserve. harvest() on the splitter is
// also permissionless, so the keeper calls it first whenever the escrow holds fees.
const { ethers } = require("hardhat");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tick(engine, splitter) {
  if (splitter) {
    const pending = await splitter.pending();
    if (pending > 0n) {
      const tx = await splitter.harvest();
      await tx.wait();
      console.log(new Date().toISOString(), "harvested", ethers.formatEther(pending), "ETH from Pons escrow");
    }
  }
  if (!(await engine.started())) {
    if ((await engine.spot()) === 0n) return console.log(new Date().toISOString(), "pool not live yet");
    const tx = await engine.start();
    await tx.wait();
    return console.log(new Date().toISOString(), "engine started");
  }
  const last = await engine.lastSampleAt();
  const len = await engine.epochLength();
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (now < last + len) return console.log(new Date().toISOString(), `epoch not over (${Number(last + len - now)}s left)`);
  const tx = await engine.poke();
  const rc = await tx.wait();
  console.log(new Date().toISOString(), "poked epoch", (await engine.epoch()).toString(), "gas", rc.gasUsed.toString());
  const settled = await engine.settle.staticCall(20);
  if (settled > 0n) {
    const t2 = await engine.settle(20);
    await t2.wait();
    console.log("  settled", settled.toString(), "bonds");
  }
}

async function main() {
  if (!process.env.ENGINE) throw new Error("set ENGINE=0x...");
  const engine = await ethers.getContractAt("BondEngine", process.env.ENGINE);
  const splitter = process.env.SPLITTER ? await ethers.getContractAt("FeeSplitter", process.env.SPLITTER) : null;
  do {
    try { await tick(engine, splitter); } catch (e) { console.error(new Date().toISOString(), "tick failed:", e.shortMessage || e.message); }
    if (process.env.LOOP) await sleep(60_000);
  } while (process.env.LOOP);
}
main().catch((e) => { console.error(e); process.exit(1); });
