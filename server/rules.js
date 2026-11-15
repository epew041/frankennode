// server/rules.js — deterministic anomaly rule engine (pure functions).
// Each rule has the signature (current, previous, config, ctx) => Anomaly[],
// where ctx = { now, history }. Comparison rules need a previous snapshot and
// return nothing on the first cycle; snapshot rules run on the current
// snapshot alone. The runner maps each rule over the relevant snapshots,
// enriches each result with an English explanation + suggested checks, and
// sorts by severity (critical > warning > info) then timestamp descending.
import { enrichAnomaly } from "./explainers.js";

const SEVERITY_RANK = { critical: 3, warning: 2, info: 1 };
const NOW_DEFAULT = () => Date.now();

function anomaly({ type, severity, source, subject, details }, now) {
  return { type, severity, source, subject, details: details || {}, timestamp: now };
}

function indexBy(arr, key) {
  const m = new Map();
  for (const v of arr) {
    if (v && v[key] != null) m.set(v[key], v);
  }
  return m;
}

// ---- Solana comparison rules ----

// Validator newly delinquent: status flips current -> delinquent (critical).
export function ruleValidatorDelinquent(current, previous, config, ctx) {
  if (!previous) return [];
  const prevMap = indexBy(previous, "votePubkey");
  const out = [];
  for (const v of current) {
    const p = prevMap.get(v.votePubkey);
    if (p && p.status === "current" && v.status === "delinquent") {
      out.push(
        anomaly(
          {
            type: "validatorDelinquent",
            severity: "critical",
            source: "solana",
            subject: v.votePubkey,
            details: {
              commission: v.commission,
              activatedStake: v.activatedStake,
              lastVote: v.lastVote,
            },
          },
          ctx.now
        )
      );
    }
  }
  return out;
}

// Commission change: any delta (warning on increase, info on decrease).
export function ruleCommissionChange(current, previous, config, ctx) {
  if (!previous) return [];
  const prevMap = indexBy(previous, "votePubkey");
  const out = [];
  for (const v of current) {
    const p = prevMap.get(v.votePubkey);
    if (p && v.commission !== p.commission) {
      const severity = v.commission > p.commission ? "warning" : "info";
      out.push(
        anomaly(
          {
            type: "commissionChange",
            severity,
            source: "solana",
            subject: v.votePubkey,
            details: { from: p.commission, to: v.commission },
          },
          ctx.now
        )
      );
    }
  }
  return out;
}

// Large stake drop: activatedStake drop > stakeDropPct (warning).
export function ruleStakeDrop(current, previous, config, ctx) {
  if (!previous) return [];
  const prevMap = indexBy(previous, "votePubkey");
  const out = [];
  for (const v of current) {
    const p = prevMap.get(v.votePubkey);
    if (!p || p.activatedStake <= 0) continue;
    const dropPct = ((p.activatedStake - v.activatedStake) / p.activatedStake) * 100;
    if (dropPct > config.rules.stakeDropPct) {
      out.push(
        anomaly(
          {
            type: "stakeDrop",
            severity: "warning",
            source: "solana",
            subject: v.votePubkey,
            details: { from: p.activatedStake, to: v.activatedStake, dropPct },
          },
          ctx.now
        )
      );
    }
  }
  return out;
}

// Missed votes: epochCredits delta below expected slots elapsed (warning).
export function ruleMissedVotes(current, previous, config, ctx) {
  if (!previous) return [];
  const prevMap = indexBy(previous, "votePubkey");
  const out = [];
  for (const v of current) {
    const p = prevMap.get(v.votePubkey);
    if (!p) continue;
    const actualDelta = v.epochCredits - p.epochCredits;
    const expectedDelta = v.lastVote - p.lastVote;
    if (expectedDelta <= 0) continue; // no slots elapsed in the window
    if (actualDelta < 0) continue; // epoch rollover: cannot compare reliably
    if (actualDelta < expectedDelta * config.rules.missedVotesRatio) {
      out.push(
        anomaly(
          {
            type: "missedVotes",
            severity: "warning",
            source: "solana",
            subject: v.votePubkey,
            details: {
              expectedDelta,
              actualDelta,
              missed: Math.round(expectedDelta - actualDelta),
            },
          },
          ctx.now
        )
      );
    }
  }
  return out;
}

// ---- Ethereum snapshot rule ----

// Ethereum fee spike: latest baseFee > multiple of window mean, or above an
// absolute gwei threshold. Critical above 2x the absolute threshold.
export function ruleEthereumFeeSpike(current, previous, config, ctx) {
  if (!current || !Array.isArray(current.baseFeePerGas) || current.baseFeePerGas.length === 0) {
    return [];
  }
  const baseFees = current.baseFeePerGas;
  const latest = baseFees[baseFees.length - 1];
  const window = baseFees.slice(0, -1);
  const mean = window.length
    ? window.reduce((a, b) => a + b, 0) / window.length
    : latest;
  const spikeVsMean = latest > mean * config.rules.feeSpikeMultiple;
  const overAbs = latest > config.rules.feeSpikeGwei;
  const critical = latest > config.rules.feeSpikeGwei * config.rules.feeSpikeCriticalMultiple;
  if (!(spikeVsMean || overAbs || critical)) return [];
  return [
    anomaly(
      {
        type: "ethereumFeeSpike",
        severity: critical ? "critical" : "warning",
        source: "ethereum",
        subject: "Ethereum base fee",
        details: {
          latest,
          mean,
          threshold: config.rules.feeSpikeGwei,
          blockNumber: current.blockNumber,
        },
      },
      ctx.now
    ),
  ];
}

// ---- Bitcoin snapshot rule ----

// Mempool congestion spike: fastestFee > threshold or mempool.count > threshold.
export function ruleMempoolCongestion(current, previous, config, ctx) {
  if (!current || !current.fees || !current.mempool) return [];
  const fastestFee = current.fees.fastestFee;
  const count = current.mempool.count;
  const feeTrigger = fastestFee > config.rules.mempoolFeeThreshold;
  const countTrigger = count > config.rules.mempoolCountThreshold;
  if (!feeTrigger && !countTrigger) return [];
  const triggeredBy = [
    feeTrigger ? "fee" : null,
    countTrigger ? "count" : null,
  ].filter(Boolean);
  return [
    anomaly(
      {
        type: "mempoolCongestion",
        severity: "warning",
        source: "bitcoin",
        subject: "Bitcoin mempool",
        details: {
          fastestFee,
          count,
          feeThreshold: config.rules.mempoolFeeThreshold,
          countThreshold: config.rules.mempoolCountThreshold,
          triggeredBy,
        },
      },
      ctx.now
    ),
  ];
}

// ---- CoinGecko comparison rule ----

// Price divergence: |price - rollingAvg| / rollingAvg > priceDivergencePct over
// a short rolling window of prior snapshots (warning).
export function rulePriceDivergence(current, previous, config, ctx) {
  if (!current) return [];
  const history = ctx.history || [];
  if (history.length === 0) return []; // first cycle: no baseline
  const symbols = ["SOL", "ETH", "BTC"];
  const out = [];
  for (const sym of symbols) {
    const cur = current[sym] && Number.isFinite(current[sym].usd) ? current[sym].usd : null;
    if (cur == null) continue;
    const past = history
      .map((h) => (h && h[sym] && Number.isFinite(h[sym].usd) ? h[sym].usd : null))
      .filter((x) => x != null);
    if (past.length === 0) continue;
    const rollingAvg = past.reduce((a, b) => a + b, 0) / past.length;
    if (rollingAvg === 0) continue;
    const divergencePct = (Math.abs(cur - rollingAvg) / rollingAvg) * 100;
    if (divergencePct > config.rules.priceDivergencePct) {
      out.push(
        anomaly(
          {
            type: "priceDivergence",
            severity: "warning",
            source: "coingecko",
            subject: sym,
            details: {
              symbol: sym,
              current: cur,
              rollingAvg,
              divergencePct,
              windowSize: past.length,
            },
          },
          ctx.now
        )
      );
    }
  }
  return out;
}

const RULE_DEFS = [
  { type: "validatorDelinquent", source: "solana", kind: "comparison", fn: ruleValidatorDelinquent },
  { type: "commissionChange", source: "solana", kind: "comparison", fn: ruleCommissionChange },
  { type: "stakeDrop", source: "solana", kind: "comparison", fn: ruleStakeDrop },
  { type: "missedVotes", source: "solana", kind: "comparison", fn: ruleMissedVotes },
  { type: "ethereumFeeSpike", source: "ethereum", kind: "snapshot", fn: ruleEthereumFeeSpike },
  { type: "mempoolCongestion", source: "bitcoin", kind: "snapshot", fn: ruleMempoolCongestion },
  { type: "priceDivergence", source: "coingecko", kind: "comparison", fn: rulePriceDivergence },
];

// Run all rules over the per-source snapshots and return a deterministic,
// enriched, ordered anomaly array. `snapshots` maps source -> { current,
// previous, history }. `now` is injected for deterministic timestamps.
export function runAll(snapshots, config, now = NOW_DEFAULT()) {
  const out = [];
  for (const def of RULE_DEFS) {
    const snap = snapshots[def.source];
    if (!snap) continue;
    const current = snap.current;
    const previous = snap.previous;
    const history = snap.history || [];
    if (current == null) continue; // source down: skip its rules
    if (def.kind === "comparison" && previous == null) continue; // first cycle
    let results;
    try {
      results = def.fn(current, previous, config, { now, history });
    } catch {
      results = []; // a throwing rule never breaks the composite response
    }
    for (const r of results || []) out.push(enrichAnomaly(r, now));
  }
  out.sort(
    (a, b) =>
      (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0) ||
      b.timestamp - a.timestamp ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  return out;
}

export default runAll;
