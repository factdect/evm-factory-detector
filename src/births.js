// Records one token birth: enrich (code, metadata, receipt), attribute, persist.
// Shared by the indexer and by on-demand lookups so both apply the same rules.
import { matchKnownEvent, refsForToken } from './attribution.js';
import { enrichToken, fpColumns } from './enrich.js';
import { fingerprint } from './fingerprint.js';

const EIP1967_IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

export class BirthRecorder {
  constructor({ chain, rpc, registry, store, log = console }) {
    Object.assign(this, { chain, rpc, registry, store, log });
  }

  /**
   * @param match   result of matchKnownEvent, or null for a discovered birth
   * @param opts    { priority, requireReceipt }
   * @returns the saved token row, or null when a registry match pointed at a non-token
   */
  async record(token, block, txHash, source, match, opts = {}) {
    const { chain, rpc, registry, store } = this;
    const { fp, meta, receipt } = await enrichToken(rpc, chain, token, txHash, opts);
    // The hash came from a log, so a null receipt means a lagging backend: let the caller retry.
    if (txHash && !receipt && opts.requireReceipt) throw Object.assign(new Error(`receipt not available yet for ${txHash}`), { code: 'RECEIPT_PENDING' });
    if (fp.kind === 'empty') { // created and destroyed, or never a contract: nothing to describe
      if (block != null) store.q.markSeen.run(chain.id, token, block, 1);
      return null;
    }
    const logs = receipt?.logs ?? [];
    if (block == null && receipt?.blockNumber) block = Number(receipt.blockNumber);

    if (!match) {
      // A registry event sitting in a discovered token's birth receipt still counts.
      for (const l of logs) {
        const m = matchKnownEvent(registry, l);
        if (m && m.token === token) { match = m; source = source === 'explorer' ? source : 'registry-event'; break; }
      }
    }
    if (match) {
      // Guard against a wrong token slot in the registry: the address must behave like an ERC-20.
      if (meta.symbol == null && meta.decimals == null) {
        this.log.warn(`[${chain.slug}] registry event ${match.signature} from ${match.factory} points at ${token}, which is not an ERC-20. Check the token slot in registry/${chain.id}.json.`);
        return null;
      }
      if (match.confidence === 'unverified-emitter' && (await this.sameCodeAsKnownFactory(match, opts))) match.confidence = 'code-match';
    }

    let saved;
    store.db.transaction(() => {
      saved = store.saveToken({
        chain_id: chain.id, address: token, birth_block: block ?? null, birth_tx: txHash ?? null, birth_source: txHash ? source : null,
        launchpad_id: match?.launchpadId ?? null,
        confidence: match?.confidence ?? (txHash ? 'discovered' : 'none'),
        factory: match?.factory ?? null,
        factory_label: match?.factoryLabel ?? null,
        event_sig: match?.signature ?? null,
        event_fields: match ? JSON.stringify(match.fields) : null,
        family: match ? JSON.stringify(match.family) : null,
        ...fpColumns(fp), ...meta,
      });
      for (const r of refsForToken(logs, token)) store.q.addRef.run(chain.id, token, r.emitter, r.topic0, r.logIndex, block ?? 0);
      store.q.markSeen.run(chain.id, token, block ?? 0, 1);
    })();
    return saved;
  }

  /** Does an unlisted emitter run the same program as an allowlisted factory of that event family? */
  async sameCodeAsKnownFactory(m, opts = {}) {
    const theirs = await this.emitterKey(m.factory, opts);
    if (!theirs) return false;
    for (const spec of [...this.registry.byTopic0.values()].flat()) {
      if (spec.signature !== m.signature) continue;
      for (const addr of spec.emitters.keys()) if ((await this.emitterKey(addr, opts)) === theirs) return true;
    }
    return false;
  }

  async emitterKey(address, opts = {}) {
    const { chain, rpc, store } = this;
    const cached = store.q.getEmitter.get(chain.id, address);
    if (cached) return cached.fp_key;
    let fp = fingerprint(await rpc.call('eth_getCode', [address, 'latest'], opts));
    if (fp.kind === 'eip1967-proxy') {
      // Compare what actually runs: the implementation behind the proxy.
      const slot = await rpc.call('eth_getStorageAt', [address, EIP1967_IMPL_SLOT, 'latest'], opts);
      const impl = '0x' + slot.slice(26);
      if (!/^0x0{40}$/.test(impl)) fp = fingerprint(await rpc.call('eth_getCode', [impl, 'latest'], opts));
    }
    // Skeleton, not exact hash: two deployments of one factory differ in constructor immutables.
    store.q.putEmitter.run(chain.id, address, fp.size, fp.key, Math.floor(Date.now() / 1000));
    return fp.key;
  }
}

/**
 * After a registry edit: re-attribute tokens we already hold evidence for. Uses the stored
 * (emitter, topic0) pairs from each birth receipt, so it costs no RPC calls. Runs on boot.
 */
export function reattributeFromEvidence(store, registry, chainId) {
  const rows = store.db.prepare(`SELECT t.address, r.emitter, r.topic0 FROM tokens t
    JOIN birth_refs r ON r.chain_id = t.chain_id AND r.token = t.address
    WHERE t.chain_id = ? AND t.launchpad_id IS NULL ORDER BY r.log_index`).all(chainId);
  let n = 0;
  const done = new Set();
  store.db.transaction(() => {
    for (const row of rows) {
      if (done.has(row.address)) continue;
      const specs = registry.byTopic0.get(row.topic0);
      const hit = specs?.find((s) => s.emitters.has(row.emitter));
      if (!hit) continue;
      const entry = hit.emitters.get(row.emitter);
      store.saveToken({
        chain_id: chainId, address: row.address, launchpad_id: hit.launchpadId,
        confidence: entry.status === 'confirmed' ? 'verified' : 'observed-emitter',
        factory: row.emitter, factory_label: entry.label ?? null, event_sig: hit.signature,
        family: JSON.stringify([...new Set(specs.map((s) => s.launchpadId))]),
      });
      done.add(row.address);
      n++;
    }
  })();
  return n;
}
