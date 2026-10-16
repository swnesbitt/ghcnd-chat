// app.js — wires Lumen sign-in, the DuckDB session and the agent loop to the page.

import { createLumenClient, LumenError } from "./lumen-oauth.js";
import { CONFIG } from "./config.js";
import { runTurn } from "./agent.js";
import { marked } from "https://cdn.jsdelivr.net/npm/marked@18.1.1/+esm";
import DOMPurify from "https://cdn.jsdelivr.net/npm/dompurify@3.4.17/+esm";

const lumen = createLumenClient({
  baseUrl: CONFIG.lumenBaseUrl,
  clientId: CONFIG.clientId,
  keyName: CONFIG.keyName,
});

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
};

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

let ghcndPromise = null;
let messages = [];
let running = null; // AbortController while a turn runs

// ---------------------------------------------------------------------------
// Messages and banners

function setStatus(text) { $("status").textContent = text; }

function showBanner(text) {
  const b = $("banner");
  b.textContent = text;
  b.hidden = !text;
}

// The page's CSP blocks any host not listed in connect-src. Say so plainly
// when that host is the configured Lumen server.
document.addEventListener("securitypolicyviolation", (e) => {
  const lumenOrigin = new URL(CONFIG.lumenBaseUrl).origin;
  if (e.blockedURI && e.blockedURI.startsWith(lumenOrigin)) {
    showBanner(`The page's Content-Security-Policy blocks ${lumenOrigin}. Add it to connect-src in index.html.`);
  }
});

// ---------------------------------------------------------------------------
// Views

function showConnect() {
  $("connect-view").hidden = false;
  $("app").hidden = true;
  $("session").hidden = true;
}

async function showApp() {
  $("connect-view").hidden = true;
  $("app").hidden = false;
  $("session").hidden = false;
  startData();
  await loadModels();
}

async function loadModels() {
  const select = $("model");
  select.replaceChildren();
  let models;
  try {
    models = await lumen.getModels();
  } catch (err) {
    handleLumenError(err);
    return;
  }
  const usable = models
    .filter((m) => m.status !== "down")
    .sort((a, b) => (b.supports_function_calling === true) - (a.supports_function_calling === true) || a.id.localeCompare(b.id));
  for (const m of usable) {
    const note = m.supports_function_calling === false ? " (no tool calling)" : "";
    select.append(el("option", { value: m.id, textContent: m.id + note }));
  }
  const saved = store.get("ghcnd-chat-model");
  const pick =
    [saved, CONFIG.preferredModel].find((id) => id && usable.some((m) => m.id === id)) ||
    usable.find((m) => m.supports_function_calling)?.id ||
    usable[0]?.id;
  if (pick) select.value = pick;
  select.onchange = () => {
    store.set("ghcnd-chat-model", select.value);
    warnIfNoTools(usable);
  };
  if (!usable.length) showBanner("Your Lumen account has no models available. Check your access on Lumen.");
  warnIfNoTools(usable);
}

function warnIfNoTools(models) {
  const m = models.find((x) => x.id === $("model").value);
  setStatus(m && m.supports_function_calling === false
    ? `${m.id} does not support tool calling, so it cannot use the data tools. Pick another model.`
    : "");
}

// ---------------------------------------------------------------------------
// Data session (DuckDB-WASM), started once per page load

function startData() {
  if (ghcndPromise) return ghcndPromise;
  setStatus("Starting the database");
  ghcndPromise = import("./ghcnd.js")
    .then((m) => m.createGhcnd({ onActivity }))
    .then((g) => {
      if (!running) setStatus("");
      return g;
    })
    .catch((err) => {
      ghcndPromise = null;
      showBanner(`Could not start the database: ${err.message}`);
      throw err;
    });
  return ghcndPromise;
}

function onActivity(a) {
  if (a.kind === "status") setStatus(a.text);
  if (a.kind === "download") {
    const mb = (a.stats.bytes / 1e6).toFixed(1);
    setStatus(`Downloading NOAA files: ${mb} MB so far`);
    $("downloaded").textContent = `Downloaded ${mb} MB from NOAA in ${a.stats.files} files this session.`;
  }
  if (a.kind === "loaded") renderRecords(a.loaded);
}

// ---------------------------------------------------------------------------
// Period-of-record rail

function renderRecords(list) {
  const ol = $("records");
  ol.replaceChildren();
  $("rail-empty").hidden = list.length > 0;
  if (!list.length) return;
  const now = new Date().getUTCFullYear();
  const start = Math.floor(Math.min(...list.map((r) => r.record_first)) / 10) * 10;
  const pos = (year) => `${(100 * (year - start)) / (now + 1 - start)}%`;
  const yearFrac = (iso) => Number(iso.slice(0, 4)) + (Date.parse(iso) - Date.UTC(Number(iso.slice(0, 4)), 0, 1)) / 31557600000;

  for (const r of list) {
    const bar = el("div", { className: "bar", role: "img" });
    bar.setAttribute(
      "aria-label",
      `Record ${r.record_first} to ${r.record_last}; loaded ${r.first_date} to ${r.last_date}`
    );
    const full = el("span", { className: "full" });
    full.style.left = pos(r.record_first);
    full.style.width = `calc(${pos(r.record_last + 1)} - ${pos(r.record_first)})`;
    const span = el("span", { className: "span" });
    const a = yearFrac(r.first_date);
    const b = yearFrac(r.last_date) + 1 / 365;
    span.style.left = pos(a);
    span.style.width = `max(2px, calc(${pos(b)} - ${pos(a)}))`;
    bar.append(full, span);
    ol.append(
      el("li", {},
        el("div", { className: "name", textContent: [r.name, r.state].filter(Boolean).join(", ") }),
        el("div", { className: "meta", textContent: `${r.station} ${r.element}` }),
        bar,
        el("div", {
          className: "meta",
          textContent: r.kind === "area"
            ? (r.first_date === r.last_date ? r.first_date : `${r.first_date} to ${r.last_date}`)
            : `${r.first_date.slice(0, 4)}–${r.last_date.slice(0, 4)} loaded, ${r.days_present_pct}% of days present`,
        })
      )
    );
  }
  ol.append(el("li", { className: "axis", ariaHidden: "true" },
    el("span", { textContent: String(start) }), el("span", { textContent: String(now) })));
}

// ---------------------------------------------------------------------------
// Transcript

function scrollToEnd() {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  $("composer").scrollIntoView({ block: "end", behavior: reduce ? "auto" : "smooth" });
}

function addUser(text) {
  $("empty")?.remove();
  $("log").append(el("p", { className: "turn-user", textContent: text }));
  scrollToEnd();
}

function addAnswer(markdown) {
  const div = el("div", { className: "answer" });
  div.innerHTML = DOMPurify.sanitize(marked.parse(markdown || "(no answer)"));
  for (const a of div.querySelectorAll("a")) a.rel = "noopener noreferrer";
  $("log").append(div);
  scrollToEnd();
}

function addError(text) {
  $("log").append(el("p", { className: "answer error-text", textContent: text }));
  scrollToEnd();
}

function areaLabel(a = {}) {
  const r = a.radius_km ?? 50;
  if (a.place) return `within ${r} km of ${a.place}`;
  if (Number.isFinite(a.lat)) return `within ${r} km of ${a.lat}, ${a.lon}`;
  if (a.county) return `in ${a.county} County${a.state ? `, ${a.state}` : ""}`;
  if (a.state) return `in ${a.state}`;
  if (a.country) return `in ${a.country}`;
  if (a.stations?.length) return `(${a.stations.length} listed)`;
  return "";
}

function stepLabel(name, args = {}) {
  switch (name) {
    case "find_stations": {
      const where = [args.query && `“${args.query}”`, areaLabel(args)].filter(Boolean).join(" ");
      return `Searched stations ${where}`.trim();
    }
    case "load_series": {
      const years = args.start_year || args.end_year ? ` ${args.start_year ?? "start"}–${args.end_year ?? "now"}` : "";
      return `Loaded ${args.station} ${(args.elements || ["PRCP"]).join(", ")}${years}`;
    }
    case "load_area": {
      const when = args.end_date && args.end_date !== args.start_date ? `${args.start_date} to ${args.end_date}` : args.start_date;
      return `Loaded all stations ${areaLabel(args) || ""}, ${(args.elements || ["TMAX"]).join(", ")}, ${when}`;
    }
    case "run_sql": return "Ran a query";
    case "make_chart": return args.title ? `Drew a chart: ${args.title}` : "Drew a chart";
    default: return `Called ${name}`;
  }
}

const steps = new Map();

function onStep(s) {
  if (s.type === "thinking") setStatus("Thinking");
  if (s.type === "tool_start") {
    setStatus(stepLabel(s.name, s.args || {}));
    const details = el("details", { className: "step running" },
      el("summary", { textContent: stepLabel(s.name, s.args || {}) }));
    $("log").append(details);
    steps.set(s.id, details);
    scrollToEnd();
  }
  if (s.type === "tool_end") {
    const details = steps.get(s.id);
    if (!details) return;
    details.classList.remove("running");
    const failed = s.result && s.result.error;
    if (failed) {
      details.classList.add("failed");
      details.querySelector("summary").textContent += " (failed)";
    }
    const call = s.name === "run_sql" ? s.args?.query
      : s.name === "make_chart"
        ? `${s.args?.sql ?? ""}\n\n${JSON.stringify(s.args?.vega_lite ?? s.args?.spec ?? null, null, 2)}`
      : JSON.stringify(s.args, null, 2);
    const result = JSON.stringify(s.result, null, 2);
    details.append(
      el("pre", { textContent: call || "" }),
      el("pre", { textContent: result.length > 6000 ? result.slice(0, 6000) + "\n…" : result })
    );
    setStatus("Thinking");
  }
}

// ---------------------------------------------------------------------------
// Charts (Vega-Lite, loaded on first use; the interpreter avoids eval under the CSP)

let vegaPromise = null;
const charts = []; // redraw functions, so charts follow a light/dark switch

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  for (const draw of charts) draw().catch(() => {});
});

function chartConfig() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  return {
    font: "Source Sans 3, Source Sans Pro, system-ui, sans-serif",
    background: null,
    view: { stroke: null },
    axis: { labelColor: v("--ink-soft"), titleColor: v("--ink"), gridColor: v("--record"), domainColor: v("--rule"), tickColor: v("--rule"), labelFontSize: 12, titleFontSize: 13, titleFontWeight: 600 },
    legend: { labelColor: v("--ink-soft"), titleColor: v("--ink") },
    title: { color: v("--ink"), font: "Montserrat, system-ui, sans-serif", fontSize: 14, fontWeight: 700, anchor: "start" },
    range: { category: ["#1d58a7", "#c84113", "#009fd4", "#707372", "#5c0e41", "#13294b"] },
    mark: { color: "#1d58a7" },
  };
}

const CHART_EXAMPLE =
  '{"mark": "bar", "encoding": {"x": {"field": "year", "type": "ordinal"}, ' +
  '"y": {"field": "total_mm", "type": "quantitative", "title": "Precipitation (mm)"}}}';

// Keys where null means something in Vega-Lite (hide the axis, no sorting, ...).
const MEANINGFUL_NULL = new Set(["axis", "legend", "sort", "scale", "stack", "header", "condition", "bin"]);

// Turn whatever the model sent into a spec Vega-Lite accepts, or explain what
// is wrong in terms the model can act on. Models often send the spec as a JSON
// string, put nulls where Vega-Lite expects objects (a null layer encoding
// makes it throw "Cannot convert undefined or null to object"), or add data
// sources of their own. Anything that would make Vega fetch is removed; the
// rows always come from the chart's SQL.
function normalizeSpec(raw) {
  let spec = raw;
  if (typeof spec === "string") {
    try {
      spec = JSON.parse(spec);
    } catch {
      throw new Error(`vega_lite must be a JSON object, not text. Example: ${CHART_EXAMPLE}`);
    }
  }
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error(`vega_lite must be a Vega-Lite spec object. Example: ${CHART_EXAMPLE}`);
  }
  spec = JSON.parse(JSON.stringify(spec));

  const clean = (node, parentKey) => {
    if (Array.isArray(node)) return node.filter((x) => x !== null && x !== undefined).map((x) => clean(x, parentKey));
    if (!node || typeof node !== "object") return node;
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (k === "url" || k === "href" || k === "datasets") delete node[k];
      else if (k === "data" && !(v && Array.isArray(v.values))) delete node[k]; // inherit the SQL rows
      else if (v === null && !MEANINGFUL_NULL.has(k)) delete node[k];
      else node[k] = clean(v, k);
    }
    return node;
  };
  spec = clean(spec);
  delete spec.data;
  delete spec.$schema;
  delete spec.autosize;

  const composite = ["layer", "facet", "hconcat", "vconcat", "concat", "repeat"].some((k) => spec[k]);
  if (!spec.mark && !composite) {
    throw new Error(`The spec needs a "mark" (or "layer"). Example: ${CHART_EXAMPLE}`);
  }
  // Years encoded as numbers get thousands separators ("2,020"); format them plainly.
  const fixYears = (node) => {
    if (!node || typeof node !== "object") return;
    for (const ch of ["x", "y", "x2", "y2"]) {
      const enc = node.encoding?.[ch];
      if (enc && /(^|_)(year|yr)$/i.test(enc.field || "") && (enc.type === "quantitative" || !enc.type) && enc.axis !== null) {
        enc.axis = { format: "d", ...(enc.axis || {}) };
      }
    }
    for (const k of ["layer", "concat", "hconcat", "vconcat"]) if (Array.isArray(node[k])) node[k].forEach(fixYears);
    if (node.spec) fixYears(node.spec);
  };
  fixYears(spec);

  // A bar, line or area mark without y draws full-height bands (a histogram
  // whose count was left out looks like a wall of bars). Add the count when x
  // is binned; otherwise ask the model for the missing channel.
  const NEEDS_XY = new Set(["bar", "line", "area", "trail"]);
  const checkXY = (node, inherited = {}) => {
    if (!node || typeof node !== "object") return;
    const enc = { ...inherited, ...(node.encoding || {}) };
    if (Array.isArray(node.layer)) return node.layer.forEach((l) => checkXY(l, enc));
    if (node.spec) return checkXY(node.spec, enc);
    const mark = typeof node.mark === "string" ? node.mark : node.mark?.type;
    if (!NEEDS_XY.has(mark)) return;
    const count = { aggregate: "count", type: "quantitative", title: "Count" };
    if (enc.x?.bin && !enc.y) node.encoding = { ...(node.encoding || {}), y: count };
    else if (enc.y?.bin && !enc.x) node.encoding = { ...(node.encoding || {}), x: count };
    else if (!enc.x || !enc.y) {
      throw new Error(
        `A ${mark} chart needs both x and y encodings. For a histogram: ` +
          '{"mark": "bar", "encoding": {"x": {"field": "<value column>", "bin": true, "type": "quantitative"}, ' +
          '"y": {"aggregate": "count", "type": "quantitative"}}}'
      );
    }
  };
  checkXY(spec);
  if (Array.isArray(spec.layer)) {
    spec.layer = spec.layer.filter((l) => l && typeof l === "object");
    if (spec.layer.some((l) => !l.mark && !l.layer)) throw new Error('Every item in "layer" needs a "mark".');
  }
  return spec;
}

async function makeChart(args) {
  const { sql, title } = args;
  // Accept the spellings models tend to use for the spec.
  const raw = args.vega_lite ?? args.vegaLite ?? args.spec ?? args.vega_lite_spec ?? args.chart;
  const g = await ghcndPromise;
  const { rows, truncated } = await g.select(sql, CONFIG.maxChartRows);
  if (!rows.length) return { error: "The chart query returned no rows." };
  let spec;
  try {
    spec = normalizeSpec(raw);
  } catch (err) {
    return { error: err.message };
  }
  const columns = Object.keys(rows[0]);
  const fields = [];
  JSON.stringify(spec, (k, v) => {
    if (k === "field" && typeof v === "string") fields.push(v);
    return v;
  });
  // Transforms can create fields, so only check specs without them.
  const hasTransform = JSON.stringify(spec).includes('"transform"');
  const missing = hasTransform ? [] : fields.filter((f) => !columns.includes(f) && !f.includes("."));
  if (missing.length) {
    return { error: `The spec uses field(s) ${missing.join(", ")} but the query returns columns ${columns.join(", ")}.` };
  }
  spec.$schema = "https://vega.github.io/schema/vega-lite/v6.json";
  spec.data = { values: rows };
  if (spec.width === undefined && !spec.facet && !spec.hconcat && !spec.concat && !spec.repeat) spec.width = "container";
  if (spec.height === undefined && !spec.facet && !spec.vconcat && !spec.concat && !spec.repeat) spec.height = 260;
  if (title && !spec.title) spec.title = title;

  vegaPromise ||= Promise.all([
    import("https://cdn.jsdelivr.net/npm/vega-embed@7.3.0/+esm"),
    import("https://cdn.jsdelivr.net/npm/vega-interpreter@2.3.2/+esm"),
  ]);
  const [{ default: embed }, { expressionInterpreter }] = await vegaPromise;
  const plot = el("div", { className: "plot" });
  plot.style.width = "100%";
  const fig = el("figure", { className: "chart" }, plot);
  $("log").append(fig);
  const draw = () => embed(plot, spec, {
    ast: true,
    expr: expressionInterpreter,
    config: chartConfig(),
    actions: { export: true, source: false, compiled: false, editor: false },
  });
  try {
    await draw();
  } catch (err) {
    fig.remove();
    return {
      error: `Vega-Lite could not render the spec: ${err.message}. Simplify it to a single mark with x and y ` +
        `encodings on the query's columns (${columns.join(", ")}), for example ${CHART_EXAMPLE}`,
    };
  }
  charts.push(draw);
  scrollToEnd();
  return { ok: true, rows: rows.length, truncated, note: "The chart is shown to the user." };
}

// ---------------------------------------------------------------------------
// Asking

function handleLumenError(err) {
  if (!(err instanceof LumenError)) return false;
  if (err.status === 401) {
    showBanner("Your Lumen key is no longer valid (it may have been revoked). Connect again.");
    showConnect();
  } else if (err.status === 403 && err.code === "consent_required") {
    showBanner(`${$("model").value} needs your acknowledgment before use. Accept it on Lumen (${CONFIG.lumenBaseUrl}/models), then ask again.`);
  } else if (err.status === 429) {
    showBanner(`Lumen is rate limiting this key. Try again in ${err.retryAfter ?? "a few"} seconds.`);
  } else {
    showBanner(`Lumen returned an error: ${err.message}`);
  }
  return true;
}

function setRunning(on) {
  $("send").hidden = on;
  $("stop").hidden = !on;
  $("prompt").disabled = on;
  for (const b of document.querySelectorAll(".examples button")) b.disabled = on;
}

async function ask(text) {
  text = text.trim();
  const model = $("model").value;
  if (!text || running || !model) return;
  showBanner("");
  addUser(text);
  $("prompt").value = "";
  const before = messages.length;
  messages.push({ role: "user", content: text });
  running = new AbortController();
  setRunning(true);
  try {
    const g = await startData();
    const handlers = {
      find_stations: (a) => g.findStations(a),
      load_series: (a) => g.loadSeries(a),
      load_area: (a) => g.loadArea(a),
      run_sql: (a) => g.runSql(a),
      make_chart: (a) => makeChart(a),
    };
    const answer = await runTurn({ lumen, model, messages, handlers, onStep, signal: running.signal });
    addAnswer(answer);
  } catch (err) {
    // Drop the unfinished turn so the next request is a valid conversation.
    messages.length = before;
    if (running.signal.aborted) addError("Stopped. This question was not kept in the conversation.");
    else if (!handleLumenError(err)) addError(err.message || String(err));
  } finally {
    running = null;
    setRunning(false);
    setStatus("");
    $("prompt").focus();
  }
}

// ---------------------------------------------------------------------------
// Controls

$("connect").addEventListener("click", () => {
  showBanner("");
  lumen.login();
});

$("disconnect").addEventListener("click", () => {
  lumen.logout();
  showBanner("Disconnected. The key still works until you revoke it on your Lumen Profile page.");
  showConnect();
});

$("new-chat").addEventListener("click", () => {
  if (running) running.abort();
  messages = [];
  steps.clear();
  charts.length = 0;
  $("log").replaceChildren(el("p", { className: "fine", textContent: "New conversation. Data you loaded is still available." }));
  $("prompt").focus();
});

$("stop").addEventListener("click", () => running?.abort());

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  ask($("prompt").value);
});

$("prompt").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    ask($("prompt").value);
  }
});

for (const b of document.querySelectorAll(".examples button")) {
  b.addEventListener("click", () => ask(b.textContent));
}

// ---------------------------------------------------------------------------
// Start-up

(async () => {
  try {
    await lumen.handleRedirect();
  } catch (err) {
    showBanner(err.message);
  }
  if (lumen.getKey()) await showApp();
  else showConnect();
})();
