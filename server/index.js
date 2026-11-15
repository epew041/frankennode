// server/index.js — HTTP server: serves public/ static files and the JSON API.
// The API composes four upstream sources through a per-source cache and
// snapshot store, runs the deterministic rule engine, and returns one
// composite /api/state response. Any single source failing degrades
// independently without failing the whole response.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { Cache } from "./cache.js";
import { SnapshotStore } from "./snapshotStore.js";
import { runAll } from "./rules.js";
import { fetchSolana } from "./sources/solana.js";
import { fetchEthereum } from "./sources/ethereum.js";
import { fetchBitcoin } from "./sources/bitcoin.js";
import { fetchCoinGecko } from "./sources/coingecko.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const SOURCE_FETCHERS = {
  solana: fetchSolana,
  ethereum: fetchEthereum,
  bitcoin: fetchBitcoin,
  coingecko: fetchCoinGecko,
};

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function contentTypeFor(filePath) {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

export function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(json);
}

function serveStatic(res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === "/") rel = "/index.html";
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    res.writeHead(200, { "Content-Type": contentTypeFor(filePath) });
    res.end(data);
  });
}

// Race a promise against a timeout; aborts the underlying request on timeout.
function withTimeout(promise, ms, ctrl) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ctrl?.abort();
      reject(new Error(`Request timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

// Per-process services. Tests inject a stub fetchImpl and/or a controllable
// now(); the default uses the global fetch and real time.
export function createServices({ fetchImpl = fetch, now = Date.now } = {}) {
  return {
    cache: new Cache(now),
    snapshotStore: new SnapshotStore(),
    fetchImpl,
    now,
  };
}

// Refresh one source: serve fresh cache, else refetch with timeout; on failure
// serve cached data while within the stale window (degraded), else mark down.
export async function refreshSource(name, services) {
  const { cache, snapshotStore, fetchImpl } = services;
  const ttl = config.ttlMs[name];
  const staleWindow = ttl * config.staleMultiplier;

  if (cache.isFresh(name, ttl)) {
    return { status: "ok", lastUpdated: cache.timestamp(name), value: cache.get(name) };
  }

  try {
    const ctrl = new AbortController();
    const value = await withTimeout(
      SOURCE_FETCHERS[name]({ fetchImpl, signal: ctrl.signal }),
      config.timeoutMs[name],
      ctrl
    );
    cache.set(name, value);
    snapshotStore.push(
      name,
      value,
      name === "coingecko" ? config.rules.priceRollingWindow : 0
    );
    return { status: "ok", lastUpdated: cache.timestamp(name), value };
  } catch (err) {
    if (cache.isWithinStaleWindow(name, staleWindow)) {
      return {
        status: "degraded",
        lastUpdated: cache.timestamp(name),
        value: cache.get(name),
        error: message(err),
      };
    }
    return {
      status: "down",
      lastUpdated: cache.timestamp(name),
      value: undefined,
      error: message(err),
    };
  }
}

function message(err) {
  return err && err.message ? err.message : String(err);
}

// Cheap, network-free status read from the cache (used by /api/health).
function statusFromCache(name, services) {
  const { cache } = services;
  const ttl = config.ttlMs[name];
  const staleWindow = ttl * config.staleMultiplier;
  if (!cache.has(name)) return { status: "down", lastUpdated: null };
  const st = cache.status(name, ttl, staleWindow);
  const mapped = st === "fresh" ? "ok" : st === "stale" ? "degraded" : "down";
  return { status: mapped, lastUpdated: cache.timestamp(name) };
}

function buildEthPressure(current, status) {
  if (!current) {
    return {
      blockNumber: null,
      baseFeePerGas: [],
      gasUsedRatio: [],
      rewardPercentiles: [],
      status,
    };
  }
  return {
    blockNumber: current.blockNumber,
    baseFeePerGas: current.baseFeePerGas,
    gasUsedRatio: current.gasUsedRatio,
    rewardPercentiles: current.rewardPercentiles,
    status,
  };
}

function buildBtcPressure(current, status) {
  if (!current) {
    return { fees: {}, mempool: { count: null, vsize: null }, status };
  }
  return { fees: current.fees, mempool: current.mempool, status };
}

function buildPricePressure(current, status) {
  if (!current) {
    return { SOL: { usd: null }, ETH: { usd: null }, BTC: { usd: null }, status };
  }
  return { ...current, status };
}

// Build the full composite /api/state response. Sources refresh in parallel
// so a slow/dead source cannot block the others.
export async function buildState(services) {
  const { snapshotStore, now } = services;
  const ts = now();

  const refreshEntries = await Promise.all(
    config.sources.map(async (name) => [name, await refreshSource(name, services)])
  );
  const refresh = Object.fromEntries(refreshEntries);

  // Per-source snapshots for the rules: `current` is the usable value returned
  // by refreshSource (undefined when the source is down, so its rules skip);
  // `previous` and `history` come from the snapshot store so comparison rules
  // compare the last two successful fetches.
  const snapshots = {};
  for (const name of config.sources) {
    const stored = snapshotStore.get(name);
    snapshots[name] = {
      current: refresh[name].value,
      previous: stored.previous,
      history: stored.history,
    };
  }

  const anomalies = runAll(snapshots, config, ts);

  const sources = {};
  for (const name of config.sources) {
    sources[name] = { status: refresh[name].status, lastUpdated: refresh[name].lastUpdated };
  }

  // Validators: capped display list — top-N current validators by stake plus
  // all delinquent. Uses the usable Solana value (empty when down).
  let validators = [];
  const solanaCurrent = refresh.solana.value;
  if (Array.isArray(solanaCurrent)) {
    const current = solanaCurrent.filter((v) => v.status === "current");
    const delinquent = solanaCurrent.filter((v) => v.status === "delinquent");
    current.sort((a, b) => b.activatedStake - a.activatedStake);
    validators = [...current.slice(0, config.validatorDisplayCap), ...delinquent];
  }

  const networkPressure = {
    ethereum: buildEthPressure(refresh.ethereum.value, refresh.ethereum.status),
    bitcoin: buildBtcPressure(refresh.bitcoin.value, refresh.bitcoin.status),
    prices: buildPricePressure(refresh.coingecko.value, refresh.coingecko.status),
  };

  return {
    generatedAt: ts,
    pollIntervalMs: config.pollIntervalMs,
    sources,
    validators,
    anomalies,
    networkPressure,
  };
}

export async function buildHealth(services) {
  const sources = {};
  for (const name of config.sources) sources[name] = statusFromCache(name, services);
  return { generatedAt: services.now(), sources };
}

function buildRouter(services) {
  return async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;
    if (pathname.startsWith("/api/")) {
      try {
        if (pathname === "/api/state") {
          return sendJson(res, 200, await buildState(services));
        }
        if (pathname === "/api/health") {
          return sendJson(res, 200, await buildHealth(services));
        }
      } catch (err) {
        return sendJson(res, 500, { error: "Internal error" });
      }
      return sendJson(res, 404, { error: "Not found" });
    }
    serveStatic(res, pathname);
  };
}

export function createServer(options = {}) {
  const services = createServices(options);
  return http.createServer(buildRouter(services));
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const server = createServer();
  server.listen(config.port, () => {
    console.log(`Frankennode listening on http://localhost:${config.port}`);
  });
}
