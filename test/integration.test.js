import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../server/index.js";

// Integration: stand up the HTTP server against stubbed sources and assert the
// composite /api/state shape, the partial-failure case (9.3), the
// stale-while-degraded serving path (9.1), and the all-down case (9.2).

function fixtures() {
  return {
    solana: {
      result: {
        current: [
          {
            votePubkey: "vote1",
            nodePubkey: "n1",
            activatedStake: 1000000000,
            commission: 7,
            epochCredits: [[1, 250, 100]],
            lastVote: 1000,
            rootSlot: 999,
          },
        ],
        delinquent: [],
      },
    },
    ethBlock: { result: "0x12" },
    ethFees: { result: { baseFeePerGas: ["0x4a817c800", "0x3b9aca00"], gasUsedRatio: [0.5] } },
    btcFees: { fastestFee: 20, halfHourFee: 15, hourFee: 10, economyFee: 5, minimumFee: 1 },
    btcMempool: { count: 1000, vsize: 5000 },
    cg: { solana: { usd: 100 }, ethereum: { usd: 3000 }, bitcoin: { usd: 60000 } },
  };
}

function makeFetch(fix, flags) {
  const methodOf = (opts) => {
    try {
      return JSON.parse(opts.body).method;
    } catch {
      return null;
    }
  };
  return async (url, opts = {}) => {
    if (flags.allDown) throw new Error("all down");
    if (url.includes("solana.com")) {
      if (flags.solanaDown) throw new Error("solana down");
      return { ok: true, json: async () => fix.solana };
    }
    if (url.includes("coingecko")) {
      if (flags.cgDown) throw new Error("cg down");
      return { ok: true, json: async () => fix.cg };
    }
    if (url.includes("fees/recommended")) {
      if (flags.btcDown) throw new Error("btc down");
      return { ok: true, json: async () => fix.btcFees };
    }
    if (url.includes("/api/mempool")) {
      if (flags.btcDown) throw new Error("btc down");
      return { ok: true, json: async () => fix.btcMempool };
    }
    if (methodOf(opts) === "eth_blockNumber") {
      if (flags.ethDown) throw new Error("eth down");
      return { ok: true, json: async () => fix.ethBlock };
    }
    if (methodOf(opts) === "eth_feeHistory") {
      if (flags.ethDown) throw new Error("eth down");
      return { ok: true, json: async () => fix.ethFees };
    }
    throw new Error("no route for " + url);
  };
}

function start(flags) {
  const fix = fixtures();
  const clock = { t: 0, now: () => clock.t, advance: (ms) => (clock.t += ms) };
  const server = createServer({ fetchImpl: makeFetch(fix, flags), now: clock.now });
  return new Promise((resolve) => {
    server.listen(0, () => resolve({ server, port: server.address().port, clock, flags }));
  });
}

async function getState(port) {
  const res = await fetch(`http://localhost:${port}/api/state`);
  return { status: res.status, body: await res.json() };
}

test("9.3: one source failing returns the other three with the failed one down", async () => {
  const { server, port } = await start({ cgDown: true });
  try {
    const { status, body } = await getState(port);
    assert.equal(status, 200);
    assert.deepEqual(
      Object.keys(body.sources).sort(),
      ["bitcoin", "coingecko", "ethereum", "solana"]
    );
    assert.equal(body.sources.coingecko.status, "down");
    assert.equal(body.sources.solana.status, "ok");
    assert.equal(body.sources.ethereum.status, "ok");
    assert.equal(body.sources.bitcoin.status, "ok");
    // the other three sources still have their data
    assert.ok(body.validators.length >= 1);
    assert.equal(body.networkPressure.ethereum.blockNumber, 18);
    assert.equal(body.networkPressure.bitcoin.fees.fastestFee, 20);
    // coingecko down -> no price data
    assert.equal(body.networkPressure.prices.SOL.usd, null);
  } finally {
    server.close();
  }
});

test("9.1: stale-while-degraded serves cached value as degraded, then down beyond the window", async () => {
  const { server, port, clock, flags } = await start({});
  try {
    // first request at t=0: all ok, cache populated
    let r = await getState(port);
    assert.equal(r.body.sources.solana.status, "ok");
    assert.ok(r.body.validators.length >= 1);
    const firstStake = r.body.validators[0].activatedStake;

    // advance past the 10s Solana TTL but within the 100s stale window
    clock.advance(20000);
    flags.solanaDown = true;
    r = await getState(port);
    assert.equal(r.body.sources.solana.status, "degraded");
    // last value still served while degraded
    assert.ok(r.body.validators.length >= 1);
    assert.equal(r.body.validators[0].activatedStake, firstStake);
    // other sources remain ok (their TTLs are longer and stubs still work)
    assert.equal(r.body.sources.ethereum.status, "ok");

    // advance well beyond the stale window -> solana goes down, no data shown
    clock.advance(200000);
    r = await getState(port);
    assert.equal(r.body.sources.solana.status, "down");
    assert.equal(r.body.validators.length, 0);
  } finally {
    server.close();
  }
});

test("9.2: when every source is down, all statuses are down and no data is presented", async () => {
  const { server, port } = await start({ allDown: true });
  try {
    const { body } = await getState(port);
    for (const name of ["solana", "ethereum", "bitcoin", "coingecko"]) {
      assert.equal(body.sources[name].status, "down", `${name} should be down`);
    }
    assert.equal(body.validators.length, 0);
    assert.equal(body.anomalies.length, 0);
    assert.equal(body.networkPressure.prices.SOL.usd, null);
  } finally {
    server.close();
  }
});

test("/api/health returns source statuses cheaply", async () => {
  const { server, port } = await start({});
  try {
    // populate cache via /api/state first
    await getState(port);
    const res = await fetch(`http://localhost:${port}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(
      Object.keys(body.sources).sort(),
      ["bitcoin", "coingecko", "ethereum", "solana"]
    );
    assert.equal(body.sources.solana.status, "ok");
  } finally {
    server.close();
  }
});
