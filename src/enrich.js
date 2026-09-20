// One batched round trip per token: birth receipt + runtime code + ERC-20 metadata.
import { decodeFunctionResult, encodeFunctionData, hexToString, parseAbi } from 'viem';
import { fingerprint } from './fingerprint.js';

const ERC20 = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function token0() view returns (address)',
]);
const MULTICALL = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
]);
const FIELDS = ['name', 'symbol', 'decimals', 'totalSupply', 'token0'];

// Token names are attacker-controlled. Keep them short and printable; the UI must still
// treat them as text, never as HTML.
const clean = (s) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80) : null);

function decodeField(fn, data) {
  if (!data || data === '0x') return null;
  try {
    return decodeFunctionResult({ abi: ERC20, functionName: fn, data });
  } catch {
    // bytes32 name/symbol (MKR-style)
    if ((fn === 'name' || fn === 'symbol') && data.length === 66) {
      try { return hexToString(data, { size: 32 }); } catch { return null; }
    }
    return null;
  }
}

function metaCalls(chain, token) {
  if (chain.multicall3) {
    const calls = FIELDS.map((fn) => ({ target: token, allowFailure: true, callData: encodeFunctionData({ abi: ERC20, functionName: fn }) }));
    return [{ method: 'eth_call', params: [{ to: chain.multicall3, data: encodeFunctionData({ abi: MULTICALL, functionName: 'aggregate3', args: [calls] }) }, 'latest'] }];
  }
  return FIELDS.map((fn) => ({ method: 'eth_call', params: [{ to: token, data: encodeFunctionData({ abi: ERC20, functionName: fn }) }, 'latest'] }));
}

const isRevert = (err) => err?.code === 3 || /revert|invalid opcode|out of gas|execution/i.test(err?.message ?? '');

function parseMeta(chain, results) {
  let raw;
  if (chain.multicall3) {
    const r = results[0];
    if (!r || r.error) throw new Error(`Multicall3 call failed: ${r?.error?.message ?? 'no response'}`);
    if (r.result === '0x') throw new Error(`No Multicall3 at ${chain.multicall3} on chain ${chain.id}. Set multicall3 to null for this chain.`);
    const out = decodeFunctionResult({ abi: MULTICALL, functionName: 'aggregate3', data: r.result });
    raw = out.map((x) => (x.success ? x.returnData : null));
  } else {
    raw = results.map((r) => {
      if (!r) throw new Error('metadata call missing from batch');
      if (r.error && !isRevert(r.error)) throw new Error(`metadata call failed: ${r.error.message}`);
      return r.error ? null : r.result;
    });
  }
  const v = Object.fromEntries(FIELDS.map((fn, i) => [fn, decodeField(fn, raw[i])]));
  return {
    name: clean(v.name),
    symbol: clean(v.symbol),
    decimals: v.decimals === null || v.decimals === undefined ? null : Number(v.decimals),
    total_supply: v.totalSupply === null || v.totalSupply === undefined ? null : v.totalSupply.toString(),
    is_lp: v.token0 ? 1 : 0, // exposes token0(): a v2-style LP token, not a launch
  };
}

/** Returns { fp, meta, receipt }. `txHash` may be null (then no receipt is fetched). */
export async function enrichToken(rpc, chain, token, txHash, opts = {}) {
  const calls = [{ method: 'eth_getCode', params: [token, 'latest'] }, ...metaCalls(chain, token)];
  if (txHash) calls.push({ method: 'eth_getTransactionReceipt', params: [txHash] });
  const res = await rpc.batch(calls, opts);
  if (!res[0] || res[0].error) throw new Error(`eth_getCode(${token}) failed: ${res[0]?.error?.message ?? 'no response'}`);
  const code = res[0].result ?? '0x';
  const metaRes = res.slice(1, txHash ? -1 : undefined);
  const last = res[res.length - 1];
  if (txHash && last?.error) throw new Error(`eth_getTransactionReceipt(${txHash}) failed: ${last.error.message}`);
  const receipt = txHash ? last?.result ?? null : null;
  const fp = fingerprint(code);
  return { fp, meta: fp.kind === 'empty' ? {} : parseMeta(chain, metaRes), receipt };
}

export const fpColumns = (fp) => ({
  code_size: fp.size, fp_kind: fp.kind, fp_key: fp.key, fp_exact: fp.exact, impl: fp.impl,
  upgradeable: fp.upgradeable === null ? null : fp.upgradeable ? 1 : 0,
});
