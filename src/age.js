// How old is a contract, really? The index only knows when a contract first announced a token
// *while the index was running*. A launchpad that has been live for a month looks brand new to
// an index that started yesterday. One address-filtered eth_getLogs lookback settles it without
// tracing or archive state: any log before the first sighting means the contract is older.

import { hex, isCallerRefusal, rangeCapFrom, RpcError } from './rpc.js';

// A block-range cap a node stated to this probe. Kept here, per chain, so that learning it never
// shrinks `chain.addrLogsSpan`, which other features (the birth scan of a lookup) size their work by.
const learnedCap = new Map();
/** The span this probe asks for on a chain: the configured one, or a cap the node stated. */
export const probeSpan = (chain) => Math.max(1, Math.min(chain.addrLogsSpan, learnedCap.get(chain.id) ?? Infinity));

/**
 * First block in [head - lookback, beforeBlock) where `address` emitted a log, or `beforeBlock`
 * if there is none. Returns { firstLogBlock, lookbackFrom }. A range the node refuses because it
 * holds too many results is itself proof of activity, so its start is taken as the answer.
 */
export async function probeFirstLog(rpc, chain, address, head, beforeBlock) {
  const lookbackFrom = Math.max(0, head - chain.ageLookbackBlocks);
  // A range the node cannot serve is itself proof of heavy activity. Nodes say so in different ways:
  // a JSON-RPC error ("more than 10000 results") or, on Base, a bare HTTP 5xx. Split the range and
  // retry; a range that still fails at 50 blocks counts as activity at its start.
  // Two failures are NOT activity, and must never date a contract:
  //   - a stated block-range cap ("limited to a 200 range"): we asked too much, so re-ask in smaller pieces
  //   - rate limiting or quota (HTTP 429, "request limit reached", "capacity limit exceeded"):
  //     the node said nothing about the contract
  const firstIn = async (a, b) => {
    try {
      const logs = await rpc.call('eth_getLogs', [{ address, fromBlock: hex(a), toBlock: hex(b) }]);
      return logs.length ? Math.min(...logs.map((l) => Number(l.blockNumber))) : null;
    } catch (e) {
      if (isCallerRefusal(e)) throw e; // rate limit / quota: retried later; a guess here would be a false "old"
      const cap = rangeCapFrom(e);
      if (cap && cap < b - a + 1) {
        learnedCap.set(chain.id, Math.min(cap, learnedCap.get(chain.id) ?? Infinity)); // for the rest of this process
        for (let x = a; x <= b; x += cap) {
          const found = await firstIn(x, Math.min(x + cap - 1, b));
          if (found !== null) return found;
        }
        return null;
      }
      const heavy = e instanceof RpcError || e?.retryable || /HTTP 5\d\d/.test(e?.message ?? '');
      if (!heavy) throw e;
      if (b - a < 50) return a;
      // (a node's hint of the range it could serve is not used here: for the busiest addresses it
      // would walk the whole lookback in small pieces, while halving reaches "active at a" in O(log))
      const mid = a + Math.floor((b - a) / 2);
      return (await firstIn(a, mid)) ?? (await firstIn(mid + 1, b));
    }
  };
  for (let a = lookbackFrom; a < beforeBlock; ) {
    const span = probeSpan(chain); // re-read: a stated cap shrinks it mid-probe
    const b = Math.min(a + span - 1, beforeBlock - 1);
    const found = await firstIn(a, b);
    if (found !== null) return { firstLogBlock: found, lookbackFrom };
    a = b + 1;
  }
  return { firstLogBlock: beforeBlock, lookbackFrom };
}

/**
 * Date a few undated serial announcers. Cheap per call; the indexer runs it only when caught up.
 * `rows` lets the caller pass a cached slice of the pending list: finding it means grouping every
 * birth in the stats window (~1 s at 100k tokens), which is too slow to repeat every cycle.
 */
export async function probePendingAges({ chain, rpc, store, head, max = 2, rows = null }) {
  const since = Math.max(0, head - chain.statsWindowBlocks);
  let n = 0;
  for (const row of rows ?? store.q.agePending.all({ c: chain.id, s: since, n: max })) {
    if (store.q.getAge.get(chain.id, row.emitter)) continue; // dated since the list was cached
    const { firstLogBlock, lookbackFrom } = await probeFirstLog(rpc, chain, row.emitter, head, row.first_block);
    store.q.putAge.run(chain.id, row.emitter, firstLogBlock, lookbackFrom, Math.floor(Date.now() / 1000));
    n++;
  }
  return n;
}
