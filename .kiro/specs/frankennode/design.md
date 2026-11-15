# Design

## Architecture

Frankennode is a single web application with two halves: a small Node.js backend that proxies, caches, normalizes, and reasons over four public sources, and a static vanilla frontend that renders the result. The backend is the only thing that talks to the internet; the browser only talks to the backend. This keeps upstream load low, hides outages behind cache, and avoids CORS and rate-limit problems in the browser.

The Frankenstein metaphor maps directly to the architecture: four unrelated "limbs" (sources) are each wrapped in the same `{ fetch(): normalized }` interface so they can be bolted onto a shared "body" (the snapshot store and rule engine). If one limb dies, the body keeps moving on the other three and the cached state of the dead one.

### Components

- **HTTP server (`server/index.js`)** — serves the static frontend and exposes the JSON API. Routes requests, handles 404s, sets JSON content types.
- **Source modules (`server/sources/*`)** — one per upstream. Each exports `fetchX()` that calls the upstream, parses the response, and returns a normalized shape. Each also carries its own cache instance and TTL from `config.js`.
- **Cache (`server/cache.js`)** — a per-source TTL cache with a stale-while-degraded window. Fresh entries are served immediately; stale-but-within-window entries are served while a refetch is attempted; expired-beyond-window entries are treated as unavailable.
- **Snapshot store (`server/snapshotStore.js`)** — keeps the current and previous normalized snapshot per source in memory. Comparison rules read current vs. previous here.
- **Rule engine (`server/rules.js`)** — a set of pure functions, one per anomaly type. The runner feeds each rule the relevant snapshots and config, collects anomalies, and sorts by severity then time.
- **Explainers (`server/explainers.js`)** — turns a normalized anomaly into a plain-language English sentence plus a list of suggested checks. Kept separate from rules so wording can change without touching detection logic.
- **Config (`server/config.js`)** — single source of truth for endpoint URLs, cache TTLs, stale windows, and rule thresholds.
- **Frontend (`public/*`)** — static shell plus a single `app.js` that polls the backend and renders the four panels.

### Architecture Diagram

```
                       Browser (no keys, no wallet)
                              |
                              | HTTP (static + /api/*)
                              v
                     +------------------+        +-------------------+
                     |   HTTP server    |------->|  Static frontend  |
                     |   (index.js)     |        |  public/*.html/js |
                     +--------+---------+        +-------------------+
                              |
                              | reads
                              v
                     +------------------+        +-------------------+
                     | Composite API    |------->|  Rule engine      |
                     | /api/state        |        |  (rules.js)        |
                     +--------+---------+        +-------------------+
                              |                         ^
                              | reads                    | reads
                              v                         |
            +------------------+----------------+   +-----+--------------+
            |  Snapshot store  |               |   |  Explainers        |
            | (current/prev)   |               |   |  (explainers.js)   |
            +--------+---------+               |   +--------------------+
                     |                         |
                     | fed by                  |
                     v                         |
        +------------+------------+            |
        |   Cache (per source)    |            |
        +------------+------------+            |
                     |                         |
                     v                         |
   +-----+-----+-----+-----+    +-------------+----------+
   |     |     |     |     |    |  Source modules          |
   Sol  Eth  BTC   CG   <---> (solana / ethereum / bitcoin / coingecko)
   RPC  RPC  API  API
```

## Data Flow

1. The browser loads `index.html` and `app.js`, then polls `GET /api/state` on a fixed interval (e.g., 15s).
2. For each source, the backend checks the cache. If fresh, it returns the cached normalized value. If stale, it triggers a source `fetchX()`; on success it normalizes, writes the cache, and pushes the value into the snapshot store (previous = old current, current = new).
3. The rule engine runs every state build over the current and previous snapshots for each source, producing anomalies. Comparison rules are skipped when no previous snapshot exists yet.
4. The explainers attach English explanations and suggested checks to each anomaly.
5. The backend assembles a single composite response: per-source status, validators, anomalies, and the network-pressure summary, and returns it as JSON.
6. The frontend re-renders the four panels from the composite response. Source status badges reflect ok / degraded / down.

The sequence for a single poll:

```
Browser -> GET /api/state -> Server
Server: for each source: cache.fresh? use cache : fetchX() -> normalize -> cache.set -> snapshotStore.push
Server: rules.runAll(snapshots, config) -> anomalies
Server: explainers.attach(anomalies)
Server: build { sources, validators, anomalies, networkPressure } -> 200 JSON
Browser: render feed, table, detail view, pressure panel; update status badges
```

## Data Sources

All four are public, key-less, and read-only. Endpoints and TTLs live in `config.js`.

- **Solana — `getVoteAccounts` (JSON-RPC).** POST to a public Solana RPC endpoint (e.g. `https://api.mainnet-beta.solana.com`) with method `getVoteAccounts`. Returns `current` and `delinquent` arrays; each entry has `votePubkey`, `nodePubkey`, `activatedStake` (lamports), `commission` (0–100), `epochCredits`, `lastVote`, `rootSlot`. Normalized to a flat validator list tagged with status. Default cache TTL ~10s.
- **Ethereum — `eth_blockNumber` + `eth_feeHistory` (JSON-RPC).** POST to a public Ethereum RPC endpoint (e.g. a public node) with two methods. `eth_blockNumber` gives the latest block; `eth_feeHistory(blockCount, newestBlock, rewardPercentiles)` gives `baseFeePerGas` and `gasUsedRatio` over a recent window. Normalized to `{ blockNumber, baseFeePerGas[], gasUsedRatio[], rewardPercentiles[] }`. Default cache TTL ~20s.
- **Bitcoin — mempool.space (REST).** `GET https://mempool.space/api/v1/fees/recommended` returns `{ fastestFee, halfHourFee, hourFee, economyFee, minimumFee }` (sat/vB). `GET https://mempool.space/api/mempool` returns `{ count, vsize, total_fee, fee_histogram }`; `count` and `vsize` are the mempool size. Normalized to `{ fees, mempool: { count, vsize } }`. Default cache TTL ~30s.
- **CoinGecko — prices (REST).** `GET https://api.coingecko.com/api/v3/simple/price?ids=solana,ethereum,bitcoin&vs_currencies=usd` returns USD prices for SOL, ETH, BTC. The free public endpoint is rate-limited (~10–30 calls/min), so the cache TTL defaults to ~90s. Normalized to `{ [symbol]: { usd } }`.

## Rule Engine

The engine is a collection of pure functions with the signature `(current, previous, config) => Anomaly[]`. The runner calls each rule with the snapshots it needs, concatenates the results, attaches explainers, and sorts by severity (critical > warning > info) then by timestamp descending. Determinism is required: identical snapshots in always produce identical anomalies out.

Rules are split into **comparison rules** (need a previous snapshot) and **snapshot rules** (run on the current snapshot alone). Comparison rules return no anomalies on the first cycle.

| Rule | Source | Trigger | Default severity | Type |
|-----|--------|---------|------------------|------|
| Validator newly delinquent | Solana | `status` flips current → delinquent | critical | comparison |
| Commission change | Solana | `commission` differs between snapshots | warning on increase, info on decrease | comparison |
| Large stake drop | Solana | `activatedStake` drops > `stakeDropPct` (default 5%) | warning | comparison |
| Missed votes | Solana | `epochCredits` delta < expected slots elapsed in window | warning | comparison |
| Ethereum fee spike | Ethereum | latest `baseFeePerGas` > `feeSpikeMultiple` (default 2×) of the window mean, or above absolute `feeSpikeGwei` | warning (critical above 2× absolute) | snapshot |
| Mempool congestion spike | Bitcoin | `fastestFee` > `mempoolFeeThreshold` (sat/vB) or `mempool.count` > `mempoolCountThreshold` | warning | snapshot |
| Price divergence | CoinGecko | `|price - rollingAvg| / rollingAvg` > `priceDivergencePct` (default 10%) over a short rolling window of snapshots | warning | comparison |

Expected-value notes for the comparison rules:
- **Missed votes:** epoch credits increment by one per slot voted. Over an interval of N slots, a healthy validator's `epochCredits` rises by ~N. A delta materially below the slots elapsed (threshold configurable) flags missed votes.
- **Price divergence:** with a single price source, "expected range" is a short rolling average computed from our own prior snapshots (no cross-exchange reference). This is a stated design choice, not a cross-market arb.

All thresholds are centralized in `config.js` so they can be tuned for the demo without touching logic.

## Interfaces

### API Contracts

All responses are JSON; all text is English. Errors are returned as `{ error: "..." }` with an appropriate status. The API never exposes upstream keys because there are none.

- `GET /api/state` — the primary composite endpoint.
  - 200 response:
    ```json
    {
      "generatedAt": 1700000000000,
      "sources": {
        "solana":    { "status": "ok|degraded|down", "lastUpdated": 1700000000000 },
        "ethereum":  { "status": "ok|degraded|down", "lastUpdated": 1700000000000 },
        "bitcoin":   { "status": "ok|degraded|down", "lastUpdated": 1700000000000 },
        "coingecko": { "status": "ok|degraded|down", "lastUpdated": 1700000000000 }
      },
      "validators": [ { "votePubkey": "...", "status": "current|delinquent", "activatedStake": 0, "commission": 0, "epochCredits": 0, "lastVote": 0, "rootSlot": 0 } ],
      "anomalies": [ { "id": "...", "type": "...", "severity": "info|warning|critical", "source": "...", "subject": "...", "explanation": "...", "suggestedChecks": ["..."], "timestamp": 0, "details": {} } ],
      "networkPressure": {
        "ethereum": { "blockNumber": 0, "baseFeePerGas": [], "status": "ok|degraded|down" },
        "bitcoin":  { "fees": {}, "mempool": { "count": 0, "vsize": 0 }, "status": "ok|degraded|down" },
        "prices":   { "SOL": { "usd": 0 }, "ETH": { "usd": 0 }, "BTC": { "usd": 0 }, "status": "ok|degraded|down" }
      }
    }
    ```
  - The server always returns 200 with whatever sources it has; `status` fields carry degradation rather than HTTP errors. Only a total backend failure yields a 5xx.
- `GET /api/health` (optional) — returns `{ sources: {...} }` status only, cheap to poll for a status light.

### UI Layout

A single-page dashboard, no routing. Layout (top to bottom, left to right):

- **Header bar** — title "Frankennode", a one-line subtitle, and four source-status badges (Solana / Ethereum / Bitcoin / CoinGecko) colored by ok / degraded / down.
- **Live anomaly feed** (primary panel, left/upper) — reverse-chronological list of anomalies, each row showing severity color, type, subject, source, and time. Selecting a row populates the anomaly detail view. Empty state: "No anomalies detected."
- **Anomaly detail view** (paired with the feed) — the selected anomaly's plain-language explanation and suggested checks, plus the type-specific `details`.
- **Validator table** — sortable rows of Solana validators: vote pubkey (truncated), status, activated stake (SOL), commission, epoch credits, last vote, root slot. Delinquent validators visually flagged.
- **Network pressure panel** — three sub-panels: Ethereum (block number + base-fee sparkline/last value), Bitcoin (fee recommendations + mempool count/vsize), and prices (SOL/ETH/BTC USD). Each sub-panel shows its source's status.

## Data Models

Normalized shapes (all amounts are numbers; lamports kept as-is and converted for display only):

- **Validator** — `{ votePubkey, nodePubkey, status: "current"|"delinquent", activatedStake, commission, epochCredits, lastVote, rootSlot }`.
- **Ethereum snapshot** — `{ blockNumber, baseFeePerGas: number[], gasUsedRatio: number[], rewardPercentiles: number[] }`.
- **Bitcoin snapshot** — `{ fees: { fastestFee, halfHourFee, hourFee, economyFee, minimumFee }, mempool: { count, vsize } }`.
- **Price snapshot** — `{ SOL: { usd }, ETH: { usd }, BTC: { usd } }`.
- **Anomaly** — `{ id, type, severity: "info"|"warning"|"critical", source, subject, explanation, suggestedChecks: string[], timestamp, details: {} }`. `id` is a deterministic hash of `type + source + subject + relevant values` so the same condition is not duplicated.
- **SourceStatus** — `{ name, status: "ok"|"degraded"|"down", lastUpdated, error? }`.

## Non-functional Considerations

- **Latency:** a cached `/api/state` response should return in well under 1s; a cold refresh should still return within ~2s, because sources are fetched and cached independently and a slow/dead source does not block the others.
- **Upstream load:** cache TTLs are chosen to stay well under each provider's free-tier limits (Solana ~10s, Ethereum ~20s, Bitcoin ~30s, CoinGecko ~90s).
- **Security:** read-only, no keys, no wallet, no auth. The backend proxies all upstreams, so no API key or origin is exposed to the browser. Input from upstreams is treated as untrusted and validated/normalized before use.
- **Reliability:** the system degrades gracefully per source; a single failure never blanks the dashboard.
- **Determinism:** the rule engine is pure; identical snapshots always yield identical anomalies, which is what makes it unit-testable.

## Error Handling

- **Source fetch failure / timeout:** each `fetchX()` is wrapped in a try/catch with a short timeout. On failure the source is marked `degraded`; its last good cached value is served if it is within the stale-while-degraded window. The window is longer than the normal TTL (e.g., 10×) specifically to mask outages.
- **Malformed upstream data:** normalization validates expected fields; if validation fails the response is discarded and the source is treated as degraded for that cycle.
- **Rate limiting:** on a 429, the backend backs off for that source and serves cache; status stays `degraded` until a fresh fetch succeeds.
- **Cache exhausted beyond the stale window:** the source is marked `down`; its rules are skipped; the relevant UI sub-panel shows "unavailable" with the last-known `lastUpdated` time. Other sources are unaffected.
- **All sources down:** the dashboard shows an explicit banner that data is stale/unavailable, and stops presenting cached values as if they were live (timestamps shown, "live" indicator off).
- **First cycle / no previous snapshot:** comparison rules are skipped until a baseline exists, so the first poll never emits false delinquency/stake-drop/missed-vote/price-divergence anomalies.
- **Duplicate suppression:** anomaly `id` is deterministic, so the feed does not list the same condition twice for unchanged values.

## Testing Strategy

### Unit Testing Strategy
- **Rule engine (`rules.test.js`)** — the core of correctness. Each rule gets fixture `current`/`previous` snapshot pairs covering: trigger fires, trigger does not fire, no previous snapshot (comparison rules return nothing), boundary conditions at the threshold, and severity assignment. Because rules are pure, no network or mocking of HTTP is needed — just fixture objects. Also assert determinism: same inputs twice → same anomalies, same order.
- **Cache (`cache.test.js`)** — fresh returns cached value without refetch; stale-but-within-window returns cached value and allows refetch; expired-beyond-window reports unavailable; TTL boundary behavior using fake timers or injected time.
- **Source normalization (`sources.test.js`)** — feed each source module a fixed upstream response fixture and assert the normalized shape; feed malformed/empty fixtures and assert it throws or returns a degradation marker rather than a bad object. HTTP is stubbed (inject the fetch function) so no network is required.

### Integration Testing
- A test that stands up the HTTP server against stubbed sources and asserts `GET /api/state` returns the composite shape with correct source statuses, including a scenario where one source is stubbed to fail and the response still returns the other three with the failed one marked `down`.

### End-to-End (manual, for the demo)
- Run against the real four upstreams and confirm the dashboard renders all four panels, updates on the poll interval, and that deliberately breaking one upstream (e.g., pointing its URL at an invalid host) leaves the rest live with a degraded badge.
