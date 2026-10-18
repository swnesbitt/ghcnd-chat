// app.js — wires Lumen sign-in, the DuckDB session and the agent loop to the page.

import { createLumenClient, LumenError } from "./lumen-oauth.js";
import { CONFIG } from "./config.js";
import { runTurn } from "./agent.js";
import { cleanModelText } from "./format.js";
import { initAlmanac, renderAlmanac, findNearby } from "./almanac.js";
import { initAnnual, renderAnnual } from "./annual.js";
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

// ---------------------------------------------------------------------------
// Diagnostic log: what happened in the current question (tool calls, results,
// errors) plus page-level errors, so a failure can be copied and sent on.
// It never includes the Lumen key or anything else from browser storage.

const logbook = { events: [], turn: null, version: null };
const clipText = (v, max = 4000) => {
  const t = typeof v === "string" ? v : JSON.stringify(v);
  return t && t.length > max ? `${t.slice(0, max)}… [${t.length - max} more characters]` : t;
};
const stamp = () => new Date().toISOString().slice(11, 19);

function logEvent(kind, text) {
  const entry = `[${stamp()}] ${kind}: ${clipText(text)}`;
  (logbook.turn ? logbook.turn.entries : logbook.events).push(entry);
  if (logbook.events.length > 200) logbook.events.splice(0, logbook.events.length - 200);
}

window.addEventListener("error", (e) => logEvent("page error", `${e.message} (${e.filename}:${e.lineno})`));
window.addEventListener("unhandledrejection", (e) => logEvent("unhandled rejection", String(e.reason?.stack || e.reason)));
const consoleError = console.error.bind(console);
console.error = (...args) => {
  logEvent("console", args.map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : clipText(a, 500))).join(" "));
  consoleError(...args);
};

// Which build is live (written by the Pages workflow), fetched up front so
// copying stays synchronous inside the click, as iOS Safari requires.
fetch("version.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((v) => (logbook.version = v)).catch(() => {});

function buildLog() {
  const v = logbook.version;
  const t = logbook.turn;
  const lines = [
    "GHCN-Daily Chat log",
    `Copied: ${new Date().toISOString()} (${new Date().toLocaleString()})`,
    `Page: ${location.origin}${location.pathname}${v ? ` (build ${v.commit}, ${v.built_at})` : ""}`,
    `Lumen: ${CONFIG.lumenBaseUrl}   Model: ${$("model")?.value || "none"}`,
    `Browser: ${navigator.userAgent}`,
  ];
  if (t) {
    lines.push("", `Question (${t.started}): ${t.question}`, "", ...t.entries);
  }
  if (logbook.events.length) lines.push("", "Page events:", ...logbook.events.slice(-60));
  return lines.join("\n");
}

function copyText(text) {
  // Fallback for browsers without the async clipboard API: a selected textarea.
  const legacy = () => {
    const ta = el("textarea", { value: text, readOnly: true });
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
    document.body.append(ta);
    ta.focus();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
    return ok;
  };
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(() => true, () => legacy());
  return Promise.resolve(legacy());
}

function copyLogButton() {
  const wrap = el("div", { className: "copy-log" });
  const btn = el("button", { type: "button", className: "quiet", textContent: "Copy log" });
  btn.addEventListener("click", () => {
    const text = buildLog();
    copyText(text).then((ok) => {
      if (ok) {
        btn.textContent = "Log copied";
        setTimeout(() => (btn.textContent = "Copy log"), 2500);
        return;
      }
      // Could not copy: show the log so it can be selected by hand.
      if (!wrap.querySelector("textarea")) {
        const ta = el("textarea", { className: "log-text", value: text, readOnly: true, rows: 8 });
        ta.setAttribute("aria-label", "Diagnostic log");
        wrap.append(el("p", { className: "fine", textContent: "Copying isn't available here. Select the log below and copy it." }), ta);
        ta.focus();
        ta.select();
      }
    });
  });
  wrap.append(btn);
  return wrap;
}

function showBanner(text, action = null) {
  const b = $("banner");
  b.replaceChildren();
  b.hidden = !text;
  if (!text) return;
  logEvent("banner", text);
  b.append(el("span", { textContent: text }));
  if (action) {
    const btn = el("button", { type: "button", className: "primary", textContent: action.label });
    btn.addEventListener("click", action.run);
    b.append(btn);
  } else {
    b.append(copyLogButton());
  }
}

// Sign in (or renew an expired key) and come back to the same view: Lumen
// returns to the bare page, so the tab and station are restored from here.
const RETURN_KEY = "ghcnd-chat:return-to";
function signIn() {
  try { sessionStorage.setItem(RETURN_KEY, location.search + location.hash); } catch { /* storage unavailable */ }
  showBanner("");
  lumen.login();
}
function restoreReturn() {
  let back = null;
  try {
    back = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
  } catch { /* storage unavailable */ }
  if (back && !location.search.includes("code=")) history.replaceState(null, "", location.pathname + back);
}

// Lumen keys can expire or be revoked; any 401 offers a one-click renewal.
const keyExpired = (err) => err?.status === 401 || /expired|invalid api key|revoked/i.test(err?.message || "");
function offerRenewal() {
  showBanner("Your Lumen key has expired or was revoked. Renew it to keep using the chat and the AI-written summaries.",
    { label: "Renew Lumen key", run: signIn });
}

// The page's CSP blocks any host not listed in connect-src. Say so plainly
// when that host is the configured Lumen server.
document.addEventListener("securitypolicyviolation", (e) => {
  logEvent("blocked by Content-Security-Policy", `${e.violatedDirective} ${e.blockedURI}`);
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
  if (a.kind === "acis-skipped") logEvent("ACIS values skipped as implausible", a.skipped.join("; "));
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
  div.innerHTML = DOMPurify.sanitize(marked.parse(cleanModelText(markdown) || "(no answer)"));
  for (const a of div.querySelectorAll("a")) a.rel = "noopener noreferrer";
  $("log").append(div);
  scrollToEnd();
}

function addError(text) {
  logEvent("error", text);
  $("log").append(el("div", { className: "answer error-block" },
    el("p", { className: "error-text", textContent: text }), copyLogButton()));
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
    case "load_records": return `Loaded records ${areaLabel(args)}`.trim();
    case "get_forecast": return `Got the NWS forecast for ${args.station || args.place || `${args.lat}, ${args.lon}`}`;
    case "run_sql": return "Ran a query";
    case "make_chart": return args.title ? `Drew a chart: ${args.title}` : "Drew a chart";
    default: return `Called ${name}`;
  }
}

const steps = new Map();

function onStep(s) {
  if (s.type === "thinking") setStatus("Thinking");
  if (s.type === "tool_start") {
    logEvent(`call ${s.name}`, s.args);
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
    logEvent(failed ? `${s.name} failed` : `${s.name} result`, failed ? s.result.error : s.result);
    if (failed) {
      details.classList.add("failed");
      details.querySelector("summary").textContent += " (failed)";
    }
    const call = s.name === "run_sql" ? s.args?.query
      : s.name === "make_chart"
        ? `${s.args?.sql ?? ""}\n\n${JSON.stringify({ vega_lite: s.args?.vega_lite ?? s.args?.spec, basemap: s.args?.basemap }, null, 2)}`
      : JSON.stringify(s.args, null, 2);
    const result = JSON.stringify(s.result, null, 2);
    details.append(
      el("pre", { textContent: call || "" }),
      el("pre", { textContent: result.length > 6000 ? result.slice(0, 6000) + "\n…" : result })
    );
    if (failed) details.append(copyLogButton());
    setStatus("Thinking");
  }
}

// ---------------------------------------------------------------------------
// Charts (Vega-Lite, loaded on first use; the interpreter avoids eval under the CSP)

let vegaPromise = null;
const charts = []; // redraw functions, so charts follow a light/dark switch
const nodeCharts = new Map(); // almanac and annual charts: the latest draw for each figure

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  for (const draw of [...charts, ...nodeCharts.values()]) draw().catch(() => {});
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

// ---------------------------------------------------------------------------
// Maps: US state and county outlines (us-atlas TopoJSON, Census 1:10m) drawn
// under the model's station layer, optionally colored by a query column.

const STATE_FIPS = {
  AL: "01", AK: "02", AZ: "04", AR: "05", CA: "06", CO: "08", CT: "09", DE: "10", DC: "11", FL: "12",
  GA: "13", HI: "15", ID: "16", IL: "17", IN: "18", IA: "19", KS: "20", KY: "21", LA: "22", ME: "23",
  MD: "24", MA: "25", MI: "26", MN: "27", MS: "28", MO: "29", MT: "30", NE: "31", NV: "32", NH: "33",
  NJ: "34", NM: "35", NY: "36", NC: "37", ND: "38", OH: "39", OK: "40", OR: "41", PA: "42", RI: "44",
  SC: "45", SD: "46", TN: "47", TX: "48", UT: "49", VT: "50", VA: "51", WA: "53", WV: "54", WI: "55",
  WY: "56", PR: "72",
};

const MAP_POINTS_EXAMPLE =
  '{"mark": "circle", "encoding": {"longitude": {"field": "lon", "type": "quantitative"}, ' +
  '"latitude": {"field": "lat", "type": "quantitative"}, "color": {"field": "tmax_f", "type": "quantitative"}}}';

let atlasPromise = null;
function loadAtlas() {
  atlasPromise ||= fetch(new URL(CONFIG.atlasUrl, location.href)).then((r) => {
    if (!r.ok) throw new Error(`Map outlines not found (${r.status}).`);
    return r.json();
  });
  atlasPromise.catch(() => (atlasPromise = null));
  return atlasPromise;
}

async function buildMap(spec, rows, basemap) {
  const level = String(basemap.level || "states").toLowerCase().startsWith("count") ? "counties" : "states";
  const st = basemap.state ? String(basemap.state).trim().toUpperCase() : null;
  if (st && !STATE_FIPS[st]) throw new Error(`Maps cover US states, DC and PR; "${basemap.state}" is not one of them.`);
  const topo = await loadAtlas();
  const css = getComputedStyle(document.documentElement);
  const outline = (filterExtra) => {
    const layer = {
      data: { values: topo, format: { type: "topojson", feature: level } },
      mark: { type: "geoshape", fill: css.getPropertyValue("--code-bg").trim(), stroke: "#8e9090", strokeWidth: level === "counties" ? 0.35 : 0.8 },
      transform: [],
    };
    if (st) {
      layer.transform.push({
        filter: level === "states" ? `datum.id == '${STATE_FIPS[st]}'` : `substring(datum.id, 0, 2) == '${STATE_FIPS[st]}'`,
      });
    }
    if (filterExtra) layer.transform.push(...filterExtra);
    return layer;
  };
  const layers = [outline()];

  // Choropleth: join query rows to shapes by county_fips (counties) or state (states).
  const color = basemap.color_by;
  if (color?.field) {
    if (!(color.field in rows[0])) throw new Error(`color_by.field "${color.field}" is not one of the query's columns (${Object.keys(rows[0]).join(", ")}).`);
    const keyed = rows
      .map((r) => ({
        ...r,
        _geo_id: level === "counties"
          ? (r.county_fips != null ? String(r.county_fips).padStart(5, "0") : null)
          : STATE_FIPS[String(r.state ?? "").toUpperCase()] ?? null,
      }))
      .filter((r) => r._geo_id);
    if (!keyed.length) {
      throw new Error(level === "counties"
        ? "To color counties, the query must return county_fips (from stations) and the value column, one row per county."
        : "To color states, the query must return state (postal code, from stations) and the value column, one row per state.");
    }
    const fill = outline([{ lookup: "id", from: { data: { values: keyed }, key: "_geo_id", fields: [color.field] } },
      { filter: `isValid(datum['${color.field}'])` }]);
    delete fill.mark.fill;
    fill.encoding = {
      color: { field: color.field, type: "quantitative", title: color.title ?? color.field, scale: { scheme: color.scheme ?? "blues" } },
      tooltip: [{ field: "properties.name", title: level === "counties" ? "County" : "State" }, { field: color.field, type: "quantitative" }],
    };
    layers.push(fill);
  }

  // The model's layers (station points), which must place marks by longitude/latitude.
  if (spec) {
    const own = spec.layer
      ? spec.layer.map((l) => ({ ...l, encoding: { ...(spec.encoding || {}), ...(l.encoding || {}) }, transform: l.transform ?? spec.transform }))
      : [{ mark: spec.mark, encoding: spec.encoding, transform: spec.transform, params: spec.params }];
    for (const l of own) {
      const enc = l.encoding || {};
      // Models often put lon/lat on x/y; move them to the geographic channels.
      if (!enc.longitude && /lon/i.test(enc.x?.field || "")) { enc.longitude = enc.x; delete enc.x; }
      if (!enc.latitude && /lat/i.test(enc.y?.field || "")) { enc.latitude = enc.y; delete enc.y; }
      if (!enc.longitude || !enc.latitude) {
        throw new Error(`On a map, every layer needs longitude and latitude encodings. Example: ${MAP_POINTS_EXAMPLE}`);
      }
      for (const ch of ["longitude", "latitude"]) enc[ch] = { type: "quantitative", ...enc[ch] };
      // Readable defaults on a gray basemap: larger dots with a white edge, and
      // a full-range color scale rather than pale blues.
      const markType = typeof l.mark === "string" ? l.mark : l.mark?.type;
      if (["circle", "point", "square"].includes(markType)) {
        l.mark = { size: 70, stroke: "#ffffff", strokeWidth: 0.7, opacity: 1, ...(typeof l.mark === "object" ? l.mark : {}), type: markType };
      }
      if (enc.color && enc.color.type !== "nominal" && !enc.color.scale?.scheme) {
        enc.color = { ...enc.color, scale: { ...(enc.color.scale || {}), scheme: "viridis" } };
      }
      l.encoding = enc;
      for (const k of Object.keys(l)) if (l[k] === undefined) delete l[k];
      layers.push(l);
    }
  }

  return {
    title: spec?.title,
    width: "container",
    height: st ? 480 : 400,
    projection: spec?.projection ?? { type: st ? "mercator" : "albersUsa" },
    data: { values: rows },
    layer: layers,
    resolve: { scale: { color: "independent" }, legend: { color: "independent" } },
  };
}

// Sensible time and temperature axes, decided from the rows themselves:
// ISO date strings become a UTC time axis (a quantitative one cannot read
// them, and local time would shift dates by a day); year columns get plain
// labels (1990, not 1,990) and no forced zero (otherwise a scatter of years
// starts at year 0); temperature columns on point and line marks drop the
// forced zero too. Anything the spec sets explicitly is left alone.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;
const TIME_NAME = /(^|_)(year|yr|yyyy|season|decade)s?$/i;
const TEMP_NAME = /(tmax|tmin|tavg|temp|_f$|_c$|deg_?[fc]$|high|low|dewpoint)/i;
const NO_ZERO_MARKS = new Set(["point", "circle", "square", "tick", "line", "trail", "rule", "text"]);

function fixAxes(spec, rows) {
  const sample = rows.slice(0, 200);
  const values = (field) => sample.map((r) => r[field]).filter((v) => v !== null && v !== undefined);
  const walk = (node, inherited = {}, inheritedMark) => {
    if (!node || typeof node !== "object") return;
    const mark = node.mark ?? inheritedMark ?? (Array.isArray(node.layer) ? node.layer.find((l) => l?.mark)?.mark : undefined);
    const markType = typeof mark === "string" ? mark : mark?.type;
    if (node.encoding) {
      for (const ch of ["x", "y", "x2", "y2"]) {
        const enc = node.encoding[ch];
        if (!enc?.field || enc.aggregate || enc.bin) continue;
        const v = values(enc.field);
        if (!v.length) continue;
        const free = !enc.type || enc.type === "quantitative" || enc.type === "temporal";
        if (free && v.every((x) => typeof x === "string" && ISO_DATE.test(x))) {
          enc.type = "temporal";
          enc.scale = { type: "utc", ...(enc.scale || {}) };
          if (enc.axis !== null) enc.axis = { format: "%b %-d, %Y", ...(enc.axis || {}) };
          continue;
        }
        const numeric = v.every((x) => typeof x === "number");
        if (!numeric || !(enc.type === "quantitative" || !enc.type)) continue;
        if (TIME_NAME.test(enc.field) || v.every((x) => Number.isInteger(x) && x >= 1700 && x <= 2100) && /year|yr/i.test(enc.field)) {
          enc.type = "quantitative";
          enc.scale = { zero: false, ...(enc.scale || {}) };
          if (enc.axis !== null) enc.axis = { format: "d", ...(enc.axis || {}) };
        } else if (TEMP_NAME.test(enc.field) && NO_ZERO_MARKS.has(markType)) {
          enc.scale = { zero: false, ...(enc.scale || {}) };
        }
      }
    }
    for (const k of ["layer", "concat", "hconcat", "vconcat"]) {
      if (Array.isArray(node[k])) node[k].forEach((l) => walk(l, { ...inherited, ...(node.encoding || {}) }, mark));
    }
    if (node.spec) walk(node.spec, node.encoding, mark);
  };
  walk(spec);
}

async function makeChart(args) {
  const { sql, title } = args;
  // Accept the spellings models tend to use for the spec.
  let raw = args.vega_lite ?? args.vegaLite ?? args.spec ?? args.vega_lite_spec ?? args.chart;
  const basemap = args.basemap && typeof args.basemap === "object" ? args.basemap
    : typeof args.basemap === "string" ? { level: args.basemap } : null;
  const g = await ghcndPromise;
  const { rows, truncated } = await g.select(sql, CONFIG.maxChartRows);
  if (!rows.length) return { error: "The chart query returned no rows." };
  let spec = null;
  try {
    if (basemap && typeof raw === "string") raw = JSON.parse(raw);
    const emptySpec = !raw || (typeof raw === "object" && !Object.keys(raw).length);
    if (basemap && raw && typeof raw === "object" && !raw.mark && !raw.layer && raw.encoding) raw.mark = "circle";
    if (!(basemap && emptySpec)) spec = normalizeSpec(raw);
  } catch (err) {
    return { error: err.message };
  }
  if (!spec && !basemap?.color_by) {
    return { error: `Give a station layer or basemap.color_by. Station layer example: ${MAP_POINTS_EXAMPLE}` };
  }
  const columns = Object.keys(rows[0]);
  const fields = [];
  JSON.stringify(spec ?? {}, (k, v) => {
    if (k === "field" && typeof v === "string") fields.push(v);
    return v;
  });
  // Transforms can create fields, so only check specs without them.
  const hasTransform = JSON.stringify(spec ?? {}).includes('"transform"');
  const missing = hasTransform ? [] : fields.filter((f) => !columns.includes(f) && !f.includes("."));
  if (missing.length) {
    return { error: `The spec uses field(s) ${missing.join(", ")} but the query returns columns ${columns.join(", ")}.` };
  }
  if (spec && !basemap) fixAxes(spec, rows);
  if (basemap) {
    try {
      spec = await buildMap(spec, rows, basemap);
    } catch (err) {
      return { error: err.message };
    }
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

// Shared chart drawing for the almanac and annual pages (same libraries and
// theme as make_chart). onView(view) runs after every draw, for listeners.
const nodeViews = new Map();
async function embedChart(node, spec, onView = null) {
  vegaPromise ||= Promise.all([
    import("https://cdn.jsdelivr.net/npm/vega-embed@7.3.0/+esm"),
    import("https://cdn.jsdelivr.net/npm/vega-interpreter@2.3.2/+esm"),
  ]);
  const [{ default: embed }, { expressionInterpreter }] = await vegaPromise;
  const full = { $schema: "https://vega.github.io/schema/vega-lite/v6.json", ...spec };
  const draw = async () => {
    nodeViews.get(node)?.finalize();
    const result = await embed(node, full, {
      ast: true,
      expr: expressionInterpreter,
      config: chartConfig(),
      actions: { export: true, source: false, compiled: false, editor: false },
    });
    nodeViews.set(node, result);
    if (onView) onView(result.view);
    return result;
  };
  await draw();
  for (const n of nodeCharts.keys()) if (!n.isConnected) { nodeCharts.delete(n); nodeViews.get(n)?.finalize(); nodeViews.delete(n); }
  nodeCharts.set(node, draw);
}

// ---------------------------------------------------------------------------
// Asking

function handleLumenError(err) {
  if (!(err instanceof LumenError)) return false;
  if (keyExpired(err)) {
    lumen.logout();
    offerRenewal();
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
  logbook.turn = { question: text, started: new Date().toISOString(), entries: [] };
  running = new AbortController();
  setRunning(true);
  try {
    const g = await startData();
    const handlers = {
      find_stations: (a) => g.findStations(a),
      load_series: (a) => g.loadSeries(a),
      load_area: (a) => g.loadArea(a),
      load_records: (a) => g.loadRecords(a),
      get_forecast: (a) => g.getForecast(a),
      run_sql: (a) => g.runSql(a),
      make_chart: (a) => makeChart(a),
    };
    const answer = await runTurn({ lumen, model, messages, handlers, onStep, signal: running.signal });
    logEvent("answer", answer);
    addAnswer(answer);
  } catch (err) {
    // Drop the unfinished turn so the next request is a valid conversation.
    messages.length = before;
    logEvent("turn failed", err?.stack || err?.message || String(err));
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

$("connect").addEventListener("click", signIn);

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
// Tabs: GHCN chat, Daily almanac and Annual climate

const TABS = ["chat", "almanac", "annual"];

function selectTab(name, { focus = false } = {}) {
  for (const t of TABS) {
    const tab = $(`tab-${t}`);
    const on = t === name;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
    $(`panel-${t}`).hidden = !on;
    if (on && focus) tab.focus();
  }
  if (name === "chat" && location.search) history.replaceState(null, "", location.pathname + location.hash);
  const params = new URLSearchParams(location.search);
  if ((name === "almanac" && params.has("annual")) || (name === "annual" && ["station", "place", "id"].some((k) => params.has(k)))) {
    history.replaceState(null, "", location.pathname);
  }
  if (name === "annual" && !location.search.includes("annual=") && location.hash !== "#annual") history.replaceState(null, "", `${location.pathname}#annual`);
}

for (const t of TABS) {
  $(`tab-${t}`).addEventListener("click", () => selectTab(t));
  $(`tab-${t}`).addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const i = TABS.indexOf(t);
    selectTab(TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length], { focus: true });
  });
}

initAlmanac({
  startData,
  lumen,
  getModel: () => $("model").value || CONFIG.preferredModel,
  embedChart,
  renderMarkdown: (t) => DOMPurify.sanitize(marked.parse(cleanModelText(t))),
  logEvent,
  onLumenError: (err) => {
    if (keyExpired(err)) {
      lumen.logout();
      offerRenewal();
      showConnect();
    }
  },
});

let almanacRunning = false;
async function showAlmanac(query, asOf = null) {
  if (almanacRunning || !query.trim()) return;
  almanacRunning = true;
  const out = $("alm-out");
  const setAlmStatus = (t) => ($("alm-status").textContent = t);
  logbook.turn = { question: `Almanac for ${query}`, started: new Date().toISOString(), entries: [] };
  $("alm-form").querySelector("button").disabled = true;
  try {
    const r = await renderAlmanac(out, query, { onStatus: setAlmStatus, asOf });
    const station = r.station;
    // For the daily email sender (scripts/send_almanac.py), which reads the page.
    window.almanacResult = { station: { id: station.id, name: station.name, state: station.state }, headline: r.headline, asOf: r.asOf };
    history.replaceState(null, "", `${location.pathname}?station=${station.id}${r.asOf ? `&date=${r.asOf}` : ""}`);
    document.title = `${station.name} almanac | GHCN-Daily Chat`;
  } catch (err) {
    setAlmStatus("");
    logEvent("almanac failed", err?.stack || err?.message || String(err));
    out.replaceChildren(el("div", { className: "error-block" },
      el("p", { className: "error-text", textContent: err.message || String(err) }), copyLogButton()));
  } finally {
    almanacRunning = false;
    $("alm-form").querySelector("button").disabled = false;
  }
}

// A place name lists the nearest stations (3 at first, "More stations" for
// the rest) and starts the almanac on the best long-record one; picking
// another station in the list switches to it. A station ID skips the list.
const STATION_ID = /^[A-Z0-9]{11}$/i;

function renderChoices(near, selected, { box = $("alm-choices"), busy = () => almanacRunning, pick = (id) => showAlmanac(id), what = "The almanac" } = {}) {
  const us = near.place?.country === "US" || near.stations[0]?.country === "US";
  const dist = (km) => (us ? `${(km * 0.6214).toFixed(km < 16 ? 1 : 0)} mi` : `${km.toFixed(km < 10 ? 1 : 0)} km`);
  const span = (c, name) => (c ? `${name} ${c.first}–${c.last}` : null);
  // The recommended station first, then the rest by distance.
  const rec = near.stations.find((st) => st.id === near.recommended);
  const all = [rec, ...near.stations.filter((st) => st.id !== near.recommended)].filter(Boolean);
  const thisYear = new Date().getFullYear();
  const lastYear = (st) => Math.max(0, ...Object.values(st.cov).map((c) => c.last || 0));
  const retired = (st) => lastYear(st) < thisYear - 1;
  // "Hide stations no longer reporting", remembered in this browser (on by default).
  const hideBox = el("input", { type: "checkbox", checked: store.get("hide-retired-stations") !== "0" });
  // "Only stations with 30+ years of data" (temperature or precipitation) that
  // are still reporting, off by default.
  const years = (st) => Math.max(0, ...["TMAX", "PRCP"].map((e) => (st.cov[e] ? st.cov[e].last - st.cov[e].first + 1 : 0)));
  const longBox = el("input", { type: "checkbox", checked: store.get("long-record-stations") === "1" });
  let ordered = [];
  let shown = 4;
  const list = el("ol", { className: "alm-stations" });
  const more = el("button", { type: "button", className: "quiet", textContent: "More stations" });
  const count = el("span", { className: "fine" });
  const filter = () => {
    const keep = (st) => st.id === selected || st.id === near.recommended;
    ordered = all.filter((st) => keep(st) || ((!hideBox.checked || !retired(st)) && (!longBox.checked || (years(st) >= 30 && !retired(st)))));
    const hidden = all.length - ordered.length;
    count.textContent = hidden ? `${hidden} hidden` : "";
  };
  hideBox.addEventListener("change", () => {
    store.set("hide-retired-stations", hideBox.checked ? "1" : "0");
    filter();
    draw();
  });
  longBox.addEventListener("change", () => {
    store.set("long-record-stations", longBox.checked ? "1" : "0");
    filter();
    draw();
  });
  const draw = () => {
    shown = Math.min(Math.max(shown, 4), ordered.length);
    list.replaceChildren(...ordered.slice(0, shown).map((st) => {
      const isSel = st.id === selected;
      const last = lastYear(st);
      const cov = ([span(st.cov.TMAX, "Temperature"), span(st.cov.PRCP, "Precipitation"), span(st.cov.SNOW, "Snow")].filter(Boolean).join(", ") || "No temperature or precipitation record")
        + (last && last < thisYear - 1 ? " (no longer reporting)" : "");
      const btn = el("button", { type: "button", className: "alm-station" },
        el("span", { className: "alm-st-name", textContent: `${st.name}${st.state ? `, ${st.state}` : ""}` }),
        el("span", { className: "alm-st-meta", textContent: `${st.id}, ${dist(st.distance_km)} away` }),
        el("span", { className: "alm-st-cov", textContent: cov }),
        isSel ? el("span", { className: "alm-st-sel", textContent: st.id === near.recommended ? (near.named ? "Selected: the station you named" : "Selected: the nearest long, current record") : "Selected" }) : st.id === near.recommended ? el("span", { className: "alm-st-meta", textContent: near.named ? "The station you named" : "Recommended: the nearest long, current record" }) : null);
      if (isSel) btn.setAttribute("aria-current", "true");
      btn.addEventListener("click", () => {
        if (busy() || st.id === selected) return;
        selected = st.id;
        filter();
        draw();
        pick(st.id);
      });
      return el("li", {}, btn);
    }));
    more.hidden = shown >= ordered.length;
  };
  more.addEventListener("click", () => {
    shown = Math.min(shown + 7, ordered.length);
    draw();
    list.children[Math.min(shown - 7, list.children.length - 1)]?.querySelector("button")?.focus();
  });
  filter();
  draw();
  const placeName = near.place ? `${near.place.name}, ${near.place.country === "US" ? near.place.admin1 : near.place.country}` : "here";
  box.replaceChildren(el("h2", { id: `${box.id}-h`, textContent: `Stations near ${placeName}` }),
    el("p", { className: "fine", textContent: near.named ? `${what} shows the station you named. Pick another to switch.` : `${what} uses the nearest station with a long, current temperature and precipitation record. Pick another to switch.` }),
    el("div", { className: "alm-filters" },
      el("label", { className: "alm-hide" }, hideBox, " Hide stations no longer reporting"),
      el("label", { className: "alm-hide" }, longBox, " Only current stations with 30+ years of data"), count),
    list, more);
  box.hidden = false;
}

async function startAlmanac(query, asOf = null) {
  const q = String(query || "").trim();
  if (!q || almanacRunning) return;
  if (STATION_ID.test(q)) {
    $("alm-choices").hidden = true;
    return showAlmanac(q.toUpperCase(), asOf);
  }
  $("alm-status").textContent = "Finding stations";
  try {
    const near = await findNearby(q);
    renderChoices(near, near.recommended);
    return showAlmanac(near.recommended, asOf);
  } catch (err) {
    $("alm-status").textContent = "";
    $("alm-choices").hidden = true;
    logEvent("almanac failed", err?.message || String(err));
    $("alm-out").replaceChildren(el("div", { className: "error-block" },
      el("p", { className: "error-text", textContent: err.message || String(err) }), copyLogButton()));
  }
}

$("alm-form").addEventListener("submit", (e) => {
  e.preventDefault();
  startAlmanac($("alm-input").value);
});

// ---------------------------------------------------------------------------
// Annual climate

initAnnual({
  startData,
  lumen,
  getModel: () => $("model").value || CONFIG.preferredModel,
  embedChart,
  renderMarkdown: (t) => DOMPurify.sanitize(marked.parse(cleanModelText(t))),
  logEvent,
  onLumenError: (err) => {
    if (keyExpired(err)) {
      lumen.logout();
      offerRenewal();
      showConnect();
    }
  },
});

let annualRunning = false;
async function showAnnual(query, year = null) {
  if (annualRunning || !query.trim()) return;
  annualRunning = true;
  const out = $("ann-out");
  const setStatus = (t) => ($("ann-status").textContent = t);
  logbook.turn = { question: `Annual climate for ${query}`, started: new Date().toISOString(), entries: [] };
  $("ann-form").querySelector("button").disabled = true;
  try {
    let id = null;
    const r = await renderAnnual(out, query, {
      onStatus: setStatus, year,
      onYear: (s) => {
        if (id) history.replaceState(null, "", `${location.pathname}?annual=${id}&year=${s.tYear ?? s.pYear}`);
      },
    });
    id = r.station.id;
    history.replaceState(null, "", `${location.pathname}?annual=${id}${year ? `&year=${r.state.tYear ?? r.state.pYear}` : ""}`);
    document.title = `${r.station.name} annual climate | GHCN-Daily Chat`;
  } catch (err) {
    setStatus("");
    logEvent("annual failed", err?.stack || err?.message || String(err));
    out.replaceChildren(el("div", { className: "error-block" },
      el("p", { className: "error-text", textContent: err.message || String(err) }), copyLogButton()));
  } finally {
    annualRunning = false;
    $("ann-form").querySelector("button").disabled = false;
  }
}

async function startAnnual(query, year = null) {
  const q = String(query || "").trim();
  if (!q || annualRunning) return;
  if (STATION_ID.test(q)) {
    $("ann-choices").hidden = true;
    return showAnnual(q.toUpperCase(), year);
  }
  $("ann-status").textContent = "Finding stations";
  try {
    const near = await findNearby(q);
    renderChoices(near, near.recommended, { box: $("ann-choices"), busy: () => annualRunning, pick: (id) => showAnnual(id), what: "This page" });
    return showAnnual(near.recommended, year);
  } catch (err) {
    $("ann-status").textContent = "";
    $("ann-choices").hidden = true;
    logEvent("annual failed", err?.message || String(err));
    $("ann-out").replaceChildren(el("div", { className: "error-block" },
      el("p", { className: "error-text", textContent: err.message || String(err) }), copyLogButton()));
  }
}

$("ann-form").addEventListener("submit", (e) => {
  e.preventDefault();
  startAnnual($("ann-input").value);
});

// ?annual=USC00118740 (or a place), with &year=2012, opens the annual page directly.
function annualFromUrl() {
  const p = new URLSearchParams(location.search);
  const q = p.get("annual");
  if (!q && location.hash !== "#annual") return false;
  selectTab("annual");
  if (q) {
    $("ann-input").value = q;
    startAnnual(q, p.get("year") ? Number(p.get("year")) : null);
  }
  return true;
}

// ?station=USC00118740, ?id=..., or ?place=Champaign, IL open the almanac directly.
function almanacFromUrl() {
  const p = new URLSearchParams(location.search);
  const q = p.get("station") || p.get("id") || p.get("place");
  if (!q && location.hash !== "#almanac") return false;
  selectTab("almanac");
  if (q) {
    $("alm-input").value = q;
    startAlmanac(q, p.get("date"));
  }
  return true;
}

// ---------------------------------------------------------------------------
// Start-up

(async () => {
  try {
    await lumen.handleRedirect();
  } catch (err) {
    showBanner(err.message);
  }
  restoreReturn();
  if (!annualFromUrl()) almanacFromUrl();
  if (lumen.getKey()) await showApp();
  else showConnect();
})();
