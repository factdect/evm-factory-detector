// Optional explorer adapter for tokens born before the index started.
// Blockscout PRO: one free key (dev.blockscout.com) covers every Blockscout chain via ?chainid=.
// NOTE: written against the documented Etherscan-compatible response shape; not exercised
// against the live API in development (no key available there). It fails soft: any
// surprise returns null and the lookup falls back to bytecode evidence only.
export async function findCreation(chain, address, { apiKey = process.env.BLOCKSCOUT_API_KEY, fetchImpl = fetch } = {}) {
  if (!apiKey || chain.explorer?.kind !== 'blockscout-pro') return null;
  try {
    const u = new URL('https://api.blockscout.com/v2/api');
    u.search = new URLSearchParams({
      chainid: String(chain.explorer.chainid), module: 'contract', action: 'getcontractcreation',
      contractaddresses: address, apikey: apiKey,
    }).toString();
    const res = await fetchImpl(u, { signal: AbortSignal.timeout(10000) });
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
