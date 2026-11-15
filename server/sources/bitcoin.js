// server/sources/bitcoin.js — mempool.space proxy + normalization.
import { config } from "../config.js";

function toNum(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return NaN;
}

export function normalizeBitcoin(feesJson, mempoolJson) {
  if (!feesJson || typeof feesJson !== "object") {
    throw new Error("Bitcoin: malformed fees response");
  }
  const fastestFee = toNum(feesJson.fastestFee);
  if (!Number.isFinite(fastestFee)) {
    throw new Error("Bitcoin: missing fastestFee");
  }
  const fees = {
    fastestFee,
    halfHourFee: toNum(feesJson.halfHourFee) || 0,
    hourFee: toNum(feesJson.hourFee) || 0,
    economyFee: toNum(feesJson.economyFee) || 0,
    minimumFee: toNum(feesJson.minimumFee) || 0,
  };

  if (!mempoolJson || typeof mempoolJson !== "object") {
    throw new Error("Bitcoin: malformed mempool response");
  }
  const count = toNum(mempoolJson.count);
  const vsize = toNum(mempoolJson.vsize);
  if (!Number.isFinite(count) || !Number.isFinite(vsize)) {
    throw new Error("Bitcoin: missing mempool count/vsize");
  }
  return { fees, mempool: { count, vsize } };
}

export async function fetchBitcoin({ fetchImpl = fetch, signal } = {}) {
  const feesRes = await fetchImpl(config.endpoints.bitcoinFees, { signal });
  if (!feesRes.ok) throw new Error(`Bitcoin fees HTTP ${feesRes.status}`);
  const feesJson = await feesRes.json();

  const memRes = await fetchImpl(config.endpoints.bitcoinMempool, { signal });
  if (!memRes.ok) throw new Error(`Bitcoin mempool HTTP ${memRes.status}`);
  const mempoolJson = await memRes.json();

  return normalizeBitcoin(feesJson, mempoolJson);
}

export default fetchBitcoin;
