// Step 2 (AFTER the Pons launch, token address known): deploy the BondEngine and wire the splitter.
//   TOKEN=0xPonsToken GUARDIAN=0xSafe SPLITTER=0xFeeSplitter npx hardhat run scripts/2-deploy-engine.js --network robinhood
const { ethers, network, run } = require("hardhat");
const A = require("./addresses");

async function main() {
  const cfg = A[network.config.chainId];
  const { TOKEN, GUARDIAN, SPLITTER } = process.env;
  for (const [k, v] of Object.entries({ TOKEN, GUARDIAN, SPLITTER })) if (!v || !ethers.isAddress(v)) throw new Error(`set ${k}=0x...`);
  const params = A.DEFAULT_PARAMS;
  const [deployer] = await ethers.getSigners();
  console.log("deployer:", deployer.address);
  const Engine = await ethers.getContractFactory("BondEngine");
  const args = [TOKEN, cfg.UNISWAP_V4_POOL_MANAGER, cfg.UNISWAP_V4_STATE_VIEW, cfg.PONS_MEME_HOOK, cfg.POOL_FEE, cfg.TICK_SPACING, GUARDIAN, A.EPOCH_LENGTH, params];
  const e = await Engine.deploy(...args);
  await e.waitForDeployment();
  const addr = await e.getAddress();
  console.log("BondEngine:", addr, "| poolId:", await e.poolId());
  const splitter = await ethers.getContractAt("FeeSplitter", SPLITTER);
  if ((await splitter.protocol()) === ethers.ZeroAddress) {
    const tx = await splitter.setProtocol(addr);
    await tx.wait();
    console.log("FeeSplitter.protocol set ->", addr);
  }
  const spot = await e.spot();
  console.log(spot > 0n ? "pool is live: call start() now (scripts/3-start-and-poke.js)" : "pool not initialized yet (token still on the Pons curve). Call start() after graduation.");
  if (process.env.VERIFY) {
    await new Promise((r) => setTimeout(r, 15000));
    await run("verify:verify", { address: addr, constructorArguments: args });
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
