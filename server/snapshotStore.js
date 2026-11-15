// server/snapshotStore.js — in-memory current + previous normalized snapshot
// per source. Comparison rules read current vs. previous here. The price
// divergence rule also needs a short rolling window of past snapshots, so
// push() can optionally retain a bounded history (only used for coingecko).
export class SnapshotStore {
  constructor() {
    this.store = new Map();
  }

  // previous := old current, current := new value. Optionally keep the old
  // current in a bounded history array (for the rolling-window price rule).
  push(source, value, keepHistory = 0) {
    const prev = this.store.get(source) || {
      current: undefined,
      previous: undefined,
      history: [],
    };
    const history = prev.history.slice();
    if (keepHistory > 0 && prev.current !== undefined) {
      history.push(prev.current);
      if (history.length > keepHistory) {
        history.splice(0, history.length - keepHistory);
      }
    }
    this.store.set(source, {
      current: value,
      previous: prev.current,
      history,
    });
  }

  // Returns { current, previous, history }. For a source never pushed, current
  // and previous are undefined and history is [].
  get(source) {
    const entry = this.store.get(source);
    if (!entry) return { current: undefined, previous: undefined, history: [] };
    return { current: entry.current, previous: entry.previous, history: entry.history };
  }

  current(source) {
    return this.get(source).current;
  }

  clear() {
    this.store.clear();
  }
}

export default SnapshotStore;
