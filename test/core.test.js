import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadRegistry, matchKnownEvent, pad32, refsForToken, resolvePlatform } from '../src/attribution.js';
import { probeFirstLog } from '../src/age.js';
import { birthFacts, probePendingPlatforms, reattributeFromEvidence } from '../src/births.js';
import { openDb } from '../src/db.js';
import { findCreation } from '../src/explorer.js';
import { Lookup } from '../src/lookup.js';
import { fingerprint } from '../src/fingerprint.js';
import { getLogsRange, Rpc, RpcError } from '../src/rpc.js';

// ---- real bytecode captured from Robinhood Chain, 2026-09-20 --------------------------------
const LONG_CLONE = '0x3d3d3d3d363d3d37363d733be8b97fd0e713b5abe0649fa830223b6b4bc5995af43d3d93803e602a57fd5bf3';
const EIP1167 = '0x363d3d373d3d3d363d737777c8743c88b3aff3cf262135bef2c8b2e833335af43d82803e903d91602b57fd5bf3';
const ERC1967_PROXY = '0x60806040527f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545f9081906001600160a01b0316368280378136915af43d5f803e156048573d5ff35b3d5ffdfea2646970667358221220518c41b405a21ac7a21acca5452dcd929d231a58417cfb3c906dc2c0cd8a490e64736f6c63430008230033';

test('fingerprint: 0age 44-byte clone (Long.xyz) resolves its implementation and is not upgradeable', () => {
  const f = fingerprint(LONG_CLONE);
  assert.equal(f.size, 44);
  assert.equal(f.kind, 'minimal-proxy');
  assert.equal(f.impl, '0x3be8b97fd0e713b5abe0649fa830223b6b4bc599');
  assert.equal(f.key, 'proxy:0x3be8b97fd0e713b5abe0649fa830223b6b4bc599');
  assert.equal(f.upgradeable, false);
});

test('fingerprint: EIP-1167 45-byte clone (Flap)', () => {
  const f = fingerprint(EIP1167);
  assert.equal(f.size, 45);
  assert.equal(f.impl, '0x7777c8743c88b3aff3cf262135bef2c8b2e83333');
});

test('fingerprint: vanity clone with a PUSH19 implementation (leading zero byte) is left-padded', () => {
  const f = fingerprint('0x363d3d373d3d3d363d72' + 'ab'.repeat(19) + '5af43d82803e903d91602a57fd5bf3');
  assert.equal(f.kind, 'minimal-proxy');
  assert.equal(f.impl, '0x00' + 'ab'.repeat(19));
});

test('fingerprint: EIP-1967 proxy is flagged upgradeable, not mistaken for a minimal clone', () => {
  const f = fingerprint(ERC1967_PROXY);
  assert.equal(f.kind, 'eip1967-proxy');
  assert.equal(f.upgradeable, true);
  assert.equal(f.impl, null);
});

test('fingerprint: tokens that differ only in immutables share a skeleton but not an exact hash', () => {
  const body = (imm) => '0x6080604052' + '7f' + imm.repeat(32) + '600052' + '73' + '11'.repeat(20) + '5060206000f3';
  const a = fingerprint(body('aa'));
  const b = fingerprint(body('bb'));
  assert.equal(a.kind, 'contract');
  assert.equal(a.key, b.key);
  assert.notEqual(a.exact, b.exact);
  const other = fingerprint('0x6080604052' + '7f' + 'aa'.repeat(32) + '600152' + '73' + '11'.repeat(20) + '5060206000f3');
  assert.equal(other.key, a.key, 'PUSH1 operand differences are masked too (skeleton = opcodes only)');
  assert.notEqual(fingerprint('0x6080604052600080fd').key, a.key);
});

test('fingerprint: empty code and a PUSH truncated by the end of code', () => {
  assert.equal(fingerprint('0x').kind, 'empty');
  assert.equal(fingerprint(null).kind, 'empty');
  assert.doesNotThrow(() => fingerprint('0x60806040527fabcd'));
});

// ---- attribution ------------------------------------------------------------------------------
const reg = loadRegistry(4663);
const TOKEN = '0x642dbfff1ab4482e55d20120a2f952d409531e18';
const AIRLOCK = '0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862';
const CREATE_T0 = '0x68ff1cfcdcf76864161555fc0de1878d8f83ec6949bf351df74d8a4a1a2679ab';
const createLog = (emitter) => ({
  address: emitter, logIndex: '0x5',
  topics: [CREATE_T0, '0x' + '0'.repeat(64)],
  data: '0x' + pad32(TOKEN).slice(2) + pad32('0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544').slice(2) + pad32('0x8366a39cc670b4001a1121b8f6a443a643e40951').slice(2),
});

test('attribution: Airlock Create from the published Airlock is a verified Doppler launch; the app comes later', () => {
  const m = matchKnownEvent(reg, createLog(AIRLOCK));
  assert.equal(m.token, TOKEN);
  assert.equal(m.launchpadId, 'doppler');
  assert.ok(m.platform, 'carries the integrator resolver');
  assert.equal(m.confidence, 'verified');
  assert.equal(m.fields.numeraire, '0x' + '0'.repeat(40));
});

test('attribution: the same event from any other contract is never credited to the launchpad', () => {
  const m = matchKnownEvent(reg, createLog('0x' + 'be'.repeat(20)));
  assert.equal(m.launchpadId, null);
  assert.equal(m.confidence, 'unverified-emitter');
  assert.deepEqual(m.family, ['doppler']);
});

test('attribution: checksummed / upper-case input still matches', () => {
  const log = createLog(AIRLOCK.toUpperCase().replace('0X', '0x'));
  log.topics = log.topics.map((t) => t.toUpperCase().replace('0X', '0x'));
  assert.equal(matchKnownEvent(reg, log).confidence, 'verified');
});

test('attribution: one signature, two launchpads: the emitter decides (Pons v1 vs NoxaFun vs unknown)', () => {
  const T0 = '0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a';
  const log = (emitter) => ({ address: emitter, logIndex: '0x1', topics: [T0, pad32(TOKEN), pad32('0x' + '01'.repeat(20)), pad32('0x1f7d7550b1b028f7571e69a784071f0205fd2efa')], data: '0x' + '0'.repeat(64 * 7) });
  assert.equal(matchKnownEvent(reg, log('0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb')).launchpadId, 'pons-v1');
  assert.equal(matchKnownEvent(reg, log('0xd9ec2db5f3d1b236843925949fe5bd8a3836fccb')).launchpadId, 'noxafun');
  const observed = matchKnownEvent(reg, log('0xf4fc0cd27fc8ecf17e55ee4c3f7201897df3eb75'));
  assert.deepEqual([observed.launchpadId, observed.confidence], ['pons-v1', 'observed-emitter'], 'found on-chain by us, not published: never "verified"');
  const unknown = matchKnownEvent(reg, log('0x' + 'c0'.repeat(20)));
  assert.equal(unknown.launchpadId, null);
  assert.deepEqual(unknown.family.sort(), ['noxafun', 'pons-v1']);
  // the chain's shared UniswapV3Factory must not be on anyone's allowlist
  assert.equal(matchKnownEvent(reg, log('0x1f7d7550b1b028f7571e69a784071f0205fd2efa')).launchpadId, null);
});

test('attribution: malformed logs do not produce a token', () => {
  assert.equal(matchKnownEvent(reg, { address: AIRLOCK, topics: [CREATE_T0], data: '0x' }), null);
  assert.equal(matchKnownEvent(reg, { address: AIRLOCK, topics: [CREATE_T0], data: '0x' + 'ff'.repeat(32) }), null, 'word is not an address');
  assert.equal(matchKnownEvent(reg, { address: AIRLOCK, topics: ['0x' + '12'.repeat(32)], data: '0x' }), null);
  assert.equal(matchKnownEvent(reg, { address: AIRLOCK, topics: [], data: '0x' }), null);
});

test('refsForToken: topic mention, aligned data mention, self excluded, unaligned ignored', () => {
  const needle = pad32(TOKEN);
  const logs = [
    { address: TOKEN, logIndex: '0x0', topics: ['0xaa', needle], data: '0x' },                       // the token itself
    { address: '0x' + '0a'.repeat(20), logIndex: '0x1', topics: ['0xbb', needle], data: '0x' },      // topic
    { address: '0x' + '0b'.repeat(20), logIndex: '0x2', topics: ['0xcc'], data: '0x' + '0'.repeat(64) + needle.slice(2) }, // data word 1
    { address: '0x' + '0c'.repeat(20), logIndex: '0x3', topics: ['0xdd'], data: '0x00' + needle.slice(2) + '0'.repeat(62) }, // shifted by 1 byte
    { address: '0x' + '0d'.repeat(20), logIndex: '0x4', topics: [needle], data: '0x' },              // topic0 itself is not a mention
  ];
  assert.deepEqual(refsForToken(logs, TOKEN).map((r) => r.emitter), ['0x' + '0a'.repeat(20), '0x' + '0b'.repeat(20)]);
});

// ---- persistence ------------------------------------------------------------------------------
test('saveToken: stronger evidence replaces weaker, weaker never downgrades, gaps get filled', () => {
  const { q, saveToken } = openDb(':memory:');
  const base = { chain_id: 1, address: '0xa' };
  saveToken({ ...base, confidence: 'discovered', birth_block: 5, birth_tx: '0x1', birth_source: 'discovery', code_size: 44 });
  saveToken({ ...base, confidence: 'verified', launchpad_id: 'long-xyz', factory: '0xf', birth_block: 5, birth_tx: '0x1', birth_source: 'registry-event', name: 'X' });
  saveToken({ ...base, confidence: 'unverified-emitter', launchpad_id: null, factory: '0xevil', symbol: 'SYM' });
  const t = q.getToken.get(1, '0xa');
  assert.equal(t.confidence, 'verified');
  assert.equal(t.launchpad_id, 'long-xyz');
  assert.equal(t.factory, '0xf');
  assert.equal(t.code_size, 44);
  assert.equal(t.symbol, 'SYM');
});

// ---- RPC plumbing -----------------------------------------------------------------------------
test('getLogsRange: shrinks on node errors and on suspiciously full results, covers the range exactly once', async () => {
  const asked = [];
  const rpc = { call: async (_m, [f]) => {
    const a = Number(f.fromBlock), b = Number(f.toBlock);
    if (b - a + 1 > 400) throw new RpcError('eth_getLogs', { code: -32000, message: 'query returned more than 10000 results' });
    asked.push([a, b]);
    return Array.from({ length: b - a + 1 }, (_, i) => ({ blockNumber: a + i }));
  } };
  const logs = await getLogsRange(rpc, {}, 1000, 3999, { span: 2000, max: 2000 }, 9500);
  assert.equal(logs.length, 3000);
  assert.deepEqual(logs.map((l) => l.blockNumber), Array.from({ length: 3000 }, (_, i) => 1000 + i));

  const capped = { call: async (_m, [f]) => Array.from({ length: Number(f.toBlock) - Number(f.fromBlock) + 1 }, () => ({})) };
  const out = await getLogsRange(capped, {}, 0, 99, { span: 100, max: 100 }, 60);
  assert.equal(out.length, 100, 'a result at the soft cap is re-fetched in halves, not trusted');
});

test('Rpc: batch results are matched by id, and an HTTP 429 is retried', async () => {
  const real = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async (_url, init) => {
    n++;
    if (n === 1) return new Response('slow down', { status: 429 });
    const parsed = JSON.parse(init.body);
    const single = !Array.isArray(parsed);
    const reqs = single ? [parsed] : parsed;
    const body = reqs.map((r) => (r.method === 'boom' ? { jsonrpc: '2.0', id: r.id, error: { code: -32000, message: 'nope' } } : { jsonrpc: '2.0', id: r.id, result: r.method })).reverse();
    return new Response(JSON.stringify(single ? body[0] : body), { status: 200 });
  };
  try {
    const rpc = new Rpc({ url: 'http://stub', minIntervalMs: 0 });
    const res = await rpc.batch([{ method: 'a' }, { method: 'boom' }, { method: 'c' }]);
    assert.deepEqual(res.map((r) => r.result ?? r.error.message), ['a', 'nope', 'c']);
    assert.equal(rpc.stats.rateLimited, 1);
    await assert.rejects(() => rpc.call('boom'), RpcError);
  } finally {
    globalThis.fetch = real;
  }
});

// ---- explorer adapters (stubbed: no live keys in development) -----------------------------------
test('findCreation: parses the Etherscan-compatible shape, tries Etherscan V2 then Blockscout, fails soft', async () => {
  const chain = { id: 4663, explorer: { kind: 'blockscout-pro', chainid: 4663 } };
  const good = JSON.stringify({ status: '1', result: [{ contractAddress: TOKEN, contractCreator: AIRLOCK.toUpperCase().replace('0X', '0x'), txHash: '0x' + 'AB'.repeat(32) }] });
  const want = { txHash: '0x' + 'ab'.repeat(32), creator: AIRLOCK };

  const calls = [];
  const record = (body, status = 200) => async (url) => { calls.push(String(url)); return new Response(body, { status }); };

  // both keys set: Etherscan answers, Blockscout never called
  calls.length = 0;
  assert.deepEqual(await findCreation(chain, TOKEN, { env: { ETHERSCAN_API_KEY: 'e', BLOCKSCOUT_API_KEY: 'b' }, fetchImpl: record(good) }), want);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /api\.etherscan\.io\/v2\/api\?chainid=4663.*getcontractcreation/);

  // Etherscan rate-limited -> falls through to Blockscout
  calls.length = 0;
  let n = 0;
  const flaky = async (url) => { calls.push(String(url)); return new Response(n++ === 0 ? '{"result":"Max rate limit reached"}' : good); };
  assert.deepEqual(await findCreation(chain, TOKEN, { env: { ETHERSCAN_API_KEY: 'e', BLOCKSCOUT_API_KEY: 'b' }, fetchImpl: flaky }), want);
  assert.match(calls[1], /api\.blockscout\.com\/v2\/api\?chainid=4663/);

  // only Blockscout key -> only Blockscout called
  calls.length = 0;
  assert.deepEqual(await findCreation(chain, TOKEN, { env: { BLOCKSCOUT_API_KEY: 'b' }, fetchImpl: record(good) }), want);
  assert.match(calls[0], /blockscout/);

  // no keys, no calls; and every failure shape returns null
  calls.length = 0;
  assert.equal(await findCreation(chain, TOKEN, { env: {}, fetchImpl: record(good) }), null);
  assert.equal(calls.length, 0);
  assert.equal(await findCreation(chain, TOKEN, { env: { ETHERSCAN_API_KEY: 'e' }, fetchImpl: record('oops', 500) }), null);
  assert.equal(await findCreation(chain, TOKEN, { env: { ETHERSCAN_API_KEY: 'e' }, fetchImpl: async () => { throw new Error('network'); } }), null);
});

test('Rpc: a programming error inside the transport is not retried for a minute', async () => {
  const real = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => { n++; throw new TypeError('x.map is not a function'); };
  try {
    const rpc = new Rpc({ url: 'http://stub', minIntervalMs: 0 });
    await assert.rejects(() => rpc.call('eth_blockNumber'), TypeError);
    assert.equal(n, 1);
  } finally { globalThis.fetch = real; }
});

test('Rpc: a node that rejects the whole batch gets it again in halves', async () => {
  const real = globalThis.fetch;
  const sizes = [];
  globalThis.fetch = async (_u, init) => {
    const parsed = JSON.parse(init.body);
    const reqs = Array.isArray(parsed) ? parsed : [parsed];
    sizes.push(reqs.length);
    if (reqs.length > 2) return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'batch too large' } }));
    const body = reqs.map((r) => ({ jsonrpc: '2.0', id: r.id, result: r.params[0] }));
    return new Response(JSON.stringify(Array.isArray(parsed) ? body[0] && body : body[0]));
  };
  try {
    const rpc = new Rpc({ url: 'http://stub', minIntervalMs: 0 });
    const res = await rpc.batch([1, 2, 3, 4, 5].map((i) => ({ method: 'echo', params: [i] })));
    assert.deepEqual(res.map((r) => r.result), [1, 2, 3, 4, 5]);
    assert.ok(rpc.batchMax <= 2, 'remembers the smaller batch size');
  } finally { globalThis.fetch = real; }
});

test('reattributeFromEvidence: promoting a factory into the registry labels its already-indexed tokens, and only those', () => {
  const store = openDb(':memory:');
  const PONS2 = '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e';
  const topic = [...reg.byTopic0.entries()].find(([, specs]) => specs.some((s) => s.launchpadId === 'pons-v2'))[0];
  for (const [addr, emitter, t] of [['0xaa', PONS2, topic], ['0xbb', '0x' + 'be'.repeat(20), topic], ['0xcc', PONS2, '0x' + '12'.repeat(32)]]) {
    store.saveToken({ chain_id: 4663, address: addr, confidence: 'discovered', birth_block: 10, birth_tx: '0x1', birth_source: 'discovery' });
    store.q.addRef.run(4663, addr, emitter, t, 0, 10);
  }
  assert.equal(reattributeFromEvidence(store, reg, 4663), 1);
  const a = store.q.getToken.get(4663, '0xaa');
  assert.deepEqual([a.launchpad_id, a.confidence, a.factory], ['pons-v2', 'verified', PONS2]);
  assert.equal(store.q.getToken.get(4663, '0xbb').launchpad_id, null, 'look-alike emitter stays unattributed');
  assert.equal(store.q.getToken.get(4663, '0xcc').launchpad_id, null, 'a different event from the real factory is not a creation event');
  assert.equal(reattributeFromEvidence(store, reg, 4663), 0, 'idempotent');
});

test('candidates: co-firing contracts are one system, a rotating factory is one mechanism, plumbing and published contracts stay out', () => {
  const store = openDb(':memory:');
  const chain = { id: 4663, name: 'T', blockTimeMs: 100, statsWindowBlocks: 1_000_000, explorer: {} };
  const lk = new Lookup({ chains: new Map([[4663, chain]]), rpcs: new Map(), registries: new Map([[4663, reg]]), store });
  store.q.setCursor.run(4663, 500_001, 500_000, 0);
  const A = '0x' + 'a1'.repeat(20), A2 = '0x' + 'a2'.repeat(20), R1 = '0x' + 'b1'.repeat(20), R2 = '0x' + 'b2'.repeat(20);
  const POOLMGR = '0x' + 'dd'.repeat(20), PONS2 = '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e', SPOOF = '0x' + 'ee'.repeat(20);
  const INIT = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438'; // v4 Initialize
  const PONS2_TOPIC = [...reg.byTopic0.entries()].find(([, sp]) => sp.some((x) => x.launchpadId === 'pons-v2'))[0];
  let n = 0;
  const birth = (block, fp, refs, launchpad = null) => {
    const t = '0x' + (++n).toString(16).padStart(40, '0');
    store.saveToken({ chain_id: 4663, address: t, confidence: launchpad ? 'verified' : 'discovered', launchpad_id: launchpad, birth_block: block, birth_tx: '0x1', birth_source: 'x', fp_key: fp });
    refs.forEach(([em, topic], i) => store.q.addRef.run(4663, t, em, topic, i, block));
  };
  for (let i = 0; i < 12; i++) birth(100_000 + i, 'skel:A', [[A, '0x' + '01'.repeat(32)], [A2, '0x' + '02'.repeat(32)], [POOLMGR, INIT]]);   // old system: 2 contracts, same births
  for (let i = 0; i < 5; i++) birth(480_000 + i, 'skel:R', [[R1, '0x' + '03'.repeat(32)]]);                                                  // rotating factory, address 1 (~33 min ago)
  for (let i = 0; i < 5; i++) birth(490_000 + i, 'skel:R', [[R2, '0x' + '03'.repeat(32)], [POOLMGR, INIT]]);                                  // rotating factory, address 2
  for (let i = 0; i < 6; i++) birth(495_000 + i, 'skel:P', [[PONS2, PONS2_TOPIC], [POOLMGR, INIT]], 'pons-v2');                               // published factory
  birth(499_000, 'skel:S', [[SPOOF, PONS2_TOPIC]]);                                                                                          // one look-alike event

  const C = (o) => lk.candidates(4663, o).list;
  const all = C();
  assert.deepEqual(all.map((c) => c.status), ['look-alike', 'new', 'new', 'new'], 'look-alikes first, even with a single token');
  const sysA = all.find((c) => c.emitter === A || c.emitter === A2);
  assert.equal(sysA.coEmitters.length, 1, 'A and A2 announce the same tokens: one system');
  assert.equal(sysA.seenFromIndexStart, true, 'active since the first indexed hour: real age unknown');
  const r1 = all.find((c) => c.emitter === R1);
  assert.deepEqual([r1.mechanism.addresses, r1.mechanism.otherAddresses], [2, [R2]], 'same creation event at two addresses');
  assert.ok(!all.some((c) => c.emitter === POOLMGR || c.emitter === PONS2), 'plumbing and published factories are not candidates');
  assert.equal(C({ status: 'all' }).find((c) => c.emitter === POOLMGR).status, 'dex-plumbing');

  // age: nothing is "new in the last hour" until it has been dated on-chain
  assert.deepEqual(lk.candidates(4663, { sinceHours: 1 }), { list: [], total: 0, pendingAgeCheck: 3 }, 'R1, R2 and the one-token look-alike all appeared this hour, none dated yet');
  store.q.putAge.run(4663, R1, 480_000, 0, 0); // first log = first sighting: genuinely new
  store.q.putAge.run(4663, R2, 490_000, 0, 0);
  store.q.putAge.run(4663, A, 100_000, 0, 0);
  store.q.putAge.run(4663, A2, 100_000, 0, 0);
  lk.listCache.m.clear();
  assert.deepEqual(C({ status: 'new', sinceHours: 1 }).map((c) => c.emitter).sort(), [R1, R2].sort(), 'first on-chain activity within the hour');
  // R2 turns out to have logged long before the index saw it: an old contract, not a new one
  store.q.putAge.run(4663, R2, 10, 0, 0);
  lk.listCache.m.clear();
  assert.deepEqual(C({ status: 'new', sinceHours: 1 }).map((c) => c.emitter), [R1]);
});

test('birthFacts + ranking: the launcher the deployer called is the maker, not the v4 hook that fired first (zLIQ, block 69057653)', () => {
  const TOKEN_Z = '0x20f346a44d50151ba356e42a7e1d2182048ad71f', HOOK = '0x5370602470386c05a2f0aa9e09765c0c9ab5e0cc', LAUNCHER = '0x4ad187b3735738596fea386d08f4073a5416977b', PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
  const XFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', INIT = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
  const word = (h) => h.replace('0x', '').padStart(64, '0');
  const receipt = { to: LAUNCHER.toUpperCase().replace('0X', '0x'), logs: [
    { address: TOKEN_Z, logIndex: '0x2', topics: [XFER, '0x' + '0'.repeat(64), pad32(LAUNCHER)], data: '0x' + word('0x33b2e3c9fd0803ce8000000') },
    { address: HOOK, logIndex: '0x3', topics: ['0x7f67dcb54634da6eb94af60e0a09c89cbea45d29548c0f625a63e28c39489d68', pad32(TOKEN_Z)], data: '0x' },
    { address: PM, logIndex: '0x4', topics: [INIT, '0x' + 'ab'.repeat(32), '0x' + '0'.repeat(64), pad32(TOKEN_Z)], data: '0x' + word('0xbb8') + word('0x3c') + word(HOOK) + word('0x1') + word('0x0') },
    { address: TOKEN_Z, logIndex: '0x9', topics: [XFER, pad32(LAUNCHER), pad32(PM)], data: '0x' + word('0x1') },
    { address: LAUNCHER, logIndex: '0xd', topics: ['0xf2d58b0e90ea2c0d4a4dc09a05f7da1e1ee3d7b58c96b55e5360c28cbb5bfbd4', pad32(TOKEN_Z)], data: '0x' },
  ] };
  assert.deepEqual(birthFacts(receipt, TOKEN_Z), { txTo: LAUNCHER, mintTo: LAUNCHER, v4Hook: HOOK });
  assert.deepEqual(birthFacts({ to: null, logs: [] }, TOKEN_Z), { txTo: null, mintTo: null, v4Hook: null });

  const store = openDb(':memory:');
  const chain = { id: 4663, name: 'T', blockTimeMs: 100, statsWindowBlocks: 1_000_000, explorer: {} };
  const lk = new Lookup({ chains: new Map([[4663, chain]]), rpcs: new Map(), registries: new Map([[4663, reg]]), store });
  store.q.setCursor.run(4663, 101, 100, 0);
  const f = birthFacts(receipt, TOKEN_Z);
  store.saveToken({ chain_id: 4663, address: TOKEN_Z, confidence: 'discovered', birth_block: 90, birth_tx: '0x1', birth_source: 'discovery', fp_key: 'skel:z', tx_to: f.txTo, mint_to: f.mintTo, v4_hook: f.v4Hook });
  for (const r of refsForToken(receipt.logs, TOKEN_Z)) store.q.addRef.run(4663, TOKEN_Z, r.emitter, r.topic0, r.logIndex, 90);
  return lk.token(4663, TOKEN_Z).then(({ body }) => {
    assert.equal(body.factory.address, LAUNCHER, 'the launcher, even though the hook logged first');
    assert.deepEqual(body.announcers.map((a) => a.role), ['unlisted', 'hook', 'infra']);
    assert.equal(body.birth.v4Hook, HOOK);
  });
});

test('probeFirstLog: finds the earliest log, treats a refused (too busy) range as activity, returns the sighting block when silent', async () => {
  const chain = { ageLookbackBlocks: 1000, addrLogsSpan: 300 };
  const asked = [];
  const rpcWith = (fn) => ({ call: async (_m, [f]) => { asked.push([Number(f.fromBlock), Number(f.toBlock)]); return fn(Number(f.fromBlock), Number(f.toBlock)); } });
  // logs at 1500 and 1700; lookback starts at 1000
  assert.deepEqual(await probeFirstLog(rpcWith((a, b) => [1500, 1700].filter((x) => x >= a && x <= b).map((x) => ({ blockNumber: '0x' + x.toString(16) }))), chain, '0xabc', 2000, 1900),
    { firstLogBlock: 1500, lookbackFrom: 1000 });
  assert.deepEqual(asked, [[1000, 1299], [1300, 1599]], 'stops at the first chunk with a log');
  assert.deepEqual(await probeFirstLog(rpcWith((a) => { if (a === 1300) throw new RpcError('eth_getLogs', { message: 'query returned more than 10000 results' }); return []; }), chain, '0xabc', 2000, 1900),
    { firstLogBlock: 1300, lookbackFrom: 1000 });
  assert.deepEqual(await probeFirstLog(rpcWith(() => []), chain, '0xabc', 2000, 1900), { firstLogBlock: 1900, lookbackFrom: 1000 });
});

test('candidates: a v4 hook that serves many tokens is pool machinery, not a new factory', () => {
  const store = openDb(':memory:');
  const chain = { id: 4663, name: 'T', blockTimeMs: 100, statsWindowBlocks: 1_000_000, explorer: {} };
  const lk = new Lookup({ chains: new Map([[4663, chain]]), rpcs: new Map(), registries: new Map([[4663, reg]]), store });
  store.q.setCursor.run(4663, 1001, 1000, 0);
  const HOOK = '0x' + 'ab'.repeat(20), MAKER = '0x' + 'cd'.repeat(20);
  for (let i = 1; i <= 4; i++) {
    const t = '0x' + i.toString(16).padStart(40, '0');
    store.saveToken({ chain_id: 4663, address: t, confidence: 'discovered', birth_block: 900 + i, birth_tx: '0x1', birth_source: 'x', fp_key: 'skel:h', tx_to: MAKER, mint_to: MAKER, v4_hook: HOOK });
    store.q.addRef.run(4663, t, HOOK, '0x' + '07'.repeat(32), 1, 900 + i);
    store.q.addRef.run(4663, t, MAKER, '0x' + '08'.repeat(32), 2, 900 + i);
  }
  const r = lk.candidates(4663, { status: 'all' }).list;
  assert.equal(r.find((c) => c.emitter === HOOK || c.coEmitters.some((x) => x.address === HOOK))?.status !== 'new' || r.length === 1, true);
  const maker = r.find((c) => c.emitter === MAKER || c.coEmitters.some((x) => x.address === MAKER));
  assert.equal(maker.makerShare, 1, 'the maker made every token it announced');
  assert.ok(!lk.candidates(4663).list.some((c) => c.emitter === HOOK && c.coEmitters.length === 0), 'a lone hook never appears as a new factory');
});

test('resolvePlatform: the Doppler integrator decides the launchpad (BURNER vs a Long launch)', async () => {
  const m = matchKnownEvent(reg, createLog(AIRLOCK));
  const w = (a) => a.replace('0x', '').padStart(64, '0');
  const assetData = (integ) => '0x' + [w('0x0f17206447090e464c277571124dd2688e48aea9'), w('0x0'), w('0x0'), w('0x0'), w('0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544'), w('0x0'), w('0x0'), w('0x1'), w('0x1'), w(integ)].join('');
  assert.deepEqual(resolvePlatform(m, assetData('0x92d435c96e63c43e12d6d0ab28f6b0b04072f765')),
    { platform: '0x92d435c96e63c43e12d6d0ab28f6b0b04072f765', launchpadId: 'long-xyz', confidence: 'observed-emitter', label: null });
  assert.deepEqual(resolvePlatform(m, assetData('0xbb0f84b75e43a48e55dd34c08daec6bdd668b1e4')),
    { platform: '0xbb0f84b75e43a48e55dd34c08daec6bdd668b1e4', launchpadId: 'doppler', confidence: 'verified', label: null }, 'BURNER: Doppler, not Long');
  assert.equal(resolvePlatform(m, '0x').platform, 'unreadable');

  // old rows credited to Long from the Airlock event alone get moved by the idle probe
  const store = openDb(':memory:');
  const chain = { id: 4663, name: 'T', blockTimeMs: 100, statsWindowBlocks: 1_000_000, explorer: {} };
  const old = [['0x' + '11'.repeat(20), '0x92d435c96e63c43e12d6d0ab28f6b0b04072f765'], ['0x' + '22'.repeat(20), '0xbb0f84b75e43a48e55dd34c08daec6bdd668b1e4']];
  for (const [t] of old) store.saveToken({ chain_id: 4663, address: t, confidence: 'verified', launchpad_id: 'long-xyz', factory: AIRLOCK, event_sig: 'Create(address,address,address,address)', birth_block: 5, birth_tx: '0x1', birth_source: 'registry-event' });
  const rpc = { batch: async (calls) => calls.map((c) => ({ result: assetData(old.find(([t]) => c.params[0].data.includes(t.slice(2)))[1]) })) };
  assert.equal(await probePendingPlatforms({ chain, rpc, registry: reg, store }), 2);
  assert.deepEqual([store.q.getToken.get(4663, old[0][0]).launchpad_id, store.q.getToken.get(4663, old[0][0]).confidence], ['long-xyz', 'observed-emitter']);
  assert.deepEqual([store.q.getToken.get(4663, old[1][0]).launchpad_id, store.q.getToken.get(4663, old[1][0]).confidence], ['doppler', 'verified']);
  assert.equal(await probePendingPlatforms({ chain, rpc, registry: reg, store }), 0, 'each token is checked once');

  const lk = new Lookup({ chains: new Map([[4663, chain]]), rpcs: new Map(), registries: new Map([[4663, reg]]), store });
  const b = (await lk.token(4663, old[1][0])).body;
  assert.deepEqual([b.verdict.code, b.launchpad.id, b.factory.platform.status], ['protocol-verified', 'doppler', 'unlisted']);
  const l = (await lk.token(4663, old[0][0])).body;
  assert.deepEqual([l.verdict.code, l.launchpad.id, l.factory.platform.status], ['observed-platform', 'long-xyz', 'observed']);
});

test('Indexer.maintain: background probes run from the caught-up path and back off when there is nothing to do', async () => {
  const { Indexer } = await import('../src/indexer.js');
  const store = openDb(':memory:');
  const chain = { id: 4663, slug: 't', name: 'T', blockTimeMs: 100, statsWindowBlocks: 1_000_000, logsChunk: 2000, ageLookbackBlocks: 1000, addrLogsSpan: 1000, explorer: {} };
  const w = (a) => a.replace('0x', '').padStart(64, '0');
  const tok = '0x' + '33'.repeat(20);
  store.saveToken({ chain_id: 4663, address: tok, confidence: 'verified', launchpad_id: 'long-xyz', factory: AIRLOCK, event_sig: 'Create(address,address,address,address)', birth_block: 5, birth_tx: '0x1', birth_source: 'registry-event' });
  for (const t of ['0x' + '44'.repeat(20), '0x' + '55'.repeat(20)]) { store.saveToken({ chain_id: 4663, address: t, confidence: 'discovered', birth_block: 900, birth_tx: '0x1', birth_source: 'x' }); store.q.addRef.run(4663, t, '0x' + 'ee'.repeat(20), '0x' + '09'.repeat(32), 0, 900); }
  let calls = 0;
  const rpc = { batch: async (cs) => { calls++; return cs.map(() => ({ result: '0x' + Array(9).fill(w('0x0')).join('') + w('0xbb0f84b75e43a48e55dd34c08daec6bdd668b1e4') })); }, call: async () => { calls++; return []; } };
  const ix = new Indexer({ chain, rpc, registry: reg, store, log: { info() {}, warn() {} } });
  await ix.maintain(1000);
  assert.equal(store.q.getToken.get(4663, tok).launchpad_id, 'doppler', 'platform resolved from the normal loop');
  assert.ok(store.q.getAge.get(4663, '0x' + 'ee'.repeat(20)), 'announcer dated');
  await ix.maintain(1000); // drains: nothing left, sets the back-off
  const before = calls;
  await ix.maintain(1000);
  assert.equal(calls, before, 'empty backlog: no RPC, no work');
});

test('recent: flags unlisted tokens and can return only them', () => {
  const store = openDb(':memory:');
  const chain = { id: 4663, name: 'T', blockTimeMs: 100, statsWindowBlocks: 1_000_000, explorer: {} };
  const lk = new Lookup({ chains: new Map([[4663, chain]]), rpcs: new Map(), registries: new Map([[4663, reg]]), store });
  const mk = (addr, block, lp) => store.saveToken({ chain_id: 4663, address: addr, confidence: lp ? 'verified' : 'discovered', launchpad_id: lp, birth_block: block, birth_tx: '0x1', birth_source: 'x', fp_key: 'skel:x', code_size: 300, fp_kind: 'contract' });
  mk('0x' + '11'.repeat(20), 100, 'pons-v2');
  mk('0x' + '22'.repeat(20), 101, null);
  mk('0x' + '33'.repeat(20), 102, 'long-xyz');
  const all = lk.recent(4663, {});
  assert.deepEqual(all.map((t) => t.unlisted), [false, true, false], 'newest first, middle one unlisted');
  const only = lk.recent(4663, { attributed: false });
  assert.deepEqual(only.map((t) => t.address), ['0x' + '22'.repeat(20)]);
  assert.ok(only.every((t) => t.unlisted));
});

test('stocks: issuer scan verifies the beacon, and lookup shows open pairs vs first launch', async () => {
  const { scanIssuers, decodeIssuerLog } = await import('../src/stocks.js');
  const store = openDb(':memory:');
  const chain = { id: 4663, name: 'T', slug: 't', blockTimeMs: 100, statsWindowBlocks: 1_000_000, logsChunk: 2000, addrLogsSpan: 2000, explorer: {} };
  const ISSUER = { id: 'rh', factory: '0x' + '11'.repeat(20), topic0: '0x' + 'aa'.repeat(32), beacon: '0x' + 'be'.repeat(20), data: ['address', 'string', 'string'] };
  const registry = { ...reg, quoteIssuers: [ISSUER] };
  const enc = (addr, name, sym) => {
    const w = (h) => h.replace('0x', '').padStart(64, '0');
    const off = w('0x60'); const nOff = w('0xa0');
    const str = (v) => { const hexs = Buffer.from(v, 'utf8').toString('hex'); return w('0x' + (v.length).toString(16)) + hexs.padEnd(64, '0'); };
    return '0x' + w(addr) + off + nOff + str(name) + str(sym);
  };
  const REAL = '0x' + '22'.repeat(20), FAKE = '0x' + '33'.repeat(20);
  const logs = [
    { address: ISSUER.factory, topics: [ISSUER.topic0], data: enc(REAL, 'Qualcomm • Robinhood Token', 'QCOM'), blockNumber: '0x64', transactionHash: '0x' + '01'.repeat(32) },
    { address: ISSUER.factory, topics: [ISSUER.topic0], data: enc(FAKE, "McDonald's • Robinhood Token", 'MCD'), blockNumber: '0x65', transactionHash: '0x' + '02'.repeat(32) },
  ];
  const beacon = (t) => (t.toLowerCase() === REAL ? '0x' + '00'.repeat(12) + 'be'.repeat(20) : '0x' + '00'.repeat(12) + 'cc'.repeat(20));
  const rpc = { call: async (m, p) => {
    if (m === 'eth_getLogs') { const from = parseInt(p[0].fromBlock, 16), to = parseInt(p[0].toBlock, 16); return logs.filter((l) => { const b = parseInt(l.blockNumber, 16); return b >= from && b <= to; }); }
    if (m === 'eth_getStorageAt') return beacon(p[0]);
    throw new Error('unexpected ' + m);
  } };
  await scanIssuers({ chain, rpc, registry, store, head: 130, maxCalls: 10 });
  // a launch that pairs with the real stock token
  store.saveToken({ chain_id: 4663, address: '0x' + 'dd'.repeat(20), confidence: 'verified', launchpad_id: 'doppler', birth_block: 110, birth_tx: '0x1', birth_source: 'x', event_fields: JSON.stringify({ numeraire: REAL }) });

  const lk = new Lookup({ chains: new Map([[4663, chain]]), rpcs: new Map(), registries: new Map([[4663, registry]]), store });
  const rows = lk.stocks(4663);
  assert.equal(rows.length, 1, 'the fake MCD (wrong beacon) is not shown');
  assert.equal(rows[0].symbol, 'QCOM');
  assert.equal(rows[0].pairsLaunched, 1);
  assert.equal(rows[0].open, null, 'no index start known yet: open-ness is not claimed');
  assert.equal(rows[0].firstLaunch.secondsAfterListing, null, 'index has no birth_refs yet: completeness unknown, so no delay claimed');
  assert.equal(rows[0].firstLaunch.launchpad, 'Doppler protocol');
  // a stock token listed before the index began: never claimed open, first launch not claimed true-first
  store.q.addRef.run(4663, '0x' + 'dd'.repeat(20), '0x' + 'ee'.repeat(20), '0x' + '01'.repeat(32), 0, 105); // index starts at 105
  store.q.putStock.run(4663, '0x' + '44'.repeat(20), 'rh', 'OLD', 'Old • Robinhood Token', 50, '0x' + '03'.repeat(32), 1, 0);
  const old = lk.stocks(4663).find((r) => r.symbol === 'OLD');
  assert.deepEqual([old.countComplete, old.open], [false, null], 'pre-index listing: zero launches seen is NOT an open pair');
  const q = lk.stocks(4663).find((r) => r.symbol === 'QCOM');
  assert.equal(q.countComplete, false, 'QCOM (listed at 100) also predates index start 105');
  assert.equal(q.firstLaunch.secondsAfterListing, null, 'no delay claimed when the true first may be missing');
  assert.equal(store.q.stockCount.get(4663).rejected, 1, 'the look-alike is recorded but flagged');
  // second scan is incremental (cursor advanced): no re-insert error, still one shown
  await scanIssuers({ chain, rpc, registry, store, head: 130, maxCalls: 10 });
  assert.equal(lk.stocks(4663).filter((r) => r.symbol === 'QCOM').length, 1, 're-scan does not duplicate');
});

test('verdict colors: no unverified or direct-deploy verdict is shown as neutral or safe', async () => {
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'));
  const line = src.match(/const TONE = (\{[^}]*\});/)[1];
  const TONE = Function(`return ${line}`)();
  // teal ('ok') is reserved for a real, verified/observed launchpad only
  const mayBeOk = new Set(['verified', 'observed-emitter', 'observed-platform']);
  for (const [code, tone] of Object.entries(TONE)) {
    if (tone === 'ok') assert.ok(mayBeOk.has(code), `${code} must not be green`);
    assert.notEqual(tone, 'flat', `${code} must not render as neutral — unverified is at least a caution`);
  }
  // the specific regression: a bare direct deploy
  assert.equal(TONE['discovered-silent'], 'warn');
  assert.equal(TONE['none'], 'warn');
});

test('live protocol resolution: an unindexed Doppler token is attributed from getAssetData, and a shared template never names an app', async () => {
  const store = openDb(':memory:');
  const chain = { id: 4663, name: 'T', blockTimeMs: 100, statsWindowBlocks: 1_000_000, explorer: {} };
  const w = (a) => a.replace('0x', '').padStart(64, '0');
  const asset = (integ) => '0x' + [w('0x0f17206447090e464c277571124dd2688e48aea9'), w('0x0'), w('0x0'), w('0x0'), w('0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544'), w('0x0'), w('0x0'), w('0x1'), w('0x1'), w(integ)].join('');
  const BANKR = '0xf60633d02690e2a15a54ab919925f3d038df163e', NOBODY = '0x' + 'ab'.repeat(20);
  const TOK_B = '0x' + '51'.repeat(20), TOK_X = '0x' + '52'.repeat(20), TOK_N = '0x' + '53'.repeat(20);
  const clone = '0x363d3d373d3d3d363d733be8b97fd0e713b5abe0649fa830223b6b4bc5995af43d82803e903d91602b57fd5bf3';
  const rpc = {
    batch: async (calls) => calls.map((c) => {
      const t = '0x' + c.params[0].data.slice(-40);
      if (t === TOK_B) return { result: asset(BANKR) };
      if (t === TOK_X) return { result: asset(NOBODY) };
      return { result: '0x' + '0'.repeat(640) }; // protocol has no record: all-zero
    }),
    call: async (m, p) => (m === 'eth_getCode' ? clone : m === 'eth_blockNumber' ? '0x64' : '0x'),
  };
  const lk = new Lookup({ chains: new Map([[4663, chain]]), rpcs: new Map([[4663, rpc]]), registries: new Map([[4663, reg]]), store });
  store.q.setCursor.run(4663, 101, 100, 0);
  // simulate "indexed before attribution existed": rows with confidence none
  for (const t of [TOK_B, TOK_X, TOK_N]) store.saveToken({ chain_id: 4663, address: t, confidence: 'none', fp_key: 'proxy:0x3be8b97fd0e713b5abe0649fa830223b6b4bc599', fp_kind: 'minimal-proxy', code_size: 44 });
  // give the cluster a Long-heavy population, like production
  for (let i = 0; i < 9; i++) store.saveToken({ chain_id: 4663, address: '0x' + (0x60 + i).toString(16).padStart(40, '0'), confidence: 'observed-emitter', launchpad_id: 'long-xyz', platform: '0x92d435c96e63c43e12d6d0ab28f6b0b04072f765', fp_key: 'proxy:0x3be8b97fd0e713b5abe0649fa830223b6b4bc599', fp_kind: 'minimal-proxy', code_size: 44, birth_block: 5, birth_tx: '0x1', birth_source: 'x' });

  const b = (await lk.token(4663, TOK_B)).body;
  assert.deepEqual([b.verdict.code, b.launchpad.id, b.factory.platform.integrator, b.bytecode.attributionSource], ['observed-platform', 'bankr', BANKR, 'live-protocol-call']);
  const x = (await lk.token(4663, TOK_X)).body;
  assert.deepEqual([x.verdict.code, x.launchpad.id, x.factory.platform.status], ['protocol-verified', 'doppler', 'unlisted']);
  const n = (await lk.token(4663, TOK_N)).body;
  assert.equal(n.verdict.code, 'none', 'no protocol record: stays none');
  assert.equal(n.likelyLaunchpad, null, 'a Long-heavy shared template must NOT make the verdict guess Long');
  assert.deepEqual([n.bytecode.cluster.template.name, n.bytecode.cluster.template.sharedByApps], ['Doppler protocol', true]);
});
