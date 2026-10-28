// update-18: o1 Launchpad (Base + Robinhood) and Base-native B20 tokens.
// Fixtures are real: HAT (o1 v2, 29% minted to one wallet at birth), MOO (o1 v2, none),
// and the B20 controls a lookup reads live (roles, transfer policies, mint headroom).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { B20_CREATED_TOPIC, B20_POLICY_REGISTRY, birthAllocations, isB20, loadRegistry, matchKnownEvent, pad32, ROLE_GRANTED_TOPIC, storedPremint } from '../src/attribution.js';
import { BirthRecorder } from '../src/births.js';
import { openDb } from '../src/db.js';
import { Lookup } from '../src/lookup.js';

const reg = loadRegistry(8453);
const XFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', ZERO = '0x' + '0'.repeat(64);
const O1_LAUNCH = '0x207384e895174175cc774fe7f7457b37c382f27ebf53d37d5257b862f80eaf9c';
const V2 = '0xa52ad458ce0282a971ecc71c051a32f28946bb9f', V2_HOOK = '0x985c14baa2a18316ffda0aefb3a632fadfca2acc', V2_VAULT = '0x3beea54db87a632a5faf20db6765d3af94c81b31';
const POOLMGR = '0x498581ff718922c3f8e6a244956af099b2652b2b';
const HAT = '0xb200000000000000000000443fe9dd40d2340801', FARM = '0xb7faece3935eb274f520b54c0cf0f4fc774f2591', CREATOR = '0x2a68080e14d60fe460ec348bcca5be08b0420fba';
const w = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const E18 = 10n ** 18n;
const mint = (token, to, amount) => ({ address: token, topics: [XFER, ZERO, pad32(to)], data: w(amount * E18) });
const move = (token, from, to, amount) => ({ address: token, topics: [XFER, pad32(from), pad32(to)], data: w(amount * E18) });
const launchLog = (token, creator) => ({ address: V2, topics: [O1_LAUNCH, pad32(token), '0x' + '4f'.repeat(32), pad32(creator)], data: '0x' + w(0).slice(2) + w(10n ** 27n).slice(2) + w(200).slice(2), logIndex: '0x1f3' });
const hatReceipt = () => ({ from: CREATOR, to: V2, blockNumber: '0x2fc8c30', logs: [mint(HAT, FARM, 290_000_000n), mint(HAT, V2_HOOK, 710_000_000n), move(HAT, V2_HOOK, POOLMGR, 710_000_000n), launchLog(HAT, CREATOR)] });

test('o1: one launch event for every factory, on both chains; HAT is o1, credited to its own factory', () => {
  const m = matchKnownEvent(reg, launchLog(HAT, CREATOR));
  assert.deepEqual([m.launchpadId, m.token, m.factory, m.confidence], ['o1', HAT, V2, 'verified']);
  assert.equal(reg.factoryOf.size >= 9, true);
  const rh = loadRegistry(4663);
  const m2 = matchKnownEvent(rh, { ...launchLog('0x2baddd78d4808a45770eb350ec42f12b8786ff01', CREATOR), address: '0xce9c48cfa068947f77738c81be406b53338e5b0d' });
  assert.equal(m2.launchpadId, 'o1');
});

test('birthAllocations: a mint at birth to anyone but the launch is an allocation; the hook, the pool and the vault are not (or are vested)', () => {
  const p = birthAllocations(hatReceipt(), HAT, reg);
  assert.deepEqual(p.allocations, [{ to: FARM, scheduleId: null, amount: (290_000_000n * E18).toString(), unlocked: true, via: 'mint' }]);
  const vested = birthAllocations({ logs: [mint(HAT, V2_VAULT, 50_000_000n), mint(HAT, V2_HOOK, 950_000_000n)] }, HAT, reg);
  assert.deepEqual(vested.allocations.map((a) => [a.to, a.unlocked, a.via]), [[V2_VAULT, false, 'vault']]);
  assert.deepEqual(birthAllocations({ logs: [mint(HAT, V2_HOOK, 1_000_000_000n)] }, HAT, reg), { v: 2 }, 'MOO: everything into the pool');
  assert.equal(storedPremint('{"v":2}', CREATOR), null, 'read, nothing');
});

test('BirthRecorder.record: an o1 launch with a birth allocation is stored with its pre-mint; the page warns 29% unlocked', async () => {
  const store = openDb(':memory:');
  const chain = { id: 8453, name: 'Base', slug: 'base', blockTimeMs: 2000, statsWindowBlocks: 100_000, logsChunk: 2000, multicall3: null, explorer: {}, b20: { factory: '0xb20f000000000000000000000000000000000000', fromBlock: 48_300_000 } };
  const META = { '0x06fdde03': '0x' + w(32).slice(2) + w(13).slice(2) + Buffer.from('blue hard hat').toString('hex').padEnd(64, '0'), '0x95d89b41': '0x' + w(32).slice(2) + w(3).slice(2) + Buffer.from('HAT').toString('hex').padEnd(64, '0'), '0x313ce567': w(18), '0x18160ddd': w(10n ** 27n) };
  const rpc = { batch: async (cs) => cs.map((c) => {
    if (c.method === 'eth_getCode') return { result: c.params[0] === HAT ? '0xef' : '0x' };
    if (c.method === 'eth_getTransactionReceipt') return { result: hatReceipt() };
    if (c.method === 'eth_call' && c.params[0].to === HAT) return { result: META[c.params[0].data.slice(0, 10)] ?? w(0) };
    return { result: w(0) };
  }), call: async () => '0x' };
  const rec = new BirthRecorder({ chain, rpc, registry: reg, store, log: { warn() {}, info() {} } });
  const saved = await rec.record(HAT, 50105264, '0xe6d6', 'registry-event', matchKnownEvent(reg, launchLog(HAT, CREATOR)), {});
  assert.deepEqual([saved.launchpad_id, JSON.parse(saved.premint).allocations[0].to], ['o1', FARM]);
  const lk = new Lookup({ chains: new Map([[8453, chain]]), rpcs: new Map([[8453, rpc]]), registries: new Map([[8453, reg]]), store });
  const b = (await lk.token(8453, HAT)).body;
  assert.deepEqual([b.launchpad.name, b.premint.unlockedPct, b.premint.allocations[0].via], ['o1 Launchpad', 29, 'mint']);
  assert.match(b.verdict.warnings[0], /29% of the supply was minted outside the sale and could be sold from the first block/);
  assert.deepEqual(b.b20.roles, { admin: [], mint: [], seize: [], pause: [] });
});

test('B20 controls: a retained admin, a live mint role, and a sender policy that rejects ordinary holders are all warned about; a hand-made B20 gets its own verdict', async () => {
  const T = '0xb200000000000000000000428e3a3eebbb20692b', DEPLOYER = '0xe090ecbee12d4b6aee5e73ff60945f2545ef5c6f', ADMIN = '0x38467be00970af18076fd08f6b4cf38ba91572b1', LAUNCHER = '0x4ba3e29e254f25e94e61c4c9d67b37027331534d';
  const store = openDb(':memory:');
  const chain = { id: 8453, name: 'Base', slug: 'base', blockTimeMs: 2000, statsWindowBlocks: 100_000, logsChunk: 2000, multicall3: null, explorer: {}, b20: { factory: '0xb20f000000000000000000000000000000000000', fromBlock: 48_300_000 } };
  store.saveToken({ chain_id: 8453, address: T, confidence: 'discovered', birth_block: 51740195, birth_tx: '0xbeef', birth_source: 'discovery', code_size: 1, fp_kind: 'tiny', tx_from: DEPLOYER, total_supply: (10n ** 27n).toString(), decimals: 18, name: 'DJTc', symbol: 'DJTc', premint: '{"v":2}' });
  let calls = 0;
  const rpc = { batch: async (cs) => { if (cs.some((c) => c.params?.[0]?.data === '0x8f770ad0')) calls++; return cs.map((c) => {
    if (c.method === 'eth_getTransactionReceipt') return { result: { from: DEPLOYER, to: LAUNCHER, logs: [{ address: T, topics: [ROLE_GRANTED_TOPIC, '0x' + '0'.repeat(64), pad32(ADMIN), pad32('0xb20f000000000000000000000000000000000000')], data: '0x' }] } };
    const d = c.params[0].data, to = c.params[0].to;
    if (to === B20_POLICY_REGISTRY) return { result: w(0) }; // an ordinary holder is NOT authorized
    if (d === '0x8f770ad0') return { result: w(2n * 10n ** 27n) };
    if (d === '0x18160ddd') return { result: w(10n ** 27n) };
    if (d.startsWith('0xdb3de624')) return { result: w(5) };
    if (d.startsWith('0x91d14854')) { const role = '0x' + d.slice(10, 74), acct = '0x' + d.slice(98); return { result: w(acct === ADMIN && (role === '0x' + '0'.repeat(64) || role.startsWith('0x154c')) ? 1 : 0) }; }
    return { result: w(0) };
  }); } };
  const lk = new Lookup({ chains: new Map([[8453, chain]]), rpcs: new Map([[8453, rpc]]), registries: new Map([[8453, reg]]), store });
  assert.equal(lk.isCheap(8453, T), false, 'live controls cost RPC: rate-limited like an unknown token');
  const b = (await lk.token(8453, T)).body;
  assert.equal(b.verdict.code, 'b20-unlisted');
  assert.deepEqual([b.b20.ordinaryCanSend, b.b20.ordinaryCanReceive, b.b20.mintable, b.b20.creator], [false, false, true, LAUNCHER]);
  assert.deepEqual([b.b20.roles.admin, b.b20.roles.mint], [[ADMIN], [ADMIN]]);
  assert.match(b.verdict.warnings.join('\n'), /Receiving is restricted/);
  assert.match(b.verdict.warnings.join('\n'), /Selling is blocked for ordinary holders/);
  assert.match(b.verdict.warnings.join('\n'), /admin role is still held by 0x38467b/);
  assert.match(b.verdict.warnings.join('\n'), /can still mint up to the supply cap \(minted 1,000,000,000 of 2,000,000,000\)/);
  const n = calls;
  await lk.token(8453, T);
  assert.equal(calls, n, 'controls cached');
});

test('isB20 and the unindexed B20 birth: the precompile log names the token, one call finds it', async () => {
  assert.equal(isB20('0xb200000000000000000000716cb18cab70ff5f01', 1), true);
  assert.equal(isB20('0xb200000000000000000000716cb18cab70ff5f01', 3248), false);
  assert.equal(isB20('0xe2943e4ba51bb08c1222f2a95b10ce4bb18ecba3', 1), false);
  const store = openDb(':memory:');
  const chain = { id: 8453, name: 'Base', slug: 'base', blockTimeMs: 2000, statsWindowBlocks: 100_000, logsChunk: 2000, multicall3: null, explorer: {}, b20: { factory: '0xb20f000000000000000000000000000000000000', fromBlock: 48_300_000 } };
  const seen = [];
  const rpc = {
    call: async (m, p) => { seen.push(m); if (m === 'eth_getLogs') { assert.deepEqual(p[0].topics, [B20_CREATED_TOPIC, pad32(HAT)]); return [{ blockNumber: '0x2fc8c30', transactionHash: '0xe6d6' }]; } return null; },
    batch: async (cs) => cs.map((c) => {
      if (c.method === 'eth_getCode') return { result: c.params[0] === HAT ? '0xef' : '0x' };
      if (c.method === 'eth_getTransactionReceipt') return { result: hatReceipt() };
      if (c.method === 'eth_call' && c.params[0].data === '0x18160ddd') return { result: w(10n ** 27n) };
      if (c.method === 'eth_call' && c.params[0].data === '0x313ce567') return { result: w(18) };
      return { result: w(0) };
    }),
  };
  const lk = new Lookup({ chains: new Map([[8453, chain]]), rpcs: new Map([[8453, rpc]]), registries: new Map([[8453, reg]]), store });
  const b = (await lk.token(8453, HAT)).body;
  assert.deepEqual([b.launchpad?.id, b.birth.block, b.premint.unlockedPct], ['o1', 0x2fc8c30, 29]);
  assert.ok(store.q.getToken.get(8453, HAT), 'recorded');
});

test('older o1 rows (indexed as unlisted, re-attributed from evidence) get their birth allocations on first lookup', async () => {
  const store = openDb(':memory:');
  const chain = { id: 8453, name: 'Base', slug: 'base', blockTimeMs: 2000, statsWindowBlocks: 100_000, logsChunk: 2000, multicall3: null, explorer: {} };
  store.saveToken({ chain_id: 8453, address: HAT, confidence: 'verified', launchpad_id: 'o1', factory: V2, birth_block: 50105264, birth_tx: '0xe6d6', birth_source: 'registry-event', tx_from: CREATOR, premint: '{}', total_supply: (10n ** 27n).toString(), decimals: 18, code_size: 1 });
  let receipts = 0;
  const rpc = { batch: async (cs) => cs.map((c) => { if (c.method === 'eth_getTransactionReceipt') { receipts++; return { result: hatReceipt() }; } return { result: w(0) }; }) };
  const lk = new Lookup({ chains: new Map([[8453, chain]]), rpcs: new Map([[8453, rpc]]), registries: new Map([[8453, reg]]), store });
  assert.equal(lk.isCheap(8453, HAT), false);
  const b = (await lk.token(8453, HAT)).body;
  assert.equal(b.premint.unlockedPct, 29);
  await lk.token(8453, HAT);
  assert.equal(receipts, 1, 'stored with v:2, read once');
});
