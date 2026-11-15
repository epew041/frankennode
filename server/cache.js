// server/cache.js — per-source TTL cache with a stale-while-degraded window.
//
// Fresh entries (age <= ttl) are served immediately. Stale-but-within-window
// entries (ttl < age <= staleWindow) are still served while a refetch is
// attempted, masking short outages. Beyond the stale window an entry is
// treated as unavailable. Time is injected so tests need no real timers.
export class Cache {
  constructor(now = Date.now) {
    this.now = now;
    this.store = new Map();
  }

  set(key, value) {
    this.store.set(key, { value, ts: this.now() });
  }

  has(key) {
    return this.store.has(key);
  }

  // Returns the stored value regardless of age, or undefined if never set.
  // Callers use isFresh / isWithinStaleWindow / status to decide freshness.
  get(key) {
    const entry = this.store.get(key);
    return entry ? entry.value : undefined;
  }

  timestamp(key) {
    const entry = this.store.get(key);
    return entry ? entry.ts : null;
  }

  age(key) {
    const entry = this.store.get(key);
    return entry ? this.now() - entry.ts : Infinity;
  }

  isFresh(key, ttl) {
    return this.has(key) && this.age(key) <= ttl;
  }

  isWithinStaleWindow(key, staleWindow) {
    return this.has(key) && this.age(key) <= staleWindow;
  }

  // Returns the value only while it is still within the stale window; once the
  // window has expired this returns undefined ("unavailable").
  getIfAvailable(key, staleWindow) {
    return this.isWithinStaleWindow(key, staleWindow) ? this.get(key) : undefined;
  }

  // 'missing' | 'fresh' | 'stale' | 'expired'
  status(key, ttl, staleWindow) {
    if (!this.has(key)) return "missing";
    const age = this.age(key);
    if (age <= ttl) return "fresh";
    if (age <= staleWindow) return "stale";
    return "expired";
  }

  delete(key) {
    this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }
}

export default Cache;
