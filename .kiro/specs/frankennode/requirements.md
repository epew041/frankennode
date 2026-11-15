# Requirements

## User Stories

### User Story: As a hackathon judge, I want a single live dashboard showing validator anomalies and cross-chain network pressure, so that I can evaluate the Frankenstein-category entry at a glance.

**Acceptance Criteria:**
- The dashboard loads in a browser with no setup, no API keys, and no wallet connection.
- The live anomaly feed, validator table, network pressure panel, and anomaly detail view are all visible on load.
- The dashboard refreshes its data periodically without a full page reload.

### User Story: As a solo validator, I want to be alerted when my validator becomes delinquent or changes commission, so that I can investigate before it affects rewards.

**Acceptance Criteria:**
- An anomaly is raised when a validator transitions from current to delinquent between snapshots.
- An anomaly is raised when a validator's commission changes between snapshots.
- Each anomaly includes a plain-language explanation and a list of suggested checks.

### User Story: As a curious observer, I want to see Ethereum fee spikes and Bitcoin mempool congestion next to Solana validator health, so that I understand cross-chain network pressure in one view.

**Acceptance Criteria:**
- The network pressure panel shows Ethereum fee/block data and Bitcoin fee/mempool data.
- Anomalies are raised for Ethereum fee spikes and Bitcoin mempool congestion spikes.
- Tracked token prices are shown, with a price-divergence anomaly when a token moves outside its expected range.

### User Story: As a user, I want the dashboard to keep working when one data source is down, so that a partial outage does not take the whole tool offline.

**Acceptance Criteria:**
- A failing source is shown as degraded or unavailable without breaking the rest of the dashboard.
- Cached data continues to be served for a degraded source until the cache expires.
- The remaining three sources and their anomalies continue to update normally.

## Functional Requirements

### Data Acquisition and Caching

WHEN the backend receives a request for source data and the cached entry is fresh
THE SYSTEM SHALL serve the cached data without contacting the upstream source

WHEN the backend receives a request for source data and the cached entry is stale
THE SYSTEM SHALL fetch the data server-side from the public source, normalize it, and update the cache

WHEN the application runs
THE SYSTEM SHALL require no API keys and no wallet connection

### Solana Validator Source

WHEN the Solana source is polled
THE SYSTEM SHALL call the public JSON-RPC method getVoteAccounts and return current and delinquent vote accounts with activated stake, commission, epoch credits, last vote, and root slot for each account

### Ethereum Source

WHEN the Ethereum source is polled
THE SYSTEM SHALL call a public JSON-RPC endpoint for eth_blockNumber and eth_feeHistory and return the current block number and the recent fee history

### Bitcoin Source

WHEN the Bitcoin source is polled
THE SYSTEM SHALL call the public mempool.space API and return fee recommendations and mempool size

### Price Source

WHEN the price source is polled
THE SYSTEM SHALL call the public CoinGecko API and return tracked token prices in USD

### Anomaly Detection

WHEN a validator transitions from current to delinquent between snapshots
THE SYSTEM SHALL raise a "validator newly delinquent" anomaly with a severity level

WHEN a validator's commission value changes between snapshots
THE SYSTEM SHALL raise a "commission change" anomaly with a severity level

WHEN a validator's activated stake drops by more than the configured threshold between snapshots
THE SYSTEM SHALL raise a "large stake drop" anomaly with a severity level

WHEN a validator's epoch credits do not advance by the expected amount between snapshots
THE SYSTEM SHALL raise a "missed votes" anomaly with a severity level

WHEN the Ethereum fee history shows a base fee spike above the configured threshold
THE SYSTEM SHALL raise an "Ethereum fee spike" anomaly with a severity level

WHEN the Bitcoin mempool congestion exceeds the configured threshold
THE SYSTEM SHALL raise a "mempool congestion spike" anomaly with a severity level

WHEN a tracked token's price diverges from its expected range by more than the configured threshold
THE SYSTEM SHALL raise a "price divergence" anomaly with a severity level

### Anomaly Explanation

WHEN any anomaly is raised
THE SYSTEM SHALL attach a plain-language English explanation and a list of suggested checks

### Dashboard

WHEN a user opens the dashboard
THE SYSTEM SHALL display a live anomaly feed, a validator table, an anomaly detail view, and a network pressure panel

WHEN a user selects an anomaly in the feed
THE SYSTEM SHALL show the anomaly detail view with its explanation and suggested checks

WHEN the dashboard polls for updates
THE SYSTEM SHALL refresh the displayed data without requiring a full page reload

WHEN any text is rendered to the user
THE SYSTEM SHALL render it in English

### Failure Handling

WHEN a single source fails or times out
THE SYSTEM SHALL mark that source as degraded and continue serving the other sources

WHEN a degraded source has fresh-enough cached data within the stale-while-degraded window
THE SYSTEM SHALL serve that cached data until the window expires

WHEN a source is unavailable and no usable cache remains
THE SYSTEM SHALL mark the source as down and skip the rules that depend on it

WHEN all sources are unavailable
THE SYSTEM SHALL display an explicit degraded state and shall not present stale data as live

## Edge Cases and Error Handling

WHEN an upstream source returns malformed data
THE SYSTEM SHALL discard that response, treat the source as degraded for the current cycle, and use cache if available

WHEN an upstream source rate-limits the backend
THE SYSTEM SHALL back off, serve cached data for that source, and keep the source marked degraded until it recovers

WHEN no previous snapshot exists for a source
THE SYSTEM SHALL establish the baseline snapshot without raising comparison-based anomalies (delinquency, commission change, stake drop, missed votes, price divergence)

WHEN two consecutive snapshots are identical for a given metric
THE SYSTEM SHALL not raise a duplicate anomaly for that unchanged metric

WHEN the rule engine receives identical snapshots more than once
THE SYSTEM SHALL produce the same set of anomalies each time
