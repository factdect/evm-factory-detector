// How old is a contract, really? The index only knows when a contract first announced a token
// *while the index was running*. A launchpad that has been live for a month looks brand new to
// an index that started yesterday. One address-filtered eth_getLogs lookback settles it without
// tracing or archive state: any log before the first sighting means the contract is older.

import { hex, RpcError } from './rpc.js';

/**
 * First block in [head - lookback, beforeBlock) where `address` emitted a log, or `beforeBlock`
 * if there is none. Returns { firstLogBlock, lookbackFrom }. A range the node refuses because it
 * holds too many results is itself proof of activity, so its start is taken as the answer.
 */
export async function probeFirstLog(rpc, chain, address, head, beforeBlock) {
  const lookbackFrom = Math.max(0, head - chain.ageLookbackBlocks);
  const span = Math.max(1, chain.addrLogsSpan);
  for (let a = lookbackFrom; a < beforeBlock; a += span) {
    const b = Math.min(a + span - 1, beforeBlock - 1);
    let logs;
    try {
      logs = await rpc.call('eth_getLogs', [{ address, fromBlock: hex(a), toBlock: hex(b) }]);
    } catch (e) {
      if (e instanceof RpcError) return { firstLogBlock: a, lookbackFrom };
      throw e;
    }
    if (logs.length) return { firstLogBlock: Math.min(...logs.map((l) => Number(l.blockNumber))), lookbackFrom };
  }
  return { firstLogBlock: beforeBlock, lookbackFrom };
}

/** Date a few undated serial announcers. Cheap per call; the indexer runs it only when caught up. */
export async function probePendingAges({ chain, rpc, store, head, max = 2 }) {
  const since = Math.max(0, head - chain.statsWindowBlocks);
  let n = 0;
  for (const row of store.q.agePending.all(chain.id, since, max)) {
    const { firstLogBlock, lookbackFrom } = await probeFirstLog(rpc, chain, row.emitter, head, row.first_block);
    store.q.putAge.run(chain.id, row.emitter, firstLogBlock, lookbackFrom, Math.floor(Date.now() / 1000));
    n++;
  }
  return n;
}
