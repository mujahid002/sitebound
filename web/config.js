const local = ['localhost', '127.0.0.1'].includes(location.hostname);

window.SITEBOUND = {
  chainId: 1874,
  rpcUrl: 'https://rpc.testnet.whitechain.io',
  explorer: 'https://explorer.testnet.whitechain.io',
  address: local ? '0x0000000000000000000000000000000000000000' : '0x43bb27f7079c76D6F0Fa4b4e6d69843e0457DF73',
  token: '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7',
  relayerUrl: local ? 'http://localhost:8787' : 'https://sitebound-relayer.sitebound-relayer.workers.dev',
  frameOrigin: local ? 'http://localhost:8002' : 'https://sitebound-pay.pages.dev',
  relayerFee: '0.01',
};
