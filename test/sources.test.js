import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSolana, fetchSolana } from "../server/sources/solana.js";
import { normalizeEthereum, fetchEthereum } from "../server/sources/ethereum.js";
import { normalizeBitcoin, fetchBitcoin } from "../server/sources/bitcoin.js";
import {
  normalizeCoinGecko,
  fetchCoinGecko,
} from "../server/sources/coingecko.js";

// Build a stub fetchImpl that routes by URL/method and returns JSON bodies.
function mockFetch(routes) {
  return async (url, opts = {}) => {
    for (const route of routes) {
      if (route.match(url, opts)) {
        const body = typeof route.json === "function" ? route.json(url, opts) : route.json;
        return {
          ok: route.ok !== false,
          status: route.status || 200,
          json: async () => body,
          text: async () => JSON.stringify(body),
        };
      }
    }
    throw new Error("mock fetch: no route for " + url);
  };
}

function rpcBodyMethod(opts) {
  try {
    return JSON.parse(opts.body).method;
  } catch {
    return null;
  }
}

// ---------- Solana ----------
const solanaGood = {
  jsonrpc: "2.0",
  id: 1,
  result: {
    current: [
      {
        votePubkey: "vote1",
        nodePubkey: "node1",
        activatedStake: 1000000000,
        commission: 7,
        epochCredits: [
          [0, 100, 0],
          [1, 250, 100],
        ],
        lastVote: 1000,
        rootSlot: 999,
      },
    ],
    delinquent: [
      {
        votePubkey: "vote2",
        nodePubkey: "node2",
        activatedStake: 5000,
        commission: 10,
        epochCredits: [[0, 50, 0]],
        lastVote: 500,
        rootSlot: null,
      },
    ],
  },
};

test("Solana normalizes current + delinquent into a flat tagged list", () => {
  const out = normalizeSolana(solanaGood);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], {
    votePubkey: "vote1",
    nodePubkey: "node1",
    status: "current",
    activatedStake: 1000000000,
    commission: 7,
    epochCredits: 250,
    lastVote: 1000,
    rootSlot: 999,
  });
  assert.equal(out[1].status, "delinquent");
  assert.equal(out[1].epochCredits, 50);
  assert.equal(out[1].rootSlot, null);
});

test("Solana rejects malformed responses", () => {
  assert.throws(() => normalizeSolana(null), /malformed response/);
  assert.throws(() => normalizeSolana({ foo: 1 }), /missing result/);
  assert.throws(
    () => normalizeSolana({ result: { current: "x", delinquent: [] } }),
    /missing current\/delinquent/
  );
  assert.throws(
    () =>
      normalizeSolana({ result: { current: [{ activatedStake: 1 }], delinquent: [] } }),
    /missing votePubkey/
  );
  assert.throws(
    () => normalizeSolana({ error: { message: "boom" } }),
    /Solana RPC error/
  );
});

test("fetchSolana uses injected fetchImpl and normalizes", async () => {
  const fetchImpl = mockFetch([
    {
      match: (url) => url.includes("solana.com"),
      json: solanaGood,
    },
  ]);
  const out = await fetchSolana({ fetchImpl });
  assert.equal(out.length, 2);
  assert.equal(out[0].votePubkey, "vote1");
});

// ---------- Ethereum ----------
const ethBlockNumber = { jsonrpc: "2.0", id: 1, result: "0x12" }; // 18
const ethFeeHistory = {
  jsonrpc: "2.0",
  id: 2,
  result: {
    baseFeePerGas: ["0x4a817c800", "0x3b9aca00"], // 20 gwei, 1 gwei
    gasUsedRatio: [0.5, 0.6],
    oldestBlock: "0x10",
    reward: [["0x0", "0x1", "0x2"]],
  },
};

test("Ethereum normalizes hex blockNumber and gwei base fees", () => {
  const out = normalizeEthereum(ethBlockNumber, ethFeeHistory);
  assert.equal(out.blockNumber, 18);
  assert.deepEqual(out.baseFeePerGas, [20, 1]);
  assert.deepEqual(out.gasUsedRatio, [0.5, 0.6]);
  assert.deepEqual(out.rewardPercentiles, [0, 50, 100]);
});

test("Ethereum rejects malformed responses", () => {
  assert.throws(() => normalizeEthereum(null, ethFeeHistory), /malformed blockNumber/);
  assert.throws(
    () => normalizeEthereum({ result: 5 }, ethFeeHistory),
    /missing blockNumber result/
  );
  assert.throws(
    () => normalizeEthereum(ethBlockNumber, { result: { baseFeePerGas: [] } }),
    /missing feeHistory arrays/
  );
  assert.throws(
    () => normalizeEthereum({ error: { message: "x" } }, ethFeeHistory),
    /Ethereum RPC error/
  );
});

test("fetchEthereum POSTs both methods and normalizes", async () => {
  const fetchImpl = mockFetch([
    {
      match: (url, opts) => rpcBodyMethod(opts) === "eth_blockNumber",
      json: ethBlockNumber,
    },
    {
      match: (url, opts) => rpcBodyMethod(opts) === "eth_feeHistory",
      json: ethFeeHistory,
    },
  ]);
  const out = await fetchEthereum({ fetchImpl });
  assert.equal(out.blockNumber, 18);
  assert.equal(out.baseFeePerGas[0], 20);
});

// ---------- Bitcoin ----------
const btcFees = {
  fastestFee: 30,
  halfHourFee: 25,
  hourFee: 20,
  economyFee: 10,
  minimumFee: 5,
};
const btcMempool = { count: 1234, vsize: 5678, total_fee: 999, fee_histogram: [] };

test("Bitcoin normalizes fees and mempool", () => {
  const out = normalizeBitcoin(btcFees, btcMempool);
  assert.deepEqual(out.fees, btcFees);
  assert.deepEqual(out.mempool, { count: 1234, vsize: 5678 });
});

test("Bitcoin rejects malformed responses", () => {
  assert.throws(() => normalizeBitcoin(null, btcMempool), /malformed fees/);
  assert.throws(
    () => normalizeBitcoin({ halfHourFee: 1 }, btcMempool),
    /missing fastestFee/
  );
  assert.throws(() => normalizeBitcoin(btcFees, null), /malformed mempool/);
  assert.throws(
    () => normalizeBitcoin(btcFees, { count: "x", vsize: 1 }),
    /missing mempool count\/vsize/
  );
});

test("fetchBitcoin GETs both endpoints and normalizes", async () => {
  const fetchImpl = mockFetch([
    { match: (url) => url.includes("fees/recommended"), json: btcFees },
    { match: (url) => url.includes("/api/mempool"), json: btcMempool },
  ]);
  const out = await fetchBitcoin({ fetchImpl });
  assert.equal(out.fees.fastestFee, 30);
  assert.equal(out.mempool.count, 1234);
});

// ---------- CoinGecko ----------
const cgGood = {
  solana: { usd: 150 },
  ethereum: { usd: 3000 },
  bitcoin: { usd: 60000 },
};

test("CoinGecko normalizes ids to SOL/ETH/BTC", () => {
  const out = normalizeCoinGecko(cgGood);
  assert.deepEqual(out, {
    SOL: { usd: 150 },
    ETH: { usd: 3000 },
    BTC: { usd: 60000 },
  });
});

test("CoinGecko handles missing symbols without throwing", () => {
  const out = normalizeCoinGecko({ solana: { usd: 150 } });
  assert.deepEqual(out, {
    SOL: { usd: 150 },
    ETH: { usd: null },
    BTC: { usd: null },
  });
});

test("CoinGecko rejects malformed responses", () => {
  assert.throws(() => normalizeCoinGecko(null), /malformed response/);
  assert.throws(() => normalizeCoinGecko("x"), /malformed response/);
  assert.throws(() => normalizeCoinGecko([1, 2]), /malformed response/);
});

test("fetchCoinGecko GETs and normalizes", async () => {
  const fetchImpl = mockFetch([
    { match: (url) => url.includes("coingecko"), json: cgGood },
  ]);
  const out = await fetchCoinGecko({ fetchImpl });
  assert.equal(out.SOL.usd, 150);
});
