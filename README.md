# Factory Detector

Which factory made this token? A birth indexer and public lookup for EVM chains.
First target: Robinhood Chain (4663). The same code runs on any EVM chain; a chain is a config entry plus a registry file.

Trading terminals label launchpad tokens from a hand-maintained allowlist of factory addresses. Launchpads replace their contracts as a whole set on every upgrade, so the allowlist is always behind, and a token from a factory that is a few hours old shows up untagged and falls into a generic audit it was never going to pass. This tool answers the underlying question directly from chain data, says how sure it is, and finds factories nobody has listed yet.

## What it does

**Known launchpads.** One `eth_getLogs` per range, filtered by the creation-event topics in `registry/<chainId>.json`, with no address filter. The topic is the anchor, the emitter allowlist is the verification. Several launchpads share one event signature (Pons v1 and NoxaFun; Flap and RealFun), and anyone can emit a look-alike, so a matching topic from an unlisted emitter is never credited to the launchpad.

**Unknown factories, without tracing.** One `eth_getLogs` for ERC-20 mints (`Transfer` from `0x0`). A minting contract whose code did not exist one block earlier was born in that block. Its birth receipt shows which contracts emitted events that name it. A contract that keeps announcing newborn tokens of a single bytecode template is a factory. No `debug_`/`trace_` methods needed.

**Bytecode fingerprint.** Minimal clones (EIP-1167, 0age 44-byte, Solady, clones with immutable args) key on their hardcoded implementation and are reported as not upgradeable. Everything else keys on the opcode skeleton (runtime code with PUSH operands zeroed), so tokens that differ only in immutables collapse into one template. EIP-1967 proxies are flagged upgradeable.

### Protocols vs launchpads

Some creation events belong to a permissionless *protocol*, not an app. Doppler's Airlock (canonical on Robinhood Chain, per docs.doppler.lol) emits the same `Create` for Long.xyz and for anyone else who calls it. The launching app is stored per asset (`getAssetData(asset).integrator`), so the registry lets an event carry a `platform` resolver: the indexer reads the integrator at record time, maps known integrators to their launchpad, and labels the rest `protocol-verified` ("Doppler, unlisted app"). Rows indexed before a resolver existed are re-checked in idle time. On 2026-09-21 about a third of Doppler launches on Robinhood Chain came from integrators other than Long's.

### Tokens born before the index

A token with no indexed birth is not a dead end. Permissionless protocols keep their own per-asset record on-chain (Doppler: `Airlock.getAssetData`), so the lookup asks each registered protocol factory live, one `eth_call` each, and attributes the token from the integrator it finds. No explorer key is needed for that; the key only adds tracing for tokens no protocol knows. The response says how the verdict was obtained in `bytecode.attributionSource` (`indexed-birth` or `live-protocol-call`).

A bytecode template owned by a protocol (the DopplerERC20V1 clone) is shared by every app on that protocol, so the cluster names the protocol (`cluster.template`) and the app split is presented as the template's users, never as a guess about who launched the token in hand.

### Silent factories and reused names

Some factories emit no creation event at all, so event-based discovery sees each of their tokens as a one-off. The indexer records who the deployer called (`tx_to`) and who received the first mint (`mint_to`); when both are the same contract and it has made several tokens, the token's verdict is `silent-factory`, the response names the contract with `tokensMade` and `topNames`, and the contract appears in `/api/v1/candidates` with `silent: true`. A plain direct deploy (no contract called) stays `discovered-silent`.

`token.sameNameElsewhere` counts other token contracts carrying the exact same name and symbol. On Robinhood Chain one silent factory was seen minting five different contracts named "Hylo 3x Leveraged HYPE" in ten hours; this field is how a lookup warns you that the name alone identifies nothing.

### Base (8453)

Enable with `CHAINS=4663,8453` **and set `RPC_8453` to a private endpoint.** Base births roughly 4,000 ERC-20 tokens a day. The public RPC (`mainnet.base.org`) is no longer usable for this from a server: it cut `eth_getLogs` to 500 blocks on 2026-10-05 and to 200 blocks on 2026-10-08, and since 2026-10-08 (about 15:00 UTC) it answers about 98% of requests from datacenter hosts with HTTP 429 "request limit reached" (measured by bracketedz.com from Railway, and confirmed from a second host). The service logs a warning at boot when Base runs on the public RPC.

What the code does about it: a node that states its block-range cap ("limited to a 200 range", Alchemy's "up to a N block range", dRPC's "ranges over N blocks") is believed, and the cap is used from then on instead of halving and growing back into the wall. Announcers are dated over 2 days rather than 7. Base nodes answer a range too heavy to serve with a bare HTTP 500; the age probe treats that like a busy range (splits it, then counts it as activity). It never treats rate limiting or an exhausted quota that way: those say nothing about the contract, so the probe fails and is retried later rather than calling a brand-new factory "old".

Registry `registry/8453.json` ships with Hydrex (Hydropump launcher, `confirmed`: public source) and Catalyst Markets (`observed`: unverified contracts, identified on-chain). An event whose name is unknown can be registered by its raw `topic0`. Algebra Integral pool-deployer and pool events are treated as DEX infrastructure, so new Algebra pools never show up as factories.

A helper contract that only fires for some of a launcher's tokens (for example a fee registry that logs non-default choices) is folded into that launcher's system by containment, rather than being reported as a separate new factory.

### A claimed app is not a launch

Permissionless protocols record which app launched a token in a field the launcher fills in itself (Doppler: `getAssetData(asset).integrator`). Anyone calling the Airlock directly can write Bankr's address there, and terminals that read only that field then show the token as a Bankr launch. On Robinhood Chain, 19 of 78 "Bankr" launches in 55 hours (2026-10-25..27) were exactly that: direct Airlock calls with a copy of Bankr's template, from wallets Bankr never uses, none of them listed on bankr.bot, and all 19 carried 14–50% of the supply minted to a wallet that could sell from the first block. One of them (DRS) was dumped 4 minutes after launch, taking 81% of everything buyers had paid in.

So a known integrator can carry two rules in the registry, and a claim is judged against both:

- `platform.known[app].wallets`: the launch senders the app itself uses, as plain addresses (`senders`: Bankr's hot wallets on Base) or as an EIP-7702 delegation target (`eip7702Delegates`: on Robinhood Chain every launch from a Bankr-managed wallet is sent by an EOA delegated to `0xd6ce…5b28`). At birth the indexer reads the launch sender from the receipt and fetches its code (one call). A sender on the list **confirms** an on-policy claim. A 7702 delegation can be copied by anyone (the EOA signs it itself), so it never vouches for an off-policy mint.
- `platform.known[app].allocations`: what the app's launch flow can mint at birth. Bankr's form offers exactly two things (15% to the fee recipient with a 30-day cliff and a 1-year vest, or nothing), so `allowed: [{ pct: 15, cliffDays: 30, vestDays: 365 }]`, `noneAllowed: true`, `maxAllocations: 1`, `tolerancePct: 0.5`. An allocation outside the policy (24% unlocked at launch, 15% with no vest, 14% vested, five 15% allocations) **refutes** the claim, whoever sent it. Supply escrowed in the token with no announced beneficiary (a token type that keeps vesting in storage) leaves the allocation check `unverified`.

A sender off the list alone is not a verdict: Bankr also launches from plain EOAs (partner and CLI keys; 6 of the 78 launches, all listed on bankr.bot, all on-policy). The outcome is stored as `claim_check` (`{ result, wallet, allocations }`): wallet confirmed → the app's label; allocation off-policy → `look-alike-platform`, credited to the protocol, with `factory.platform.claims` naming the app the field pretends to be and `verdict.warnings` saying which rule failed; wallet off-list but allocation on-policy → the label is kept with `claimCheck: "unverified"` and a note; nothing checkable (a live lookup with no birth transaction, or an app without rules) → unverified or no check at all. On every boot, stored claims are judged again against the registry from stored facts (no RPC), so adding a wallet to `senders` or changing a policy applies to tokens already indexed. Tokens indexed before this check are completed on their first lookup (one receipt read, rate-limited like a lookup of an unknown token) and by an idle-time probe over the stats window; a protocol token the index does not hold yet gets its birth found and recorded on lookup (see the replay section).

### Pre-mint: supply that can be sold from the first block

A bonding curve only prices what is sold through it. Doppler's token (DopplerERC20V1) can mint up to 80% of the supply to any wallets at birth, under vesting schedules whose duration may be 0 ("instant"). Those allocations are events in the birth receipt, so every Doppler launch gets `premint`: the share minted outside the sale, the share unlocked at launch, and each allocation with its cliff and duration (a schedule with no cliff that finishes within a day counts as unlocked at launch). The page shows it as "Pre-minted: 25% of supply; 24% → 0xbe51… (unlocked at launch); 1% → 0xa032… (vesting 30-day cliff, 365 days)", and `verdict.warnings` leads with it. Bankr's own launches carry 15% with a 30-day cliff and a 1-year vest, which shows as 15% pre-minted, 0% unlocked.

### Confidence levels

| Code | Meaning |
| --- | --- |
| `verified` | Creation event from an address the launchpad (or a reputable integration doc) publishes |
| `observed-emitter` | Same, but the allowlist entry is one we found on-chain ourselves |
| `code-match` | Matching event, unlisted emitter, same program as a listed factory. New generation or third-party redeploy |
| `silent-factory` | No creation event, but the contract the deployer called also got the mint and has made several tokens this way |
| `protocol-verified` | Canonical protocol contract (e.g. Doppler Airlock), launched by an app not in the registry |
| `observed-platform` | Protocol launch by an integrator we identified on-chain as a launchpad, not published by it |
| `unverified-emitter` | Matching event, unlisted emitter, different code. Never shown as the launchpad |
| `look-alike-platform` | Protocol launch whose integrator field names a known app, but what was minted at birth is outside that app's allocation policy (or, for an app with no policy, the sender is not one of its wallets). Credited to the protocol; the claimed app is shown as a claim |
| `discovered` | No registry match. A contract that announced several same-template tokens announced this one |
| `discovered-first` | The announcing contract has announced exactly one token. One-off deployer or brand-new factory |
| `discovered-silent` | Born and minted in one transaction, nobody announced it |
| `bytecode-cluster` | Birth not indexed; template matches a known launchpad's. Shows the template, not who deployed it |
| `none` | No birth record and no template match |

## Run

```bash
npm install
cp .env.example .env   # optional, defaults work for Robinhood Chain
npm start              # indexer + API + page on :8080
npm test               # unit tests (no network)
node test/live-smoke.js 4663 2000   # live: index the last 2000 blocks into memory and print what it found
node test/live-smoke.js 8453 40     # same code on Base, discovery-only
```

Needs Node 22+ (any current version; better-sqlite3 v13 ships N-API prebuilds, so nothing compiles at install). Dependencies: `viem` (ABI + keccak) and `better-sqlite3`. No build step.

## API

All `GET`, JSON, CORS open. The lookup page renders exactly what the token endpoint returns.

| Endpoint | Returns |
| --- | --- |
| `/api/v1/token/:chainId/:address` | Verdict, launchpad, factory (with tokens announced and first-seen age), birth tx, bytecode template, announcers |
| `/api/v1/recent/:chainId?limit=50` | Newest births |
| `/api/v1/stocks/:chainId` | New quote tokens from known issuers (Robinhood stock tokens). Each row: when it was added, `pairsLaunched` (how many launches use it as their pair), `open` (true = nobody has launched against it yet), and `firstLaunch` (the first token on that pair, its launchpad, and `secondsAfterListing`). A token counts only if its beacon slot matches the issuer's — name-alikes are rejected. |
| `/api/v1/candidates/:chainId` | The detector: unlisted factories, grouped. Contracts that fire in the same birth transactions are one *system* (`coEmitters`); systems sharing a creation event are one *mechanism* (`mechanism.addresses` > 1 = a factory that rotates its address). `firstActivityAgoSec` is the contract's first log on-chain (dated in idle time by an address-filtered getLogs lookback, default 7 days), not when this index first saw it. `makerShare` = share of its tokens whose deployer called it or whose first mint went to it. Params: `status=unlisted` (default: `new` + `look-alike`) \| `all` \| `pool-hook` \| `dex-plumbing` \| …, `sinceHours=24` (first on-chain activity within N hours; undated systems are counted in `pendingAgeCheck`, never guessed), `min=2`, `limit=100`. Response carries `total` beside the page. |
| `/api/v1/launchpads/:chainId` | Registry with provenance per factory address and indexed counts |
| `/api/v1/chains` | Configured chains and indexer status: head, lag (blocks and seconds), `stalled`, `diskFull`, discovery on/off, stall-gap replay progress (`backfill`), RPC counters |
| `/health` | Same, plus `storage` and `ok` / `problems`. `ok` is false when an indexer is stalled (an error for 2 minutes, or no progress for 5), the disk is full, free disk is under 64 MB, room to write into is below `MIN_FREE_MB`, or the evidence migration failed |

Page: `/` and shareable `/t/:chainId/:address`.

Indexed tokens cost no RPC call. Tokens outside the index cost one batched RPC request (plus one explorer call when `ETHERSCAN_API_KEY` or `BLOCKSCOUT_API_KEY` is set; Etherscan V2 is tried first), are rate limited per client, and are not written to the database unless the explorer returned a real birth transaction.

## Deploy on Railway

One service, one volume.

1. New service from the repo. Start command is `npm start`.
2. Add a volume mounted at `/data` (Hobby plan or above: 0.5 GB lasts days, see "Storage"). Set `DB_PATH=/data/factory.db`.
3. Set `CHAINS=4663`. Optional: `ETHERSCAN_API_KEY` or `BLOCKSCOUT_API_KEY` for on-demand lookups of tokens born before the index.
4. Health check path: `/health`.

Keep `ROLE=all`. The indexer and the API share one paced RPC client, so public lookups can never push the indexer into HTTP 429. Splitting into two services only works if both can open the same SQLite file, which Railway volumes do not allow.

### Storage

Railway volumes are 0.5 GB on the Free and Trial plans, 5 GB on Hobby and 50 GB on Pro, and can be grown on the paid plans only. On 2026-09-25 the 0.5 GB volume filled at about 91,000 tokens and indexing stopped for 14 days, while `/health` kept saying "19 blocks behind". What changed:

- **Smaller evidence.** The birth evidence (which contracts mentioned a token in its birth receipt, about 7 rows per token) used to be hex text with three indexes, about 5 KB per token. It is now stored as integer ids, about 1 KB per token. All in, with the token rows, a token costs 1–2.5 KB instead of 5.5–6.7 KB (measured on two 91,000–100,000-token databases). Robinhood Chain births about 16,500 tokens a day, so expect 17–40 MB a day: a 5 GB volume lasts roughly 4 to 9 months. `/health` → `storage.daysLeft` gives the real figure.
- **Migration.** The old table is copied into the new form on the first boot that has room, in batches, and dropped only after every row is copied and counted (91,000 tokens: about 10 s). It needs free disk for the new tables plus some WAL: about 170 bytes per evidence row plus 64 MB, and about 25 MB more for two new token indexes (about 200 MB in all for a 91,000-token database; with less, it waits and `/health` says how much is missing). The space the old table frees inside the file is reused before the file grows. Interrupting it is safe: the next boot finishes it.
- **Pruning, last resort.** When room to write into (free disk plus reusable pages inside the file) drops below `MIN_FREE_MB` (default 150), and whenever the disk is full, the oldest birth evidence is deleted in small steps, always keeping the 3-day stats window plus a day. Tokens are never deleted: each keeps its launchpad, factory, maker and fingerprint. Each factory's first sighting and the index start are kept, so ages do not move. A token whose announcers were pruned gets the verdict `evidence-pruned`, never "silent". `RETAIN_REFS_DAYS=N` prunes evidence older than N days on a schedule instead (never inside the stats window).
- **A full disk pauses, it does not spin.** Indexing waits a minute between attempts and says `diskFull` in `/health`; it resumes by itself once there is room. Lookups keep working from what is indexed. If the volume is so full the database cannot even be opened, the service answers every request with 503 and an explanation, and restarts by itself once the database opens again.
- **Grow the volume before deploying onto a full one.** Railway runs one deployment at a time for a service with a volume, so a deploy onto a full volume replaces the running one with the 503 page; it does not keep the old one serving. A 0.5 GB volume holding ~500 MB cannot migrate at all (the new tables need room before the old one is dropped).
- `/health` → `storage` shows the database size, free disk (`fsFreeBytes`), pages reusable inside the file, bytes per token, `daysLeft`, and the migration state. `diskLow` (under 64 MB of free disk) is a problem even when the file has reusable pages: the WAL, a migration and index builds need real disk.

**Going back to an older build.** update-12 and earlier cannot open a migrated database (they create indexes on `birth_refs`, which is now a view) and would crash at boot. To roll back: stop the service, then in a shell with the volume mounted run `DB_PATH=/data/factory.db node scripts/rollback-evidence.mjs`, then deploy the older build. It rebuilds the old text table with its indexes (it needs the old form's space again, about 750 bytes per evidence row). Older builds do not replay stall gaps.

### After a long stall

When the indexer is further behind than `MAX_LAG_BLOCKS_<id>` (default: 30 minutes of blocks), live indexing does not replay everything in order (discovery of unknown factories cannot run that far back anyway). It resumes at the edge of the node's state window, so the live feed is current again within a minute, and the skipped blocks are queued as a gap. A background loop replays the gap newest-first for known launchpad events only, using a lower-priority lane of the same RPC budget, so the live loop never waits for it. `/health` → `backfill` shows blocks left and an ETA. On the public Robinhood RPC a replay ran at 50–120 blocks a second in testing, so two weeks of chain (about 12 million blocks) takes one to three days. `BACKFILL=off` skips the replay; tokens in the gap can still be looked up one by one: a token a launch protocol knows (Doppler's Airlock) has its birth found on lookup by its own mint log (address-filtered getLogs, newest first, at most `BIRTH_SCAN_WINDOWS_<id>` × `ADDR_LOGS_SPAN_<id>` blocks back, 55 days on Robinhood Chain) and recorded like an indexed launch, so its claim and pre-mint are judged from the receipt rather than from the integrator field alone; other tokens need `ETHERSCAN_API_KEY` / `BLOCKSCOUT_API_KEY`. Until the replay has passed it, a stock token listed inside the gap reports `countComplete: false`.

## Add a launchpad

Append to `registry/<chainId>.json`:

```json
{
  "id": "pons-v2",
  "name": "Pons v2",
  "url": "https://www.ponsfamily.com/launchpad",
  "events": [{
    "signature": "TokenLaunched(address,address,address,address,uint256,uint256)",
    "token": { "from": "topic", "index": 1 },
    "fields": { "curve": { "from": "topic", "index": 2 } },
    "emitters": [{ "address": "0x7ed5…ec7e", "label": "factory", "status": "confirmed", "source": "docs.ponsfamily.com/v2#contracts" }]
  }],
  "contracts": [{ "address": "0xe33e…2948", "label": "launch-and-buy router" }]
}
```

`token` says where the token address sits: `{ "from": "topic", "index": n }` or `{ "from": "data", "word": n }`. A protocol event carries `platform` (the call that names the launching app, and `known` apps by integrator address); a known app may carry `wallets` (`senders`, `eip7702Delegates`) and `allocations` (`allowed[{pct,cliffDays,vestDays}]`, `noneAllowed`, `tolerancePct`) so that a claim is confirmed by the sender or refuted by the birth allocations rather than believed. If the slot is wrong the indexer notices (the address does not behave like an ERC-20), logs a warning, and attributes nothing. Every emitter carries a `source`. Only fill `url` when you verified it: a wrong link in a provenance tool is a phishing vector.

Workflow for a new factory: it shows up under `/api/v1/candidates` with `status: "new"`, you open a sample token's birth transaction, find the launchpad's own docs for that address, then add it with its source. Restart to reload. On boot, tokens already indexed as `discovered` are re-attributed from the evidence stored with their birth (no RPC calls), so promoting a candidate immediately labels every token it has made since the index saw it.

## Add a chain

Set `CHAINS=4663,<id>` and `RPC_<id>=…`. Built-in tuning exists for 4663 and 8453; for anything else set `MIN_INTERVAL_MS_<id>`, `LOGS_CHUNK_<id>` and `STATE_WINDOW_<id>` from measured limits. With no `registry/<id>.json` the chain runs discovery-only.

What carries over between chains: all code, the DEX-plumbing event list, the canonical-address list (Permit2, Multicall3, …).
What does not: the registry, RPC limits, block time, how far back the node serves historical state.
Not supported: chains that are not bytecode-equivalent (zkSync Era breaks fingerprints), non-EVM chains.

## Measured on Robinhood Chain public RPC (2026-09-20)

- JSON-RPC batches work and are rate limited per HTTP request, not per call. Batches of 12 at 450 ms spacing: zero 429s.
- Historical state is served about 3,000 blocks back (5 minutes) and refused at 10,000. Discovery therefore runs inside a 2,500-block window; older ranges are indexed from registry events only.
- 2,400 blocks (4 minutes of chain time) index in about 19 s. Steady state sits 20 blocks (2 s) behind head.
- Multicall3 is at the canonical address.

## Limits, stated plainly

- **Reorgs:** handled by staying `confirmations` blocks behind head only. No block-hash tracking.
- **Births outside the state window** (downtime longer than a few minutes, deep backfill, stall-gap replay) are found only through registry events, unless you point `RPC_<id>` at an archive node and set `STATE_WINDOW_<id>=0`.
- **Tokens that do not mint in their creation transaction** are missed by discovery.
- **Vyper** keeps immutables after the code, so Vyper templates do not collapse into one skeleton.
- **The explorer adapters** (`src/explorer.js`: Etherscan V2, Blockscout PRO) are written against the documented `getcontractcreation` response and unit-tested with stubs. Neither has been run against the live APIs. They fail soft: on any surprise the lookup falls back to bytecode evidence.
- **Verified means provenance, not safety.** A token from a verified factory can still be a bad buy.
- **Growth:** about 1 KB per token (see "Storage"). Evidence older than the stats window can be pruned without affecting attribution.

## Layout

```
src/chains.js       per-chain numbers and env overrides
src/rpc.js          paced JSON-RPC client: batching, priority + background lanes, 429 backoff, getLogs ranges that learn a stated cap
src/fingerprint.js  minimal-proxy detection, opcode skeleton hash
src/attribution.js  registry loader, event matching, "who announced this token" from a receipt
src/births.js       records one birth (shared by indexer and on-demand lookups)
src/indexer.js      the live loop, plus a background loop (probes, storage, stall-gap replay)
src/db.js           SQLite schema, compact birth evidence, migration and its rollback, pruning, disk accounting
scripts/            rollback-evidence.mjs (undo the evidence migration for an older build)
src/lookup.js       index rows -> public JSON, candidates (the detector), /health
src/age.js          dates announcing contracts by their first on-chain log
src/explorer.js     optional explorer adapters (Etherscan V2, Blockscout PRO)
src/server.js       HTTP API + static page, strict CSP
public/             the lookup page (no framework, no inline script)
registry/           launchpads per chain, every address with its source
```

Apache-2.0.
