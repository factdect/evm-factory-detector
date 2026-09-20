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
const RATE_RE = /rate.?limit|too many requests|exceeded.*(quota|capacity)|throttl/i;
export const isRateLimit = (e) => e?.code === 429 || e?.code === -32005 || RATE_RE.test(e?.message ?? '');
export const isStateUnavailable = (e) =>
  /historical state|missing trie node|state .*not available|pruned|header not found|archive/i.test(e?.message ?? '');

export const hex = (n) => '0x' + Number(n).toString(16);

export class Rpc {
  constructor({ url, headers = {}, minIntervalMs = 500, timeoutMs = 30000, maxRetries = 6, batchMax = 12 }) {
    this.url = url;
    this.headers = headers;
    this.minIntervalMs = minIntervalMs;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.batchMax = batchMax;
    this.queue = [];
    this.running = false;
    this.lastStart = 0;
    this.nextId = 1;
    this.stats = { http: 0, calls: 0, rateLimited: 0, retries: 0, errors: 0 };
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
      out.push(...(await this.#enqueue(slice, opts.priority === true)));
      i += slice.length;
    }
    return out;
  }

  #enqueue(calls, priority) {
    return new Promise((resolve, reject) => {
      const job = { calls, resolve, reject };
      if (priority) this.queue.unshift(job); else this.queue.push(job);
      this.#drain();
    });
  }

  async #drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift();
        try { job.resolve(await this.#send(job.calls)); } catch (e) { job.reject(e); }
      }
    } finally {
      this.running = false;
    }
  }

  async #pace() {
    const wait = this.lastStart + this.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastStart = Date.now();
  }

  async #send(calls) {
    const single = calls.length === 1;
    const payload = calls.map((c) => ({ jsonrpc: '2.0', id: this.nextId++, method: c.method, params: c.params ?? [] }));
    let attempt = 0;
    for (;;) {
      await this.#pace();
      this.stats.http++;
      let backoff = null;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
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
          backoff = Number.isFinite(ra) && ra > 0 ? ra * 1000 : null;
          throw Object.assign(new Error(`HTTP ${res.status}`), { retryable: true });
        }
        if (res.status >= 500) throw Object.assign(new Error(`HTTP ${res.status}`), { retryable: true });
        let body;
        try { body = JSON.parse(text); } catch { throw Object.assign(new Error(`non-JSON response (HTTP ${res.status})`), { retryable: true }); }
        // Some nodes reject an oversized batch with one error object instead of an array.
        if (!single && !Array.isArray(body)) {
          if (calls.length > 1) {
            const mid = calls.length >> 1;
            this.batchMax = Math.max(1, mid); // remember the smaller size for later batches
            return [...(await this.#send(calls.slice(0, mid))), ...(await this.#send(calls.slice(mid)))];
          }
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
      } catch (e) {
        // Only transport problems are worth retrying. A bare TypeError is a bug, not a network blip.
        const retryable = e.retryable || e.name === 'AbortError' || e.name === 'TimeoutError'
          || (e instanceof TypeError && /fetch failed|terminated|network|socket/i.test(e.message));
        if (!retryable || attempt >= this.maxRetries) { this.stats.errors++; throw e; }
        attempt++;
        this.stats.retries++;
        await sleep(backoff ?? Math.min(30000, 1000 * 2 ** (attempt - 1)) + Math.random() * 250);
      }
    }
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
      if (e instanceof RpcError && b > a) { state.span = Math.max(1, Math.floor((b - a + 1) / 2)); continue; }
      throw e;
    }
    if (logs.length >= softCap && b > a) { state.span = Math.max(1, Math.floor((b - a + 1) / 2)); continue; }
    out.push(...logs);
    a = b + 1;
    if (state.span < state.max) state.span = Math.min(state.max, Math.ceil(state.span * 1.5));
  }
  return out;
}
