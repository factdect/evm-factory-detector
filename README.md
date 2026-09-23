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
| `/api/v1/chains` | Configured chains and indexer status (head, lag, discovery on/off) |
| `/health` | Same, with `ok` |

Page: `/` and shareable `/t/:chainId/:address`.

Indexed tokens cost no RPC call. Tokens outside the index cost one batched RPC request (plus one explorer call when `ETHERSCAN_API_KEY` or `BLOCKSCOUT_API_KEY` is set; Etherscan V2 is tried first), are rate limited per client, and are not written to the database unless the explorer returned a real birth transaction.

## Deploy on Railway

One service, one volume.

1. New service from the repo. Start command is `npm start`.
2. Add a volume mounted at `/data`. Set `DB_PATH=/data/factory.db`.
3. Set `CHAINS=4663`. Optional: `ETHERSCAN_API_KEY` or `BLOCKSCOUT_API_KEY` for on-demand lookups of tokens born before the index.
4. Health check path: `/health`.

Keep `ROLE=all`. The indexer and the API share one paced RPC client, so public lookups can never push the indexer into HTTP 429. Splitting into two services only works if both can open the same SQLite file, which Railway volumes do not allow.

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

`token` says where the token address sits: `{ "from": "topic", "index": n }` or `{ "from": "data", "word": n }`. If the slot is wrong the indexer notices (the address does not behave like an ERC-20), logs a warning, and attributes nothing. Every emitter carries a `source`. Only fill `url` when you verified it: a wrong link in a provenance tool is a phishing vector.

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
- **Births outside the state window** (downtime longer than a few minutes, deep backfill) are found only through registry events, unless you point `RPC_<id>` at an archive node and set `STATE_WINDOW_<id>=0`.
- **Tokens that do not mint in their creation transaction** are missed by discovery.
- **Vyper** keeps immutables after the code, so Vyper templates do not collapse into one skeleton.
- **The explorer adapters** (`src/explorer.js`: Etherscan V2, Blockscout PRO) are written against the documented `getcontractcreation` response and unit-tested with stubs. Neither has been run against the live APIs. They fail soft: on any surprise the lookup falls back to bytecode evidence.
- **Verified means provenance, not safety.** A token from a verified factory can still be a bad buy.
- **Growth:** `birth_refs` grows by a few rows per birth. Rows older than the stats window can be deleted without affecting attribution.

## Layout

```
src/chains.js       per-chain numbers and env overrides
src/rpc.js          paced JSON-RPC client: batching, priority queue, 429 backoff, adaptive getLogs ranges
src/fingerprint.js  minimal-proxy detection, opcode skeleton hash
src/attribution.js  registry loader, event matching, "who announced this token" from a receipt
src/births.js       records one birth (shared by indexer and on-demand lookups)
src/indexer.js      the loop
src/lookup.js       index rows -> public JSON, candidates (the detector)
src/age.js          dates announcing contracts by their first on-chain log
src/explorer.js     optional explorer adapters (Etherscan V2, Blockscout PRO)
src/server.js       HTTP API + static page, strict CSP
public/             the lookup page (no framework, no inline script)
registry/           launchpads per chain, every address with its source
```

Apache-2.0.
