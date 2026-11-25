import { createHash } from "node:crypto";

/**
 * The dashboard: one self-contained HTML document. No external request of any
 * kind — no CDN, no web font, no image — and the only requests it makes are to
 * the two JSON endpoints of the server that served it.
 *
 * Branch names, paths and reasons come from git and are untrusted. The script
 * below builds every node with createElement / createElementNS and sets every
 * dynamic string through textContent or setAttribute; it never assigns
 * innerHTML and never builds markup from strings. The Content-Security-Policy
 * then allows exactly this stylesheet and this script, by hash, so markup that
 * did get in could not run or load anything.
 *
 * The CSS and the script are plain template literals: keep them free of
 * backticks, backslashes and dollar-brace sequences.
 */

const CSS = `
:root {
  color-scheme: light;
  --page: #f9f9f7;
  --surface: #fcfcfb;
  --ink: #0b0b0b;
  --ink-2: #52514e;
  --muted: #898781;
  --grid: #e1e0d9;
  --axis: #c3c2b7;
  --border: rgba(11, 11, 11, 0.10);
  --wash: rgba(11, 11, 11, 0.04);
  --accent: #2a78d6;
  --track: #cde2fb;
  --good: #0ca30c;
  --warning: #fab219;
  --critical: #d03b3b;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --page: #0d0d0d;
    --surface: #1a1a19;
    --ink: #f0efec;
    --ink-2: #c3c2b7;
    --muted: #898781;
    --grid: #2c2c2a;
    --axis: #383835;
    --border: rgba(255, 255, 255, 0.10);
    --wash: rgba(255, 255, 255, 0.05);
    --accent: #3987e5;
    --track: #0d366b;
  }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--page);
  color: var(--ink);
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
}
.page { max-width: 1040px; margin: 0 auto; padding: 32px 24px 64px; }
h1 { margin: 0; font-size: 20px; font-weight: 650; letter-spacing: -0.01em; }
h2 { margin: 0; font-size: 15px; font-weight: 600; }
p { margin: 0; }
.masthead { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 8px 24px; }
.lede { color: var(--ink-2); margin-top: 2px; }
.daemon { color: var(--ink-2); font-variant-numeric: tabular-nums; }
.daemon strong { color: var(--ink); font-weight: 600; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; background: var(--muted); }
.dot.good { background: var(--good); }
.dot.warn { background: var(--warning); }
.filters { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin: 24px 0 16px; }
.segments { display: inline-flex; padding: 2px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
.seg {
  appearance: none; border: 0; background: transparent; color: var(--ink-2);
  font: inherit; padding: 5px 12px; border-radius: 6px; cursor: pointer;
}
.seg:hover { background: var(--wash); }
.seg[aria-pressed="true"] { background: var(--ink); color: var(--surface); font-weight: 600; }
.seg:focus-visible, .button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.scope { color: var(--ink-2); font-variant-numeric: tabular-nums; }
.frame { transition: opacity 120ms ease; }
.stale { opacity: 0.5; }
.state { color: var(--ink-2); padding: 20px 0; }
.state.error { color: var(--ink); }
.state.error::before { content: "! "; color: var(--critical); font-weight: 700; }
.empty { padding: 40px 24px; text-align: center; border: 1px dashed var(--axis); border-radius: 10px; }
.empty strong { display: block; font-size: 16px; font-weight: 600; margin-bottom: 4px; }
.empty span { color: var(--ink-2); overflow-wrap: anywhere; }
.tiles { display: grid; grid-template-columns: 1.4fr 1fr 1fr 1fr; gap: 12px; }
.tile, .card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; }
.tile { padding: 16px 18px; min-width: 0; }
.tile-label { color: var(--ink-2); font-size: 13px; }
.tile-value { font-size: 28px; font-weight: 600; line-height: 1.15; margin-top: 6px; letter-spacing: -0.01em; }
.tile.hero .tile-value { font-size: 48px; line-height: 1.05; letter-spacing: -0.02em; }
.tile-note { color: var(--ink-2); font-size: 12px; margin-top: 4px; }
.tiles.small .tile-value { font-size: 22px; }
.tiles.small { grid-template-columns: repeat(4, 1fr); }
.card { margin-top: 16px; padding: 18px 20px 14px; }
.card-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; margin-bottom: 10px; }
.card-head .meta { color: var(--ink-2); font-size: 12px; font-variant-numeric: tabular-nums; }
.card-head .push { margin-left: auto; }
.table-wrap { overflow-x: auto; margin: 0 -8px; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 8px; text-align: left; vertical-align: top; }
th { color: var(--ink-2); font-size: 12px; font-weight: 500; white-space: nowrap; border-bottom: 1px solid var(--axis); }
td { border-top: 1px solid var(--grid); overflow-wrap: anywhere; }
tbody tr:first-child td { border-top: 0; }
tfoot td { border-top: 1px solid var(--axis); font-weight: 600; }
.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
td.when { white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--ink-2); }
td.repo { font-weight: 500; }
td.reason { color: var(--ink-2); }
.dim { color: var(--muted); }
.note { color: var(--ink-2); font-size: 12px; margin-top: 10px; overflow-wrap: anywhere; }
.button {
  appearance: none; font: inherit; font-size: 13px; color: var(--ink); background: var(--surface);
  border: 1px solid var(--axis); border-radius: 6px; padding: 4px 10px; cursor: pointer;
}
.button:hover { background: var(--wash); }
.button:disabled { color: var(--muted); cursor: default; background: transparent; }
.chart-wrap { position: relative; }
.chart-wrap svg { display: block; overflow: visible; }
.gridline { stroke: var(--grid); stroke-width: 1; }
.baseline { stroke: var(--axis); stroke-width: 1; }
.tick { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.bar { fill: var(--accent); }
.bar.on { opacity: 0.78; }
.bar-label { fill: var(--ink-2); font-size: 11px; font-variant-numeric: tabular-nums; }
.hit { fill: transparent; outline: none; }
.hit:focus-visible { stroke: var(--accent); stroke-width: 1; }
.tip {
  position: absolute; z-index: 1; pointer-events: none; white-space: nowrap;
  background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
  padding: 8px 10px; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.14);
}
.tip-value { font-size: 15px; font-weight: 600; }
.tip-line { color: var(--ink-2); font-size: 12px; font-variant-numeric: tabular-nums; }
.section-title { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; margin: 40px 0 12px; padding-top: 24px; border-top: 1px solid var(--grid); }
.section-title .meta { color: var(--ink-2); font-size: 12px; font-variant-numeric: tabular-nums; }
.section-title .push { margin-left: auto; }
.volume + .volume { margin-top: 14px; }
.volume-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 2px 16px; margin-bottom: 6px; }
.volume-name { font-weight: 500; overflow-wrap: anywhere; }
.volume-nums { color: var(--ink-2); font-variant-numeric: tabular-nums; }
.meter { height: 8px; border-radius: 4px; background: var(--track); overflow: hidden; }
.meter-fill { height: 100%; border-radius: 4px; background: var(--accent); }
.meter-fill.critical { background: var(--critical); }
#usage-stats { margin-top: 16px; }
@media (max-width: 760px) {
  .tiles, .tiles.small { grid-template-columns: 1fr 1fr; }
  .tile.hero { grid-column: 1 / -1; }
  .page { padding: 20px 14px 48px; }
}
`;

const BODY = `
<main class="page">
  <header class="masthead">
    <div>
      <h1>treekeeper</h1>
      <p class="lede">What was removed, and what is on disk now. Local and read-only.</p>
    </div>
    <p class="daemon" id="daemon"></p>
  </header>

  <div class="filters">
    <div class="segments" role="group" aria-label="Time range">
      <button type="button" class="seg" data-range="7d" aria-pressed="false">7 days</button>
      <button type="button" class="seg" data-range="30d" aria-pressed="true">30 days</button>
      <button type="button" class="seg" data-range="all" aria-pressed="false">All time</button>
    </div>
    <span class="scope" id="scope"></span>
  </div>

  <p class="state" id="history-state" role="status">Loading…</p>
  <div class="empty" id="history-empty" hidden></div>

  <div class="frame" id="history-body" hidden>
    <div class="tiles" id="tiles"></div>
    <p class="state" id="range-empty" hidden></p>

    <section class="card" id="repos-card" aria-labelledby="repos-title">
      <div class="card-head"><h2 id="repos-title">Removed, by repo</h2></div>
      <div class="table-wrap" id="repos"></div>
    </section>

    <section class="card" id="chart-card" aria-labelledby="chart-title">
      <div class="card-head">
        <h2 id="chart-title">Space reclaimed per day</h2>
        <span class="meta" id="chart-meta"></span>
      </div>
      <div class="chart-wrap" id="chart"></div>
    </section>

    <section class="card" id="removals-card" aria-labelledby="removals-title">
      <div class="card-head">
        <h2 id="removals-title">Removed worktrees</h2>
        <span class="meta" id="removals-meta"></span>
      </div>
      <div class="table-wrap" id="removals"></div>
      <p class="note" id="removals-more" hidden></p>
    </section>
  </div>

  <div class="section-title">
    <h2>On disk now</h2>
    <span class="meta" id="usage-meta"></span>
    <button type="button" class="button push" id="usage-refresh" disabled>Measuring…</button>
  </div>
  <p class="state" id="usage-state" role="status">Measuring… this sizes every worktree and can take a minute.</p>
  <div class="frame" id="usage-body" hidden>
    <section class="card" aria-label="Volumes"><div id="volumes"></div></section>
    <div class="tiles small" id="usage-stats"></div>
    <section class="card" aria-labelledby="usage-title">
      <div class="card-head"><h2 id="usage-title">Worktrees, by repo</h2></div>
      <div class="table-wrap" id="usage-repos"></div>
      <div id="usage-notes"></div>
    </section>
  </div>
</main>
`;

const SCRIPT = `
(function () {
  "use strict";

  var SVG_NS = "http://www.w3.org/2000/svg";
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var RANGE_TEXT = { "7d": "the last 7 days", "30d": "the last 30 days", "all": "the whole log" };
  var LIST_STEP = 50;

  var state = {
    range: "30d",
    payload: null,
    historySeq: 0,
    listLimit: LIST_STEP,
    usage: null,
    usageError: null,
    measuring: false
  };

  // ---- DOM helpers. Text always goes in through textContent. ----

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function svgEl(tag, attrs) {
    var node = document.createElementNS(SVG_NS, tag);
    for (var key in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, key)) node.setAttribute(key, String(attrs[key]));
    }
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function show(node, on) { node.hidden = !on; }

  // ---- Formatting ----

  function formatKb(kb) {
    if (typeof kb !== "number" || !isFinite(kb) || kb < 0) return "?";
    if (kb >= 1048576) return (kb / 1048576).toFixed(1) + "G";
    if (kb >= 1024) return Math.round(kb / 1024) + "M";
    return Math.round(kb) + "K";
  }

  function count(n) {
    return Number(n || 0).toLocaleString("en-US");
  }

  function plural(n, one, many) {
    return count(n) + " " + (n === 1 ? one : many);
  }

  function pad(n) { return (n < 10 ? "0" : "") + n; }

  function thisYear() { return new Date().getFullYear(); }

  // "2026-11-12" to "Nov 12", with the year when it is not this one.
  function dayText(day) {
    var parts = String(day).split("-");
    var text = (MONTHS[Number(parts[1]) - 1] || "?") + " " + Number(parts[2]);
    return Number(parts[0]) === thisYear() ? text : text + ", " + parts[0];
  }

  function stamp(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "?";
    var text = MONTHS[d.getMonth()] + " " + d.getDate();
    if (d.getFullYear() !== thisYear()) text += ", " + d.getFullYear();
    return text + ", " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function duration(ms) {
    if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return "?";
    var minutes = Math.floor(ms / 60000);
    if (minutes < 1) return Math.max(1, Math.round(ms / 1000)) + "s";
    if (minutes < 60) return minutes + "m";
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return minutes % 60 ? hours + "h " + (minutes % 60) + "m" : hours + "h";
    var days = Math.floor(hours / 24);
    return hours % 24 ? days + "d " + (hours % 24) + "h" : days + "d";
  }

  function ago(ms) {
    var delta = Date.now() - ms;
    if (!isFinite(delta)) return "?";
    if (delta < 45000) return "just now";
    return duration(delta) + " ago";
  }

  // ---- Building blocks ----

  function tile(label, value, note, hero) {
    var node = el("div", hero ? "tile hero" : "tile");
    node.appendChild(el("div", "tile-label", label));
    node.appendChild(el("div", "tile-value", value));
    if (note) node.appendChild(el("div", "tile-note", note));
    return node;
  }

  // columns: [{ label, cls, cell(row) -> string | Node, foot }]
  function table(columns, rows, withFoot) {
    var node = el("table");
    var head = el("tr");
    columns.forEach(function (col) {
      var th = el("th", col.cls === "num" ? "num" : "", col.label);
      th.setAttribute("scope", "col");
      head.appendChild(th);
    });
    var thead = el("thead");
    thead.appendChild(head);
    node.appendChild(thead);

    var tbody = el("tbody");
    rows.forEach(function (row) {
      var tr = el("tr");
      columns.forEach(function (col) {
        var td = el("td", col.cls || "");
        var content = col.cell(row, td);
        if (content instanceof Node) td.appendChild(content);
        else if (content !== undefined && content !== null) td.textContent = String(content);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    node.appendChild(tbody);

    if (withFoot) {
      var foot = el("tr");
      columns.forEach(function (col) {
        foot.appendChild(el("td", col.cls === "num" ? "num" : "", col.foot === undefined ? "" : col.foot));
      });
      var tfoot = el("tfoot");
      tfoot.appendChild(foot);
      node.appendChild(tfoot);
    }
    return node;
  }

  function repoCell(row, td) {
    td.setAttribute("title", row.repo);
    return row.name;
  }

  function getJson(url) {
    return fetch(url, { cache: "no-store", headers: { Accept: "application/json" } }).then(function (res) {
      return res.json().then(
        function (body) {
          if (!res.ok) throw new Error(body && body.error ? String(body.error) : "HTTP " + res.status);
          return body;
        },
        function () { throw new Error("unreadable response (HTTP " + res.status + ")"); }
      );
    });
  }

  // ---- Daemon line ----

  function renderDaemon() {
    var host = $("daemon");
    clear(host);
    var d = state.payload ? state.payload.daemon : null;
    if (!d) return;

    var status = !d.installed ? "not installed" : d.active ? "scheduled" : "installed, not loaded";
    var dot = el("span", "dot" + (d.installed ? (d.active ? " good" : " warn") : ""));
    dot.setAttribute("aria-hidden", "true");
    host.appendChild(dot);
    host.appendChild(el("strong", "", "Daemon " + status));

    var bits = [];
    if (d.installed && d.intervalSeconds) bits.push("every " + duration(d.intervalSeconds * 1000));
    bits.push(d.lastSweep ? "last sweep " + ago(d.lastSweep.at) : "no sweep yet");
    bits.push(plural(d.sweeps, "sweep", "sweeps"));
    host.appendChild(document.createTextNode(" · " + bits.join(" · ")));
  }

  // ---- History ----

  function renderHistory() {
    var payload = state.payload;
    if (!payload) return;
    var h = payload.history;
    renderDaemon();

    var first = h.byDay.length ? h.byDay[0].day : null;
    var last = h.byDay.length ? h.byDay[h.byDay.length - 1].day : null;
    $("scope").textContent = first === null ? "" : first === last ? dayText(first) : dayText(first) + " – " + dayText(last);

    show($("history-state"), false);

    if (h.since === null) {
      var empty = $("history-empty");
      clear(empty);
      empty.appendChild(el("strong", "", "Nothing removed yet"));
      empty.appendChild(el("span", "",
        "Every worktree and branch treekeeper removes is recorded" +
        (payload.logFile ? " in " + payload.logFile : "") +
        ". The first one will show up here."));
      show(empty, true);
      show($("history-body"), false);
      return;
    }
    show($("history-empty"), false);
    show($("history-body"), true);

    var t = h.totals;
    var tiles = $("tiles");
    clear(tiles);
    tiles.appendChild(tile("Space reclaimed", formatKb(t.reclaimedKb),
      t.worktrees ? "from " + plural(t.worktrees, "removed worktree", "removed worktrees") : "no worktrees removed", true));
    tiles.appendChild(tile("Worktrees removed", count(t.worktrees),
      t.worktrees ? "average " + formatKb(t.reclaimedKb / t.worktrees) + " each" : ""));
    tiles.appendChild(tile("Branches deleted", count(t.branches), "pruned without a worktree"));
    tiles.appendChild(tile("Repos touched", count(t.repos), "log starts " + stamp(h.since)));

    var nothing = t.worktrees === 0 && t.branches === 0;
    var note = $("range-empty");
    note.textContent = nothing ? "Nothing removed in " + RANGE_TEXT[h.range] + "." : "";
    show(note, nothing);
    show($("repos-card"), !nothing);
    show($("chart-card"), !nothing);
    show($("removals-card"), !nothing);
    if (nothing) return;

    var repos = $("repos");
    clear(repos);
    repos.appendChild(table([
      { label: "Repo", cls: "repo", cell: repoCell },
      { label: "Worktrees removed", cls: "num", cell: function (r) { return count(r.worktrees); } },
      { label: "Space reclaimed", cls: "num", cell: function (r) { return formatKb(r.reclaimedKb); } },
      { label: "Branches deleted", cls: "num", cell: function (r) { return count(r.branches); } },
      { label: "Most recent", cls: "num", cell: function (r, td) {
          td.setAttribute("title", ago(Date.parse(r.lastRemovalAt)));
          return stamp(r.lastRemovalAt);
        } }
    ], h.byRepo, false));

    renderChart();
    renderRemovals();
  }

  function renderRemovals() {
    var h = state.payload.history;
    var host = $("removals");
    var more = $("removals-more");
    clear(host);
    clear(more);
    $("removals-meta").textContent = plural(h.totals.worktrees, "worktree", "worktrees") + ", newest first";

    if (h.removals.length === 0) {
      host.appendChild(el("p", "state", "No worktrees removed in " + RANGE_TEXT[h.range] + " — only branches."));
      show(more, false);
      return;
    }

    var rows = h.removals.slice(0, state.listLimit);
    host.appendChild(table([
      { label: "When", cls: "when", cell: function (r, td) {
          td.setAttribute("title", ago(Date.parse(r.at)));
          return stamp(r.at);
        } },
      { label: "Repo", cls: "repo", cell: repoCell },
      { label: "Branch", cls: "", cell: function (r, td) {
          td.setAttribute("title", r.path);
          return r.branch === null ? el("span", "dim", "(detached)") : r.branch;
        } },
      { label: "Size", cls: "num", cell: function (r) { return formatKb(r.sizeKb); } },
      { label: "Reason", cls: "reason", cell: function (r) {
          return r.archived ? r.reason + " · archived first" : r.reason;
        } }
    ], rows, false));

    var hidden = h.removals.length - rows.length;
    if (hidden > 0) {
      var button = el("button", "button", "Show " + Math.min(LIST_STEP, hidden) + " more");
      button.setAttribute("type", "button");
      button.addEventListener("click", function () {
        state.listLimit += LIST_STEP;
        renderRemovals();
      });
      more.appendChild(button);
      more.appendChild(document.createTextNode("  " + count(hidden) + " not shown"));
    } else if (h.removalsOmitted > 0) {
      more.textContent = plural(h.removalsOmitted, "older removal is", "older removals are") + " counted above but not listed.";
    }
    show(more, hidden > 0 || h.removalsOmitted > 0);
  }

  // ---- Chart: one series, space reclaimed per day ----

  function bucketDays(days, maxBars) {
    var size = 1;
    if (days.length > maxBars) {
      size = days.length / 7 <= maxBars ? 7 : days.length / 28 <= maxBars ? 28 : Math.ceil(days.length / maxBars);
    }
    var buckets = [];
    // Group back from today so the newest bar always ends on the last day.
    for (var end = days.length; end > 0; end -= size) {
      var start = Math.max(0, end - size);
      var b = { from: days[start].day, to: days[end - 1].day, reclaimedKb: 0, worktrees: 0, branches: 0 };
      for (var i = start; i < end; i += 1) {
        b.reclaimedKb += days[i].reclaimedKb;
        b.worktrees += days[i].worktrees;
        b.branches += days[i].branches;
      }
      b.label = b.from === b.to ? dayText(b.from) : dayText(b.from) + " – " + dayText(b.to);
      buckets.unshift(b);
    }
    return { size: size, buckets: buckets };
  }

  // A clean axis in the unit the largest value reads in (K, M or G).
  function axisFor(maxKb) {
    var unit = maxKb >= 1048576 ? 1048576 : maxKb >= 1024 ? 1024 : 1;
    var letter = unit === 1048576 ? "G" : unit === 1024 ? "M" : "K";
    var top = Math.max(maxKb / unit, 1);
    var rough = top / 3;
    var power = Math.pow(10, Math.floor(Math.log(rough) / Math.LN10));
    var lead = rough / power;
    var step = (lead <= 1 ? 1 : lead <= 2 ? 2 : lead <= 5 ? 5 : 10) * power;
    var ticks = [];
    for (var v = 0; v < top + step * 0.999; v += step) {
      var shown = Math.round(v * 100) / 100;
      ticks.push({ kb: v * unit, label: shown === 0 ? "0" : shown + letter });
    }
    return { maxKb: ticks[ticks.length - 1].kb, ticks: ticks };
  }

  function renderChart() {
    var host = $("chart");
    var payload = state.payload;
    if (!payload || $("chart-card").hidden || $("history-body").hidden) return;
    var days = payload.history.byDay;
    clear(host);

    var width = Math.max(320, Math.floor(host.clientWidth || 720));
    var height = 230;
    var m = { top: 22, right: 16, bottom: 26, left: 46 };
    var plotW = width - m.left - m.right;
    var plotH = height - m.top - m.bottom;
    var grouped = bucketDays(days, Math.max(1, Math.floor(plotW / 6)));
    var buckets = grouped.buckets;

    $("chart-title").textContent = "Space reclaimed per " +
      (grouped.size === 1 ? "day" : grouped.size === 7 ? "week" : grouped.size + " days");

    var peak = null;
    buckets.forEach(function (b) {
      if (b.reclaimedKb > 0 && (peak === null || b.reclaimedKb > peak.reclaimedKb)) peak = b;
    });
    $("chart-meta").textContent = peak === null
      ? "branches only — no disk space was reclaimed"
      : "peak " + formatKb(peak.reclaimedKb) + ", " + peak.label;

    var axis = axisFor(peak === null ? 0 : peak.reclaimedKb);
    var baseY = m.top + plotH;
    var yOf = function (kb) { return baseY - (kb / axis.maxKb) * plotH; };

    var svg = svgEl("svg", { width: width, height: height, viewBox: "0 0 " + width + " " + height, role: "group" });
    svg.setAttribute("aria-label", "Space reclaimed per bar, " + buckets.length + " bars. Focus a bar for its value.");

    axis.ticks.forEach(function (tick) {
      var y = Math.round(yOf(tick.kb)) + 0.5;
      if (tick.kb > 0) svg.appendChild(svgEl("line", { x1: m.left, x2: width - m.right, y1: y, y2: y, "class": "gridline" }));
      var text = svgEl("text", { x: m.left - 8, y: y + 4, "text-anchor": "end", "class": "tick" });
      text.textContent = tick.label;
      svg.appendChild(text);
    });

    var band = plotW / buckets.length;
    var barW = Math.max(1, Math.min(24, band - 2));
    var every = Math.max(1, Math.ceil(buckets.length / Math.max(1, Math.floor(plotW / 72))));
    var bars = [];

    buckets.forEach(function (b, i) {
      var cx = m.left + band * i + band / 2;
      var x = cx - barW / 2;
      var h = b.reclaimedKb > 0 ? Math.max(1, baseY - yOf(b.reclaimedKb)) : 0;
      var top = baseY - h;
      var bar = null;
      if (h > 0) {
        // Rounded at the data end, square on the baseline.
        var r = Math.min(4, h, barW / 2);
        bar = svgEl("path", {
          "class": "bar",
          d: "M" + x + "," + baseY + " V" + (top + r) + " Q" + x + "," + top + " " + (x + r) + "," + top +
             " H" + (x + barW - r) + " Q" + (x + barW) + "," + top + " " + (x + barW) + "," + (top + r) +
             " V" + baseY + " Z"
        });
        svg.appendChild(bar);
      }
      bars.push(bar);

      // Label from the newest bar backwards, so today is always named.
      if ((buckets.length - 1 - i) % every === 0) {
        var label = svgEl("text", { x: cx, y: baseY + 17, "text-anchor": "middle", "class": "tick" });
        label.textContent = dayText(b.to);
        svg.appendChild(label);
      }

      if (b === peak) {
        var value = svgEl("text", {
          x: Math.min(Math.max(cx, m.left + 16), width - m.right - 16), y: top - 6,
          "text-anchor": "middle", "class": "bar-label"
        });
        value.textContent = formatKb(b.reclaimedKb);
        svg.appendChild(value);
      }
    });

    svg.appendChild(svgEl("line", { x1: m.left, x2: width - m.right, y1: baseY + 0.5, y2: baseY + 0.5, "class": "baseline" }));

    var tip = el("div", "tip");
    tip.hidden = true;

    var point = function (i) {
      var b = buckets[i];
      bars.forEach(function (bar, j) { if (bar) bar.setAttribute("class", j === i ? "bar on" : "bar"); });
      clear(tip);
      tip.appendChild(el("div", "tip-value", formatKb(b.reclaimedKb)));
      tip.appendChild(el("div", "tip-line",
        plural(b.worktrees, "worktree", "worktrees") + (b.branches ? " · " + plural(b.branches, "branch", "branches") : "")));
      tip.appendChild(el("div", "tip-line", b.label));
      tip.hidden = false;
      var cx = m.left + band * i + band / 2;
      var top = b.reclaimedKb > 0 ? yOf(b.reclaimedKb) : baseY;
      var left = Math.min(Math.max(0, cx - tip.offsetWidth / 2), Math.max(0, width - tip.offsetWidth));
      var y = top - tip.offsetHeight - 10;
      tip.style.left = left + "px";
      tip.style.top = (y < 0 ? top + 10 : y) + "px";
    };
    var leave = function () {
      bars.forEach(function (bar) { if (bar) bar.setAttribute("class", "bar"); });
      tip.hidden = true;
    };

    // The hit target is the whole column, not just the painted bar.
    buckets.forEach(function (b, i) {
      var hit = svgEl("rect", {
        "class": "hit", x: m.left + band * i, y: m.top, width: band, height: plotH,
        tabindex: 0, role: "img"
      });
      hit.setAttribute("aria-label", b.label + ": " + formatKb(b.reclaimedKb) + " reclaimed, " +
        plural(b.worktrees, "worktree", "worktrees") + ", " + plural(b.branches, "branch", "branches"));
      hit.addEventListener("pointerenter", function () { point(i); });
      hit.addEventListener("pointerleave", leave);
      hit.addEventListener("focus", function () { point(i); });
      hit.addEventListener("blur", leave);
      svg.appendChild(hit);
    });

    host.appendChild(svg);
    host.appendChild(tip);
  }

  function loadHistory() {
    var seq = state.historySeq += 1;
    var body = $("history-body");
    body.classList.add("stale");
    return getJson("/api/history?range=" + encodeURIComponent(state.range)).then(
      function (payload) {
        if (seq !== state.historySeq) return;
        state.payload = payload;
        body.classList.remove("stale");
        renderHistory();
      },
      function (err) {
        if (seq !== state.historySeq) return;
        body.classList.remove("stale");
        var line = $("history-state");
        line.className = "state error";
        line.textContent = "Could not load the removal history: " + (err && err.message ? err.message : "request failed");
        show(line, true);
      }
    );
  }

  // ---- Current usage ----

  function renderUsageStatus() {
    var u = state.usage;
    var button = $("usage-refresh");
    button.disabled = state.measuring;
    button.textContent = state.measuring ? "Measuring…" : "Refresh";

    var line = $("usage-state");
    if (state.usageError) {
      line.className = "state error";
      line.textContent = "Could not measure current usage: " + state.usageError;
      show(line, true);
    } else if (!u) {
      line.className = "state";
      line.textContent = "Measuring… this sizes every worktree and can take a minute.";
      show(line, true);
    } else {
      show(line, false);
    }

    var body = $("usage-body");
    show(body, !!u);
    body.classList.toggle("stale", state.measuring && !!u);
    $("usage-meta").textContent = u
      ? "measured " + ago(Date.parse(u.generatedAt)) + " · took " + duration(u.durationMs) + " · not affected by the range"
      : "";
  }

  function renderUsage() {
    renderUsageStatus();
    var u = state.usage;
    if (!u) return;

    var volumes = $("volumes");
    clear(volumes);
    if (u.volumes.length === 0) {
      volumes.appendChild(el("p", "state", "No volume could be read for the configured roots: " + u.roots.join(", ")));
    }
    u.volumes.forEach(function (v) {
      var pct = v.totalKb > 0 ? Math.min(100, Math.max(0, (v.usedKb / v.totalKb) * 100)) : 0;
      var low = pct >= 90;
      var box = el("div", "volume");
      var head = el("div", "volume-head");
      head.appendChild(el("span", "volume-name", "Volume holding " + v.roots.join(", ")));
      head.appendChild(el("span", "volume-nums",
        formatKb(v.usedKb) + " used of " + formatKb(v.totalKb) + " · " + formatKb(v.freeKb) + " free" +
        (low ? " · low on space" : "")));
      var meter = el("div", "meter");
      meter.setAttribute("role", "img");
      meter.setAttribute("aria-label", Math.round(pct) + "% used");
      var fill = el("div", low ? "meter-fill critical" : "meter-fill");
      fill.style.width = pct.toFixed(1) + "%";
      meter.appendChild(fill);
      box.appendChild(head);
      box.appendChild(meter);
      volumes.appendChild(box);
    });

    var t = u.totals;
    var withWorktrees = u.repos.filter(function (r) { return r.worktrees > 0; }).length;
    var stats = $("usage-stats");
    clear(stats);
    stats.appendChild(tile("Linked worktrees", count(t.worktrees), "in " + plural(withWorktrees, "repo", "repos")));
    stats.appendChild(tile("They occupy", formatKb(t.sizeKb),
      t.unmeasured ? plural(t.unmeasured, "worktree", "worktrees") + " could not be measured" : ""));
    stats.appendChild(tile("Reclaimable now", formatKb(t.reclaimableKb),
      plural(t.reclaimableWorktrees, "finished worktree", "finished worktrees")));
    stats.appendChild(tile("Branches to prune", count(t.branchesDeletable), "merged or closed, no worktree"));

    var rows = u.repos.filter(function (r) { return r.worktrees > 0 || r.branchesDeletable > 0; });
    var host = $("usage-repos");
    clear(host);
    if (rows.length === 0) {
      host.appendChild(el("p", "state", u.repos.length === 0
        ? "No git repos found under " + u.roots.join(", ") + "."
        : "No linked worktrees and nothing to prune in " + plural(u.repos.length, "repo", "repos") + "."));
    } else {
      host.appendChild(table([
        { label: "Repo", cls: "repo", cell: repoCell, foot: "Total" },
        { label: "Worktrees", cls: "num", cell: function (r) { return count(r.worktrees); }, foot: count(t.worktrees) },
        { label: "On disk", cls: "num", cell: function (r) {
            return formatKb(r.sizeKb) + (r.unmeasured ? " +" + r.unmeasured + " unmeasured" : "");
          }, foot: formatKb(t.sizeKb) },
        { label: "Reclaimable", cls: "num", cell: function (r) { return count(r.reclaimableWorktrees); }, foot: count(t.reclaimableWorktrees) },
        { label: "Reclaimable size", cls: "num", cell: function (r) { return formatKb(r.reclaimableKb); }, foot: formatKb(t.reclaimableKb) },
        { label: "Branches to prune", cls: "num", cell: function (r) { return count(r.branchesDeletable); }, foot: count(t.branchesDeletable) }
      ], rows, true));
    }

    var notes = $("usage-notes");
    clear(notes);
    var quiet = u.repos.length - rows.length;
    if (rows.length > 0 && quiet > 0) {
      notes.appendChild(el("p", "note", plural(quiet, "other repo has", "other repos have") + " no linked worktrees and nothing to prune."));
    }
    if (u.skipped.length > 0) {
      notes.appendChild(el("p", "note", "Skipped: " + u.skipped.map(function (s) { return s.name + " (" + s.reason + ")"; }).join(", ")));
    }
    u.warnings.forEach(function (w) { notes.appendChild(el("p", "note", "Note: " + w)); });
    notes.appendChild(el("p", "note", "Worktree counts and sizes leave out each repo's main checkout. Nothing on this page removes anything; run treekeeper gc --apply for that."));
  }

  function loadUsage(refresh) {
    if (state.measuring) return;
    state.measuring = true;
    state.usageError = null;
    renderUsageStatus();
    getJson(refresh ? "/api/usage?refresh=1" : "/api/usage").then(
      function (payload) {
        state.measuring = false;
        state.usage = payload.usage;
        renderUsage();
      },
      function (err) {
        state.measuring = false;
        state.usageError = err && err.message ? err.message : "request failed";
        renderUsageStatus();
      }
    );
  }

  // ---- Wiring ----

  Array.prototype.forEach.call(document.querySelectorAll(".seg"), function (button) {
    button.addEventListener("click", function () {
      var range = button.getAttribute("data-range");
      if (range === state.range) return;
      state.range = range;
      state.listLimit = LIST_STEP;
      Array.prototype.forEach.call(document.querySelectorAll(".seg"), function (other) {
        other.setAttribute("aria-pressed", other === button ? "true" : "false");
      });
      loadHistory();
    });
  });

  $("usage-refresh").addEventListener("click", function () { loadUsage(true); });

  var resizeQueued = false;
  window.addEventListener("resize", function () {
    if (resizeQueued) return;
    resizeQueued = true;
    window.requestAnimationFrame(function () {
      resizeQueued = false;
      renderChart();
    });
  });

  // Keep "12m ago" honest on a page left open, and pick up new removals when
  // the tab comes back to the front.
  window.setInterval(function () {
    renderDaemon();
    if (state.usage) renderUsageStatus();
  }, 30000);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && state.payload) loadHistory();
  });

  loadHistory();
  loadUsage(false);
})();
`;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("base64");
}

/**
 * Nothing loads from anywhere but this document: no default source at all, the
 * one inline stylesheet and the one inline script by hash, and fetch() back to
 * the serving origin only.
 */
export const PAGE_CSP = [
  "default-src 'none'",
  `script-src 'sha256-${sha256(SCRIPT)}'`,
  `style-src 'sha256-${sha256(CSS)}'`,
  "connect-src 'self'",
  "img-src data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export const PAGE_HTML =
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>treekeeper</title>
<link rel="icon" href="data:,">
<style>${CSS}</style>
</head>
<body>${BODY}<script>${SCRIPT}</script>
</body>
</html>
`;
