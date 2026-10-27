// Turns index rows into the public JSON. The lookup page renders exactly this JSON.
import { claimPlacement, INFRA_ADDRESSES, INFRA_TOPICS, judgeClaim, matchKnownEvent, parseClaim, platformCall, premintFacts, resolvePlatform, senderCodeCall, TRANSFER_TOPIC, ZERO_TOPIC } from './attribution.js';
import { BirthRecorder } from './births.js';
import { enrichToken, fpColumns } from './enrich.js';
import { findCreation } from './explorer.js';
import { getLogsRange, hex } from './rpc.js';

// below this much free disk (not counting pages reusable inside the file), writes that grow a file fail soon
const MIN_FS_FREE_BYTES = 64 * 1024 * 1024;

const VERDICTS = {
  verified: ['Verified factory', 'A creation event from an address the launchpad publishes as its factory names this token.'],
  'observed-emitter': ['Observed factory', 'The creation event comes from a factory we identified on-chain. The launchpad has not published this address.'],
  'code-match': ['Same code, unlisted address', 'The emitter runs the same program as a listed factory but sits at an address nobody has published. It can be a new generation or a third-party redeploy.'],
  'protocol-verified': ['Verified protocol, unlisted app', 'Created through the canonical contract of a permissionless launch protocol, by an app (integrator) that is not in the registry. The protocol part is certain; which app launched it is not a known one.'],
  'observed-platform': ['Observed launchpad', 'Created through a launch protocol by an integrator we identified on-chain as this launchpad. The launchpad has not published this address.'],
  'unverified-emitter': ['Look-alike event', 'The event signature matches a known launchpad, but the emitter is not one of its published factories. Several launchpads share signatures and anyone can emit one.'],
  'look-alike-platform': ['Claims a launchpad it was not launched by', 'Created through a permissionless launch protocol with the integrator field set to a known launchpad, but what it minted at birth is something that launchpad\'s launch flow does not produce (or, for a launchpad with no published policy, it was not sent by that launchpad\'s wallets). The integrator field is self-declared calldata: anyone can write another app\'s address there, and terminals that read only that field show the token as that app\'s. This is a direct protocol launch wearing the label.'],
  discovered: ['Unlisted factory', 'No launchpad in the registry claims this token. A contract that has announced several tokens of one template did, which is what a factory looks like.'],
  'discovered-first': ['First sighting', 'The contract that announced this token has announced no other token in this index. A one-off deployer and a brand-new factory look identical until the second token.'],
  'silent-factory': ['Unlisted silent factory', 'A contract the deployer called created and received this token, and has created other tokens the same way, without ever emitting a creation event. A factory that stays quiet is not in any launchpad registry.'],
  'discovered-silent': ['No factory event', 'The contract appeared and minted in one transaction, and no other contract announced it. Deployed directly, or by a factory that emits nothing.'],
  'evidence-pruned': ['Unlisted, evidence pruned', 'No launchpad in the registry claims this token. The list of contracts that announced it at birth was deleted to save space (old birth evidence is pruned when the volume runs low), so who made it cannot be shown any more. The birth transaction below still can be checked by hand.'],
  'bytecode-cluster': ['Bytecode match only', 'The birth transaction is not indexed. The bytecode matches a template used by a known launchpad, which shows the template, not who deployed it.'],
  none: ['No birth record', 'This index holds no birth transaction for the token, and no launch protocol has an on-chain record of it either: it was deployed directly, or by a factory this registry does not know. With an explorer key configured, older tokens are traced on demand.'],
};

class TtlCache {
  constructor(ttlMs, max) { Object.assign(this, { ttlMs, max, m: new Map() }); }
  get(k) { const e = this.m.get(k); if (!e) return undefined; if (e.t < Date.now()) { this.m.delete(k); return undefined; } return e.v; }
  set(k, v) { if (this.m.size >= this.max) this.m.delete(this.m.keys().next().value); this.m.set(k, { v, t: Date.now() + this.ttlMs }); return v; }
}

export class Lookup {
  constructor({ chains, rpcs, registries, store, indexers = new Map() }) {
    Object.assign(this, { chains, rpcs, registries, store, indexers });
    this.emitterCache = new TtlCache(60_000, 5000);
    this.adhocCache = new TtlCache(60_000, 5000); // short: a token looked up seconds after launch gets indexed moments later
    this.listCache = new TtlCache(30_000, 2000);
    this.countCache = new TtlCache(10_000, 32);
    this.inflight = new Map();
    // protocol tokens whose birth a scan did not find, and rows whose birth receipt the node did not
    // return: do not ask again on every lookup
    this.birthMiss = new TtlCache(30 * 60_000, 5000);
    this.factsMiss = new TtlCache(10 * 60_000, 5000);
    const db = store.db;
    this.sql = {
      // first sighting over all time (index-only MIN), activity over the stats window
      // pruned evidence leaves its first sighting in emitter_first, so "first seen" never moves forward
      emitterFirst: db.prepare(`SELECT MIN(b) AS first_block FROM (
          SELECT f.first_block AS b FROM emitter_first f JOIN ids e ON e.id = f.emitter_id WHERE f.chain_id = @c AND e.v = @e
          UNION ALL SELECT MIN(block) FROM birth_refs WHERE chain_id = @c AND emitter = @e)`),
      emitterStats: db.prepare(`SELECT COUNT(DISTINCT token) AS births, MAX(block) AS last_block
        FROM birth_refs WHERE chain_id = ? AND emitter = ? AND block >= ?`),
      emitterTopCluster: db.prepare(`SELECT t.fp_key, COUNT(DISTINCT r.token) AS n FROM birth_refs r
        JOIN tokens t ON t.chain_id = r.chain_id AND t.address = r.token
        WHERE r.chain_id = ? AND r.emitter = ? AND r.block >= ? GROUP BY t.fp_key ORDER BY n DESC LIMIT 1`),
      emitters: db.prepare(`SELECT r.emitter, COUNT(DISTINCT r.token) AS births,
          COUNT(DISTINCT CASE WHEN t.launchpad_id IS NOT NULL THEN r.token END) AS known_births,
          COUNT(DISTINCT t.launchpad_id) AS known_launchpads, GROUP_CONCAT(DISTINCT t.launchpad_id) AS launchpads,
          COUNT(DISTINCT r.topic0) AS event_types, MIN(r.block) AS first_block, MAX(r.block) AS last_block
        FROM birth_refs r JOIN tokens t ON t.chain_id = r.chain_id AND t.address = r.token
        WHERE r.chain_id = ? AND r.block >= ? AND t.is_lp = 0 GROUP BY r.emitter HAVING births >= 2 ORDER BY births DESC LIMIT 1500`),
      oneEmitter: db.prepare(`SELECT r.emitter, COUNT(DISTINCT r.token) AS births,
          COUNT(DISTINCT CASE WHEN t.launchpad_id IS NOT NULL THEN r.token END) AS known_births,
          COUNT(DISTINCT t.launchpad_id) AS known_launchpads, GROUP_CONCAT(DISTINCT t.launchpad_id) AS launchpads,
          COUNT(DISTINCT r.topic0) AS event_types, MIN(r.block) AS first_block, MAX(r.block) AS last_block
        FROM birth_refs r JOIN tokens t ON t.chain_id = r.chain_id AND t.address = r.token
        WHERE r.chain_id = ? AND r.block >= ? AND r.emitter = ?`),
      emitterTokens: db.prepare('SELECT DISTINCT token FROM birth_refs WHERE chain_id = ? AND emitter = ? AND block >= ?'),
      // of this emitter's tokens that carry birth facts: how many it served as pool hook, and how many it made
      emitterRoles: db.prepare(`SELECT COUNT(DISTINCT CASE WHEN t.tx_to IS NOT NULL OR t.mint_to IS NOT NULL THEN t.address END) AS with_facts,
          COUNT(DISTINCT CASE WHEN t.v4_hook = r.emitter THEN t.address END) AS as_hook
        FROM birth_refs r JOIN tokens t ON t.chain_id = r.chain_id AND t.address = r.token
        WHERE r.chain_id = ? AND r.emitter = ? AND r.block >= ?`),
      // the first block the index ever covered; recorded before any prune, so pruning cannot move it
      indexStart: db.prepare(`SELECT COALESCE((SELECT v FROM meta WHERE chain_id = @c AND k = 'index_start'),
          (SELECT MIN(block) FROM birth_refs WHERE chain_id = @c)) AS b`),
      emitterTopics: db.prepare(`SELECT topic0, COUNT(*) AS n FROM birth_refs WHERE chain_id = ? AND emitter = ? AND block >= ? GROUP BY topic0 ORDER BY n DESC, topic0 LIMIT 5`),
      sampleTokens: db.prepare(`SELECT token FROM birth_refs WHERE chain_id = ? AND emitter = ? AND block >= ? GROUP BY token ORDER BY MAX(block) DESC LIMIT 3`),
    };
    // The same questions asked of the compact tables directly: grouping and filtering on integer ids,
    // and turning ids back into addresses only for the rows that are returned. Reading through the
    // birth_refs view costs three dictionary lookups per row, which made the detector 1.7x slower.
    // The view versions above stay for a database whose evidence has not been migrated yet.
    const tok = 'JOIN ids tk ON tk.id = r.token_id JOIN tokens t ON t.chain_id = r.chain_id AND t.address = tk.v';
    const agg = `COUNT(DISTINCT r.token_id) AS births,
          COUNT(DISTINCT CASE WHEN t.launchpad_id IS NOT NULL THEN r.token_id END) AS known_births,
          COUNT(DISTINCT t.launchpad_id) AS known_launchpads, GROUP_CONCAT(DISTINCT t.launchpad_id) AS launchpads,
          COUNT(DISTINCT r.topic_id) AS event_types, MIN(r.block) AS first_block, MAX(r.block) AS last_block`;
    this.fast = {
      id: db.prepare('SELECT id FROM ids WHERE v = ?').pluck(),
      emitterStats: db.prepare('SELECT COUNT(DISTINCT token_id) AS births, MAX(block) AS last_block FROM refs WHERE chain_id = ? AND emitter_id = ? AND block >= ?'),
      emitterTopCluster: db.prepare(`SELECT t.fp_key, COUNT(DISTINCT r.token_id) AS n FROM refs r ${tok}
        WHERE r.chain_id = ? AND r.emitter_id = ? AND r.block >= ? GROUP BY t.fp_key ORDER BY n DESC LIMIT 1`),
      emitters: db.prepare(`SELECT e.v AS emitter, x.* FROM (
          SELECT r.emitter_id, ${agg} FROM refs r ${tok}
          WHERE r.chain_id = ? AND r.block >= ? AND t.is_lp = 0 GROUP BY r.emitter_id HAVING births >= 2 ORDER BY births DESC LIMIT 1500
        ) x JOIN ids e ON e.id = x.emitter_id ORDER BY x.births DESC`),
      oneEmitter: db.prepare(`SELECT CASE WHEN COUNT(*) > 0 THEN @e END AS emitter, ${agg} FROM refs r ${tok}
        WHERE r.chain_id = @c AND r.block >= @s AND r.emitter_id = @id`),
      // ids, not addresses: these sets are only compared with each other
      emitterTokens: db.prepare('SELECT DISTINCT token_id AS token FROM refs WHERE chain_id = ? AND emitter_id = ? AND block >= ?'),
      emitterRoles: db.prepare(`SELECT COUNT(DISTINCT CASE WHEN t.tx_to IS NOT NULL OR t.mint_to IS NOT NULL THEN r.token_id END) AS with_facts,
          COUNT(DISTINCT CASE WHEN t.v4_hook = @e THEN r.token_id END) AS as_hook
        FROM refs r ${tok} WHERE r.chain_id = @c AND r.emitter_id = @id AND r.block >= @s`),
      emitterTopics: db.prepare(`SELECT p.v AS topic0, COUNT(*) AS n FROM refs r JOIN ids p ON p.id = r.topic_id
        WHERE r.chain_id = ? AND r.emitter_id = ? AND r.block >= ? GROUP BY r.topic_id ORDER BY n DESC, p.v LIMIT 5`),
      sampleTokens: db.prepare(`SELECT tk.v AS token FROM (
          SELECT token_id, MAX(block) AS mb FROM refs WHERE chain_id = ? AND emitter_id = ? AND block >= ? GROUP BY token_id ORDER BY mb DESC LIMIT 3
        ) x JOIN ids tk ON tk.id = x.token_id ORDER BY x.mb DESC`),
      // Everything the detector wants to know about one emitter's tokens, in one pass over them,
      // grouped by bytecode template (each token sits in exactly one group, so the sums are exact).
      profile: db.prepare(`SELECT t.fp_key AS fp_key, COUNT(DISTINCT r.token_id) AS n, MAX(r.block) AS last_block,
          COUNT(DISTINCT CASE WHEN t.tx_to IS NOT NULL OR t.mint_to IS NOT NULL THEN r.token_id END) AS wf,
          COUNT(DISTINCT CASE WHEN t.v4_hook = @e THEN r.token_id END) AS hook,
          COUNT(DISTINCT CASE WHEN t.tx_to = @e OR t.mint_to = @e THEN r.token_id END) AS made
        FROM refs r ${tok} WHERE r.chain_id = @c AND r.emitter_id = @id AND r.block >= @s GROUP BY t.fp_key`),
    };
    const legacy = () => this.store.migration.needed;
    const f = this.fast, v = this.sql;
    const none = { births: 0, last_block: null };
    this.ev = {
      /** births, last block, top template count, tokens with birth facts, as pool hook, made by itself */
      profile: (c, e, s) => {
        if (legacy()) {
          const st = v.emitterStats.get(c, e, s);
          const top = v.emitterTopCluster.get(c, e, s);
          const ro = v.emitterRoles.get(c, e, s);
          const mk = this.ev.makerShare(c, e, s, [e]);
          return { births: st.births, lastBlock: st.last_block, topN: top?.n ?? 0, withFacts: ro.with_facts, asHook: ro.as_hook, madeSelf: mk.made };
        }
        const id = f.id.get(e);
        const out = { births: 0, lastBlock: null, topN: 0, withFacts: 0, asHook: 0, madeSelf: 0 };
        if (id === undefined) return out;
        for (const g of f.profile.all({ c, e, s, id })) {
          out.births += g.n; out.withFacts += g.wf; out.asHook += g.hook; out.madeSelf += g.made;
          if (g.n > out.topN) out.topN = g.n;
          if (g.last_block !== null && (out.lastBlock === null || g.last_block > out.lastBlock)) out.lastBlock = g.last_block;
        }
        return out;
      },
      emitterStats: (c, e, s) => { if (legacy()) return v.emitterStats.get(c, e, s); const id = f.id.get(e); return id === undefined ? none : f.emitterStats.get(c, id, s); },
      emitterTopCluster: (c, e, s) => { if (legacy()) return v.emitterTopCluster.get(c, e, s); const id = f.id.get(e); return id === undefined ? undefined : f.emitterTopCluster.get(c, id, s); },
      emitters: (c, s) => (legacy() ? v.emitters : f.emitters).all(c, s),
      oneEmitter: (c, s, e) => { if (legacy()) return v.oneEmitter.get(c, s, e); return f.oneEmitter.get({ c, s, e, id: f.id.get(e) ?? -1 }); },
      emitterTokens: (c, e, s) => { if (legacy()) return v.emitterTokens.all(c, e, s); const id = f.id.get(e); return id === undefined ? [] : f.emitterTokens.all(c, id, s); },
      emitterRoles: (c, e, s) => { if (legacy()) return v.emitterRoles.get(c, e, s); return f.emitterRoles.get({ c, e, s, id: f.id.get(e) ?? -1 }); },
      emitterTopics: (c, e, s) => { if (legacy()) return v.emitterTopics.all(c, e, s); const id = f.id.get(e); return id === undefined ? [] : f.emitterTopics.all(c, id, s); },
      sampleTokens: (c, e, s) => { if (legacy()) return v.sampleTokens.all(c, e, s); const id = f.id.get(e); return id === undefined ? [] : f.sampleTokens.all(c, id, s); },
      // emitters that fired one of these creation events in the window
      byTopics: (c, s, topic0s) => {
        const marks = topic0s.map(() => '?').join(',');
        return legacy()
          ? db.prepare(`SELECT DISTINCT emitter FROM birth_refs WHERE chain_id = ? AND block >= ? AND topic0 IN (${marks})`).all(c, s, ...topic0s)
          : db.prepare(`SELECT DISTINCT e.v AS emitter FROM refs r JOIN ids e ON e.id = r.emitter_id
              WHERE r.chain_id = ? AND r.block >= ? AND r.topic_id IN (SELECT id FROM ids WHERE v IN (${marks}))`).all(c, s, ...topic0s);
      },
      // of an emitter's tokens with birth facts: how many were made by (called into / minted to) one of `addrs`
      makerShare: (c, e, s, addrs) => {
        const marks = addrs.map(() => '?').join(',');
        const cols = `COUNT(DISTINCT t.address) AS with_facts,
          COUNT(DISTINCT CASE WHEN t.tx_to IN (${marks}) OR t.mint_to IN (${marks}) THEN t.address END) AS made`;
        if (legacy()) {
          return db.prepare(`SELECT ${cols} FROM birth_refs r JOIN tokens t ON t.chain_id = r.chain_id AND t.address = r.token
            WHERE r.chain_id = ? AND r.emitter = ? AND r.block >= ? AND (t.tx_to IS NOT NULL OR t.mint_to IS NOT NULL)`).get(...addrs, ...addrs, c, e, s);
        }
        return db.prepare(`SELECT ${cols} FROM refs r ${tok}
          WHERE r.chain_id = ? AND r.emitter_id = ? AND r.block >= ? AND (t.tx_to IS NOT NULL OR t.mint_to IS NOT NULL)`).get(...addrs, ...addrs, c, f.id.get(e) ?? -1, s);
      },
    };
  }

  chain(id) { return this.chains.get(Number(id)) ?? null; }

  #head(chainId) {
    return this.indexers.get(chainId)?.status.head ?? this.store.q.getCursor.get(chainId)?.head ?? null;
  }

  /** First block of the statistics window. 0 when we do not know the head yet. */
  #since(chainId) {
    const head = this.#head(chainId);
    return head ? Math.max(0, head - this.chains.get(chainId).statsWindowBlocks) : 0;
  }

  #emitterInfo(chainId, emitter) {
    const k = `${chainId}:${emitter}`;
    const hit = this.emitterCache.get(k);
    if (hit) return hit;
    const since = this.#since(chainId);
    const p = this.ev.profile(chainId, emitter, since);
    return this.emitterCache.set(k, {
      births: p.births, firstBlock: this.sql.emitterFirst.get({ c: chainId, e: emitter })?.first_block ?? null, lastBlock: p.lastBlock,
      // share of this emitter's tokens that use one bytecode template: ~1.0 for a factory, low for shared plumbing
      purity: p.births && p.topN ? Number((p.topN / p.births).toFixed(3)) : null,
      // of its tokens with birth facts: how many it served as pool hook, and how many it made itself
      withFacts: p.withFacts, asHook: p.asHook, madeSelf: p.madeSelf,
    });
  }

  #classify(chainId, emitter, topic0) {
    const reg = this.registries.get(chainId);
    const name = (id) => reg.launchpads.get(id)?.name ?? id;
    const specs = reg.byTopic0.get(topic0);
    const hit = specs?.find((s) => s.emitters.has(emitter));
    if (hit) return { role: 'registry', label: `${name(hit.launchpadId)} ${hit.emitters.get(emitter).label ?? 'factory'}`, event: hit.signature };
    // Address-level knowledge beats topic-level guesses.
    const own = reg.factoryOf.get(emitter);
    if (own) return { role: 'registry', label: `${name(own.launchpadId)} ${own.label ?? 'factory'}`, event: null };
    const comp = reg.companionOf.get(emitter);
    if (comp) return { role: 'companion', label: `${name(comp.launchpadId)} ${comp.label ?? 'contract'}`, event: null };
    if (INFRA_ADDRESSES.has(emitter)) return { role: 'infra', label: INFRA_ADDRESSES.get(emitter), event: null };
    if (specs) return { role: 'look-alike', label: `same event as ${specs.map((s) => name(s.launchpadId)).join(' / ')}`, event: specs[0].signature };
    if (INFRA_TOPICS.has(topic0)) return { role: 'infra', label: INFRA_TOPICS.get(topic0), event: null };
    return { role: 'unlisted', label: null, event: null };
  }

  #announcers(chainId, token, row = {}) {
    const rows = this.store.q.refsOf.all(chainId, token);
    const byEmitter = new Map();
    for (const r of rows) {
      const c = this.#classify(chainId, r.emitter, r.topic0);
      // the pool's v4 hook mentions every token it serves: machinery, not the maker
      if (c.role === 'unlisted' && r.emitter === row.v4_hook) { c.role = 'hook'; c.label = "Uniswap v4 hook of this token's pool"; }
      const prev = byEmitter.get(r.emitter);
      // called by the deployer, or received the first mint: that contract made the token
      const creator = r.emitter === row.tx_to || r.emitter === row.mint_to;
      const rank = { registry: 5, 'look-alike': 4, unlisted: creator ? 3 : 2, hook: 1.5, companion: 1, infra: 0 }[c.role];
      c.creator = creator;
      if (!prev || rank > prev.rank) {
        const { births, firstBlock, lastBlock, purity } = this.#emitterInfo(chainId, r.emitter); // the public fields only
        byEmitter.set(r.emitter, { emitter: r.emitter, topic0: r.topic0, logIndex: r.log_index, rank, ...c, births, firstBlock, lastBlock, purity });
      }
    }
    // A factory announces many tokens of one template. Per-launch helper contracts announce one.
    const list = [...byEmitter.values()];
    // Next to a contract that announces many tokens, a contract that announced only this one
    // is a per-launch helper (its bonding curve, its tax processor), not a rival factory.
    const hasSerial = list.some((a) => a.births >= 2 && a.role !== 'infra');
    for (const a of list) if (a.role === 'unlisted' && !a.creator && a.births < 2 && hasSerial) { a.role = 'helper'; a.rank = 1; }
    return list.sort((a, b) =>
      b.rank - a.rank || Number((b.purity ?? 0) >= 0.8) - Number((a.purity ?? 0) >= 0.8) || b.births - a.births || a.logIndex - b.logIndex,
    ).map(({ rank, ...a }) => a);
  }

  #cluster(chainId, fpKey) {
    if (!fpKey) return null;
    const reg = this.registries.get(chainId);
    const ck = `cluster:${chainId}:${fpKey}`;
    const rows = this.listCache.get(ck) ?? this.listCache.set(ck, this.store.q.cluster.all(chainId, fpKey));
    const size = rows.reduce((s, r) => s + r.n, 0);
    return {
      key: fpKey, size,
      launchpads: rows.map((r) => ({ id: r.launchpad_id || null, name: r.launchpad_id ? reg.launchpads.get(r.launchpad_id)?.name ?? r.launchpad_id : 'unattributed', tokens: r.n, share: Number((r.n / size).toFixed(3)) })),
      // a template owned by a permissionless protocol is shared by every app on it: name the protocol,
      // and make clear the app shares describe the template's users, not who launched *this* token
      template: this.#templateOwner(reg, fpKey),
    };
  }

  /**
   * For a token with no indexed birth, query each protocol factory that keeps per-asset data
   * (Doppler Airlock: getAssetData). One eth_call per protocol; no explorer key, no birth tx.
   * Returns attribution columns to merge into the row, or {} when no protocol knows the token.
   */
  async #liveProtocol(chain, addr) {
    const reg = this.registries.get(chain.id);
    const rpc = this.rpcs.get(chain.id);
    if (!rpc) return {};
    for (const spec of reg.platformSpecs ?? []) {
      try {
        const match = { platform: spec.platform, factory: spec.factory, launchpadId: spec.launchpadId };
        const [res] = await rpc.batch([platformCall(match, addr)], { priority: true });
        const data = res?.result ?? '0x';
        if (data.length < 66) continue;
        const r = resolvePlatform(match, data);
        if (r.platform === 'unreadable') continue;
        // numeraire (word 0) all-zero means the protocol has no record of this asset
        if (/^0x0{64}/.test(data.slice(0, 66).replace('0x', '0x'))) continue;
        return { launchpad_id: r.launchpadId, confidence: r.confidence, factory: spec.factory, factory_label: spec.emitters.get(spec.factory)?.label ?? null,
          event_sig: spec.signature, platform: r.platform, claim_app: r.claimedLaunchpadId ?? null, claim_check: r.claimCheck ?? null, attribution_source: 'live-protocol-call' };
      } catch { /* try the next protocol */ }
    }
    return {};
  }

  /**
   * Find and record the birth of a token that a launch protocol knows but the index does not hold.
   * The token's own mint from address zero marks its birth: found with address-filtered getLogs,
   * newest window first (at most BIRTH_SCAN_WINDOWS x ADDR_LOGS_SPAN blocks back, 6 windows per
   * request), and accepted only when that transaction's receipt holds a registry creation event for
   * this token. The birth is then recorded exactly as the indexer records it (sender, pre-mint,
   * judged claim), so the replay later skips it. Returns the saved row, or null (nothing found,
   * scanning disabled, or the node refused): the caller then answers from the protocol call alone.
   */
  async #protocolBirth(chain, addr, knownTxs = []) {
    const rpc = this.rpcs.get(chain.id);
    const reg = this.registries.get(chain.id);
    const span = chain.addrLogsSpan, windows = chain.birthScanWindows;
    const key = `${chain.id}:${addr}`;
    if (!rpc || this.birthMiss.get(key)) return null;
    const recordIfBirth = async (tx, block) => {
      const receipt = await rpc.call('eth_getTransactionReceipt', [tx], { priority: true });
      const isBirth = (receipt?.logs ?? []).some((l) => matchKnownEvent(reg, l)?.token === addr);
      if (!isBirth) return null; // a later mint (inflation), not the launch
      const recorder = new BirthRecorder({ chain, rpc, registry: reg, store: this.store });
      const saved = await recorder.record(addr, block ?? Number(receipt.blockNumber), tx, 'registry-event', null, { priority: true });
      return saved?.launchpad_id ? saved : null;
    };
    try {
      // a birth transaction the index already holds (a row stored before its protocol was in the registry)
      for (const [tx, block] of knownTxs) { const saved = await recordIfBirth(tx, block); if (saved) return saved; }
    } catch { /* fall through to the scan */ }
    if (!(span > 0) || !(windows > 0)) { this.birthMiss.set(key, true); return null; }
    try {
      let head = this.#head(chain.id);
      if (head == null) head = Number(await rpc.call('eth_blockNumber', [], { priority: true }));
      const ranges = [];
      for (let i = 0, b = head; i < windows && b >= 0; i++, b -= span) ranges.push([Math.max(0, b - span + 1), b]);
      const filter = { address: addr, topics: [TRANSFER_TOPIC, ZERO_TOPIC] };
      const urgent = { call: (m, p) => rpc.call(m, p, { priority: true }) };
      const byPos = (x, y) => Number(x.blockNumber) - Number(y.blockNumber) || Number(x.logIndex) - Number(y.logIndex);
      for (let i = 0; i < ranges.length; i += 6) {
        const group = ranges.slice(i, i + 6);
        const res = await rpc.batch(group.map(([a, b]) => ({ method: 'eth_getLogs', params: [{ ...filter, fromBlock: hex(a), toBlock: hex(b) }] })), { priority: true });
        for (let j = 0; j < group.length; j++) {
          let logs = res[j]?.result;
          // a node that refuses the span (a stated cap, a result-size limit): walk this window adaptively
          if (!Array.isArray(logs)) logs = await getLogsRange(urgent, filter, group[j][0], group[j][1], { span, max: span }, chain.logsSoftCap);
          if (!logs.length) continue;
          const blockOf = new Map();
          for (const l of logs.sort(byPos)) if (!blockOf.has(l.transactionHash)) blockOf.set(l.transactionHash, Number(l.blockNumber));
          for (const [tx, block] of blockOf) {
            const saved = await recordIfBirth(tx, block); // not the launch: keep looking further back
            if (saved) return saved;
          }
        }
      }
    } catch { /* a refusing or flaky node: answer from the protocol call alone */ }
    this.birthMiss.set(key, true);
    return null;
  }

  /** The stored pre-mint facts as shares of the total supply. */
  #premint(row) {
    if (!row.premint) return null;
    let p;
    try { p = typeof row.premint === 'string' ? JSON.parse(row.premint) : row.premint; } catch { return null; }
    const supply = row.total_supply ? BigInt(row.total_supply) : 0n;
    const pct = (amt) => (supply > 0n ? Number((BigInt(amt) * 10000n) / supply) / 100 : null);
    const allocations = (p.allocations ?? []).map((a) => {
      const sch = p.schedules?.[a.scheduleId] ?? null;
      // DopplerERC20V1 allows a duration of 0 or at least a day; anything faster is as good as unlocked
      const unlocked = sch ? sch.cliff < 3600 && sch.duration < 86400 : false;
      return { to: a.to, amount: a.amount, pct: pct(a.amount), cliffDays: sch ? Math.round((sch.cliff / 86400) * 10) / 10 : null, vestDays: sch ? Math.round((sch.duration / 86400) * 10) / 10 : null, unlockedAtLaunch: unlocked };
    });
    const allocated = allocations.reduce((s, a) => s + BigInt(a.amount), 0n);
    const escrowed = BigInt(p.escrowed ?? '0');
    // Supply minted into the token itself with no announced beneficiaries: vesting kept in storage only
    // (an older token type). Only meaningful for a protocol launch; other tokens that mint to
    // themselves are not pre-minting anything to anyone.
    const unannounced = row.platform && escrowed > allocated ? escrowed - allocated : 0n;
    const total = allocated + unannounced;
    if (total === 0n) return null; // receipt read, nothing minted outside the sale
    const unlocked = allocations.filter((a) => a.unlockedAtLaunch).reduce((s, a) => s + BigInt(a.amount), 0n);
    const round = (x) => (x === null ? null : Math.round(x * 100) / 100);
    return { totalPct: round(pct(total.toString())), unlockedPct: round(pct(unlocked.toString())), escrowedPct: round(pct(escrowed.toString())),
      unannouncedPct: round(pct(unannounced.toString())), allocations };
  }

  /**
   * Tokens indexed before the sender and pre-mint columns existed: read their birth receipt once,
   * on first lookup (one RPC call), and check the launch sender against the claimed app's wallets.
   * Returns the updated row, or the same row when nothing could be added.
   */
  async #completeBirthFacts(chain, row) {
    if (!this.#needsBirthFacts(row)) return row;
    const rpc = this.rpcs.get(chain.id);
    const reg = this.registries.get(chain.id);
    if (!rpc) return row;
    const key = `${chain.id}:${row.address}`;
    if (this.factsMiss.get(key)) return row; // the node had no receipt a moment ago: do not ask on every lookup
    try {
      const [rc] = await rpc.batch([{ method: 'eth_getTransactionReceipt', params: [row.birth_tx] }], { priority: true });
      const receipt = rc?.result;
      if (!receipt) { this.factsMiss.set(key, true); return row; }
      const sender = receipt.from ? receipt.from.toLowerCase() : null;
      const premint = premintFacts(receipt, row.address);
      this.store.q.setBirthFacts.run(sender, premint ? JSON.stringify(premint) : '{}', chain.id, row.address);
      let next = { ...row, tx_from: sender, premint: premint ? JSON.stringify(premint) : '{}' };
      // a protocol launch that claims an app with rules: judge the claim now (sender wallet + allocation policy)
      const spec = row.platform && row.factory ? (reg.platformSpecs ?? []).find((s) => s.factory === row.factory) : null;
      const known = spec?.platform.known.get(row.platform);
      if (spec && known && (known.wallets || known.allocations) && parseClaim(row.claim_check)?.result !== 'verified') {
        const code = sender && known.wallets ? (await rpc.batch([senderCodeCall(sender)], { priority: true }))[0]?.result ?? null : null;
        const claim = judgeClaim(known, sender, code, premint, row.total_supply ?? null);
        const { launchpadId, confidence } = claimPlacement(known, spec.launchpadId, claim);
        const claimCheck = claim ? JSON.stringify(claim) : null;
        this.store.q.setClaim.run(launchpadId, confidence, known.launchpad, claimCheck, chain.id, row.address);
        next = { ...next, launchpad_id: launchpadId, confidence, claim_app: known.launchpad, claim_check: claimCheck };
      }
      return next;
    } catch { this.factsMiss.set(key, true); return row; }
  }

  /** An update-13 row with a birth transaction whose receipt was never read for sender and pre-mint. */
  #needsBirthFacts(row) {
    return Boolean(row.birth_tx) && row.premint === null && row.tx_from === null;
  }

  #templateOwner(reg, fpKey) {
    if (!fpKey?.startsWith('proxy:')) return null;
    const impl = fpKey.slice(6);
    const c = reg.companionOf.get(impl);
    if (!c) return null;
    const lp = reg.launchpads.get(c.launchpadId);
    const isProtocol = (reg.platformSpecs ?? []).some((s) => s.launchpadId === c.launchpadId);
    return { launchpadId: c.launchpadId, name: lp?.name ?? c.launchpadId, label: c.label, sharedByApps: isProtocol };
  }

  #shape(chain, row, { adhoc = false } = {}) {
    const reg = this.registries.get(chain.id);
    const lp = row.launchpad_id ? reg.launchpads.get(row.launchpad_id) ?? { id: row.launchpad_id, name: row.launchpad_id } : null;
    const announcers = adhoc ? [] : this.#announcers(chain.id, row.address, row);
    const cluster = this.#cluster(chain.id, row.fp_key);
    const primary = announcers.find((a) => a.role === 'unlisted' || a.role === 'look-alike' || a.role === 'registry') ?? announcers.find((a) => a.role === 'hook') ?? null;

    let code = row.confidence ?? 'none';
    // protocol launches: the verdict is about the app, not the protocol contract
    const protocolLaunch = Boolean(row.platform);
    if (protocolLaunch && code === 'verified' && lp && reg.byTopic0 && [...reg.byTopic0.values()].flat().some((s) => s.launchpadId === lp.id && s.platform)) code = 'protocol-verified';
    else if (protocolLaunch && code === 'observed-emitter') code = 'observed-platform';
    const claimed = row.claim_app ? reg.launchpads.get(row.claim_app) ?? { id: row.claim_app, name: row.claim_app } : null;
    const claim = parseClaim(row.claim_check);
    const premint = this.#premint(row);
    let likely = null;
    // no announcers because they were pruned is not the same as "nobody announced it"
    const pruned = code === 'discovered' && !primary && row.birth_block != null && row.birth_block < (this.store.q.getMeta.get(chain.id, 'pruned_before')?.v ?? -1);
    if (pruned) code = 'evidence-pruned';
    else if (code === 'discovered' && !primary) code = 'discovered-silent';
    else if (code === 'discovered' && primary.births < 2) code = 'discovered-first';
    // no event anywhere, but the deployer called a contract that also got the mint: that contract is the maker
    let silentMaker = null;
    if (code === 'discovered-silent' && row.mint_to && row.mint_to === row.tx_to) {
      const since = this.#since(chain.id);
      const made = this.store.q.madeBy.get(chain.id, row.mint_to, row.mint_to, since);
      if (made.n >= 2) {
        code = 'silent-factory';
        silentMaker = { address: row.mint_to, tokensMade: made.n, firstBlock: made.first_block, lastBlock: made.last_block,
          topNames: this.store.q.madeByNames.all(chain.id, row.mint_to, row.mint_to, since).map((r) => ({ name: r.name, tokens: r.n })) };
      }
    }
    if (code === 'none' && cluster) {
      const top = cluster.launchpads[0];
      if (top?.id && top.share >= 0.9 && top.tokens >= 5 && !cluster.template?.sharedByApps) { code = 'bytecode-cluster'; likely = { id: top.id, name: top.name, share: top.share, tokens: top.tokens }; }
    }
    let [headline, detail] = VERDICTS[code] ?? VERDICTS.none;
    if (code === 'look-alike-platform' && claimed) headline = `Claims ${claimed.name}, not launched by it`;
    const warnings = [];
    if (premint?.unlockedPct >= 1) {
      const to = premint.allocations.filter((a) => a.unlockedAtLaunch).map((a) => a.to);
      warnings.push(`${premint.unlockedPct}% of the supply was minted outside the sale and could be sold from the first block (to ${to.length === 1 ? to[0] : `${to.length} wallets`}).`);
    } else if (premint?.unannouncedPct >= 1) {
      warnings.push(`${premint.totalPct}% of the supply was minted outside the sale; ${premint.unannouncedPct}% sits in the token contract with no announced beneficiary or schedule, so when it can be sold is not known from the launch.`);
    } else if (premint?.totalPct >= 1) {
      warnings.push(`${premint.totalPct}% of the supply was minted outside the sale (vesting; see premint).`);
    }
    if (code === 'look-alike-platform' && claimed) {
      const why = [];
      if (claim?.allocations === 'failed') why.push(`what was minted at birth${premint?.unlockedPct ? ` (${premint.unlockedPct}% unlocked at launch)` : ''} is not something ${claimed.name}'s launch flow produces`);
      if (claim?.wallet === 'failed') why.push(`the launch was sent by ${row.tx_from ?? 'a wallet'}, which is not one of ${claimed.name}'s wallets`);
      else if (claim?.wallet === 'verified') why.push(`the sending wallet is set up like ${claimed.name}'s (an EIP-7702 delegation anyone can copy), which does not make an off-policy mint ${claimed.name}'s`);
      warnings.push(`The integrator field names ${claimed.name}, but ${why.join(', and ')}. Terminals that trust the integrator field show it as a ${claimed.name} launch.`);
    } else if (claim?.result === 'unverified' && claimed) {
      warnings.push(claim.wallet === 'failed' && claim.allocations === 'verified'
        ? `The launch was sent by ${row.tx_from ?? 'a wallet'}, which is not one of ${claimed.name}'s known wallets; what was minted at birth matches ${claimed.name}'s policy, so the label is kept but not confirmed.`
        : claim.wallet === 'failed'
          ? `The launch was sent by ${row.tx_from ?? 'a wallet'}, which is not one of ${claimed.name}'s known wallets, and what was minted at birth could not be read; the label is kept but not confirmed.`
          : `The integrator field names ${claimed.name}; the launch could not be checked against ${claimed.name}'s wallets or allocation policy.`);
    }
    const factoryAddr = row.factory ?? silentMaker?.address ?? (code === 'discovered' || code === 'discovered-first' ? primary?.emitter : null) ?? null;
    const fstats = factoryAddr ? this.#emitterInfo(chain.id, factoryAddr) : null;
    const head = this.#head(chain.id);
    const known = reg.factoryOf.get(row.address) ?? reg.companionOf.get(row.address) ?? null;

    return {
      schema: 1,
      chain: { id: chain.id, name: chain.name },
      // set when someone pastes a launchpad's own contract instead of a token
      knownContract: known ? { launchpad: reg.launchpads.get(known.launchpadId)?.name ?? known.launchpadId, role: known.label } : null,
      token: { address: row.address, name: row.name, symbol: row.symbol, decimals: row.decimals, totalSupply: row.total_supply,
        // other token contracts carrying this exact name and symbol (a counterfeit signal, not proof)
        sameNameElsewhere: row.name && row.symbol ? this.store.q.sameName.get(chain.id, row.name, row.symbol, row.address).n : 0 },
      verdict: { code, headline, detail, warnings },
      launchpad: lp ? { id: lp.id, name: lp.name, url: lp.url ?? null, stack: lp.stack ?? null } : null,
      likelyLaunchpad: likely,
      factory: factoryAddr ? {
        address: factoryAddr, label: row.factory_label ?? primary?.label ?? null, event: row.event_sig ?? primary?.event ?? null,
        eventFields: row.event_fields ? JSON.parse(row.event_fields) : null,
        sharesSignatureWith: row.family ? JSON.parse(row.family).filter((id) => id !== row.launchpad_id).map((id) => reg.launchpads.get(id)?.name ?? id) : [],
        platform: row.platform ? {
          integrator: row.platform === 'unreadable' ? null : row.platform,
          launchpad: code === 'protocol-verified' || code === 'look-alike-platform' ? null : lp?.name ?? null,
          status: code === 'protocol-verified' ? 'unlisted' : code === 'look-alike-platform' ? 'look-alike' : code === 'observed-platform' ? 'observed' : 'confirmed',
          // the app the integrator field names, and whether the launch sender belongs to it
          claims: claimed ? { id: claimed.id, name: claimed.name } : null,
          claimCheck: claim?.result ?? null, senderCheck: claim?.wallet ?? null, allocationCheck: claim?.allocations ?? null, sender: row.tx_from ?? null,
        } : null,
        // silent factories announce nothing: report what they made instead
        silent: Boolean(silentMaker),
        tokensMade: silentMaker?.tokensMade ?? null, topNames: silentMaker?.topNames ?? null,
        tokensAnnounced: silentMaker ? null : fstats?.births ?? null, statsWindowBlocks: chain.statsWindowBlocks,
        firstSeenBlock: silentMaker?.firstBlock ?? fstats?.firstBlock ?? null,
        firstSeenAgoSec: (silentMaker?.firstBlock ?? fstats?.firstBlock) && head ? Math.max(0, Math.round(((head - (silentMaker?.firstBlock ?? fstats.firstBlock)) * chain.blockTimeMs) / 1000)) : null,
      } : null,
      birth: row.birth_tx ? {
        block: row.birth_block, tx: row.birth_tx, source: row.birth_source,
        explorerUrl: chain.explorer?.web ? `${chain.explorer.web}/tx/${row.birth_tx}` : null,
        calledContract: row.tx_to ?? null, sender: row.tx_from ?? null, firstMintTo: row.mint_to ?? null, v4Hook: row.v4_hook ?? null,
      } : null,
      bytecode: {
        size: row.code_size, kind: row.fp_kind, implementation: row.impl,
        upgradeable: row.upgradeable === null || row.upgradeable === undefined ? null : Boolean(row.upgradeable),
        exactHash: row.fp_exact, cluster,
        attributionSource: row.attribution_source ?? (row.birth_tx ? 'indexed-birth' : null),
        note: row.fp_kind === 'minimal-proxy'
          ? 'Minimal clone: the implementation address is hardcoded in the bytecode and cannot be changed. Generic scanners still report it as a proxy.'
          : row.fp_kind === 'eip1967-proxy' ? 'EIP-1967 proxy: whoever controls the admin or implementation can change the logic.' : null,
      },
      announcers,
      // tokens minted at birth outside the sale (Doppler vesting allocations), as shares of the supply
      premint,
      evidencePruned: pruned,
      indexedAt: row.created_at ?? null,
    };
  }

  /** True when answering costs no RPC call (indexed or cached), so the rate limiter can skip it. */
  isCheap(chainId, address) {
    const a = address.toLowerCase();
    const row = this.store.q.getToken.get(Number(chainId), a);
    if (row) {
      // rows a lookup completes with RPC calls (see token()) go through the rate limiter like unknown tokens
      const live = !row.launchpad_id && (row.confidence === 'none' || row.confidence === 'discovered');
      return !(live || (this.#needsBirthFacts(row) && !this.factsMiss.get(`${Number(chainId)}:${a}`)));
    }
    return this.adhocCache.get(`${Number(chainId)}:${a}`) !== undefined;
  }

  /** Main entry. Indexed tokens cost no RPC calls; unknown ones cost 1 batch (+1 explorer call). */
  async token(chainId, address) {
    const chain = this.chain(chainId);
    if (!chain) return { status: 404, body: { error: 'unknown_chain', message: `Chain ${chainId} is not configured here.`, chains: [...this.chains.keys()] } };
    const addr = address.toLowerCase();
    let row = this.store.q.getToken.get(chain.id, addr);
    if (row) {
      // indexed but never attributed (born before the index, or a silent birth): a protocol may still know it
      if (!row.launchpad_id && (row.confidence === 'none' || row.confidence === 'discovered')) {
        const live = await this.#liveProtocol(chain, addr);
        if (live.launchpad_id) {
          // a protocol launch the index holds without its creation event: find and record the real birth
          const born = await this.#protocolBirth(chain, addr, row.birth_tx ? [[row.birth_tx, row.birth_block]] : []);
          return { status: 200, body: this.#shape(chain, born ?? { ...row, ...live }) };
        }
      }
      row = await this.#completeBirthFacts(chain, row);
      return { status: 200, body: this.#shape(chain, row) };
    }

    const key = `${chain.id}:${addr}`;
    const cached = this.adhocCache.get(key);
    if (cached) return cached;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = this.#resolveUnindexed(chain, addr).then((r) => this.adhocCache.set(key, r)).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  async #resolveUnindexed(chain, addr) {
    const rpc = this.rpcs.get(chain.id);
    const creation = await findCreation(chain, addr);
    if (creation) {
      const recorder = new BirthRecorder({ chain, rpc, registry: this.registries.get(chain.id), store: this.store });
      const saved = await recorder.record(addr, null, creation.txHash, 'explorer', null, { priority: true });
      if (saved && saved.fp_kind !== 'empty') return { status: 200, body: this.#shape(chain, saved) };
    }
    const { fp, meta } = await enrichToken(rpc, chain, addr, null, { priority: true });
    if (fp.kind === 'empty') return { status: 404, body: { error: 'not_a_contract', message: `No contract at ${addr} on ${chain.name}.` } };
    // Not persisted: a public endpoint should not let strangers grow the database.
    const row = { address: addr, confidence: 'none', ...fpColumns(fp), ...meta };
    // No birth record, but a permissionless protocol keeps its own asset registry on-chain: ask it.
    const live = await this.#liveProtocol(chain, addr);
    if (live.launchpad_id) {
      // The protocol knows it, so it is a real launch the index has not reached (born before the
      // index started, or in a stall gap not replayed yet). Its claim and pre-mint need the birth
      // receipt, exactly like an indexed launch: the integrator field alone is not believed.
      const born = await this.#protocolBirth(chain, addr);
      if (born) return { status: 200, body: this.#shape(chain, born) };
    }
    Object.assign(row, live);
    return { status: 200, body: this.#shape(chain, row, { adhoc: true }) };
  }

  /** opts: { limit, attributed: false = only tokens with no known launchpad } */
  recent(chainId, opts = {}) {
    const chain = this.chain(chainId);
    if (!chain) return null;
    const reg = this.registries.get(chain.id);
    const limit = Math.min(Math.max(1, Number.isFinite(opts.limit) ? opts.limit : 50), 200);
    const q = opts.attributed === false ? this.store.q.recentUnlisted : this.store.q.recent;
    return q.all(chain.id, limit).map((r) => ({
      address: r.address, symbol: r.symbol, name: r.name, birthBlock: r.birth_block, birthTx: r.birth_tx,
      launchpad: r.launchpad_id ? reg.launchpads.get(r.launchpad_id)?.name ?? r.launchpad_id : null,
      // unlisted = we have no launchpad for it: a discovered/unverified factory, or none at all
      unlisted: !r.launchpad_id,
      confidence: r.confidence, factory: r.factory, codeSize: r.code_size, bytecodeKind: r.fp_kind, cluster: r.fp_key,
      // the app the integrator field claims when the launch was not sent by it; supply unlocked at birth
      claims: r.confidence === 'look-alike-platform' && r.claim_app ? reg.launchpads.get(r.claim_app)?.name ?? r.claim_app : null,
      unlockedPct: this.#premint(r)?.unlockedPct ?? null,
    }));
  }

  /**
   * The detector: contracts that keep announcing newborn tokens but are in no registry.
   * Emitters that fire in the same birth transactions are one *system*; systems that share
   * a creation event are one *mechanism* (a factory that rotates its address shows up as
   * one mechanism with many systems).
   */
  #systems(chain) {
    const hit = this.listCache.get(`sys:${chain.id}`);
    if (hit) return hit;
    const reg = this.registries.get(chain.id);
    const since = this.#since(chain.id);
    const head = this.#head(chain.id);
    const indexStart = this.sql.indexStart.get({ c: chain.id })?.b ?? null;
    const hourBlocks = Math.round(3_600_000 / chain.blockTimeMs);

    // look-alikes get their own query so busy chains can never push them below a LIMIT
    const lookAlike = new Set();
    if (reg.topic0s.length) {
      for (const r of this.ev.byTopics(chain.id, since, reg.topic0s)) if (!reg.factoryOf.has(r.emitter) && !reg.companionOf.has(r.emitter)) lookAlike.add(r.emitter);
    }
    const rows = this.ev.emitters(chain.id, since);
    const seen = new Set(rows.map((r) => r.emitter));
    for (const e of lookAlike) if (!seen.has(e)) rows.push(this.ev.oneEmitter(chain.id, since, e));

    const members = [];
    for (const e of rows) {
      if (!e || reg.factoryOf.has(e.emitter) || reg.companionOf.has(e.emitter)) continue; // already published
      const topics = this.ev.emitterTopics(chain.id, e.emitter, since);
      const classes = topics.map((t) => this.#classify(chain.id, e.emitter, t.topic0));
      const info = this.#emitterInfo(chain.id, e.emitter);
      let status = 'new';
      if (classes[0]?.role === 'infra') status = 'dex-plumbing';                 // dominant event is DEX plumbing
      else if (lookAlike.has(e.emitter)) status = 'look-alike';
      else if (e.known_launchpads >= 2) status = 'shared-plumbing';
      else if (info.purity !== null && info.purity < 0.6 && e.births >= 20) status = 'shared-plumbing'; // many templates = not a factory
      else if (e.known_launchpads === 1 && e.known_births / e.births >= 0.9) status = `companion-of:${e.launchpads}`;
      if (status === 'new' && info.withFacts >= 2 && info.asHook / info.withFacts >= 0.5) status = 'pool-hook'; // machinery of the pools, not a maker
      const age = this.store.q.getAge.get(chain.id, e.emitter);
      members.push({ e, topics, classes, info, status, tokens: null, age });
    }

    // group emitters that announce the same tokens (Jaccard >= 0.9) into one system
    const parent = members.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const small = members.map((m, i) => ({ m, i })).filter(({ m }) => m.e.births <= 5000 && (m.status === 'new' || m.status === 'look-alike'));
    for (const x of small) x.m.tokens = new Set(this.ev.emitterTokens(chain.id, x.m.e.emitter, since).map((r) => r.token));
    small.sort((x, y) => x.m.tokens.size - y.m.tokens.size);
    for (let i = 0; i < small.length; i++) {
      for (let j = i + 1; j < small.length && small[j].m.tokens.size <= small[i].m.tokens.size / 0.9; j++) {
        const A = small[i].m.tokens, B = small[j].m.tokens;
        let inter = 0; for (const t of A) if (B.has(t)) inter++;
        if (inter / (A.size + B.size - inter) >= 0.9) parent[find(small[i].i)] = find(small[j].i);
      }
    }
    // containment: a helper that only fires for *some* of a launcher's tokens (a fee registry that logs
    // non-default choices, an optional module) is part of that launcher's system, not a new factory.
    // Every token it announced must also be announced by one larger system; the largest such wins.
    for (let i = 0; i < small.length; i++) {
      const A = small[i].m.tokens;
      if (A.size < 2) continue;
      for (let j = small.length - 1; j > i; j--) {
        const B = small[j].m.tokens;
        if (B.size <= A.size || find(small[i].i) === find(small[j].i)) continue;
        let inter = 0; for (const t of A) if (B.has(t)) inter++;
        if (inter / A.size >= 0.9) { parent[find(small[i].i)] = find(small[j].i); break; }
      }
    }
    const groups = new Map();
    members.forEach((m, i) => { const r = find(i); (groups.get(r) ?? groups.set(r, []).get(r)).push(m); });

    const ago = (block) => (head && block != null ? Math.max(0, Math.round(((head - block) * chain.blockTimeMs) / 1000)) : null);
    const systems = [...groups.values()].map((g) => {
      g.sort((x, y) => y.e.births - x.e.births || (x.e.emitter < y.e.emitter ? -1 : 1));
      const p = g[0];
      const first = Math.min(...g.map((m) => m.info.firstBlock ?? m.e.first_block));
      const last = Math.max(...g.map((m) => m.e.last_block));
      const own = p.topics.map((t, i) => ({ t, c: p.classes[i] })).find((x) => x.c.role !== 'infra');
      // real first activity: the earliest log of any member, when every member has been dated
      const ageKnown = g.every((m) => m.age);
      const firstActivity = ageKnown ? Math.min(...g.map((m) => m.age.first_log_block)) : null;
      // who made the tokens: share of the system's tokens whose deployer called, or whose first mint went to, a member
      const addrs = g.map((m) => m.e.emitter);
      // a one-member system's share is in its profile already; a group needs its members together
      const mk = g.length === 1 ? { with_facts: p.info.withFacts, made: p.info.madeSelf } : this.ev.makerShare(chain.id, p.e.emitter, since, addrs);
      return {
        emitter: p.e.emitter,
        coEmitters: g.slice(1).map((m) => ({ address: m.e.emitter, topEvent: m.topics[0]?.topic0 ?? null })),
        status: g.some((m) => m.status === 'look-alike') ? 'look-alike' : p.status,
        tokensAnnounced: p.e.births, alreadyAttributed: p.e.known_births, templatePurity: p.info.purity,
        eventTypes: p.e.event_types, topEvents: p.topics.map((t, i) => ({ topic0: t.topic0, count: t.n, label: p.classes[i].label })),
        firstSeenBlock: first, lastSeenBlock: last, firstSeenAgoSec: ago(first), lastSeenAgoSec: ago(last),
        // true = it was already active when this index started, so its real age is unknown
        seenFromIndexStart: indexStart !== null && first <= indexStart + hourBlocks,
        // first log anywhere on-chain within the lookback (null until the idle-time probe has dated it)
        firstActivityBlock: firstActivity, firstActivityAgoSec: ago(firstActivity), ageKnown,
        makerShare: mk.with_facts ? Number((mk.made / mk.with_facts).toFixed(3)) : null,
        mechanismTopic: own?.t.topic0 ?? null,
        sampleTokens: this.ev.sampleTokens(chain.id, p.e.emitter, since).map((r) => r.token),
      };
    });
    // silent factories: emit no creation event, so the event-based grouping above never sees them.
    // Found instead from birth facts: the deployer called the contract and the first mint went to it.
    for (const m of this.store.q.silentMakers.all(chain.id, since)) {
      if (reg.factoryOf.has(m.maker) || reg.companionOf.has(m.maker)) continue;
      if (systems.some((s) => s.emitter === m.maker || s.coEmitters.some((c) => c.address === m.maker))) continue;
      const age = this.store.q.getAge.get(chain.id, m.maker);
      const ageKnown = Boolean(age);
      const firstActivity = ageKnown ? Math.min(age.first_log_block, m.first_block) : null;
      systems.push({
        emitter: m.maker, coEmitters: [], status: 'new', silent: true,
        tokensAnnounced: m.n, alreadyAttributed: 0, templatePurity: m.templates ? Number((1 / m.templates).toFixed(3)) : null,
        eventTypes: 0, topEvents: [], distinctNames: m.names,
        firstSeenBlock: m.first_block, lastSeenBlock: m.last_block, firstSeenAgoSec: ago(m.first_block), lastSeenAgoSec: ago(m.last_block),
        seenFromIndexStart: indexStart !== null && m.first_block <= indexStart + hourBlocks,
        firstActivityBlock: firstActivity, firstActivityAgoSec: ago(firstActivity), ageKnown,
        makerShare: 1, // by construction: every counted token was called-into and minted to this contract
        mechanismTopic: null,
        sampleTokens: this.store.db.prepare('SELECT address FROM tokens WHERE chain_id = ? AND mint_to = ? AND tx_to = ? ORDER BY birth_block DESC LIMIT 5').all(chain.id, m.maker, m.maker).map((r) => r.address),
      });
    }
    // a factory that rotates addresses: several systems, one creation event
    const byMech = new Map();
    for (const s of systems) if (s.mechanismTopic && (s.status === 'new' || s.status === 'look-alike')) (byMech.get(s.mechanismTopic) ?? byMech.set(s.mechanismTopic, []).get(s.mechanismTopic)).push(s.emitter);
    for (const s of systems) {
      const sib = byMech.get(s.mechanismTopic) ?? [s.emitter];
      s.mechanism = { topic0: s.mechanismTopic, addresses: sib.length, otherAddresses: sib.filter((a) => a !== s.emitter).slice(0, 20) };
      delete s.mechanismTopic;
    }
    return this.listCache.set(`sys:${chain.id}`, systems);
  }

  /**
   * opts: { status: 'unlisted' (new + look-alike, default) | 'all' | exact status, sinceHours, min, limit }
   * sinceHours counts a system only when its *first on-chain activity* is that recent. Systems not
   * dated yet are left out of that count and reported as pendingAgeCheck instead of guessed at.
   */
  candidates(chainId, opts = {}) {
    const chain = this.chain(chainId);
    if (!chain) return null;
    const status = opts.status ?? 'unlisted';
    const min = Math.max(1, Number.isFinite(opts.min) ? opts.min : 2);
    const limit = Math.min(500, Math.max(1, Number.isFinite(opts.limit) ? opts.limit : 100));
    const maxAge = Number.isFinite(opts.sinceHours) ? opts.sinceHours * 3600 : null;
    const order = { 'look-alike': 0, new: 1 };
    let pendingAgeCheck = 0;
    const all = this.#systems(chain)
      .filter((s) => (status === 'all' ? true : status === 'unlisted' ? s.status === 'new' || s.status === 'look-alike' : s.status === status))
      .filter((s) => s.tokensAnnounced >= min || s.status === 'look-alike')
      .filter((s) => {
        if (maxAge === null) return true;
        if (!s.ageKnown) { if (s.firstSeenAgoSec !== null && s.firstSeenAgoSec <= maxAge) pendingAgeCheck++; return false; }
        return s.firstActivityAgoSec !== null && s.firstActivityAgoSec <= maxAge;
      })
      .sort((x, y) => (order[x.status] ?? 2) - (order[y.status] ?? 2) || y.tokensAnnounced - x.tokensAnnounced);
    return { list: all.slice(0, limit), total: all.length, pendingAgeCheck };
  }

  /**
   * New quote tokens from known issuers (Robinhood stock tokens), newest first. For each: how many
   * launches already use it as their pair, and which launch was first. pairs == 0 means the pair
   * is still open: nobody has launched against it yet.
   */
  stocks(chainId, opts = {}) {
    const chain = this.chain(chainId);
    if (!chain) return null;
    const reg = this.registries.get(chain.id);
    const head = this.#head(chain.id);
    const limit = Math.min(Math.max(1, Number.isFinite(opts.limit) ? opts.limit : 50), 300);
    const ago = (b) => (head && b != null ? Math.max(0, Math.round(((head - b) * chain.blockTimeMs) / 1000)) : null);
    // launches are counted from this index only: for a stock token listed before the index began,
    // earlier launches on its pair are invisible, so "zero launches" would be a false "open pair"
    const indexStart = this.sql.indexStart.get({ c: chain.id })?.b ?? null;
    // a stall gap that is not replayed yet hides launches too: anything listed before its end is incomplete
    const gapEnd = this.store.q.gapStats.get(chain.id)?.last ?? null;
    return this.store.q.stocks.all(chain.id, limit).map((s) => {
      const f = s.first_address ? this.store.q.getToken.get(chain.id, s.first_address) : null;
      const complete = indexStart !== null && s.block >= indexStart && (gapEnd === null || s.block > gapEnd);
      return {
        address: s.address, symbol: s.symbol, name: s.name, issuer: s.issuer,
        addedBlock: s.block, addedTx: s.tx, addedAgoSec: ago(s.block),
        // countComplete=false: listed before the index, so pairsLaunched is a lower bound
        pairsLaunched: s.pairs, countComplete: complete,
        open: complete ? s.pairs === 0 : null,
        firstLaunch: f ? {
          address: f.address, symbol: f.symbol, birthBlock: f.birth_block, birthAgoSec: ago(f.birth_block),
          launchpad: f.launchpad_id ? reg.launchpads.get(f.launchpad_id)?.name ?? f.launchpad_id : null,
          // only meaningful when every launch on the pair is indexed; otherwise the true first may be older
          secondsAfterListing: complete && f.birth_block != null ? Math.round(((f.birth_block - s.block) * chain.blockTimeMs) / 1000) : null,
          isTrueFirst: complete,
        } : null,
      };
    });
  }

  launchpads(chainId) {
    const chain = this.chain(chainId);
    if (!chain) return null;
    const reg = this.registries.get(chain.id);
    const counts = this.store.q.launchpadCounts.all(chain.id);
    return [...reg.launchpads.values()].map((lp) => ({
      ...lp,
      tokensIndexed: counts.filter((c) => c.launchpad_id === lp.id).reduce((s, c) => s + c.n, 0),
      factories: [...reg.byTopic0.values()].flat().filter((s) => s.launchpadId === lp.id)
        .flatMap((s) => [...s.emitters.entries()].map(([address, e]) => ({ address, event: s.signature, ...e }))),
    }));
  }

  status() {
    const now = Date.now();
    return [...this.chains.values()].map((c) => {
      const ix = this.indexers.get(c.id)?.status ?? null;
      const cur = this.store.q.getCursor.get(c.id) ?? null;
      const n = this.#counts(c.id);
      const g = this.store.q.gapStats.get(c.id);
      const rpc = this.rpcs.get(c.id);
      const sec = (ms) => (ms == null ? null : Math.round(ms / 1000));
      let indexer = null;
      if (ix) {
        const since = ix.lastProgressAt ?? ix.startedAt;
        const quietMs = now - since;
        // A long catch-up range can legitimately take a minute or two; failing with an error for two
        // minutes, or no cursor advance at all for five, is a stall.
        indexer = {
          head: ix.head, nextBlock: ix.next, lagBlocks: ix.lag,
          lagSeconds: ix.lag == null ? null : Math.round((ix.lag * c.blockTimeMs) / 1000),
          // no cursor advance for this long = stalled, whatever the head says
          stalled: quietMs > 300_000 || (Boolean(ix.lastError) && quietMs > 120_000),
          lastProgressAgoSec: sec(ix.lastProgressAt == null ? null : now - ix.lastProgressAt),
          discovery: ix.discovery, lastError: ix.lastError, errorForSec: sec(ix.errorSince == null ? null : now - ix.errorSince),
          diskFull: Boolean(ix.diskFull),
          platformsResolved: ix.platformsResolved ?? 0, agesProbed: ix.agesProbed ?? 0,
          // time spent on background work in the last caught-up cycle (live detection waits for it)
          lastMaintainMs: ix.lastMaintainMs ?? null, backgroundJobMs: ix.jobMs ?? null,
        };
      } else if (cur) {
        indexer = { head: cur.head, nextBlock: cur.next_block, lagBlocks: cur.head ? cur.head - cur.next_block : null, discovery: null, lastError: null };
      }
      return {
        id: c.id, name: c.name, slug: c.slug, blockTimeMs: c.blockTimeMs, explorer: c.explorer?.web ?? null,
        launchpadsInRegistry: this.registries.get(c.id).launchpads.size,
        tokensIndexed: n.tokens, tokensAttributed: n.attributed ?? 0,
        indexer,
        // blocks skipped by a stall, being replayed (newest first) for known launchpad events
        backfill: { gaps: g.n, blocksLeft: g.blocks, fromBlock: g.first, toBlock: g.last, launchesRecovered: ix?.backfilled ?? 0,
          skippedBlocks: ix?.replaySkippedBlocks ?? 0,
          etaHours: (() => {
            const r = ix?.replay;
            if (!g.blocks || !r?.blocks) return null;
            const perSec = r.blocks / Math.max(1, (now - r.since) / 1000);
            return Math.round((10 * g.blocks) / perSec / 3600) / 10;
          })() },
        // counters only: some providers put the account key in the URL, so it is never published
        rpc: rpc ? { custom: !c.publicRpc, ...rpc.stats } : null,
        explorerLookups: Boolean(process.env.ETHERSCAN_API_KEY || process.env.BLOCKSCOUT_API_KEY),
        stockTokens: (() => { const s = this.store.q.stockCount.get(c.id); return { tracked: (s.n ?? 0) - (s.rejected ?? 0), rejectedLookAlikes: s.rejected ?? 0 }; })(),
      };
    });
  }

  // counting tokens scans the table; the page asks every 15 s per visitor, so keep it for 10 s
  #counts(chainId) {
    const k = `counts:${chainId}`;
    return this.countCache.get(k) ?? this.countCache.set(k, this.store.q.counts.get(chainId));
  }

  /** Volume usage and how long it lasts at the current birth rate. */
  storage() {
    const s = this.store.storage.stats();
    let tokens = 0, last24h = 0;
    for (const c of this.chains.values()) {
      tokens += this.#counts(c.id).tokens ?? 0;
      // births by block, not by indexing time: a stall replay must not look like a surge (indexed range scan)
      const head = this.#head(c.id);
      if (head !== null) last24h += this.store.q.bornSinceBlock.get(c.id, head - Math.round((86400 * 1000) / c.blockTimeMs)).n ?? 0;
    }
    // pages freed by a migration or a prune sit inside the file and are reused first: not "used"
    const used = s.dbBytes === null ? null : s.dbBytes - (s.reusableBytes ?? 0) + (s.walBytes ?? 0);
    const perToken = used !== null && tokens > 0 ? Math.round(used / tokens) : null;
    const perDay = perToken !== null ? perToken * last24h : null;
    const minFree = Math.min(...[...this.chains.values()].map((c) => c.minFreeBytes ?? 0));
    const m = this.store.migration;
    return {
      dbBytes: s.dbBytes, walBytes: s.walBytes, reusableBytes: s.reusableBytes, volumeBytes: s.volumeBytes,
      fsFreeBytes: s.fsFreeBytes, freeBytes: s.freeBytes,
      usedPct: s.volumeBytes ? Math.round((1000 * (s.volumeBytes - (s.fsFreeBytes ?? 0))) / s.volumeBytes) / 10 : null,
      // room to write into (disk + reusable pages) below MIN_FREE_MB: the oldest evidence is being pruned
      low: s.freeBytes !== null && s.freeBytes < minFree,
      // free disk itself nearly gone: the WAL, a migration or an index build can fail even with
      // plenty of reusable pages inside the file, and pruning cannot help. Grow the volume.
      diskLow: s.fsFreeBytes !== null && s.fsFreeBytes < MIN_FS_FREE_BYTES,
      bytesPerToken: perToken, tokensBornLast24h: last24h,
      daysLeft: perDay && s.freeBytes !== null ? Math.round((10 * s.freeBytes) / perDay) / 10 : null,
      evidence: m.needed ? 'legacy text form (migration pending)' : 'compact',
      migrationError: m.lastError,
    };
  }

  /** /health: ok only when every indexer is moving and the disk has room. */
  health() {
    const chains = this.status();
    const storage = this.storage();
    const problems = [];
    for (const c of chains) {
      if (c.indexer?.diskFull) problems.push(`${c.slug}: disk full, indexing paused`);
      else if (c.indexer?.stalled) problems.push(`${c.slug}: no progress for ${c.indexer.lastProgressAgoSec ?? '?'} s${c.indexer.lastError ? ` (${c.indexer.lastError})` : ''}`);
    }
    if (storage.diskLow) problems.push(`storage: only ${Math.floor(storage.fsFreeBytes / 1048576)} MB free on the volume; grow it`);
    if (storage.low) problems.push('storage: free space below MIN_FREE_MB, old birth evidence is being pruned');
    if (storage.migrationError) problems.push(`storage: evidence migration: ${storage.migrationError}`);
    return { ok: problems.length === 0, problems, storage, chains };
  }
}
