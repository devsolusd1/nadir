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
  engine: "0xEf94026fcCD0A2D8366BeC05C7da401C7de53152",
  splitter: "0x52d56dD57b815AB4C797Ce8B0aDcC32e1fC8653d",
  token: "0xcce4ee785574d906d53984bab6476cef7e5e033f",
  tokenSymbol: "NADIR",
  x: "https://x.com/Nadir_rh",
  treasuryBps: 6000,
};
