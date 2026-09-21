// Everything that differs between EVM chains lives here. The code paths are identical
// for every chain; only these numbers, the RPC URL and the launchpad registry change.
//
// Override per chain with env vars:  RPC_<id>, RPC_HEADERS_<id> (JSON), MIN_INTERVAL_MS_<id>,
// LOGS_CHUNK_<id>, STATE_WINDOW_<id> (0 = unlimited, use with an archive RPC), START_BLOCK_<id>.

const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';

const DEFAULTS = {
  4663: {
    id: 4663,
    slug: 'robinhood',
    name: 'Robinhood Chain',
    rpc: 'https://rpc.mainnet.chain.robinhood.com',
    blockTimeMs: 100,
    // Public RPC: HTTP 429 after ~5 requests / 2 s. 450 ms keeps us at ~4.4 req / 2 s.
    minIntervalMs: 450,
    logsChunk: 2000,        // block span per eth_getLogs
    logsSoftCap: 9500,      // treat a result this large as "possibly truncated" and split the range
    confirmations: 20,      // stay 2 s behind the sequencer head
    pollMs: 3000,
    // Public RPC serves historical state for a few thousand blocks only (measured: 3000 ok, 10000 not).
    // Discovery of unknown factories needs eth_getCode at block N-1, so it only runs inside this window.
    stateWindow: 2500,
    backfillBlocks: 6000,   // on first start, begin this many blocks behind head
    multicall3: MULTICALL3,
    // eth_getLogs filtered by one address accepts huge spans here (measured: 2,000,000 blocks)
    addrLogsSpan: 2_000_000,
    explorer: { kind: 'blockscout-pro', chainid: 4663, web: 'https://robinhoodchain.blockscout.com' },
  },
  8453: {
    id: 8453,
    slug: 'base',
    name: 'Base',
    rpc: 'https://mainnet.base.org',
    blockTimeMs: 2000,
    minIntervalMs: 350,
    logsChunk: 400,
    logsSoftCap: 9500,
    confirmations: 5,
    pollMs: 4000,
    stateWindow: 100,
    backfillBlocks: 300,
    multicall3: MULTICALL3,
    explorer: { kind: 'blockscout-pro', chainid: 8453, web: 'https://base.blockscout.com' },
  },
};

const num = (v, fallback) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? fallback : Number(v));

export function loadChains(env = process.env) {
  const ids = (env.CHAINS || '4663').split(',').map((s) => Number(s.trim())).filter(Boolean);
  const out = new Map();
  for (const id of ids) {
    const base = DEFAULTS[id];
    if (!base && !env[`RPC_${id}`]) {
      throw new Error(`Chain ${id} has no built-in defaults. Set RPC_${id} (and ideally the tuning vars) to add it.`);
    }
    const c = {
      // Conservative defaults for a chain we know nothing about.
      id, slug: String(id), name: `Chain ${id}`, blockTimeMs: 2000, minIntervalMs: 500, logsChunk: 500,
      logsSoftCap: 9500, confirmations: 10, pollMs: 5000, stateWindow: 100, backfillBlocks: 300,
      multicall3: MULTICALL3, explorer: { kind: 'blockscout-pro', chainid: id, web: null },
      ...base,
    };
    c.rpc = env[`RPC_${id}`] || c.rpc;
    c.rpcHeaders = env[`RPC_HEADERS_${id}`] ? JSON.parse(env[`RPC_HEADERS_${id}`]) : {};
    c.minIntervalMs = num(env[`MIN_INTERVAL_MS_${id}`], c.minIntervalMs);
    c.logsChunk = num(env[`LOGS_CHUNK_${id}`], c.logsChunk);
    c.stateWindow = num(env[`STATE_WINDOW_${id}`], c.stateWindow);
    c.startBlock = num(env[`START_BLOCK_${id}`], null);
    // Factory statistics (tokens announced, template purity) look at the last 3 days by default.
    c.statsWindowBlocks = num(env[`STATS_WINDOW_BLOCKS_${id}`], Math.round((3 * 86400 * 1000) / c.blockTimeMs));
    // A contract that emitted anything before we first saw it announce a token is not new.
    // We look this far back for its first log (default 7 days).
    c.addrLogsSpan = num(env[`ADDR_LOGS_SPAN_${id}`], c.addrLogsSpan ?? c.logsChunk);
    c.ageLookbackBlocks = num(env[`AGE_LOOKBACK_BLOCKS_${id}`], Math.round((7 * 86400 * 1000) / c.blockTimeMs));
    out.set(id, c);
  }
  if (out.size === 0) throw new Error('CHAINS is empty. Example: CHAINS=4663 or CHAINS=4663,8453');
  return out;
}
