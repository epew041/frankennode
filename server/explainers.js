// server/explainers.js — turns a normalized anomaly into a plain-language
// English explanation plus a list of suggested checks. Kept separate from the
// rules so wording can change without touching detection logic. Also assigns
// the deterministic anomaly id (hash of type + source + subject) so the same
// condition is never listed twice for unchanged values.
import { createHash } from "node:crypto";

export function makeId(type, source, subject) {
  return createHash("sha256")
    .update(`${type}:${source}:${subject}`)
    .digest("hex")
    .slice(0, 16);
}

export function shortKey(key) {
  if (typeof key !== "string") return String(key);
  if (key.length <= 12) return key;
  return `${key.slice(0, 6)}\u2026${key.slice(-4)}`;
}

export function lamportsToSol(lamports) {
  return (Number(lamports) / 1e9).toFixed(2);
}

export function fmtNum(n) {
  if (n == null || !Number.isFinite(n)) return "n/a";
  if (Math.abs(n) >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

const EXPLAINERS = {
  validatorDelinquent: (a) => ({
    explanation: `Validator ${shortKey(a.subject)} became delinquent — it was current at the last check and is no longer voting reliably.`,
    suggestedChecks: [
      "Confirm the validator node is online and synced to the network.",
      "Check RPC connectivity and the validator software logs.",
      "Look for a matching commission-change or stake-drop anomaly.",
    ],
  }),
  commissionChange: (a) => {
    const up = a.details.to > a.details.from;
    return {
      explanation: `Validator ${shortKey(a.subject)} ${up ? "raised" : "lowered"} its commission from ${a.details.from}% to ${a.details.to}%.`,
      suggestedChecks: [
        "Verify the change was intentional and authorized by the operator.",
        "Compare with the validator operator's public announcement.",
        "Assess the impact on staking rewards.",
      ],
    };
  },
  stakeDrop: (a) => ({
    explanation: `Validator ${shortKey(a.subject)} lost ${a.details.dropPct.toFixed(1)}% of activated stake since the last check (from ${lamportsToSol(a.details.from)} SOL to ${lamportsToSol(a.details.to)} SOL).`,
    suggestedChecks: [
      "Check whether delegators withdrew stake.",
      "Look for a matching delinquency or commission-change anomaly.",
      "Confirm an epoch boundary did not reset the stake accounting.",
    ],
  }),
  missedVotes: (a) => ({
    explanation: `Validator ${shortKey(a.subject)} advanced only ${a.details.actualDelta} epoch credits while about ${a.details.expectedDelta} slots elapsed — roughly ${a.details.missed} votes appear missed.`,
    suggestedChecks: [
      "Check validator uptime and network latency.",
      "Inspect vote-transaction failures in the validator logs.",
      "Confirm the node clock and slot tracking are correct.",
    ],
  }),
  ethereumFeeSpike: (a) => ({
    explanation: `Ethereum base fee spiked to ${a.details.latest.toFixed(1)} gwei, well above the recent window mean of ${a.details.mean.toFixed(1)} gwei.`,
    suggestedChecks: [
      "Check for a high-gas on-chain event such as an NFT mint or airdrop claim.",
      "Compare against recent block gas-used ratios.",
      "Wait for the base fee to self-correct over the next few blocks.",
    ],
  }),
  mempoolCongestion: (a) => ({
    explanation: `Bitcoin mempool is congested: fastest fee ${a.details.fastestFee} sat/vB with ${fmtNum(a.details.count)} unconfirmed transactions.`,
    suggestedChecks: [
      "Consider waiting for fees to drop before sending non-urgent transactions.",
      "Use a lower-priority fee tier if timing allows.",
      "Check mempool.space for the live congestion trend.",
    ],
  }),
  priceDivergence: (a) => ({
    explanation: `${a.details.symbol} price moved to $${fmtNum(a.details.current)}, which is ${a.details.divergencePct.toFixed(1)}% away from its recent rolling average of $${fmtNum(a.details.rollingAvg)}.`,
    suggestedChecks: [
      "Confirm the move reflects real market activity.",
      "Compare against another price source if available.",
      "Check for low liquidity or a stale upstream price reading.",
    ],
  }),
};

// Build the full anomaly object: deterministic id + English explanation and
// suggested checks attached.
export function enrichAnomaly(r, now) {
  const ex = EXPLAINERS[r.type]
    ? EXPLAINERS[r.type](r)
    : {
        explanation: `An anomaly of type ${r.type} was detected for ${r.subject}.`,
        suggestedChecks: ["Review the related source for details."],
      };
  return {
    id: makeId(r.type, r.source, String(r.subject)),
    type: r.type,
    severity: r.severity,
    source: r.source,
    subject: r.subject,
    explanation: ex.explanation,
    suggestedChecks: ex.suggestedChecks,
    timestamp: r.timestamp != null ? r.timestamp : now,
    details: r.details || {},
  };
}

export default enrichAnomaly;
