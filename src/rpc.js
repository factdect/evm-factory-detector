// Paced JSON-RPC client. One instance per RPC URL = one shared rate budget for the
// indexer and for on-demand lookups (lookups jump the queue with { priority: true }).

export class RpcError extends Error {
  constructor(method, err) {
    super(`${method}: ${err?.message ?? 'unknown RPC error'}`);
    this.name = 'RpcError';
    this.code = err?.code;
    this.data = err?.data;
    this.method = method;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// "request limit reached" is mainnet.base.org's wording (HTTP 429, code -32011), seen since 2026-10-08.
const RATE_RE = /rate.?limit|too many requests|request limit|exceeded.*(quota|capacity)|throttl/i;
export const isRateLimit = (e) => e?.code === 429 || e?.code === -32005 || RATE_RE.test(e?.message ?? '');
// What the transport throws once it gave up on a rate-limited request.
// (503 is answered like 429 by the transport: a node shedding load, not a statement about the query)
export const isRateLimitFailure = (e) => /^HTTP (?:429|503)\b|^rate limited\b/.test(e?.message ?? '') || isRateLimit(e);
// Refusals about the caller (rate, quota, key, a block page), not about the query: they say nothing
// about the chain, so nothing may be concluded from them.
export const isCallerRefusal = (e) => isRateLimitFailure(e)
  || /capacity limit|quota|api.?key|unauthori[sz]ed|forbidden|\bHTTP 40[13]\b|non-JSON response/i.test(e?.message ?? '');

const isRetryable = (e) => e?.retryable || e?.name === 'AbortError' || e?.name === 'TimeoutError'
  || (e instanceof TypeError && /fetch failed|terminated|network|socket/i.test(e.message));
const retryDelay = (e, attempt) => (e?.backoff ?? Math.min(30000, 1000 * 2 ** (attempt - 1))) + Math.random() * 250;

// A node that states its eth_getLogs block-range cap. Learning the number beats halving blindly:
// Base cut its public RPC to 500 blocks on 2026-10-05 and to 200 on 2026-10-08.
const RANGE_CAP_RES = [
  /limited to a ([\d,]+)(?:[- ]block)? range/i,       // mainnet.base.org, sepolia.base.org
  /up to a ([\d,]+) block range/i,                     // Alchemy free tier
  /ranges? over ([\d,]+) blocks?/i,                    // dRPC free plan
  /block range (?:limit|is limited to|exceeds?(?: the)?(?: max(?:imum)?)?)\D{0,12}([\d,]+)/i,
  /max(?:imum)? (?:block )?range(?: of| is|:)? ([\d,]+)/i,
];
// A range refused for the SIZE of its result ("Log response size exceeded", "more than 10000
// results"). Not a cap on the span: the same span is fine for a quiet address. Alchemy's wording
// also quotes its 10,000-block policy in this message; reading that as a cap once made the birth
// scan 10x shorter for the rest of the process.
export const isResultSizeError = (e) => /response size|too many (results|logs)|more than \d[\d,]* (results|logs)|cap of \d+K? logs|exceeds? (the )?(max(imum)? )?(number of )?(results|logs)/i.test(e?.message ?? '');
/** Block count a node says it allows per eth_getLogs, or null when the error does not say (or is about result size). */
export function rangeCapFrom(e) {
  const msg = String(e?.message ?? '');
  if (isResultSizeError(e)) return null;
  for (const re of RANGE_CAP_RES) {
    const m = msg.match(re);
    if (m) { const n = Number(m[1].replace(/,/g, '')); if (Number.isFinite(n) && n > 0) return n; }
  }
  return null;
}
/** The range a node says it could serve ("this block range should work: [0x…, 0x…]", Alchemy), as [from, to], or null. */
export function suggestedRangeFrom(e) {
  const m = String(e?.message ?? '').match(/should work: \[\s*(0x[0-9a-f]+)\s*,\s*(0x[0-9a-f]+)\s*\]/i);
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[2]);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? [a, b] : null;
}
export const isStateUnavailable = (e) =>
  /historical state|missing trie node|state .*not available|pruned|header not found|archive/i.test(e?.message ?? '');

export const hex = (n) => '0x' + Number(n).toString(16);

export class Rpc {
  constructor({ url, headers = {}, minIntervalMs = 500, timeoutMs = 30000, bgTimeoutMs = 10000, maxRetries = 6, batchMax = 12 }) {
    this.url = url;
    this.headers = headers;
    this.minIntervalMs = minIntervalMs;
    this.timeoutMs = timeoutMs;
    this.bgTimeoutMs = bgTimeoutMs; // a background request holds the line while it waits: keep it short
    this.maxRetries = maxRetries;
    this.batchMax = batchMax;
    this.queue = [];
    this.lowQueue = []; // background work: sent only when nothing else is waiting
    this.running = false;
    this.lastStart = 0;
    this.nextId = 1;
    this.stats = { http: 0, calls: 0, rateLimited: 0, retries: 0, errors: 0 };
  }

  /**
   * The same client and rate budget for background work (stall replay, age and platform probes):
   * its calls are sent only when no normal call is waiting, so the live indexer never queues
   * behind a backlog. Lookups ({ priority: true }) still jump every queue.
   */
  background() {
    const low = (o) => ({ ...o, low: o.priority !== true });
    return {
      url: this.url, stats: this.stats,
      call: (method, params = [], opts = {}) => this.call(method, params, low(opts)),
      batch: (calls, opts = {}) => this.batch(calls, low(opts)),
    };
  }

  /** Single call. Resolves with `result`, rejects with RpcError. */
  async call(method, params = [], opts = {}) {
    const [r] = await this.batch([{ method, params }], opts);
    if (r.error) throw new RpcError(method, r.error);
    return r.result;
  }

  /**
   * Batch of calls -> array of { result } | { error }, same order. Never rejects for
   * per-call JSON-RPC errors; rejects only when the HTTP request itself keeps failing.
   */
  async batch(calls, opts = {}) {
    if (calls.length === 0) return [];
    const out = [];
    for (let i = 0; i < calls.length; ) {
      const slice = calls.slice(i, i + this.batchMax); // batchMax can shrink while we wait, so advance by what was sent
      out.push(...(await this.#enqueue(slice, opts.priority === true, opts.low === true)));
      i += slice.length;
    }
    return out;
  }

  #enqueue(calls, priority, low = false) {
    return new Promise((resolve, reject) => {
      const job = { calls, resolve, reject, low: low && !priority, attempt: 0, notBefore: 0 };
      if (priority) this.queue.unshift(job); else if (job.low) this.lowQueue.push(job); else this.queue.push(job);
      this.#drain();
    });
  }

  /**
   * One request at a time, normal lane first. A background job gets one attempt per turn: when it
   * fails with something worth retrying it goes to the back of its lane with a backoff, instead of
   * retrying in place (which used to keep live calls waiting through every retry).
   */
  async #drain() {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        let job = this.queue.shift();
        if (!job && this.lowQueue.length) {
          // A caller that just got its answer usually asks again within a few microtasks. Let it
          // queue that call first; otherwise the live loop would wait one background call per call.
          await new Promise((r) => setImmediate(r));
          job = this.queue.shift();
          if (!job) {
            const now = Date.now();
            const i = this.lowQueue.findIndex((j) => j.notBefore <= now);
            if (i >= 0) job = this.lowQueue.splice(i, 1)[0];
            else { this.#wakeLater(Math.min(...this.lowQueue.map((j) => j.notBefore)) - now); break; }
          }
        }
        if (!job) break;
        if (!job.low) {
          try { job.resolve(await this.#send(job.calls)); } catch (e) { job.reject(e); }
          continue;
        }
        try {
          job.resolve(await this.#attempt(job.calls, this.bgTimeoutMs));
        } catch (e) {
          if (isRetryable(e) && job.attempt < this.maxRetries) {
            job.attempt++;
            this.stats.retries++;
            job.notBefore = Date.now() + retryDelay(e, job.attempt);
            this.lowQueue.push(job);
          } else {
            this.stats.errors++;
            job.reject(e);
          }
        }
      }
    } finally {
      this.running = false;
    }
  }

  #wakeLater(ms) {
    clearTimeout(this.wake);
    this.wake = setTimeout(() => { this.wake = null; this.#drain(); }, Math.max(1, ms));
  }

  async #pace() {
    const wait = this.lastStart + this.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastStart = Date.now();
  }

  /** Normal lane: retry in place with backoff. */
  async #send(calls) {
    for (let attempt = 0; ; ) {
      try {
        return await this.#attempt(calls, this.timeoutMs);
      } catch (e) {
        // Only transport problems are worth retrying. A bare TypeError is a bug, not a network blip.
        if (!isRetryable(e) || attempt >= this.maxRetries) { this.stats.errors++; throw e; }
        attempt++;
        this.stats.retries++;
        await sleep(retryDelay(e, attempt));
      }
    }
  }

  /** One HTTP request. Throws { retryable, backoff } for what is worth another try. */
  async #attempt(calls, timeoutMs) {
    const single = calls.length === 1;
    const payload = calls.map((c) => ({ jsonrpc: '2.0', id: this.nextId++, method: c.method, params: c.params ?? [] }));
    await this.#pace();
    this.stats.http++;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res, text;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.headers },
        body: JSON.stringify(single ? payload[0] : payload),
        signal: ctrl.signal,
      });
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429 || res.status === 503) {
      this.stats.rateLimited++;
      const ra = Number(res.headers.get('retry-after'));
      throw Object.assign(new Error(`HTTP ${res.status}`), { retryable: true, backoff: Number.isFinite(ra) && ra > 0 ? ra * 1000 : null });
    }
    if (res.status >= 500) throw Object.assign(new Error(`HTTP ${res.status}`), { retryable: true });
    let body;
    try { body = JSON.parse(text); } catch { throw Object.assign(new Error(`non-JSON response (HTTP ${res.status})`), { retryable: true }); }
    // Some nodes reject an oversized batch with one error object instead of an array.
    if (!single && !Array.isArray(body) && calls.length > 1) {
      const mid = calls.length >> 1;
      this.batchMax = Math.max(1, mid); // remember the smaller size for later batches
      return [...(await this.#send(calls.slice(0, mid))), ...(await this.#send(calls.slice(mid)))];
    }
    const arr = Array.isArray(body) ? body : [body];
    // A rate-limit error can also arrive as a JSON-RPC error with HTTP 200.
    if (arr.some((r) => r?.error && isRateLimit(r.error))) {
      this.stats.rateLimited++;
      throw Object.assign(new Error('rate limited (JSON-RPC)'), { retryable: true });
    }
    const byId = new Map(arr.map((r) => [r?.id, r]));
    this.stats.calls += calls.length;
    return payload.map((p) => {
      const r = byId.get(p.id);
      if (!r) return { error: { code: -1, message: 'missing response in batch' } };
      return r.error ? { error: r.error } : { result: r.result };
    });
  }
}

/**
 * eth_getLogs over [from, to] with an adaptive block span. Splits the range when the
 * node rejects it (range / result-size caps move around on public RPCs) or when the
 * result is suspiciously close to a silent truncation cap.
 * `state` = { span, max } is kept by the caller so the learned span survives between calls.
 */
export async function getLogsRange(rpc, filter, from, to, state, softCap = 9500) {
  const out = [];
  let a = from;
  while (a <= to) {
    const b = Math.min(a + state.span - 1, to);
    let logs;
    try {
      logs = await rpc.call('eth_getLogs', [{ ...filter, fromBlock: hex(a), toBlock: hex(b) }]);
    } catch (e) {
      if (e instanceof RpcError && b > a) {
        const cap = rangeCapFrom(e);
        const hint = suggestedRangeFrom(e);
        if (cap && cap < b - a + 1) {
          // the node told us its cap: use it from now on instead of growing back into the wall
          state.max = Math.min(state.max, cap);
          state.span = Math.min(state.span, cap);
        } else if (hint && hint[0] === a && hint[1] < b) {
          // a result-size refusal that names the range it would serve: take exactly that, once
          state.span = hint[1] - a + 1;
        } else {
          state.span = Math.max(1, Math.floor((b - a + 1) / 2));
        }
        continue;
      }
      throw e;
    }
    if (logs.length >= softCap && b > a) { state.span = Math.max(1, Math.floor((b - a + 1) / 2)); continue; }
    out.push(...logs);
    a = b + 1;
    if (state.span < state.max) state.span = Math.min(state.max, Math.ceil(state.span * 1.5));
  }
  return out;
}
