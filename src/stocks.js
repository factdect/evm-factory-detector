// New quote tokens. On Robinhood Chain the quote side of most launches is a Robinhood stock
// token (QCOM, NVDA, …), and every one of them comes from a single issuer factory. Watching that
// factory tells us the moment a new pair becomes possible, before any launchpad supports it.
//
// Trust rule: a creation event names a token, but only the token's own beacon slot proves it is
// the issuer's product. Name-alikes on another beacon are stored with beacon_ok = 0 and never shown.

import { decodeAbiParameters } from 'viem';
import { hex, RpcError } from './rpc.js';

const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const CONFIRMATIONS = 20;

export function decodeIssuerLog(issuer, log) {
  const [token, name, symbol] = decodeAbiParameters(issuer.data.map((type) => ({ type })), log.data);
  return { token: token.toLowerCase(), name, symbol, block: Number(log.blockNumber), tx: log.transactionHash };
}

export async function beaconOf(rpc, token) {
  const slot = await rpc.call('eth_getStorageAt', [token, BEACON_SLOT, 'latest']);
  return typeof slot === 'string' && slot.length >= 42 ? '0x' + slot.slice(-40).toLowerCase() : null;
}

/**
 * Scan each issuer from its cursor. The first run walks the chain's whole history (address-filtered
 * getLogs, a few dozen calls on Robinhood Chain); after that it is one call per cycle.
 * maxCalls bounds how much a single cycle may spend so the indexer is never starved.
 */
export async function scanIssuers({ chain, rpc, registry, store, head, maxCalls = 4 }) {
  let calls = 0, found = 0;
  const to = head - CONFIRMATIONS;
  for (const issuer of registry.quoteIssuers ?? []) {
    let next = store.q.getIssuerCursor.get(chain.id, issuer.factory)?.next_block ?? 0;
    const span = Math.max(1, chain.addrLogsSpan ?? chain.logsChunk);
    while (next <= to && calls < maxCalls) {
      const b = Math.min(next + span - 1, to);
      let logs;
      try {
        logs = await rpc.call('eth_getLogs', [{ address: issuer.factory, topics: [issuer.topic0], fromBlock: hex(next), toBlock: hex(b) }]);
      } catch (e) {
        if (e instanceof RpcError && span > 1000) { chain.addrLogsSpan = Math.floor(span / 4); break; } // node refused the span: shrink and retry next cycle
        throw e;
      }
      calls++;
      for (const log of logs) {
        const ev = decodeIssuerLog(issuer, log);
        const beacon = await beaconOf(rpc, ev.token);
        store.q.putStock.run(chain.id, ev.token, issuer.id, ev.symbol, ev.name, ev.block, ev.tx, beacon === issuer.beacon ? 1 : 0, Math.floor(Date.now() / 1000));
        found++;
      }
      next = b + 1;
      store.q.setIssuerCursor.run(chain.id, issuer.factory, next);
    }
  }
  return { calls, found };
}
