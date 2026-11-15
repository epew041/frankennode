import { test } from "node:test";
import assert from "node:assert/strict";
import { SnapshotStore } from "../server/snapshotStore.js";
import { config } from "../server/config.js";
import {
  runAll,
  ruleValidatorDelinquent,
  ruleCommissionChange,
  ruleStakeDrop,
  ruleMissedVotes,
  ruleEthereumFeeSpike,
  ruleMempoolCongestion,
  rulePriceDivergence,
} from "../server/rules.js";

const NOW = 1_700_000_000_000;
const ctx = () => ({ now: NOW, history: [] });

function validator(pubkey, status, opts = {}) {
  return {
    votePubkey: pubkey,
    nodePubkey: "n-" + pubkey,
    status,
    activatedStake: opts.stake ?? 1e9,
    commission: opts.commission ?? 5,
    epochCredits: opts.credits ?? 1000,
    lastVote: opts.lastVote ?? 1000,
    rootSlot: opts.rootSlot ?? 999,
  };
}

// ---- Snapshot store (task 5.1) ----
test("snapshot store: first push leaves previous undefined", () => {
  const store = new SnapshotStore();
  store.push("solana", [1]);
  const snap = store.get("solana");
  assert.deepEqual(snap.current, [1]);
  assert.equal(snap.previous, undefined);
  assert.deepEqual(snap.history, []);
});

test("snapshot store: second push makes previous the old current", () => {
  const store = new SnapshotStore();
  store.push("solana", [1]);
  store.push("solana", [2]);
  const snap = store.get("solana");
  assert.deepEqual(snap.current, [2]);
  assert.deepEqual(snap.previous, [1]);
});

test("snapshot store: keepHistory retains a bounded rolling window", () => {
  const store = new SnapshotStore();
  store.push("coingecko", { SOL: { usd: 100 } }, 3);
  store.push("coingecko", { SOL: { usd: 101 } }, 3);
  store.push("coingecko", { SOL: { usd: 102 } }, 3);
  store.push("coingecko", { SOL: { usd: 103 } }, 3);
  store.push("coingecko", { SOL: { usd: 104 } }, 3);
  const snap = store.get("coingecko");
  assert.deepEqual(snap.current, { SOL: { usd: 104 } });
  assert.deepEqual(snap.previous, { SOL: { usd: 103 } });
  assert.equal(snap.history.length, 3);
  assert.deepEqual(snap.history[0], { SOL: { usd: 101 } });
  assert.deepEqual(snap.history[2], { SOL: { usd: 103 } });
});

// ---- Rule: validator newly delinquent (6.2) ----
test("validatorDelinquent: current->delinquent flip raises critical", () => {
  const prev = [validator("v1", "current")];
  const cur = [validator("v1", "delinquent")];
  const out = ruleValidatorDelinquent(cur, prev, config, ctx());
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, "critical");
  assert.equal(out[0].source, "solana");
  assert.equal(out[0].subject, "v1");
});

test("validatorDelinquent: unchanged pair raises nothing", () => {
  const prev = [validator("v1", "current")];
  const cur = [validator("v1", "current")];
  assert.equal(ruleValidatorDelinquent(cur, prev, config, ctx()).length, 0);
});

test("validatorDelinquent: no previous raises nothing (first cycle)", () => {
  const cur = [validator("v1", "delinquent")];
  assert.equal(ruleValidatorDelinquent(cur, undefined, config, ctx()).length, 0);
});

// ---- Rule: commission change (6.3) ----
test("commissionChange: increase raises warning, decrease raises info", () => {
  const prev = [validator("v1", "current", { commission: 5 })];
  const up = [validator("v1", "current", { commission: 8 })];
  const down = [validator("v1", "current", { commission: 3 })];
  assert.equal(ruleCommissionChange(up, prev, config, ctx())[0].severity, "warning");
  assert.equal(ruleCommissionChange(down, prev, config, ctx())[0].severity, "info");
});

test("commissionChange: no change raises nothing", () => {
  const prev = [validator("v1", "current", { commission: 5 })];
  const cur = [validator("v1", "current", { commission: 5 })];
  assert.equal(ruleCommissionChange(cur, prev, config, ctx()).length, 0);
});

test("commissionChange: first cycle raises nothing", () => {
  const cur = [validator("v1", "current", { commission: 5 })];
  assert.equal(ruleCommissionChange(cur, undefined, config, ctx()).length, 0);
});

// ---- Rule: large stake drop (6.4) ----
test("stakeDrop: drop just above threshold raises warning", () => {
  const prev = [validator("v1", "current", { stake: 100 })];
  const cur = [validator("v1", "current", { stake: 94 })]; // 6% drop > 5%
  const out = ruleStakeDrop(cur, prev, config, ctx());
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, "warning");
  assert.ok(out[0].details.dropPct > 5);
});

test("stakeDrop: drop just below threshold and any increase raise nothing", () => {
  const prev = [validator("v1", "current", { stake: 100 })];
  const justBelow = [validator("v1", "current", { stake: 96 })]; // 4%
  const increase = [validator("v1", "current", { stake: 110 })];
  assert.equal(ruleStakeDrop(justBelow, prev, config, ctx()).length, 0);
  assert.equal(ruleStakeDrop(increase, prev, config, ctx()).length, 0);
});

test("stakeDrop: first cycle raises nothing", () => {
  const cur = [validator("v1", "current", { stake: 10 })];
  assert.equal(ruleStakeDrop(cur, undefined, config, ctx()).length, 0);
});

// ---- Rule: missed votes (6.5) ----
test("missedVotes: barely advancing credits raises warning", () => {
  const prev = [validator("v1", "current", { credits: 1000, lastVote: 1000 })];
  const cur = [validator("v1", "current", { credits: 1050, lastVote: 1100 })]; // expected 100, got 50
  const out = ruleMissedVotes(cur, prev, config, ctx());
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, "warning");
  assert.equal(out[0].details.missed, 50);
});

test("missedVotes: advancing by expected amount raises nothing", () => {
  const prev = [validator("v1", "current", { credits: 1000, lastVote: 1000 })];
  const cur = [validator("v1", "current", { credits: 1090, lastVote: 1100 })]; // 90 of 100, ratio 0.9
  assert.equal(ruleMissedVotes(cur, prev, config, ctx()).length, 0);
});

test("missedVotes: epoch rollover (credits decrease) does not fire", () => {
  const prev = [validator("v1", "current", { credits: 5000, lastVote: 1000 })];
  const cur = [validator("v1", "current", { credits: 10, lastVote: 1100 })]; // epoch reset
  assert.equal(ruleMissedVotes(cur, prev, config, ctx()).length, 0);
});

test("missedVotes: first cycle raises nothing", () => {
  const cur = [validator("v1", "current", { credits: 10, lastVote: 100 })];
  assert.equal(ruleMissedVotes(cur, undefined, config, ctx()).length, 0);
});

// ---- Rule: Ethereum fee spike (6.6) ----
test("ethereumFeeSpike: clear spike raises warning", () => {
  const snap = { blockNumber: 18, baseFeePerGas: [10, 10, 10, 10, 10, 25], gasUsedRatio: [], rewardPercentiles: [] };
  const out = ruleEthereumFeeSpike(snap, undefined, config, ctx());
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, "warning");
});

test("ethereumFeeSpike: flat window raises nothing", () => {
  const snap = { blockNumber: 18, baseFeePerGas: [10, 10, 10, 10, 10, 10], gasUsedRatio: [], rewardPercentiles: [] };
  assert.equal(ruleEthereumFeeSpike(snap, undefined, config, ctx()).length, 0);
});

test("ethereumFeeSpike: 2x absolute spike raises critical", () => {
  const snap = { blockNumber: 18, baseFeePerGas: [10, 10, 10, 10, 10, 120], gasUsedRatio: [], rewardPercentiles: [] };
  const out = ruleEthereumFeeSpike(snap, undefined, config, ctx());
  assert.equal(out[0].severity, "critical");
});

// ---- Rule: mempool congestion spike (6.7) ----
test("mempoolCongestion: high fastestFee raises warning", () => {
  const snap = { fees: { fastestFee: 60, halfHourFee: 1, hourFee: 1, economyFee: 1, minimumFee: 1 }, mempool: { count: 1000, vsize: 1 } };
  const out = ruleMempoolCongestion(snap, undefined, config, ctx());
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, "warning");
  assert.ok(out[0].details.triggeredBy.includes("fee"));
});

test("mempoolCongestion: high mempool count raises warning", () => {
  const snap = { fees: { fastestFee: 10, halfHourFee: 1, hourFee: 1, economyFee: 1, minimumFee: 1 }, mempool: { count: 60000, vsize: 1 } };
  const out = ruleMempoolCongestion(snap, undefined, config, ctx());
  assert.equal(out.length, 1);
  assert.ok(out[0].details.triggeredBy.includes("count"));
});

test("mempoolCongestion: calm fixture raises nothing", () => {
  const snap = { fees: { fastestFee: 20, halfHourFee: 1, hourFee: 1, economyFee: 1, minimumFee: 1 }, mempool: { count: 1000, vsize: 1 } };
  assert.equal(ruleMempoolCongestion(snap, undefined, config, ctx()).length, 0);
});

// ---- Rule: price divergence (6.8) ----
test("priceDivergence: price beyond rolling average raises warning", () => {
  const history = [
    { SOL: { usd: 100 }, ETH: { usd: 3000 }, BTC: { usd: 60000 } },
    { SOL: { usd: 100 }, ETH: { usd: 3000 }, BTC: { usd: 60000 } },
  ];
  const cur = { SOL: { usd: 150 }, ETH: { usd: 3000 }, BTC: { usd: 60000 } };
  const out = rulePriceDivergence(cur, history[1], config, { now: NOW, history });
  assert.equal(out.length, 1);
  assert.equal(out[0].subject, "SOL");
  assert.equal(out[0].severity, "warning");
});

test("priceDivergence: stable series raises nothing", () => {
  const history = [
    { SOL: { usd: 100 }, ETH: { usd: 3000 }, BTC: { usd: 60000 } },
    { SOL: { usd: 101 }, ETH: { usd: 2999 }, BTC: { usd: 60100 } },
  ];
  const cur = { SOL: { usd: 100 }, ETH: { usd: 3000 }, BTC: { usd: 60000 } };
  assert.equal(rulePriceDivergence(cur, history[1], config, { now: NOW, history }).length, 0);
});

test("priceDivergence: first cycle (no history) raises nothing", () => {
  const cur = { SOL: { usd: 999 }, ETH: { usd: 3000 }, BTC: { usd: 60000 } };
  assert.equal(rulePriceDivergence(cur, undefined, config, { now: NOW, history: [] }).length, 0);
});

// ---- Runner + explainers (6.1, 6.9, 6.10) ----
function seedSnapshots() {
  return {
    solana: {
      current: [validator("v1", "delinquent", { commission: 8 })],
      previous: [validator("v1", "current", { commission: 5, stake: 100 })],
      history: [],
    },
    ethereum: {
      current: { blockNumber: 18, baseFeePerGas: [10, 10, 10, 10, 10, 120], gasUsedRatio: [], rewardPercentiles: [] },
      previous: undefined,
      history: [],
    },
    bitcoin: {
      current: { fees: { fastestFee: 60, halfHourFee: 1, hourFee: 1, economyFee: 1, minimumFee: 1 }, mempool: { count: 1000, vsize: 1 } },
      previous: undefined,
      history: [],
    },
    coingecko: {
      current: { SOL: { usd: 150 }, ETH: { usd: 3000 }, BTC: { usd: 60000 } },
      previous: { SOL: { usd: 100 }, ETH: { usd: 3000 }, BTC: { usd: 60000 } },
      history: [
        { SOL: { usd: 100 }, ETH: { usd: 3000 }, BTC: { usd: 60000 } },
      ],
    },
  };
}

test("runAll: comparison rules are skipped on the first cycle", () => {
  const snapshots = seedSnapshots();
  snapshots.solana.previous = undefined;
  snapshots.coingecko.previous = undefined;
  snapshots.coingecko.history = [];
  const out = runAll(snapshots, config, NOW);
  // only snapshot rules (ethereum fee spike + bitcoin congestion) should fire
  const types = out.map((a) => a.type);
  assert.ok(!types.includes("validatorDelinquent"));
  assert.ok(!types.includes("commissionChange"));
  assert.ok(!types.includes("stakeDrop"));
  assert.ok(!types.includes("missedVotes"));
  assert.ok(!types.includes("priceDivergence"));
  assert.ok(types.includes("ethereumFeeSpike"));
  assert.ok(types.includes("mempoolCongestion"));
});

test("runAll: every anomaly is enriched with English explanation + suggested checks", () => {
  const out = runAll(seedSnapshots(), config, NOW);
  assert.ok(out.length >= 4, "expected several anomalies from the seeded fixtures");
  for (const a of out) {
    assert.equal(typeof a.id, "string");
    assert.ok(a.id.length > 0);
    assert.equal(typeof a.explanation, "string");
    assert.ok(a.explanation.length > 0, `${a.type} has empty explanation`);
    assert.ok(Array.isArray(a.suggestedChecks) && a.suggestedChecks.length >= 1, `${a.type} has no suggested checks`);
    assert.equal(a.timestamp, NOW);
    // sanity: explanation should be English text (no non-English placeholder)
    assert.match(a.explanation, /[A-Za-z]/);
  }
});

test("runAll: sorts by severity desc then timestamp desc", () => {
  const out = runAll(seedSnapshots(), config, NOW);
  const ranks = out.map((a) => ({ critical: 3, warning: 2, info: 1 }[a.severity] || 0));
  for (let i = 1; i < ranks.length; i++) {
    assert.ok(ranks[i] <= ranks[i - 1], "severities must be non-increasing");
  }
  // the Ethereum fee spike (critical) should come before warnings
  const critIdx = out.findIndex((a) => a.severity === "critical");
  const warnIdx = out.findIndex((a) => a.severity === "warning");
  assert.ok(critIdx !== -1 && warnIdx !== -1 && critIdx < warnIdx);
});

test("runAll: deterministic — identical inputs twice yield identical ordered output", () => {
  const a = runAll(seedSnapshots(), config, NOW);
  const b = runAll(seedSnapshots(), config, NOW);
  assert.deepEqual(a, b);
});

test("runAll: source down (no current) skips its rules", () => {
  const snapshots = seedSnapshots();
  delete snapshots.ethereum.current;
  snapshots.ethereum.current = null;
  const out = runAll(snapshots, config, NOW);
  assert.ok(!out.some((a) => a.type === "ethereumFeeSpike"));
});
