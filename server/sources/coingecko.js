// server/sources/coingecko.js — CoinGecko price proxy + normalization.
import { config } from "../config.js";

const ID_TO_SYMBOL = { solana: "SOL", ethereum: "ETH", bitcoin: "BTC" };

export function normalizeCoinGecko(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("CoinGecko: malformed response");
  }
  const out = {};
  for (const [id, symbol] of Object.entries(ID_TO_SYMBOL)) {
    const entry = json[id];
    if (entry && typeof entry === "object" && typeof entry.usd === "number") {
      out[symbol] = { usd: entry.usd };
    } else {
      // A missing symbol is not fatal; mark it null rather than throwing.
      out[symbol] = { usd: null };
    }
  }
  return out;
}

export async function fetchCoinGecko({ fetchImpl = fetch, signal } = {}) {
  const res = await fetchImpl(config.endpoints.coingecko, { signal });
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  const json = await res.json();
  return normalizeCoinGecko(json);
}

export default fetchCoinGecko;
