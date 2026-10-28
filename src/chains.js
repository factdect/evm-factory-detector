// Everything that differs between EVM chains lives here. The code paths are identical
// for every chain; only these numbers, the RPC URL and the launchpad registry change.
//
// Override per chain with env vars:  RPC_<id>, RPC_HEADERS_<id> (JSON), MIN_INTERVAL_MS_<id>,
// LOGS_CHUNK_<id>, POLL_MS_<id>, STATE_WINDOW_<id> (0 = unlimited, use with an archive RPC), START_BLOCK_<id>,
// MAX_LAG_BLOCKS_<id> (0 = never jump ahead after a stall), ADDR_LOGS_SPAN_<id>,
// BIRTH_SCAN_WINDOWS_<id> (0 = a lookup never searches the birth of an unindexed protocol token).
// Global: BACKFILL=off (do not replay stall gaps), RETAIN_REFS_DAYS (0 = keep all birth evidence),
// MIN_FREE_MB (below this, the oldest birth evidence is pruned; default 150).

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
    // Address-filtered getLogs span. mainnet.base.org caps every getLogs at 200 blocks since
    // 2026-10-08 (2,000 before 10-05, 500 until 10-08); a stated cap is learned from the error, so
    // this stays at 2,000 for private RPCs that allow it.
    addrLogsSpan: 2000,
    // ~4,000 token births a day: date announcers over 2 days, not 7, to keep the probe cheap
    ageLookbackBlocks: 86_400,
    // Base-native B20 tokens (Beryl upgrade, 2026-07-08): their creation is a log of this precompile
    b20: { factory: '0xb20f000000000000000000000000000000000000', fromBlock: 48_300_000 },
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
    // how often the live loop asks for new blocks: every poll costs a few calls (head, known events,
    // fresh mints), which is what a metered RPC bills for
    c.pollMs = num(env[`POLL_MS_${id}`], c.pollMs);
    c.stateWindow = num(env[`STATE_WINDOW_${id}`], c.stateWindow);
    c.startBlock = num(env[`START_BLOCK_${id}`], null);
    // Factory statistics (tokens announced, template purity) look at the last 3 days by default.
    c.statsWindowBlocks = num(env[`STATS_WINDOW_BLOCKS_${id}`], Math.round((3 * 86400 * 1000) / c.blockTimeMs));
    // A contract that emitted anything before we first saw it announce a token is not new.
    // We look this far back for its first log (default 7 days).
    c.addrLogsSpan = num(env[`ADDR_LOGS_SPAN_${id}`], c.addrLogsSpan ?? c.logsChunk);
    c.ageLookbackBlocks = num(env[`AGE_LOOKBACK_BLOCKS_${id}`], c.ageLookbackBlocks ?? Math.round((7 * 86400 * 1000) / c.blockTimeMs));
    c.publicRpc = c.rpc === base?.rpc;
    // A lookup of a protocol token the index does not hold yet searches its birth this many
    // ADDR_LOGS_SPAN windows back (Robinhood Chain: 24 x 2,000,000 blocks = 55 days). Off on Base's
    // public RPC, which caps every getLogs at 200 blocks; with RPC_8453 set it covers 24 x 2,000 blocks.
    c.birthScanWindows = num(env[`BIRTH_SCAN_WINDOWS_${id}`], c.publicRpc && id === 8453 ? 0 : 24);
    // Further behind than this (default: 4 state windows, at least 30 minutes of blocks), live
    // indexing jumps ahead and the skipped blocks are replayed in the background.
    c.maxLagBlocks = num(env[`MAX_LAG_BLOCKS_${id}`], Math.max(c.stateWindow * 4, Math.round((30 * 60 * 1000) / c.blockTimeMs)));
    c.backfill = !/^(0|off|false|no)$/i.test(env.BACKFILL ?? '');
    c.retainRefsDays = num(env.RETAIN_REFS_DAYS, 0);
    c.minFreeBytes = num(env.MIN_FREE_MB, 150) * 1024 * 1024;
    out.set(id, c);
  }
  if (out.size === 0) throw new Error('CHAINS is empty. Example: CHAINS=4663 or CHAINS=4663,8453');
  return out;
}
