// Optional explorer adapters for tokens born before the index started. Tried in order;
// each fails soft (any surprise -> null) and the lookup falls back to bytecode evidence.
//
//   1. Etherscan V2  - one key for every Etherscan-supported chain via ?chainid=.
//                      Robinhood Chain is supported (robin.etherscan.io). Free key: etherscan.io/apis
//   2. Blockscout PRO - one key for every Blockscout chain via ?chainid=. Free key: dev.blockscout.com
//
// Both speak the same Etherscan-compatible getcontractcreation shape, so one parser serves both.
// Neither adapter has been exercised against the live APIs in development (no keys there); they
// are unit-tested against the documented response shape only.

async function tryProvider(url, fetchImpl) {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const body = await res.json();
    const row = Array.isArray(body?.result) ? body.result[0] : null;
    const txHash = row?.txHash ?? row?.tx_hash ?? null;
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash ?? '')) return null;
    const creator = row.contractCreator ?? row.contract_creator ?? null;
    return { txHash: txHash.toLowerCase(), creator: /^0x[0-9a-fA-F]{40}$/.test(creator ?? '') ? creator.toLowerCase() : null };
  } catch {
    return null;
  }
}

const endpoint = (base, chainid, address, apikey) => {
  const u = new URL(base);
  u.search = new URLSearchParams({ chainid: String(chainid), module: 'contract', action: 'getcontractcreation', contractaddresses: address, apikey }).toString();
  return u;
};

export async function findCreation(chain, address, { env = process.env, fetchImpl = fetch } = {}) {
  const chainid = chain.explorer?.chainid ?? chain.id;
  if (env.ETHERSCAN_API_KEY) {
    const hit = await tryProvider(endpoint('https://api.etherscan.io/v2/api', chainid, address, env.ETHERSCAN_API_KEY), fetchImpl);
    if (hit) return hit;
  }
  if (env.BLOCKSCOUT_API_KEY) {
    const hit = await tryProvider(endpoint('https://api.blockscout.com/v2/api', chainid, address, env.BLOCKSCOUT_API_KEY), fetchImpl);
    if (hit) return hit;
  }
  return null;
}
