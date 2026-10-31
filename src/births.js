// Records one token birth: enrich (code, metadata, receipt), attribute, persist.
// Shared by the indexer and by on-demand lookups so both apply the same rules.
import { birthAllocations, checkAllocations, checkVanity, claimPlacement, claimResult, judgeClaim, matchKnownEvent, pad32, parseClaim, platformCall, platformNeedsSender, premintFacts, refsForToken, resolvePlatform, senderCodeCall, storedPremint, TRANSFER_TOPIC, ZERO_TOPIC } from './attribution.js';
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
  return { txTo: receipt?.to ? receipt.to.toLowerCase() : null, txFrom: receipt?.from ? receipt.from.toLowerCase() : null, mintTo, v4Hook };
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
        // A protocol launch: which app launched it decides the launchpad. The integrator field is
        // self-declared, so the claim is judged by the launch sender (against the app's known
        // wallets) and by what was minted at birth (against the app's allocation policy).
        const sender = receipt?.from ? receipt.from.toLowerCase() : null;
        const calls = [platformCall(match, token)];
        if (sender && platformNeedsSender(match)) calls.push(senderCodeCall(sender));
        const res = await rpc.batch(calls, opts);
        const r = resolvePlatform(match, res[0]?.result ?? '0x', sender, res[1]?.result ?? null, receipt ? premintFacts(receipt, token) : undefined, meta.total_supply ?? null, token);
        Object.assign(match, { launchpadId: r.launchpadId, confidence: r.confidence, platformAddr: r.platform, factoryLabel: r.label ?? match.factoryLabel,
          claimedLaunchpadId: r.claimedLaunchpadId, claimCheck: r.claimCheck });
      }
    }

    const facts = birthFacts(receipt, token);
    // Doppler announces its allocations as events; other launchpads simply mint them at birth
    const premint = premintFacts(receipt, token) ?? (receipt && match && !match.platform ? birthAllocations(receipt, token, registry) : null);
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
        tx_from: facts.txFrom, claim_app: match?.claimedLaunchpadId ?? null, claim_check: match?.claimCheck ?? null,
        // '{}' = receipt read, nothing minted outside the sale; NULL = receipt not read
        premint: premint ? JSON.stringify(premint) : receipt ? '{"v":3}' : null,
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
  // a token recorded as unlisted had its birth read without counting allocations (that needs the
  // launch event): clear the facts so the lookup reads them again as a registry launch
  const clearFacts = store.db.prepare('UPDATE tokens SET premint = NULL WHERE chain_id = ? AND address = ?');
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
      clearFacts.run(chainId, row.address);
      done.add(row.address);
      n++;
    }
  })();
  return n;
}

/**
 * On boot: pre-mint facts stored as v2 (update-18 to 20) counted the mint into a launch's per-token
 * sale contract (Pons v2's curve, a pool) as an allocation unlocked at launch: every Pons v2 token
 * read "100% of the supply was minted outside the sale". For launchpads whose launch event names that
 * contract (a `sale` field), clear the v2 rows that list allocations. They show no pre-mint until a
 * lookup reads their birth receipt again (v3). Idempotent: nothing matches once they are rewritten.
 */
export function resetSaleMintFacts(store, registry, chainId) {
  const clear = store.db.prepare(`UPDATE tokens SET premint = NULL WHERE chain_id = ? AND factory = ?
    AND premint LIKE '%"v":2%' AND premint LIKE '%"allocations"%'`);
  let n = 0;
  store.db.transaction(() => {
    for (const specs of registry.byTopic0.values()) {
      for (const s of specs) {
        if (!s.saleFields?.length || s.platform) continue;
        for (const emitter of s.emitters.keys()) n += clear.run(chainId, emitter).changes;
      }
    }
  })();
  return n;
}

/**
 * On boot: judge stored claims again against the registry as it is now, from stored facts only (no
 * RPC). A wallet added to an app's `senders`, or an allocation option added to (or removed from)
 * its policy, takes effect on rows already indexed. The EIP-7702 half of the wallet check needs the
 * sender's code, so a stored result for it is kept. Returns the number of rows that changed.
 */
export function rejudgeStoredClaims(store, registry, chainId) {
  let n = 0;
  store.db.transaction(() => {
    for (const spec of registry.platformSpecs ?? []) {
      for (const [platform, k] of spec.platform.known) {
        const rows = store.q.claimRows.all(chainId, spec.factory, platform);
        for (const r of rows) {
          const prev = parseClaim(r.claim_check);
          const sender = r.tx_from ? r.tx_from.toLowerCase() : null;
          const wallet = !k.wallets ? null : sender && k.wallets.senders.has(sender) ? 'verified'
            : prev?.wallet && prev.wallet !== 'unverified' ? prev.wallet : 'unverified';
          const allocations = checkAllocations(k.allocations, storedPremint(r.premint, r.tx_from), r.total_supply ?? null);
          const vanity = checkVanity(k.vanity, r.address);
          const result = claimResult(wallet, allocations, vanity);
          const claim = result === null ? null : { result, wallet, allocations, ...(vanity ? { vanity } : {}) };
          const { launchpadId, confidence } = claimPlacement(k, spec.launchpadId, claim);
          const claimCheck = claim ? JSON.stringify(claim) : null;
          if (claimCheck === (r.claim_check ?? null) && launchpadId === r.launchpad_id && confidence === r.confidence && r.claim_app === k.launchpad) continue;
          store.q.setClaim.run(launchpadId, confidence, k.launchpad, claimCheck, chainId, r.address);
          n++;
        }
      }
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
        const rows = store.q.platformPending.all(chain.id, emitter, spec.signature, max - n).map((r) => ({ ...r, premintObj: storedPremint(r.premint, r.tx_from) }));
        if (!rows.length) continue;
        const match = { platform: spec.platform, factory: emitter, launchpadId: spec.launchpadId };
        const needSender = platformNeedsSender(match);
        const res = await rpc.batch(rows.map((r) => platformCall(match, r.address)));
        // the sender's code, for rows that recorded their sender (older rows did not: their claim stays unverified)
        const withSender = needSender ? rows.map((r, i) => [i, r]).filter(([, r]) => r.tx_from) : [];
        const codes = withSender.length ? await rpc.batch(withSender.map(([, r]) => senderCodeCall(r.tx_from))) : [];
        const codeOf = new Map(withSender.map(([i], j) => [i, codes[j]?.result ?? null]));
        store.db.transaction(() => {
          rows.forEach((r, i) => {
            if (res[i]?.error) return; // retry next time
            const p = resolvePlatform(match, res[i]?.result ?? '0x', r.tx_from ?? null, codeOf.get(i) ?? null, r.premintObj, r.total_supply ?? null, r.address);
            store.q.setPlatform.run(p.platform, p.launchpadId, p.confidence, p.label ?? entry.label ?? null, p.claimedLaunchpadId ?? null, p.claimCheck ?? null, chain.id, r.address);
          });
        })();
        n += rows.length;
        if (n >= max) return n;
      }
    }
  }
  return n;
}

/**
 * Idle-time job: tokens attributed through a protocol event before the sender and pre-mint columns
 * existed. Reads their birth receipts (newest first, a few per cycle), stores the sender and the
 * pre-mint facts, and checks the sender against the claimed app's wallets. Returns rows completed.
 */
export async function probePendingBirthFacts({ chain, rpc, registry, store, max = 8, sinceBlock = 0 }) {
  let n = 0;
  for (const specs of registry.byTopic0.values()) {
    for (const spec of specs) {
      if (!spec.platform) continue;
      for (const [emitter] of spec.emitters) {
        const rows = store.q.premintPending.all(chain.id, emitter, sinceBlock, max - n);
        if (!rows.length) continue;
        const rcs = await rpc.batch(rows.map((r) => ({ method: 'eth_getTransactionReceipt', params: [r.birth_tx] })));
        const senders = rows.map((r, i) => (rcs[i]?.result?.from ? rcs[i].result.from.toLowerCase() : null));
        const known = rows.map((r) => (r.platform ? spec.platform.known.get(r.platform) : null));
        const need = rows.map((r, i) => [i, senders[i]]).filter(([i, s_]) => s_ && known[i]?.wallets);
        const judged = (k, i, premint, supply) => judgeClaim(k, senders[i], codeOf.get(i) ?? null, premint, supply, rows[i].address);
        const codes = need.length ? await rpc.batch(need.map(([, s_]) => senderCodeCall(s_))) : [];
        const codeOf = new Map(need.map(([i], j) => [i, codes[j]?.result ?? null]));
        store.db.transaction(() => {
          rows.forEach((r, i) => {
            const receipt = rcs[i]?.result;
            if (!receipt) return; // retry next time
            const premint = premintFacts(receipt, r.address);
            store.q.setBirthFacts.run(senders[i], premint ? JSON.stringify(premint) : '{}', chain.id, r.address);
            const k = known[i];
            if (k && (k.wallets || k.allocations || k.vanity)) {
              const claim = judged(k, i, premint, r.total_supply ?? null);
              const { launchpadId, confidence } = claimPlacement(k, spec.launchpadId, claim);
              store.q.setClaim.run(launchpadId, confidence, k.launchpad, claim ? JSON.stringify(claim) : null, chain.id, r.address);
            }
            n++;
          });
        })();
        if (n >= max) return n;
      }
    }
  }
  return n;
}
