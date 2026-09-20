// Public HTTP surface: the JSON API and the lookup page that renders the same JSON.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RpcError } from './rpc.js';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

// Un-indexed lookups spend RPC budget, so they are rate limited per client.
function makeLimiter(perMinute) {
  const hits = new Map();
  setInterval(() => { const cut = Date.now() - 60_000; for (const [k, v] of hits) if (v[v.length - 1] < cut) hits.delete(k); }, 60_000).unref();
  return (key) => {
    const now = Date.now();
    const arr = (hits.get(key) ?? []).filter((t) => t > now - 60_000);
    if (arr.length >= perMinute) { hits.set(key, arr); return false; }
    arr.push(now); hits.set(key, arr);
    return true;
  };
}

// The left side of X-Forwarded-For is whatever the client typed. Count from the right:
// TRUST_PROXY_HOPS=1 (Railway's edge) takes the address the last trusted proxy saw.
function clientIp(req) {
  const hops = Number(process.env.TRUST_PROXY_HOPS ?? 1);
  const chain = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return (hops > 0 && chain[chain.length - hops]) || req.socket.remoteAddress || 'unknown';
}

export function createServer({ lookup, log = console }) {
  const allow = makeLimiter(Number(process.env.LOOKUPS_PER_MINUTE ?? 30));

  const send = (res, status, body, headers = {}) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body, null, 2));
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'x-content-type-options': 'nosniff',
      ...headers,
    });
    res.end(buf);
  };

  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') return send(res, 204, Buffer.alloc(0), { 'access-control-allow-methods': 'GET', 'access-control-max-age': '86400' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method_not_allowed' });
      const url = new URL(req.url, 'http://x');
      const parts = url.pathname.split('/').filter(Boolean);

      const asset = STATIC[url.pathname];
      if (asset || parts.length === 0 || parts[0] === 't') {
        const [file, type] = asset ?? STATIC['/'];
        return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, file)), {
          'content-type': type,
          'cache-control': 'public, max-age=60',
          // No inline script: token names are attacker-controlled text, and this keeps it text.
          'content-security-policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
          'referrer-policy': 'no-referrer',
        });
      }
      if (parts[0] === 'health') {
        const chains = lookup.status();
        const bad = chains.some((c) => c.indexer?.lastError);
        return send(res, 200, { ok: !bad, chains });
      }
      if (parts[0] === 'api' && parts[1] === 'v1') {
        const [, , resource, chainId, address] = parts;
        if (resource === 'chains') return send(res, 200, { chains: lookup.status() }, { 'cache-control': 'public, max-age=5' });
        if (!/^\d{1,12}$/.test(chainId ?? '')) return send(res, 400, { error: 'bad_chain', message: 'Use a numeric chain id, e.g. /api/v1/token/4663/0x…' });
        if (!lookup.chain(chainId)) return send(res, 404, { error: 'unknown_chain', message: `Chain ${chainId} is not configured here.` });

        if (resource === 'token') {
          if (!ADDRESS.test(address ?? '')) return send(res, 400, { error: 'bad_address', message: 'Expected a 0x-prefixed 40-hex-character contract address.' });
          if (!lookup.isCheap(chainId, address) && !allow(clientIp(req))) return send(res, 429, { error: 'rate_limited', message: 'Too many lookups of tokens outside the index. Try again in a minute.' }, { 'retry-after': '60' });
          const r = await lookup.token(chainId, address);
          return send(res, r.status, r.body, { 'cache-control': r.status === 200 && r.body.birth ? 'public, max-age=120' : 'public, max-age=15' });
        }
        if (resource === 'recent') {
          const n = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
          return send(res, 200, { tokens: lookup.recent(chainId, Number.isFinite(n) ? n : 50) }, { 'cache-control': 'public, max-age=3' });
        }
        if (resource === 'candidates') return send(res, 200, { candidates: lookup.candidates(chainId) }, { 'cache-control': 'public, max-age=10' });
        if (resource === 'launchpads') return send(res, 200, { launchpads: lookup.launchpads(chainId) }, { 'cache-control': 'public, max-age=60' });
      }
      return send(res, 404, { error: 'not_found', endpoints: ['/api/v1/chains', '/api/v1/token/:chainId/:address', '/api/v1/recent/:chainId', '/api/v1/candidates/:chainId', '/api/v1/launchpads/:chainId', '/health'] });
    } catch (e) {
      log.error('request failed:', e);
      const upstream = e instanceof RpcError || /fetch failed|HTTP \d{3}|eth_|Multicall3|rate limited|aborted/i.test(String(e?.message));
      return upstream
        ? send(res, 502, { error: 'upstream_failed', message: 'The chain RPC did not answer properly. Try again in a moment.' })
        : send(res, 500, { error: 'internal_error', message: 'Something broke on our side. It has been logged.' });
    }
  });
}
