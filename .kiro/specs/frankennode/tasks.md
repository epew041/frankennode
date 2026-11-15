# Tasks

## 1. Project Scaffolding

- [x] 1.1 Initialize `package.json` with `type: module`, `start` (`node server/index.js`) and `test` (`node --test`) scripts, and Node 20 engine field.
  - Expected outcome: `npm start` runs without error and `npm test` discovers zero tests without error.

- [x] 1.2 Create the directory layout (`server/`, `server/sources/`, `public/`, `test/`) with placeholder files.
  - Expected outcome: the tree matches `structure.md` and `npm start` still exits cleanly (server not yet listening is fine).

- [x] 1.3 Add `server/config.js` with endpoint URLs, cache TTLs, stale-while-degraded windows, and rule thresholds as named constants.
  - Expected outcome: importing `config.js` returns an object with all configured values and no magic numbers appear in other modules.

## 2. Backend HTTP Server

- [x] 2.1 Implement `server/index.js` using `node:http` to serve static files from `public/` (mapping `/` to `index.html`, correct content types for `.html/.css/.js`, 404 for missing files).
  - Expected outcome: `curl localhost:PORT/` returns `index.html` and `curl localhost:PORT/app.js` returns the JS with the right content type.

- [x] 2.2 Add JSON API routing: a `/api/state` route returning `{}` (stub) with `Content-Type: application/json`, and a catch-all 404 for unknown `/api/*` routes.
  - Depends on: 2.1
  - Expected outcome: `curl localhost:PORT/api/state` returns `{}` as JSON; unknown `/api/foo` returns 404.

## 3. Cache Helper

- [x] 3.1 Implement `server/cache.js` with `get(key)`, `set(key, value)`, `isFresh(key, ttl)`, `isWithinStaleWindow(key, staleWindow)`, and a `status(key)` helper. Use injected `now()` so tests can control time.
  - Expected outcome: unit-testable without real timers; a fresh `set` then `get` returns the value; `isFresh` is true within TTL and false after.

- [x] 3.2 Verify stale-while-degraded behavior: a stale-but-within-window entry is still returned by `get`, and `isWithinStaleWindow` distinguishes it from fully expired.
  - Depends on: 3.1
  - Expected outcome: in `cache.test.js`, an entry older than TTL but within the stale window returns its value; an entry beyond the stale window reports unavailable.

## 4. Source Modules

- [x] 4.1 Implement `server/sources/solana.js` exporting `fetchSolana({ fetchImpl })` that POSTs `getVoteAccounts` to the configured RPC and normalizes `current` + `delinquent` arrays into a flat validator list tagged with `status`.
  - Expected outcome: with a fixture RPC response injected via `fetchImpl`, normalization returns the validator shape from `design.md`; malformed input is rejected.

- [x] 4.2 Implement `server/sources/ethereum.js` exporting `fetchEthereum({ fetchImpl })` that POSTs `eth_blockNumber` and `eth_feeHistory` and normalizes to `{ blockNumber, baseFeePerGas[], gasUsedRatio[], rewardPercentiles[] }`.
  - Depends on: 4.1 (pattern reuse)
  - Expected outcome: fixture inputs normalize to the Ethereum snapshot shape; hex values are parsed to numbers.

- [x] 4.3 Implement `server/sources/bitcoin.js` exporting `fetchBitcoin({ fetchImpl })` that GETs `/api/v1/fees/recommended` and `/api/mempool` and normalizes to `{ fees, mempool: { count, vsize } }`.
  - Expected outcome: the real mempool.space fixture (fees object + mempool object) normalizes to the Bitcoin snapshot shape.

- [x] 4.4 Implement `server/sources/coingecko.js` exporting `fetchCoinGecko({ fetchImpl })` that GETs the configured price endpoint and normalizes to `{ SOL, ETH, BTC }` USD prices.
  - Expected outcome: a CoinGecko fixture normalizes to the price snapshot shape; missing symbols are handled without throwing.

- [x] 4.5 Add `server/sources.test.js` covering each source's normalization with a good fixture and a malformed fixture (asserts degradation marker/throw, not a bad object).
  - Depends on: 4.1, 4.2, 4.3, 4.4
  - Expected outcome: `npm test` passes all source normalization cases including malformed-input handling.

## 5. Snapshot Store

- [x] 5.1 Implement `server/snapshotStore.js` holding current and previous normalized snapshots per source, with `push(source, value)` (previous = old current, current = new) and `get(source)` returning `{ current, previous }`.
  - Expected outcome: after two `push` calls, `get` returns the latest as `current` and the prior as `previous`; the first `push` leaves `previous` undefined.

## 6. Rule Engine

- [x] 6.1 Implement `server/rules.js` with a runner that maps each rule over the relevant snapshots and concatenates results, skipping comparison rules when no `previous` exists, then sorts by severity then timestamp descending.
  - Expected outcome: with empty/fixed fixtures, the runner returns a deterministic, ordered anomaly array; comparison rules are skipped on the first cycle.

- [x] 6.2 Implement the "validator newly delinquent" comparison rule (status current → delinquent, severity critical).
  - Depends on: 6.1
  - Expected outcome: a fixture pair with one validator flipping to delinquent produces one critical anomaly; an unchanged pair produces none.

- [x] 6.3 Implement the "commission change" comparison rule (any commission delta; warning on increase, info on decrease).
  - Depends on: 6.1
  - Expected outcome: a fixture pair with a commission increase raises a warning, a decrease raises info, and no change raises nothing.

- [x] 6.4 Implement the "large stake drop" comparison rule (activatedStake drop > `stakeDropPct`, severity warning).
  - Depends on: 6.1
  - Expected outcome: a drop just above the threshold raises a warning; a drop just below and any increase raise nothing.

- [x] 6.5 Implement the "missed votes" comparison rule (epochCredits delta below expected slots elapsed in the window, severity warning).
  - Depends on: 6.1
  - Expected outcome: a fixture pair where epochCredits barely advance raises a warning; a pair advancing by the expected amount raises nothing.

- [x] 6.6 Implement the "Ethereum fee spike" snapshot rule (latest baseFee > multiple of window mean or above absolute threshold; warning, critical above 2× absolute).
  - Depends on: 6.1
  - Expected outcome: a base-fee window with a clear spike raises a warning; a flat window raises nothing; a 2× absolute spike raises critical.

- [x] 6.7 Implement the "mempool congestion spike" snapshot rule (fastestFee > threshold or mempool.count > threshold, severity warning).
  - Depends on: 6.1
  - Expected outcome: a Bitcoin fixture with high fastestFee or high mempool count raises a warning; a calm fixture raises nothing.

- [x] 6.8 Implement the "price divergence" comparison rule (|price − rollingAvg| / rollingAvg > `priceDivergencePct` over a short rolling window of snapshots, severity warning).
  - Depends on: 6.1
  - Expected outcome: a price jumping well beyond the rolling average raises a warning; a stable price series raises nothing; first cycle (no baseline) raises nothing.

- [x] 6.9 Implement `server/explainers.js` mapping each anomaly type to an English explanation and a `suggestedChecks` list, and wire it into the runner so every anomaly is enriched before output.
  - Depends on: 6.2–6.8
  - Expected outcome: every anomaly returned by the runner has a non-empty `explanation` and at least one `suggestedChecks` entry, all in English.

- [x] 6.10 Add `server/rules.test.js` covering each rule's fire/no-fire, the first-cycle skip, threshold boundaries, severity, and determinism (same inputs twice → identical ordered output).
  - Depends on: 6.2–6.9
  - Expected outcome: `npm test` passes all rule-engine cases including the determinism assertion.

## 7. Composite API

- [x] 7.1 Wire `/api/state` in `server/index.js` to build the composite response: per-source status (ok/degraded/down), validators, enriched anomalies, and the network-pressure summary, using the cache, snapshot store, and rule engine.
  - Depends on: 2.2, 3.2, 4.5, 5.1, 6.10
  - Expected outcome: with stubbed sources, `GET /api/state` returns the full composite shape from `design.md` with correct statuses.

- [x] 7.2 Implement per-source refresh with try/catch and timeout so one source failing marks it degraded/down without failing the whole request.
  - Depends on: 7.1
  - Expected outcome: with one source stubbed to throw, `/api/state` still returns the other three sources and marks the failed one `down`/`degraded`.

- [x] 7.3 (optional) Add `/api/health` returning just the source statuses.
  - Depends on: 7.1
  - Expected outcome: `curl /api/health` returns the four source statuses quickly.

## 8. Frontend Dashboard

- [x] 8.1 Build `public/index.html` + `public/styles.css` as the dashboard shell with header, status badges, and the four panel containers (feed, detail, validator table, network pressure).
  - Expected outcome: loading `/` shows the four labeled panels and four source-status badges.

- [x] 8.2 Implement `public/app.js` to fetch `/api/state` on a fixed interval and update source-status badges from the `sources` object.
  - Depends on: 8.1, 7.1
  - Expected outcome: badges reflect ok/degraded/down colors matching the current backend response; polling runs without a page reload.

- [x] 8.3 Implement the live anomaly feed: reverse-chronological list of anomalies with severity color, type, subject, source, and time; selecting a row selects it for the detail view.
  - Depends on: 8.2
  - Expected outcome: anomalies render in order; an empty list shows "No anomalies detected."; clicking a row updates the detail view.

- [x] 8.4 Implement the anomaly detail view showing the selected anomaly's explanation and suggested checks plus `details`.
  - Depends on: 8.3
  - Expected outcome: selecting an anomaly shows its English explanation and suggested checks.

- [x] 8.5 Implement the validator table: rows with vote pubkey (truncated), status, activated stake (formatted as SOL), commission, epoch credits, last vote, root slot; delinquent validators visually flagged.
  - Depends on: 8.2
  - Expected outcome: the Solana validators render as a table; delinquent rows are visually distinct.

- [x] 8.6 Implement the network pressure panel with the three sub-panels (Ethereum block/base-fee, Bitcoin fees/mempool, prices) each showing its source status.
  - Depends on: 8.2
  - Expected outcome: all three sub-panels render their latest values and per-source status.

## 9. Failure Handling and Degradation

- [x] 9.1 Implement the stale-while-degraded serving path in `/api/state`: serve cached data while within the stale window, mark `degraded`; serve nothing and mark `down` beyond it.
  - Depends on: 7.1, 3.2
  - Expected outcome: with a source's upstream unreachable but cache present, the response still includes that source's last value with status `degraded`.

- [x] 9.2 Implement the all-down banner: when every source is `down`, the dashboard shows an explicit stale/unavailable banner and stops presenting cached data as live.
  - Depends on: 8.2
  - Expected outcome: when all sources are `down`, a visible banner appears and the live indicator is off.

- [x] 9.3 Add an integration test that stands up the server with stubbed sources, one of which fails, and asserts `/api/state` returns the other three sources with the failed one marked `down`.
  - Depends on: 7.2
  - Expected outcome: `npm test` passes the partial-failure integration case.

## 10. Polish and Documentation

- [x] 10.1 Review every user-facing string for English-only phrasing and clarity (header, subtitles, panel titles, empty states, anomaly explanations, suggested checks, status badges, banner).
  - Expected outcome: a manual pass finds no non-English or placeholder text in the rendered dashboard.

- [x] 10.2 Confirm all thresholds and TTLs are sourced from `config.js` with sensible defaults for a live demo.
  - Expected outcome: changing a value in `config.js` changes behavior with no code edits elsewhere.

- [x] 10.3 Add a `README.md` with run steps (`npm install` if needed, `npm start`, open the URL), a note that no keys/wallet are required, and a short description of the four sources and seven anomaly types.
  - Expected outcome: a new user can run the app and understand what they are looking at from the README alone.

- [x] 10.4 (optional) Add a small "Frankenstein" visual theme (color accents, subtitle) to reinforce the hackathon category without obscuring data.
  - Expected outcome: the dashboard reads as the Frankenstein-category entry while keeping all panels legible.
