// Can a buyer sell? A token can be clean and its pool still a trap: on Uniswap v4 the pool's hook
// runs on every swap and may keep the output of a sell (INVISIBLE on Base, 2026-10-28: a fresh
// wallet created a B20 token, opened a v4 pool with its own 16.8 KB hook, and the hook took
// 99.99% of every sell's ETH as a "fee"; the token itself had no tax, no roles, no policy).
// The only honest test is to run the swap: the v4 Quoter executes the pool, hooks included, and
// reverts with the result, so eth_call gives the answer for free. The round trip is ONE quote along
// the path native -> token -> native through the same pool, so the sell sees the pool as the buy
// left it: a thin pool, or a fresh one-sided pool nobody has bought from yet, does not read as a
// trap (two separate quotes would price the sell against the pool before the buy).

import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi } from 'viem';
import { getLogsRange, hex } from './rpc.js';

export const V4_INITIALIZE_TOPIC = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
const QUOTER_ABI = parseAbi([
  'function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)',
  'function quoteExactInput((address exactCurrency,(address intermediateCurrency,uint24 fee,int24 tickSpacing,address hooks,bytes hookData)[] path,uint128 exactAmount) params) returns (uint256 amountOut,uint256 gasEstimate)',
]);
const NATIVE = '0x0000000000000000000000000000000000000000';
export const PROBE_WEI = 200_000_000_000_000n; // 0.0002 of the native coin: small enough to move no real pool

const pad32 = (a) => '0x' + '0'.repeat(24) + a.toLowerCase().slice(2);
const addr = (word) => '0x' + word.slice(-40).toLowerCase();

/** Pool keys of the token's v4 pools against the native coin or its wrapped form, from Initialize logs. */
export function poolKeysFrom(logs, token, v4) {
  const t = token.toLowerCase();
  const keys = [];
  for (const l of logs) {
    if (l.address?.toLowerCase() !== v4.poolManager || l.topics?.[0] !== V4_INITIALIZE_TOPIC) continue;
    const c0 = addr(l.topics[2]), c1 = addr(l.topics[3]);
    const other = c0 === t ? c1 : c1 === t ? c0 : null;
    if (other !== NATIVE && other !== v4.wrappedNative) continue;
    const d = l.data.slice(2);
    keys.push({ currency0: c0, currency1: c1, fee: Number(BigInt('0x' + d.slice(0, 64))), tickSpacing: Number(BigInt.asIntN(256, BigInt('0x' + d.slice(64, 128)))),
      hooks: addr(d.slice(128, 192)), block: Number(l.blockNumber) });
  }
  return keys;
}

/** eth_call: a buy of `amount` native in the pool (quoteExactInputSingle). */
export function buyCall(v4, key, token, amount) {
  return { method: 'eth_call', params: [{ to: v4.quoter, data: encodeFunctionData({ abi: QUOTER_ABI, functionName: 'quoteExactInputSingle',
    args: [{ poolKey: { currency0: key.currency0, currency1: key.currency1, fee: key.fee, tickSpacing: key.tickSpacing, hooks: key.hooks }, zeroForOne: key.currency1 === token, exactAmount: amount, hookData: '0x' }] }) }, 'latest'] };
}
/** eth_call: buy with `amount` native and sell everything bought straight back, in one quote (quoteExactInput, two hops). */
export function roundTripCall(v4, key, token, amount) {
  const native = key.currency0 === token ? key.currency1 : key.currency0;
  const hop = (to) => ({ intermediateCurrency: to, fee: key.fee, tickSpacing: key.tickSpacing, hooks: key.hooks, hookData: '0x' });
  return { method: 'eth_call', params: [{ to: v4.quoter, data: encodeFunctionData({ abi: QUOTER_ABI, functionName: 'quoteExactInput',
    args: [{ exactCurrency: native, path: [hop(token), hop(native)], exactAmount: amount }] }) }, 'latest'] };
}
/** amountOut of either quote, or { revert } with the node's message. */
export function decodeQuote(res) {
  if (!res || res.error || !res.result || res.result === '0x') return { revert: res?.error?.message ?? 'no result' };
  try { return { out: decodeFunctionResult({ abi: QUOTER_ABI, functionName: 'quoteExactInput', data: res.result })[0] }; } catch (e) { return { revert: e.message }; }
}

/**
 * Find the token's native-paired v4 pools (Initialize logs from `fromBlock`, `spanBlocks` long; with
 * no known birth block, the last `spanBlocks` before head),
 * then quote, per pool, a 0.0002 buy and the round trip (that buy sold straight back) in one batch
 * (at most 3 pools). Returns null when there is no such pool or the chain has no v4 settings,
 * `untradable` when no pool can be bought from, otherwise the result of the pool a router would pick
 * (the most tokens for the buy), with the other pools summarised in `others`: anyone can open a pool
 * of any token, so a trap pool beside the real one does not make the token a trap.
 * `trapHooks` (registry: runtime-code keccak -> { name }) names a pool hook that is a copy of a known
 * trap template, even when its pool has been emptied and nothing can be quoted (one getCode batch).
 */
export async function sellCheck({ chain, rpc, token, fromBlock, spanBlocks, priority = true, trapHooks = null }) {
  const v4 = chain.v4;
  if (!v4) return null;
  const head = Number(await rpc.call('eth_blockNumber', [], { priority }));
  const from = fromBlock ?? Math.max(0, head - spanBlocks);
  const to = Math.min(head, from + spanBlocks);
  const urgent = { call: (m, p) => rpc.call(m, p, { priority }) };
  const state = { span: Math.max(1, chain.addrLogsSpan ?? 2000), max: Math.max(1, chain.addrLogsSpan ?? 2000) };
  const tPad = pad32(token);
  const [as0, as1] = await Promise.all([
    getLogsRange(urgent, { address: v4.poolManager, topics: [V4_INITIALIZE_TOPIC, null, tPad] }, from, to, state, chain.logsSoftCap ?? 9500),
    getLogsRange(urgent, { address: v4.poolManager, topics: [V4_INITIALIZE_TOPIC, null, null, tPad] }, from, to, { ...state }, chain.logsSoftCap ?? 9500),
  ]);
  const keys = poolKeysFrom([...as0, ...as1], token, v4).slice(0, 3);
  if (!keys.length) return null;
  const hooked = [...new Set(keys.map((k) => k.hooks).filter((h) => !/^0x0{40}$/.test(h)))];
  if (hooked.length && trapHooks?.size) {
    const codes = await rpc.batch(hooked.map((h) => ({ method: 'eth_getCode', params: [h, 'latest'] })), { priority });
    hooked.forEach((h, i) => {
      const code = codes[i]?.result;
      if (!code || code === '0x') return;
      const hash = keccak256(code), known = trapHooks.get(hash);
      for (const k of keys) if (k.hooks === h) Object.assign(k, { hookCodeHash: hash }, known ? { knownTrap: known.name } : {});
    });
  }
  const trapKey = keys.find((k) => k.knownTrap);
  const knownTrap = trapKey ? { hook: trapKey.hooks, name: trapKey.knownTrap } : null;
  const results = [];
  const t = token.toLowerCase();
  for (const key of keys) {
    const [b, r] = await rpc.batch([buyCall(v4, key, t, PROBE_WEI), roundTripCall(v4, key, t, PROBE_WEI)], { priority });
    const buy = decodeQuote(b), trip = decodeQuote(r);
    if (buy.revert || !buy.out) { results.push({ pool: key, verdict: 'buy-reverts', error: String(buy.revert ?? 'zero out').slice(0, 160) }); continue; }
    if (trip.revert) { results.push({ pool: key, verdict: 'sell-reverts', bought: buy.out.toString(), error: String(trip.revert).slice(0, 160) }); continue; }
    const back = trip.out;
    const returnPct = Number((back * 1_000_000n) / PROBE_WEI) / 10_000; // 4 decimals, so a 99.99% tax is not shown as 0%
    results.push({ pool: key, verdict: returnPct < 50 ? 'trap' : returnPct < 90 ? 'heavy-fees' : 'ok', paid: PROBE_WEI.toString(), bought: buy.out.toString(), back: back.toString(), returnPct });
  }
  // a pool nobody can buy from (initialized, never funded) says nothing about selling
  const tradable = results.filter((r) => r.verdict !== 'buy-reverts');
  if (!tradable.length) return { verdict: 'untradable', poolsChecked: results.length, pool: results[0].pool, error: results[0].error, knownTrap };
  const cmp = (a, b) => (a > b) - (a < b);
  tradable.sort((x, y) => cmp(BigInt(y.bought), BigInt(x.bought)));
  const [main, ...rest] = tradable;
  const others = rest.map((r) => ({ hooks: r.pool.hooks, fee: r.pool.fee, verdict: r.verdict, returnPct: r.returnPct ?? null }));
  return { ...main, poolsChecked: results.length, others, knownTrap };
}
