// update-13: what went wrong on 2026-09-25 (volume full, indexer frozen for 14 days, /health said
// "19 blocks behind") and what Base changed on 2026-10-05 / 10-08 (getLogs caps, rate limits).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { loadRegistry } from '../src/attribution.js';
import { probeFirstLog, probeSpan } from '../src/age.js';
import { loadChains } from '../src/chains.js';
import { isDiskFull, openDb } from '../src/db.js';
import { Indexer } from '../src/indexer.js';
import { Lookup } from '../src/lookup.js';
import { getLogsRange, isCallerRefusal, rangeCapFrom, Rpc, RpcError, suggestedRangeFrom } from '../src/rpc.js';

const quiet = { info() {}, warn() {}, error() {} };
const addr = (n) => '0x' + n.toString(16).padStart(40, '0');
const topic = (n) => '0x' + n.toString(16).padStart(64, '0');
const tmpFile = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fd-')), name);

// ---- Base RPC reality ----------------------------------------------------------------------------

test('rangeCapFrom: reads the cap a node states, and nothing from other errors', () => {
  const e = (message) => new RpcError('eth_getLogs', { message });
  assert.equal(rangeCapFrom(e('eth_getLogs is limited to a 200 range')), 200, 'mainnet.base.org since 2026-10-08');
  assert.equal(rangeCapFrom(e('eth_getLogs is limited to a 1,000 range')), 1000);
  assert.equal(rangeCapFrom(e('Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.')), 10, 'Alchemy free tier');
  assert.equal(rangeCapFrom(e('ranges over 10000 blocks are not supported on freetier')), 10000, 'dRPC');
  assert.equal(rangeCapFrom(e('query returned more than 10000 results')), null, 'a result-size cap is not a block cap');
  assert.equal(rangeCapFrom(e('backend response too large')), null);
});

test('getLogsRange: a stated cap is learned once, instead of failing every other call', async () => {
  const asked = [];
  let refused = 0;
  const rpc = { call: async (_m, [f]) => {
    const a = Number(f.fromBlock), b = Number(f.toBlock);
    if (b - a + 1 > 200) { refused++; throw new RpcError('eth_getLogs', { code: -32614, message: 'eth_getLogs is limited to a 200 range' }); }
    asked.push([a, b]);
    return [{ blockNumber: a }];
  } };
  const state = { span: 400, max: 400 };
  await getLogsRange(rpc, {}, 0, 1999, state, 9500);
  assert.equal(refused, 1, 'one refusal teaches the cap; growing back to 400 would be refused again and again');
  assert.deepEqual([state.span, state.max], [200, 200]);
  assert.equal(asked.length, 10);
  assert.deepEqual(asked.at(-1), [1800, 1999], 'covers the range exactly');
});

test('Rpc: "request limit reached" (Base, HTTP 200 JSON-RPC error) is a rate limit and is retried', async () => {
  const real = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async (_u, init) => {
    n++;
    const { id } = JSON.parse(init.body);
    if (n === 1) return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32011, message: 'request limit reached' } }), { status: 200 });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: '0x1' }), { status: 200 });
  };
  try {
    const rpc = new Rpc({ url: 'http://stub', minIntervalMs: 0, maxRetries: 2 });
    assert.equal(await rpc.call('eth_blockNumber'), '0x1');
    assert.equal(rpc.stats.rateLimited, 1);
  } finally { globalThis.fetch = real; }
  assert.ok(isCallerRefusal(new Error('HTTP 429')));
  assert.ok(isCallerRefusal(new RpcError('eth_getLogs', { message: 'Monthly capacity limit exceeded.' })), 'Alchemy quota');
  assert.ok(!isCallerRefusal(new Error('HTTP 500')));
});

test('probeFirstLog: rate limits and quota never date a contract; a stated cap re-asks in smaller pieces', async () => {
  const chain = { id: 99001, ageLookbackBlocks: 1000, addrLogsSpan: 600 };
  const rpcWith = (fn) => ({ call: async (_m, [f]) => fn(Number(f.fromBlock), Number(f.toBlock)) });
  // Before update-13 a 429 after retries counted as "busy range = activity": a brand-new factory on
  // a rate-limited Base RPC came out "older than the lookback". Now the probe fails and is retried later.
  await assert.rejects(() => probeFirstLog(rpcWith(() => { throw Object.assign(new Error('HTTP 429'), { retryable: true }); }), chain, '0xabc', 2000, 1900));
  await assert.rejects(() => probeFirstLog(rpcWith(() => { throw new RpcError('eth_getLogs', { message: 'Monthly capacity limit exceeded' }); }), chain, '0xabc', 2000, 1900));
  // a 200-block cap: the log at 1450 is found, no false activity at a refused range's start
  const capped = rpcWith((a, b) => {
    if (b - a + 1 > 200) throw new RpcError('eth_getLogs', { message: 'eth_getLogs is limited to a 200 range' });
    return a <= 1450 && 1450 <= b ? [{ blockNumber: '0x' + (1450).toString(16) }] : [];
  });
  assert.deepEqual(await probeFirstLog(capped, chain, '0xabc', 2000, 1900), { firstLogBlock: 1450, lookbackFrom: 1000 });
  assert.equal(probeSpan(chain), 200, 'learned for the next probe');
  assert.equal(chain.addrLogsSpan, 600, 'the configured span is not touched: the birth scan of a lookup sizes its work by it');
  assert.deepEqual(await probeFirstLog(rpcWith((a, b) => { if (b - a + 1 > 200) throw new RpcError('x', { message: 'eth_getLogs is limited to a 200 range' }); return []; }), chain, '0xabc', 2000, 1900),
    { firstLogBlock: 1900, lookbackFrom: 1000 }, 'silent contract stays new');
});

// ---- storage ---------------------------------------------------------------------------------------

const LEGACY = `
CREATE TABLE birth_refs (
  chain_id INTEGER NOT NULL, token TEXT NOT NULL, emitter TEXT NOT NULL, topic0 TEXT NOT NULL,
  log_index INTEGER, block INTEGER,
  PRIMARY KEY (chain_id, token, emitter, topic0)
) WITHOUT ROWID;
CREATE INDEX refs_pair ON birth_refs (chain_id, emitter, topic0);
CREATE INDEX refs_emitter_block ON birth_refs (chain_id, emitter, block);
CREATE INDEX refs_block ON birth_refs (chain_id, block);`;

test('storage: the old text evidence table migrates in place and reads back identically', () => {
  const file = tmpFile('legacy.db');
  const old = new Database(file);
  old.exec(LEGACY);
  const ins = old.prepare('INSERT INTO birth_refs VALUES (?, ?, ?, ?, ?, ?)');
  const rows = [];
  for (let t = 1; t <= 50; t++) for (let e = 0; e < 3; e++) rows.push([4663, addr(0x1000 + t), addr(0xe0 + e), topic(0x70 + e), e, 1000 + t]);
  for (const r of rows) ins.run(...r);
  old.close();

  const store = openDb(file);
  assert.equal(store.migration.needed, false);
  assert.equal(store.db.prepare("SELECT type FROM sqlite_master WHERE name = 'birth_refs'").get().type, 'view');
  const back = store.db.prepare('SELECT chain_id, token, emitter, topic0, log_index, block FROM birth_refs ORDER BY token, emitter').all().map(Object.values);
  assert.deepEqual(back, rows.sort((x, y) => (x[1] + x[2]).localeCompare(y[1] + y[2])));
  assert.equal(store.q.getMeta.get(4663, 'index_start').v, 1001, 'index start recorded from the old table');
  store.q.addRef.run(4663, addr(0x9999), addr(0xe0), topic(0x70), 0, 2000); // writes go to the new form
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM birth_refs').get().n, 151);
  store.db.close();
});

test('storage: evidence takes under a third of the space it took as text', () => {
  const pages = (db, names) => db.prepare(`SELECT SUM(pgsize) AS b FROM dbstat WHERE name IN (${names.map(() => '?').join(',')})`).get(...names).b;
  const legacy = new Database(':memory:');
  legacy.exec(LEGACY);
  const ins = legacy.prepare('INSERT INTO birth_refs VALUES (?, ?, ?, ?, ?, ?)');
  const store = openDb(':memory:');
  legacy.transaction(() => {
    store.db.transaction(() => {
      for (let t = 0; t < 3000; t++) {
        for (let e = 0; e < 7; e++) { // ~7 refs per token, as measured on Robinhood Chain (2026-10-09)
          const args = [4663, addr(0x100000 + t), addr(0xe0 + (e % 4)), topic(0x700 + e), e, 5_000_000 + t];
          ins.run(...args);
          store.q.addRef.run(...args);
        }
      }
    })();
  })();
  const before = pages(legacy, ['birth_refs', 'refs_pair', 'refs_emitter_block', 'refs_block']);
  const after = pages(store.db, ['refs', 'refs_emitter_block', 'refs_block', 'ids', 'sqlite_autoindex_ids_1']);
  assert.ok(after < before / 3, `compact ${after} B vs text ${before} B`);
});

test('storage: pruning old evidence keeps tokens, first sightings and the index start', () => {
  const store = openDb(':memory:');
  const E = addr(0xee);
  for (const [t, b] of [[1, 100], [2, 200], [3, 5000]]) {
    store.saveToken({ chain_id: 4663, address: addr(t), confidence: 'discovered', birth_block: b, birth_tx: '0x1', birth_source: 'x' });
    store.q.addRef.run(4663, addr(t), E, topic(1), 0, b);
  }
  const reg = loadRegistry(4663);
  const chain = loadChains({ CHAINS: '4663' }).get(4663);
  const lk = new Lookup({ chains: new Map([[4663, chain]]), rpcs: new Map(), registries: new Map([[4663, reg]]), store });
  const firstBefore = lk.sql.emitterFirst.get({ c: 4663, e: E }).first_block;
  assert.equal(store.pruneRefs(4663, 1000, { batch: 1 }), 2);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM birth_refs').get().n, 1);
  assert.equal(store.q.counts.get(4663).tokens, 3, 'tokens are never pruned');
  assert.equal(lk.sql.emitterFirst.get({ c: 4663, e: E }).first_block, firstBefore, 'first sighting does not move forward');
  assert.equal(lk.sql.indexStart.get({ c: 4663 }).b, 100, 'index start does not move forward');
});

test('isDiskFull: SQLite and filesystem wording', () => {
  assert.ok(isDiskFull(Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' })));
  assert.ok(isDiskFull(new Error('ENOSPC: no space left on device, write')));
  assert.ok(!isDiskFull(new Error('HTTP 429')));
});

// ---- the stall ---------------------------------------------------------------------------------

function stalledIndexer({ head, cursor, rpcExtra = {} }) {
  const chain = loadChains({ CHAINS: '4663' }).get(4663);
  const store = openDb(':memory:');
  store.q.setCursor.run(4663, cursor, cursor + 19, 0);
  const asked = [];
  const rpc = {
    call: async (m, p) => {
      if (m === 'eth_blockNumber') return '0x' + head.toString(16);
      if (m === 'eth_getLogs') { asked.push([Number(p[0].fromBlock), Number(p[0].toBlock)]); return []; }
      if (rpcExtra[m]) return rpcExtra[m](p);
      throw new Error('unexpected ' + m);
    },
    batch: async (cs) => cs.map(() => ({ result: '0x' })),
  };
  const ix = new Indexer({ chain, rpc, registry: loadRegistry(4663), store, log: quiet });
  return { chain, store, ix, asked };
}

test('stall: /health shows the real lag while a range keeps failing (it said "19 blocks" for 14 days)', async () => {
  const head = 84_229_934, cursor = 72_199_070;
  const { chain, store, ix } = stalledIndexer({ head, cursor });
  chain.maxLagBlocks = 0; // isolate: no jump-ahead in this test
  ix.diskWaitMs = 0;
  let reclaimed = 0;
  ix.reclaim = () => { reclaimed++; return 0; };
  ix.processRange = async () => { ix.stop(); throw Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' }); };
  ix.status.startedAt = Date.now() - 10 * 60_000;
  await ix.run();
  assert.equal(ix.status.head, head, 'head is fresh even though the range failed');
  assert.equal(ix.status.lag, head - cursor);
  assert.equal(ix.status.diskFull, true);
  assert.equal(reclaimed, 1, 'a full disk triggers a reclaim, not a 5-second retry loop');
  const lk = new Lookup({ chains: new Map([[4663, chain]]), rpcs: new Map(), registries: new Map([[4663, loadRegistry(4663)]]), store, indexers: new Map([[4663, ix]]) });
  const h = lk.health();
  assert.equal(h.ok, false);
  assert.match(h.problems[0], /disk full/);
  assert.equal(h.chains[0].indexer.lagBlocks, head - cursor);
  assert.equal(h.chains[0].indexer.stalled, true);
});

test('stall: far behind, live indexing resumes near head and the gap is replayed newest-first for known launches', async () => {
  const head = 1_500_000, cursor = 1_000_000;
  const { chain, store, ix, asked } = stalledIndexer({ head, cursor });
  const target = head - chain.confirmations;
  const resume = target - chain.stateWindow;
  const maintain = ix.maintain.bind(ix);
  ix.maintain = async () => {};
  const live = ix.processRange.bind(ix);
  ix.processRange = async (...a) => { const r = await live(...a); ix.stop(); return r; };
  await ix.run();
  assert.equal(asked[0][0], resume, 'first live range starts at the edge of the state window');
  assert.equal(ix.status.discovery, 'on', 'discovery is live again immediately');
  assert.deepEqual(store.q.newestGap.get(4663), { from_block: cursor, to_block: resume - 1 });
  assert.equal(store.q.getCursor.get(4663).next_block, resume + chain.logsChunk);

  // background replay: newest chunk first, known-launchpad events only (discovery cannot run there)
  ix.processRange = live;
  asked.length = 0;
  await maintain(head);
  assert.ok(!asked.some(([, b]) => b === resume - 1), 'maintain() does not replay: a dense chunk would hold up live detection');
  asked.length = 0;
  assert.equal(await ix.backfillOnce(head), true);
  const known = asked.find(([a, b]) => b === resume - 1);
  assert.ok(known, 'replays the newest end of the gap first');
  const first = resume - known[0];
  assert.equal(first, chain.logsChunk / 10, 'a small first chunk: live detection must not wait on the replay');
  assert.equal(asked.filter(([a]) => a >= cursor && a < resume).length, 1, 'one getLogs (registry events) per chunk: no mint discovery in the gap');
  assert.equal(store.q.newestGap.get(4663).to_block, resume - first - 1);
  assert.equal(ix.status.discovery, 'on', 'the replay does not flip the live discovery status');
  await ix.backfillOnce(head);
  assert.ok(ix.backfillSpan > first, 'a quick chunk grows the next one');

  const lk = new Lookup({ chains: new Map([[4663, chain]]), rpcs: new Map(), registries: new Map([[4663, loadRegistry(4663)]]), store, indexers: new Map([[4663, ix]]) });
  const left = store.q.newestGap.get(4663).to_block - cursor + 1;
  assert.equal(lk.status()[0].backfill.blocksLeft, left);
  // a stock token listed inside the gap: its launch count cannot be complete until the replay passes it
  store.q.addRef.run(4663, addr(1), addr(2), topic(3), 0, 900_000);
  store.q.putStock.run(4663, addr(0x44), 'rh', 'GAP', 'Gap • Robinhood Token', 1_200_000, '0x' + '03'.repeat(32), 1, 0);
  store.q.putStock.run(4663, addr(0x45), 'rh', 'NEW', 'New • Robinhood Token', 1_499_000, '0x' + '04'.repeat(32), 1, 0);
  const rows = lk.stocks(4663);
  assert.deepEqual(rows.map((r) => [r.symbol, r.countComplete, r.open]), [['NEW', true, true], ['GAP', false, null]]);
});

test('stall: BACKFILL=off jumps ahead without queueing a replay; a normal restart lag is replayed in order', async () => {
  const head = 1_500_000;
  {
    const { chain, store, ix } = stalledIndexer({ head, cursor: 1_000_000 });
    chain.backfill = false;
    ix.maintain = async () => {};
    const live = ix.processRange.bind(ix);
    ix.processRange = async (...a) => { const r = await live(...a); ix.stop(); return r; };
    await ix.run();
    assert.equal(store.q.newestGap.get(4663), undefined);
  }
  {
    const { store, ix, asked } = stalledIndexer({ head, cursor: head - 5000 }); // a deploy restart: minutes, not days
    ix.maintain = async () => {};
    const live = ix.processRange.bind(ix);
    ix.processRange = async (...a) => { const r = await live(...a); ix.stop(); return r; };
    await ix.run();
    assert.equal(asked[0][0], head - 5000, 'small lag: no jump, nothing skipped');
    assert.equal(store.q.newestGap.get(4663), undefined);
  }
});

// ---- live detection never waits for background work ---------------------------------------------

test('Rpc: background calls queued first still go after the live loop\'s calls', async () => {
  const real = globalThis.fetch;
  const order = [];
  globalThis.fetch = async (_u, init) => {
    const b = JSON.parse(init.body);
    order.push(b.method);
    await new Promise((r) => setTimeout(r, 2));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, result: b.method }), { status: 200 });
  };
  try {
    const rpc = new Rpc({ url: 'http://stub', minIntervalMs: 0 });
    const bg = rpc.background();
    const backlog = ['b1', 'b2', 'b3', 'b4'].map((m) => bg.call(m)); // a replay chunk's receipts, all queued
    for (const m of ['l1', 'l2', 'l3']) assert.equal(await rpc.call(m), m); // the live loop, one call at a time
    await Promise.all(backlog);
    assert.deepEqual(order, ['l1', 'l2', 'l3', 'b1', 'b2', 'b3', 'b4'], 'each live call goes before the backlog');
    const lookup = bg.call('b5');
    assert.equal(await rpc.call('p', [], { priority: true }), 'p');
    await lookup;
  } finally { globalThis.fetch = real; }
});

test('runBackground: probes and replay run only while live indexing is caught up', async () => {
  const { ix } = stalledIndexer({ head: 1_500_000, cursor: 1_000_000 });
  let maintained = 0, replayed = 0;
  ix.maintain = async () => { maintained++; };
  ix.backfillOnce = async () => { replayed++; return false; };
  Object.assign(ix, { bgPollMs: 1000, bgWaitMs: 20 });
  Object.assign(ix.status, { head: 1_500_000, lag: 400_000, lastProgressAt: Date.now() });
  ix.runBackground();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(maintained + replayed, 0, 'catching up: the live loop gets the whole RPC budget');
  ix.status.lag = 19;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(maintained, 1);
  assert.equal(replayed, 1);
  ix.stop(); // the loop's timers are unref'd: it ends at its next wake without holding the process
});

test('replay: a chunk that keeps failing is skipped after 10 tries; a full disk is never a reason to skip', async () => {
  const { store, ix } = stalledIndexer({ head: 1_500_000, cursor: 1_000_000 });
  store.q.addGap.run(4663, 1_000_000, 1_000_999, 0);
  ix.backfillSpan = 1000;
  ix.processRange = async () => { throw new Error('execution reverted: poison block'); };
  for (let i = 0; i < 9; i++) await assert.rejects(() => ix.backfillOnce(1_500_000));
  assert.equal(store.q.newestGap.get(4663).to_block, 1_000_999, 'nine failures: still waiting on that chunk');
  assert.equal(await ix.backfillOnce(1_500_000), true);
  assert.equal(store.q.newestGap.get(4663), undefined, 'tenth failure: chunk skipped, gap done');
  assert.equal(ix.status.replaySkippedBlocks, 1000);

  store.q.addGap.run(4663, 2_000_000, 2_000_999, 0);
  ix.processRange = async () => { throw Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' }); };
  for (let i = 0; i < 15; i++) await assert.rejects(() => ix.backfillOnce(1_500_000));
  assert.equal(store.q.newestGap.get(4663).to_block, 2_000_999, 'disk full: nothing skipped, however long it lasts');
});

test('rollback: the evidence goes back to the exact old text table, with its indexes, and migrates again', async () => {
  const { rollbackEvidence } = await import('../src/db.js');
  const file = tmpFile('rb.db');
  const store = openDb(file);
  const rows = [];
  for (let t = 1; t <= 30; t++) for (let e = 0; e < 3; e++) rows.push([4663, addr(0x2000 + t), addr(0xe0 + e), topic(0x80 + e), e, 500 + t]);
  for (const r of rows) store.q.addRef.run(...r);
  store.db.close();
  assert.deepEqual(rollbackEvidence(file), { done: true, rows: 90 });
  const db = new Database(file);
  const objs = db.prepare("SELECT type, name FROM sqlite_master WHERE tbl_name = 'birth_refs' ORDER BY name").all().map((o) => `${o.type}:${o.name}`);
  assert.deepEqual(objs, ['table:birth_refs', 'index:refs_block', 'index:refs_emitter_block', 'index:refs_pair'], 'what an older build expects');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('refs', 'ids', 'emitter_first')").get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM birth_refs').get().n, 90);
  db.close();
  assert.equal(rollbackEvidence(file).done, false, 'a second rollback is a no-op');
  const again = openDb(file); // and update-13 migrates it again
  assert.equal(again.migration.needed, false);
  assert.equal(again.db.prepare('SELECT COUNT(*) AS n FROM birth_refs').get().n, 90);
  again.db.close();
});

test('health: low free disk is a problem even with plenty of reusable pages; a migration error is shown', () => {
  const store = openDb(':memory:');
  const chain = loadChains({ CHAINS: '4663' }).get(4663);
  const lk = new Lookup({ chains: new Map([[4663, chain]]), rpcs: new Map(), registries: new Map([[4663, loadRegistry(4663)]]), store });
  store.storage.stats = () => ({ dbBytes: 600e6, walBytes: 0, volumeBytes: 5e9, fsFreeBytes: 5 * 1048576, reusableBytes: 470e6, freeBytes: 5 * 1048576 + 470e6 });
  store.migration.lastError = 'needs ~197 MB free on the volume, have 5 MB';
  const h = lk.health();
  assert.equal(h.ok, false);
  assert.equal(h.storage.low, false, '475 MB of room to write into: nothing to prune');
  assert.equal(h.storage.diskLow, true, 'but the disk itself has 5 MB: the WAL or an index build fails next');
  assert.ok(h.problems.some((p) => /only 5 MB free on the volume; grow it/.test(p)));
  assert.ok(h.problems.some((p) => /migration: needs ~197 MB/.test(p)));
});

test('pruned evidence: a discovered token whose announcers were pruned is not called "silent"', async () => {
  const store = openDb(':memory:');
  const chain = loadChains({ CHAINS: '4663' }).get(4663);
  const lk = new Lookup({ chains: new Map([[4663, chain]]), rpcs: new Map(), registries: new Map([[4663, loadRegistry(4663)]]), store });
  const T = addr(0x7777), M = addr(0x8888);
  // made by a maker that also made others: with no evidence at all this used to read "silent factory"
  for (const [a, b] of [[T, 100], [addr(0x7778), 110], [addr(0x7779), 120]]) {
    store.saveToken({ chain_id: 4663, address: a, confidence: 'discovered', birth_block: b, birth_tx: '0x1', birth_source: 'discovery', tx_to: M, mint_to: M });
    store.q.addRef.run(4663, a, addr(0xe1), topic(9), 0, b);
  }
  store.q.setCursor.run(4663, 5000, 5019, 0);
  assert.equal(store.pruneRefs(4663, 1000), 3);
  const body = (await lk.token(4663, T)).body;
  assert.equal(body.verdict.code, 'evidence-pruned');
  assert.equal(body.evidencePruned, true);
  // a token born after the prune horizon, with no announcers, is still what it was
  store.saveToken({ chain_id: 4663, address: addr(0x9999), confidence: 'discovered', birth_block: 4000, birth_tx: '0x2', birth_source: 'discovery' });
  assert.equal((await lk.token(4663, addr(0x9999))).body.verdict.code, 'discovered-silent');
});

test('index start: set at the first block of a fresh index; moved forward when skipped blocks are not replayed', async () => {
  {
    const { store, ix } = stalledIndexer({ head: 1_500_000, cursor: 0 });
    store.db.exec('DELETE FROM cursor'); // fresh database
    ix.maintain = async () => {};
    const live = ix.processRange.bind(ix);
    ix.processRange = async (...a) => { const r = await live(...a); ix.stop(); return r; };
    await ix.run();
    assert.equal(store.q.getMeta.get(4663, 'index_start').v, 1_500_000 - 20 - ix.chain.backfillBlocks);
  }
  {
    const { chain, store, ix } = stalledIndexer({ head: 1_500_000, cursor: 1_000_000 });
    store.q.setMetaOnce.run(4663, 'index_start', 900_000);
    chain.backfill = false;
    const live = ix.processRange.bind(ix);
    ix.processRange = async (...a) => { const r = await live(...a); ix.stop(); return r; };
    await ix.run();
    const resume = 1_500_000 - chain.confirmations - chain.stateWindow;
    assert.equal(store.q.getMeta.get(4663, 'index_start').v, resume, 'BACKFILL=off: complete only from where live resumed');
  }
  {
    const { chain, store, ix } = stalledIndexer({ head: 1_500_000, cursor: 1_499_000 });
    chain.maxLagBlocks = 100; // 980 behind: past MAX_LAG_BLOCKS but inside the state window, so nothing to skip
    const live = ix.processRange.bind(ix);
    ix.processRange = async (...a) => { const r = await live(...a); ix.stop(); return r; };
    await ix.run();
    assert.equal(store.q.newestGap.get(4663), undefined, 'no empty gap written');
  }
});

test('reclaim: RETAIN_REFS_DAYS never prunes inside the stats window', () => {
  const { chain, store, ix } = stalledIndexer({ head: 1_500_000, cursor: 1_499_000 });
  chain.retainRefsDays = 1; // asks for 1 day, but candidates read 3
  ix.status.head = 10_000_000;
  const day = Math.round(86_400_000 / chain.blockTimeMs);
  for (const [i, ago] of [[1, 2 * day], [2, 5 * day]]) store.q.addRef.run(4663, addr(i), addr(0xee), topic(1), 0, 10_000_000 - ago);
  ix.reclaim('housekeeping');
  const left = store.db.prepare('SELECT token FROM birth_refs').all().map((r) => r.token);
  assert.deepEqual(left, [addr(1)], 'the 2-day-old evidence stays; the 5-day-old goes');
});

test('a result-size refusal is not a range cap: Alchemy names its 10,000-block policy in it, and once took the birth scan from 2.4M to 240k blocks', async () => {
  const ALCHEMY = 'Log response size exceeded. You can make eth_getLogs requests with up to a 10,000 block range and no limit on the response size, or you can request any block range with a cap of 10K logs in the response. Based on your parameters and the response size limit, this block range should work: [0x3e8, 0x4e2]';
  assert.equal(rangeCapFrom({ message: ALCHEMY }), null);
  assert.deepEqual(suggestedRangeFrom({ message: ALCHEMY }), [1000, 1250]);
  assert.equal(rangeCapFrom({ message: 'query returned more than 10000 results' }), null);
  assert.equal(rangeCapFrom({ message: 'eth_getLogs is limited to a 200 range' }), 200, 'a real cap still parses');
  // the age probe on a busy address: a size refusal is activity (halving, as before); the span stays configured
  const chain = { id: 99002, ageLookbackBlocks: 1000, addrLogsSpan: 100_000 };
  const asked = [];
  const rpc = { call: async (_m, [f]) => { const a = Number(f.fromBlock), b = Number(f.toBlock); asked.push([a, b]);
    if (b - a + 1 > 250) throw new RpcError('eth_getLogs', { message: ALCHEMY.replace('[0x3e8, 0x4e2]', `[0x${a.toString(16)}, 0x${(a + 249).toString(16)}]`) });
    return a <= 1100 && 1100 <= b ? [{ blockNumber: '0x44c' }] : []; } };
  assert.deepEqual(await probeFirstLog(rpc, chain, '0xabc', 2000, 1900), { firstLogBlock: 1100, lookbackFrom: 1000 });
  assert.ok(asked.length <= 8, `halving, not a walk: ${asked.length} calls`);
  assert.equal(chain.addrLogsSpan, 100_000);
  assert.equal(probeSpan(chain), 100_000, 'no cap learned from a size error');
  asked.length = 0;
  // getLogsRange takes the hint too, without lowering its ceiling
  const state = { span: 100_000, max: 100_000 };
  const got = await getLogsRange(rpc, { address: '0xabc' }, 1000, 1899, state);
  assert.equal(got.length, 1);
  assert.equal(state.max, 100_000);
});

test('age probe on a busy address: small windows first, and a huge answer does not overflow (update-20)', async () => {
  const { probeFirstLog: probe, earliestBlock, FIRST_WINDOW } = await import('../src/age.js');
  // 2026-10-28 on Base: one 86,400-block call returned a busy announcer's whole week; Math.min(...logs) threw
  const many = Array.from({ length: 300_000 }, (_, i) => ({ blockNumber: '0x' + (5000 + (i % 100)).toString(16) }));
  assert.equal(earliestBlock(many), 5000);
  assert.equal(earliestBlock([]), null);
  const chain = { id: 99003, ageLookbackBlocks: 86_400, addrLogsSpan: 100_000 };
  const asked = [];
  const busy = { call: async (_m, [f]) => { const a = Number(f.fromBlock), b = Number(f.toBlock); asked.push(b - a + 1); return many.map((l, i) => ({ blockNumber: '0x' + (a + (i % (b - a + 1))).toString(16) })); } };
  assert.deepEqual(await probe(busy, chain, '0xbusy', 100_000, 99_000), { firstLogBlock: 13_600, lookbackFrom: 13_600 });
  assert.deepEqual(asked, [FIRST_WINDOW], 'a busy address is answered from the first small window');
  // a quiet address on Base settings: 200, 1,600, 12,800, then the rest of the week in one call
  asked.length = 0;
  const quiet = { call: async (_m, [f]) => { asked.push(Number(f.toBlock) - Number(f.fromBlock) + 1); return []; } };
  assert.deepEqual(await probe(quiet, chain, '0xquiet', 100_000, 100_000), { firstLogBlock: 100_000, lookbackFrom: 13_600 });
  assert.deepEqual(asked, [200, 1600, 12_800, 71_800]);
});
