// Injected (EIP-1193) wallet helpers for "Pay from my wallet" and the setup popup.
import { SITEBOUND_ABI } from './lib.js';

const C = window.SITEBOUND;
const CHAIN = '0x' + C.chainId.toString(16);

async function useChain(eth) {
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN }] });
  } catch (e) {
    if (e.code !== 4902 && e.data?.originalError?.code !== 4902) throw e;
    await eth.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: CHAIN, chainName: 'Whitechain Testnet', nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 },
        rpcUrls: [C.rpcUrl], blockExplorerUrls: [C.explorer],
      }],
    });
  }
}

// The provider is built after the chain switch: ethers refuses a network that changes under it.
export async function connect(eth) {
  if (!eth) throw new Error('No browser wallet found. Install one (MetaMask, Rabby, …) and reload.');
  const [account] = await eth.request({ method: 'eth_requestAccounts' });
  await useChain(eth);
  return new ethers.BrowserProvider(eth, C.chainId).getSigner(account);
}

export function notDeployed() {
  return /^0x0{40}$/i.test(C.address) ? 'Sitebound is not deployed yet: set address in config.js.' : null;
}

export async function sendPay(eth, input, quote = null) {
  const signer = await connect(eth);
  const sb = new ethers.Contract(C.address, SITEBOUND_ABI, signer);
  const tx = quote ? await sb.payWithQuote(input, quote.expiry, quote.sig) : await sb.pay(input);
  return tx.hash;
}
