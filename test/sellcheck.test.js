// update-19: a pool's hook can keep a sell's output while the token itself is clean
// (INVISIBLE on Base, 2026-10-28). The sell test quotes a buy and the sale of what it bought.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeAbiParameters, toFunctionSelector } from 'viem';
import { PROBE_WEI, poolKeysFrom, sellCheck, V4_INITIALIZE_TOPIC } from '../src/sellcheck.js';
import { openDb } from '../src/db.js';
import { loadRegistry } from '../src/attribution.js';
import { Lookup } from '../src/lookup.js';

const PM = '0x498581ff718922c3f8e6a244956af099b2652b2b', QUOTER = '0x0d5e0f971ed27fbff6c2837bf31316121532048d', WETH = '0x4200000000000000000000000000000000000006';
const T = '0xb2000000000000000000006996930ba855ea5774', HOOK = '0xbacb63b3aca5e164cfcda95fdc21a7fa4ee240cc';
const v4 = { poolManager: PM, quoter: QUOTER, wrappedNative: WETH };
const chain = { id: 8453, name: 'Base', slug: 'base', blockTimeMs: 2000, statsWindowBlocks: 100_000, logsChunk: 2000, addrLogsSpan: 100_000, multicall3: null, explorer: {}, v4 };
const pad = (a) => '0x' + '0'.repeat(24) + a.slice(2);
const w = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0');
const initLog = (c0, c1, hooks, fee = 100, ts = 1) => ({ address: PM, topics: [V4_INITIALIZE_TOPIC, '0x' + 'ab'.repeat(32), pad(c0), pad(c1)], data: '0x' + w(fee) + w(ts) + w(hooks) + w(1n << 96n) + w(0), blockNumber: '0x32bd4a0' });
const quoteResult = (out) => ({ result: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [out, 100000n]) });
const SINGLE = toFunctionSelector('quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))');
const MULTI = toFunctionSelector('quoteExactInput((address,(address,uint24,int24,address,bytes)[],uint128))');
// buyOut: the buy quote (null = reverts); backOut: the round trip (buy, then sell it all back) quote
function rpcFor({ pools, buyOut, backOut, sellRevert = false }) {
  return {
    call: async (m, p) => { if (m === 'eth_blockNumber') return '0x32c0000'; if (m === 'eth_getLogs') { const f = p[0]; return pools.filter((l) => (f.topics[2] ? l.topics[2] === f.topics[2] : l.topics[3] === f.topics[3])); } return null; },
    batch: async (cs) => cs.map((c) => {
      if (c.params[0].to !== QUOTER) return { result: '0x' };
      const sel = c.params[0].data.slice(0, 10);
      if (sel === SINGLE) return buyOut == null ? { error: { message: 'execution reverted' } } : quoteResult(buyOut);
      if (sel === MULTI) return buyOut == null || sellRevert ? { error: { message: 'execution reverted: HookCallFailed' } } : quoteResult(backOut);
      throw new Error('unexpected call ' + sel);
    }),
  };
}

test('poolKeysFrom: only native- or WETH-paired pools of the token, with fee, tick spacing and hook', () => {
  const keys = poolKeysFrom([initLog('0x0000000000000000000000000000000000000000', T, HOOK), initLog('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', T, HOOK)], T, v4);
  assert.deepEqual(keys.map((k) => [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]), [['0x0000000000000000000000000000000000000000', T, 100, 1, HOOK]]);
});

test('sellCheck: INVISIBLE (hook keeps 99.99% of the sell) is a trap; a normal pool is ok; a reverting sell says so; an unfunded pool is untradable', async () => {
  const pools = [initLog('0x0000000000000000000000000000000000000000', T, HOOK)];
  const trap = await sellCheck({ chain, rpc: rpcFor({ pools, buyOut: 54703n * 10n ** 18n, backOut: 19_991_828_985n }), token: T, fromBlock: 53204372, spanBlocks: 86400 });
  assert.deepEqual([trap.verdict, trap.returnPct, trap.pool.hooks], ['trap', 0.0099, HOOK]);
  const ok = await sellCheck({ chain, rpc: rpcFor({ pools, buyOut: 1000n, backOut: PROBE_WEI * 98n / 100n }), token: T, fromBlock: 1, spanBlocks: 10 });
  assert.deepEqual([ok.verdict, ok.returnPct], ['ok', 98]);
  const rev = await sellCheck({ chain, rpc: rpcFor({ pools, buyOut: 1000n, sellRevert: true }), token: T, fromBlock: 1, spanBlocks: 10 });
  assert.equal(rev.verdict, 'sell-reverts');
  const empty = await sellCheck({ chain, rpc: rpcFor({ pools, buyOut: null }), token: T, fromBlock: 1, spanBlocks: 10 });
  assert.deepEqual([empty.verdict, empty.poolsChecked, empty.pool.hooks, empty.knownTrap], ['untradable', 1, HOOK, null]);
  assert.equal(await sellCheck({ chain, rpc: rpcFor({ pools: [] }), token: T, fromBlock: 1, spanBlocks: 10 }), null);
});

test('lookup: a token with no known launchpad gets the sell test and its warning leads; a launchpad token does not pay for it', async () => {
  const store = openDb(':memory:');
  store.saveToken({ chain_id: 8453, address: T, confidence: 'discovered', birth_block: 53204372, birth_tx: '0x82d6', birth_source: 'discovery', code_size: 3000, decimals: 18, name: 'INVISIBLE', symbol: 'INVISIBLE', premint: '{"v":2}', tx_from: '0xa7bd' });
  const rpc = rpcFor({ pools: [initLog('0x0000000000000000000000000000000000000000', T, HOOK)], buyOut: 54703n * 10n ** 18n, backOut: 19_991_828_985n });
  const lk = new Lookup({ chains: new Map([[8453, chain]]), rpcs: new Map([[8453, rpc]]), registries: new Map([[8453, loadRegistry(8453)]]), store });
  const b = (await lk.token(8453, T)).body;
  assert.equal(b.sellCheck.verdict, 'trap');
  assert.match(b.verdict.warnings[0], /returns only under 0\.01% through the token's Uniswap v4 pool \(hook 0xbacb63b3/);
  const L = '0xb200000000000000000000443fe9dd40d2340801';
  store.saveToken({ chain_id: 8453, address: L, confidence: 'verified', launchpad_id: 'o1', factory: '0xa52ad458ce0282a971ecc71c051a32f28946bb9f', birth_block: 1, birth_tx: '0x1', code_size: 3000, premint: '{"v":2}', tx_from: '0x2a68' });
  const b2 = (await lk.token(8453, L)).body;
  assert.equal(b2.sellCheck, null);
  // a token of unknown age (no birth block) is not judged by whatever pool someone opened lately
  const O = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
  store.saveToken({ chain_id: 8453, address: O, confidence: 'none', birth_block: null, code_size: 2500, premint: null });
  assert.equal((await lk.token(8453, O)).body.sellCheck, null);
  // a pool whose own LP fee is 86.6% (no hook) is a fee trap; the test costs RPC until cached
  const U = '0x099903713bfb4c97e0fec5b59bdc22c04fb11ed9';
  store.saveToken({ chain_id: 8453, address: U, confidence: 'discovered', birth_block: 53202000, code_size: 2500, premint: '{"v":2}' });
  const lk2 = new Lookup({ chains: new Map([[8453, chain]]), rpcs: new Map([[8453, rpcFor({ pools: [initLog('0x0000000000000000000000000000000000000000', U, '0x0000000000000000000000000000000000000000', 865630, 200)], buyOut: 10n ** 22n, backOut: 3_672_392_749_913n })]]), registries: new Map([[8453, loadRegistry(8453)]]), store });
  assert.equal(lk2.isCheap(8453, U), false);
  const b3 = (await lk2.token(8453, U)).body;
  assert.deepEqual([b3.sellCheck.verdict, b3.sellCheck.returnPct], ['trap', 1.8361]);
  assert.ok(b3.verdict.warnings.some((w) => /whose own fee is 86\.563% per swap/.test(w)), b3.verdict.warnings.join(' | '));
});

test('the round trip is one quote along native -> token -> native through the same pool and hook', async () => {
  const { decodeFunctionData, parseAbi } = await import('viem');
  const { roundTripCall, buyCall } = await import('../src/sellcheck.js');
  const key = { currency0: '0x0000000000000000000000000000000000000000', currency1: T, fee: 100, tickSpacing: 1, hooks: HOOK };
  const abi = parseAbi(['function quoteExactInput((address exactCurrency,(address intermediateCurrency,uint24 fee,int24 tickSpacing,address hooks,bytes hookData)[] path,uint128 exactAmount) params) returns (uint256,uint256)',
    'function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256,uint256)']);
  const rt = decodeFunctionData({ abi, data: roundTripCall(v4, key, T, PROBE_WEI).params[0].data }).args[0];
  assert.equal(rt.exactCurrency, '0x0000000000000000000000000000000000000000');
  assert.deepEqual(rt.path.map((h) => [h.intermediateCurrency.toLowerCase(), h.fee, h.tickSpacing, h.hooks.toLowerCase()]), [[T, 100, 1, HOOK], ['0x0000000000000000000000000000000000000000', 100, 1, HOOK]]);
  assert.equal(rt.exactAmount, PROBE_WEI);
  const buy = decodeFunctionData({ abi, data: buyCall(v4, key, T, PROBE_WEI).params[0].data }).args[0];
  assert.equal(buy.zeroForOne, true); // native is currency0: buying the token is zero for one
});

test('a hook with the bytecode of a known trap template is named, even when its pool is empty', async () => {
  const { keccak256 } = await import('viem');
  const code = '0x6080604052' + 'ab'.repeat(40);
  const trapHooks = new Map([[keccak256(code), { name: 'B20 sell-trap hook (INVISIBLE template)' }]]);
  const pools = [initLog('0x0000000000000000000000000000000000000000', T, HOOK)];
  const base = rpcFor({ pools, buyOut: null });
  let codeCalls = 0;
  const rpc = { ...base, batch: async (cs) => (cs[0].method === 'eth_getCode' ? (codeCalls++, cs.map((c) => ({ result: c.params[0] === HOOK ? code : '0x' }))) : base.batch(cs)) };
  const r = await sellCheck({ chain, rpc, token: T, fromBlock: 1, spanBlocks: 10, trapHooks });
  assert.deepEqual([r.verdict, r.knownTrap], ['untradable', { hook: HOOK, name: 'B20 sell-trap hook (INVISIBLE template)' }]);
  // no registry templates on this chain: no getCode call is spent
  await sellCheck({ chain, rpc, token: T, fromBlock: 1, spanBlocks: 10, trapHooks: new Map() });
  assert.equal(codeCalls, 1);
  // the shipped Base registry carries the INVISIBLE template
  const reg = loadRegistry(8453);
  assert.equal(reg.trapHooks.get('0x42db5cca66c87d0d48cbb61a0165ab6ddf0bb98b664d6dda94ee5103f273fa89')?.name, 'B20 sell-trap hook (INVISIBLE template)');
  assert.equal(loadRegistry(4663).trapHooks.size, 0);
});

test('the verdict is the pool a router would pick: a stranger\'s trap pool beside the real one is a note, not the verdict', async () => {
  const H2 = '0x2ec73784e859e15d7cfb6b56aac40b32eb9b80cc';
  const pools = [initLog('0x0000000000000000000000000000000000000000', T, '0x0000000000000000000000000000000000000000', 3000, 60), initLog('0x0000000000000000000000000000000000000000', T, H2, 100, 1)];
  // the real pool gives 1,000 tokens and 99.4% back; the trap pool gives 10 tokens and 0.01% back
  const rpc = rpcFor({ pools, buyOut: 0n, backOut: 0n });
  rpc.batch = async (cs) => cs.map((c) => {
    if (c.method === 'eth_getCode') return { result: '0x60016001' }; // not a known template
    const d = c.params[0].data, isTrap = d.includes(H2.slice(2));
    return d.startsWith(SINGLE) ? quoteResult(isTrap ? 10n : 1000n) : quoteResult(isTrap ? PROBE_WEI / 10_000n : PROBE_WEI * 994n / 1000n);
  });
  const r = await sellCheck({ chain, rpc, token: T, fromBlock: 1, spanBlocks: 10 });
  assert.deepEqual([r.verdict, r.returnPct, r.pool.hooks], ['ok', 99.4, '0x0000000000000000000000000000000000000000']);
  assert.deepEqual(r.others, [{ hooks: H2, fee: 100, verdict: 'trap', returnPct: 0.01 }]);
  const store = openDb(':memory:');
  store.saveToken({ chain_id: 8453, address: T, confidence: 'discovered', birth_block: 1, birth_tx: '0x1', code_size: 3000, premint: '{"v":2}', tx_from: '0x1' });
  const lk = new Lookup({ chains: new Map([[8453, chain]]), rpcs: new Map([[8453, rpc]]), registries: new Map([[8453, loadRegistry(8453)]]), store });
  const w = (await lk.token(8453, T)).body.verdict.warnings;
  assert.ok(!w.some((x) => /Buyers lose/.test(x)), w.join(' | '));
  assert.ok(w.some((x) => /Another Uniswap v4 pool of this token \(hook 0x2ec73784e859e15d7cfb6b56aac40b32eb9b80cc\) returns only 0\.01%/.test(x)), w.join(' | '));
});
