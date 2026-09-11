// Robinhood Chain mainnet (chainId 4663) — verified on-chain 2026-09-10/11
module.exports = {
  4663: {
    PONS_FEE_ESCROW: "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e",
    PONS_FACTORY: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
    PONS_LAUNCH_AND_BUY: "0xe33E9E479dF8802cb0866d5d05258bEc4cF62948",
    PONS_MEME_HOOK: "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044",
    UNISWAP_V4_POOL_MANAGER: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    UNISWAP_V4_STATE_VIEW: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
    POOL_FEE: 0,          // Pons launch config 0: poolFee 0 (the hook charges), tickSpacing 200
    TICK_SPACING: 200,
    EXPLORER: "https://robinhoodchain.blockscout.com",
  },
  46630: {
    // Robinhood Chain testnet: fill in if/when Pons publishes testnet deployments
    EXPLORER: "https://explorer.testnet.chain.robinhood.com",
  },
};

// Default engine parameters (1h epochs)
module.exports.DEFAULT_PARAMS = {
  maxBonusBps: 5000,     // +50% at full discount band
  bandBps: 5000,         // full bonus when 50% below target
  entryBurnBps: 100,     // 1% burned on entry
  penaltyBps: 2000,      // 20% early-exit penalty
  releaseBps: 1000,      // 10% of the ETH reserve bought back per epoch
  stakingShareBps: 5000, // 50% of incoming ETH to stakers, 50% to buybacks
  window: 24,            // target = 24h average
  vestEpochs: 24,        // bonds mature after 24h
  minSamples: 6,         // bonds open 6h after start
};
module.exports.EPOCH_LENGTH = 3600;
