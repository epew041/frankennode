import { test } from "node:test";
import assert from "node:assert/strict";
import { Cache } from "../server/cache.js";

// A controllable clock so cache behavior is tested without real timers.
function makeClock() {
  let t = 0;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

test("fresh set then get returns the value", () => {
  const c = makeClock();
  const cache = new Cache(c.now);
  cache.set("solana", { validators: [1, 2] });
  assert.deepEqual(cache.get("solana"), { validators: [1, 2] });
  c.advance(5000);
  assert.deepEqual(cache.get("solana"), { validators: [1, 2] });
  assert.equal(cache.timestamp("solana"), 0);
});

test("isFresh is true within TTL and false after", () => {
  const c = makeClock();
  const cache = new Cache(c.now);
  cache.set("x", 1);
  assert.equal(cache.isFresh("x", 10000), true);
  c.advance(10000); // exactly at TTL boundary is still fresh
  assert.equal(cache.isFresh("x", 10000), true);
  c.advance(1); // one ms past TTL
  assert.equal(cache.isFresh("x", 10000), false);
});

test("stale-but-within-window returns value and is distinguishable from fresh", () => {
  const c = makeClock();
  const cache = new Cache(c.now);
  cache.set("x", 42);
  c.advance(20000); // stale (past 10s TTL), within 100s stale window
  assert.equal(cache.isFresh("x", 10000), false);
  assert.equal(cache.isWithinStaleWindow("x", 100000), true);
  assert.equal(cache.status("x", 10000, 100000), "stale");
  assert.equal(cache.getIfAvailable("x", 100000), 42);
});

test("entry beyond the stale window reports unavailable", () => {
  const c = makeClock();
  const cache = new Cache(c.now);
  cache.set("x", 42);
  c.advance(100001); // beyond the 100s stale window
  assert.equal(cache.isWithinStaleWindow("x", 100000), false);
  assert.equal(cache.status("x", 10000, 100000), "expired");
  assert.equal(cache.getIfAvailable("x", 100000), undefined);
  // raw get still returns the stored value; availability is the caller's call
  assert.equal(cache.get("x"), 42);
});

test("missing entry reports missing", () => {
  const cache = new Cache();
  assert.equal(cache.status("nope", 10000, 100000), "missing");
  assert.equal(cache.get("nope"), undefined);
  assert.equal(cache.isFresh("nope", 10000), false);
  assert.equal(cache.isWithinStaleWindow("nope", 100000), false);
});
