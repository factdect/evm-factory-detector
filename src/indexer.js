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
import { getLogsRange, hex, isStateUnavailable } from './rpc.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lc = (s) => s.toLowerCase();
const byPosition = (a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex);

export class Indexer {
  constructor({ chain, rpc, registry, store, log = console }) {
    Object.assign(this, { chain, rpc, registry, store, log });
    this.births = new BirthRecorder({ chain, rpc, registry, store, log });
    this.spanKnown = { span: chain.logsChunk, max: chain.logsChunk };
    this.spanMints = { span: chain.logsChunk, max: chain.logsChunk };
    this.receiptMisses = 0;
    this.status = { head: null, next: null, lag: null, lastRangeAt: null, lastError: null, discovery: null };
    this.stopped = false;
  }

  stop() { this.stopped = true; }

  async run() {
    const { chain, store } = this;
    while (!this.stopped) {
      try {
        const head = Number(await this.rpc.call('eth_blockNumber'));
        const target = head - chain.confirmations;
        let next = store.q.getCursor.get(chain.id)?.next_block ?? chain.startBlock ?? Math.max(0, target - chain.backfillBlocks);
        if (next > target) { this.#setStatus(head, next); await sleep(chain.pollMs); continue; }
        const to = Math.min(next + chain.logsChunk - 1, target);
        const stats = await this.processRange(next, to, head);
        this.receiptMisses = 0;
        store.q.setCursor.run(chain.id, to + 1, head, Math.floor(Date.now() / 1000));
        this.#setStatus(head, to + 1);
        this.status.lastError = null;
        // Caught up: do a slice of background work, then wait for blocks. On a 100 ms chain there
        // is always a new block by the time we loop, so "nothing to index" never happens and
        // cannot be the trigger for this.
        if (to === target) { await this.maintain(head); await sleep(chain.pollMs); }
        if (stats.known || stats.born) {
          this.log.info(`[${chain.slug}] ${next}-${to} known=${stats.known} born=${stats.born} checked=${stats.checked} lag=${head - to}`);
        }
      } catch (e) {
        if (e?.code === 'RECEIPT_PENDING') this.receiptMisses++;
        this.status.lastError = String(e?.message ?? e);
        this.log.warn(`[${chain.slug}] range failed, retrying in 5s: ${this.status.lastError}`);
        await sleep(5000);
      }
    }
  }

  /**
   * One small slice of background work per caught-up cycle: read the launching app for protocol
   * launches that lack it, and date one announcer by its first on-chain log. A probe that finds
   * nothing to do is skipped for a minute so an empty backlog costs no queries.
   */
  async maintain(head) {
    const { chain, store } = this;
    const now = Date.now();
    this.idleUntil ??= { platforms: 0, ages: 0, stocks: 0 };
    try {
      // new quote tokens first: this is the time-sensitive one
      if (now >= this.idleUntil.stocks && this.registry.quoteIssuers?.length) {
        const r = await scanIssuers({ chain, rpc: this.rpc, registry: this.registry, store, head, maxCalls: 4 });
        if (r.calls <= 1) this.idleUntil.stocks = now + 15_000; // caught up: look again in 15 s
        this.status.stocksFound = (this.status.stocksFound ?? 0) + r.found;
      }
      if (now >= this.idleUntil.platforms) {
        const n = await probePendingPlatforms({ chain, rpc: this.rpc, registry: this.registry, store, max: 24 });
        if (!n) this.idleUntil.platforms = now + 60_000;
        this.status.platformsResolved = (this.status.platformsResolved ?? 0) + n;
      }
      if (now >= this.idleUntil.ages) {
        const n = await probePendingAges({ chain, rpc: this.rpc, store, head, max: 1 });
        if (!n) this.idleUntil.ages = now + 60_000;
        this.status.agesProbed = (this.status.agesProbed ?? 0) + n;
      }
    } catch (e) {
      this.log.warn(`[${chain.slug}] background probe: ${e.message}`);
    }
  }

  #setStatus(head, next) {
    Object.assign(this.status, { head, next, lag: head - next, lastRangeAt: Date.now() });
  }

  /** Process [from, to]. Idempotent: safe to re-run the same range after a crash. */
  async processRange(from, to, head = to) {
    const { chain, rpc, registry, store } = this;
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
        const saved = await this.births.record(m.token, Number(log.blockNumber), log.transactionHash, 'registry-event', m, { requireReceipt: this.receiptMisses < 3 });
        if (saved) stats.known++;
      }
    }

    // ---- B. discovery ----------------------------------------------------------------
    // Only the part of the range whose N-1 state the node can still serve.
    const dFrom = chain.stateWindow === 0 ? from : Math.max(from, head - chain.stateWindow);
    this.status.discovery = dFrom <= to ? 'on' : 'paused (catching up, outside the historical-state window)';
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
      if (await this.births.record(c, block, log.transactionHash, 'discovery', null, { requireReceipt: this.receiptMisses < 3 })) stats.born++;
    }
    return stats;
  }
}
