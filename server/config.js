// server/config.js
// Single source of truth for endpoint URLs, cache TTLs, stale-while-degraded
// windows, and rule thresholds. No other module should contain magic numbers.

const envPort = process.env.PORT ? Number(process.env.PORT) : 3000;

export const config = {
  // HTTP server
  port: Number.isFinite(envPort) ? envPort : 3000,

  // Hint passed to the frontend for its poll interval (ms).
  pollIntervalMs: 15000,

  // ---- Source endpoint URLs ----
  endpoints: {
    solana: "https://api.mainnet-beta.solana.com",
    ethereum: "https://ethereum-rpc.publicnode.com",
    bitcoinFees: "https://mempool.space/api/v1/fees/recommended",
    bitcoinMempool: "https://mempool.space/api/mempool",
    coingecko:
      "https://api.coingecko.com/api/v3/simple/price?ids=solana,ethereum,bitcoin&vs_currencies=usd",
  },

  // ---- Cache TTLs (ms) per source ----
  // Chosen to stay well under each provider's free-tier limits.
  ttlMs: {
    solana: 10000,
    ethereum: 20000,
    bitcoin: 30000,
    coingecko: 90000,
  },

  // Stale-while-degraded window expressed as a multiplier on the TTL.
  // An entry older than TTL but within (TTL * staleMultiplier) is still served
  // while a refetch is attempted, masking short outages.
  staleMultiplier: 10,

  // Per-source outbound request timeout (ms).
  timeoutMs: {
    solana: 8000,
    ethereum: 8000,
    bitcoin: 8000,
    coingecko: 8000,
  },

  // Deterministic iteration order for the four sources.
  sources: ["solana", "ethereum", "bitcoin", "coingecko"],

  // ---- Rule thresholds ----
  rules: {
    // Solana comparison rules
    stakeDropPct: 5, // activatedStake drop > 5% => warning
    missedVotesRatio: 0.8, // epochCredits delta < 80% of slots elapsed => warning

    // Ethereum fee spike (snapshot rule)
    feeSpikeMultiple: 2, // latest baseFee > 2x window mean => warning
    feeSpikeGwei: 50, // absolute baseFee (gwei) threshold
    feeSpikeCriticalMultiple: 2, // critical if baseFee > 2x absolute threshold

    // Bitcoin mempool congestion (snapshot rule)
    mempoolFeeThreshold: 50, // fastestFee > 50 sat/vB => warning
    mempoolCountThreshold: 50000, // mempool.count > 50000 => warning

    // CoinGecko price divergence (comparison rule)
    priceDivergencePct: 10, // |price - rollingAvg| / rollingAvg > 10% => warning
    priceRollingWindow: 5, // number of prior snapshots for the rolling average
  },

  // Display cap for the validator table payload (top-N current validators by
  // stake, plus all delinquent). The full snapshot is still kept for the rules.
  validatorDisplayCap: 50,
};

export default config;
