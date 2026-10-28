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
  // Algebra Integral (Hydrex, and other Algebra-based DEXes): pool deployer and pool machinery
  'Pool(address,address,address)': 'Algebra pool deployer',
  'Initialize(uint160,int24)': 'Algebra pool',
  'Plugin(address)': 'Algebra pool',
  'CommunityVault(address)': 'Algebra pool',
  'Swap(address,address,int256,int256,uint160,uint128,int24,uint24,uint24)': 'Algebra pool',
  'Mint(address,address,int24,int24,uint128,uint256,uint256)': 'Algebra pool',
  'IncreaseLiquidity(uint256,uint128,uint128,uint256,uint256,address)': 'Algebra position manager',
  'Permit(address,address,address,uint160,uint48,uint48)': 'Permit2 allowance',
};
// Canonical same-address-on-every-chain contracts that show up in launch transactions.
export const INFRA_ADDRESSES = new Map([
  ['0x000000000022d473030f116ddee9f6b43ac78ba3', 'Permit2'],
  ['0xca11bde05977b3631167028862be2a173976ca11', 'Multicall3'],
  ['0x4e59b44847b379578588920ca78fbf26c0b4956c', 'CREATE2 deployer'],
  ['0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789', 'ERC-4337 EntryPoint v0.6'],
  ['0x0000000071727de22e5e9d8baf0edac6f37da032', 'ERC-4337 EntryPoint v0.7'],
  // Base's native token standard: every B20 token is created by this precompile, whoever launched it
  ['0xb20f000000000000000000000000000000000000', 'B20 token factory (Base precompile)'],
  ['0x8453000000000000000000000000000000000001', 'B20 activation registry (Base)'],
  ['0x8453000000000000000000000000000000000002', 'B20 policy registry (Base)'],
]);

// ---- B20 (Base native tokens) -------------------------------------------------------------
export const B20_FACTORY = '0xb20f000000000000000000000000000000000000';
export const B20_POLICY_REGISTRY = '0x8453000000000000000000000000000000000002';
export const B20_CREATED_TOPIC = '0xfd9bf2730513a1709722ff379a0844dfd8f997d600693c2bcc659e188bbdba0d';
export const ROLE_GRANTED_TOPIC = '0x2f8788117e7eff1d82e926ec794901d17c78024a50270940304540a733656f0d';
export const B20_ROLES = {
  admin: '0x' + '0'.repeat(64),
  mint: '0x154c00819833dac601ee5ddded6fda79d9d8b506b911b3dbd54cdb95fe6c3686',
  seize: '0x3469b8b0d89e9604f8510ed143f74a8336d22955d4f83e23bf53d9414e27f432',
  pause: '0x139c2898040ef16910dc9f44dc697df79363da767d8bc92f2e310312b816e46d',
};
export const B20_POLICY_SCOPES = {
  sender: '0xb81736c875ab819dd97f59f2a6542cfb731ad52b4ae15a6f24df2fb02b0327f5',
  receiver: '0x8a4b3fa2d8b921852bc0089c6ef0958aa6961897be36fd731330fe2cd23f8363',
  executor: '0x10be5173aff2a44e748bd9acd8b19fe34689581398a9db7ba2fb671e786ff7d8',
};
/** A B20 token: Base-native, address in the factory's 0xb2 range, runtime code the one-byte 0xef marker. */
export const isB20 = (address, codeSize) => /^0xb20{14}/i.test(address ?? '') && (codeSize == null || codeSize === 1);
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
      // an event whose name is unknown (unverified contract) is registered by its raw topic0
      const topic0 = ev.topic0 ? ev.topic0.toLowerCase() : toEventSelector(ev.signature);
      const emitters = new Map((ev.emitters ?? []).map((e) => [lc(e.address), { label: e.label ?? null, status: e.status ?? 'confirmed', source: e.source ?? null }]));
      for (const [addr, e] of emitters) factoryOf.set(addr, { launchpadId: lp.id, label: e.label });
      const platform = ev.platform ? {
        abi: [parseAbiItem(ev.platform.call)], field: ev.platform.field, name: ev.platform.name ?? 'platform',
        // An integrator address is self-declared calldata: anyone can write Bankr's address there.
        // `wallets` says which launch senders the app itself uses; a claim from any other sender is a look-alike.
        known: new Map(Object.entries(ev.platform.known ?? {}).map(([a, v]) => [lc(a), { ...v, wallets: walletRule(v.wallets), allocations: allocationRule(v.allocations) }])),
      } : null;
      // a field marked `sale` names the per-token contract the supply is minted into to be sold (a
      // bonding curve, the pool): a mint to it is the launch, not an allocation (see birthAllocations)
      const saleFields = Object.entries(ev.fields ?? {}).filter(([, where]) => where?.sale).map(([name]) => name);
      const spec = { launchpadId: lp.id, signature: ev.signature, topic0, token: ev.token, fields: ev.fields ?? {}, saleFields, emitters, platform };
      if (!byTopic0.has(topic0)) byTopic0.set(topic0, []);
      byTopic0.get(topic0).push(spec);
    }
  }
  // contracts that issue *quote* tokens (e.g. Robinhood stock tokens), watched separately
  const quoteIssuers = (raw.quoteIssuers ?? []).map((q) => ({ ...q, factory: lc(q.factory), beacon: lc(q.beacon), topic0: lc(q.topic0) }));
  // creation events that carry a platform resolver, with the factory to call (for live lookups of unindexed tokens)
  const platformSpecs = [...byTopic0.values()].flat().filter((s) => s.platform).flatMap((s) => [...s.emitters.keys()].map((factory) => ({ ...s, factory })));
  // Uniswap v4 hooks known to keep what a sale pays out, by runtime-code keccak (src/sellcheck.js)
  const trapHooks = new Map((raw.trapHooks ?? []).map((h) => [lc(h.codeHash), { name: h.name, status: h.status ?? 'observed', source: h.source ?? null }]));
  return { chainId, launchpads, byTopic0, topic0s: [...byTopic0.keys()], factoryOf, companionOf, quoteIssuers, platformSpecs, trapHooks };
}

function walletRule(w) {
  if (!w) return null;
  return {
    status: w.status ?? 'observed', source: w.source ?? null,
    senders: new Set((w.senders ?? []).map(lc)),
    eip7702Delegates: new Set((w.eip7702Delegates ?? []).map(lc)),
  };
}

function allocationRule(a) {
  if (!a) return null;
  return {
    status: a.status ?? 'documented', source: a.source ?? null,
    allowed: (a.allowed ?? []).map((x) => ({ pct: Number(x.pct), cliffDays: Number(x.cliffDays ?? 0), vestDays: Number(x.vestDays ?? 0) })),
    noneAllowed: a.noneAllowed !== false,
    tolerancePct: Number(a.tolerancePct ?? 0.5),
    // how many allocations one launch may carry (Bankr: one, to the fee recipient)
    maxAllocations: Number(a.maxAllocations ?? 1),
  };
}

/**
 * Is what was minted at birth something the app's own launch flow produces? Bankr's form offers
 * exactly two things: 15% to one wallet with a 30-day cliff over a year, or nothing. A 14% instant
 * allocation, five 15% allocations, or 15% with no vest is not a Bankr launch, whoever sent it.
 * Returns 'verified', 'failed', or 'unverified': the birth receipt has not been read (premint
 * undefined), the supply is unknown, or supply was escrowed in the token without announced
 * beneficiaries (a token type that keeps vesting in storage only), so the allocations are unknown.
 */
export function checkAllocations(rule, premint, totalSupply) {
  if (!rule) return null;
  if (premint === undefined) return 'unverified';
  const allocs = premint?.allocations ?? [];
  const escrowed = BigInt(premint?.escrowed ?? '0');
  const allocated = allocs.reduce((t, a) => t + BigInt(a.amount), 0n);
  const unannounced = escrowed > allocated;
  if (!allocs.length) return unannounced ? 'unverified' : rule.noneAllowed ? 'verified' : 'failed';
  if (allocs.length > rule.maxAllocations) return 'failed';
  const supply = totalSupply ? BigInt(totalSupply) : 0n;
  if (supply <= 0n) return 'unverified';
  for (const a of allocs) {
    const sch = premint.schedules?.[a.scheduleId];
    const pct = Number((BigInt(a.amount) * 10000n) / supply) / 100;
    const cliffDays = sch ? sch.cliff / 86400 : 0;
    const vestDays = sch ? sch.duration / 86400 : 0;
    const ok = rule.allowed.some((x) => Math.abs(x.pct - pct) <= rule.tolerancePct && Math.abs(x.cliffDays - cliffDays) <= 1 && Math.abs(x.vestDays - vestDays) <= 1);
    if (!ok) return 'failed';
  }
  return unannounced ? 'unverified' : 'verified';
}

/**
 * The verdict from the two checks. An allocation outside the app's policy refutes the claim even
 * from a known wallet: anyone can delegate an EOA to the app's EIP-7702 implementation, so a
 * delegation alone cannot vouch for an off-policy mint. A known wallet confirms an on-policy (or
 * unknown) allocation. A sender that is not a known wallet keeps an on-policy claim unverified (the
 * app also launches from partner and CLI keys); with no allocation policy to go by, it refutes it.
 */
export function claimResult(wallet, allocations) {
  if (wallet === null && allocations === null) return null;
  if (allocations === 'failed') return 'failed';
  if (wallet === 'verified') return 'verified';
  if (wallet === 'failed') return allocations === null ? 'failed' : 'unverified';
  return 'unverified';
}

/**
 * The stored pre-mint as checkAllocations wants it: undefined = the birth receipt has not been read,
 * null = read, nothing minted outside the sale. Rows store '{}' for the latter, except rows recorded
 * by update-14, which stored NULL; their sender (tx_from, read from the same receipt) tells them apart.
 */
export function storedPremint(premintText, txFrom) {
  if (premintText === null || premintText === undefined) return txFrom ? null : undefined;
  try {
    const p = JSON.parse(premintText);
    return p && (p.allocations?.length || (p.escrowed && BigInt(p.escrowed) > 0n)) ? p : null; // {}, { v: 2 }, { v: 3 }: read, nothing
  } catch { return undefined; }
}

/** The verdict on an integrator claim, from both rules (see claimResult). */
export function judgeClaim(k, sender, senderCode, premint, totalSupply) {
  const wallet = checkSender(k.wallets, sender, senderCode);
  const allocations = checkAllocations(k.allocations, premint, totalSupply);
  const result = claimResult(wallet, allocations);
  return result === null ? null : { result, wallet, allocations };
}

/** Where a judged claim puts the token: the app, or the protocol when the claim is refuted. */
export function claimPlacement(k, protocolLaunchpadId, claim) {
  const look = claim?.result === 'failed';
  return {
    launchpadId: look ? protocolLaunchpadId : k.launchpad,
    confidence: look ? 'look-alike-platform' : k.status === 'confirmed' ? 'verified' : 'observed-emitter',
  };
}

/**
 * Does the launch sender belong to the app? `code` is eth_getCode(sender): an EIP-7702 delegated
 * EOA has code 0xef0100 + the delegate address. Returns 'verified', 'failed', or 'unverified'
 * (sender or its code unknown).
 */
export function checkSender(rule, sender, code) {
  if (!rule) return null;
  if (!sender) return 'unverified';
  const s = lc(sender);
  if (rule.senders.has(s)) return 'verified';
  if (typeof code !== 'string') return 'unverified';
  const c = lc(code);
  if (c.startsWith('0xef0100') && c.length === 48 && rule.eip7702Delegates.has('0x' + c.slice(8))) return 'verified';
  return 'failed';
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
    sale: hit ? (spec.saleFields ?? []).map((n) => fields[n]).filter((a) => /^0x[0-9a-f]{40}$/.test(a ?? '')) : [],
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
export function resolvePlatform(match, rawResult, sender = null, senderCode = null, premint = undefined, totalSupply = null) {
  const p = match.platform;
  let addr = null;
  try {
    const out = decodeFunctionResult({ abi: p.abi, functionName: p.abi[0].name, data: rawResult });
    const v = Array.isArray(out) ? out[p.field] : out;
    if (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)) addr = v.toLowerCase();
  } catch { /* unreadable: stays at protocol level */ }
  const k = addr ? p.known.get(addr) : null;
  if (k) {
    const claim = judgeClaim(k, sender, senderCode, premint, totalSupply);
    const claimCheck = claim ? JSON.stringify(claim) : null;
    // The integrator field claims an app, but the launch is not the app's: a direct protocol
    // launch wearing the label. Credited to the protocol, flagged.
    if (claim?.result === 'failed') return { platform: addr, launchpadId: match.launchpadId, confidence: 'look-alike-platform', label: null, claimedLaunchpadId: k.launchpad, claimCheck };
    return { platform: addr, launchpadId: k.launchpad, confidence: k.status === 'confirmed' ? 'verified' : 'observed-emitter', label: k.label ?? null, claimedLaunchpadId: k.launchpad, claimCheck };
  }
  return { platform: addr ?? 'unreadable', launchpadId: match.launchpadId, confidence: 'verified', label: null, claimedLaunchpadId: null, claimCheck: null };
}

/** The stored claim verdict: { result, wallet, allocations } or null. */
export function parseClaim(claimCheck) {
  if (!claimCheck) return null;
  try { const c = JSON.parse(claimCheck); return c && typeof c === 'object' ? c : null; } catch { return null; }
}

/** True when some known integrator of this platform has a wallet rule, so the sender's code is worth fetching. */
export const platformNeedsSender = (match) => [...(match.platform?.known?.values() ?? [])].some((k) => k.wallets);
export const senderCodeCall = (sender) => ({ method: 'eth_getCode', params: [sender, 'latest'] });

// ---- pre-mint: tokens minted at birth to someone other than the sale -----------------------------
// Doppler's token (DopplerERC20V1) records its allocations as events in the birth receipt:
//   VestingScheduleCreated(scheduleId, cliff, duration)   duration 0 = unlocked at once
//   VestingAllocated(beneficiary, scheduleId, amount)
const VESTING_SCHEDULE_TOPIC = toEventSelector('VestingScheduleCreated(uint256,uint64,uint64)');
const VESTING_ALLOCATED_TOPIC = toEventSelector('VestingAllocated(address,uint256,uint256)');

/**
 * What was minted at birth outside the sale, from the token's own logs in its birth receipt.
 * Amounts are decimal strings in base units. Returns null when the receipt shows no allocation.
 *   { escrowed, schedules: { id: { cliff, duration } }, allocations: [{ to, amount, scheduleId }] }
 */
export function premintFacts(receipt, token) {
  const t = lc(token);
  const schedules = {};
  const allocations = [];
  let escrowed = 0n;
  for (const l of receipt?.logs ?? []) {
    if (lc(l.address) !== t || !l.topics?.length) continue;
    const t0 = lc(l.topics[0]);
    const d = (l.data ?? '0x').slice(2);
    if (t0 === VESTING_SCHEDULE_TOPIC && l.topics.length >= 2 && d.length >= 128) {
      schedules[String(BigInt(l.topics[1]))] = { cliff: Number(BigInt('0x' + d.slice(0, 64))), duration: Number(BigInt('0x' + d.slice(64, 128))) };
    } else if (t0 === VESTING_ALLOCATED_TOPIC && l.topics.length >= 3 && d.length >= 64) {
      allocations.push({ to: '0x' + lc(l.topics[1]).slice(26), scheduleId: String(BigInt(l.topics[2])), amount: BigInt('0x' + d.slice(0, 64)).toString() });
    } else if (t0 === TRANSFER_TOPIC && l.topics.length === 3 && lc(l.topics[1]) === ZERO_TOPIC && '0x' + lc(l.topics[2]).slice(26) === t) {
      escrowed += BigInt('0x' + (d.slice(0, 64) || '0')); // minted to the token itself: the vesting escrow
    }
  }
  if (!allocations.length && escrowed === 0n) return null;
  return { escrowed: escrowed.toString(), schedules, allocations };
}

/**
 * Supply minted at birth to anyone but the launch itself: what a launchpad allocated outside the
 * sale (o1's factories before 2026-08-30 minted up to 80% to any address). Mints to the token, to
 * the launchpad's own contracts (hooks, lockers, factories), to the per-token sale contract its launch
 * event names (a field marked `sale`: Pons v2's curve, a pool) and to shared plumbing are the launch;
 * a mint to one of the launchpad's vesting vaults is a vested allocation; anything else is an
 * allocation unlocked at launch. Returns the premint shape ({ v: 3, escrowed, schedules,
 * allocations }), or { v: 3 } when the birth minted nothing outside the launch. (v: 2, update-18,
 * counted the mint into a per-token curve as a 100% allocation: every Pons v2 launch read "100% of the
 * supply was minted outside the sale".)
 */
export function birthAllocations(receipt, token, registry) {
  const t = lc(token);
  const sale = new Set();
  for (const l of receipt?.logs ?? []) {
    const m = registry ? matchKnownEvent(registry, l) : null;
    if (m && m.token === t && m.launchpadId) for (const a of m.sale) sale.add(a);
  }
  const allocations = [];
  for (const l of receipt?.logs ?? []) {
    if (lc(l.address) !== t || lc(l.topics?.[0]) !== TRANSFER_TOPIC || l.topics.length !== 3 || lc(l.topics[1]) !== ZERO_TOPIC) continue;
    const to = '0x' + lc(l.topics[2]).slice(26);
    if (to === t || to === '0x000000000000000000000000000000000000dead' || INFRA_ADDRESSES.has(to) || registry?.factoryOf?.has(to) || sale.has(to)) continue;
    const companion = registry?.companionOf?.get(to);
    // only a vesting vault holds an allocation for someone; a fee or buyback vault is the launchpad's own
    const vault = Boolean(companion && /vesting/i.test(companion.label ?? ''));
    if (companion && !vault) continue; // a hook, locker or deployer of the launchpad: the launch itself
    allocations.push({ to, scheduleId: null, amount: BigInt('0x' + ((l.data ?? '0x').slice(2, 66) || '0')).toString(), unlocked: !vault, via: vault ? 'vault' : 'mint' });
  }
  return allocations.length ? { v: 3, escrowed: '0', schedules: {}, allocations } : { v: 3 };
}

export function platformCall(match, token) {
  const p = match.platform;
  return { method: 'eth_call', params: [{ to: match.factory, data: encodeFunctionData({ abi: p.abi, functionName: p.abi[0].name, args: [token] }) }, 'latest'] };
}
