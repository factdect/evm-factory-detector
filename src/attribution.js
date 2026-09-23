// Attribution = "which launchpad's factory emitted a creation event for this token?"
//
// Trust model (this is the whole point of the tool):
//   verified            topic0 matches AND the emitter is on the launchpad's allowlist.
//   observed-emitter    same, but the allowlist entry is one we found on-chain ourselves
//                       (status "observed"), not one the launchpad has published.
//   code-match          topic0 matches, emitter is NOT allowlisted, but its bytecode is
//                       identical to an allowlisted factory. New generation OR a third-party
//                       redeploy of the same (often open-source) factory code.
//   unverified-emitter  topic0 matches, unknown emitter, different code. Anyone can emit a
//                       look-alike event, so never present this as the launchpad.
//   discovered          no registry match; we list the contracts that emitted events
//                       referencing the token in its birth transaction.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFunctionResult, encodeFunctionData, parseAbiItem, toEventSelector } from 'viem';

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const ZERO_TOPIC = '0x' + '0'.repeat(64);

// DEX-level events that reference a new token in almost every launch on any EVM chain.
// They are real, but they are shared plumbing, not the launchpad. Keyed by topic0 so
// the list is chain-agnostic.
const INFRA_SIGNATURES = {
  'PairCreated(address,address,address,uint256)': 'Uniswap v2-style factory',
  'PoolCreated(address,address,uint24,int24,address)': 'Uniswap v3-style factory',
  'Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)': 'Uniswap v4 PoolManager',
  'Transfer(address,address,uint256)': 'ERC-20/721 transfer',
  'Approval(address,address,uint256)': 'ERC-20 approval',
  'OwnershipTransferred(address,address)': 'Ownable',
  'Swap(address,uint256,uint256,uint256,uint256,address)': 'Uniswap v2-style pool',
  'Sync(uint112,uint112)': 'Uniswap v2-style pool',
  'Mint(address,uint256,uint256)': 'Uniswap v2-style pool',
  'Swap(address,address,int256,int256,uint160,uint128,int24)': 'Uniswap v3-style pool',
  'Mint(address,address,int24,int24,uint128,uint256,uint256)': 'Uniswap v3-style pool',
  'Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)': 'Uniswap v4 PoolManager',
  'ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)': 'Uniswap v4 PoolManager',
  'Approval(address,address,address,uint160,uint48)': 'Permit2 allowance',
  'Permit(address,address,address,uint160,uint48,uint48)': 'Permit2 allowance',
};
// Canonical same-address-on-every-chain contracts that show up in launch transactions.
export const INFRA_ADDRESSES = new Map([
  ['0x000000000022d473030f116ddee9f6b43ac78ba3', 'Permit2'],
  ['0xca11bde05977b3631167028862be2a173976ca11', 'Multicall3'],
  ['0x4e59b44847b379578588920ca78fbf26c0b4956c', 'CREATE2 deployer'],
  ['0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789', 'ERC-4337 EntryPoint v0.6'],
  ['0x0000000071727de22e5e9d8baf0edac6f37da032', 'ERC-4337 EntryPoint v0.7'],
]);
export const INFRA_TOPICS = new Map(
  Object.entries(INFRA_SIGNATURES).map(([sig, label]) => [toEventSelector(sig), label]),
);

const lc = (s) => (typeof s === 'string' ? s.toLowerCase() : s);
export const pad32 = (addr) => '0x' + '0'.repeat(24) + lc(addr).slice(2);

const REGISTRY_DIR = fileURLToPath(new URL('../registry', import.meta.url));

export function loadRegistry(chainId, dir = process.env.REGISTRY_DIR || REGISTRY_DIR) {
  const file = path.join(dir, `${chainId}.json`);
  const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { chainId, launchpads: [] };
  const byTopic0 = new Map();
  const launchpads = new Map();
  const factoryOf = new Map();   // allowlisted emitter -> { launchpadId, label }
  const companionOf = new Map(); // other published contracts of a launchpad -> { launchpadId, label }
  for (const lp of raw.launchpads ?? []) {
    for (const c of lp.contracts ?? []) companionOf.set(lc(c.address), { launchpadId: lp.id, label: c.label ?? null });
    launchpads.set(lp.id, { id: lp.id, name: lp.name, url: lp.url ?? null, stack: lp.stack ?? null });
    for (const ev of lp.events ?? []) {
      const topic0 = toEventSelector(ev.signature);
      const emitters = new Map((ev.emitters ?? []).map((e) => [lc(e.address), { label: e.label ?? null, status: e.status ?? 'confirmed', source: e.source ?? null }]));
      for (const [addr, e] of emitters) factoryOf.set(addr, { launchpadId: lp.id, label: e.label });
      const platform = ev.platform ? {
        abi: [parseAbiItem(ev.platform.call)], field: ev.platform.field, name: ev.platform.name ?? 'platform',
        known: new Map(Object.entries(ev.platform.known ?? {}).map(([a, v]) => [lc(a), v])),
      } : null;
      const spec = { launchpadId: lp.id, signature: ev.signature, topic0, token: ev.token, fields: ev.fields ?? {}, emitters, platform };
      if (!byTopic0.has(topic0)) byTopic0.set(topic0, []);
      byTopic0.get(topic0).push(spec);
    }
  }
  // contracts that issue *quote* tokens (e.g. Robinhood stock tokens), watched separately
  const quoteIssuers = (raw.quoteIssuers ?? []).map((q) => ({ ...q, factory: lc(q.factory), beacon: lc(q.beacon), topic0: lc(q.topic0) }));
  // creation events that carry a platform resolver, with the factory to call (for live lookups of unindexed tokens)
  const platformSpecs = [...byTopic0.values()].flat().filter((s) => s.platform).flatMap((s) => [...s.emitters.keys()].map((factory) => ({ ...s, factory })));
  return { chainId, launchpads, byTopic0, topic0s: [...byTopic0.keys()], factoryOf, companionOf, quoteIssuers, platformSpecs };
}

function readSlot(log, where) {
  if (!where) return null;
  let word;
  if (where.from === 'topic') word = log.topics?.[where.index];
  else if (where.from === 'data') {
    const d = log.data?.slice(2) ?? '';
    const s = d.slice(where.word * 64, where.word * 64 + 64);
    word = s.length === 64 ? '0x' + s : null;
  }
  return word ? lc(word) : null;
}
const asAddress = (word) => (word && /^0x0{24}[0-9a-f]{40}$/.test(word) ? '0x' + word.slice(26) : null);

/** Match one log against the registry. Returns null when topic0 is not a known creation event. */
export function matchKnownEvent(registry, log) {
  const specs = registry.byTopic0.get(lc(log.topics?.[0]));
  if (!specs) return null;
  const emitter = lc(log.address);
  const hit = specs.find((s) => s.emitters.has(emitter));
  const spec = hit ?? specs[0];
  const token = asAddress(readSlot(log, spec.token));
  if (!token) return null;
  const fields = {};
  for (const [name, where] of Object.entries(spec.fields)) {
    const w = readSlot(log, where);
    fields[name] = asAddress(w) ?? w;
  }
  const entry = hit ? hit.emitters.get(emitter) : null;
  return {
    token,
    launchpadId: hit ? hit.launchpadId : null,
    confidence: hit ? (entry.status === 'confirmed' ? 'verified' : 'observed-emitter') : 'unverified-emitter',
    factory: emitter,
    factoryLabel: entry?.label ?? null,
    signature: spec.signature,
    fields,
    family: [...new Set(specs.map((s) => s.launchpadId))], // launchpads that use this event signature
    platform: hit?.platform ?? null, // protocol emitters: the launching app is resolved by a call
  };
}

/**
 * Every (emitter, topic0) in a receipt whose topics or ABI-aligned data mention `token`,
 * excluding logs emitted by the token itself. No tracing needed: a factory that creates
 * a token through an internal CREATE still has to tell the world about it in an event.
 */
export function refsForToken(logs, token) {
  const needle = pad32(token).slice(2);
  const self = lc(token);
  const seen = new Map();
  for (const log of logs ?? []) {
    const emitter = lc(log.address);
    if (emitter === self || !log.topics?.length) continue;
    let mentioned = log.topics.slice(1).some((t) => lc(t).slice(2) === needle);
    if (!mentioned) {
      const d = lc(log.data ?? '0x').slice(2);
      for (let i = 0; i + 64 <= d.length; i += 64) if (d.slice(i, i + 64) === needle) { mentioned = true; break; }
    }
    if (!mentioned) continue;
    const topic0 = lc(log.topics[0]);
    const k = emitter + topic0;
    if (!seen.has(k)) seen.set(k, { emitter, topic0, logIndex: Number(log.logIndex) });
  }
  return [...seen.values()];
}

/**
 * Permissionless protocols (Doppler) emit one creation event for every app built on them.
 * The app is stored per asset (Doppler: getAssetData(asset).integrator). Given the raw call
 * result, return { platform, launchpadId, confidence, label } for the token.
 *   known integrator  -> that launchpad, 'verified' if confirmed, 'observed-emitter' if observed
 *   unknown           -> the protocol itself, 'verified' (it IS a protocol launch, app unlisted)
 */
export function resolvePlatform(match, rawResult) {
  const p = match.platform;
  let addr = null;
  try {
    const out = decodeFunctionResult({ abi: p.abi, functionName: p.abi[0].name, data: rawResult });
    const v = Array.isArray(out) ? out[p.field] : out;
    if (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)) addr = v.toLowerCase();
  } catch { /* unreadable: stays at protocol level */ }
  const k = addr ? p.known.get(addr) : null;
  if (k) return { platform: addr, launchpadId: k.launchpad, confidence: k.status === 'confirmed' ? 'verified' : 'observed-emitter', label: k.label ?? null };
  return { platform: addr ?? 'unreadable', launchpadId: match.launchpadId, confidence: 'verified', label: null };
}

export function platformCall(match, token) {
  const p = match.platform;
  return { method: 'eth_call', params: [{ to: match.factory, data: encodeFunctionData({ abi: p.abi, functionName: p.abi[0].name, args: [token] }) }, 'latest'] };
}
