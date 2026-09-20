// ROLE=all (default) runs indexer + API in one process with one shared RPC budget.
// ROLE=indexer / ROLE=api split them, which only makes sense when both can reach the same DB file.
import { loadRegistry } from './attribution.js';
import { reattributeFromEvidence } from './births.js';
import { loadChains } from './chains.js';
import { openDb } from './db.js';
import { Indexer } from './indexer.js';
import { Lookup } from './lookup.js';
import { Rpc } from './rpc.js';
import { createServer } from './server.js';

const role = process.env.ROLE ?? 'all';
const chains = loadChains();
const store = openDb();
const rpcs = new Map();
const registries = new Map();
const indexers = new Map();

for (const chain of chains.values()) {
  rpcs.set(chain.id, new Rpc({ url: chain.rpc, headers: chain.rpcHeaders, minIntervalMs: chain.minIntervalMs }));
  registries.set(chain.id, loadRegistry(chain.id));
  console.info(`[${chain.slug}] chain ${chain.id}, ${registries.get(chain.id).launchpads.size} launchpads in registry, rpc ${new URL(chain.rpc).host}`);
  if (role !== 'api') {
    const n = reattributeFromEvidence(store, registries.get(chain.id), chain.id);
    if (n) console.info(`[${chain.slug}] registry changed: re-attributed ${n} already-indexed tokens from stored evidence`);
  }
}

if (role === 'all' || role === 'indexer') {
  for (const chain of chains.values()) {
    const ix = new Indexer({ chain, rpc: rpcs.get(chain.id), registry: registries.get(chain.id), store });
    indexers.set(chain.id, ix);
    ix.run().catch((e) => { console.error(`[${chain.slug}] indexer crashed`, e); process.exit(1); });
  }
}

let server = null;
if (role === 'all' || role === 'api') {
  const lookup = new Lookup({ chains, rpcs, registries, store, indexers });
  server = createServer({ lookup });
  const port = Number(process.env.PORT ?? 8080);
  server.listen(port, () => console.info(`lookup page + API on :${port}`));
}

function shutdown() {
  for (const ix of indexers.values()) ix.stop();
  server?.close();
  setTimeout(() => { store.db.close(); process.exit(0); }, 300).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
