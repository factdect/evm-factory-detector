import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadRegistry, matchKnownEvent, pad32, refsForToken } from '../src/attribution.js';
import { reattributeFromEvidence } from '../src/births.js';
import { openDb } from '../src/db.js';
import { findCreation } from '../src/explorer.js';
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

test('attribution: Airlock Create from the published Airlock is verified', () => {
  const m = matchKnownEvent(reg, createLog(AIRLOCK));
  assert.equal(m.token, TOKEN);
  assert.equal(m.launchpadId, 'long-xyz');
  assert.equal(m.confidence, 'verified');
  assert.equal(m.fields.numeraire, '0x' + '0'.repeat(40));
});

test('attribution: the same event from any other contract is never credited to the launchpad', () => {
  const m = matchKnownEvent(reg, createLog('0x' + 'be'.repeat(20)));
  assert.equal(m.launchpadId, null);
  assert.equal(m.confidence, 'unverified-emitter');
  assert.deepEqual(m.family, ['long-xyz']);
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
  const unknown = matchKnownEvent(reg, log('0xf4fc0cd27fc8ecf17e55ee4c3f7201897df3eb75'));
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
