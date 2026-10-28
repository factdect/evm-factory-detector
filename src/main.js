// ROLE=all (default) runs indexer + API in one process with one shared RPC budget.
// ROLE=indexer / ROLE=api split them, which only makes sense when both can reach the same DB file.
import http from 'node:http';
import { loadRegistry } from './attribution.js';
import { reattributeFromEvidence, rejudgeStoredClaims, resetSaleMintFacts } from './births.js';
import { loadChains } from './chains.js';
import { isDiskFull, openDb } from './db.js';
import { Indexer } from './indexer.js';
import { Lookup } from './lookup.js';
import { Rpc } from './rpc.js';
import { createServer } from './server.js';

const role = process.env.ROLE ?? 'all';
const chains = loadChains();
const port = Number(process.env.PORT ?? 8080);

// A volume at 100% cannot even open the database (SQLite needs a few KB for its WAL index).
const isStorageError = (e) => isDiskFull(e) || /^SQLITE_IOERR/.test(e?.code ?? '') || /disk I\/O error/i.test(e?.message ?? '');

let store = null;
try {
  store = openDb();
} catch (e) {
  if (!isStorageError(e)) throw e;
  storageFull(e);
}
if (store) start(store);

/**
 * The database cannot be opened because the volume is full. Answer every request with 503 and a
 * plain explanation (logs and /health say what to do). This does not keep an older deployment
 * serving: Railway runs one deployment at a time for a service with a volume, so grow the volume
 * BEFORE deploying. Once the database opens again, exit so the restart policy brings the service
 * up normally.
 */
function storageFull(err) {
  const msg = `storage full: the database cannot be opened (${err.code ?? 'error'}: ${err.message}). `
    + 'Grow the volume (Railway: service > Volume > grow), then restart or redeploy.';
  console.error(msg);
  http.createServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'retry-after': '60', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: false, problems: [msg] }, null, 2));
  }).listen(port, () => console.info(`storage-full mode: answering 503 on :${port}`));
  setInterval(() => {
    try {
      openDb().db.close();
      console.info('storage: the database opens again; restarting');
      process.exit(1);
    } catch { /* still full */ }
  }, 30_000);
}

function start(store) {
  {
    const s = store.storage.stats();
    const mb = (b) => (b === null ? '?' : `${Math.round(b / 1048576)} MB`);
    console.info(`storage: db ${mb(s.dbBytes)} (${mb(s.reusableBytes)} reusable), wal ${mb(s.walBytes)}, free ${mb(s.freeBytes)} of ${mb(s.volumeBytes)}`
      + (store.migration.needed ? ` | evidence migration pending: ${store.migration.lastError}` : ''));
  }
  const rpcs = new Map();
  const registries = new Map();
  const indexers = new Map();

  for (const chain of chains.values()) {
    rpcs.set(chain.id, new Rpc({ url: chain.rpc, headers: chain.rpcHeaders, minIntervalMs: chain.minIntervalMs }));
    registries.set(chain.id, loadRegistry(chain.id));
    console.info(`[${chain.slug}] chain ${chain.id}, ${registries.get(chain.id).launchpads.size} launchpads in registry, rpc ${new URL(chain.rpc).host}`);
    if (chain.id === 8453 && chain.publicRpc) {
      console.warn('[base] WARNING: mainnet.base.org caps eth_getLogs at 200 blocks and, since 2026-10-08, answers ~98% of requests from '
        + 'datacenter hosts with HTTP 429 "request limit reached". Set RPC_8453 to a private endpoint, or Base indexing will crawl.');
    }
    if (role !== 'api') {
      try {
        const n = reattributeFromEvidence(store, registries.get(chain.id), chain.id);
        if (n) console.info(`[${chain.slug}] registry changed: re-attributed ${n} already-indexed tokens from stored evidence`);
        const c = rejudgeStoredClaims(store, registries.get(chain.id), chain.id);
        if (c) console.info(`[${chain.slug}] registry rules changed: re-judged ${c} stored integrator claims`);
        const s = resetSaleMintFacts(store, registries.get(chain.id), chain.id);
        if (s) console.info(`[${chain.slug}] pre-mint facts: cleared ${s} rows that counted the launch's own sale contract as an allocation (re-read on lookup)`);
      } catch (e) {
        // a full disk must not stop the API from serving what is already indexed; this runs again on the next boot
        if (!isDiskFull(e)) throw e;
        console.error(`[${chain.slug}] re-attribution skipped, disk full: ${e.message}`);
      }
    }
  }

  if (role === 'all' || role === 'indexer') {
    for (const chain of chains.values()) {
      const ix = new Indexer({ chain, rpc: rpcs.get(chain.id), registry: registries.get(chain.id), store });
      indexers.set(chain.id, ix);
      ix.run().catch((e) => { console.error(`[${chain.slug}] indexer crashed`, e); process.exit(1); });
      ix.runBackground().catch((e) => { console.error(`[${chain.slug}] background loop crashed`, e); process.exit(1); });
    }
  }

  // Storage housekeeping is global (one database for every chain), so it runs on its own timer, not
  // from a chain's caught-up path: a chain that lags must not stop the disk from being looked after.
  if (role !== 'api') {
    const housekeeping = () => {
      try { if (store.migration.needed) store.migrateRefs(); } catch (e) { console.error(`storage: migration: ${e.message}`); }
      for (const ix of indexers.values()) {
        try { ix.reclaim('housekeeping'); } catch (e) { console.warn(`[${ix.chain.slug}] storage housekeeping: ${e.message}`); }
      }
    };
    setTimeout(housekeeping, 60_000).unref();
    setInterval(housekeeping, 10 * 60_000).unref();
  }

  let server = null;
  if (role === 'all' || role === 'api') {
    const lookup = new Lookup({ chains, rpcs, registries, store, indexers });
    server = createServer({ lookup });
    server.listen(port, () => console.info(`lookup page + API on :${port}`));
  }

  const shutdown = () => {
    for (const ix of indexers.values()) ix.stop();
    server?.close();
    setTimeout(() => { store.db.close(); process.exit(0); }, 300).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
