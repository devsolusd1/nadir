// Production config (Robinhood Chain mainnet). Fill in after deploying.
window.BOND_CONFIG = {
  name: "NADIR",
  chainId: 4663,
  chainName: "Robinhood Chain",
  rpc: "https://robinhood-mainnet.g.alchemy.com/v2/alch_Jc-vuH82QY1MfoyAsugxP",
  rpcs: [
    "https://robinhood-mainnet.g.alchemy.com/v2/alch_Jc-vuH82QY1MfoyAsugxP", // Alchemy (restrict this key to the site domain in the Alchemy dashboard)
    "https://rpc.mainnet.chain.robinhood.com",                              // official
    "https://robinhood-rpc.publicnode.com",                                  // publicnode
  ],
  multicall: "0xcA11bde05977b3631167028862bE2a173976CA11", // Multicall3 (verified deployed on chain 4663)
  explorer: "https://robinhoodchain.blockscout.com",
  engine: "0x0000000000000000000000000000000000000000",
  splitter: "0x0000000000000000000000000000000000000000",
  token: "0x0000000000000000000000000000000000000000",
  tokenSymbol: "TOKEN",
  x: "https://x.com/Nadir_rh",
  treasuryBps: 6000,
};
