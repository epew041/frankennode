---
inclusion: always
---

# Product Overview

## Purpose
Frankennode is the Kiroween 2026 "Frankenstein" hackathon entry: a read-only validator anomaly agent that stitches together four incompatible public blockchain data sources into one live dashboard. It monitors Solana validator health alongside Ethereum and Bitcoin network pressure, and uses a deterministic rule engine to surface anomalies with plain-language explanations and suggested checks.

The Frankenstein angle is deliberate: the four sources were never designed to be combined, share schemas, or even run on the same chain. Frankennode bolts them together and keeps the composite alive even when individual limbs fail.

## Target Users
- **Hackathon judges and attendees** viewing a live demo of the Frankenstein-category entry.
- **Solo validators and staking hobbyists** who want a no-setup, no-wallet, no-API-key overview of validator health and cross-chain conditions.
- **Curious observers** who want a single glanceable view of Solana validator anomalies next to Ethereum fee pressure and Bitcoin mempool congestion.

## Key Features
- Server-side proxy and cache for four public sources: Solana `getVoteAccounts`, Ethereum `eth_blockNumber` + `eth_feeHistory`, Bitcoin mempool.space, and CoinGecko prices.
- Deterministic rule engine flagging seven anomaly types (validator newly delinquent, commission change, large stake drop, missed votes, Ethereum fee spike, mempool congestion spike, price divergence), each with a severity level.
- Plain-language explanation and suggested follow-up checks for every anomaly.
- Dashboard with a live anomaly feed, a validator table, an anomaly detail view, and a network pressure panel.
- Graceful degradation: the dashboard keeps working when any one source is down.

## Business Objectives
- Showcase well in the Kiroween 2026 Frankenstein category with a tool that stays reliably live for the duration of judging and demo.
- Demonstrate that a coherent monitoring tool can be assembled from unrelated public APIs with no keys, no wallet, and no write operations.
- Make anomaly detection deterministic and explainable, so the same inputs always produce the same findings.
