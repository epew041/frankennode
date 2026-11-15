---
inclusion: always
---

# Project Structure

## Layout
```
frankennode/
  package.json            # npm scripts (start, test) and metadata
  server/
    index.js              # HTTP server: serves public/ and JSON API routes
    cache.js              # per-source TTL cache with stale-while-degraded
    snapshotStore.js       # in-memory current + previous snapshot per source
    rules.js              # deterministic anomaly rule engine (pure functions)
    explainers.js         # plain-language explanation + suggested-checks generators
    config.js             # thresholds, TTLs, endpoint URLs (single source of truth)
    sources/
      solana.js            # getVoteAccounts proxy + normalization
      ethereum.js          # eth_blockNumber + eth_feeHistory proxy + normalization
      bitcoin.js           # mempool.space proxy + normalization
      coingecko.js         # price proxy + normalization
  public/
    index.html            # dashboard shell
    styles.css             # dashboard styling
    app.js                 # client-side fetch + render logic
  test/
    rules.test.js         # rule engine unit tests with fixture snapshots
    cache.test.js         # cache TTL + stale-while-degraded tests
    sources.test.js       # source normalization shape tests with fixtures
```

## Naming Conventions
- Lowercase, descriptive file names; one source per file under `server/sources/`.
- Each source module exports a single `fetchX()` function returning a normalized data shape.
- Rule functions are named `rule<AnomalyType>` and return a normalized anomaly object (or empty array).
- Constants and config live in `server/config.js`; no magic numbers inline.

## Import Patterns
- Backend: relative imports within `server/`. No path aliases.
- Frontend: plain `<script src="app.js">` tag in `index.html`. No module bundler, no npm packages shipped to the browser.

## Architectural Decisions
- Sources are isolated behind a common `{ fetch(): normalizedData }` interface so a failing source degrades independently of the others.
- Caching is server-side (not in the browser) so a source outage is masked by cache for as long as the TTL and stale-while-degraded window allow.
- The rule engine is pure and deterministic: given normalized snapshots it always produces the same anomalies, making it unit-testable with fixtures and no network.
- Snapshots are held in memory and reset on restart, which is acceptable for a demo/hackathon tool; no database.
