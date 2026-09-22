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
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, address)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS tokens_birth ON tokens (chain_id, birth_block DESC);
CREATE INDEX IF NOT EXISTS tokens_fp ON tokens (chain_id, fp_key);
CREATE INDEX IF NOT EXISTS tokens_factory ON tokens (chain_id, factory);
CREATE TABLE IF NOT EXISTS birth_refs (
  chain_id INTEGER NOT NULL, token TEXT NOT NULL, emitter TEXT NOT NULL, topic0 TEXT NOT NULL,
  log_index INTEGER, block INTEGER,
  PRIMARY KEY (chain_id, token, emitter, topic0)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS refs_pair ON birth_refs (chain_id, emitter, topic0);
CREATE INDEX IF NOT EXISTS refs_emitter_block ON birth_refs (chain_id, emitter, block);
CREATE INDEX IF NOT EXISTS refs_block ON birth_refs (chain_id, block);
-- first on-chain activity of an announcing contract, found by an address-filtered getLogs lookback
CREATE TABLE IF NOT EXISTS emitter_age (
  chain_id INTEGER NOT NULL, address TEXT NOT NULL, first_log_block INTEGER NOT NULL, lookback_from INTEGER NOT NULL, probed_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, address)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS emitters (
  chain_id INTEGER NOT NULL, address TEXT NOT NULL, code_size INTEGER, fp_key TEXT, checked_at INTEGER,
  PRIMARY KEY (chain_id, address)
) WITHOUT ROWID;
`;

export function openDb(file = process.env.DB_PATH || './data/factory.db') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  // databases created before these columns existed
  const have = new Set(db.prepare('PRAGMA table_info(tokens)').all().map((c) => c.name));
  for (const col of ['tx_to', 'mint_to', 'v4_hook', 'platform']) if (!have.has(col)) db.exec(`ALTER TABLE tokens ADD COLUMN ${col} TEXT`);

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
        name, symbol, decimals, total_supply, is_lp, tx_to, mint_to, v4_hook, platform, created_at)
      VALUES (@chain_id, @address, @birth_block, @birth_tx, @birth_source, @launchpad_id, @confidence, @factory, @factory_label,
        @event_sig, @event_fields, @family, @code_size, @fp_kind, @fp_key, @fp_exact, @impl, @upgradeable,
        @name, @symbol, @decimals, @total_supply, @is_lp, @tx_to, @mint_to, @v4_hook, @platform, @created_at)`),
    addRef: db.prepare('INSERT OR IGNORE INTO birth_refs (chain_id, token, emitter, topic0, log_index, block) VALUES (?, ?, ?, ?, ?, ?)'),
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
    platformPending: db.prepare(`SELECT address, factory, event_sig FROM tokens WHERE chain_id = ? AND platform IS NULL AND factory = ? AND event_sig = ? ORDER BY birth_block DESC LIMIT ?`),
    setPlatform: db.prepare('UPDATE tokens SET platform = ?, launchpad_id = ?, confidence = ?, factory_label = COALESCE(?, factory_label) WHERE chain_id = ? AND address = ?'),
    getAge: db.prepare('SELECT first_log_block, lookback_from FROM emitter_age WHERE chain_id = ? AND address = ?'),
    putAge: db.prepare('INSERT OR REPLACE INTO emitter_age (chain_id, address, first_log_block, lookback_from, probed_at) VALUES (?, ?, ?, ?, ?)'),
    // serial announcers we have not dated yet, busiest first
    agePending: db.prepare(`SELECT r.emitter, MIN(r.block) AS first_block, COUNT(DISTINCT r.token) AS births FROM birth_refs r
      WHERE r.chain_id = ? AND r.block >= ? AND NOT EXISTS (SELECT 1 FROM emitter_age a WHERE a.chain_id = r.chain_id AND a.address = r.emitter)
      GROUP BY r.emitter HAVING births >= 2 ORDER BY births DESC LIMIT ?`),
    putEmitter: db.prepare('INSERT OR REPLACE INTO emitters (chain_id, address, code_size, fp_key, checked_at) VALUES (?, ?, ?, ?, ?)'),
    counts: db.prepare(`SELECT COUNT(*) AS tokens, SUM(launchpad_id IS NOT NULL) AS attributed FROM tokens WHERE chain_id = ? AND is_lp = 0`),
  };
  // Stronger evidence replaces weaker evidence; equal or weaker evidence only fills gaps.
  const RANK = { verified: 5, 'observed-emitter': 4, 'code-match': 3, 'unverified-emitter': 2, discovered: 1, none: 0 };
  const ATTRIBUTION = ['launchpad_id', 'confidence', 'factory', 'factory_label', 'event_sig', 'event_fields', 'family', 'platform', 'birth_block', 'birth_tx', 'birth_source'];
  const BLANK = { birth_block: null, birth_tx: null, birth_source: null, launchpad_id: null, confidence: 'none', factory: null,
    factory_label: null, event_sig: null, event_fields: null, family: null, code_size: null, fp_kind: null, fp_key: null,
    fp_exact: null, impl: null, upgradeable: null, name: null, symbol: null, decimals: null, total_supply: null, is_lp: 0,
    tx_to: null, mint_to: null, v4_hook: null, platform: null };

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

  return { db, q, saveToken };
}
