// server/sources/ethereum.js — eth_blockNumber + eth_feeHistory proxy + normalization.
import { config } from "../config.js";

// The reward percentiles we request for eth_feeHistory; echoed back so the UI
// knows what the priority-fee samples correspond to.
const REWARD_PERCENTILES = [0, 50, 100];

function hexToBigInt(hex) {
  if (typeof hex !== "string") {
    throw new Error("Ethereum: expected hex string");
  }
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h === "" || !/^[0-9a-fA-F]*$/.test(h)) {
    throw new Error("Ethereum: invalid hex " + JSON.stringify(hex));
  }
  return BigInt("0x" + (h || "0"));
}

function hexToInt(hex) {
  return Number(hexToBigInt(hex));
}

// Convert a hex-wei string to a number in gwei.
function hexWeiToGwei(hex) {
  try {
    return Number(hexToBigInt(hex)) / 1e9;
  } catch {
    return 0;
  }
}

export function normalizeEthereum(blockNumberJson, feeHistoryJson) {
  if (!blockNumberJson || typeof blockNumberJson !== "object") {
    throw new Error("Ethereum: malformed blockNumber response");
  }
  if (blockNumberJson.error) {
    throw new Error("Ethereum RPC error: " + (blockNumberJson.error.message || "unknown"));
  }
  if (typeof blockNumberJson.result !== "string") {
    throw new Error("Ethereum: missing blockNumber result");
  }
  const blockNumber = hexToInt(blockNumberJson.result);

  if (!feeHistoryJson || typeof feeHistoryJson !== "object") {
    throw new Error("Ethereum: malformed feeHistory response");
  }
  if (feeHistoryJson.error) {
    throw new Error("Ethereum RPC error: " + (feeHistoryJson.error.message || "unknown"));
  }
  const r = feeHistoryJson.result;
  if (!r || !Array.isArray(r.baseFeePerGas) || !Array.isArray(r.gasUsedRatio)) {
    throw new Error("Ethereum: missing feeHistory arrays");
  }
  const baseFeePerGas = r.baseFeePerGas.map((h) => hexWeiToGwei(h));
  const gasUsedRatio = r.gasUsedRatio.map((x) => Number(x));
  return { blockNumber, baseFeePerGas, gasUsedRatio, rewardPercentiles: REWARD_PERCENTILES };
}

export async function fetchEthereum({ fetchImpl = fetch, signal } = {}) {
  const headers = { "Content-Type": "application/json" };
  const bnRes = await fetchImpl(config.endpoints.ethereum, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    signal,
  });
  if (!bnRes.ok) throw new Error(`Ethereum RPC returned HTTP ${bnRes.status}`);
  const blockNumberJson = await bnRes.json();

  const fhRes = await fetchImpl(config.endpoints.ethereum, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "eth_feeHistory",
      params: ["0x5", "latest", REWARD_PERCENTILES],
    }),
    signal,
  });
  if (!fhRes.ok) throw new Error(`Ethereum RPC returned HTTP ${fhRes.status}`);
  const feeHistoryJson = await fhRes.json();

  return normalizeEthereum(blockNumberJson, feeHistoryJson);
}

export default fetchEthereum;
