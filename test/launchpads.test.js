// update-21: launchpads on Robinhood Chain the registry did not know (audit of 2026-10-28). Each
// fixture is a real launch log read from the chain that day; the token must come out of it as that
// launchpad's, and the same event from any other contract must not.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadRegistry, matchKnownEvent, resolvePlatform } from '../src/attribution.js';
import { rejudgeStoredClaims } from '../src/births.js';
import { openDb } from '../src/db.js';

const reg = loadRegistry(4663);
// [launchpad, log, token, creator, tx]
const LAUNCHES = [
  ['uniswap-launcher', { address: '0x0000ffffbe8efe702c8703ae3477ff5de3d319c0', topics: ["0x2e2b3f61b70d2d131b2a807371103cc98d51adcaa5e9a8f9c32658ad8426e74e", "0x00000000000000000000000072c339997e51c86324072847a0d60d48e49e23b8"], data: '0x' }, '0x72c339997e51c86324072847a0d60d48e49e23b8', null, '0xb6bf6f84ec2002fe6eb7a9f106c1b901c1cee9b1af71586a5ef679cc6c24ca05'],
  ['bags', { address: '0xe8cc4431adf8b5a847c113ef0c6af9043219cb37', topics: ["0x643b3b606052cbadac2f906ad0b462da99eda2a1d4f824d315d7f6edd3e4cced", "0x000000000000000000000000d47684579384ea3f58c9850ea089bf498061b073", "0x000000000000000000000000512c315379a3dde3aaa363b51b66dfc22aea9e29", "0x000000000000000000000000c7ddaf9fabeceb68ede241f4a822a3c9626bf412"], data: '0x00000000000000000000000078a54733aaeb605baa6b5879547c62d400aa7bd6000000000000000000000000000000000000000000000000000000000000000007fbc4213ff5d2caa768514fc2c21e55cbd6dd4b39109d1d7184834116a857da00000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000000c414d43494b204b454241424900000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000005414d43494b000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006268747470733a2f2f726f62696e686f6f642d626167732e707265766965772e656d657267656e746167656e742e636f6d2f6170692f6d657461646174612f38643334656262302d656233632d343862332d393766312d326433363830633463633030000000000000000000000000000000000000000000000000000000000000' }, '0xd47684579384ea3f58c9850ea089bf498061b073', '0xc7ddaf9fabeceb68ede241f4a822a3c9626bf412', '0x9d0f378c8d6515c77bf416277ef64aac66b750ef23b223151c298947730b7e2a'],
  ['letscash', { address: '0x5bd1fbe78a78fe8236fa00cf48fbeba74ae34661', topics: ["0x17091df68f499cf4e20dcfc5d42f064dd22359e785b77691c4c4ed0322608897", "0x00000000000000000000000057db94a8124493b1df6c0e8825a15d0e774a23cc", "0x0000000000000000000000005835619c020e167052cba35eb4fc2c44bafd983c", "0xac7f4cfcad0af6f1234587443f3bff160565a5812046394455c9f8a286bd624f"], data: '0x00000000000000000000000000000000000000000000000000000000000003e8000000000000000000000000000000000000000000000000002e2f6e5e14800000000000000000000000000000000000000000000007c76e5140c5790525881500000000000000000000000075a54357d9c78a2db19004a5fdc76c50f9242aec0000000000000000000000005835619c020e167052cba35eb4fc2c44bafd983c' }, '0x57db94a8124493b1df6c0e8825a15d0e774a23cc', '0x5835619c020e167052cba35eb4fc2c44bafd983c', '0x9eec4489983319e541a77b1b665d52ee8af676a53fb3de1b1564800799c32306'],
  ['klik', { address: '0x16cf6788b762ee8969744586ed16fc5705140dd7', topics: ["0x60122e78030aba0a2e4a67adb3e52b411343cc51778f919095d3fe394090c1b2"], data: '0x000000000000000000000000ddd0d96df7902b5bef3a11880eabbd01b01d14b3' }, '0xddd0d96df7902b5bef3a11880eabbd01b01d14b3', null, '0x60946c9ac0847f8753f7d4358d4a429718916badaec968142a80c8025aacae17'],
  ['dyorfun', { address: '0x80b42aed46d73f47119dc444bea28a9e68f32bf4', topics: ["0x8f8815afd174b9556e4ef54fbb59bb79d5c567fa89760ac9409682fb9459bfad", "0x0000000000000000000000008b737037418eb9d7842982c5668fbc6d14e5af38", "0x0000000000000000000000008aa9e9d1710fbef6bd4dfb7f425a09b2b350315e", "0x0000000000000000000000001f7d7550b1b028f7571e69a784071f0205fd2efa"], data: '0x0000000000000000000000000bd7d308f8e1639fab988df18a8011f41eacad7300000000000000000000000047dd5343353c3cbacd70bdb51826a47a2946c4a10000000000000000000000000000000000000000000000000000000000169dbc00000000000000000000000000000000000000000000000000000000019073fb000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e00000000000000000000000008aa9e9d1710fbef6bd4dfb7f425a09b2b350315e0000000000000000000000000000000000000000000000000000000000000042697066733a2f2f6261666b726569686d6270707335776375326a7173697677636e6e346a797262636b64373633766978327962346c796b6c6a7a6167367535346961000000000000000000000000000000000000000000000000000000000000' }, '0x8b737037418eb9d7842982c5668fbc6d14e5af38', '0x8aa9e9d1710fbef6bd4dfb7f425a09b2b350315e', '0xfd803ce7e473cc6a55b18a7fcea016f0fbc401c08c74f081fe4e057ed5845994'],
  ['apestore', { address: '0x6e4910ea5a04376032f6564da9a9e4e88b7a87c1', topics: ["0xb378e89b40ac5bbe0e2241b596fbe1adc3cf1fb7c982aa1b4560165cf264ee93", "0x00000000000000000000000005b806651e071dea47bd214008b632ddc7970ca4", "0x0000000000000000000000000000000000000000000000000000000000037f9f"], data: '0x' }, '0x05b806651e071dea47bd214008b632ddc7970ca4', null, '0x31416878228a8428299bf9e6a6786261d93f50749b855b6956e07138e1fb8006'],
];

test('real launches of the six launchpads added in update-21 are attributed to them', () => {
  for (const [lp, log, token, creator, tx] of LAUNCHES) {
    const m = matchKnownEvent(reg, log);
    assert.ok(m, `${lp}: no match for ${tx}`);
    assert.deepEqual([m.launchpadId, m.confidence, m.token], [lp, 'verified', token], `${lp} (${tx})`);
    if (creator) assert.equal(m.fields.creator, creator, `${lp}: creator`);
    // the same event from a contract that is not the launchpad's is a look-alike, never the launchpad
    const fake = matchKnownEvent(reg, { ...log, address: '0x' + '42'.repeat(20) });
    assert.deepEqual([fake.launchpadId, fake.confidence], [null, 'unverified-emitter'], `${lp}: look-alike`);
  }
  // pools.trade's token factory and strategies are the launcher's companions, not unlisted factories
  assert.equal(reg.companionOf.get('0x000000e200088d55c39a11f609e5f667729ad49b')?.launchpadId, 'uniswap-launcher');
  assert.equal(reg.companionOf.get('0x2380abf72c17aabab76480244759ac7e2932eecc')?.launchpadId, 'bags');
});

test('anoncoin is a known Doppler integrator on Robinhood Chain; stored rows move to it on boot', () => {
  const ANON = '0xd8a823e4e416df7a8bfa412ae06f5d5639a1db4d', AIRLOCK = '0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862';
  const spec = reg.platformSpecs.find((s) => s.factory === AIRLOCK);
  const m = { launchpadId: 'doppler', platform: spec.platform };
  const w = (a) => a.replace('0x', '').padStart(64, '0');
  const assetData = '0x' + [w('0x0bd7d308f8e1639fab988df18a8011f41eacad73'), w('0x0'), w('0x0'), w('0x0'), w('0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544'), w('0x0'), w('0x0'), w('0x1'), w('0x1'), w(ANON)].join('');
  const r = resolvePlatform(m, assetData, '0x031');
  assert.deepEqual([r.launchpadId, r.confidence, r.claimedLaunchpadId, r.claimCheck], ['anoncoin', 'observed-emitter', 'anoncoin', null]);
  assert.equal(reg.launchpads.get('anoncoin').name, 'anoncoin');
  // SPOOKYDOGE was stored before update-21 as "Doppler, unlisted app"
  const store = openDb(':memory:');
  const T = '0xa3b3e3c6b5a26b9a81f9b8f2e7934a207e50d09e';
  store.saveToken({ chain_id: 4663, address: T, confidence: 'verified', launchpad_id: 'doppler', factory: AIRLOCK, platform: ANON, event_sig: 'Create(address,address,address,address)', birth_block: 99000000, birth_tx: '0x1', birth_source: 'registry-event', premint: '{"v":2}', tx_from: '0x0310' });
  assert.ok(rejudgeStoredClaims(store, reg, 4663) >= 1);
  const row = store.q.getToken.get(4663, T);
  assert.deepEqual([row.launchpad_id, row.confidence, row.claim_app], ['anoncoin', 'observed-emitter', 'anoncoin']);
});


// A launch that mints its whole supply into its own per-token curve is not a 100% pre-mint. Update-18
// to 20 said it was for every Pons v2 token ("100% of the supply was minted outside the sale").
const PONS_V2 = {"tx": "0x6d143eb1d5311c540b694485ee8215f769ca24f2f372d179745fe542ea607b57", "token": "0x8d350557f1e53d2a03dfb619c0d763f689901321", "logs": [{"address": "0x8d350557f1e53d2a03dfb619c0d763f689901321", "topics": ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", "0x0000000000000000000000000000000000000000000000000000000000000000", "0x0000000000000000000000006ea8f0cd4674330163651ff9fc179a4fbd875d5b"], "data": "0x0000000000000000000000000000000000000000033b2e3c9fd0803ce8000000"}, {"address": "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e", "topics": ["0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607", "0x0000000000000000000000008d350557f1e53d2a03dfb619c0d763f689901321", "0x0000000000000000000000006ea8f0cd4674330163651ff9fc179a4fbd875d5b", "0x000000000000000000000000399e78851d2681efb2d62cbb2fc7d37d4fdb169b"], "data": "0x000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003a4965bf58a40000"}]};
const BAGS = {"tx": "0x9d0f378c8d6515c77bf416277ef64aac66b750ef23b223151c298947730b7e2a", "token": "0xd47684579384ea3f58c9850ea089bf498061b073", "logs": [{"address": "0xd47684579384ea3f58c9850ea089bf498061b073", "topics": ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", "0x0000000000000000000000000000000000000000000000000000000000000000", "0x000000000000000000000000512c315379a3dde3aaa363b51b66dfc22aea9e29"], "data": "0x0000000000000000000000000000000000000000033b2e3c9fd0803ce8000000"}, {"address": "0xe8cc4431adf8b5a847c113ef0c6af9043219cb37", "topics": ["0x643b3b606052cbadac2f906ad0b462da99eda2a1d4f824d315d7f6edd3e4cced", "0x000000000000000000000000d47684579384ea3f58c9850ea089bf498061b073", "0x000000000000000000000000512c315379a3dde3aaa363b51b66dfc22aea9e29", "0x000000000000000000000000c7ddaf9fabeceb68ede241f4a822a3c9626bf412"], "data": "0x00000000000000000000000078a54733aaeb605baa6b5879547c62d400aa7bd6000000000000000000000000000000000000000000000000000000000000000007fbc4213ff5d2caa768514fc2c21e55cbd6dd4b39109d1d7184834116a857da00000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000000c414d43494b204b454241424900000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000005414d43494b000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006268747470733a2f2f726f62696e686f6f642d626167732e707265766965772e656d657267656e746167656e742e636f6d2f6170692f6d657461646174612f38643334656262302d656233632d343862332d393766312d326433363830633463633030000000000000000000000000000000000000000000000000000000000000"}]};

test('the mint into the launch\'s own curve is the sale, not an allocation (Pons v2, Bags); a buyback vault is not a vesting vault', async () => {
  const { birthAllocations } = await import('../src/attribution.js');
  for (const fx of [PONS_V2, BAGS]) {
    const m = matchKnownEvent(reg, fx.logs.find((l) => l.address !== fx.token));
    assert.equal(m.sale.length, 1, 'the launch event names the curve');
    assert.deepEqual(birthAllocations({ logs: fx.logs }, fx.token, reg), { v: 3 }, fx.tx);
  }
  // the same mint without the launch event in the receipt is still an allocation (nothing names that contract)
  const onlyMint = PONS_V2.logs.filter((l) => l.address === PONS_V2.token);
  assert.equal(birthAllocations({ logs: onlyMint }, PONS_V2.token, reg).allocations.length, 1);
  // Pons v2's buyback vault is the launchpad's own contract: a mint to it is the launch, never "vested"
  const mintTo = (to) => ({ address: PONS_V2.token, topics: [onlyMint[0].topics[0], onlyMint[0].topics[1], '0x' + '0'.repeat(24) + to.slice(2)], data: onlyMint[0].data });
  assert.deepEqual(birthAllocations({ logs: [mintTo('0x42df2a798f82289e177311362e8f5ccc45c1219c')] }, PONS_V2.token, reg), { v: 3 });
});

test('boot: v2 pre-mint rows of a launchpad whose event names its sale contract are cleared and re-read on lookup', async () => {
  const { resetSaleMintFacts } = await import('../src/births.js');
  const { Lookup } = await import('../src/lookup.js');
  const store = openDb(':memory:');
  const v2 = JSON.stringify({ v: 2, escrowed: '0', schedules: {}, allocations: [{ to: '0x6ea8f0cd4674330163651ff9fc179a4fbd875d5b', scheduleId: null, amount: '1000000000000000000000000000', unlocked: true, via: 'mint' }] });
  const base = { chain_id: 4663, confidence: 'verified', birth_block: 98000000, birth_tx: PONS_V2.tx, birth_source: 'registry-event', tx_from: '0x0d0e', total_supply: (10n ** 27n).toString() };
  store.saveToken({ ...base, address: PONS_V2.token, launchpad_id: 'pons-v2', factory: '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e', premint: v2 });
  store.saveToken({ ...base, address: '0x' + '01'.repeat(20), launchpad_id: 'o1', factory: '0xce9c48cfa068947f77738c81be406b53338e5b0d', premint: v2 }); // o1 names no sale contract
  store.saveToken({ ...base, address: '0x' + '02'.repeat(20), launchpad_id: 'pons-v2', factory: '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e', premint: '{"v":3}' });
  assert.equal(resetSaleMintFacts(store, reg, 4663), 1);
  assert.equal(resetSaleMintFacts(store, reg, 4663), 0, 'idempotent');
  assert.equal(store.q.getToken.get(4663, PONS_V2.token).premint, null);
  assert.equal(store.q.getToken.get(4663, '0x' + '01'.repeat(20)).premint, v2);
  // the lookup reads the birth receipt again and stores v3: no pre-mint
  const chain = { id: 4663, name: 'Robinhood Chain', slug: 'robinhood', blockTimeMs: 100, statsWindowBlocks: 1_000_000, explorer: {} };
  const rpc = { call: async () => null, batch: async (cs) => cs.map((c) => (c.method === 'eth_getTransactionReceipt' ? { result: { from: '0x0d0e', logs: PONS_V2.logs } } : { result: null })) };
  const lk = new Lookup({ chains: new Map([[4663, chain]]), rpcs: new Map([[4663, rpc]]), registries: new Map([[4663, reg]]), store });
  assert.equal(lk.isCheap(4663, PONS_V2.token), false, 'needs its birth facts again');
  const b = (await lk.token(4663, PONS_V2.token)).body;
  assert.equal(b.premint, null);
  assert.ok(!b.verdict.warnings.some((w) => /minted outside the sale/.test(w)), b.verdict.warnings.join(' | '));
  assert.equal(store.q.getToken.get(4663, PONS_V2.token).premint, '{"v":3}');
});
