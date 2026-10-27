// update-14: the integrator field is a claim, not proof (19 "Bankr" launches on Robinhood Chain,
// 2026-10-25..27, came from wallets Bankr never uses), and supply minted outside the sale is the
// first thing a buyer needs to know (DRS: 24% unlocked at launch, dumped 4 minutes in).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAllocations, checkSender, loadRegistry, matchKnownEvent, pad32, platformNeedsSender, premintFacts, resolvePlatform } from '../src/attribution.js';
import { BirthRecorder, probePendingBirthFacts, probePendingPlatforms } from '../src/births.js';
import { openDb } from '../src/db.js';
import { Lookup } from '../src/lookup.js';

const reg = loadRegistry(4663);
const AIRLOCK = '0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862';
const BANKR = '0xf60633d02690e2a15a54ab919925f3d038df163e';
const BANKR_7702 = '0xd6cedde84be40893d153be9d467cd6ad37875b28';
const DRS = '0xe2943e4ba51bb08c1222f2a95b10ce4bb18ecba3';
const DUMPER = '0xbe5184be49af5aeaba84a6872afc1814db87214f';
const LAUNCHER = '0xa032ab028968ccf8430165f77486bc805e5d789e';
const w = (h) => h.replace('0x', '').padStart(64, '0');
const XFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const CREATE_T0 = '0x68ff1cfcdcf76864161555fc0de1878d8f83ec6949bf351df74d8a4a1a2679ab';
const assetData = (integ) => '0x' + [w('0x0bd7d308f8e1639fab988df18a8011f41eacad73'), w('0x0'), w('0xdead'), w('0xba2f330edb16cd8056f5988d8ce19bbc63475a0e'), w('0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544'), w(DRS), w('0xdead'), w('0xf2568bc2d21591d7f8000000'), w('0x1431e0fae6d7217caa0000000'), w(integ)].join('');
const code7702 = (delegate) => '0xef0100' + delegate.slice(2);
// metadata without Multicall3: one eth_call per field, answered by selector
const chainOf = () => ({ id: 4663, name: 'Robinhood Chain', slug: 'robinhood', blockTimeMs: 100, statsWindowBlocks: 1_000_000, logsChunk: 2000, multicall3: null, explorer: {} });
const str = (v) => '0x' + w('0x20') + w('0x' + v.length.toString(16)) + Buffer.from(v).toString('hex').padEnd(64, '0');
const META = { '0x06fdde03': str('Dragon Reserve'), '0x95d89b41': str('DRS'), '0x313ce567': '0x' + w('0x12'), '0x18160ddd': '0x' + w('0x1431e0fae6d7217caa0000000'), '0x0dfe1681': '0x' };
const metaOf = (c) => ({ result: META[c.params[0].data.slice(0, 10)] ?? '0x' });

// the token's own logs from DRS's real launch receipt (block 98672092): two schedules, two allocations, the 25B escrow mint
import { toEventSelector } from 'viem';
const T_SCHED = toEventSelector('VestingScheduleCreated(uint256,uint64,uint64)');
const T_ALLOC = toEventSelector('VestingAllocated(address,uint256,uint256)');
// DRS's real birth logs; `token` re-addresses them so a second token can carry the same pre-mint
const drsLogs = (token = DRS) => [
  { address: token, topics: [T_SCHED, w('0x0')].map((x, i) => (i ? '0x' + x : x)), data: '0x' + w('0x0') + w('0x0') },
  { address: token, topics: [T_SCHED, '0x' + w('0x1')], data: '0x' + w('0x278d00') + w('0x1e13380') },
  { address: token, topics: [T_ALLOC, pad32(LAUNCHER), '0x' + w('0x1')], data: '0x' + w('0x33b2e3c9fd0803ce8000000') },
  { address: token, topics: [T_ALLOC, pad32(DUMPER), '0x' + w('0x0')], data: '0x' + w('0x4d8c55aefb8c05b5c0000000') },
  { address: token, topics: [XFER, '0x' + '0'.repeat(64), pad32(token)], data: '0x' + w('0x50c783eb9b5c85f2a8000000') },
  { address: token, topics: [XFER, '0x' + '0'.repeat(64), pad32(AIRLOCK)], data: '0x' + w('0xf2568bc2d21591d7f8000000') },
];
const createLog = () => ({ address: AIRLOCK, logIndex: '0x15', topics: [CREATE_T0, pad32('0x0bd7d308f8e1639fab988df18a8011f41eacad73')],
  data: '0x' + w(DRS) + w('0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544') + w('0x9982538f41f2ae29ddb9d3d9307010052984fdbb') });

test('checkSender: Bankr\'s wallets on Robinhood Chain are EIP-7702 EOAs delegated to one implementation; a plain EOA fails; no sender is unverified', () => {
  const m = matchKnownEvent(reg, createLog());
  const rule = m.platform.known.get(BANKR).wallets;
  assert.equal(checkSender(rule, '0xbad608307d46fb8e9d878428ca138542861adfea', code7702(BANKR_7702)), 'verified');
  assert.equal(checkSender(rule, LAUNCHER, '0x'), 'failed', 'DRS launcher: plain EOA, nonce 2');
  assert.equal(checkSender(rule, LAUNCHER, code7702('0x3cc0af5611a3f0df6d9a5f3d7a0c5b2c1d1e2f30')), 'failed', 'delegated, but to someone else\'s implementation (Long uses two)');
  assert.equal(checkSender(rule, null, null), 'unverified');
  assert.equal(checkSender(rule, LAUNCHER, null), 'unverified', 'code not fetched');
  assert.equal(checkSender(null, LAUNCHER, '0x'), null, 'an app without a wallet rule is never checked');
  assert.ok(platformNeedsSender(m));
  const base = loadRegistry(8453).platformSpecs.find((s) => s.launchpadId === 'doppler').platform.known.get(BANKR).wallets;
  assert.equal(checkSender(base, '0x2d3faeac23567d32b249b2325689f6f76dda4a28', '0x'), 'verified', 'Base: a Bankr hot wallet (nonce 529k)');
  assert.equal(checkSender(base, LAUNCHER, '0x'), 'failed');
});

const SUPPLY = '100000000000000000000000000000';
const premintOf = (allocs) => ({ escrowed: '0', schedules: { 0: { cliff: 0, duration: 0 }, 1: { cliff: 2592000, duration: 31536000 } }, allocations: allocs });
const BANKR_15 = premintOf([{ to: DUMPER, scheduleId: '1', amount: '15000000000000000000000000000' }]);
const INSTANT_24 = premintOf([{ to: LAUNCHER, scheduleId: '1', amount: '1000000000000000000000000000' }, { to: DUMPER, scheduleId: '0', amount: '24000000000000000000000000000' }]);

test('checkAllocations: Bankr\'s policy is 15% / 30-day cliff / 1 year, or nothing; anything else is not a Bankr launch', () => {
  const m = matchKnownEvent(reg, createLog());
  const rule = m.platform.known.get(BANKR).allocations;
  assert.equal(checkAllocations(rule, BANKR_15, SUPPLY), 'verified');
  assert.equal(checkAllocations(rule, null, SUPPLY), 'verified', 'no vesting: allowed');
  assert.equal(checkAllocations(rule, INSTANT_24, SUPPLY), 'failed', 'DRS: 24% unlocked + 1% vested');
  assert.equal(checkAllocations(rule, premintOf([{ to: DUMPER, scheduleId: '1', amount: '14000000000000000000000000000' }]), SUPPLY), 'failed', '14% vested: not the 15% Bankr mints');
  assert.equal(checkAllocations(rule, premintOf([{ to: DUMPER, scheduleId: '0', amount: '15000000000000000000000000000' }]), SUPPLY), 'failed', '15% but unlocked: not Bankr');
  assert.equal(checkAllocations(rule, undefined, SUPPLY), 'unverified', 'receipt not read yet');
  assert.equal(checkAllocations(null, INSTANT_24, SUPPLY), null, 'app without a policy');
});

test('judgeClaim + resolvePlatform: a Bankr wallet settles it; an off-policy allocation settles it the other way; a plain EOA with an on-policy allocation stays unverified', () => {
  const m = matchKnownEvent(reg, createLog());
  const fake = resolvePlatform(m, assetData(BANKR), LAUNCHER, '0x', INSTANT_24, SUPPLY);
  assert.deepEqual([fake.launchpadId, fake.confidence, fake.claimedLaunchpadId, fake.platform], ['doppler', 'look-alike-platform', 'bankr', BANKR]);
  assert.deepEqual(JSON.parse(fake.claimCheck), { result: 'failed', wallet: 'failed', allocations: 'failed' });
  const real = resolvePlatform(m, assetData(BANKR), '0xbad608307d46fb8e9d878428ca138542861adfea', code7702(BANKR_7702), BANKR_15, SUPPLY);
  assert.deepEqual([real.launchpadId, real.confidence, JSON.parse(real.claimCheck).result], ['bankr', 'observed-emitter', 'verified']);
  // the six bankr.bot-listed launches from plain EOAs (partner / CLI keys): on-policy, so the label is kept, unconfirmed
  const partner = resolvePlatform(m, assetData(BANKR), '0x732971d59ec5ff899c9bf458b99210240b03b115', '0x', null, SUPPLY);
  assert.deepEqual([partner.launchpadId, partner.confidence, JSON.parse(partner.claimCheck)], ['bankr', 'observed-emitter', { result: 'unverified', wallet: 'failed', allocations: 'verified' }]);
  // a Bankr wallet with an off-policy allocation would mean Bankr changed its product: still Bankr
  const changed = resolvePlatform(m, assetData(BANKR), '0xbad608307d46fb8e9d878428ca138542861adfea', code7702(BANKR_7702), INSTANT_24, SUPPLY);
  assert.equal(JSON.parse(changed.claimCheck).result, 'verified');
  const unknown = resolvePlatform(m, assetData(BANKR), null, null);
  assert.deepEqual([unknown.launchpadId, unknown.confidence, JSON.parse(unknown.claimCheck).result], ['bankr', 'observed-emitter', 'unverified'], 'no sender, no receipt (live lookup): the claim stands, marked unverified');
  const long = resolvePlatform(m, assetData('0x92d435c96e63c43e12d6d0ab28f6b0b04072f765'), LAUNCHER, '0x', INSTANT_24, SUPPLY);
  assert.deepEqual([long.launchpadId, long.claimCheck], ['long-xyz', null], 'Long has no rules: never judged');
});

test('premintFacts: DRS\'s receipt says 25% escrowed, 24% to the dumper with cliff 0 / duration 0, 1% to the launcher over a year', () => {
  const p = premintFacts({ logs: drsLogs() }, DRS);
  assert.equal(p.escrowed, '25000000000000000000000000000');
  assert.deepEqual(p.schedules, { 0: { cliff: 0, duration: 0 }, 1: { cliff: 2592000, duration: 31536000 } });
  assert.deepEqual(p.allocations, [
    { to: LAUNCHER, scheduleId: '1', amount: '1000000000000000000000000000' },
    { to: DUMPER, scheduleId: '0', amount: '24000000000000000000000000000' },
  ]);
  assert.equal(premintFacts({ logs: [{ address: DRS, topics: [XFER, '0x' + '0'.repeat(64), pad32(AIRLOCK)], data: '0x' + w('0x1') }] }, DRS), null, 'a mint to the sale only is not a pre-mint');
  assert.equal(premintFacts({ logs: drsLogs() }, '0x' + '99'.repeat(20)), null, 'another token\'s logs do not count');
});

test('BirthRecorder.record: a look-alike Bankr launch is stored as Doppler direct with its claim, sender and pre-mint; the lookup warns', async () => {
  const store = openDb(':memory:');
  const chain = chainOf();
  const receipt = { from: LAUNCHER, to: AIRLOCK, blockNumber: '0x5e1a6fc', logs: [...drsLogs(), createLog()] };
  const calls = [];
  const rpc = { batch: async (cs) => { calls.push(...cs.map((c) => c.method)); return cs.map((c) => {
    if (c.method === 'eth_getCode') return { result: c.params[0] === DRS ? '0x3d3d3d3d363d3d37363d733be8b97fd0e713b5abe0649fa830223b6b4bc5995af43d3d93803e602a57fd5bf3' : '0x' };
    if (c.method === 'eth_getTransactionReceipt') return { result: receipt };
    if (c.method === 'eth_call' && c.params[0].to === AIRLOCK) return { result: assetData(BANKR) };
    if (c.method === 'eth_call') return metaOf(c);
    return { result: '0x' };
  }); }, call: async () => '0x' };
  const rec = new BirthRecorder({ chain, rpc, registry: reg, store, log: { warn() {}, info() {} } });
  const m = matchKnownEvent(reg, createLog());
  const saved = await rec.record(DRS, 98672092, '0xaa9ac19631e69bdf496e04a5289e8940be75ce20f30e5f89cb88e712291b3bd8', 'registry-event', m, {});
  assert.deepEqual([saved.launchpad_id, saved.confidence, saved.claim_app, JSON.parse(saved.claim_check), saved.tx_from], ['doppler', 'look-alike-platform', 'bankr', { result: 'failed', wallet: 'failed', allocations: 'failed' }, LAUNCHER]);
  assert.ok(calls.includes('eth_getCode'), 'the sender\'s code was fetched to check the claim');
  assert.equal(JSON.parse(saved.premint).allocations.length, 2);

  const lk = new Lookup({ chains: new Map([[4663, chain]]), rpcs: new Map([[4663, rpc]]), registries: new Map([[4663, reg]]), store });
  const b = (await lk.token(4663, DRS)).body;
  assert.equal(b.verdict.code, 'look-alike-platform');
  assert.equal(b.verdict.headline, 'Claims Bankr, not launched by it');
  assert.equal(b.launchpad.id, 'doppler');
  assert.deepEqual(b.factory.platform.claims, { id: 'bankr', name: 'Bankr' });
  assert.deepEqual([b.factory.platform.status, b.factory.platform.claimCheck, b.factory.platform.senderCheck, b.factory.platform.allocationCheck, b.factory.platform.sender], ['look-alike', 'failed', 'failed', 'failed', LAUNCHER]);
  assert.equal(b.birth.sender, LAUNCHER);
  assert.equal(b.premint.totalPct, 25);
  assert.equal(b.premint.unlockedPct, 24);
  assert.equal(b.premint.escrowedPct, 25);
  assert.deepEqual(b.premint.allocations.map((a) => [a.to, a.pct, a.cliffDays, a.vestDays, a.unlockedAtLaunch]), [[LAUNCHER, 1, 30, 365, false], [DUMPER, 24, 0, 0, true]]);
  assert.equal(b.verdict.warnings.length, 2);
  assert.match(b.verdict.warnings[0], /^24% of the supply was minted outside the sale and could be sold from the first block \(to 0xbe5184/);
  assert.match(b.verdict.warnings[1], /names Bankr, but what was minted at birth \(24% unlocked at launch\) is not something Bankr's launch flow produces, and the launch was sent by 0xa032ab.*not one of Bankr's wallets/);
  const r = lk.recent(4663).find((t) => t.address === DRS);
  assert.deepEqual([r.claims, r.unlockedPct, r.launchpad], ['Bankr', 24, 'Doppler protocol']);
});

test('a genuine Bankr launch (7702 wallet, 15% vesting) stays Bankr: observed-platform, no warnings about the claim', async () => {
  const store = openDb(':memory:');
  const chain = chainOf();
  const SENDER = '0xbad608307d46fb8e9d878428ca138542861adfea', RECIP = '0x812140e97180357f73b4888df29d2c8759617890', QOS = '0xdc28bd4f8e4500ca79371f56461657ce6b905ba3';
  const logs = [
    { address: QOS, topics: [T_SCHED, '0x' + w('0x0')], data: '0x' + w('0x278d00') + w('0x1e13380') },
    { address: QOS, topics: [T_ALLOC, pad32(RECIP), '0x' + w('0x0')], data: '0x' + w('0x3077b58d5d378399ac000000') }, // 15B
    { address: QOS, topics: [XFER, '0x' + '0'.repeat(64), pad32(QOS)], data: '0x' + w('0x3077b58d5d378399ac000000') },
    { address: AIRLOCK, logIndex: '0x15', topics: [CREATE_T0, pad32('0x0bd7d308f8e1639fab988df18a8011f41eacad73')], data: '0x' + w(QOS) + w('0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544') + w('0x' + '77'.repeat(20)) },
  ];
  const receipt = { from: SENDER, to: AIRLOCK, logs };
  const rpc = { batch: async (cs) => cs.map((c) => {
    if (c.method === 'eth_getCode') return { result: c.params[0] === QOS ? '0x3d3d3d3d363d3d37363d733be8b97fd0e713b5abe0649fa830223b6b4bc5995af43d3d93803e602a57fd5bf3' : c.params[0] === SENDER ? code7702(BANKR_7702) : '0x' };
    if (c.method === 'eth_getTransactionReceipt') return { result: receipt };
    if (c.method === 'eth_call' && c.params[0].to === AIRLOCK) return { result: assetData(BANKR).replace(w(DRS), w(QOS)) };
    if (c.method === 'eth_call') return metaOf(c);
    return { result: '0x' };
  }) };
  const rec = new BirthRecorder({ chain, rpc, registry: reg, store, log: { warn() {}, info() {} } });
  const saved = await rec.record(QOS, 98744921, '0x' + '0a'.repeat(32), 'registry-event', matchKnownEvent(reg, logs[3]), {});
  assert.deepEqual([saved.launchpad_id, saved.confidence, JSON.parse(saved.claim_check)], ['bankr', 'observed-emitter', { result: 'verified', wallet: 'verified', allocations: 'verified' }]);
  const lk = new Lookup({ chains: new Map([[4663, chain]]), rpcs: new Map([[4663, rpc]]), registries: new Map([[4663, reg]]), store });
  const b = (await lk.token(4663, QOS)).body;
  assert.deepEqual([b.verdict.code, b.launchpad.id, b.factory.platform.status, b.factory.platform.senderCheck], ['observed-platform', 'bankr', 'observed', 'verified']);
  assert.equal(b.premint.totalPct, 15);
  assert.equal(b.premint.unlockedPct, 0);
  assert.deepEqual(b.verdict.warnings, ['15% of the supply was minted outside the sale (vesting; see premint).']);
});

test('older rows: the idle probe and a first lookup read the birth receipt once, store sender + pre-mint, and re-judge the claim', async () => {
  const store = openDb(':memory:');
  const chain = chainOf();
  // as update-13 stored it: credited to Bankr from the integrator alone, no sender, no pre-mint
  store.saveToken({ chain_id: 4663, address: DRS, confidence: 'observed-emitter', launchpad_id: 'bankr', factory: AIRLOCK, event_sig: 'Create(address,address,address,address)',
    platform: BANKR, birth_block: 98672092, birth_tx: '0x' + 'aa'.repeat(32), birth_source: 'registry-event', total_supply: '100000000000000000000000000000' });
  const T2 = '0x' + '55'.repeat(20);
  const tokenOfTx = { ['0x' + 'aa'.repeat(32)]: DRS, ['0x' + 'bb'.repeat(32)]: T2 };
  let receipts = 0, codes = 0;
  const rpc = { batch: async (cs) => cs.map((c) => {
    if (c.method === 'eth_getTransactionReceipt') { receipts++; return { result: { from: LAUNCHER, to: AIRLOCK, logs: drsLogs(tokenOfTx[c.params[0]]) } }; }
    if (c.method === 'eth_getCode') { codes++; return { result: '0x' }; }
    return { result: '0x' };
  }) };
  const lk = new Lookup({ chains: new Map([[4663, chain]]), rpcs: new Map([[4663, rpc]]), registries: new Map([[4663, reg]]), store });
  const b = (await lk.token(4663, DRS)).body;
  assert.deepEqual([b.verdict.code, b.launchpad.id, b.premint.unlockedPct, b.birth.sender], ['look-alike-platform', 'doppler', 24, LAUNCHER]);
  assert.deepEqual([receipts, codes], [1, 1]);
  await lk.token(4663, DRS);
  assert.deepEqual([receipts, codes], [1, 1], 'read once, stored');
  const row = store.q.getToken.get(4663, DRS);
  assert.deepEqual([row.launchpad_id, row.confidence, row.claim_app, JSON.parse(row.claim_check).result, row.tx_from], ['doppler', 'look-alike-platform', 'bankr', 'failed', LAUNCHER]);

  // the background probe does the same for rows nobody has looked up
  store.saveToken({ chain_id: 4663, address: T2, confidence: 'observed-emitter', launchpad_id: 'bankr', factory: AIRLOCK, event_sig: 'Create(address,address,address,address)',
    platform: BANKR, birth_block: 98672000, birth_tx: '0x' + 'bb'.repeat(32), birth_source: 'registry-event', total_supply: '100000000000000000000000000000' });
  assert.equal(await probePendingBirthFacts({ chain, rpc, registry: reg, store, max: 8 }), 1);
  assert.equal(JSON.parse(store.q.getToken.get(4663, T2).claim_check).result, 'failed');
  assert.equal(await probePendingBirthFacts({ chain, rpc, registry: reg, store, max: 8 }), 0, 'nothing pending');
  // the platform probe (rows without a platform yet) also checks the sender when it is stored
  const T3 = '0x' + '66'.repeat(20);
  store.saveToken({ chain_id: 4663, address: T3, confidence: 'verified', launchpad_id: 'doppler', factory: AIRLOCK, event_sig: 'Create(address,address,address,address)', birth_block: 1, birth_tx: '0x1', birth_source: 'registry-event',
    tx_from: LAUNCHER, premint: JSON.stringify(premintFacts({ logs: drsLogs() }, DRS)), total_supply: SUPPLY });
  const rpc2 = { batch: async (cs) => cs.map((c) => ({ result: c.method === 'eth_call' ? assetData(BANKR) : '0x' })) };
  assert.equal(await probePendingPlatforms({ chain, rpc: rpc2, registry: reg, store }), 1);
  assert.deepEqual([store.q.getToken.get(4663, T3).launchpad_id, JSON.parse(store.q.getToken.get(4663, T3).claim_check)], ['doppler', { result: 'failed', wallet: 'failed', allocations: 'failed' }]);
  // a row with the sender stored but no receipt read yet: an off-wallet sender alone is not a verdict
  const T4 = '0x' + '67'.repeat(20);
  store.saveToken({ chain_id: 4663, address: T4, confidence: 'verified', launchpad_id: 'doppler', factory: AIRLOCK, event_sig: 'Create(address,address,address,address)', birth_block: 1, birth_tx: '0x2', birth_source: 'registry-event', tx_from: LAUNCHER, total_supply: SUPPLY });
  assert.equal(await probePendingPlatforms({ chain, rpc: rpc2, registry: reg, store }), 1);
  assert.deepEqual([store.q.getToken.get(4663, T4).launchpad_id, JSON.parse(store.q.getToken.get(4663, T4).claim_check)], ['bankr', { result: 'unverified', wallet: 'failed', allocations: 'unverified' }]);
});
