// server/sources/solana.js — getVoteAccounts proxy + normalization.
import { config } from "../config.js";

function toNum(v, fallback = 0) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return fallback;
}

// epochCredits is an array of [epoch, credits, prevCredits] tuples. The
// validator's current-epoch credits is the credits field of the last tuple.
function latestEpochCredits(epochCredits) {
  if (!Array.isArray(epochCredits) || epochCredits.length === 0) return 0;
  const last = epochCredits[epochCredits.length - 1];
  if (Array.isArray(last) && last.length >= 2) return toNum(last[1]);
  return toNum(last);
}

function normalizeValidator(v, status) {
  if (!v || typeof v !== "object") {
    throw new Error("Solana: malformed vote account");
  }
  if (typeof v.votePubkey !== "string" || v.votePubkey === "") {
    throw new Error("Solana: missing votePubkey");
  }
  return {
    votePubkey: v.votePubkey,
    nodePubkey: typeof v.nodePubkey === "string" ? v.nodePubkey : null,
    status,
    activatedStake: toNum(v.activatedStake),
    commission: toNum(v.commission),
    epochCredits: latestEpochCredits(v.epochCredits),
    lastVote: toNum(v.lastVote),
    rootSlot: v.rootSlot == null ? null : toNum(v.rootSlot),
  };
}

export function normalizeSolana(json) {
  if (!json || typeof json !== "object") {
    throw new Error("Solana: malformed response");
  }
  if (json.error) {
    throw new Error("Solana RPC error: " + (json.error.message || "unknown"));
  }
  const result = json.result;
  if (!result || typeof result !== "object") {
    throw new Error("Solana: missing result object");
  }
  if (!Array.isArray(result.current) || !Array.isArray(result.delinquent)) {
    throw new Error("Solana: missing current/delinquent arrays");
  }
  const validators = [];
  for (const v of result.current) validators.push(normalizeValidator(v, "current"));
  for (const v of result.delinquent) validators.push(normalizeValidator(v, "delinquent"));
  return validators;
}

export async function fetchSolana({ fetchImpl = fetch, signal } = {}) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "getVoteAccounts",
    params: [],
  });
  const res = await fetchImpl(config.endpoints.solana, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal,
  });
  if (!res.ok) throw new Error(`Solana RPC returned HTTP ${res.status}`);
  const json = await res.json();
  return normalizeSolana(json);
}

export default fetchSolana;
