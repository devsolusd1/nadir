// Step 1 (BEFORE the Pons launch): deploy the FeeSplitter and use its address as `creatorFeeRecipient` on Pons.
//   TREASURY=0xYourWalletOrSafe TREASURY_BPS=6000 npx hardhat run scripts/1-deploy-splitter.js --network robinhood
const { ethers, network, run } = require("hardhat");
const A = require("./addresses");

async function main() {
  const cfg = A[network.config.chainId];
  const treasury = process.env.TREASURY;
  const bps = Number(process.env.TREASURY_BPS || 6000);
  if (!treasury || !ethers.isAddress(treasury)) throw new Error("set TREASURY=0x... (your wallet or Safe)");
  if (!cfg?.PONS_FEE_ESCROW) throw new Error("no Pons escrow address for this chain");
  const [deployer] = await ethers.getSigners();
  console.log("deployer:", deployer.address, "| treasury:", treasury, "| treasuryBps:", bps);
  const Splitter = await ethers.getContractFactory("FeeSplitter");
  const s = await Splitter.deploy(cfg.PONS_FEE_ESCROW, treasury, bps);
  await s.waitForDeployment();
  const addr = await s.getAddress();
  console.log("FeeSplitter:", addr);
  console.log(`\nNow launch on Pons with creatorFeeRecipient = ${addr}`);
  console.log("Keep the deployer key: it is the only one allowed to call setProtocol() once.");
  if (process.env.VERIFY) {
    await new Promise((r) => setTimeout(r, 15000));
    await run("verify:verify", { address: addr, constructorArguments: [cfg.PONS_FEE_ESCROW, treasury, bps] });
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
