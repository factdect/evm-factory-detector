// Turns index rows into the public JSON. The lookup page renders exactly this JSON.
import { INFRA_ADDRESSES, INFRA_TOPICS } from './attribution.js';
import { BirthRecorder } from './births.js';
import { enrichToken, fpColumns } from './enrich.js';
import { findCreation } from './explorer.js';

const VERDICTS = {
  verified: ['Verified factory', 'A creation event from an address the launchpad publishes as its factory names this token.'],
  'observed-emitter': ['Observed factory', 'The creation event comes from a factory we identified on-chain. The launchpad has not published this address.'],
  'code-match': ['Same code, unlisted address', 'The emitter runs the same program as a listed factory but sits at an address nobody has published. It can be a new generation or a third-party redeploy.'],
  'unverified-emitter': ['Look-alike event', 'The event signature matches a known launchpad, but the emitter is not one of its published factories. Several launchpads share signatures and anyone can emit one.'],
  discovered: ['Unlisted factory', 'No launchpad in the registry claims this token. A contract that has announced several tokens of one template did, which is what a factory looks like.'],
  'discovered-first': ['First sighting', 'The contract that announced this token has announced no other token in this index. A one-off deployer and a brand-new factory look identical until the second token.'],
  'discovered-silent': ['No factory event', 'The contract appeared and minted in one transaction, and no other contract announced it. Deployed directly, or by a factory that emits nothing.'],
  'bytecode-cluster': ['Bytecode match only', 'The birth transaction is not indexed. The bytecode matches a template used by a known launchpad, which shows the template, not who deployed it.'],
  none: ['No birth record', 'This index holds no birth transaction for the token: it was created before indexing started, or in the last few seconds. With an explorer key configured, older tokens are traced on demand.'],
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
    this.listCache = new TtlCache(30_000, 100);
    this.inflight = new Map();
    const db = store.db;
    this.sql = {
      // first sighting over all time (index-only MIN), activity over the stats window
      emitterFirst: db.prepare('SELECT MIN(block) AS first_block FROM birth_refs WHERE chain_id = ? AND emitter = ?'),
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
        WHERE r.chain_id = ? AND r.block >= ? AND t.is_lp = 0 GROUP BY r.emitter ORDER BY births DESC LIMIT 200`),
      emitterTopics: db.prepare(`SELECT topic0, COUNT(*) AS n FROM birth_refs WHERE chain_id = ? AND emitter = ? AND block >= ? GROUP BY topic0 ORDER BY n DESC LIMIT 5`),
      sampleTokens: db.prepare(`SELECT token FROM birth_refs WHERE chain_id = ? AND emitter = ? AND block >= ? GROUP BY token ORDER BY MAX(block) DESC LIMIT 3`),
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
    const s = this.sql.emitterStats.get(chainId, emitter, since);
    const top = this.sql.emitterTopCluster.get(chainId, emitter, since);
    return this.emitterCache.set(k, {
      births: s.births, firstBlock: this.sql.emitterFirst.get(chainId, emitter)?.first_block ?? null, lastBlock: s.last_block,
      // share of this emitter's tokens that use one bytecode template: ~1.0 for a factory, low for shared plumbing
      purity: s.births && top ? Number((top.n / s.births).toFixed(3)) : null,
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

  #announcers(chainId, token) {
    const rows = this.store.q.refsOf.all(chainId, token);
    const byEmitter = new Map();
    for (const r of rows) {
      const c = this.#classify(chainId, r.emitter, r.topic0);
      const prev = byEmitter.get(r.emitter);
      const rank = { registry: 4, 'look-alike': 3, unlisted: 2, companion: 1, infra: 0 }[c.role];
      if (!prev || rank > prev.rank) byEmitter.set(r.emitter, { emitter: r.emitter, topic0: r.topic0, logIndex: r.log_index, rank, ...c, ...this.#emitterInfo(chainId, r.emitter) });
    }
    // A factory announces many tokens of one template. Per-launch helper contracts announce one.
    const list = [...byEmitter.values()];
    // Next to a contract that announces many tokens, a contract that announced only this one
    // is a per-launch helper (its bonding curve, its tax processor), not a rival factory.
    const hasSerial = list.some((a) => a.births >= 2 && a.role !== 'infra');
    for (const a of list) if (a.role === 'unlisted' && a.births < 2 && hasSerial) { a.role = 'helper'; a.rank = 1; }
    return list.sort((a, b) =>
      b.rank - a.rank || Number((b.purity ?? 0) >= 0.8) - Number((a.purity ?? 0) >= 0.8) || b.births - a.births || a.logIndex - b.logIndex,
    ).map(({ rank, ...a }) => a);
  }

  #cluster(chainId, fpKey) {
    if (!fpKey) return null;
    const reg = this.registries.get(chainId);
    const rows = this.store.q.cluster.all(chainId, fpKey);
    const size = rows.reduce((s, r) => s + r.n, 0);
    return {
      key: fpKey, size,
      launchpads: rows.map((r) => ({ id: r.launchpad_id || null, name: r.launchpad_id ? reg.launchpads.get(r.launchpad_id)?.name ?? r.launchpad_id : 'unattributed', tokens: r.n, share: Number((r.n / size).toFixed(3)) })),
    };
  }

  #shape(chain, row, { adhoc = false } = {}) {
    const reg = this.registries.get(chain.id);
    const lp = row.launchpad_id ? reg.launchpads.get(row.launchpad_id) ?? { id: row.launchpad_id, name: row.launchpad_id } : null;
    const announcers = adhoc ? [] : this.#announcers(chain.id, row.address);
    const cluster = this.#cluster(chain.id, row.fp_key);
    const primary = announcers.find((a) => a.role === 'unlisted' || a.role === 'look-alike' || a.role === 'registry') ?? null;

    let code = row.confidence ?? 'none';
    let likely = null;
    if (code === 'discovered' && !primary) code = 'discovered-silent';
    else if (code === 'discovered' && primary.births < 2) code = 'discovered-first';
    if (code === 'none' && cluster) {
      const top = cluster.launchpads[0];
      if (top?.id && top.share >= 0.9 && top.tokens >= 5) { code = 'bytecode-cluster'; likely = { id: top.id, name: top.name, share: top.share, tokens: top.tokens }; }
    }
    const [headline, detail] = VERDICTS[code] ?? VERDICTS.none;
    const factoryAddr = row.factory ?? (code === 'discovered' || code === 'discovered-first' ? primary?.emitter : null) ?? null;
    const fstats = factoryAddr ? this.#emitterInfo(chain.id, factoryAddr) : null;
    const head = this.#head(chain.id);
    const known = reg.factoryOf.get(row.address) ?? reg.companionOf.get(row.address) ?? null;

    return {
      schema: 1,
      chain: { id: chain.id, name: chain.name },
      // set when someone pastes a launchpad's own contract instead of a token
      knownContract: known ? { launchpad: reg.launchpads.get(known.launchpadId)?.name ?? known.launchpadId, role: known.label } : null,
      token: { address: row.address, name: row.name, symbol: row.symbol, decimals: row.decimals, totalSupply: row.total_supply },
      verdict: { code, headline, detail },
      launchpad: lp ? { id: lp.id, name: lp.name, url: lp.url ?? null, stack: lp.stack ?? null } : null,
      likelyLaunchpad: likely,
      factory: factoryAddr ? {
        address: factoryAddr, label: row.factory_label ?? primary?.label ?? null, event: row.event_sig ?? primary?.event ?? null,
        eventFields: row.event_fields ? JSON.parse(row.event_fields) : null,
        sharesSignatureWith: row.family ? JSON.parse(row.family).filter((id) => id !== row.launchpad_id).map((id) => reg.launchpads.get(id)?.name ?? id) : [],
        tokensAnnounced: fstats?.births ?? null, statsWindowBlocks: chain.statsWindowBlocks, firstSeenBlock: fstats?.firstBlock ?? null,
        firstSeenAgoSec: fstats?.firstBlock && head ? Math.max(0, Math.round(((head - fstats.firstBlock) * chain.blockTimeMs) / 1000)) : null,
      } : null,
      birth: row.birth_tx ? {
        block: row.birth_block, tx: row.birth_tx, source: row.birth_source,
        explorerUrl: chain.explorer?.web ? `${chain.explorer.web}/tx/${row.birth_tx}` : null,
      } : null,
      bytecode: {
        size: row.code_size, kind: row.fp_kind, implementation: row.impl,
        upgradeable: row.upgradeable === null || row.upgradeable === undefined ? null : Boolean(row.upgradeable),
        exactHash: row.fp_exact, cluster,
        note: row.fp_kind === 'minimal-proxy'
          ? 'Minimal clone: the implementation address is hardcoded in the bytecode and cannot be changed. Generic scanners still report it as a proxy.'
          : row.fp_kind === 'eip1967-proxy' ? 'EIP-1967 proxy: whoever controls the admin or implementation can change the logic.' : null,
      },
      announcers,
      indexedAt: row.created_at ?? null,
    };
  }

  /** True when answering costs no RPC call (indexed or cached), so the rate limiter can skip it. */
  isCheap(chainId, address) {
    const a = address.toLowerCase();
    return Boolean(this.store.q.getToken.get(Number(chainId), a)) || this.adhocCache.get(`${Number(chainId)}:${a}`) !== undefined;
  }

  /** Main entry. Indexed tokens cost no RPC calls; unknown ones cost 1 batch (+1 explorer call). */
  async token(chainId, address) {
    const chain = this.chain(chainId);
    if (!chain) return { status: 404, body: { error: 'unknown_chain', message: `Chain ${chainId} is not configured here.`, chains: [...this.chains.keys()] } };
    const addr = address.toLowerCase();
    const row = this.store.q.getToken.get(chain.id, addr);
    if (row) return { status: 200, body: this.#shape(chain, row) };

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
    return { status: 200, body: this.#shape(chain, row, { adhoc: true }) };
  }

  recent(chainId, limit = 50) {
    const chain = this.chain(chainId);
    if (!chain) return null;
    const reg = this.registries.get(chain.id);
    return this.store.q.recent.all(chain.id, Math.min(Math.max(1, limit), 200)).map((r) => ({
      address: r.address, symbol: r.symbol, name: r.name, birthBlock: r.birth_block, birthTx: r.birth_tx,
      launchpad: r.launchpad_id ? reg.launchpads.get(r.launchpad_id)?.name ?? r.launchpad_id : null,
      confidence: r.confidence, factory: r.factory, codeSize: r.code_size, bytecodeKind: r.fp_kind, cluster: r.fp_key,
    }));
  }

  /** The detector: contracts that keep announcing newborn tokens but are not in the registry. */
  candidates(chainId) {
    const chain = this.chain(chainId);
    if (!chain) return null;
    const hit = this.listCache.get(`cand:${chain.id}`);
    if (hit) return hit;
    const out = [];
    const since = this.#since(chain.id);
    for (const e of this.sql.emitters.all(chain.id, since)) {
      const topics = this.sql.emitterTopics.all(chain.id, e.emitter, since);
      const classes = topics.map((t) => this.#classify(chain.id, e.emitter, t.topic0));
      if (classes.some((c) => c.role === 'registry' || c.role === 'companion')) continue; // already published
      const info = this.#emitterInfo(chain.id, e.emitter);
      let status = 'new';
      if (classes.every((c) => c.role === 'infra')) status = 'dex-plumbing';
      else if (e.known_launchpads >= 2) status = 'shared-plumbing';
      else if (e.known_launchpads === 1 && e.known_births / e.births >= 0.9) status = `companion-of:${e.launchpads}`;
      else if (classes.some((c) => c.role === 'look-alike')) status = 'look-alike';
      if (e.births < 2 && status !== 'look-alike') continue; // per-launch helper contracts and one-off deployers
      out.push({
        emitter: e.emitter, status, tokensAnnounced: e.births, alreadyAttributed: e.known_births, templatePurity: info.purity,
        eventTypes: e.event_types, topEvents: topics.map((t, i) => ({ topic0: t.topic0, count: t.n, label: classes[i].label })),
        firstSeenBlock: e.first_block, lastSeenBlock: e.last_block,
        sampleTokens: this.sql.sampleTokens.all(chain.id, e.emitter, since).map((r) => r.token),
      });
    }
    const order = { new: 0, 'look-alike': 1 };
    out.sort((a, b) => (order[a.status] ?? 2) - (order[b.status] ?? 2) || b.tokensAnnounced - a.tokensAnnounced);
    return this.listCache.set(`cand:${chain.id}`, out.slice(0, 60));
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
    return [...this.chains.values()].map((c) => {
      const ix = this.indexers.get(c.id)?.status ?? null;
      const cur = this.store.q.getCursor.get(c.id) ?? null;
      const n = this.store.q.counts.get(c.id);
      return {
        id: c.id, name: c.name, slug: c.slug, blockTimeMs: c.blockTimeMs, explorer: c.explorer?.web ?? null,
        launchpadsInRegistry: this.registries.get(c.id).launchpads.size,
        tokensIndexed: n.tokens, tokensAttributed: n.attributed ?? 0,
        indexer: ix ? { head: ix.head, nextBlock: ix.next, lagBlocks: ix.lag, discovery: ix.discovery, lastError: ix.lastError }
          : cur ? { head: cur.head, nextBlock: cur.next_block, lagBlocks: cur.head ? cur.head - cur.next_block : null, discovery: null, lastError: null } : null,
        explorerLookups: Boolean(process.env.BLOCKSCOUT_API_KEY),
      };
    });
  }
}
