export const RECENT_SCOPES = Object.freeze(['workload', 'observer', 'all']);

export function finiteInteger(value, { min, max, fallback }) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : null;
}

export function recentOptions(searchParams) {
  const minutes = finiteInteger(searchParams.get('minutes'), { min: 1, max: 60, fallback: 15 });
  const minSpans = finiteInteger(searchParams.get('minSpans'), { min: 1, max: 1000, fallback: 1 });
  const errors = searchParams.get('errors') || 'any';
  const scope = searchParams.get('scope') || 'workload';
  if (minutes === null) throw new RangeError('minutes must be an integer from 1 to 60');
  if (minSpans === null) throw new RangeError('minSpans must be an integer from 1 to 1000');
  if (!['any', 'only', 'none'].includes(errors)) throw new RangeError('errors must be any, only, or none');
  if (!RECENT_SCOPES.includes(scope)) throw new RangeError('scope must be workload, observer, or all');
  return { minutes, minSpans, errors, scope };
}

export function filterSummaries(rows, { minSpans, errors }) {
  return rows.filter((row) => {
    const errorCount = Array.isArray(row?.errors) ? row.errors.length : Number(row?.errors) || 0;
    return Number(row?.spans) >= minSpans && (errors === 'any' || (errors === 'only' ? errorCount > 0 : errorCount === 0));
  });
}

export function retryAfterSeconds(header, now = Date.now(), fallback = 2, maximum = 300) {
  if (!header) return fallback;
  const numeric = Number(header);
  const seconds = Number.isFinite(numeric) ? numeric : (Date.parse(header) - now) / 1000;
  return Math.max(0, Math.min(maximum, Number.isFinite(seconds) ? Math.ceil(seconds) : fallback));
}

// Browser-safe helpers are stringified into the gallery by worker.mjs, so keep them
// self-contained (no module-scope dependencies).
export function retryAfterMilliseconds(header, now = Date.now(), fallback = 2_000, maximum = 300_000) {
  if (!header) return fallback;
  const numeric = Number(header);
  const milliseconds = Number.isFinite(numeric) ? numeric * 1_000 : Date.parse(header) - now;
  return Math.max(0, Math.min(maximum, Number.isFinite(milliseconds) ? Math.ceil(milliseconds) : fallback));
}

export function createRequestScheduler({
  limit = 18,
  windowMs = 60_000,
  now = () => Date.now(),
  sleep = (milliseconds, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    }, { once: true });
  }),
  onWait = () => {},
} = {}) {
  const starts = [];
  return {
    starts,
    async permit(signal) {
      for (;;) {
        if (signal?.aborted) throw signal.reason ?? new DOMException('Cancelled', 'AbortError');
        const time = now();
        while (starts.length && starts[0] <= time - windowMs) starts.shift();
        if (starts.length < limit) {
          starts.push(time);
          return time;
        }
        const wait = Math.max(1, starts[0] + windowMs - time);
        onWait(wait, starts.length);
        await sleep(wait, signal);
      }
    },
  };
}

export function createBlobUrlStore({ maxEntries = 24, revoke = (url) => URL.revokeObjectURL(url) } = {}) {
  const entries = new Map(), owners = new Map();
  const discard = (key, entry) => {
    if (entries.get(key) === entry) entries.delete(key);
    entry.discarded = true;
    if (!entry.owners.size) revoke(entry.url);
  };
  const trim = () => {
    while (entries.size > maxEntries) {
      const candidate = [...entries].find(([, entry]) => !entry.owners.size);
      if (!candidate) break; // Displayed URLs stay valid; release() resumes trimming.
      discard(candidate[0], candidate[1]);
    }
  };
  const release = (owner) => {
    const entry = owners.get(owner);
    if (!entry) return;
    owners.delete(owner);
    entry.owners.delete(owner);
    if (entry.discarded && !entry.owners.size) revoke(entry.url);
    trim();
  };
  return {
    entries,
    get(key) {
      const entry = entries.get(key);
      if (entry) { entries.delete(key); entries.set(key, entry); }
      return entry;
    },
    put(key, value, owner) {
      const old = entries.get(key);
      if (old && old !== value) discard(key, old);
      if (owner !== undefined) release(owner);
      const entry = { ...value, owners: new Set(), discarded: false };
      if (owner !== undefined) { entry.owners.add(owner); owners.set(owner, entry); }
      entries.set(key, entry);
      trim();
      return entry;
    },
    bind(owner, key) {
      release(owner);
      const entry = entries.get(key);
      if (!entry) return null;
      entry.owners.add(owner);
      owners.set(owner, entry);
      return entry;
    },
    release,
    delete(key) { const entry = entries.get(key); if (entry) discard(key, entry); },
    clear() {
      for (const [owner] of owners) release(owner);
      for (const [key, entry] of entries) discard(key, entry);
    },
  };
}

// Small in-isolate LRU-ish cache. Pending loads are shared, rejected loads are removed,
// and both entry count and approximate weight are hard bounds.
export class CacheCapacityError extends Error {
  constructor(retryAfter = 2) {
    super('render capacity is busy; retry later');
    this.name = 'CacheCapacityError';
    this.publicStatus = 503;
    this.retryAfter = retryAfter;
  }
}

export class BoundedCoalescingCache {
  constructor({ maxEntries, maxPending = maxEntries, maxWeight, ttlMs, weight = () => 1, now = () => Date.now(), retryAfter = 2 }) {
    this.maxEntries = maxEntries;
    this.maxPending = Math.min(maxEntries, maxPending);
    this.maxWeight = maxWeight;
    this.ttlMs = ttlMs;
    this.weight = weight;
    this.now = now;
    this.retryAfter = retryAfter;
    this.entries = new Map();
  }
  delete(key) { this.entries.delete(key); }
  get pendingCount() { return [...this.entries.values()].filter((entry) => entry.pending).length; }
  prune() {
    const now = this.now();
    for (const [key, entry] of this.entries) if (!entry.pending && entry.expires <= now) this.entries.delete(key);
    let weight = [...this.entries.values()].reduce((sum, entry) => sum + (entry.pending ? 0 : entry.weight), 0);
    while (this.entries.size > this.maxEntries || weight > this.maxWeight) {
      const settled = [...this.entries].find(([, entry]) => !entry.pending);
      if (!settled) break;
      this.entries.delete(settled[0]);
      weight -= settled[1].weight;
    }
  }
  async get(key, load) {
    this.prune();
    const existing = this.entries.get(key);
    if (existing && (existing.pending || existing.expires > this.now())) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing.promise;
    }
    if (existing) this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const settled = [...this.entries].find(([, entry]) => !entry.pending);
      if (!settled) throw new CacheCapacityError(this.retryAfter);
      this.entries.delete(settled[0]);
    }
    if (this.pendingCount >= this.maxPending) throw new CacheCapacityError(this.retryAfter);
    const entry = { pending: true, expires: Infinity, weight: 0, promise: null };
    entry.promise = Promise.resolve().then(load).then((value) => {
      entry.pending = false;
      entry.expires = this.now() + this.ttlMs;
      entry.weight = Math.max(0, Number(this.weight(value)) || 0);
      this.prune();
      return value;
    }, (error) => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    });
    this.entries.set(key, entry);
    return entry.promise;
  }
}
