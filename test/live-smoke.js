// Live smoke test against the real chain. Usage:
//   node test/live-smoke.js [chainId] [blocks]      e.g.  node test/live-smoke.js 4663 2000
import { loadChains } from '../src/chains.js';
import { loadRegistry, INFRA_TOPICS } from '../src/attribution.js';
import { openDb } from '../src/db.js';
import { Indexer } from '../src/indexer.js';
import { Rpc } from '../src/rpc.js';

const chainId = Number(process.argv[2] ?? 4663);
const blocks = Number(process.argv[3] ?? 2000);
process.env.CHAINS = String(chainId);
const chain = loadChains().get(chainId);
const rpc = new Rpc({ url: chain.rpc, headers: chain.rpcHeaders, minIntervalMs: chain.minIntervalMs });
const store = openDb(process.env.DB_PATH ?? ':memory:');
const registry = loadRegistry(chainId);
const ix = new Indexer({ chain, rpc, registry, store });

const t0 = Date.now();
const head = Number(await rpc.call('eth_blockNumber'));
const to = head - chain.confirmations;
const from = to - blocks + 1;
let stats = { known: 0, born: 0, checked: 0 };
for (let a = from; a <= to; a += chain.logsChunk) {
  const s = await ix.processRange(a, Math.min(a + chain.logsChunk - 1, to), head);
  for (const k of Object.keys(stats)) stats[k] += s[k];
}
const secs = (Date.now() - t0) / 1000;
console.log(`\n${chain.name}: blocks ${from}-${to} (${blocks} blocks = ${(blocks * chain.blockTimeMs / 1000).toFixed(0)} s of chain time) processed in ${secs.toFixed(1)} s`);
console.log('stats', stats, 'rpc', rpc.stats, 'discovery:', ix.status.discovery);

console.log('\nBirths:');
for (const t of store.q.recent.all(chainId, 40)) {
  console.log(' ', t.address, String(t.birth_block), (t.launchpad_id ?? '-').padEnd(9), t.confidence.padEnd(18), String(t.code_size).padStart(6), (t.fp_key ?? '').slice(0, 24).padEnd(24), JSON.stringify(t.symbol));
}
console.log('\nEmitter/event pairs that announced a newborn token (the detector):');
for (const p of store.q.pairs.all(chainId, 0, 25)) {
  const label = INFRA_TOPICS.get(p.topic0) ?? (registry.byTopic0.has(p.topic0) ? 'REGISTRY' : '');
  console.log(' ', p.emitter, p.topic0.slice(0, 10), 'births', String(p.births).padStart(3), 'known', p.known_births, (p.launchpads ?? '').padEnd(10), label);
}
