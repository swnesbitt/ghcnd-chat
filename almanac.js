// almanac.js — "Climate at a glance": an almanac page for one GHCN-Daily station.
//
// Everything numeric is computed here, deterministically, from the station's
// full GHCN-Daily record, NOAA's 1991-2020 normals (NCEI; computed from the
// station's own 1991-2020 data where NCEI has none) and the NWS forecast. The
// model only writes the text in the blue boxes, from a compact summary of
// those numbers; without a Lumen key the boxes get plain templated text.

const NORMALS_DAILY = "https://www.ncei.noaa.gov/data/normals-daily/1991-2020/access/";
const NORMALS_ANNUAL = "https://www.ncei.noaa.gov/data/normals-annualseasonal/1991-2020/access/";
const STATION_RE = /^[A-Z0-9]{11}$/;
const COLORS = {
  warm: "#c84113", cool: "#1d58a7", warmLight: "#e8a48c", coolLight: "#98afd2",
  normal: "#707372", precip: "#009fd4", precipLight: "#8dd1eb", ink: "#13294b",
};

let deps = null;
export function initAlmanac(d) {
  deps = d;
}

// ---------------------------------------------------------------------------
// Small helpers

const h = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "className") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return node;
};
const sq = (s) => `'${String(s).replace(/'/g, "''")}'`;
const addDays = (s, n) => new Date(Date.parse(`${s}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const todayLocal = () => new Date().toLocaleDateString("en-CA");
const fmtDay = (s, opts = { weekday: "short", month: "short", day: "numeric" }) =>
  new Date(`${s}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", ...opts });
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const round = (v, d = 0) => (isNum(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const md = (s) => s.slice(5); // "2026-10-17" -> "10-17"

function unitsFor(country) {
  if (country === "US") {
    return {
      us: true, t: "°F", p: "in", s: "in",
      temp: (c) => (isNum(c) ? c * 9 / 5 + 32 : null), precip: (mm) => (isNum(mm) ? mm / 25.4 : null), snow: (mm) => (isNum(mm) ? mm / 25.4 : null),
      tSql: "value * 9 / 5 + 32", pSql: "value / 25.4", sSql: "value / 25.4",
      wet: 0.01, dd: 65, gddBase: 50, gddCap: 86, near: 2, pd: 2, sd: 1,
      frost: [{ label: "Frost (36°F)", thr: 36, key: "T36" }, { label: "Freeze (32°F)", thr: 32, key: "T32" }, { label: "Hard freeze (28°F)", thr: 28, key: "T28" }],
    };
  }
  return {
    us: false, t: "°C", p: "mm", s: "cm",
    temp: (c) => (isNum(c) ? c : null), precip: (mm) => (isNum(mm) ? mm : null), snow: (mm) => (isNum(mm) ? mm / 10 : null),
    tSql: "value", pSql: "value", sSql: "value / 10",
    wet: 0.25, dd: 18, gddBase: 10, gddCap: 30, near: 1, pd: 1, sd: 1,
    frost: [{ label: "Frost (2°C)", thr: 2 }, { label: "Freeze (0°C)", thr: 0 }, { label: "Hard freeze (−2°C)", thr: -2 }],
  };
}

function formatters(U) {
  const t = (v) => (isNum(v) ? `${Math.round(v)}${U.t}` : "–");
  const dep = (v, d = 0) => (isNum(v) ? `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v).toFixed(d)}°` : "");
  const p = (v) => (isNum(v) ? (v === 0 ? `0 ${U.p}` : `${v.toFixed(U.pd)} ${U.p}`) : "–");
  const s = (v) => (isNum(v) ? (v === 0 ? `0 ${U.s}` : `${v.toFixed(U.sd)} ${U.s}`) : "–");
  return { t, dep, p, s };
}

// Minimal CSV parser for NCEI files (quoted fields, no embedded newlines).
function parseCsv(text) {
  const split = (line) => {
    const out = [];
    let cur = "";
    let q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === "," && !q) {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out.map((x) => x.trim());
  };
  const lines = text.trim().split(/\r?\n/);
  const head = split(lines[0]);
  return lines.slice(1).map((l) => {
    const v = split(l);
    return Object.fromEntries(head.map((k, i) => [k, v[i]]));
  });
}
// NCEI codes: -7777 rounds to zero (trace); -9999, -8888, -6666, -5555, -4444 are missing or not applicable.
const ncei = (s) => {
  if (s === undefined || s === "") return null;
  const v = Number(s);
  if (!Number.isFinite(v)) return null;
  if (v === -7777) return 0;
  return v <= -4444 ? null : v;
};

// The 366 month-days of a leap year, in order.
const MONTH_DAYS = Array.from({ length: 366 }, (_, i) => new Date(Date.UTC(2000, 0, 1 + i)).toISOString().slice(5, 10));

// ---------------------------------------------------------------------------
// Station

const parseCoverage = (text) => Object.fromEntries((text || "").split(", ").filter(Boolean).map((c) => {
  const [el, span] = c.split(" ");
  const [first, last] = (span || "").split("-").map(Number);
  return [el, { first, last }];
}));

// Stations near a place, closest first, with periods of record, and the one the
// almanac should use: the nearest with a long, current temperature and
// precipitation record.
export async function findNearby(input) {
  const g = await deps.startData();
  const text = String(input || "").trim();
  const thisYear = new Date().getFullYear();
  let r = null;
  for (const radius of [60, 150, 300]) {
    r = await g.findStations({ place: text, radius_km: radius, limit: 50 });
    if ((r.stations || []).length >= 5) break;
  }
  const stations = (r.stations || []).map((st) => ({ ...st, cov: parseCoverage(st.coverage) }));
  if (!stations.length) throw new Error(`No GHCN-Daily stations within 300 km of ${text}.`);
  const isGood = (st) => st.cov.TMAX?.last >= thisYear - 1 && st.cov.PRCP?.last >= thisYear - 1 && st.cov.TMAX.first <= 1995;
  const recommended = stations.find(isGood) || stations.find((st) => st.cov.TMAX?.last >= thisYear - 1) || stations[0];
  return { place: r.place, stations, recommended: recommended.id };
}

async function resolveStation(g, input) {
  const text = String(input || "").trim();
  if (!text) throw new Error("Enter a station name, a place (e.g., Champaign, IL) or a GHCN-Daily ID.");
  const id = STATION_RE.test(text.toUpperCase()) ? text.toUpperCase() : (await findNearby(text)).recommended;
  const row = (await g.sql(`SELECT * FROM stations WHERE id = ${sq(id)}`))[0];
  if (!row) throw new Error(`${id} is not a GHCN-Daily station ID.`);
  return row;
}

// ---------------------------------------------------------------------------
// Normals: NCEI 1991-2020 where available, else computed from the station.

async function fetchText(url) {
  try {
    const r = await fetch(url);
    return r.ok ? r.text() : null;
  } catch {
    return null;
  }
}

async function officialNormals(id) {
  const [daily, annual] = await Promise.all([fetchText(`${NORMALS_DAILY}${id}.csv`), fetchText(`${NORMALS_ANNUAL}${id}.csv`)]);
  if (!daily) return null;
  const rows = parseCsv(daily);
  const byMd = new Map(rows.map((r) => [r.DATE, r]));
  const out = [];
  let prevP = 0;
  let prevS = 0;
  for (const mdKey of MONTH_DAYS) {
    const r = byMd.get(mdKey) || {};
    const ytdP = ncei(r["YTD-PRCP-NORMAL"]);
    const ytdS = ncei(r["YTD-SNOW-NORMAL"]);
    const first = mdKey === "01-01";
    out.push({
      md: mdKey,
      tmax: ncei(r["DLY-TMAX-NORMAL"]), tmin: ncei(r["DLY-TMIN-NORMAL"]),
      prcp: ytdP === null ? null : Math.max(0, first ? ytdP : ytdP - prevP),
      snow: ytdS === null ? null : Math.max(0, first ? ytdS : ytdS - prevS),
      pct_wet: isNum(ncei(r["DLY-PRCP-PCTALL-GE001HI"])) ? ncei(r["DLY-PRCP-PCTALL-GE001HI"]) / 100 : null,
      gdd: ncei(r["DLY-GRDD-TB5086"]), hdd: ncei(r["DLY-HTDD-NORMAL"]), cdd: ncei(r["DLY-CLDD-NORMAL"]),
    });
    if (ytdP !== null) prevP = ytdP;
    if (ytdS !== null) prevS = ytdS;
  }
  const frost = {};
  if (annual) {
    const a = parseCsv(annual)[0] || {};
    for (const thr of ["T36", "T32", "T28"]) {
      for (const kind of ["PRBFST", "PRBLST"]) {
        for (const p of ["10", "50", "90"]) {
          const v = (a[`ANN-TMIN-${kind}-${thr}FP${p}`] || "").trim();
          if (/^\d\d\/\d\d$/.test(v)) frost[`${kind}-${thr}-${p}`] = v.replace("/", "-");
        }
      }
    }
  }
  return { days: out, frost };
}

async function computedNormals(g, U) {
  const rows = await g.sql(`
    SELECT strftime(date, '%m-%d') AS md,
           avg(tmax) AS tmax, avg(tmin) AS tmin, avg(prcp) AS prcp, avg(snow) AS snow,
           avg(CASE WHEN prcp IS NULL THEN NULL WHEN prcp >= ${U.wet} THEN 1 ELSE 0 END) AS pct_wet,
           avg(gdd) AS gdd, avg(hdd) AS hdd, avg(cdd) AS cdd,
           count(DISTINCT year(date)) FILTER (WHERE tmax IS NOT NULL AND tmin IS NOT NULL) AS ny_t,
           count(DISTINCT year(date)) FILTER (WHERE prcp IS NOT NULL) AS ny_p,
           count(DISTINCT year(date)) FILTER (WHERE snow IS NOT NULL) AS ny_s
    FROM alm_daily WHERE year(date) BETWEEN 1991 AND 2020 GROUP BY 1`);
  const byMd = new Map(rows.map((r) => [r.md, r]));
  const raw = MONTH_DAYS.map((m) => byMd.get(m) || { md: m });
  const median = (k) => {
    const v = raw.map((r) => r[k]).filter(isNum).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : 0;
  };
  const enough = { t: median("ny_t") >= 20, p: median("ny_p") >= 20, s: median("ny_s") >= 20 };
  // Smooth each field with a circular 31-day mean so single-year quirks wash out.
  const smooth = (k) => raw.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let j = -15; j <= 15; j++) {
      const v = raw[(i + j + 366) % 366][k];
      if (isNum(v)) {
        sum += v;
        n++;
      }
    }
    return n ? sum / n : null;
  });
  const f = {};
  for (const k of ["tmax", "tmin", "gdd", "hdd", "cdd"]) f[k] = enough.t ? smooth(k) : raw.map(() => null);
  for (const k of ["prcp", "pct_wet"]) f[k] = enough.p ? smooth(k) : raw.map(() => null);
  f.snow = enough.s ? smooth("snow") : raw.map(() => null);
  return MONTH_DAYS.map((m, i) => ({
    md: m, tmax: f.tmax[i], tmin: f.tmin[i], prcp: f.prcp[i], snow: f.snow[i], pct_wet: f.pct_wet[i],
    gdd: f.gdd[i], hdd: f.hdd[i], cdd: f.cdd[i],
  }));
}

// ---------------------------------------------------------------------------
// Charts

const utcX = (title, format = "%b %-d") => ({
  field: "date", type: "temporal", scale: { type: "utc" }, title,
  axis: { format, labelAngle: 0, tickCount: 6 },
});

function windowChart(rows, today, U) {
  const domain = ["High", "Low", "Normal high", "Normal low", "Record high", "Record low"];
  const color = {
    field: "series", type: "nominal", title: null,
    scale: { domain, range: [COLORS.warm, COLORS.cool, "#d98a6e", "#7d97c4", "#ecb9a6", "#b9c9e4"] },
    legend: { orient: "bottom", columns: 3, symbolType: "stroke", symbolStrokeWidth: 2 },
  };
  const strokeDash = { field: "series", type: "nominal", scale: { domain, range: [[1, 0], [1, 0], [6, 4], [6, 4], [2, 3], [2, 3]] }, legend: null };
  const x = { field: "date", type: "temporal", scale: { type: "utc" }, title: null, axis: { format: "%a %-d", labelAngle: 0 } };
  const y = { field: "value", type: "quantitative", title: U.t, scale: { zero: false } };
  const tooltip = [{ field: "date", type: "temporal", format: "%a %b %-d" }, { field: "series" }, { field: "value", format: ".0f" }];
  const layer = (filter, mark, extra = {}) => ({ transform: [{ filter }], mark, encoding: { x, y, color, strokeDash, detail: { field: "series" }, tooltip, ...extra } });
  return {
    width: "container", height: 240,
    data: { values: rows },
    layer: [
      layer("datum.kind === 'record'", { type: "line", strokeWidth: 1.5 }),
      layer("datum.kind === 'normal'", { type: "line", strokeWidth: 1.5 }),
      layer("datum.kind === 'observed'", { type: "line", strokeWidth: 2.5, point: { filled: true, size: 45 } }),
      layer("datum.kind === 'forecast'", { type: "line", strokeWidth: 2.5, point: { filled: false, size: 50, strokeWidth: 1.5, fill: "white" } }, { strokeDash: { value: [5, 3] } }),
      {
        data: { values: [{ date: today, label: "Today" }] },
        layer: [
          { mark: { type: "rule", color: COLORS.normal, strokeDash: [2, 2] }, encoding: { x } },
          { mark: { type: "text", align: "left", dx: 4, dy: -6, color: COLORS.normal, fontSize: 11 }, encoding: { x, y: { value: 0 }, text: { field: "label" } } },
        ],
      },
    ],
  };
}

function precipBars(rows, U, title) {
  return {
    width: "container", height: 90,
    data: { values: rows },
    mark: { type: "bar", width: { band: 0.6 } },
    encoding: {
      x: { field: "date", type: "temporal", timeUnit: "utcyearmonthdate", scale: { type: "utc" }, title: null, axis: { format: "%a %-d", labelAngle: 0 } },
      y: { field: "value", type: "quantitative", title: `${title} (${U.p})`, axis: { format: U.us ? ".2f" : ".1f", tickCount: 3 } },
      color: { field: "kind", type: "nominal", title: null, scale: { domain: ["Observed", "Forecast"], range: [COLORS.precip, COLORS.precipLight] }, legend: { orient: "bottom" } },
      tooltip: [{ field: "date", type: "temporal", timeUnit: "utcyearmonthdate", format: "%b %-d" }, { field: "value", format: `.${U.pd}f` }, { field: "kind" }],
    },
  };
}

function departureChart(rows, U) {
  const x = { field: "date", type: "temporal", timeUnit: "utcyearmonthdate", scale: { type: "utc" }, title: null, axis: { format: "%b", labelAngle: 0, tickCount: 6 } };
  const y = { field: "value", type: "quantitative", title: `Daily mean temperature vs normal (${U.t})` };
  return {
    width: "container", height: 200,
    data: { values: rows },
    layer: [
      {
        transform: [{ filter: "datum.kind === 'day'" }],
        mark: { type: "bar", width: { band: 1 } },
        encoding: {
          x, y,
          color: { condition: { test: "datum.value >= 0", value: COLORS.warm }, value: COLORS.cool },
          tooltip: [{ field: "date", type: "temporal", timeUnit: "utcyearmonthdate", format: "%b %-d, %Y" }, { field: "value", format: "+.1f", title: "Departure" }],
        },
      },
      { transform: [{ filter: "datum.kind === 'mean'" }], mark: { type: "line", color: COLORS.ink, strokeWidth: 1.5 }, encoding: { x, y } },
    ],
  };
}

function cumulativeChart(rows, U, unit, title, domain, range) {
  return {
    width: "container", height: 200,
    data: { values: rows },
    mark: { type: "line", strokeWidth: 2 },
    encoding: {
      x: utcX(null, "%b"),
      y: { field: "value", type: "quantitative", title: `${title} (${unit})` },
      color: { field: "series", type: "nominal", title: null, scale: { domain, range }, legend: { orient: "bottom" } },
      strokeDash: { field: "series", type: "nominal", scale: { domain, range: domain.map((d) => (/normal/i.test(d) ? [6, 4] : [1, 0])) }, legend: null },
      tooltip: [{ field: "date", type: "temporal", format: "%b %-d" }, { field: "series" }, { field: "value", format: ".2f" }],
    },
  };
}

function frostChart(rows, today, fall, fcEnd) {
  const x = (field) => ({
    field, type: "temporal", scale: { type: "utc", domain: fall ? ["2000-08-15", "2000-12-15"] : ["2000-02-15", "2000-06-15"] },
    axis: { format: "%b %-d", labelAngle: 0, title: null },
  });
  const y = { field: "label", type: "nominal", title: null, sort: null, axis: { labelLimit: 160 } };
  return {
    width: "container", height: 40 * rows.length + 20,
    data: { values: rows },
    layer: [
      ...(fcEnd ? [{ data: { values: [{ a: today, b: fcEnd }] }, mark: { type: "rect", color: "#e9ecef", opacity: 0.9 }, encoding: { x: x("a"), x2: { field: "b" } } }] : []),
      { transform: [{ filter: "datum.p10 && datum.p90" }], mark: { type: "bar", height: 12, color: "#d2ebf5", cornerRadius: 2 }, encoding: { x: x("p10"), x2: { field: "p90" }, y } },
      { transform: [{ filter: "datum.p50" }], mark: { type: "tick", thickness: 3, size: 18, color: COLORS.precip }, encoding: { x: x("p50"), y } },
      { transform: [{ filter: "datum.observed" }], mark: { type: "point", filled: true, size: 90, color: COLORS.cool, shape: "diamond" }, encoding: { x: x("observed"), y } },
      { transform: [{ filter: "datum.forecast" }], mark: { type: "point", filled: false, size: 90, strokeWidth: 2, color: COLORS.cool, shape: "diamond" }, encoding: { x: x("forecast"), y } },
      { transform: [{ filter: "datum.possible" }], mark: { type: "point", filled: false, size: 80, strokeWidth: 2, color: COLORS.cool, shape: "circle", strokeDash: [2, 2] }, encoding: { x: x("possible"), y } },
      { data: { values: [{ today }] }, mark: { type: "rule", color: COLORS.warm, strokeDash: [3, 3] }, encoding: { x: x("today") } },
    ],
  };
}

// ---------------------------------------------------------------------------
// Classification of a value against the 1991-2020 distribution and the record

function classify(pct, value, recHi, recLo, U, warmSide = true) {
  if (!isNum(value)) return null;
  if (isNum(recHi) && value > recHi) return "record warm";
  if (isNum(recLo) && value < recLo) return "record cold";
  if (isNum(recHi) && value >= recHi - U.near) return "near the record warm";
  if (isNum(recLo) && value <= recLo + U.near) return "near the record cold";
  if (!isNum(pct)) return null;
  if (pct >= 0.9) return "much above normal";
  if (pct >= 0.7) return "above normal";
  if (pct <= 0.1) return "much below normal";
  if (pct <= 0.3) return "below normal";
  return "near normal";
}

// ---------------------------------------------------------------------------
// Narrative: the model writes the blue boxes from the numbers; templates otherwise.

const NARRATOR = `You write the short text boxes of a station climate almanac for a curious general audience. You get a JSON summary of numbers computed from NOAA data. Use only those numbers; never invent values, dates or records. Return only a JSON object with these string fields:
- "now": 2-3 sentences on the latest observations and today's forecast against normal and the record for the date.
- "outlook": 3-5 sentences on where the past 5 and next 5 days sit relative to the 1991-2020 normals and the historical record: normal or abnormal, and how (use the classes given). Then a sentence or two on anything interesting in the forecast text.
- "past_year": 3-5 sentences summarizing the last 12 months' temperature, precipitation and snowfall against normal, ending with something creative: an almanac-style saying, a haiku or a vivid image grounded in these numbers.
- "frost": 3-4 sentences on frost and freeze this season against the normal dates: what has happened so far, whether the forecast brings a frost or freeze (or could, where a forecast low is within the margin given), and how usual or unusual that timing is relative to 1991-2020 (use the percentages given); or "" if the input has no frost section.
- "season": 3-4 sentences on how hot this summer or how cold this winter has been so far: its rank among all years on record, hot or cold extremes and day counts against the 1991-2020 average, and precipitation or snow; or "" if the input has no season section.
- "degree_days": 2-3 sentences on year-to-date growing, heating and cooling degree days against normal and what that means for crops and energy use.
Many stations are cooperative observers who read the thermometer once a day, often in the morning (observation_time, e.g., "0800"), so a reported high often comes from the previous afternoon. That is normal practice; do not mention it.
Plain sentences, Unicode symbols (°, −, ≤), the units given, no LaTeX, no headings, no lists.`;

async function narrate(facts) {
  if (!deps.lumen.getKey()) return null;
  const model = deps.getModel();
  if (!model) return null;
  const resp = await deps.lumen.api("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model, temperature: 0.5,
      messages: [{ role: "system", content: NARRATOR }, { role: "user", content: JSON.stringify(facts) }],
    }),
  });
  const body = await resp.json();
  const text = body.choices?.[0]?.message?.content || "";
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("The model did not return JSON for the almanac text.");
  return { text: JSON.parse(m[0]), model };
}

// ---------------------------------------------------------------------------
// Main

export async function renderAlmanac(out, input, { onStatus = () => {}, asOf = null } = {}) {
  out.replaceChildren();
  onStatus("Starting the database");
  const g = await deps.startData();
  onStatus("Finding the station");
  const st = await resolveStation(g, input);
  const U = unitsFor(st.country);
  const F = formatters(U);
  // asOf: an almanac for a past date, from observations only (no forecast).
  const historical = !!asOf && /^\d{4}-\d{2}-\d{2}$/.test(asOf) && asOf < todayLocal();
  const D = historical ? asOf : todayLocal();
  const year = Number(D.slice(0, 4));
  const month = Number(D.slice(5, 7));

  onStatus(`Loading ${st.name}'s record, normals and forecast`);
  const [series, official, forecast] = await Promise.allSettled([
    g.loadSeries({ station: st.id, elements: ["TMAX", "TMIN", "PRCP", "SNOW"] }),
    U.us ? officialNormals(st.id) : Promise.resolve(null),
    historical ? Promise.resolve(null) : g.getForecast({ station: st.id }),
  ]);
  if (series.status === "rejected") throw series.reason;
  const loadedEls = new Set(series.value.results.filter((r) => r.loaded).map((r) => r.element));
  const provisional = new Set((await g.sql(`SELECT DISTINCT strftime(date, '%Y-%m-%d') AS d FROM provisional WHERE station = ${sq(st.id)}`)).map((r) => r.d));
  const hasT = loadedEls.has("TMAX") && loadedEls.has("TMIN");
  const hasP = loadedEls.has("PRCP");
  const fc = forecast.status === "fulfilled" ? forecast.value : null;
  if (forecast.status === "rejected") deps.logEvent("almanac forecast", forecast.reason?.message || String(forecast.reason));

  onStatus("Computing normals and records");
  await g.sql(`
    CREATE OR REPLACE TABLE alm_daily AS
    WITH p AS (
      SELECT date,
        max(CASE WHEN element = 'TMAX' THEN ${U.tSql} END) AS tmax,
        max(CASE WHEN element = 'TMIN' THEN ${U.tSql} END) AS tmin,
        max(CASE WHEN element = 'PRCP' THEN ${U.pSql} END) AS prcp,
        max(CASE WHEN element = 'SNOW' THEN ${U.sSql} END) AS snow
      FROM obs WHERE station = ${sq(st.id)} GROUP BY date)
    SELECT *,
      CASE WHEN tmax IS NULL OR tmin IS NULL OR tmax < tmin THEN NULL
           ELSE (least(greatest(tmax, ${U.gddBase}), ${U.gddCap}) + least(greatest(tmin, ${U.gddBase}), ${U.gddCap})) / 2 - ${U.gddBase} END AS gdd,
      CASE WHEN tmax IS NULL OR tmin IS NULL THEN NULL ELSE greatest(0, ${U.dd} - (tmax + tmin) / 2) END AS hdd,
      CASE WHEN tmax IS NULL OR tmin IS NULL THEN NULL ELSE greatest(0, (tmax + tmin) / 2 - ${U.dd}) END AS cdd
    FROM p`);

  // Normals, field by field: NCEI first, the station's own 1991-2020 mean otherwise.
  const off = official.status === "fulfilled" ? official.value : null;
  const comp = await computedNormals(g, U);
  const source = {};
  const norm = MONTH_DAYS.map((m, i) => {
    const o = off?.days[i] || {};
    const c = comp[i];
    const pick = (k) => (isNum(o[k]) ? o[k] : c[k]);
    return { md: m, tmax: pick("tmax"), tmin: pick("tmin"), prcp: pick("prcp"), snow: pick("snow"), pct_wet: pick("pct_wet"), gdd: pick("gdd"), hdd: pick("hdd"), cdd: pick("cdd") };
  });
  for (const [k, fields] of [["temperature", ["tmax"]], ["precipitation", ["prcp"]], ["snowfall", ["snow"]]]) {
    const o = off?.days.some((d) => isNum(d[fields[0]]));
    const c = comp.some((d) => isNum(d[fields[0]]));
    source[k] = o ? "NOAA 1991–2020 normals" : c ? "computed from this station's 1991–2020 data" : null;
  }
  await g.sql("CREATE OR REPLACE TABLE alm_norm (md VARCHAR, tmax DOUBLE, tmin DOUBLE, prcp DOUBLE, snow DOUBLE, pct_wet DOUBLE, gdd DOUBLE, hdd DOUBLE, cdd DOUBLE)");
  await g.sql(`INSERT INTO alm_norm VALUES ${norm.map((n) =>
    `(${sq(n.md)}, ${["tmax", "tmin", "prcp", "snow", "pct_wet", "gdd", "hdd", "cdd"].map((k) => (isNum(n[k]) ? n[k] : "NULL")).join(", ")})`).join(", ")}`);
  const normFor = (date) => norm[MONTH_DAYS.indexOf(md(date))] || {};

  const latest = (await g.sql(`SELECT strftime(max(date), '%Y-%m-%d') AS d FROM alm_daily WHERE date ${historical ? "<=" : "<"} DATE ${sq(D)} AND (tmax IS NOT NULL OR prcp IS NOT NULL)`))[0].d;
  const hasSnow = (await g.sql(`SELECT count(snow) AS n FROM alm_daily WHERE date > DATE ${sq(D)} - INTERVAL 730 DAY`))[0].n > 30;

  // Forecast in display units, by date.
  const fcBy = new Map();
  for (const r of fc?.daily || []) {
    const v = r.element === "TMAX" || r.element === "TMIN" ? U.temp(r.value)
      : r.element === "PRCP" ? U.precip(r.value) : r.element === "SNOW" ? U.snow(r.value) : r.value;
    fcBy.set(`${r.date}|${r.element}`, { value: v, partial: r.partial_day });
  }
  const fcv = (date, el) => fcBy.get(`${date}|${el}`)?.value ?? null;

  // Records and percentiles for the 11-day window plus the latest report.
  const winDates = Array.from({ length: 11 }, (_, i) => addDays(D, i - 5));
  const obsRows = await g.sql(`SELECT strftime(date, '%Y-%m-%d') AS date, tmax, tmin, prcp, snow FROM alm_daily
                               WHERE date BETWEEN DATE ${sq(addDays(D, -5))} AND DATE ${sq(historical ? addDays(D, 5) : D)} OR date = DATE ${sq(latest || D)}`);
  const obsBy = new Map(obsRows.map((r) => [r.date, r]));
  const evalDates = [...new Set([...(latest ? [latest] : []), ...winDates])];
  const valueRows = evalDates.map((d) => {
    const observed = historical ? true : d < D;
    const o = obsBy.get(d) || {};
    return {
      date: d, kind: observed ? "observed" : "forecast",
      tmax: observed ? o.tmax ?? null : fcv(d, "TMAX"), tmin: observed ? o.tmin ?? null : fcv(d, "TMIN"),
      prcp: observed ? o.prcp ?? null : fcv(d, "PRCP"), snow: observed ? o.snow ?? null : fcv(d, "SNOW"),
      pop: observed ? null : fcv(d, "POP"),
    };
  });
  const lit = (v) => (isNum(v) ? `${v}::DOUBLE` : "NULL::DOUBLE");
  const stats = await g.sql(`
    WITH w(date, tmax, tmin) AS (VALUES ${valueRows.map((r) => `(DATE ${sq(r.date)}, ${lit(r.tmax)}, ${lit(r.tmin)})`).join(", ")}),
    rec AS (
      SELECT w.date,
        max(a.tmax) AS rec_hi, arg_max(year(a.date), a.tmax) AS rec_hi_yr,
        min(a.tmax) AS rec_cold_hi, arg_min(year(a.date), a.tmax) AS rec_cold_hi_yr,
        min(a.tmin) AS rec_lo, arg_min(year(a.date), a.tmin) AS rec_lo_yr,
        max(a.tmin) AS rec_warm_lo, arg_max(year(a.date), a.tmin) AS rec_warm_lo_yr,
        max(a.prcp) AS rec_prcp, arg_max(year(a.date), a.prcp) AS rec_prcp_yr,
        max(a.snow) AS rec_snow, arg_max(year(a.date), a.snow) AS rec_snow_yr,
        count(DISTINCT year(a.date)) AS n_years
      FROM w JOIN alm_daily a ON month(a.date) = month(w.date) AND day(a.date) = day(w.date) AND year(a.date) <> year(w.date)
      GROUP BY w.date),
    pct AS (
      SELECT w.date,
        avg(CASE WHEN a.tmax < w.tmax THEN 1.0 WHEN a.tmax = w.tmax THEN 0.5 ELSE 0.0 END) FILTER (WHERE a.tmax IS NOT NULL AND w.tmax IS NOT NULL) AS pct_hi,
        avg(CASE WHEN a.tmin < w.tmin THEN 1.0 WHEN a.tmin = w.tmin THEN 0.5 ELSE 0.0 END) FILTER (WHERE a.tmin IS NOT NULL AND w.tmin IS NOT NULL) AS pct_lo
      FROM w JOIN alm_daily a ON year(a.date) BETWEEN 1991 AND 2020
        AND least(abs(dayofyear(a.date) - dayofyear(w.date)), 366 - abs(dayofyear(a.date) - dayofyear(w.date))) <= 7
      GROUP BY w.date)
    SELECT strftime(w.date, '%Y-%m-%d') AS date, rec.* EXCLUDE (date), pct.* EXCLUDE (date)
    FROM w LEFT JOIN rec ON rec.date = w.date LEFT JOIN pct ON pct.date = w.date`);
  const statBy = new Map(stats.map((s) => [s.date, s]));
  const day = (d) => {
    const v = valueRows.find((r) => r.date === d) || { date: d };
    const s = statBy.get(d) || {};
    const n = normFor(d);
    return {
      ...v, ...s,
      n_hi: n.tmax, n_lo: n.tmin, n_prcp: n.prcp, n_snow: n.snow, pct_wet: n.pct_wet,
      dep_hi: isNum(v.tmax) && isNum(n.tmax) ? v.tmax - n.tmax : null,
      dep_lo: isNum(v.tmin) && isNum(n.tmin) ? v.tmin - n.tmin : null,
      class_hi: classify(s.pct_hi, v.tmax, s.rec_hi, s.rec_cold_hi, U),
      class_lo: classify(s.pct_lo, v.tmin, s.rec_warm_lo, s.rec_lo, U),
    };
  };

  // ---- Layout -------------------------------------------------------------
  const page = h("article", { className: "alm" });
  out.append(page);
  const boxes = {};
  const section = (key, title, ...content) => {
    const box = h("div", { className: "alm-box" });
    boxes[key] = box;
    const sec = h("section", { className: "alm-section", "aria-labelledby": `alm-${key}` },
      h("h2", { id: `alm-${key}`, text: title }), box, ...content);
    page.append(sec);
    return sec;
  };
  const charts = [];
  const chart = (spec, label) => {
    const fig = h("figure", { className: "alm-chart", "aria-label": label });
    charts.push([fig, spec]);
    return fig;
  };

  // Header
  const firstYear = (await g.sql("SELECT min(year(date)) AS y FROM alm_daily"))[0].y;
  page.append(h("header", { className: "alm-head" },
    h("h1", { text: `${st.name}${st.state ? `, ${st.state}` : ""}` }),
    h("p", { className: "alm-meta", text: [
      `GHCN-Daily ${st.id}`,
      st.county ? `${st.county} County` : null,
      `${Math.abs(st.lat).toFixed(2)}°${st.lat >= 0 ? "N" : "S"} ${Math.abs(st.lon).toFixed(2)}°${st.lon >= 0 ? "E" : "W"}`,
      isNum(st.elev_m) ? `${U.us ? Math.round(st.elev_m * 3.281) + " ft" : Math.round(st.elev_m) + " m"} elevation` : null,
      `records since ${firstYear}`,
    ].filter(Boolean).join(", ") }),
    h("p", { className: "alm-meta", text: `Almanac for ${fmtDay(D, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}${historical ? ", from observations (no forecast)" : ""}. Normals: ${source.temperature || "unavailable"}.` })));

  const facts = {
    station: { name: st.name, state: st.state, id: st.id, units: { temperature: U.t, precipitation: U.p, snowfall: U.s } },
    today: D, historical_view: historical, normals_source: source,
  };

  // ---- 1. Yesterday and today
  const Ldate = latest ? (latest === D ? addDays(D, -1) : latest) : null;
  const L = Ldate ? day(Ldate) : null;
  const T = day(D);
  const latestLabel = Ldate === addDays(D, -1) ? (historical ? "Day before" : "Yesterday") : "Latest report";
  // Co-op observers report the 24 hours ending at their observation time
  // (often 7 or 8 a.m.); passed to the model as background only.
  const obsTime = latest ? (await g.sql(`SELECT obs_time FROM obs WHERE station = ${sq(st.id)} AND element = 'TMAX' AND obs_time IS NOT NULL AND date <= DATE ${sq(Ldate)} ORDER BY date DESC LIMIT 1`))[0]?.obs_time : null;
  const cell = (main, normalTxt, recordTxt, flag) => h("td", {},
    h("div", { className: "alm-val", text: main }),
    normalTxt ? h("div", { className: "alm-sub", text: normalTxt }) : null,
    recordTxt ? h("div", { className: "alm-sub", text: recordTxt }) : null,
    flag ? h("div", { className: "alm-flag", text: flag }) : null);
  const tempCell = (v, n, dep, rec, recYr, isHigh, observed) => cell(
    F.t(v), isNum(n) ? `normal ${F.t(n)}${isNum(dep) ? ` (${F.dep(dep)})` : ""}` : null,
    isNum(rec) ? `record ${F.t(rec)} in ${recYr}` : null,
    isNum(v) && isNum(rec) && (isHigh ? v > rec : v < rec) ? (observed ? "New record" : "Would set a record") : null);
  const nowRows = [];
  if (hasT) {
    nowRows.push(h("tr", {}, h("th", { scope: "row", text: "High" }),
      L ? tempCell(L.tmax, L.n_hi, L.dep_hi, L.rec_hi, L.rec_hi_yr, true, true) : cell("–"),
      tempCell(T.tmax, T.n_hi, T.dep_hi, T.rec_hi, T.rec_hi_yr, true, false)));
    nowRows.push(h("tr", {}, h("th", { scope: "row", text: "Low" }),
      L ? tempCell(L.tmin, L.n_lo, L.dep_lo, L.rec_lo, L.rec_lo_yr, false, true) : cell("–"),
      tempCell(T.tmin, T.n_lo, T.dep_lo, T.rec_lo, T.rec_lo_yr, false, false)));
  }
  if (hasP) {
    nowRows.push(h("tr", {}, h("th", { scope: "row", text: "Precipitation" }),
      L ? cell(F.p(L.prcp), isNum(L.pct_wet) ? `rain or snow falls on ${Math.round(L.pct_wet * 100)}% of these dates` : null,
        isNum(L.rec_prcp) ? `record ${F.p(L.rec_prcp)} in ${L.rec_prcp_yr}` : null) : cell("–"),
      cell(isNum(T.prcp) ? F.p(T.prcp) : "–", isNum(T.pop) ? `${Math.round(T.pop)}% chance${fcBy.get(`${D}|PRCP`)?.partial ? ", rest of today" : ""}` : null,
        isNum(T.rec_prcp) ? `record ${F.p(T.rec_prcp)} in ${T.rec_prcp_yr}` : null)));
  }
  if (hasSnow && (isNum(L?.snow) && L.snow > 0 || isNum(T.snow) && T.snow > 0 || month >= 10 || month <= 4)) {
    nowRows.push(h("tr", {}, h("th", { scope: "row", text: "Snowfall" }),
      L ? cell(F.s(L.snow), null, isNum(L.rec_snow) && L.rec_snow > 0 ? `record ${F.s(L.rec_snow)} in ${L.rec_snow_yr}` : null) : cell("–"),
      cell(isNum(T.snow) ? F.s(T.snow) : "–", null, isNum(T.rec_snow) && T.rec_snow > 0 ? `record ${F.s(T.rec_snow)} in ${T.rec_snow_yr}` : null)));
  }
  section("now", "Yesterday and today",
    h("div", { className: "alm-scroll" }, h("table", { className: "alm-table alm-now" },
      h("thead", {}, h("tr", {}, h("td"),
        h("th", { scope: "col", text: L ? `${latestLabel}, ${fmtDay(Ldate)}${provisional.has(Ldate) ? " (provisional)" : ""}` : "Latest report" }),
        h("th", { scope: "col", text: historical ? `${fmtDay(D)} (observed)` : `Today, ${fmtDay(D)}${fc ? " (forecast)" : ""}` }))),
      h("tbody", {}, nowRows))),
    provisional.size ? h("p", { className: "fine", text: `Days after ${fmtDay(addDays([...provisional].sort()[0], -1), { month: "short", day: "numeric" })} are provisional reports from the Regional Climate Centers' ACIS; GHCN-Daily runs a few days behind and may revise them.` }) : null,
    fc || historical ? null : h("p", { className: "fine", text: forecast.status === "rejected" && !/covers the US/.test(forecast.reason?.message || "")
      ? "The National Weather Service forecast could not be reached just now. Reload the page to try again."
      : "No National Weather Service forecast is available for this station." }));
  const pick = (r) => r && {
    date: r.date, high: round(r.tmax), low: round(r.tmin), precip: round(r.prcp, U.pd), snow: round(r.snow, 1), pop: round(r.pop),
    normal_high: round(r.n_hi), normal_low: round(r.n_lo), high_vs_normal: round(r.dep_hi), low_vs_normal: round(r.dep_lo),
    high_class: r.class_hi, low_class: r.class_lo,
    record_high: round(r.rec_hi), record_high_year: r.rec_hi_yr, record_low: round(r.rec_lo), record_low_year: r.rec_lo_yr,
    record_precip: round(r.rec_prcp, U.pd), record_precip_year: r.rec_prcp_yr, years_of_record: r.n_years,
  };
  facts.now = { latest_report: pick(L), latest_is_provisional: provisional.has(Ldate), latest_label: latestLabel, today_forecast: fc ? pick(T) : null, today_observed: historical ? pick(T) : null, observation_time: obsTime || null };

  // ---- 2. Past 5 and next 5 days
  const win = winDates.map(day);
  if (hasT || hasP) {
    const chartRows = [];
    for (const r of win) {
      const kind = r.kind;
      if (isNum(r.tmax)) chartRows.push({ date: r.date, series: "High", value: r.tmax, kind });
      if (isNum(r.tmin)) chartRows.push({ date: r.date, series: "Low", value: r.tmin, kind });
      if (isNum(r.n_hi)) chartRows.push({ date: r.date, series: "Normal high", value: r.n_hi, kind: "normal" });
      if (isNum(r.n_lo)) chartRows.push({ date: r.date, series: "Normal low", value: r.n_lo, kind: "normal" });
      if (isNum(r.rec_hi)) chartRows.push({ date: r.date, series: "Record high", value: r.rec_hi, kind: "record" });
      if (isNum(r.rec_lo)) chartRows.push({ date: r.date, series: "Record low", value: r.rec_lo, kind: "record" });
    }
    const prRows = win.filter((r) => isNum(r.prcp)).map((r) => ({ date: r.date, value: r.prcp, kind: r.kind === "observed" ? "Observed" : "Forecast" }));
    const tr = win.map((r) => h("tr", { className: r.kind === "forecast" ? "alm-fc" : "" },
      h("th", { scope: "row", text: `${fmtDay(r.date)}${r.date === D ? " (today)" : ""}` }),
      hasT ? h("td", { text: `${F.t(r.tmax)} ${F.dep(r.dep_hi)}`.trim() }) : null,
      hasT ? h("td", { text: `${F.t(r.tmin)} ${F.dep(r.dep_lo)}`.trim() }) : null,
      hasP ? h("td", { text: r.kind === "forecast" && isNum(r.pop) ? `${F.p(r.prcp)} (${Math.round(r.pop)}%)` : F.p(r.prcp) }) : null,
      hasSnow ? h("td", { text: F.s(r.snow) }) : null,
      h("td", { className: "alm-kind", text: r.kind === "forecast" ? "Forecast" : provisional.has(r.date) ? "Provisional" : isNum(r.tmax) || isNum(r.prcp) ? "Observed" : "Not yet reported" })));
    section("outlook", "The past 5 days and the next 5",
      hasT ? chart(windowChart(chartRows, D, U), "Daily highs and lows with normals and records") : null,
      hasP && prRows.some((r) => r.value > 0) ? chart(precipBars(prRows, U, "Precipitation"), "Daily precipitation") : null,
      h("div", { className: "alm-scroll" }, h("table", { className: "alm-table" },
        h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Day" }),
          hasT ? h("th", { scope: "col", text: "High (vs normal)" }) : null, hasT ? h("th", { scope: "col", text: "Low (vs normal)" }) : null,
          hasP ? h("th", { scope: "col", text: "Precip" }) : null, hasSnow ? h("th", { scope: "col", text: "Snow" }) : null, h("td"))),
        h("tbody", {}, tr))));
    facts.outlook = {
      days: win.map(pick).map((x, i) => ({ ...x, kind: win[i].kind === "observed" && provisional.has(win[i].date) ? "observed (provisional)" : win[i].kind })),
      nws_text_forecast: fc?.text_forecast?.slice(0, 8) || [],
      forecast_issued: fc?.issued || null,
      class_scale: "classes compare each value with this station's 1991-2020 values within 7 days of the date: much below <10th percentile, below <30th, near normal 30-70th, above >70th, much above >90th; near the record means within " + U.near + U.t,
    };
  }

  // ---- 3. The past year
  if (latest && (hasT || hasP)) {
    const start = addDays(latest, -364);
    const yr = await g.sql(`
      SELECT strftime(g.date, '%Y-%m-%d') AS date, a.tmax, a.tmin, a.prcp, a.snow,
             n.tmax AS n_hi, n.tmin AS n_lo, n.prcp AS n_prcp
      FROM (SELECT unnest(generate_series(DATE ${sq(start)}, DATE ${sq(latest)}, INTERVAL 1 DAY))::DATE AS date) g
      LEFT JOIN alm_daily a ON a.date = g.date
      LEFT JOIN alm_norm n ON n.md = strftime(g.date, '%m-%d')
      ORDER BY g.date`);
    const content = [];
    const yfacts = { period: `${start} to ${latest}` };
    if (hasT) {
      const depRows = [];
      const deps30 = [];
      for (const r of yr) {
        const dep = isNum(r.tmax) && isNum(r.tmin) && isNum(r.n_hi) && isNum(r.n_lo) ? (r.tmax + r.tmin) / 2 - (r.n_hi + r.n_lo) / 2 : null;
        deps30.push(dep);
        if (deps30.length > 30) deps30.shift();
        const v = deps30.filter(isNum);
        if (isNum(dep)) depRows.push({ date: r.date, kind: "day", value: round(dep, 1) });
        if (v.length >= 20) depRows.push({ date: r.date, kind: "mean", value: round(v.reduce((a, b) => a + b, 0) / v.length, 2) });
      }
      content.push(h("h3", { text: "Temperature compared with normal" }), chart(departureChart(depRows, U), "Daily mean temperature departure from normal, with 30-day mean"));
      const daysDep = depRows.filter((r) => r.kind === "day").map((r) => ({ date: r.date, dep: r.value }));
      const all = daysDep.map((r) => r.dep);
      yfacts.mean_temperature_vs_normal = round(all.reduce((a, b) => a + b, 0) / (all.length || 1), 1);
      yfacts.days_warmer_than_normal = all.filter((d) => d > 0).length;
      yfacts.days_colder_than_normal = all.filter((d) => d < 0).length;
      const warm = daysDep.reduce((a, b) => (b.dep > (a?.dep ?? -Infinity) ? b : a), null);
      const cold = daysDep.reduce((a, b) => (b.dep < (a?.dep ?? Infinity) ? b : a), null);
      yfacts.warmest_day_vs_normal = warm && { date: warm.date, departure: warm.dep };
      yfacts.coldest_day_vs_normal = cold && { date: cold.date, departure: cold.dep };
    }
    if (hasP && source.precipitation) {
      let co = 0;
      let cn = 0;
      let missing = 0;
      const cum = [];
      for (const r of yr) {
        if (isNum(r.prcp)) co += r.prcp;
        else missing++;
        if (isNum(r.n_prcp)) cn += r.n_prcp;
        cum.push({ date: r.date, series: "Observed", value: round(co, 2) }, { date: r.date, series: "Normal", value: round(cn, 2) });
      }
      content.push(h("h3", { text: "Precipitation since " + fmtDay(start, { month: "long", day: "numeric", year: "numeric" }) }),
        chart(cumulativeChart(cum, U, U.p, "Cumulative precipitation", ["Observed", "Normal"], [COLORS.precip, COLORS.normal]), "Cumulative precipitation against normal"));
      yfacts.precipitation = { total: round(co, U.pd), normal: round(cn, U.pd), percent_of_normal: cn ? Math.round((100 * co) / cn) : null, days_missing: missing };
    }
    // Monthly table, last 12 calendar months.
    const months = new Map();
    for (const r of yr) {
      const k = r.date.slice(0, 7);
      if (!months.has(k)) months.set(k, { hi: [], lo: [], nhi: [], nlo: [], p: 0, np: 0, pd: 0, s: 0, sd: 0, days: 0 });
      const m = months.get(k);
      m.days++;
      if (isNum(r.tmax)) { m.hi.push(r.tmax); m.nhi.push(r.n_hi); }
      if (isNum(r.tmin)) { m.lo.push(r.tmin); m.nlo.push(r.n_lo); }
      if (isNum(r.prcp)) { m.p += r.prcp; m.pd++; }
      if (isNum(r.n_prcp)) m.np += r.n_prcp;
      if (isNum(r.snow)) { m.s += r.snow; m.sd++; }
    }
    const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    // Monthly means need data on at least 70% of the month's days so far (and 10 days).
    const ok = (a, m) => a.length >= Math.max(10, 0.7 * m.days);
    const mrows = [...months.entries()].slice(-12).map(([k, m]) => ({
      month: k, hi: ok(m.hi, m) ? mean(m.hi) : null, lo: ok(m.lo, m) ? mean(m.lo) : null,
      dhi: ok(m.hi, m) ? mean(m.hi) - mean(m.nhi) : null, dlo: ok(m.lo, m) ? mean(m.lo) - mean(m.nlo) : null,
      p: m.pd >= m.days - 3 ? m.p : null, pp: m.pd >= m.days - 3 && m.np ? Math.round((100 * m.p) / m.np) : null,
      s: m.sd >= m.days - 3 ? m.s : null, partial: m.days < new Date(Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5)), 0)).getUTCDate(),
    }));
    content.push(h("h3", { text: "Month by month" }), h("div", { className: "alm-scroll" }, h("table", { className: "alm-table" },
      h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Month" }),
        hasT ? h("th", { scope: "col", text: "Avg high" }) : null, hasT ? h("th", { scope: "col", text: "Avg low" }) : null,
        hasP ? h("th", { scope: "col", text: "Precip (% of normal)" }) : null, hasSnow ? h("th", { scope: "col", text: "Snow" }) : null)),
      h("tbody", {}, mrows.map((m) => h("tr", {},
        h("th", { scope: "row", text: `${fmtDay(`${m.month}-15`, { month: "short", year: "numeric" })}${m.partial ? " (partial)" : ""}` }),
        hasT ? h("td", { text: isNum(m.hi) ? `${F.t(m.hi)} ${F.dep(m.dhi, 1)}` : "–" }) : null,
        hasT ? h("td", { text: isNum(m.lo) ? `${F.t(m.lo)} ${F.dep(m.dlo, 1)}` : "–" }) : null,
        hasP ? h("td", { text: isNum(m.p) ? `${F.p(m.p)}${isNum(m.pp) ? ` (${m.pp}%)` : ""}` : "–" }) : null,
        hasSnow ? h("td", { text: F.s(m.s) }) : null))))));
    yfacts.months = mrows.map((m) => ({ month: m.month, avg_high_vs_normal: round(m.dhi, 1), avg_low_vs_normal: round(m.dlo, 1), precip_percent_of_normal: m.pp, snow: round(m.s, 1) }));

    // Snow seasons, Oct 1 to Apr 15.
    if (hasSnow && source.snowfall) {
      const curStart = month >= 10 ? year : month <= 4 && D.slice(5) <= "04-15" ? year - 1 : null;
      const lastDone = curStart !== null ? curStart - 1 : year - 1;
      const seasons = [lastDone, ...(curStart !== null ? [curStart] : [])];
      const srows = [];
      const sfacts = [];
      let normalDone = false;
      for (const s of seasons) {
        const end = s === curStart ? (latest < `${s + 1}-04-15` ? latest : `${s + 1}-04-15`) : `${s + 1}-04-15`;
        if (end < `${s}-10-01`) continue;
        const rows = await g.sql(`
          SELECT strftime(g.date, '%Y-%m-%d') AS date, a.snow, n.snow AS n_snow
          FROM (SELECT unnest(generate_series(DATE '${s}-10-01', DATE ${sq(end)}, INTERVAL 1 DAY))::DATE AS date) g
          LEFT JOIN alm_daily a ON a.date = g.date LEFT JOIN alm_norm n ON n.md = strftime(g.date, '%m-%d') ORDER BY g.date`);
        const name = `${s}–${String(s + 1).slice(2)}${s === curStart ? " so far" : ""}`;
        let c = 0;
        let cn = 0;
        let miss = 0;
        for (const r of rows) {
          if (isNum(r.snow)) c += r.snow;
          else miss++;
          const x = `${r.date.slice(5) >= "10-01" ? 2000 : 2001}-${r.date.slice(5)}`;
          srows.push({ date: x, series: name, value: round(c, 1) });
        }
        if (!normalDone) {
          for (let d = "2000-10-01"; d <= "2001-04-15"; d = addDays(d, 1)) {
            const n = normFor(d).snow;
            if (isNum(n)) cn += n;
            srows.push({ date: d, series: "Normal", value: round(cn, 1) });
          }
          normalDone = true;
        }
        let normalSoFar = 0;
        for (const r of rows) normalSoFar += isNum(r.n_snow) ? r.n_snow : 0;
        sfacts.push({ season: name, total: round(c, 1), normal_for_same_period: round(normalSoFar, 1), days_missing: miss });
      }
      if (srows.length) {
        const names = [...new Set(srows.map((r) => r.series))];
        const range = names.map((n) => (n === "Normal" ? COLORS.normal : /so far/.test(n) ? COLORS.ink : COLORS.precip));
        content.push(h("h3", { text: "Snowfall, October 1 to April 15" }),
          chart(cumulativeChart(srows, U, U.s, "Cumulative snowfall", names, range), "Cumulative snowfall by season against normal"));
        yfacts.snow_seasons = sfacts;
      }
    }
    section("past_year", "The past year", ...content);
    facts.past_year = yfacts;
  }

  // ---- 4. Frost and freeze tracker (fall: Aug-Dec, spring: Feb-Jun)
  // The year in four stories: spring frost (Mar 1-Jun 10), summer (Jun 11-Aug 31),
  // fall frost (Sep 1-Dec 10), winter (Dec 11-Feb 29).
  const mdToday = md(D);
  const spring = mdToday >= "03-01" && mdToday <= "06-10";
  const fall = mdToday >= "09-01" && mdToday <= "12-10";
  const summer = mdToday >= "06-11" && mdToday <= "08-31";
  const winter = mdToday >= "12-11" || mdToday <= "02-29";
  if (hasT && (fall || spring)) {
    // Forecast lows, dated by the morning they occur (co-op practice).
    const fcNights = [...fcBy.entries()].filter(([k, v]) => k.endsWith("|TMIN") && isNum(v.value))
      .map(([k, v]) => ({ date: k.split("|")[0], low: v.value })).filter((n) => n.date >= D).sort((x, y) => x.date.localeCompare(y.date));
    const fcEnd = fcNights.length ? fcNights[fcNights.length - 1].date : null;
    const margin = U.us ? 3 : 2; // forecast lows this close to a threshold could still reach it
    const usual = (pct) => (pct === null ? null : pct < 0.1 ? "very early" : pct < 0.25 ? "early" : pct > 0.9 ? "very late" : pct > 0.75 ? "late" : "within the usual range");
    const short = (d) => fmtDay(d, { weekday: "short", month: "short", day: "numeric" });
    const frows = [];
    const ffacts = [];
    for (const f of U.frost) {
      const hist = await g.sql(`
        SELECT year(date) AS y,
          strftime(min(date) FILTER (WHERE month(date) >= 7 AND tmin <= ${f.thr}), '%Y-%m-%d') AS first_fall,
          strftime(max(date) FILTER (WHERE month(date) <= 6 AND tmin <= ${f.thr}), '%Y-%m-%d') AS last_spring,
          count(tmin) FILTER (WHERE month(date) BETWEEN 8 AND 12) AS n_fall,
          count(tmin) FILTER (WHERE month(date) BETWEEN 1 AND 6) AS n_spring
        FROM alm_daily GROUP BY 1 ORDER BY 1`);
      const key = fall ? "first_fall" : "last_spring";
      const good = hist.filter((r) => r.y < year && r[key] && (fall ? r.n_fall >= 120 : r.n_spring >= 150));
      const sorted = good.map((r) => r[key]).sort((x, y) => md(x).localeCompare(md(y)));
      const base = good.filter((r) => r.y >= 1991 && r.y <= 2020).map((r) => md(r[key])).sort();
      const pctDate = (p) => (base.length >= 15 ? base[Math.min(base.length - 1, Math.floor(p * base.length))] : null);
      // Share of 1991-2020 seasons whose first (fall) or last (spring) occurrence came on or before a date.
      const cdf = (d) => (base.length >= 15 && d ? base.filter((m) => m <= md(d)).length / base.length : null);
      const kind = fall ? "PRBFST" : "PRBLST";
      const o = (p) => (f.key && off?.frost?.[`${kind}-${f.key}-${p}`]) || null;
      const p10 = o("10") || pctDate(0.1);
      const p50 = o("50") || pctDate(0.5);
      const p90 = o("90") || pctDate(0.9);
      const thisYear = hist.find((r) => r.y === year);
      const observed = thisYear?.[key] && (fall || thisYear[key] <= latest) ? thisYear[key] : null;
      // In the forecast: at or below the threshold, or close enough that it could happen.
      const hits = fcNights.filter((n) => n.low <= f.thr);
      const fcDate = (fall ? hits[0] : hits[hits.length - 1])?.date || null;
      const coldest = fcNights.reduce((m, n) => (!m || n.low < m.low ? n : m), null);
      const possible = !fcDate && coldest && coldest.low <= f.thr + margin ? coldest : null;
      let status;
      let dateForPct = null;
      if (fall && observed) {
        status = "occurred";
        dateForPct = observed;
      } else if (fcDate) {
        status = "in the forecast";
        dateForPct = fcDate;
      } else if (possible) {
        status = "possible in the forecast";
        dateForPct = possible.date;
      } else {
        status = fall ? "not yet, and not in the forecast" : observed ? "no later one in the forecast" : "none yet";
      }
      const pct = cdf(dateForPct);
      const byToday = cdf(D);
      const byFcEnd = cdf(fcEnd);
      let compare;
      if (dateForPct && pct !== null) {
        compare = fall
          ? `${short(dateForPct)} is ${usual(pct)}: ${Math.round(pct * 100)}% of 1991–2020 falls had their first by then`
          : `${short(dateForPct)} is ${usual(pct)}: the last came by then in ${Math.round(pct * 100)}% of 1991–2020 springs`;
      } else if (fall && byFcEnd !== null) {
        compare = `By ${short(fcEnd)}, ${Math.round(byFcEnd * 100)}% of 1991–2020 falls had had one${byFcEnd > 0.75 ? ", so this fall is running late" : ""}`;
      } else if (!fall && byToday !== null) {
        compare = `In ${Math.round(byToday * 100)}% of 1991–2020 springs the last one had already come by today`;
      } else {
        compare = "Too few complete 1991–2020 seasons here to compare";
      }
      const to2000 = (d) => (d ? `2000-${d.length > 5 ? md(d) : d}` : null);
      frows.push({
        label: f.label, p10: to2000(p10), p50: to2000(p50), p90: to2000(p90),
        observed: to2000(observed), forecast: status === "in the forecast" ? to2000(fcDate) : null,
        possible: status === "possible in the forecast" ? to2000(possible.date) : null,
      });
      ffacts.push({
        threshold: f.label, status, median_date: p50, early_10pct: p10, late_90pct: p90,
        normal_source: o("50") ? "NOAA 1991–2020 normals" : "this station's 1991–2020 record",
        this_season: observed || null, forecast_date: fcDate,
        possible_date: possible?.date || null, possible_forecast_low: possible ? round(possible.low) : null,
        timing_vs_1991_2020: dateForPct ? { date: dateForPct, percent_of_seasons_by_then: pct === null ? null : Math.round(pct * 100), class: usual(pct) } : null,
        percent_of_1991_2020_seasons_by_end_of_forecast: byFcEnd === null ? null : Math.round(byFcEnd * 100),
        percent_of_1991_2020_seasons_by_today: byToday === null ? null : Math.round(byToday * 100),
        comparison: compare,
        earliest_on_record: sorted[0] || null, latest_on_record: sorted[sorted.length - 1] || null, seasons_on_record: good.length,
      });
    }
    const reaches = (low) => {
      const hit = [...U.frost].reverse().find((f) => low <= f.thr);
      if (hit) return hit.label.replace(/ \(.*\)$/, "");
      const near = U.frost.find((f) => low <= f.thr + margin);
      return near ? `Within ${margin}° of ${near.label.replace(/ \(.*\)$/, "").toLowerCase()}` : "";
    };
    section("frost", fall ? "First frost and freeze" : "Last frost and freeze",
      chart(frostChart(frows, `2000-${md(D)}`, fall, fcEnd ? `2000-${md(fcEnd)}` : null), "Frost and freeze dates against normal, with the forecast"),
      h("p", { className: "fine alm-legend", text: `Shaded: the middle 80% of ${fall ? "first" : "last"} dates (10% to 90% chance). Blue tick: median date. Solid diamond: ${fall ? "this season's first" : "this spring's last so far"}. Open diamond: forecast. Open circle: possible (a forecast low within ${margin}°). Gray band: the forecast period. Dashed line: today.` }),
      h("div", { className: "alm-scroll" }, h("table", { className: "alm-table alm-frost" },
        h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Threshold" }), h("th", { scope: "col", text: "Median" }),
          h("th", { scope: "col", text: fall ? "This fall" : "This spring" }), h("th", { scope: "col", text: "Forecast" }),
          h("th", { scope: "col", text: "Compared with 1991–2020" }), h("th", { scope: "col", text: "Earliest" }), h("th", { scope: "col", text: "Latest" }))),
        h("tbody", {}, ffacts.map((x) => h("tr", {}, h("th", { scope: "row", text: x.threshold }),
          h("td", { text: x.median_date ? fmtDay(`2000-${x.median_date}`, { month: "short", day: "numeric" }) : "–" }),
          h("td", { text: x.this_season ? fmtDay(x.this_season, { month: "short", day: "numeric" }) : fall ? "Not yet" : "None yet" }),
          h("td", { text: x.forecast_date ? `${short(x.forecast_date)}` : x.possible_date ? `Possible ${short(x.possible_date)} (low ${F.t(x.possible_forecast_low)})` : x.status === "occurred" ? "–" : "None forecast" }),
          h("td", { className: "alm-wrap", text: x.comparison }),
          h("td", { text: x.earliest_on_record ? fmtDay(x.earliest_on_record, { month: "short", day: "numeric", year: "numeric" }) : "–" }),
          h("td", { text: x.latest_on_record ? fmtDay(x.latest_on_record, { month: "short", day: "numeric", year: "numeric" }) : "–" })))))),
      fcNights.length ? h("h3", { text: "Forecast lows" }) : null,
      fcNights.length ? h("div", { className: "alm-scroll" }, h("table", { className: "alm-table" },
        h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Morning of" }), h("th", { scope: "col", text: "Forecast low" }), h("th", { scope: "col", text: "Reaches" }))),
        h("tbody", {}, fcNights.map((n) => h("tr", {}, h("th", { scope: "row", text: short(n.date) }), h("td", { text: F.t(n.low) }), h("td", { text: reaches(n.low) || "–" })))))) : null,
      fcNights.length ? h("p", { className: "fine", text: `NWS forecast lows for the grid cell around the station. Low spots and clear, calm nights can run a few degrees colder than the forecast, so a low within ${margin}° of a threshold counts as possible.` }) : null);
    facts.frost = {
      season: fall ? "fall (first occurrence)" : "spring (last occurrence)", as_of: latest,
      forecast_lows: fcNights.map((n) => ({ morning_of: n.date, low: round(n.low) })), forecast_ends: fcEnd,
      possible_margin_degrees: margin, thresholds: ffacts,
    };
  }

  // ---- 4b. Summer or winter so far, ranked against every year on record
  if (hasT && latest && (summer || winter)) {
    const sy = summer ? year : Number(mdToday.slice(0, 2)) === 12 ? year : year - 1;
    const start = summer ? `${sy}-06-01` : `${sy}-12-01`;
    const K = Math.round((Date.parse(latest) - Date.parse(start)) / 864e5);
    if (K >= 7) {
      const T = U.us
        ? { hot: [90, 95, 100], night: 70, frigid: 0, icy: 32, snowDay: 1 }
        : { hot: [30, 35, 40], night: 20, frigid: -18, icy: 0, snowDay: 2.5 };
      const months = summer ? "month(date) IN (6, 7, 8)" : "month(date) IN (12, 1, 2)";
      const syExpr = summer ? "year(date)" : "CASE WHEN month(date) = 12 THEN year(date) ELSE year(date) - 1 END";
      const startExpr = summer ? "make_date(sy, 6, 1)" : "make_date(sy, 12, 1)";
      const rows = await g.sql(`
        WITH s AS (SELECT *, ${syExpr} AS sy FROM alm_daily WHERE ${months}),
        w AS (SELECT * FROM s WHERE date_diff('day', ${startExpr}, date) BETWEEN 0 AND ${K})
        SELECT sy,
          count(*) FILTER (WHERE tmax IS NOT NULL AND tmin IS NOT NULL) AS n_t,
          count(prcp) AS n_p, count(snow) AS n_s,
          avg((tmax + tmin) / 2) FILTER (WHERE tmax IS NOT NULL AND tmin IS NOT NULL) AS tmean,
          ${summer ? T.hot.map((t, i) => `count(*) FILTER (WHERE tmax >= ${t}) AS hot${i}`).join(", ") + `, count(*) FILTER (WHERE tmin >= ${T.night}) AS nights`
            : `count(*) FILTER (WHERE tmin <= ${T.frigid}) AS frigid, count(*) FILTER (WHERE tmax <= ${T.icy}) AS icy, count(*) FILTER (WHERE snow >= ${T.snowDay}) AS snowdays, sum(snow) AS snow_total, max(snow) AS max_snow, strftime(arg_max(date, snow), '%Y-%m-%d') AS max_snow_date`},
          max(tmax) AS max_hi, strftime(arg_max(date, tmax), '%Y-%m-%d') AS max_hi_date,
          min(tmin) AS min_lo, strftime(arg_min(date, tmin), '%Y-%m-%d') AS min_lo_date,
          sum(prcp) AS prcp_total, max(prcp) AS max_prcp, strftime(arg_max(date, prcp), '%Y-%m-%d') AS max_prcp_date
        FROM w GROUP BY sy ORDER BY sy`);
      const need = 0.8 * (K + 1);
      const good = rows.filter((r) => r.n_t >= need);
      const cur = good.find((r) => r.sy === sy);
      const base = good.filter((r) => r.sy >= 1991 && r.sy <= 2020 && r.sy !== sy);
      if (cur && base.length >= 15) {
        const avg = (k, set = base) => {
          const v = set.map((r) => r[k]).filter(isNum);
          return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
        };
        const others = good.filter((r) => r.sy !== sy);
        const rankOf = (k, desc = true, set = good) => {
          const v = set.filter((r) => isNum(r[k]));
          const sorted = [...v].sort((a, b) => (desc ? b[k] - a[k] : a[k] - b[k]));
          return { rank: sorted.findIndex((r) => r.sy === sy) + 1, of: sorted.length };
        };
        const recordOf = (k, desc = true) => {
          const v = others.filter((r) => isNum(r[k]));
          if (!v.length) return null;
          const r = v.reduce((a, b) => ((desc ? b[k] > a[k] : b[k] < a[k]) ? b : a));
          return { value: r[k], year: r.sy };
        };
        const pGood = good.filter((r) => r.n_p >= need);
        const sGood = good.filter((r) => r.n_s >= need);
        const label = (y) => (summer ? String(y) : `${y}–${String(y + 1).slice(2)}`);
        const period = `${fmtDay(start, { month: "short", day: "numeric" })} to ${fmtDay(latest, { month: "short", day: "numeric" })}`;
        const ord = (n) => `${n}${["th", "st", "nd", "rd"][(n % 100 > 10 && n % 100 < 14) ? 0 : Math.min(n % 10, 4) % 4] || "th"}`;
        const warmRank = rankOf("tmean", true);
        const coldRank = rankOf("tmean", false);
        const trs = [];
        const row = (name, val, normal, rec, fmt = (v) => String(Math.round(v))) => trs.push(h("tr", {},
          h("th", { scope: "row", text: name }),
          h("td", { text: isNum(val) ? fmt(val) : "–" }),
          h("td", { text: isNum(normal) ? fmt(normal) : "–" }),
          h("td", { text: rec && isNum(rec.value) ? `${fmt(rec.value)} (${label(rec.year)})` : "–" })));
        row("Mean temperature", cur.tmean, avg("tmean"), recordOf("tmean", summer), (v) => `${v.toFixed(1)}${U.t}`);
        const sfacts = {
          season: summer ? "summer" : "winter", period, years_compared: good.length,
          mean_temperature: round(cur.tmean, 1), mean_temperature_1991_2020: round(avg("tmean"), 1),
          rank_warmest: warmRank, rank_coldest: coldRank,
        };
        if (summer) {
          T.hot.forEach((t, i) => {
            row(`Days ${t}${U.t} or hotter`, cur[`hot${i}`], avg(`hot${i}`), recordOf(`hot${i}`, true), (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1)));
            sfacts[`days_${t}_or_hotter`] = { this_season: cur[`hot${i}`], avg_1991_2020: round(avg(`hot${i}`), 1), record: recordOf(`hot${i}`, true) };
          });
          row(`Nights ${T.night}${U.t} or warmer`, cur.nights, avg("nights"), recordOf("nights", true), (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1)));
          sfacts.warm_nights = { this_season: cur.nights, avg_1991_2020: round(avg("nights"), 1), record: recordOf("nights", true) };
          row("Hottest high", cur.max_hi, avg("max_hi"), recordOf("max_hi", true), F.t);
          sfacts.hottest_high = { value: round(cur.max_hi), date: cur.max_hi_date };
        } else {
          row(`Days with a low of ${T.frigid}${U.t} or colder`, cur.frigid, avg("frigid"), recordOf("frigid", true), (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1)));
          row(`Days with a high of ${T.icy}${U.t} or colder`, cur.icy, avg("icy"), recordOf("icy", true), (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1)));
          row("Coldest low", cur.min_lo, avg("min_lo"), recordOf("min_lo", false), F.t);
          sfacts.frigid_days = { this_season: cur.frigid, avg_1991_2020: round(avg("frigid"), 1), record: recordOf("frigid", true) };
          sfacts.days_below_freezing_all_day = { this_season: cur.icy, avg_1991_2020: round(avg("icy"), 1), record: recordOf("icy", true) };
          sfacts.coldest_low = { value: round(cur.min_lo), date: cur.min_lo_date };
          if (hasSnow && cur.n_s >= need && sGood.length >= 15) {
            const sBase = sGood.filter((r) => r.sy >= 1991 && r.sy <= 2020 && r.sy !== sy);
            row("Snowfall", cur.snow_total, avg("snow_total", sBase), recordOf("snow_total", true), F.s);
            row(`Days with ${U.us ? "1 in" : "2.5 cm"} or more of snow`, cur.snowdays, avg("snowdays", sBase), recordOf("snowdays", true), (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1)));
            sfacts.snowfall = { this_season: round(cur.snow_total, 1), avg_1991_2020: round(avg("snow_total", sBase), 1), rank_snowiest: rankOf("snow_total", true, sGood), biggest_day: { value: round(cur.max_snow, 1), date: cur.max_snow_date } };
          }
        }
        if (hasP && cur.n_p >= need && pGood.length >= 15) {
          const pBase = pGood.filter((r) => r.sy >= 1991 && r.sy <= 2020 && r.sy !== sy);
          row("Precipitation", cur.prcp_total, avg("prcp_total", pBase), recordOf("prcp_total", true), F.p);
          row("Wettest day", cur.max_prcp, avg("max_prcp", pBase), recordOf("max_prcp", true), F.p);
          sfacts.precipitation = { this_season: round(cur.prcp_total, U.pd), avg_1991_2020: round(avg("prcp_total", pBase), U.pd), rank_wettest: rankOf("prcp_total", true, pGood), wettest_day: { value: round(cur.max_prcp, U.pd), date: cur.max_prcp_date } };
        }
        const chartRows = good.map((r) => ({ year: r.sy, value: round(r.tmean, 1), current: r.sy === sy ? "This season" : "Other years" }));
        const base30 = avg("tmean");
        section("season", summer ? "How hot is this summer?" : "How cold is this winter?",
          h("p", { className: "alm-rank", text: `${period}: the ${ord(summer ? warmRank.rank : coldRank.rank)} ${summer ? "warmest" : "coldest"} of ${good.length} ${summer ? "summers" : "winters"} on record here.` }),
          chart({
            width: "container", height: 200,
            data: { values: chartRows },
            layer: [
              {
                mark: { type: "point", filled: true },
                encoding: {
                  x: { field: "year", type: "quantitative", title: summer ? "Summer" : "Winter beginning in", scale: { zero: false }, axis: { format: "d" } },
                  y: { field: "value", type: "quantitative", title: `Mean temperature, ${period} (${U.t})`, scale: { zero: false } },
                  color: { field: "current", type: "nominal", title: null, scale: { domain: ["This season", "Other years"], range: [summer ? COLORS.warm : COLORS.cool, "#aaabab"] }, legend: { orient: "bottom" } },
                  size: { field: "current", type: "nominal", scale: { domain: ["This season", "Other years"], range: [120, 30] }, legend: null },
                  tooltip: [{ field: "year", format: "d" }, { field: "value", format: ".1f" }],
                },
              },
              ...(isNum(base30) ? [{ data: { values: [{ v: round(base30, 1), label: "1991–2020 average" }] }, layer: [
                { mark: { type: "rule", color: COLORS.normal, strokeDash: [6, 4] }, encoding: { y: { field: "v", type: "quantitative" } } },
                { mark: { type: "text", align: "left", dx: 4, dy: -6, color: COLORS.normal, fontSize: 11 }, encoding: { x: { value: 0 }, y: { field: "v", type: "quantitative" }, text: { field: "label" } } },
              ] }] : []),
            ],
          }, "Season-to-date mean temperature by year"),
          h("div", { className: "alm-scroll" }, h("table", { className: "alm-table" },
            h("thead", {}, h("tr", {}, h("th", { scope: "col", text: period }), h("th", { scope: "col", text: "This season" }),
              h("th", { scope: "col", text: "1991–2020 average" }), h("th", { scope: "col", text: "Record (season)" }))),
            h("tbody", {}, trs))));
        facts.season = sfacts;
      }
    }
  }

  // ---- 5. Degree days, year to date
  if (hasT && latest && latest >= `${year}-01-15`) {
    const dd = await g.sql(`
      SELECT strftime(a.date, '%Y-%m-%d') AS date, a.gdd, a.hdd, a.cdd, n.gdd AS n_gdd, n.hdd AS n_hdd, n.cdd AS n_cdd
      FROM alm_daily a JOIN alm_norm n ON n.md = strftime(a.date, '%m-%d')
      WHERE a.date BETWEEN DATE '${year}-01-01' AND DATE ${sq(latest)} AND a.gdd IS NOT NULL ORDER BY a.date`);
    const sum = (k) => dd.reduce((s, r) => s + (isNum(r[k]) ? r[k] : 0), 0);
    const totals = ["gdd", "hdd", "cdd"].map((k) => ({ k, actual: sum(k), normal: sum(`n_${k}`) }));
    const label = { gdd: `Growing degree days (base ${U.gddBase}°, capped at ${U.gddCap}°)`, hdd: `Heating degree days (base ${U.dd}°)`, cdd: `Cooling degree days (base ${U.dd}°)` };
    const totalDays = Math.round((Date.parse(latest) - Date.parse(`${year}-01-01`)) / 864e5) + 1;
    let cg = 0;
    let cgn = 0;
    const gRows = [];
    for (const r of dd) {
      cg += r.gdd;
      cgn += isNum(r.n_gdd) ? r.n_gdd : 0;
      gRows.push({ date: r.date, series: "This year", value: Math.round(cg) }, { date: r.date, series: "Normal", value: Math.round(cgn) });
    }
    section("degree_days", "Degree days this year",
      h("div", { className: "alm-scroll" }, h("table", { className: "alm-table" },
        h("thead", {}, h("tr", {}, h("th", { scope: "col", text: `January 1 to ${fmtDay(latest, { month: "long", day: "numeric" })}` }),
          h("th", { scope: "col", text: "This year" }), h("th", { scope: "col", text: "Normal" }), h("th", { scope: "col", text: "Departure" }))),
        h("tbody", {}, totals.map((x) => h("tr", {}, h("th", { scope: "row", text: label[x.k] }),
          h("td", { text: Math.round(x.actual).toLocaleString() }),
          h("td", { text: Math.round(x.normal).toLocaleString() }),
          h("td", { text: `${x.actual - x.normal >= 0 ? "+" : "−"}${Math.abs(Math.round(x.actual - x.normal)).toLocaleString()}${x.normal ? ` (${Math.round((100 * x.actual) / x.normal)}% of normal)` : ""}` })))))),
      dd.length < totalDays - 3 ? h("p", { className: "fine", text: `${totalDays - dd.length} days without both a high and a low are left out of both columns.` }) : null,
      h("h3", { text: "Growing degree days so far" }),
      chart(cumulativeChart(gRows, U, "GDD", "Cumulative growing degree days", ["This year", "Normal"], [COLORS.warm, COLORS.normal]), "Cumulative growing degree days against normal"));
    facts.degree_days = Object.fromEntries(totals.map((x) => [x.k, { this_year: Math.round(x.actual), normal: Math.round(x.normal), percent_of_normal: x.normal ? Math.round((100 * x.actual) / x.normal) : null }]));
    facts.degree_days.through = latest;
  }

  // ---- Footer
  page.append(h("footer", { className: "alm-foot" },
    h("p", { className: "alm-ai", text: "This almanac is generated automatically. Its numbers are computed from NOAA data, and the text in the blue boxes is written by an AI model, so it may make mistakes; check important values against the sources." }),
    h("p", { className: "fine", text: `Sources: NOAA NCEI GHCN-Daily (station ${st.id})${provisional.size ? `, with ${[...provisional].sort()[0]} onward from the NOAA Regional Climate Centers' ACIS (provisional, not yet in GHCN-Daily)` : ""}; NOAA NCEI U.S. Climate Normals 1991–2020${source.temperature?.startsWith("NOAA") ? "" : " (not available for this station; normals computed from its own 1991–2020 data)"}; National Weather Service forecast${fc ? ` (NDFD grid ${fc.nws_grid}, issued ${new Date(fc.issued).toLocaleString()})` : ""}. Records use this station's own history and may differ from official records.` })));

  // ---- Text: templates now, the model's when it answers
  const templates = templateText(facts, U, F);
  for (const [k, box] of Object.entries(boxes)) box.textContent = templates[k] || "";
  onStatus("Drawing charts");
  for (const [fig, spec] of charts) {
    try {
      await deps.embedChart(fig, spec);
    } catch (err) {
      fig.replaceChildren(h("p", { className: "fine", text: `Chart unavailable: ${err.message}` }));
      deps.logEvent("almanac chart", err.message);
    }
  }
  onStatus("");
  if (deps.lumen.getKey()) {
    onStatus("Writing summaries");
    for (const box of Object.values(boxes)) box.classList.add("alm-pending");
    try {
      const n = await narrate(facts);
      for (const [k, box] of Object.entries(boxes)) {
        const t = n?.text?.[k];
        if (typeof t === "string" && t.trim()) box.innerHTML = deps.renderMarkdown(t);
      }
      page.querySelector(".alm-ai").textContent += ` Text written by ${n.model} via Lumen.`;
    } catch (err) {
      deps.logEvent("almanac narrative", err.message);
      page.querySelector(".alm-ai").textContent += " (The AI text could not be generated this time; the boxes show plain summaries.)";
    } finally {
      for (const box of Object.values(boxes)) box.classList.remove("alm-pending");
      onStatus("");
    }
  } else {
    page.querySelector(".alm-ai").textContent += " Sign in to Lumen on the GHCN chat tab for AI-written summaries; until then the boxes show plain summaries.";
  }
  return { station: st, facts, asOf: historical ? D : null };
}

// ---------------------------------------------------------------------------
// Plain templated text, used before (or instead of) the model's.

function templateText(f, U, F) {
  const out = {};
  const n = f.now;
  if (n) {
    const parts = [];
    const l = n.latest_report;
    if (l && isNum(l.high)) {
      parts.push(`${n.latest_label === "Yesterday" ? "Yesterday" : `On ${fmtDay(l.date, { month: "long", day: "numeric" })}`} the high was ${F.t(l.high)}${isNum(l.high_vs_normal) ? `, ${F.dep(l.high_vs_normal)} from normal` : ""}, and the low ${F.t(l.low)}${isNum(l.low_vs_normal) ? ` (${F.dep(l.low_vs_normal)})` : ""}.`);
    }
    const t = n.today_forecast;
    if (t && isNum(t.high)) {
      parts.push(`Today's forecast high of ${F.t(t.high)} is ${t.high_class ? `${t.high_class}, against` : "compared with"} a normal of ${F.t(t.normal_high)}${isNum(t.record_high) ? `; the record for the date is ${F.t(t.record_high)} from ${t.record_high_year}` : ""}.`);
    }
    out.now = parts.join(" ");
  }
  const o = f.outlook;
  if (o) {
    const fcDays = o.days.filter((d) => d.kind === "forecast" && isNum(d.high));
    const obsDays = o.days.filter((d) => d.kind === "observed" && isNum(d.high));
    const avg = (a, k) => (a.length ? a.reduce((s, d) => s + (d[k] || 0), 0) / a.length : null);
    const parts = [];
    if (obsDays.length) parts.push(`The past ${obsDays.length} days averaged ${F.dep(avg(obsDays, "high_vs_normal"), 1)} from normal for highs and ${F.dep(avg(obsDays, "low_vs_normal"), 1)} for lows.`);
    if (fcDays.length) {
      parts.push(`The forecast runs ${F.dep(avg(fcDays, "high_vs_normal"), 1)} from normal for highs over the next ${fcDays.length} days.`);
      const notable = fcDays.filter((d) => d.high_class && d.high_class !== "near normal").map((d) => `${fmtDay(d.date, { weekday: "long" })} (${d.high_class})`);
      if (notable.length) parts.push(`Days that stand out: ${notable.join(", ")}.`);
    }
    out.outlook = parts.join(" ");
  }
  const y = f.past_year;
  if (y) {
    const parts = [];
    if (isNum(y.mean_temperature_vs_normal)) parts.push(`Over the past year the average temperature ran ${F.dep(y.mean_temperature_vs_normal, 1)} from normal, with ${y.days_warmer_than_normal} warmer-than-normal days and ${y.days_colder_than_normal} colder ones.`);
    if (y.precipitation) parts.push(`Precipitation totaled ${F.p(y.precipitation.total)}, ${y.precipitation.percent_of_normal}% of the normal ${F.p(y.precipitation.normal)}.`);
    if (y.snow_seasons?.length) parts.push(y.snow_seasons.map((s) => `${s.season}: ${F.s(s.total)} of snow against ${F.s(s.normal_for_same_period)} normal`).join("; ") + ".");
    out.past_year = parts.join(" ");
  }
  const fr = f.frost;
  if (fr) {
    const md2 = (m) => fmtDay(`2000-${m}`, { month: "short", day: "numeric" });
    out.frost = fr.thresholds.map((t) => {
      const what = t.this_season && t.status === "occurred" ? `came ${fmtDay(t.this_season, { month: "short", day: "numeric" })}`
        : t.forecast_date ? `is in the forecast for ${fmtDay(t.forecast_date, { weekday: "long", month: "short", day: "numeric" })}`
        : t.possible_date ? `is possible ${fmtDay(t.possible_date, { weekday: "long" })} (forecast low ${F.t(t.possible_forecast_low)})`
        : t.status;
      return `${t.threshold} ${what}${t.median_date ? `; the median date is ${md2(t.median_date)}` : ""}. ${t.comparison}.`;
    }).join(" ");
  }
  const se = f.season;
  if (se) {
    const r = se.season === "summer" ? se.rank_warmest : se.rank_coldest;
    const parts = [`From ${se.period}, this ${se.season} averaged ${F.t(se.mean_temperature)} against a 1991–2020 average of ${F.t(se.mean_temperature_1991_2020)}, ranking ${r.rank} of ${r.of} ${se.season === "summer" ? "for warmth" : "for cold"}.`];
    if (se.precipitation) parts.push(`Precipitation is ${F.p(se.precipitation.this_season)} against an average of ${F.p(se.precipitation.avg_1991_2020)}.`);
    if (se.snowfall) parts.push(`Snowfall is ${F.s(se.snowfall.this_season)} against an average of ${F.s(se.snowfall.avg_1991_2020)}.`);
    out.season = parts.join(" ");
  }
  const d = f.degree_days;
  if (d) {
    out.degree_days = `Since January 1: ${d.gdd.this_year.toLocaleString()} growing degree days (${d.gdd.percent_of_normal}% of normal), ${d.hdd.this_year.toLocaleString()} heating degree days (${d.hdd.percent_of_normal}%) and ${d.cdd.this_year.toLocaleString()} cooling degree days (${d.cdd.percent_of_normal}%).`;
  }
  return out;
}
