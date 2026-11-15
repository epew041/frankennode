# Frankennode

A read-only validator anomaly agent that stitches four unrelated public
blockchain data sources into one live dashboard. Built for the Kiroween 2026
"Frankenstein" category: the four sources were never designed to be combined,
share schemas, or even run on the same chain — Frankennode bolts them together
and keeps the composite alive even when individual limbs fail.

No API keys. No wallet. No write operations. No accounts.

## Run

```bash
npm install   # optional — there are no runtime dependencies
npm start     # starts the server on http://localhost:3000 (or $PORT)
npm test      # runs the unit + integration tests with node --test
```

Then open <http://localhost:3000> in a browser. The dashboard polls
`/api/state` on a fixed interval and re-renders without a page reload.

## What it shows

A single page with four panels:

- **Anomaly feed** — the latest anomalies, most severe first, each with a
  severity color, type, subject, source, and time. Click a row for detail.
- **Anomaly detail** — the selected anomaly's plain-language explanation and a
  list of suggested follow-up checks, plus the type-specific `details`.
- **Solana validators** — a table of validators (vote pubkey, status, stake,
  commission, epoch credits, last vote, root slot). Delinquent rows are flagged.
- **Network pressure** — Ethereum block/base-fee, Bitcoin fees/mempool, and
  SOL/ETH/BTC prices, each with its source's status.

The header carries a live indicator and four source-status badges
(`ok` / `degraded` / `down`). If every source is `down`, a banner replaces the
live view instead of presenting stale data as live.

## The four sources

All public, key-less, and read-only. The backend proxies and caches each one
server-side so the browser never talks to them directly.

| Source | What it calls | Cache TTL |
| --- | --- | --- |
| Solana | `getVoteAccounts` JSON-RPC (current + delinquent vote accounts) | ~10s |
| Ethereum | `eth_blockNumber` + `eth_feeHistory` JSON-RPC | ~20s |
| Bitcoin | mempool.space fee recommendations + mempool size | ~30s |
| CoinGecko | USD prices for SOL/ETH/BTC | ~90s |

Endpoint URLs, TTLs, stale-while-degraded windows, and rule thresholds all live
in [`server/config.js`](server/config.js) — change a value there to change
behavior with no other code edits.

## The seven anomaly types

The rule engine is pure and deterministic: given the same snapshots it always
produces the same anomalies, which is what makes it unit-testable with fixtures
and no network. Each anomaly carries an English explanation and suggested checks.

1. **Validator newly delinquent** (critical) — a validator flips from current to
   delinquent between snapshots.
2. **Commission change** (warning on increase, info on decrease) — a validator's
   commission value changes between snapshots.
3. **Large stake drop** (warning) — a validator's activated stake drops by more
   than the configured threshold.
4. **Missed votes** (warning) — a validator's epoch credits advance materially
   below the slots elapsed in the window.
5. **Ethereum fee spike** (warning, critical above 2× the absolute threshold) —
   the latest base fee spikes above a multiple of the recent window mean, or
   above an absolute gwei threshold.
6. **Mempool congestion spike** (warning) — Bitcoin `fastestFee` or mempool
   count exceeds its threshold.
7. **Price divergence** (warning) — a tracked token's price moves more than the
   configured percentage away from a short rolling average of prior snapshots.

## Graceful degradation

- A failing source is marked `degraded` and its last cached value keeps being
  served for as long as it is within the stale-while-degraded window (10× the
  TTL), masking short outages.
- Beyond that window the source is marked `down`, its rules are skipped, and
  its panels show "unavailable" — the other three sources keep updating.
- The first poll never emits false comparison anomalies (delinquency,
  commission change, stake drop, missed votes, price divergence): there is no
  baseline yet.
- Malformed upstream data is discarded and the source is treated as degraded
  for that cycle.

## Layout

```
server/
  index.js        HTTP server + composite /api/state + /api/health
  cache.js        per-source TTL cache with stale-while-degraded
  snapshotStore.js current + previous snapshot per source (+ price history)
  rules.js        deterministic rule engine (pure functions)
  explainers.js   English explanations + suggested checks
  config.js       endpoints, TTLs, stale windows, thresholds (single source of truth)
  sources/        solana.js ethereum.js bitcoin.js coingecko.js
public/
  index.html styles.css app.js
test/
  rules.test.js cache.test.js sources.test.js integration.test.js
```

The backend uses only Node.js built-ins (`node:http`, global `fetch`,
`node:test`). The frontend is plain HTML/CSS/JS with no build step.
