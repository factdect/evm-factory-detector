// Core indexer. Per block range it does two things:
//
//   A. Known launchpads  - one eth_getLogs filtered by the registry's creation-event topic0s
//                          (no address filter: factories rotate, so the topic is the anchor
//                          and the emitter allowlist is the verification).
//   B. Unknown factories - one eth_getLogs for ERC-20 mints (Transfer from 0x0). A contract
//                          whose code did not exist one block earlier was born here; its
//                          birth receipt tells us which contracts announced it.
//
// B needs historical state (getCode at N-1), which public RPCs keep for a short window,
// so it only runs close to head unless STATE_WINDOW_<id>=0 (archive RPC).

import { matchKnownEvent, TRANSFER_TOPIC, ZERO_TOPIC } from './attribution.js';
import { probePendingAges } from './age.js';
import { scanIssuers } from './stocks.js';
import { BirthRecorder, probePendingPlatforms } from './births.js';
import { isDiskFull } from './db.js';
import { getLogsRange, hex, isCallerRefusal, isStateUnavailable } from './rpc.js';

// unref: a background loop's wait must not keep the process (or a test run) alive
const sleep = (ms, unref = false) => new Promise((r) => { const t = setTimeout(r, ms); if (unref) t.unref?.(); });
const lc = (s) => s.toLowerCase();
const byPosition = (a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex);

export class Indexer {
  constructor({ chain, rpc, registry, store, log = console }) {
    Object.assign(this, { chain, rpc, registry, store, log });
    this.births = new BirthRecorder({ chain, rpc, registry, store, log });
    // Background work (stall replay, probes) uses the same rate budget in a lower lane: the live
    // loop's calls always go first, so live detection never waits behind a backlog.
    this.bgRpc = typeof rpc.background === 'function' ? rpc.background() : rpc;
    this.bgBirths = this.bgRpc === rpc ? this.births : new BirthRecorder({ chain, rpc: this.bgRpc, registry, store, log });
    this.spanKnown = { span: chain.logsChunk, max: chain.logsChunk };
    this.spanMints = { span: chain.logsChunk, max: chain.logsChunk };
    this.receiptMisses = 0;
    this.status = { head: null, next: null, lag: null, lastRangeAt: null, lastError: null, discovery: null,
      startedAt: Date.now(), lastProgressAt: null, errorSince: null, diskFull: false };
    this.stopped = false;
    this.retryMs = 5000;      // after an RPC / receipt failure
    this.diskWaitMs = 60_000; // after "database or disk is full": retrying faster cannot help
    this.bgPollMs = 1000;     // background loop, nothing to replay
    this.bgWaitMs = 5000;     // background loop, live indexing still catching up
  }

  stop() { this.stopped = true; }

  async run() {
    const { chain, store } = this;
    while (!this.stopped) {
      try {
        const head = Number(await this.rpc.call('eth_blockNumber'));
        // Head is recorded before any work, so a range that keeps failing shows its true lag.
        // (Before 2026-10, head froze with the failing range and /health said "19 blocks behind"
        // for 14 days while the volume was full.)
        Object.assign(this.status, { head, headAt: Date.now() });
        const target = head - chain.confirmations;
        const cursor = store.q.getCursor.get(chain.id);
        let next = cursor?.next_block ?? chain.startBlock ?? Math.max(0, target - chain.backfillBlocks);
        // first start: the index is complete from here (set before any jump, so a replayed gap counts)
        if (!cursor) store.q.setMetaOnce.run(chain.id, 'index_start', next);
        this.status.next = next;
        this.status.lag = head - next;
        next = this.#jumpIfFarBehind(next, target, head);
        if (next > target) { this.#setStatus(head, next); this.#progress(); await sleep(chain.pollMs); continue; }
        const to = Math.min(next + chain.logsChunk - 1, target);
        const stats = await this.processRange(next, to, head);
        this.receiptMisses = 0;
        store.q.setCursor.run(chain.id, to + 1, head, Math.floor(Date.now() / 1000));
        this.#setStatus(head, to + 1);
        this.#progress();
        // Caught up: wait for blocks. Background work runs in runBackground(), never in this loop:
        // when it ran here (before update-13), one slow probe held live detection for up to 97 s.
        if (to === target) await sleep(chain.pollMs);
        if (stats.known || stats.born) {
          this.log.info(`[${chain.slug}] ${next}-${to} known=${stats.known} born=${stats.born} checked=${stats.checked} lag=${head - to}`);
        }
      } catch (e) {
        if (e?.code === 'RECEIPT_PENDING') this.receiptMisses++;
        this.status.lastError = String(e?.message ?? e);
        this.status.errorSince ??= Date.now();
        if (isDiskFull(e)) {
          // Retrying every 5 s cannot help. Reclaim what we can, then wait for space.
          if (!this.status.diskFull) this.log.error(`[${chain.slug}] DISK FULL: indexing is paused. Grow the volume (see README, "Storage"). ${this.status.lastError}`);
          this.status.diskFull = true;
          try { this.reclaim('disk-full'); } catch (r) { this.log.warn(`[${chain.slug}] reclaim failed: ${r.message}`); }
          await sleep(this.diskWaitMs);
        } else {
          this.log.warn(`[${chain.slug}] range failed, retrying in ${this.retryMs / 1000}s: ${this.status.lastError}`);
          await sleep(this.retryMs);
        }
      }
    }
  }

  /**
   * After a long stall (or a long time switched off) the live cursor cannot afford to replay
   * everything in order: discovery only works within the node's historical-state window, and
   * replaying days of known launches first would keep the live feed dark for hours. So live
   * indexing resumes at the edge of the state window, and the skipped blocks are recorded as a
   * gap that runBackground() replays newest-first for known launchpad events.
   */
  #jumpIfFarBehind(next, target, head) {
    const { chain, store } = this;
    if (!(chain.maxLagBlocks > 0) || target - next <= chain.maxLagBlocks) return next;
    const resume = Math.max(next, target - chain.stateWindow);
    if (resume <= next) return next; // MAX_LAG_BLOCKS below the state window: nothing to skip
    const now = Math.floor(Date.now() / 1000);
    store.db.transaction(() => {
      if (chain.backfill) store.q.addGap.run(chain.id, next, resume - 1, now);
      // not replayed: the index is only complete from where live indexing resumes
      else store.q.raiseMeta.run(chain.id, 'index_start', resume);
      store.q.setCursor.run(chain.id, resume, head, now);
    })();
    this.log.warn(`[${chain.slug}] ${target - next} blocks behind: live indexing resumes at ${resume}; ` +
      (chain.backfill ? `blocks ${next}-${resume - 1} are queued for a known-launchpad replay` : 'the skipped blocks are not replayed (BACKFILL=off)'));
    this.status.next = resume;
    this.status.lag = head - resume;
    return resume;
  }

  #progress() {
    Object.assign(this.status, { lastProgressAt: Date.now(), lastError: null, errorSince: null, diskFull: false });
  }

  /**
   * Make room: flush the WAL into the database file, then, if room is short, prune the oldest birth
   * evidence (never tokens). Called when the disk is full and by the housekeeping timer in main.js.
   */
  reclaim(reason = 'low-space') {
    const { chain, store } = this;
    try { store.db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
    const head = this.status.head ?? store.q.getCursor.get(chain.id)?.head ?? null;
    if (head === null) return 0;
    const s = store.storage.stats();
    const blocksPerDay = Math.round((86400 * 1000) / chain.blockTimeMs);
    // never inside the stats window (+1 day): candidates and the age probe read that evidence
    const floor = Math.max(chain.statsWindowBlocks + blocksPerDay, 4 * blocksPerDay);
    const diskFull = reason === 'disk-full';
    // Room SQLite can write into (free disk + pages freed inside the file) is short. Low free disk
    // alone is not helped by pruning (freed pages stay inside the file); /health reports that case.
    const low = s.freeBytes !== null && s.freeBytes < chain.minFreeBytes;
    // while space is short every write needs WAL room too: delete in small steps
    const opts = diskFull ? { batch: 2_000, maxBatches: 500 } : low ? { batch: 5_000, maxBatches: 400 } : undefined;
    let pruned = 0;
    if (chain.retainRefsDays > 0) pruned += store.pruneRefs(chain.id, head - Math.max(floor, chain.retainRefsDays * blocksPerDay), opts);
    if (low || diskFull) pruned += store.pruneRefs(chain.id, head - floor, opts);
    if (pruned) this.log.warn(`[${chain.slug}] storage (${reason}): pruned ${pruned} old birth-evidence rows`);
    this.status.storagePruned = (this.status.storagePruned ?? 0) + pruned;
    return pruned;
  }

  /**
   * One small slice of background work, run by runBackground() while live indexing is caught up:
   * look for new stock tokens, read the launching app for protocol launches that lack it, and date
   * one announcer by its first on-chain log. A job that finds nothing to do, or fails, is skipped
   * for a while, so an empty backlog costs no queries and a rate-limited node is not hammered.
   */
  async maintain(head) {
    const { chain, store } = this;
    const now = Date.now();
    this.idleUntil ??= { platforms: 0, ages: 0, stocks: 0 };
    this.status.jobMs ??= {};
    const rpc = this.bgRpc;
    const job = async (name, fn) => {
      if (now < this.idleUntil[name]) return;
      const t0 = Date.now();
      try { await fn(); } catch (e) {
        this.idleUntil[name] = now + 60_000;
        this.log.warn(`[${chain.slug}] background ${name}: ${e.message}`);
      }
      this.status.jobMs[name] = Date.now() - t0;
    };
    // new quote tokens first: this is the time-sensitive one
    if (this.registry.quoteIssuers?.length) {
      await job('stocks', async () => {
        const r = await scanIssuers({ chain, rpc, registry: this.registry, store, head, maxCalls: 4 });
        if (r.calls <= 1) this.idleUntil.stocks = now + 15_000; // caught up: look again in 15 s
        this.status.stocksFound = (this.status.stocksFound ?? 0) + r.found;
      });
    }
    await job('platforms', async () => {
      const n = await probePendingPlatforms({ chain, rpc, registry: this.registry, store, max: 24 });
      if (!n) this.idleUntil.platforms = now + 60_000;
      this.status.platformsResolved = (this.status.platformsResolved ?? 0) + n;
    });
    await job('ages', async () => {
      // the pending list is costly to compute: refresh it every 5 minutes, probe one per cycle
      if (!this.ageQueue?.length || now > this.ageQueueAt + 300_000) {
        this.ageQueue = store.q.agePending.all({ c: chain.id, s: Math.max(0, head - chain.statsWindowBlocks), n: 50 });
        this.ageQueueAt = now;
      }
      const rows = this.ageQueue.splice(0, 1);
      const n = rows.length ? await probePendingAges({ chain, rpc, store, head, rows }) : 0;
      if (!n && !this.ageQueue.length) this.idleUntil.ages = now + 60_000;
      this.status.agesProbed = (this.status.agesProbed ?? 0) + n;
    });
  }

  /**
   * Everything that is not live indexing, in its own loop beside run(): new stock tokens, launching
   * apps of protocol launches, announcer ages, and the replay of stall gaps. (Storage housekeeping
   * has its own timer in main.js: it must run even while a chain is catching up.)
   * It runs only while the live loop is caught up (after a deploy, live catch-up goes first), and
   * its RPC calls use the background lane, so the live loop never waits for it.
   */
  async runBackground() {
    const { chain } = this;
    const nearHead = chain.confirmations + Math.round(10_000 / chain.blockTimeMs);
    while (!this.stopped) {
      let worked = false;
      const live = this.status.lastProgressAt !== null && this.status.lag !== null && this.status.lag <= nearHead;
      if (live && this.status.head !== null) {
        const t0 = Date.now();
        await this.maintain(this.status.head);
        this.status.lastMaintainMs = Date.now() - t0;
        if (chain.backfill) {
          try { worked = await this.backfillOnce(this.status.head); } catch (e) {
            this.log.warn(`[${chain.slug}] backfill: ${e.message}`);
            await sleep(this.retryMs, true);
          }
        }
      }
      await sleep(worked ? 50 : live ? this.bgPollMs : this.bgWaitMs, true);
    }
  }

  /** Replay the newest chunk of the newest gap. Returns false when there is no gap. */
  async backfillOnce(head) {
    const { chain, store } = this;
    const g = store.q.newestGap.get(chain.id);
    if (!g) return false;
    // Outside the state window, so known launchpad events only. Chunks are sized to take a few seconds.
    this.backfillSpan ??= Math.max(1, Math.round(chain.logsChunk / 10));
    const b = g.to_block, a = Math.max(g.from_block, b - this.backfillSpan + 1);
    const t0 = Date.now();
    let stats;
    try {
      stats = await this.processRange(a, b, head, { live: false });
      this.replayFailures = null;
    } catch (e) {
      // A chunk that keeps failing for a reason of its own must not block the rest of the replay
      // forever. A full disk or a rate-limited node is not such a reason: those just wait.
      if (isDiskFull(e) || isCallerRefusal(e)) throw e;
      const k = `${a}-${b}`;
      this.replayFailures = this.replayFailures?.k === k ? { k, n: this.replayFailures.n + 1 } : { k, n: 1 };
      if (this.replayFailures.n < 10) throw e;
      this.log.warn(`[${chain.slug}] replay: skipping blocks ${a}-${b} after 10 failures: ${e.message}`);
      this.status.replaySkippedBlocks = (this.status.replaySkippedBlocks ?? 0) + (b - a + 1);
      store.q.raiseMeta.run(chain.id, 'index_start', b + 1); // launches in the skipped blocks are unknown
      this.replayFailures = null;
      stats = { known: 0 };
    }
    const took = Date.now() - t0;
    if (took > 8000) this.backfillSpan = Math.max(1, Math.floor(this.backfillSpan / 2));
    else if (took < 3000) this.backfillSpan = Math.min(chain.logsChunk, Math.ceil(this.backfillSpan * 1.5));
    if (a <= g.from_block) store.q.delGap.run(chain.id, g.from_block); else store.q.setGapTo.run(a - 1, chain.id, g.from_block);
    // replay speed over this process's lifetime, for the ETA in /health
    const r = (this.status.replay ??= { since: t0, blocks: 0 });
    r.blocks += b - a + 1;
    this.status.backfilled = (this.status.backfilled ?? 0) + stats.known;
    return true;
  }

  #setStatus(head, next) {
    Object.assign(this.status, { head, next, lag: head - next, lastRangeAt: Date.now() });
  }

  /** Process [from, to]. Idempotent: safe to re-run the same range after a crash. */
  async processRange(from, to, head = to, { live = true } = {}) {
    const { chain, registry, store } = this;
    const rpc = live ? this.rpc : this.bgRpc;
    const births = live ? this.births : this.bgBirths;
    const stats = { known: 0, born: 0, checked: 0 };
    const handled = new Set();

    // ---- A. creation events of known launchpads -------------------------------------
    if (registry.topic0s.length) {
      const logs = await getLogsRange(rpc, { topics: [registry.topic0s] }, from, to, this.spanKnown, chain.logsSoftCap);
      for (const log of logs.sort(byPosition)) {
        const m = matchKnownEvent(registry, log);
        if (!m || handled.has(m.token)) continue;
        handled.add(m.token);
        if (store.q.getToken.get(chain.id, m.token)?.launchpad_id) continue; // already attributed (re-run of a range)
        const saved = await births.record(m.token, Number(log.blockNumber), log.transactionHash, 'registry-event', m, { requireReceipt: this.receiptMisses < 3 });
        if (saved) stats.known++;
      }
    }

    // ---- B. discovery ----------------------------------------------------------------
    // Only the part of the range whose N-1 state the node can still serve.
    const dFrom = chain.stateWindow === 0 ? from : Math.max(from, head - chain.stateWindow);
    if (live) this.status.discovery = dFrom <= to ? 'on' : 'paused (catching up, outside the historical-state window)';
    if (dFrom > to) return stats;

    const mints = await getLogsRange(rpc, { topics: [TRANSFER_TOPIC, ZERO_TOPIC] }, dFrom, to, this.spanMints, chain.logsSoftCap);
    const first = new Map(); // contract -> its first mint log in this range
    for (const log of mints.sort(byPosition)) {
      if (log.topics.length !== 3) continue; // 4 topics = ERC-721, not a fungible launch
      const c = lc(log.address);
      if (!first.has(c)) first.set(c, log);
    }
    const fresh = [...first.entries()].filter(([c]) => !handled.has(c) && !store.q.seen.get(chain.id, c) && !store.q.getToken.get(chain.id, c));
    stats.checked = fresh.length;

    // Was the contract already there one block before its first mint?
    const probes = await rpc.batch(fresh.map(([c, log]) => ({ method: 'eth_getCode', params: [c, hex(Number(log.blockNumber) - 1)] })));
    for (let i = 0; i < fresh.length; i++) {
      const [c, log] = fresh[i];
      const block = Number(log.blockNumber);
      const p = probes[i];
      if (p.error) {
        // Seen now, so any later mint is by definition not its birth. Unknown provenance.
        if (isStateUnavailable(p.error)) { store.q.markSeen.run(chain.id, c, block, null); continue; }
        throw new Error(`eth_getCode(${c}@${block - 1}): ${p.error.message}`);
      }
      const born = p.result === '0x';
      store.q.markSeen.run(chain.id, c, block, born ? 1 : 0);
      if (!born) continue;
      if (await births.record(c, block, log.transactionHash, 'discovery', null, { requireReceipt: this.receiptMisses < 3 })) stats.born++;
    }
    return stats;
  }
}
