// Records one token birth: enrich (code, metadata, receipt), attribute, persist.
// Shared by the indexer and by on-demand lookups so both apply the same rules.
import { matchKnownEvent, pad32, platformCall, refsForToken, resolvePlatform, TRANSFER_TOPIC, ZERO_TOPIC } from './attribution.js';
import { enrichToken, fpColumns } from './enrich.js';
import { fingerprint } from './fingerprint.js';

const EIP1967_IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

const V4_INITIALIZE = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
const ZERO_ADDR = '0x' + '0'.repeat(40);

/**
 * Facts that say who actually made the token, as opposed to who merely mentioned it:
 *   txTo    the contract the deployer called
 *   mintTo  who received the first mint (a factory usually mints to itself or to its curve)
 *   v4Hook  the hook of the Uniswap v4 pool opened for this token in the same transaction.
 *           A hook names the token in its events but is pool machinery, not the factory.
 */
export function birthFacts(receipt, token) {
  const t = token.toLowerCase();
  const needle = pad32(t);
  let mintTo = null, v4Hook = null;
  for (const l of receipt?.logs ?? []) {
    const topics = (l.topics ?? []).map((x) => x.toLowerCase());
    if (!mintTo && l.address?.toLowerCase() === t && topics[0] === TRANSFER_TOPIC && topics[1] === ZERO_TOPIC && topics.length === 3) mintTo = '0x' + topics[2].slice(26);
    if (!v4Hook && topics[0] === V4_INITIALIZE && (topics[2] === needle || topics[3] === needle)) {
      const hook = '0x' + (l.data ?? '0x').slice(2).slice(128 + 24, 192).toLowerCase();
      if (hook.length === 42 && hook !== ZERO_ADDR) v4Hook = hook;
    }
  }
  return { txTo: receipt?.to ? receipt.to.toLowerCase() : null, mintTo, v4Hook };
}

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
      if (match.platform) {
        // a protocol launch: which app launched it decides the launchpad
        const [res] = await rpc.batch([platformCall(match, token)], opts);
        const r = resolvePlatform(match, res?.result ?? '0x');
        Object.assign(match, { launchpadId: r.launchpadId, confidence: r.confidence, platformAddr: r.platform, factoryLabel: r.label ?? match.factoryLabel });
      }
    }

    const facts = birthFacts(receipt, token);
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
        tx_to: facts.txTo, mint_to: facts.mintTo, v4_hook: facts.v4Hook, platform: match?.platformAddr ?? null,
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
      // protocol emitters get their app from a call; leave it to the idle-time platform probe
      if (hit.platform) {
        store.saveToken({ chain_id: chainId, address: row.address, launchpad_id: hit.launchpadId, confidence: 'verified', factory: row.emitter,
          factory_label: hit.emitters.get(row.emitter).label ?? null, event_sig: hit.signature, family: JSON.stringify([...new Set(specs.map((s) => s.launchpadId))]) });
        done.add(row.address); n++; continue;
      }
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

/**
 * Idle-time job: read the launching app for tokens attributed through a protocol event before
 * this check existed (or whose record-time call failed). Also moves old rows that were credited
 * to a launchpad from the protocol event alone to wherever their integrator actually points.
 */
export async function probePendingPlatforms({ chain, rpc, registry, store, max = 36 }) {
  let n = 0;
  for (const specs of registry.byTopic0.values()) {
    for (const spec of specs) {
      if (!spec.platform) continue;
      for (const [emitter, entry] of spec.emitters) {
        const rows = store.q.platformPending.all(chain.id, emitter, spec.signature, max - n);
        if (!rows.length) continue;
        const match = { platform: spec.platform, factory: emitter, launchpadId: spec.launchpadId };
        const res = await rpc.batch(rows.map((r) => platformCall(match, r.address)));
        store.db.transaction(() => {
          rows.forEach((r, i) => {
            if (res[i]?.error) return; // retry next time
            const p = resolvePlatform(match, res[i]?.result ?? '0x');
            store.q.setPlatform.run(p.platform, p.launchpadId, p.confidence, p.label ?? entry.label ?? null, chain.id, r.address);
          });
        })();
        n += rows.length;
        if (n >= max) return n;
      }
    }
  }
  return n;
}
