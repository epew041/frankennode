// public/app.js — polls /api/state and renders the four dashboard panels.
// All upstream-derived strings are inserted via textContent to avoid injection.
(function () {
  "use strict";

  const SOURCE_LABELS = {
    solana: "Solana",
    ethereum: "Ethereum",
    bitcoin: "Bitcoin",
    coingecko: "CoinGecko",
  };
  const SOURCE_ORDER = ["solana", "ethereum", "bitcoin", "coingecko"];

  let pollIntervalMs = 15000;
  let lastState = null;
  let selectedId = null;

  // ---- small DOM helpers ----
  function el(tag, props, ...kids) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (k === "class") node.className = v;
        else if (k === "text") node.textContent = v;
        else if (k.startsWith("data-")) node.setAttribute(k, v);
        else if (k === "onclick") node.addEventListener("click", v);
        else node.setAttribute(k, v);
      }
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      node.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
    }
    return node;
  }
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // ---- formatters ----
  function fmtTime(ts) {
    if (!ts) return "—";
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleTimeString("en-US", { hour12: false });
  }
  function fmtNum(n, digits = 2) {
    if (n == null || !Number.isFinite(n)) return "—";
    return n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
  }
  function fmtSol(lamports) {
    if (lamports == null || !Number.isFinite(lamports)) return "—";
    return fmtNum(lamports / 1e9);
  }
  function truncPk(pk) {
    if (typeof pk !== "string") return "—";
    if (pk.length <= 12) return pk;
    return pk.slice(0, 6) + "…" + pk.slice(-4);
  }

  // ---- badges ----
  function renderBadges(sources) {
    const host = document.getElementById("badges");
    clear(host);
    for (const name of SOURCE_ORDER) {
      const s = sources[name] || { status: "down", lastUpdated: null };
      host.appendChild(
        el("span", { class: `badge ${s.status}` },
          el("span", { class: "pip" }),
          SOURCE_LABELS[name],
          el("span", { class: "mini-status", text: s.status })
        )
      );
    }
  }

  // ---- feed + detail ----
  function renderFeed(anomalies) {
    const host = document.getElementById("feed");
    clear(host);
    if (!anomalies || anomalies.length === 0) {
      host.appendChild(el("li", { class: "empty", text: "No anomalies detected." }));
      return;
    }
    for (const a of anomalies) {
      const li = el("li", { class: a.id === selectedId ? "selected" : "", onclick: () => selectAnomaly(a.id) },
        el("span", { class: `sev ${a.severity}` }),
        el("span", { class: "ftype", text: prettyType(a.type) }),
        el("span", { class: "fmeta", text: `${a.subject} · ${SOURCE_LABELS[a.source] || a.source}` }),
        el("span", { class: "ftime", text: fmtTime(a.timestamp) })
      );
      host.appendChild(li);
    }
  }

  function prettyType(type) {
    return String(type).replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
  }

  function selectAnomaly(id) {
    selectedId = id;
    renderFeed((lastState && lastState.anomalies) || []);
    renderDetail();
  }

  function renderDetail() {
    const host = document.getElementById("detail");
    clear(host);
    const anomalies = (lastState && lastState.anomalies) || [];
    const a = anomalies.find((x) => x.id === selectedId);
    if (!a) {
      host.appendChild(el("p", { class: "empty", text: "Select an anomaly to see its explanation and suggested checks." }));
      return;
    }
    host.appendChild(el("div", { class: "d-title", text: `${prettyType(a.type)} — ${a.subject}` }));
    host.appendChild(el("div", { class: "d-sub", text: `severity: ${a.severity} · source: ${SOURCE_LABELS[a.source] || a.source} · ${fmtTime(a.timestamp)}` }));
    host.appendChild(el("p", { class: "d-expl", text: a.explanation }));
    host.appendChild(el("h3", { text: "Suggested checks" }));
    host.appendChild(el("ul", {}, a.suggestedChecks.map((c) => el("li", { text: c }))));
    const details = a.details || {};
    const keys = Object.keys(details);
    if (keys.length) {
      host.appendChild(el("h3", { text: "Details" }));
      host.appendChild(el("pre", { class: "d-details", text: JSON.stringify(details, null, 2) }));
    }
  }

  // ---- validators ----
  function renderValidators(validators) {
    const tbody = document.querySelector("#validators tbody");
    clear(tbody);
    const count = document.getElementById("validator-count");
    count.textContent = validators && validators.length ? `${validators.length} shown` : "";
    if (!validators || validators.length === 0) {
      tbody.appendChild(el("tr", {}, el("td", { colspan: "7", class: "empty", text: "No Solana validator data available." })));
      return;
    }
    for (const v of validators) {
      const row = el("tr", { class: v.status === "delinquent" ? "delinquent" : "" },
        el("td", { class: "pk", text: truncPk(v.votePubkey) }),
        el("td", { class: "status", text: v.status }),
        el("td", { class: "num", text: fmtSol(v.activatedStake) }),
        el("td", { class: "num", text: `${v.commission}%` }),
        el("td", { class: "num", text: fmtNum(v.epochCredits, 0) }),
        el("td", { class: "num", text: fmtNum(v.lastVote, 0) }),
        el("td", { class: "num", text: v.rootSlot == null ? "—" : fmtNum(v.rootSlot, 0) })
      );
      tbody.appendChild(row);
    }
  }

  // ---- network pressure ----
  function renderPressure(np) {
    const host = document.getElementById("pressure");
    clear(host);
    if (!np) return;

    // Ethereum
    const eth = np.ethereum || { status: "down" };
    const ethPanel = el("div", { class: "subpanel" },
      el("h3", {}, "Ethereum",
        el("span", { class: `mini-status ${eth.status}`, text: eth.status })),
      el("div", { class: "row" }, el("span", { class: "k", text: "Block" }), el("span", { class: "v", text: eth.blockNumber == null ? "—" : fmtNum(eth.blockNumber, 0) })),
      el("div", { class: "row" }, el("span", { class: "k", text: "Base fee" }), el("span", { class: "v", text: lastFee(eth.baseFeePerGas) }))
    );
    ethPanel.appendChild(sparkline(eth.baseFeePerGas));
    host.appendChild(ethPanel);

    // Bitcoin
    const btc = np.bitcoin || { status: "down" };
    const fees = btc.fees || {};
    host.appendChild(el("div", { class: "subpanel" },
      el("h3", {}, "Bitcoin",
        el("span", { class: `mini-status ${btc.status}`, text: btc.status })),
      el("div", { class: "row" }, el("span", { class: "k", text: "Fastest fee" }), el("span", { class: "v", text: fees.fastestFee == null ? "—" : `${fees.fastestFee} sat/vB` })),
      el("div", { class: "row" }, el("span", { class: "k", text: "Half-hour" }), el("span", { class: "v", text: fees.halfHourFee == null ? "—" : `${fees.halfHourFee} sat/vB` })),
      el("div", { class: "row" }, el("span", { class: "k", text: "Mempool count" }), el("span", { class: "v", text: btc.mempool && btc.mempool.count != null ? fmtNum(btc.mempool.count, 0) : "—" })),
      el("div", { class: "row" }, el("span", { class: "k", text: "Mempool vsize" }), el("span", { class: "v", text: btc.mempool && btc.mempool.vsize != null ? fmtNum(btc.mempool.vsize, 0) : "—" }))
    ));

    // Prices
    const prices = np.prices || { status: "down" };
    const pricePanel = el("div", { class: "subpanel" },
      el("h3", {}, "Prices",
        el("span", { class: `mini-status ${prices.status}`, text: prices.status }))
    );
    for (const sym of ["SOL", "ETH", "BTC"]) {
      const usd = prices[sym] && prices[sym].usd;
      pricePanel.appendChild(el("div", { class: "row" },
        el("span", { class: "k", text: sym }),
        el("span", { class: "v", text: usd == null ? "—" : `$${fmtNum(usd)}` })
      ));
    }
    host.appendChild(pricePanel);
  }

  function lastFee(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return "—";
    return `${fmtNum(arr[arr.length - 1])} gwei`;
  }

  function sparkline(arr) {
    const wrap = el("div", { class: "sparkline" });
    if (!Array.isArray(arr) || arr.length === 0) return wrap;
    const max = Math.max(...arr.map((x) => (Number.isFinite(x) ? x : 0)), 0.0001);
    for (const v of arr) {
      const h = Math.max(2, (Number(v) / max) * 100);
      wrap.appendChild(el("div", { class: "bar", style: `height:${h}%` }));
    }
    return wrap;
  }

  // ---- overall status: banners + live indicator ----
  function renderOverall(sources) {
    const order = SOURCE_ORDER;
    const allDown = order.every((n) => (sources[n] && sources[n].status) === "down");
    document.getElementById("all-down-banner").classList.toggle("hidden", !allDown);
    document.getElementById("live-indicator").classList.toggle("off", allDown);
  }

  function render(state) {
    lastState = state;
    renderBadges(state.sources || {});
    renderOverall(state.sources || {});
    renderFeed(state.anomalies || []);
    renderDetail();
    renderValidators(state.validators || []);
    renderPressure(state.networkPressure || {});
    document.getElementById("updated-at").textContent =
      "Updated " + fmtTime(state.generatedAt);
  }

  async function tick() {
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const state = await res.json();
      if (state && state.pollIntervalMs) pollIntervalMs = state.pollIntervalMs;
      document.getElementById("conn-error").classList.add("hidden");
      render(state);
    } catch (err) {
      document.getElementById("conn-error").classList.remove("hidden");
      document.getElementById("live-indicator").classList.add("off");
    }
  }

  async function loop() {
    await tick();
    setTimeout(loop, pollIntervalMs);
  }

  loop();
})();
