// Step 4 (optional, after the engine exists): deploy sNADIR, the liquid staking receipt on top of the BondEngine.
//   npx hardhat run scripts/4-deploy-snadir.js --network robinhood      (reads TOKEN and ENGINE from .env)
const { ethers, network } = require("hardhat");

async function main() {
  const { TOKEN, ENGINE } = process.env;
  for (const [k, v] of Object.entries({ TOKEN, ENGINE })) if (!v || !ethers.isAddress(v)) throw new Error(`set ${k}=0x... in .env`);
  const [deployer] = await ethers.getSigners();
  console.log("deployer:", deployer.address, "| chain:", network.config.chainId);
  const F = await ethers.getContractFactory("StakedNadir");
  const s = await F.deploy(TOKEN, ENGINE);
  await s.waitForDeployment();
  const addr = await s.getAddress();
  console.log("StakedNadir (sNADIR):", addr);
  console.log("name/symbol:", await s.name(), await s.symbol(), "| engine:", await s.engine(), "| nadir:", await s.nadir());
}
main().catch((e) => { console.error(e); process.exit(1); });
