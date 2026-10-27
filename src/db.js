import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cursor (
  chain_id INTEGER PRIMARY KEY, next_block INTEGER NOT NULL, head INTEGER, updated_at INTEGER
);
-- every contract we have ever seen mint, so each one costs at most one historical getCode
CREATE TABLE IF NOT EXISTS contracts_seen (
  chain_id INTEGER NOT NULL, address TEXT NOT NULL, first_block INTEGER NOT NULL, born INTEGER,
  PRIMARY KEY (chain_id, address)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS tokens (
  chain_id INTEGER NOT NULL, address TEXT NOT NULL,
  birth_block INTEGER, birth_tx TEXT, birth_source TEXT,
  launchpad_id TEXT, confidence TEXT, factory TEXT, factory_label TEXT, event_sig TEXT, event_fields TEXT, family TEXT,
  code_size INTEGER, fp_kind TEXT, fp_key TEXT, fp_exact TEXT, impl TEXT, upgradeable INTEGER,
  name TEXT, symbol TEXT, decimals INTEGER, total_supply TEXT, is_lp INTEGER NOT NULL DEFAULT 0,
  tx_to TEXT, mint_to TEXT, v4_hook TEXT, platform TEXT,
  tx_from TEXT, claim_app TEXT, claim_check TEXT, premint TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, address)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS tokens_birth ON tokens (chain_id, birth_block DESC);
CREATE INDEX IF NOT EXISTS tokens_fp ON tokens (chain_id, fp_key);
CREATE INDEX IF NOT EXISTS tokens_factory ON tokens (chain_id, factory);
-- every lookup counts look-alike names, and silent-factory verdicts count what a maker made: without
-- these, both scanned the whole tokens table (36 ms per lookup at 91k tokens, growing with the index)
CREATE INDEX IF NOT EXISTS tokens_name ON tokens (chain_id, name, symbol);
CREATE INDEX IF NOT EXISTS tokens_maker ON tokens (chain_id, mint_to);
-- Birth evidence: every (emitter, topic0) that mentioned a token in its birth receipt, ~7 per token.
-- Stored as integer ids (a dictionary of addresses and topics) because the text form, with three
-- indexes each repeating 150 bytes of hex, was ~5.5 KB per token all in and filled a 0.5 GB volume
-- (2026-09-25). Read it through the birth_refs view below.
-- AUTOINCREMENT: an id is never handed out twice, even after a write that was rolled back.
CREATE TABLE IF NOT EXISTS ids (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS refs (
  chain_id INTEGER NOT NULL, token_id INTEGER NOT NULL, emitter_id INTEGER NOT NULL, topic_id INTEGER NOT NULL,
  log_index INTEGER, block INTEGER,
  PRIMARY KEY (chain_id, token_id, emitter_id, topic_id)
) WITHOUT ROWID;
-- Names differ from the old text table's indexes (refs_emitter_block, refs_block): index names are
-- global in SQLite, so reusing them would make these silently not exist until the next boot.
CREATE INDEX IF NOT EXISTS refs_by_emitter ON refs (chain_id, emitter_id, block);
CREATE INDEX IF NOT EXISTS refs_by_block ON refs (chain_id, block);
-- first sighting of an emitter, kept when old evidence is pruned so "first seen" never moves forward
CREATE TABLE IF NOT EXISTS emitter_first (
  chain_id INTEGER NOT NULL, emitter_id INTEGER NOT NULL, first_block INTEGER NOT NULL,
  PRIMARY KEY (chain_id, emitter_id)
) WITHOUT ROWID;
-- per-chain facts that must survive pruning:
--   index_start   the first block from which the index is complete
--   pruned_before birth evidence below this block has been deleted
CREATE TABLE IF NOT EXISTS meta (
  chain_id INTEGER NOT NULL, k TEXT NOT NULL, v INTEGER,
  PRIMARY KEY (chain_id, k)
) WITHOUT ROWID;
-- block ranges skipped by a long stall, replayed later for known launchpad events only
CREATE TABLE IF NOT EXISTS gaps (
  chain_id INTEGER NOT NULL, from_block INTEGER NOT NULL, to_block INTEGER NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, from_block)
) WITHOUT ROWID;
-- first on-chain activity of an announcing contract, found by an address-filtered getLogs lookback
-- quote tokens a known issuer created (Robinhood stock tokens), with the proof we checked
CREATE TABLE IF NOT EXISTS stock_tokens (
  chain_id INTEGER NOT NULL, address TEXT NOT NULL, issuer TEXT NOT NULL,
  symbol TEXT, name TEXT, block INTEGER NOT NULL, tx TEXT NOT NULL,
  beacon_ok INTEGER NOT NULL, seen_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, address)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS stock_tokens_block ON stock_tokens (chain_id, block DESC);
CREATE TABLE IF NOT EXISTS issuer_cursor (
  chain_id INTEGER NOT NULL, issuer TEXT NOT NULL, next_block INTEGER NOT NULL,
  PRIMARY KEY (chain_id, issuer)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS emitter_age (
  chain_id INTEGER NOT NULL, address TEXT NOT NULL, first_log_block INTEGER NOT NULL, lookback_from INTEGER NOT NULL, probed_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, address)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS emitters (
  chain_id INTEGER NOT NULL, address TEXT NOT NULL, code_size INTEGER, fp_key TEXT, checked_at INTEGER,
  PRIMARY KEY (chain_id, address)
) WITHOUT ROWID;
`;

const REFS_VIEW = `CREATE VIEW IF NOT EXISTS birth_refs AS
  SELECT r.chain_id AS chain_id, t.v AS token, e.v AS emitter, p.v AS topic0, r.log_index AS log_index, r.block AS block
  FROM refs r JOIN ids t ON t.id = r.token_id JOIN ids e ON e.id = r.emitter_id JOIN ids p ON p.id = r.topic_id`;

/**
 * Disk accounting for the database's volume. "Free" counts what SQLite can write into: free space on
 * the filesystem plus pages already inside the file that deleted rows left behind (SQLite reuses those
 * before it grows the file, so a prune frees room without the file ever shrinking).
 */
function makeStorage(db, file) {
  const mem = file === ':memory:';
  const size = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
  return {
    stats() {
      const pageSize = db.pragma('page_size', { simple: true });
      const freePages = db.pragma('freelist_count', { simple: true });
      const reusable = pageSize * freePages;
      if (mem) return { dbBytes: null, walBytes: null, volumeBytes: null, fsFreeBytes: null, reusableBytes: reusable, freeBytes: null };
      let volumeBytes = null, fsFreeBytes = null;
      try {
        const st = fs.statfsSync(path.dirname(path.resolve(file)));
        volumeBytes = st.blocks * st.bsize;
        fsFreeBytes = st.bavail * st.bsize;
      } catch { /* platform without statfs: report what we can */ }
      return {
        dbBytes: size(file), walBytes: size(file + '-wal'), volumeBytes, fsFreeBytes, reusableBytes: reusable,
        freeBytes: fsFreeBytes === null ? null : fsFreeBytes + reusable,
      };
    },
  };
}

/** True for SQLite / filesystem "out of space" errors. */
export const isDiskFull = (e) => e?.code === 'SQLITE_FULL' || e?.code === 'ENOSPC' || /database or disk is full|ENOSPC|no space left/i.test(String(e?.message ?? e));

export function openDb(file = process.env.DB_PATH || './data/factory.db') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  try {
    return setUp(db, file);
  } catch (e) {
    try { db.close(); } catch { /* already unusable */ } // a failed open must not leak the handle
    throw e;
  }
}

function setUp(db, file) {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  // databases created before these columns existed
  const have = new Set(db.prepare('PRAGMA table_info(tokens)').all().map((c) => c.name));
  for (const col of ['tx_to', 'mint_to', 'v4_hook', 'platform', 'tx_from', 'claim_app', 'claim_check', 'premint']) if (!have.has(col)) db.exec(`ALTER TABLE tokens ADD COLUMN ${col} TEXT`);
  // update-13 rows whose birth receipt still has to be read for sender and pre-mint: a small,
  // shrinking set, so the idle probe never walks the whole table to find it
  db.exec(`CREATE INDEX IF NOT EXISTS tokens_facts_pending ON tokens (chain_id, factory, birth_block)
    WHERE premint IS NULL AND tx_from IS NULL AND birth_tx IS NOT NULL AND platform IS NOT NULL`);

  // birth_refs used to be a text table. Move it into the id form when there is room; until then the
  // old table keeps serving reads (same columns as the view) and writes go to it.
  const legacyRefs = () => db.prepare("SELECT type FROM sqlite_master WHERE name = 'birth_refs'").get()?.type === 'table';
  const storage = makeStorage(db, file);
  const migration = { needed: legacyRefs(), lastError: null, lastTry: 0 };
  const checkpoint = () => {
    const [r] = db.pragma('wal_checkpoint(TRUNCATE)');
    if (r?.busy) throw new Error('WAL checkpoint could not complete');
  };
  /**
   * Copy the text table into the id form in batches of block windows, checkpointing after each, so
   * the WAL stays at one batch. The new tables grow the database file (the old table's pages are freed
   * only at the end), so the volume needs room for them: ~170 bytes per row, plus WAL and margin.
   * Safe to interrupt: the old table is dropped only after every row is copied (and counted), and a
   * new run skips what an earlier run already copied.
   */
  function migrateRefs({ force = false, batch = 100_000 } = {}) {
    if (!legacyRefs()) { migration.needed = false; return true; }
    migration.lastTry = Date.now();
    const rows = db.prepare('SELECT COUNT(*) AS n FROM birth_refs').get().n;
    const need = rows * 170 + 64 * 1024 * 1024;
    const s = storage.stats();
    if (!force && s.fsFreeBytes !== null && s.fsFreeBytes < need) {
      migration.lastError = `needs ~${Math.ceil(need / 1048576)} MB free on the volume, have ${Math.floor(s.fsFreeBytes / 1048576)} MB`;
      return false;
    }
    try {
      db.transaction(() => db.exec(`
        INSERT OR IGNORE INTO ids (v) SELECT token FROM birth_refs UNION SELECT emitter FROM birth_refs UNION SELECT topic0 FROM birth_refs;
        INSERT OR IGNORE INTO meta (chain_id, k, v) SELECT chain_id, 'index_start', MIN(block) FROM birth_refs GROUP BY chain_id;`))();
      checkpoint();
      const sel = `INSERT OR IGNORE INTO refs (chain_id, token_id, emitter_id, topic_id, log_index, block)
        SELECT b.chain_id, t.id, e.id, p.id, b.log_index, b.block FROM birth_refs b
        JOIN ids t ON t.v = b.token JOIN ids e ON e.v = b.emitter JOIN ids p ON p.v = b.topic0 WHERE b.chain_id = ?`;
      const copy = db.prepare(`${sel} AND b.block >= ? AND b.block < ?`);
      const copyNull = db.prepare(`${sel} AND b.block IS NULL`);
      const nth = db.prepare('SELECT block FROM birth_refs WHERE chain_id = ? AND block >= ? ORDER BY block LIMIT 1 OFFSET ?');
      for (const { c, lo, hi } of db.prepare('SELECT chain_id AS c, MIN(block) AS lo, MAX(block) AS hi FROM birth_refs GROUP BY chain_id').all()) {
        if (lo !== null) {
          for (let a = lo; a <= hi; ) {
            const upTo = Math.max(a + 1, nth.get(c, a, batch)?.block ?? hi + 1);
            db.transaction(() => copy.run(c, a, upTo))();
            checkpoint();
            a = upTo;
          }
        }
        copyNull.run(c);
      }
      const copied = db.prepare('SELECT COUNT(*) AS n FROM refs').get().n;
      if (copied < rows) throw new Error(`copied ${copied} of ${rows} evidence rows; the old table is kept`);
      db.transaction(() => { db.exec('DROP TABLE birth_refs'); db.exec(REFS_VIEW); })();
      checkpoint();
      migration.needed = false;
      migration.lastError = null;
      return true;
    } catch (e) {
      migration.needed = legacyRefs();
      migration.lastError = String(e?.message ?? e);
      return !migration.needed;
    }
  }
  if (migration.needed) migrateRefs();
  if (!legacyRefs()) db.exec(REFS_VIEW);

  const q = {
    getCursor: db.prepare('SELECT next_block, head, updated_at FROM cursor WHERE chain_id = ?'),
    setCursor: db.prepare(`INSERT INTO cursor (chain_id, next_block, head, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (chain_id) DO UPDATE SET next_block = excluded.next_block, head = excluded.head, updated_at = excluded.updated_at`),
    seen: db.prepare('SELECT 1 FROM contracts_seen WHERE chain_id = ? AND address = ?'),
    markSeen: db.prepare('INSERT OR IGNORE INTO contracts_seen (chain_id, address, first_block, born) VALUES (?, ?, ?, ?)'),
    getToken: db.prepare('SELECT * FROM tokens WHERE chain_id = ? AND address = ?'),
    putToken: db.prepare(`INSERT OR REPLACE INTO tokens (
        chain_id, address, birth_block, birth_tx, birth_source, launchpad_id, confidence, factory, factory_label,
        event_sig, event_fields, family, code_size, fp_kind, fp_key, fp_exact, impl, upgradeable,
        name, symbol, decimals, total_supply, is_lp, tx_to, mint_to, v4_hook, platform, tx_from, claim_app, claim_check, premint, created_at)
      VALUES (@chain_id, @address, @birth_block, @birth_tx, @birth_source, @launchpad_id, @confidence, @factory, @factory_label,
        @event_sig, @event_fields, @family, @code_size, @fp_kind, @fp_key, @fp_exact, @impl, @upgradeable,
        @name, @symbol, @decimals, @total_supply, @is_lp, @tx_to, @mint_to, @v4_hook, @platform, @tx_from, @claim_app, @claim_check, @premint, @created_at)`),
    // gaps left by a long stall: newest first, so the most recent launches come back first
    addGap: db.prepare('INSERT OR REPLACE INTO gaps (chain_id, from_block, to_block, created_at) VALUES (?, ?, ?, ?)'),
    newestGap: db.prepare('SELECT from_block, to_block FROM gaps WHERE chain_id = ? ORDER BY to_block DESC LIMIT 1'),
    setGapTo: db.prepare('UPDATE gaps SET to_block = ? WHERE chain_id = ? AND from_block = ?'),
    delGap: db.prepare('DELETE FROM gaps WHERE chain_id = ? AND from_block = ?'),
    gapStats: db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(to_block - from_block + 1), 0) AS blocks, MIN(from_block) AS first, MAX(to_block) AS last FROM gaps WHERE chain_id = ?'),
    getMeta: db.prepare('SELECT v FROM meta WHERE chain_id = ? AND k = ?'),
    setMetaOnce: db.prepare('INSERT OR IGNORE INTO meta (chain_id, k, v) VALUES (?, ?, ?)'),
    // only ever moves forward (index_start after a skipped range, pruned_before after a prune)
    raiseMeta: db.prepare(`INSERT INTO meta (chain_id, k, v) VALUES (?, ?, ?)
      ON CONFLICT (chain_id, k) DO UPDATE SET v = MAX(COALESCE(v, excluded.v), excluded.v)`),
    bornSinceBlock: db.prepare('SELECT COUNT(*) AS n FROM tokens WHERE chain_id = ? AND birth_block >= ?'),
    refsOf: db.prepare('SELECT emitter, topic0, log_index FROM birth_refs WHERE chain_id = ? AND token = ? ORDER BY log_index ASC'),
    recent: db.prepare(`SELECT * FROM tokens WHERE chain_id = ? AND is_lp = 0 AND birth_block IS NOT NULL
      ORDER BY birth_block DESC LIMIT ?`),
    recentUnlisted: db.prepare(`SELECT * FROM tokens WHERE chain_id = ? AND is_lp = 0 AND birth_block IS NOT NULL AND launchpad_id IS NULL
      ORDER BY birth_block DESC LIMIT ?`),
    cluster: db.prepare(`SELECT COALESCE(launchpad_id, '') AS launchpad_id, COUNT(*) AS n FROM tokens
      WHERE chain_id = ? AND fp_key = ? GROUP BY 1 ORDER BY n DESC`),
    factoryStats: db.prepare(`SELECT COUNT(*) AS births, MIN(birth_block) AS first_block, MAX(birth_block) AS last_block
      FROM tokens WHERE chain_id = ? AND factory = ?`),
    launchpadCounts: db.prepare(`SELECT launchpad_id, confidence, COUNT(*) AS n, MAX(birth_block) AS last_block
      FROM tokens WHERE chain_id = ? AND launchpad_id IS NOT NULL GROUP BY launchpad_id, confidence`),
    pairs: db.prepare(`SELECT r.emitter, r.topic0, COUNT(*) AS births,
        SUM(CASE WHEN t.launchpad_id IS NOT NULL THEN 1 ELSE 0 END) AS known_births,
        COUNT(DISTINCT t.launchpad_id) AS known_launchpads,
        MIN(r.block) AS first_block, MAX(r.block) AS last_block,
        (SELECT token FROM birth_refs s WHERE s.chain_id = r.chain_id AND s.emitter = r.emitter AND s.topic0 = r.topic0 ORDER BY s.block DESC LIMIT 1) AS sample_token,
        GROUP_CONCAT(DISTINCT t.launchpad_id) AS launchpads
      FROM birth_refs r JOIN tokens t ON t.chain_id = r.chain_id AND t.address = r.token
      WHERE r.chain_id = ? AND r.block >= ? AND t.is_lp = 0
      GROUP BY r.emitter, r.topic0 ORDER BY births DESC LIMIT ?`),
    getEmitter: db.prepare('SELECT * FROM emitters WHERE chain_id = ? AND address = ?'),
    // tokens attributed through a protocol event whose launching app has not been read yet
    platformPending: db.prepare(`SELECT address, factory, event_sig, tx_from, premint, total_supply FROM tokens WHERE chain_id = ? AND platform IS NULL AND factory = ? AND event_sig = ? ORDER BY birth_block DESC LIMIT ?`),
    setPlatform: db.prepare(`UPDATE tokens SET platform = ?, launchpad_id = ?, confidence = ?, factory_label = COALESCE(?, factory_label),
      claim_app = ?, claim_check = ? WHERE chain_id = ? AND address = ?`),
    // facts read later from the birth receipt (tokens indexed before these columns existed)
    setBirthFacts: db.prepare('UPDATE tokens SET tx_from = COALESCE(?, tx_from), premint = COALESCE(?, premint) WHERE chain_id = ? AND address = ?'),
    setClaim: db.prepare('UPDATE tokens SET launchpad_id = ?, confidence = ?, claim_app = ?, claim_check = ? WHERE chain_id = ? AND address = ?'),
    // Doppler-attributed rows whose birth receipt has not been read for these facts yet
    premintPending: db.prepare(`SELECT address, birth_tx, birth_block, factory, event_sig, platform, total_supply FROM tokens INDEXED BY tokens_facts_pending
      WHERE chain_id = ? AND premint IS NULL AND tx_from IS NULL AND birth_tx IS NOT NULL AND platform IS NOT NULL AND factory = ? AND birth_block >= ?
      ORDER BY birth_block DESC LIMIT ?`),
    // rows that carry a judged (or judgeable) claim of one integrator, for the boot-time re-judgement
    claimRows: db.prepare(`SELECT address, launchpad_id, confidence, tx_from, premint, total_supply, claim_app, claim_check FROM tokens INDEXED BY tokens_factory
      WHERE chain_id = ? AND factory = ? AND platform = ? AND (tx_from IS NOT NULL OR premint IS NOT NULL OR claim_check IS NOT NULL)`),
    getIssuerCursor: db.prepare('SELECT next_block FROM issuer_cursor WHERE chain_id = ? AND issuer = ?'),
    setIssuerCursor: db.prepare('INSERT OR REPLACE INTO issuer_cursor (chain_id, issuer, next_block) VALUES (?, ?, ?)'),
    putStock: db.prepare(`INSERT OR IGNORE INTO stock_tokens (chain_id, address, issuer, symbol, name, block, tx, beacon_ok, seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    // newest stock tokens with how many launches already use each one as their pair, and the first of them
    stocks: db.prepare(`SELECT s.*,
        (SELECT COUNT(*) FROM tokens t WHERE t.chain_id = s.chain_id AND json_extract(t.event_fields, '$.numeraire') = s.address) AS pairs,
        (SELECT t.address FROM tokens t WHERE t.chain_id = s.chain_id AND json_extract(t.event_fields, '$.numeraire') = s.address ORDER BY t.birth_block ASC LIMIT 1) AS first_address
      FROM stock_tokens s WHERE s.chain_id = ? AND s.beacon_ok = 1 ORDER BY s.block DESC LIMIT ?`),
    stockCount: db.prepare('SELECT COUNT(*) AS n, SUM(beacon_ok = 0) AS rejected FROM stock_tokens WHERE chain_id = ?'),
    getAge: db.prepare('SELECT first_log_block, lookback_from FROM emitter_age WHERE chain_id = ? AND address = ?'),
    putAge: db.prepare('INSERT OR REPLACE INTO emitter_age (chain_id, address, first_log_block, lookback_from, probed_at) VALUES (?, ?, ?, ?, ?)'),
    // serial announcers we have not dated yet, busiest first
    agePending: db.prepare(`SELECT emitter, MIN(first_block) AS first_block, SUM(births) AS births FROM (
        SELECT r.emitter AS emitter, MIN(r.block) AS first_block, COUNT(DISTINCT r.token) AS births FROM birth_refs r
          WHERE r.chain_id = @c AND r.block >= @s GROUP BY r.emitter
        UNION ALL
        -- silent factories: made tokens (called by the deployer / got the mint) without emitting anything
        SELECT t.mint_to AS emitter, MIN(t.birth_block), COUNT(*) FROM tokens t
          WHERE t.chain_id = @c AND t.birth_block >= @s AND t.mint_to IS NOT NULL AND t.mint_to = t.tx_to GROUP BY t.mint_to
      ) x WHERE NOT EXISTS (SELECT 1 FROM emitter_age a WHERE a.chain_id = @c AND a.address = x.emitter)
      GROUP BY emitter HAVING births >= 2 ORDER BY births DESC LIMIT @n`),
    // tokens a contract made: the deployer called it AND the first mint went to it
    madeBy: db.prepare(`SELECT COUNT(*) AS n, MIN(birth_block) AS first_block, MAX(birth_block) AS last_block FROM tokens INDEXED BY tokens_maker
      WHERE chain_id = ? AND mint_to = ? AND tx_to = ? AND birth_block >= ?`),
    madeByNames: db.prepare(`SELECT name, COUNT(*) AS n FROM tokens INDEXED BY tokens_maker WHERE chain_id = ? AND mint_to = ? AND tx_to = ? AND birth_block >= ?
      GROUP BY name ORDER BY n DESC LIMIT 5`),
    // the same name+symbol on other token contracts: the clearest counterfeit signal there is
    // INDEXED BY: without statistics the planner prefers the primary key and scans every token
    sameName: db.prepare(`SELECT COUNT(*) AS n FROM tokens INDEXED BY tokens_name WHERE chain_id = ? AND name = ? AND symbol = ? AND address != ? AND is_lp = 0`),
    silentMakers: db.prepare(`SELECT t.mint_to AS maker, COUNT(*) AS n, MIN(t.birth_block) AS first_block, MAX(t.birth_block) AS last_block,
        COUNT(DISTINCT t.fp_key) AS templates, COUNT(DISTINCT t.name) AS names
      FROM tokens t
      WHERE t.chain_id = ? AND t.birth_block >= ? AND t.is_lp = 0 AND t.launchpad_id IS NULL
        AND t.mint_to IS NOT NULL AND t.mint_to = t.tx_to
        AND NOT EXISTS (SELECT 1 FROM birth_refs r WHERE r.chain_id = t.chain_id AND r.token = t.address)
      GROUP BY t.mint_to HAVING n >= 2 ORDER BY n DESC LIMIT 300`),
    putEmitter: db.prepare('INSERT OR REPLACE INTO emitters (chain_id, address, code_size, fp_key, checked_at) VALUES (?, ?, ?, ?, ?)'),
    counts: db.prepare(`SELECT COUNT(*) AS tokens, SUM(launchpad_id IS NOT NULL) AS attributed FROM tokens WHERE chain_id = ? AND is_lp = 0`),
  };
  // Stronger evidence replaces weaker evidence; equal or weaker evidence only fills gaps.
  // look-alike-platform ranks with unverified-emitter: a protocol launch that claims an app it was not sent by
  const RANK = { verified: 5, 'observed-emitter': 4, 'code-match': 3, 'unverified-emitter': 2, 'look-alike-platform': 2, discovered: 1, none: 0 };
  const ATTRIBUTION = ['launchpad_id', 'confidence', 'factory', 'factory_label', 'event_sig', 'event_fields', 'family', 'platform', 'claim_app', 'claim_check', 'birth_block', 'birth_tx', 'birth_source'];
  const BLANK = { birth_block: null, birth_tx: null, birth_source: null, launchpad_id: null, confidence: 'none', factory: null,
    factory_label: null, event_sig: null, event_fields: null, family: null, code_size: null, fp_kind: null, fp_key: null,
    fp_exact: null, impl: null, upgradeable: null, name: null, symbol: null, decimals: null, total_supply: null, is_lp: 0,
    tx_to: null, mint_to: null, v4_hook: null, platform: null, tx_from: null, claim_app: null, claim_check: null, premint: null };

  function saveToken(row) {
    const old = q.getToken.get(row.chain_id, row.address);
    const next = { ...BLANK, ...(old ?? {}), created_at: old?.created_at ?? Math.floor(Date.now() / 1000) };
    const stronger = !old || (RANK[row.confidence] ?? 0) > (RANK[old.confidence] ?? 0);
    for (const [k, v] of Object.entries(row)) {
      if (v === undefined) continue;
      if (ATTRIBUTION.includes(k)) { if (stronger || next[k] === null) next[k] = v; }
      else if (v !== null) next[k] = v;
    }
    q.putToken.run(next);
    return next;
  }

  // ---- birth evidence writes (id form, or the legacy text table until it has been migrated) ----
  // No id cache: an id remembered from a write that was later rolled back (a full disk does that)
  // would point the next evidence row at the wrong address. The lookup is an indexed read.
  const idOf = db.prepare('SELECT id FROM ids WHERE v = ?').pluck();
  const putId = db.prepare('INSERT OR IGNORE INTO ids (v) VALUES (?)');
  const putRef = db.prepare('INSERT OR IGNORE INTO refs (chain_id, token_id, emitter_id, topic_id, log_index, block) VALUES (?, ?, ?, ?, ?, ?)');
  const id = (v) => {
    const n = idOf.get(v);
    if (n !== undefined) return n;
    const r = putId.run(v); // INSERT OR IGNORE: lastInsertRowid is stale when the row was ignored
    return r.changes ? Number(r.lastInsertRowid) : idOf.get(v);
  };
  // The pending-age list groups every birth in the stats window: on the compact tables it groups by
  // integer id and turns only the result rows back into addresses.
  const agePendingFast = db.prepare(`SELECT emitter, MIN(first_block) AS first_block, SUM(births) AS births FROM (
      SELECT e.v AS emitter, g.first_block, g.births FROM (
        SELECT emitter_id, MIN(block) AS first_block, COUNT(DISTINCT token_id) AS births FROM refs
          WHERE chain_id = @c AND block >= @s GROUP BY emitter_id HAVING births >= 1
      ) g JOIN ids e ON e.id = g.emitter_id
      UNION ALL
      SELECT t.mint_to AS emitter, MIN(t.birth_block), COUNT(*) FROM tokens t
        WHERE t.chain_id = @c AND t.birth_block >= @s AND t.mint_to IS NOT NULL AND t.mint_to = t.tx_to GROUP BY t.mint_to
    ) x WHERE NOT EXISTS (SELECT 1 FROM emitter_age a WHERE a.chain_id = @c AND a.address = x.emitter)
    GROUP BY emitter HAVING births >= 2 ORDER BY births DESC LIMIT @n`);
  const agePendingView = q.agePending;
  q.agePending = { all: (params) => (migration.needed ? agePendingView : agePendingFast).all(params) };

  let legacyPut = null;
  q.addRef = {
    run(chainId, token, emitter, topic0, logIndex, block) {
      if (migration.needed) {
        legacyPut ??= db.prepare('INSERT OR IGNORE INTO birth_refs (chain_id, token, emitter, topic0, log_index, block) VALUES (?, ?, ?, ?, ?, ?)');
        return legacyPut.run(chainId, token, emitter, topic0, logIndex, block);
      }
      q.setMetaOnce.run(chainId, 'index_start', block); // a no-op read once it is set
      return putRef.run(chainId, id(token), id(emitter), id(topic0), logIndex, block);
    },
  };

  /**
   * Delete birth evidence older than `beforeBlock`, oldest first, in batches. Tokens themselves are
   * never deleted: a token keeps its launchpad, factory, maker and fingerprint; only the list of
   * contracts that mentioned it in its birth receipt goes. Each emitter's first sighting is kept.
   * Returns the number of evidence rows removed.
   */
  function pruneRefs(chainId, beforeBlock, { batch = 50_000, maxBatches = 1_000 } = {}) {
    if (migration.needed) return 0; // the text table is migrated first; pruning it would cost more than it frees
    const start = db.prepare('SELECT MIN(block) AS b FROM refs WHERE chain_id = ?').get(chainId)?.b;
    if (start === null || start === undefined || start >= beforeBlock) return 0;
    q.setMetaOnce.run(chainId, 'index_start', start);
    const keepFirst = db.prepare(`INSERT INTO emitter_first (chain_id, emitter_id, first_block)
      SELECT chain_id, emitter_id, MIN(block) FROM refs WHERE chain_id = ? AND block < ? GROUP BY emitter_id
      ON CONFLICT (chain_id, emitter_id) DO UPDATE SET first_block = MIN(first_block, excluded.first_block)`);
    // refs is WITHOUT ROWID, so batches are block windows holding about `batch` rows each: small
    // transactions keep the WAL (which needs disk too) small while space is tight
    const lowest = db.prepare('SELECT MIN(block) AS b FROM refs WHERE chain_id = ? AND block < ?');
    const nth = db.prepare('SELECT block FROM refs WHERE chain_id = ? AND block >= ? AND block < ? ORDER BY block LIMIT 1 OFFSET ?');
    const del = db.prepare('DELETE FROM refs WHERE chain_id = ? AND block < ?');
    let removed = 0;
    for (let i = 0; i < maxBatches; i++) {
      const lo = lowest.get(chainId, beforeBlock)?.b;
      if (lo === null || lo === undefined) break;
      const hi = nth.get(chainId, lo, beforeBlock, batch)?.block ?? beforeBlock;
      const upTo = Math.max(lo + 1, Math.min(hi, beforeBlock));
      db.transaction(() => {
        keepFirst.run(chainId, upTo);
        removed += del.run(chainId, upTo).changes;
        q.raiseMeta.run(chainId, 'pruned_before', upTo);
      })();
      db.pragma('wal_checkpoint(PASSIVE)');
    }
    db.pragma('wal_checkpoint(TRUNCATE)');
    return removed;
  }

  return { db, q, saveToken, storage, migration, migrateRefs, pruneRefs };
}

/**
 * Undo the evidence migration so an older build (update-12 and before) can open the database again:
 * that code creates indexes on birth_refs and fails to boot when birth_refs is a view. Rebuilds the
 * text table with its three indexes from the compact tables, then drops those. The text form needs
 * ~0.75 KB per evidence row (about 5.5 KB per token), so check the volume has room. Run it with the
 * service stopped: scripts/rollback-evidence.mjs. Blocks skipped by a stall and not yet replayed are
 * kept in table `gaps`, which older builds ignore (they will not replay them).
 */
export function rollbackEvidence(file, { force = false } = {}) {
  const db = new Database(file);
  try {
    db.pragma('journal_mode = WAL');
    const type = db.prepare("SELECT type FROM sqlite_master WHERE name = 'birth_refs'").get()?.type;
    if (type === 'table') return { done: false, reason: 'birth_refs is already the text table: nothing to undo' };
    if (type !== 'view') return { done: false, reason: 'no birth_refs in this database' };
    const rows = db.prepare('SELECT COUNT(*) AS n FROM refs').get().n;
    const need = rows * 750 + 64 * 1024 * 1024;
    let free = null;
    try { const st = fs.statfsSync(path.dirname(path.resolve(file))); free = st.bavail * st.bsize; } catch { /* unknown */ }
    if (!force && free !== null && free < need) {
      return { done: false, reason: `needs ~${Math.ceil(need / 1048576)} MB free on the volume, have ${Math.floor(free / 1048576)} MB (grow it, or pass --force)` };
    }
    db.transaction(() => db.exec(`
      CREATE TABLE birth_refs_text (
        chain_id INTEGER NOT NULL, token TEXT NOT NULL, emitter TEXT NOT NULL, topic0 TEXT NOT NULL,
        log_index INTEGER, block INTEGER,
        PRIMARY KEY (chain_id, token, emitter, topic0)
      ) WITHOUT ROWID;
      INSERT INTO birth_refs_text (chain_id, token, emitter, topic0, log_index, block)
        SELECT chain_id, token, emitter, topic0, log_index, block FROM birth_refs;
      DROP VIEW birth_refs;
      ALTER TABLE birth_refs_text RENAME TO birth_refs;
      DROP TABLE refs;
      DROP TABLE ids;
      DROP TABLE emitter_first;
      CREATE INDEX IF NOT EXISTS refs_pair ON birth_refs (chain_id, emitter, topic0);
      CREATE INDEX IF NOT EXISTS refs_emitter_block ON birth_refs (chain_id, emitter, block);
      CREATE INDEX IF NOT EXISTS refs_block ON birth_refs (chain_id, block);`))();
    db.pragma('wal_checkpoint(TRUNCATE)');
    return { done: true, rows };
  } finally {
    db.close();
  }
}
