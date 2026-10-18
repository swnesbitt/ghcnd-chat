// annual.js — the Annual climate tab: one year of daily observations for a
// GHCN-Daily station against its 1991-2020 normals and its records, for
// temperature, precipitation and snowfall, with the station's climate
// (Köppen class, extremes, year-to-year record) summarized below each chart.
//
// As on the Daily almanac, every number is computed here from the station's
// GHCN-Daily record and NOAA's normals; the model only writes the summaries,
// and plain templated text stands in without a Lumen key.

import { unitsFor, formatters, MONTH_DAYS, resolveStation, officialNormals, computedNormals } from "./almanac.js";

let deps = null;
export function initAnnual(d) {
  deps = d;
}

// ---------------------------------------------------------------------------
// Helpers

const h = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "className") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? "" : v);
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return node;
};
const sq = (s) => `'${String(s).replace(/'/g, "''")}'`;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const fmtDay = (s, opts = { month: "short", day: "numeric", year: "numeric" }) =>
  new Date(`${s}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", ...opts });
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const ord = (n) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
};
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS_IN = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
// Month-days of a snow season, July 1 to June 30 (Feb 29 included; skipped in common years).
const SEASON_MDS = [...MONTH_DAYS.slice(MONTH_DAYS.indexOf("07-01")), ...MONTH_DAYS.slice(0, MONTH_DAYS.indexOf("07-01"))];
const seasonLabel = (s) => `${s}–${String(s + 1).slice(2)}`;

const COLORS = {
  warm: "#c84113", cool: "#1d58a7", ink: "#13294b", normal: "#707372",
  recordBand: "#e6e9ef", normalBand: "#bcc6d6", precip: "#009fd4", snow: "#5e7fb3",
  wetBand: "#e1f1f8", snowBand: "#e6ebf4", select: "#ff5f05",
};

// ---------------------------------------------------------------------------
// Köppen-Geiger classification (Peel et al. 2007; Beck et al. 2018), from
// monthly mean temperature (°C) and precipitation (mm).

const KOPPEN_NAMES = {
  Af: "tropical rainforest", Am: "tropical monsoon", Aw: "tropical savanna", As: "tropical savanna (dry summer)",
  BWh: "hot desert", BWk: "cold desert", BSh: "hot semi-arid", BSk: "cold semi-arid",
  Csa: "hot-summer Mediterranean", Csb: "warm-summer Mediterranean", Csc: "cold-summer Mediterranean",
  Cwa: "monsoon-influenced humid subtropical", Cwb: "subtropical highland", Cwc: "cold subtropical highland",
  Cfa: "humid subtropical", Cfb: "temperate oceanic", Cfc: "subpolar oceanic",
  Dsa: "hot-summer continental (dry summer)", Dsb: "warm-summer continental (dry summer)", Dsc: "subarctic (dry summer)", Dsd: "extremely cold subarctic (dry summer)",
  Dwa: "monsoon-influenced hot-summer humid continental", Dwb: "monsoon-influenced warm-summer humid continental", Dwc: "monsoon-influenced subarctic", Dwd: "monsoon-influenced extremely cold subarctic",
  Dfa: "hot-summer humid continental", Dfb: "warm-summer humid continental", Dfc: "subarctic", Dfd: "extremely cold subarctic",
  ET: "tundra", EF: "ice cap",
};

export function koppen(T, P, lat) {
  const MAT = T.reduce((a, b) => a + b, 0) / 12;
  const MAP = P.reduce((a, b) => a + b, 0);
  const Thot = Math.max(...T);
  const Tcold = Math.min(...T);
  const Tmon10 = T.filter((t) => t > 10).length;
  const north = lat >= 0;
  const summer = north ? [3, 4, 5, 6, 7, 8] : [9, 10, 11, 0, 1, 2]; // Apr-Sep or Oct-Mar
  const winter = [...Array(12).keys()].filter((m) => !summer.includes(m));
  const Ps = summer.map((m) => P[m]);
  const Pw = winter.map((m) => P[m]);
  const sumS = Ps.reduce((a, b) => a + b, 0);
  const sumW = Pw.reduce((a, b) => a + b, 0);
  const Pdry = Math.min(...P);
  const Psdry = Math.min(...Ps);
  const Pswet = Math.max(...Ps);
  const Pwdry = Math.min(...Pw);
  const Pwwet = Math.max(...Pw);
  const Pth = sumW >= 0.7 * MAP ? 2 * MAT : sumS >= 0.7 * MAP ? 2 * MAT + 28 : 2 * MAT + 14;
  const facts = { mean_annual_temp_c: +MAT.toFixed(1), annual_precip_mm: Math.round(MAP), warmest_month_c: +Thot.toFixed(1), coldest_month_c: +Tcold.toFixed(1), months_above_10c: Tmon10, aridity_threshold_mm: Math.round(10 * Pth) };
  let code;
  if (Thot < 10) code = Thot > 0 ? "ET" : "EF";
  else if (MAP < 10 * Pth) code = (MAP < 5 * Pth ? "BW" : "BS") + (MAT >= 18 ? "h" : "k");
  else if (Tcold >= 18) code = Pdry >= 60 ? "Af" : Pdry >= 100 - MAP / 25 ? "Am" : "Aw";
  else {
    const first = Tcold > 0 ? "C" : "D";
    const second = Psdry < 40 && Psdry < Pwwet / 3 ? "s" : Pwdry < Pswet / 10 ? "w" : "f";
    const third = Thot >= 22 ? "a" : Tmon10 >= 4 ? "b" : first === "D" && Tcold < -38 ? "d" : "c";
    code = first + second + third;
  }
  return { code, name: KOPPEN_NAMES[code] || code, ...facts };
}

// ---------------------------------------------------------------------------
// Charts (Vega-Lite)

// Stacked charts line up: same x domain and a fixed y-axis width.
const Y_AXIS = { minExtent: 44, maxExtent: 44 };

const hoverLayer = (tooltip) => ({
  params: [{ name: "hover", select: { type: "point", encodings: ["x"], nearest: true, on: "pointerover", clear: "pointerout" } }],
  mark: { type: "rule", color: "#4a4a4a", strokeWidth: 1 },
  encoding: { opacity: { condition: { param: "hover", empty: false, value: 0.45 }, value: 0 }, tooltip },
});

const dayX = (domain, format = "%b") => ({
  field: "date", type: "temporal", scale: { type: "utc", domain },
  axis: { format, labelAngle: 0, tickCount: 12, title: null, grid: true },
});

function tempSpec(rows, year, U) {
  const y = (field) => ({ field, type: "quantitative", title: U.t, scale: { zero: false }, axis: Y_AXIS });
  return {
    width: "container", height: 320,
    data: { values: rows },
    encoding: { x: dayX([`${year}-01-01`, `${year}-12-31`]) },
    layer: [
      { mark: { type: "area", color: COLORS.recordBand }, encoding: { y: y("rec_lo"), y2: { field: "rec_hi" } } },
      { mark: { type: "area", color: COLORS.normalBand }, encoding: { y: y("norm_lo"), y2: { field: "norm_hi" } } },
      {
        transform: [{ filter: "isValid(datum.obs_hi) && isValid(datum.obs_lo)" }],
        mark: { type: "rule", strokeWidth: 2 },
        encoding: {
          y: y("obs_lo"), y2: { field: "obs_hi" },
          color: { condition: { test: "datum.obs_hi + datum.obs_lo >= datum.norm_hi + datum.norm_lo", value: COLORS.warm }, value: COLORS.cool },
        },
      },
      { transform: [{ filter: "datum.set_hi" }], mark: { type: "point", shape: "triangle-up", filled: true, size: 45, color: COLORS.warm, stroke: "white", strokeWidth: 0.5 }, encoding: { y: y("obs_hi") } },
      { transform: [{ filter: "datum.set_lo" }], mark: { type: "point", shape: "triangle-down", filled: true, size: 45, color: COLORS.cool, stroke: "white", strokeWidth: 0.5 }, encoding: { y: y("obs_lo") } },
      hoverLayer([
        { field: "t_date", title: "Date" }, { field: "t_obs", title: "Observed" }, { field: "t_norm", title: "Normal" },
        { field: "t_mean", title: "Mean, all years" }, { field: "t_rec_hi", title: "Record high" }, { field: "t_rec_lo", title: "Record low" },
      ]),
    ],
  };
}

function cumulativeSpec(rows, domain, U, unit, label, color, band) {
  const y = (field) => ({ field, type: "quantitative", title: `${label} (${unit})`, axis: Y_AXIS });
  return {
    width: "container", height: 280,
    data: { values: rows },
    encoding: { x: dayX(domain) },
    layer: [
      { mark: { type: "area", color: band }, encoding: { y: y("env_lo"), y2: { field: "env_hi" } } },
      { mark: { type: "line", color: COLORS.normal, strokeDash: [6, 4], strokeWidth: 1.5 }, encoding: { y: y("norm_cum") } },
      { transform: [{ filter: "isValid(datum.cum)" }], mark: { type: "line", color, strokeWidth: 2.5 }, encoding: { y: y("cum") } },
      hoverLayer([
        { field: "t_date", title: "Date" }, { field: "t_day", title: "That day" }, { field: "t_cum", title: "Total so far" },
        { field: "t_norm", title: "Normal so far" }, { field: "t_hi", title: "Most so far" }, { field: "t_lo", title: "Least so far" },
        { field: "t_rec", title: "Record for the date" },
      ]),
    ],
  };
}

function dailyBarsSpec(rows, domain, U, unit, label, color) {
  return {
    width: "container", height: 110,
    data: { values: rows.filter((r) => isNum(r.day) && r.day > 0).map((r) => ({ ...r,
      d0: new Date(Date.parse(`${r.date}T00:00:00Z`) - 0.45 * 864e5).toISOString(), d1: new Date(Date.parse(`${r.date}T00:00:00Z`) + 0.45 * 864e5).toISOString() })) },
    mark: { type: "rect", color, clip: true },
    encoding: {
      x: { ...dayX(domain), field: "d0" },
      x2: { field: "d1" },
      y: { field: "day", type: "quantitative", title: `${label} (${unit})`, axis: { tickCount: 3, ...Y_AXIS } },
      y2: { datum: 0 },
      tooltip: [{ field: "t_date", title: "Date" }, { field: "t_day", title: label }, { field: "t_rec", title: "Record for the date" }],
    },
  };
}

function annualTempSpec(rows, sel, normal) {
  const x = { field: "year", type: "quantitative", title: null, axis: { format: "d", labelAngle: 0 }, scale: { zero: false, nice: false } };
  const y = { field: "value", type: "quantitative", title: null, scale: { zero: false } };
  const color = { field: "series", type: "nominal", title: null, scale: { domain: ["Mean high", "Mean low"], range: [COLORS.warm, COLORS.cool] }, legend: { orient: "bottom" } };
  return {
    width: "container", height: 200,
    data: { values: rows },
    layer: [
      { mark: { type: "line", strokeWidth: 1, opacity: 0.6 }, encoding: { x, y, color } },
      { transform: [{ regression: "value", on: "year", groupby: ["series"] }], mark: { type: "line", strokeDash: [5, 4], strokeWidth: 1.5 }, encoding: { x, y, color } },
      {
        mark: { type: "point", filled: true, cursor: "pointer" },
        encoding: {
          x, y, color,
          size: { condition: { test: `datum.year === ${sel}`, value: 140 }, value: 22 },
          stroke: { condition: { test: `datum.year === ${sel}`, value: COLORS.select }, value: null },
          strokeWidth: { value: 2.5 },
          tooltip: [{ field: "year", title: "Year", format: "d" }, { field: "series" }, { field: "t_value", title: "Value" }, { field: "t_rank", title: "Rank" }],
        },
      },
      ...(normal ? [{ data: { values: normal }, mark: { type: "rule", strokeDash: [2, 3], strokeWidth: 1 }, encoding: { y: { field: "value", type: "quantitative" }, color } }] : []),
    ],
  };
}

function annualBarsSpec(rows, sel, normal, unit, color, label) {
  return {
    width: "container", height: 180,
    data: { values: rows },
    layer: [
      {
        mark: { type: "bar", cursor: "pointer", width: { band: 0.85 } },
        encoding: {
          x: { field: "year", type: "ordinal", title: null, axis: { labelExpr: "datum.value % 10 === 0 ? datum.value : ''", labelAngle: 0, ticks: false } },
          y: { field: "value", type: "quantitative", title: `${label} (${unit})` },
          color: { condition: { test: `datum.year === ${sel}`, value: COLORS.select }, value: color },
          tooltip: [{ field: "t_year", title: label.includes("Snow") ? "Season" : "Year" }, { field: "t_value", title: label }, { field: "t_rank", title: "Rank" }],
        },
      },
      ...(isNum(normal) ? [{ data: { values: [{ v: normal }] }, mark: { type: "rule", color: COLORS.normal, strokeDash: [6, 4] }, encoding: { y: { field: "v", type: "quantitative" } } }] : []),
    ],
  };
}

// ---------------------------------------------------------------------------
// Narrative

const NARRATOR = `You write the climate summaries under the charts of a station's annual climate page, for a curious general audience. You get a JSON summary of numbers computed from NOAA data. Use only those numbers; never invent values, dates, records or causes. Return only a JSON object with these string fields:
- "temperature": 4-6 sentences. Start with the Köppen climate classification (code and name) and what it means at this place, citing the deciding numbers given (warmest and coldest month means, months above 10 °C, aridity threshold where relevant). Then the seasonal cycle and notable all-time temperature extremes with their dates, and the long-term trend if given. End with how the selected year compares (rank, notable days, records set), saying "so far" for a partial year.
- "precipitation": 3-5 sentences: how much falls and when (wettest and driest months), notable extremes (wettest day, wettest and driest years with years), then the selected year against normal and its rank ("so far" for a partial year).
- "snowfall": 3-4 sentences on the snow climate (average season total, snowiest month, extremes with dates and seasons) and the selected season; or "" if the input has no snowfall section.
Plain sentences, Unicode symbols (°, −, ≤), the units given, no LaTeX, no headings, no lists.`;

async function narrate(facts) {
  if (!deps.lumen.getKey()) return null;
  const model = deps.getModel();
  if (!model) return null;
  const resp = await deps.lumen.api("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, temperature: 0.4, messages: [{ role: "system", content: NARRATOR }, { role: "user", content: JSON.stringify(facts) }] }),
  });
  const body = await resp.json();
  const text = body.choices?.[0]?.message?.content || "";
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("The model did not return JSON for the summaries.");
  return { text: JSON.parse(m[0]), model };
}

function templateText(f, F) {
  const out = {};
  const k = f.koppen;
  const t = f.temperature;
  if (t) {
    const parts = [];
    if (k) parts.push(`${f.station.name} has a ${k.name} climate (Köppen ${k.code}): the warmest month averages ${k.warmest_month_c} °C and the coldest ${k.coldest_month_c} °C, with ${k.months_above_10c} months above 10 °C.`);
    if (t.normals) parts.push(`Normal highs run from ${F.t(t.normals.coldest_month_high)} in ${t.normals.coldest_month} to ${F.t(t.normals.warmest_month_high)} in ${t.normals.warmest_month}.`);
    if (t.extremes?.highest) parts.push(`The station's highest reading is ${F.t(t.extremes.highest.value)} on ${fmtDay(t.extremes.highest.date)}, and its lowest ${F.t(t.extremes.lowest.value)} on ${fmtDay(t.extremes.lowest.date)}.`);
    const s = t.selected;
    if (s && isNum(s.mean)) parts.push(`${s.label} averaged ${F.t(s.mean)} (${F.dep(s.mean - s.normal_mean, 1)} from normal)${s.rank ? `, the ${s.rank}` : ""}.`);
    out.temperature = parts.join(" ");
  }
  const p = f.precipitation;
  if (p) {
    const parts = [];
    if (p.normals) parts.push(`About ${F.p(p.normals.annual)} falls in a normal year, most in ${p.normals.wettest_month} and least in ${p.normals.driest_month}.`);
    if (p.extremes?.wettest_day) parts.push(`The wettest day on record brought ${F.p(p.extremes.wettest_day.value)} on ${fmtDay(p.extremes.wettest_day.date)}.`);
    const s = p.selected;
    if (s && isNum(s.total)) parts.push(`${s.label} has ${F.p(s.total)}, ${s.percent_of_normal}% of normal${s.rank ? `, the ${s.rank}` : ""}.`);
    out.precipitation = parts.join(" ");
  }
  const sn = f.snowfall;
  if (sn) {
    const parts = [];
    if (isNum(sn.normal_season)) parts.push(`A normal season brings ${F.s(sn.normal_season)} of snow.`);
    if (sn.extremes?.snowiest_season) parts.push(`The snowiest season on record was ${sn.extremes.snowiest_season.season} with ${F.s(sn.extremes.snowiest_season.value)}.`);
    const s = sn.selected;
    if (s && isNum(s.total)) parts.push(`The ${s.label} season has ${F.s(s.total)}${s.rank ? `, the ${s.rank}` : ""}.`);
    out.snowfall = parts.join(" ");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ranks

function rankText(rows, key, value, sel, hiWord, loWord) {
  const good = rows.filter((r) => isNum(r[key]));
  if (!isNum(value) || good.length < 10) return null;
  const hi = 1 + good.filter((r) => r[key] > value).length;
  const lo = 1 + good.filter((r) => r[key] < value).length;
  const ties = good.filter((r) => r[key] === value && r.k !== sel).length;
  const tie = ties ? " (tied)" : "";
  return hi <= lo ? `${ord(hi)} ${hiWord} of ${good.length}${tie}` : `${ord(lo)} ${loWord} of ${good.length}${tie}`;
}

// ---------------------------------------------------------------------------
// Main

export async function renderAnnual(out, input, { onStatus = () => {}, year = null, onYear = () => {} } = {}) {
  out.replaceChildren();
  onStatus("Starting the database");
  const g = await deps.startData();
  onStatus("Finding the station");
  const st = await resolveStation(g, input);
  const U = unitsFor(st.country);
  const F = { ...formatters(U), t1: (v) => (isNum(v) ? `${v.toFixed(1)}${U.t}` : "–") };
  const hot = U.us ? 90 : 32;
  const freeze = U.us ? 32 : 0;
  const heavy = U.us ? 1 : 25;
  const snowDay = U.us ? 1 : 2.5;

  onStatus(`Loading ${st.name}'s full record and normals`);
  const [series, official] = await Promise.allSettled([
    g.loadSeries({ station: st.id, elements: ["TMAX", "TMIN", "PRCP", "SNOW"] }),
    U.us ? officialNormals(st.id) : Promise.resolve(null),
  ]);
  if (series.status === "rejected") throw series.reason;
  const loaded = new Set(series.value.results.filter((r) => r.loaded).map((r) => r.element));
  const hasT = loaded.has("TMAX") && loaded.has("TMIN");
  const hasP = loaded.has("PRCP");
  const hasS = loaded.has("SNOW");
  if (!hasT && !hasP) throw new Error(`${st.name} (${st.id}) has no temperature or precipitation record.`);

  // The last 10 days the station has not reported, from the nearest station that has them.
  const today = new Date().toLocaleDateString("en-CA");
  const shift = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
  try {
    await g.fillNeighbors({ station: st.id, elements: ["TMAX", "TMIN", "PRCP", "SNOW"], start_date: shift(today, -10), end_date: shift(today, -1) });
  } catch (err) {
    deps.logEvent("annual nearby fill", err.message);
  }
  const subRows = await g.sql(`SELECT element, strftime(date, '%Y-%m-%d') AS d, source, source_name, distance_km FROM substituted WHERE station = ${sq(st.id)}`);
  const subBy = new Map(subRows.map((r) => [r.d, r]));
  const subTag = (date) => (subBy.has(date) ? ` * from ${subBy.get(date).source_name}` : "");

  onStatus("Computing normals, records and yearly statistics");
  await g.sql(`
    CREATE OR REPLACE TABLE ann_daily AS
    WITH p AS (
      SELECT date,
        max(CASE WHEN element = 'TMAX' THEN value END) AS tmax_c,
        max(CASE WHEN element = 'TMIN' THEN value END) AS tmin_c,
        max(CASE WHEN element = 'PRCP' THEN value END) AS prcp_mm,
        max(CASE WHEN element = 'SNOW' THEN value END) AS snow_mm
      FROM obs WHERE station = ${sq(st.id)} GROUP BY date)
    SELECT date, strftime(date, '%m-%d') AS md, year(date) AS yr,
      year(date) - CASE WHEN month(date) < 7 THEN 1 ELSE 0 END AS season,
      round(${U.tSql.replace(/value/g, "tmax_c")}, 1) AS tmax, round(${U.tSql.replace(/value/g, "tmin_c")}, 1) AS tmin,
      ${U.pSql.replace(/value/g, "prcp_mm")} AS prcp, ${U.sSql.replace(/value/g, "snow_mm")} AS snow,
      tmax_c, tmin_c, prcp_mm,
      NULL::DOUBLE AS gdd, NULL::DOUBLE AS hdd, NULL::DOUBLE AS cdd
    FROM p`);
  const provisional = new Set((await g.sql(`SELECT DISTINCT strftime(date, '%Y-%m-%d') AS d FROM provisional WHERE station = ${sq(st.id)}`)).map((r) => r.d));

  // Normals by month-day: NCEI first, else the station's own smoothed 1991-2020 means.
  const off = official.status === "fulfilled" ? official.value : null;
  const comp = await computedNormals(g, U, "ann_daily");
  const pick = (i, k) => (isNum(off?.days[i]?.[k]) ? off.days[i][k] : comp[i][k]);
  const norm = new Map(MONTH_DAYS.map((m, i) => [m, { tmax: pick(i, "tmax"), tmin: pick(i, "tmin"), prcp: pick(i, "prcp"), snow: pick(i, "snow") }]));
  const normSource = (k) => (off?.days.some((d) => isNum(d[k])) ? "NOAA 1991–2020 normals" : comp.some((d) => isNum(d[k])) ? "this station's 1991–2020 average" : null);

  // Records and all-years means by month-day (latest year wins ties).
  const recRows = await g.sql(`
    SELECT md,
      max(tmax) AS rec_hi, arg_max(yr, tmax + yr / 1e6) AS rec_hi_yr,
      min(tmin) AS rec_lo, arg_min(yr, tmin - yr / 1e6) AS rec_lo_yr,
      avg(tmax) AS mean_hi, avg(tmin) AS mean_lo,
      max(prcp) AS rec_p, arg_max(yr, prcp + yr / 1e9) AS rec_p_yr,
      max(snow) AS rec_s, arg_max(yr, snow + yr / 1e9) AS rec_s_yr
    FROM ann_daily GROUP BY md`);
  const rec = new Map(recRows.map((r) => [r.md, r]));

  const last = (await g.sql("SELECT strftime(max(date), '%Y-%m-%d') AS d, min(yr) AS y0 FROM ann_daily WHERE tmax IS NOT NULL OR prcp IS NOT NULL"))[0];
  const latest = last.d;
  const firstYear = last.y0;
  const thisYear = Number(latest.slice(0, 4));
  const years = (await g.sql("SELECT DISTINCT yr FROM ann_daily WHERE tmax IS NOT NULL OR prcp IS NOT NULL ORDER BY yr DESC")).map((r) => r.yr);
  const seasons = hasS ? (await g.sql("SELECT season FROM ann_daily WHERE snow IS NOT NULL GROUP BY season HAVING count(*) > 60 ORDER BY season DESC")).map((r) => r.season) : [];
  const latestSnowSeason = hasS ? (await g.sql("SELECT max(season) AS s FROM ann_daily WHERE snow > 0"))[0].s : null;

  // Köppen from the station's 1991-2020 monthly means (or its whole record if that period is thin).
  async function monthly(where) {
    return g.sql(`
      WITH m AS (
        SELECT yr, month(date) AS mo,
          avg((tmax_c + tmin_c) / 2) FILTER (WHERE tmax_c IS NOT NULL AND tmin_c IS NOT NULL) AS t,
          count(*) FILTER (WHERE tmax_c IS NOT NULL AND tmin_c IS NOT NULL) AS nt,
          sum(prcp_mm) AS p, count(prcp_mm) AS np
        FROM ann_daily ${where} GROUP BY 1, 2)
      SELECT mo, avg(t) FILTER (WHERE nt >= 20) AS t, count(*) FILTER (WHERE nt >= 20) AS yt,
        avg(p * ${"CASE mo WHEN 2 THEN 28.25 WHEN 4 THEN 30 WHEN 6 THEN 30 WHEN 9 THEN 30 WHEN 11 THEN 30 ELSE 31 END"} / np) FILTER (WHERE np >= 25) AS p,
        count(*) FILTER (WHERE np >= 25) AS yp
      FROM m GROUP BY mo ORDER BY mo`);
  }
  let mon = await monthly("WHERE yr BETWEEN 1991 AND 2020");
  let monPeriod = "1991–2020";
  if (mon.length < 12 || mon.some((r) => !(r.yt >= 10) || !(r.yp >= 10))) {
    mon = await monthly("");
    monPeriod = `${firstYear}–${thisYear}`;
  }
  const kp = mon.length === 12 && mon.every((r) => isNum(r.t) && isNum(r.p)) ? koppen(mon.map((r) => r.t), mon.map((r) => r.p), st.lat) : null;

  // ---- Yearly statistics for a period (Jan 1 to endMd), every year
  const doy = (mdKey) => MONTH_DAYS.indexOf(mdKey) + (mdKey > "02-28" ? 0 : 1); // days Jan 1..md in a common year
  async function yearStats(endMd) {
    const need = Math.floor(0.9 * doy(endMd));
    return g.sql(`
      SELECT yr AS k,
        count(tmax) AS n_hi, count(tmin) AS n_lo,
        avg(tmax) AS mean_hi, avg(tmin) AS mean_lo, avg((tmax + tmin) / 2) AS mean,
        max(tmax) AS max_hi, strftime(arg_max(date, tmax), '%Y-%m-%d') AS max_hi_d,
        min(tmin) AS min_lo, strftime(arg_min(date, tmin), '%Y-%m-%d') AS min_lo_d,
        count(*) FILTER (WHERE tmax >= ${hot}) AS d_hot, count(*) FILTER (WHERE tmin <= ${freeze}) AS d_frz,
        count(prcp) AS n_p, sum(prcp) AS total, max(prcp) AS max_p, strftime(arg_max(date, prcp), '%Y-%m-%d') AS max_p_d,
        count(*) FILTER (WHERE prcp >= ${U.wet}) AS d_wet, count(*) FILTER (WHERE prcp >= ${heavy}) AS d_heavy,
        ${need} AS need
      FROM ann_daily WHERE md <= ${sq(endMd)} AND md <> '02-29' OR (md = '02-29' AND ${sq(endMd)} >= '03-01')
      GROUP BY yr ORDER BY yr`);
  }
  const tValid = (r) => r.n_hi >= r.need && r.n_lo >= r.need;
  const pValid = (r) => r.n_p >= r.need;

  // ---- Snow seasons (Jul 1 to an end month-day), every season
  const winterDays = (endIdx) => SEASON_MDS.slice(0, endIdx + 1).filter((m) => m !== "02-29" && ["11", "12", "01", "02", "03"].includes(m.slice(0, 2))).length;
  async function seasonStats(endIdx) {
    const mds = SEASON_MDS.slice(0, endIdx + 1).map(sq).join(", ");
    return g.sql(`
      SELECT season AS k,
        count(snow) FILTER (WHERE month(date) IN (11, 12, 1, 2, 3)) AS n_w,
        sum(snow) AS total, max(snow) AS max_s, strftime(arg_max(date, snow), '%Y-%m-%d') AS max_s_d,
        count(*) FILTER (WHERE snow >= ${snowDay}) AS d_snow,
        strftime(min(date) FILTER (WHERE snow > 0), '%Y-%m-%d') AS first_d, strftime(max(date) FILTER (WHERE snow > 0), '%Y-%m-%d') AS last_d
      FROM ann_daily WHERE md IN (${mds}) AND snow IS NOT NULL GROUP BY season ORDER BY season`);
  }
  const sValid = (endIdx) => (r) => r.n_w >= Math.floor(0.85 * winterDays(endIdx));

  // Full-year tables (for the year-by-year charts and records), computed once.
  const fullYears = await yearStats("12-31");
  const fullSeasons = hasS ? await seasonStats(SEASON_MDS.length - 1) : [];
  const normalYears = (rows, valid) => rows.filter((r) => r.k >= 1991 && r.k <= 2020 && valid(r));
  const avg = (rows, key) => (rows.length ? rows.reduce((a, r) => a + (r[key] || 0), 0) / rows.length : null);

  // ---- Layout
  const page = h("article", { className: "alm ann" });
  out.append(page);
  page.append(h("header", { className: "alm-head" },
    h("h1", { text: `${st.name}${st.state ? `, ${st.state}` : ""}` }),
    h("p", { className: "alm-meta", text: [
      `GHCN-Daily ${st.id}`, st.county ? `${st.county} County` : null,
      `${Math.abs(st.lat).toFixed(2)}°${st.lat >= 0 ? "N" : "S"} ${Math.abs(st.lon).toFixed(2)}°${st.lon >= 0 ? "E" : "W"}`,
      isNum(st.elev_m) ? `${U.us ? Math.round(st.elev_m * 3.281) + " ft" : Math.round(st.elev_m) + " m"} elevation` : null,
      `records ${firstYear}–${latest.slice(0, 4)}`,
    ].filter(Boolean).join(", ") }),
    kp ? h("p", { className: "ann-koppen" }, h("strong", { text: `Köppen ${kp.code}` }), ` · ${kp.name} climate (from ${monPeriod} monthly means)`) : null));

  const boxes = {};
  const facts = {
    station: { name: st.name, state: st.state, id: st.id, latitude: st.lat, elevation_m: st.elev_m, record_starts: firstYear, latest_observation: latest },
    units: { temperature: U.t, precipitation: U.p, snowfall: U.s },
    koppen: kp ? { ...kp, from_monthly_means: monPeriod } : null,
  };
  const narrateSoon = (() => {
    let timer = null;
    let token = 0;
    return () => {
      clearTimeout(timer);
      const t = templateText(facts, F);
      for (const [k, box] of Object.entries(boxes)) box.textContent = t[k] || "";
      if (!deps.lumen.getKey()) return;
      timer = setTimeout(async () => {
        const mine = ++token;
        for (const box of Object.values(boxes)) box.classList.add("alm-pending");
        try {
          const n = await narrate(facts);
          if (mine !== token || !n) return;
          for (const [k, box] of Object.entries(boxes)) {
            const txt = n.text?.[k];
            if (typeof txt === "string" && txt.trim()) box.innerHTML = deps.renderMarkdown(txt);
          }
          aiNote.textContent = `The summaries are written by an AI model (${n.model} via Lumen) from the numbers on this page, so they may make mistakes; check important values against the charts and tables.`;
        } catch (err) {
          deps.logEvent("annual narrative", err.message);
          deps.onLumenError?.(err);
          if (err?.status === 401) aiNote.textContent = "Your Lumen key has expired, so the summaries are plain templated text. Renew it with the button at the top of the page.";
        } finally {
          if (mine === token) for (const box of Object.values(boxes)) box.classList.remove("alm-pending");
        }
      }, 600);
    };
  })();

  const yearSelect = (id, options, value, onChange) => {
    const sel = h("select", { id, className: "ann-select" }, options.map(([v, label]) => h("option", { value: String(v), ...(String(v) === String(value) ? { selected: true } : {}) }, label)));
    sel.addEventListener("change", () => onChange(Number(sel.value)));
    return sel;
  };
  const legend = (items) => h("ul", { className: "ann-legend" }, items.map(([kind, color, label]) =>
    h("li", {}, h("span", { className: `ann-key ann-key-${kind}`, style: `--c:${color}` }), label)));
  const figure = (label) => h("figure", { className: "alm-chart", "aria-label": label });
  const table = (head, rows) => h("div", { className: "alm-scroll" }, h("table", { className: "alm-table ann-table" },
    h("thead", {}, h("tr", {}, head.map((c) => h("th", { scope: "col", text: c })))),
    h("tbody", {}, rows.filter(Boolean).map((r) => h("tr", {}, h("th", { scope: "row", text: r[0] }), r.slice(1).map((c) => h("td", { text: c ?? "–" })))))));
  const draw = async (fig, spec, onView) => {
    try {
      await deps.embedChart(fig, spec, onView);
    } catch (err) {
      fig.replaceChildren(h("p", { className: "fine", text: `Chart unavailable: ${err.message}` }));
      deps.logEvent("annual chart", err.message);
    }
  };
  const clickYear = (cb) => (view) => view.addEventListener("click", (_e, item) => {
    const y = item?.datum?.year ?? item?.datum?.season;
    if (isNum(y)) cb(y);
  });
  const periodLabel = (y, endMd) => (endMd === "12-31" ? String(y) : `${y} through ${fmtDay(`${y}-${endMd}`, { month: "short", day: "numeric" })}`);

  const yearOpts = years.map((y) => [y, y === thisYear && latest.slice(5) !== "12-31" ? `${y} (so far)` : String(y)]);
  const startYear = years.includes(Number(year)) ? Number(year) : thisYear;
  const state = { tYear: startYear, pYear: startYear,
    sSeason: seasons.includes(Number(year) - 1) ? Number(year) - 1 : (latestSnowSeason ?? seasons[0]) };

  // ---- Temperature
  if (hasT) {
    const sec = h("section", { className: "alm-section", "aria-labelledby": "ann-temp" });
    const fig = figure("Daily high and low temperatures against normals and records");
    const statsBox = h("div");
    const annFig = figure("Annual mean high and low temperatures, every year on record");
    boxes.temperature = h("div", { className: "alm-box" });
    const sel = yearSelect("ann-t-year", yearOpts, state.tYear, (y) => update(y));
    sec.append(
      h("div", { className: "ann-title" }, h("h2", { id: "ann-temp", text: "Temperature" }), h("label", { className: "ann-pick" }, "Year ", sel)),
      fig,
      legend([["band", COLORS.recordBand, "Record range"], ["band", COLORS.normalBand, `Normal range (${normSource("tmax") || "unavailable"})`],
        ["bar", COLORS.warm, "Observed, warmer than normal"], ["bar", COLORS.cool, "Observed, colder than normal"], ["tri", COLORS.warm, "Record set (high ▲, low ▼)"]]),
      statsBox,
      h("h3", { text: "Every year on record" }),
      h("p", { className: "fine", text: "Annual mean high and low for complete years, with linear trends. Click a year to show it above." }),
      annFig,
      boxes.temperature);
    page.append(sec);

    const nHi = MONTH_DAYS.map((m) => norm.get(m).tmax).filter(isNum);
    const monthlyNormHi = MONTHS.map((_, i) => {
      const v = MONTH_DAYS.filter((m) => Number(m.slice(0, 2)) === i + 1).map((m) => norm.get(m).tmax).filter(isNum);
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    });
    const warmM = monthlyNormHi.indexOf(Math.max(...monthlyNormHi.filter(isNum)));
    const coldM = monthlyNormHi.indexOf(Math.min(...monthlyNormHi.filter(isNum)));
    const valid = fullYears.filter(tValid);
    const ext = (await g.sql(`
      SELECT max(tmax) AS hi, strftime(arg_max(date, tmax), '%Y-%m-%d') AS hi_d, min(tmin) AS lo, strftime(arg_min(date, tmin), '%Y-%m-%d') AS lo_d,
             min(tmax) AS cold_day, strftime(arg_min(date, tmax), '%Y-%m-%d') AS cold_day_d, max(tmin) AS warm_night, strftime(arg_max(date, tmin), '%Y-%m-%d') AS warm_night_d
      FROM ann_daily`))[0];
    const meanRows = valid.map((r) => ({ year: r.k, mean: r.mean }));
    const slope = (rows) => {
      if (rows.length < 20) return null;
      const n = rows.length;
      const mx = rows.reduce((a, r) => a + r.year, 0) / n;
      const my = rows.reduce((a, r) => a + r.mean, 0) / n;
      const sxy = rows.reduce((a, r) => a + (r.year - mx) * (r.mean - my), 0);
      const sxx = rows.reduce((a, r) => a + (r.year - mx) ** 2, 0);
      return sxx ? (10 * sxy) / sxx : null;
    };
    const warmest = valid.reduce((a, r) => (!a || r.mean > a.mean ? r : a), null);
    const coldest = valid.reduce((a, r) => (!a || r.mean < a.mean ? r : a), null);
    facts.temperature = {
      normals: nHi.length ? {
        annual_mean_high: +(avg(MONTH_DAYS.map((m) => ({ v: norm.get(m).tmax })), "v")).toFixed(1),
        annual_mean_low: +(avg(MONTH_DAYS.map((m) => ({ v: norm.get(m).tmin })), "v")).toFixed(1),
        warmest_month: MONTHS[warmM], warmest_month_high: +monthlyNormHi[warmM].toFixed(1),
        coldest_month: MONTHS[coldM], coldest_month_high: +monthlyNormHi[coldM].toFixed(1),
        source: normSource("tmax"),
      } : null,
      extremes: {
        highest: { value: ext.hi, date: ext.hi_d }, lowest: { value: ext.lo, date: ext.lo_d },
        coldest_high: { value: ext.cold_day, date: ext.cold_day_d }, warmest_low: { value: ext.warm_night, date: ext.warm_night_d },
        warmest_year: warmest ? { value: +warmest.mean.toFixed(1), year: warmest.k } : null,
        coldest_year: coldest ? { value: +coldest.mean.toFixed(1), year: coldest.k } : null,
      },
      trend_per_decade: {
        since_start: isNum(slope(meanRows)) ? +slope(meanRows).toFixed(2) : null,
        since_1970: isNum(slope(meanRows.filter((r) => r.year >= 1970))) ? +slope(meanRows.filter((r) => r.year >= 1970)).toFixed(2) : null,
        complete_years: valid.length,
      },
      days_per_year_1991_2020: { [`high_at_least_${hot}`]: round1(avg(normalYears(fullYears, tValid), "d_hot")), [`low_at_most_${freeze}`]: round1(avg(normalYears(fullYears, tValid), "d_frz")) },
    };

    const annRows = valid.flatMap((r) => [
      { year: r.k, series: "Mean high", value: r.mean_hi, t_value: F.t1(r.mean_hi), t_rank: rankText(valid.map((x) => ({ k: x.k, v: x.mean_hi })), "v", r.mean_hi, r.k, "warmest", "coldest") },
      { year: r.k, series: "Mean low", value: r.mean_lo, t_value: F.t1(r.mean_lo), t_rank: rankText(valid.map((x) => ({ k: x.k, v: x.mean_lo })), "v", r.mean_lo, r.k, "warmest", "coldest") },
    ]);
    const normal = facts.temperature.normals ? [{ series: "Mean high", value: facts.temperature.normals.annual_mean_high }, { series: "Mean low", value: facts.temperature.normals.annual_mean_low }] : null;

    async function update(y) {
      state.tYear = y;
      sel.value = String(y);
      onYear(state);
      const endMd = y === thisYear ? latest.slice(5) : "12-31";
      const stats = endMd === "12-31" ? fullYears : await yearStats(endMd);
      const cur = stats.find((r) => r.k === y) || {};
      const v = stats.filter(tValid);
      const nY = normalYears(stats, tValid);
      const nMd = MONTH_DAYS.filter((m) => m <= endMd && (m !== "02-29"));
      const normHi = avg(nMd.map((m) => ({ v: norm.get(m).tmax })), "v");
      const normLo = avg(nMd.map((m) => ({ v: norm.get(m).tmin })), "v");
      const label = periodLabel(y, endMd);
      const rk = (key, hiW, loW) => (tValid(cur) ? rankText(v, key, cur[key], y, hiW, loW) : "incomplete year");
      // Daily rows for the chart.
      const obs = new Map((await g.sql(`SELECT md, tmax, tmin FROM ann_daily WHERE yr = ${y}`)).map((r) => [r.md, r]));
      const mds = MONTH_DAYS.filter((m) => m !== "02-29" || isLeap(y));
      let setHi = 0;
      let setLo = 0;
      const rows = mds.map((m) => {
        const n = norm.get(m);
        const r = rec.get(m) || {};
        const o = obs.get(m) || {};
        const date = `${y}-${m}`;
        const sh = isNum(o.tmax) && o.tmax === r.rec_hi && r.rec_hi_yr === y;
        const sl = isNum(o.tmin) && o.tmin === r.rec_lo && r.rec_lo_yr === y;
        setHi += sh;
        setLo += sl;
        return {
          date, norm_hi: n.tmax, norm_lo: n.tmin, rec_hi: r.rec_hi, rec_lo: r.rec_lo, obs_hi: o.tmax ?? null, obs_lo: o.tmin ?? null, set_hi: sh, set_lo: sl,
          t_date: fmtDay(date, { weekday: "short", month: "short", day: "numeric", year: "numeric" }) + (subBy.has(date) ? subTag(date) : provisional.has(date) ? " (provisional)" : ""),
          t_obs: isNum(o.tmax) || isNum(o.tmin) ? `${F.t(o.tmax)} / ${F.t(o.tmin)}${sh ? " (record high)" : ""}${sl ? " (record low)" : ""}` : date > latest ? "Not yet" : "Not reported",
          t_norm: `${F.t(n.tmax)} / ${F.t(n.tmin)}`,
          t_mean: `${F.t(r.mean_hi)} / ${F.t(r.mean_lo)}`,
          t_rec_hi: isNum(r.rec_hi) ? `${F.t(r.rec_hi)} (${r.rec_hi_yr})` : "–",
          t_rec_lo: isNum(r.rec_lo) ? `${F.t(r.rec_lo)} (${r.rec_lo_yr})` : "–",
        };
      });
      await draw(fig, tempSpec(rows, y, U));
      const both = (key) => `warmest ${maxBy(v, key, (r) => `${F.t1(r[key])} (${r.k})`)}; coldest ${minBy(v, key, (r) => `${F.t1(r[key])} (${r.k})`)}`;
      statsBox.replaceChildren(table(["", label, "1991–2020 average", "Rank", "Station record"], [
        ["Mean high", F.t1(cur.mean_hi), F.t1(normHi), rk("mean_hi", "warmest", "coldest"), v.length ? both("mean_hi") : null],
        ["Mean low", F.t1(cur.mean_lo), F.t1(normLo), rk("mean_lo", "warmest", "coldest"), v.length ? both("mean_lo") : null],
        ["Highest", isNum(cur.max_hi) ? `${F.t(cur.max_hi)} on ${fmtDay(cur.max_hi_d, { month: "short", day: "numeric" })}` : null, F.t(avg(nY, "max_hi")), rk("max_hi", "highest", "lowest"), `${F.t(ext.hi)} on ${fmtDay(ext.hi_d)}`],
        ["Lowest", isNum(cur.min_lo) ? `${F.t(cur.min_lo)} on ${fmtDay(cur.min_lo_d, { month: "short", day: "numeric" })}` : null, F.t(avg(nY, "min_lo")), rk("min_lo", "mildest", "coldest"), `${F.t(ext.lo)} on ${fmtDay(ext.lo_d)}`],
        [`Days with a high of ${hot}${U.t} or more`, String(cur.d_hot ?? "–"), round1s(avg(nY, "d_hot")), rk("d_hot", "most", "fewest"), maxBy(v, "d_hot", (r) => `${r.d_hot} (${r.k})`)],
        [`Days with a low of ${freeze}${U.t} or less`, String(cur.d_frz ?? "–"), round1s(avg(nY, "d_frz")), rk("d_frz", "most", "fewest"), maxBy(v, "d_frz", (r) => `${r.d_frz} (${r.k})`)],
        ["Daily records set", `${setHi} high, ${setLo} low`, null, null, null],
      ]));
      facts.temperature.selected = {
        label, partial: endMd !== "12-31", mean_high: round1(cur.mean_hi), mean_low: round1(cur.mean_lo), mean: round1(cur.mean),
        normal_mean: round1((normHi + normLo) / 2), mean_high_vs_normal: round1(cur.mean_hi - normHi), mean_low_vs_normal: round1(cur.mean_lo - normLo),
        rank: rk("mean", "warmest", "coldest"),
        highest: isNum(cur.max_hi) ? { value: cur.max_hi, date: cur.max_hi_d } : null, lowest: isNum(cur.min_lo) ? { value: cur.min_lo, date: cur.min_lo_d } : null,
        [`days_high_at_least_${hot}`]: cur.d_hot, [`days_low_at_most_${freeze}`]: cur.d_frz,
        daily_record_highs_set: setHi, daily_record_lows_set: setLo,
      };
      await draw(annFig, annualTempSpec(annRows, y, normal), clickYear(update));
      narrateSoon();
    }
    state.updateT = update;
  }

  // ---- Precipitation
  if (hasP) {
    const sec = h("section", { className: "alm-section", "aria-labelledby": "ann-prcp" });
    const fig = figure("Cumulative precipitation against normal and the wettest and driest years");
    const barsFig = figure("Daily precipitation");
    const statsBox = h("div");
    const annFig = figure("Annual precipitation, every year on record");
    boxes.precipitation = h("div", { className: "alm-box" });
    const sel = yearSelect("ann-p-year", yearOpts, state.pYear, (y) => update(y));
    sec.append(
      h("div", { className: "ann-title" }, h("h2", { id: "ann-prcp", text: "Precipitation" }), h("label", { className: "ann-pick" }, "Year ", sel)),
      fig,
      legend([["band", COLORS.wetBand, "Range of complete years (wettest to driest so far)"], ["dash", COLORS.normal, `Normal (${normSource("prcp") || "unavailable"})`], ["line", COLORS.precip, "This year"]]),
      barsFig,
      statsBox,
      h("h3", { text: "Every year on record" }),
      h("p", { className: "fine", text: "Annual totals for complete years; the dashed line is the 1991–2020 average. Click a year to show it above." }),
      annFig,
      boxes.precipitation);
    page.append(sec);

    // Wettest and driest year-to-date across complete years, by month-day.
    const env = new Map((await g.sql(`
      WITH v AS (SELECT yr FROM ann_daily WHERE prcp IS NOT NULL GROUP BY yr HAVING count(*) >= 347),
      c AS (SELECT yr, md, sum(coalesce(prcp, 0)) OVER (PARTITION BY yr ORDER BY date) AS cum FROM ann_daily WHERE yr IN (SELECT yr FROM v))
      SELECT md, max(cum) AS hi, arg_max(yr, cum) AS hi_yr, min(cum) AS lo, arg_min(yr, cum) AS lo_yr FROM c GROUP BY md`)).map((r) => [r.md, r]));
    const valid = fullYears.filter(pValid);
    const nY = normalYears(fullYears, pValid);
    const monthlyNormP = MONTHS.map((_, i) => MONTH_DAYS.filter((m) => Number(m.slice(0, 2)) === i + 1 && m !== "02-29").reduce((a, m) => a + (norm.get(m).prcp || 0), 0));
    const annualNormal = monthlyNormP.reduce((a, b) => a + b, 0);
    const wetM = monthlyNormP.indexOf(Math.max(...monthlyNormP));
    const dryM = monthlyNormP.indexOf(Math.min(...monthlyNormP));
    const wettestDay = (await g.sql("SELECT max(prcp) AS v, strftime(arg_max(date, prcp), '%Y-%m-%d') AS d FROM ann_daily"))[0];
    const wettestYear = valid.reduce((a, r) => (!a || r.total > a.total ? r : a), null);
    const driestYear = valid.reduce((a, r) => (!a || r.total < a.total ? r : a), null);
    facts.precipitation = {
      normals: annualNormal > 0 ? { annual: round2(annualNormal), wettest_month: MONTHS[wetM], wettest_month_total: round2(monthlyNormP[wetM]), driest_month: MONTHS[dryM], driest_month_total: round2(monthlyNormP[dryM]), source: normSource("prcp") } : null,
      extremes: {
        wettest_day: { value: wettestDay.v, date: wettestDay.d },
        wettest_year: wettestYear ? { value: round2(wettestYear.total), year: wettestYear.k } : null,
        driest_year: driestYear ? { value: round2(driestYear.total), year: driestYear.k } : null,
      },
      wet_days_per_year_1991_2020: round1(avg(nY, "d_wet")),
    };
    const annRows = valid.map((r) => ({ year: r.k, value: r.total, t_year: String(r.k), t_value: F.p(r.total), t_rank: rankText(valid, "total", r.total, r.k, "wettest", "driest") }));

    async function update(y) {
      state.pYear = y;
      sel.value = String(y);
      onYear(state);
      const endMd = y === thisYear ? latest.slice(5) : "12-31";
      const stats = endMd === "12-31" ? fullYears : await yearStats(endMd);
      const cur = stats.find((r) => r.k === y) || {};
      const v = stats.filter(pValid);
      const nYp = normalYears(stats, pValid);
      const label = periodLabel(y, endMd);
      const rk = (key, hiW, loW) => (pValid(cur) ? rankText(v, key, cur[key], y, hiW, loW) : "incomplete year");
      const obs = new Map((await g.sql(`SELECT md, prcp FROM ann_daily WHERE yr = ${y}`)).map((r) => [r.md, r.prcp]));
      const mds = MONTH_DAYS.filter((m) => m !== "02-29" || isLeap(y));
      let cum = 0;
      let ncum = 0;
      const rows = mds.map((m) => {
        const date = `${y}-${m}`;
        const d = obs.get(m);
        const future = date > latest;
        if (isNum(d)) cum += d;
        ncum += norm.get(m).prcp || 0;
        const e = env.get(m) || {};
        const r = rec.get(m) || {};
        return {
          date, day: isNum(d) ? d : null, cum: future ? null : cum, norm_cum: annualNormal > 0 ? ncum : null, env_hi: e.hi, env_lo: e.lo,
          t_date: fmtDay(date, { weekday: "short", month: "short", day: "numeric", year: "numeric" }) + (subBy.has(date) ? subTag(date) : provisional.has(date) ? " (provisional)" : ""),
          t_day: isNum(d) ? F.p(d) : future ? "Not yet" : "Not reported",
          t_cum: future ? "–" : `${F.p(cum)}${ncum > 0 ? ` (${Math.round((100 * cum) / ncum)}% of normal)` : ""}`,
          t_norm: F.p(ncum),
          t_hi: isNum(e.hi) ? `${F.p(e.hi)} (${e.hi_yr})` : "–",
          t_lo: isNum(e.lo) ? `${F.p(e.lo)} (${e.lo_yr})` : "–",
          t_rec: isNum(r.rec_p) ? `${F.p(r.rec_p)} (${r.rec_p_yr})` : "–",
        };
      });
      const domain = [`${y}-01-01`, `${y}-12-31`];
      await draw(fig, cumulativeSpec(rows, domain, U, U.p, "Precipitation since January 1", COLORS.precip, COLORS.wetBand));
      await draw(barsFig, dailyBarsSpec(rows, domain, U, U.p, "Daily precipitation", COLORS.precip));
      const normTot = MONTH_DAYS.filter((m) => m <= endMd && m !== "02-29").reduce((a, m) => a + (norm.get(m).prcp || 0), 0);
      const wet = maxBy(v, "total", (r) => `${F.p(r.total)} (${r.k})`);
      const dry = minBy(v, "total", (r) => `${F.p(r.total)} (${r.k})`);
      statsBox.replaceChildren(table(["", label, "1991–2020 average", "Rank", "Station record"], [
        ["Total", F.p(cur.total), F.p(normTot), rk("total", "wettest", "driest"), `wettest ${wet}; driest ${dry}`],
        ["Wettest day", isNum(cur.max_p) ? `${F.p(cur.max_p)} on ${fmtDay(cur.max_p_d, { month: "short", day: "numeric" })}` : null, F.p(avg(nYp, "max_p")), rk("max_p", "highest", "lowest"), `${F.p(wettestDay.v)} on ${fmtDay(wettestDay.d)}`],
        [`Days with ${U.us ? "0.01 in" : "0.25 mm"} or more`, String(cur.d_wet ?? "–"), round1s(avg(nYp, "d_wet")), rk("d_wet", "most", "fewest"), maxBy(v, "d_wet", (r) => `${r.d_wet} (${r.k})`)],
        [`Days with ${U.us ? "1 in" : "25 mm"} or more`, String(cur.d_heavy ?? "–"), round1s(avg(nYp, "d_heavy")), rk("d_heavy", "most", "fewest"), maxBy(v, "d_heavy", (r) => `${r.d_heavy} (${r.k})`)],
      ]));
      facts.precipitation.selected = {
        label, partial: endMd !== "12-31", total: round2(cur.total), normal_to_date: round2(normTot),
        percent_of_normal: normTot > 0 && isNum(cur.total) ? Math.round((100 * cur.total) / normTot) : null,
        rank: rk("total", "wettest", "driest"), wettest_day: isNum(cur.max_p) ? { value: cur.max_p, date: cur.max_p_d } : null, wet_days: cur.d_wet,
      };
      await draw(annFig, annualBarsSpec(annRows, y, annualNormal > 0 ? avg(nY, "total") : null, U.p, COLORS.precip, "Precipitation"), clickYear(update));
      narrateSoon();
    }
    state.updateP = update;
  }

  // ---- Snowfall (seasons July to June)
  if (hasS && seasons.length) {
    const sec = h("section", { className: "alm-section", "aria-labelledby": "ann-snow" });
    const fig = figure("Cumulative snowfall for the season against normal and the snowiest and least snowy seasons");
    const barsFig = figure("Daily snowfall");
    const statsBox = h("div");
    const annFig = figure("Seasonal snowfall, every season on record");
    boxes.snowfall = h("div", { className: "alm-box" });
    const thisSeason = Number(latest.slice(0, 4)) - (Number(latest.slice(5, 7)) < 7 ? 1 : 0);
    const opts = seasons.map((s) => [s, `${seasonLabel(s)}${s === thisSeason ? " (so far)" : ""}`]);
    const sel = yearSelect("ann-s-season", opts, state.sSeason, (s) => update(s));
    sec.append(
      h("div", { className: "ann-title" }, h("h2", { id: "ann-snow", text: "Snowfall" }), h("label", { className: "ann-pick" }, "Season ", sel)),
      fig,
      legend([["band", COLORS.snowBand, "Range of complete seasons (snowiest to least snowy so far)"], ["dash", COLORS.normal, `Normal (${normSource("snow") || "unavailable"})`], ["line", COLORS.snow, "This season"]]),
      barsFig,
      statsBox,
      h("h3", { text: "Every season on record" }),
      h("p", { className: "fine", text: "Season totals (July to June) for complete seasons; the dashed line is the 1991–2020 average. Click a season to show it above." }),
      annFig,
      boxes.snowfall);
    page.append(sec);

    const fullValid = sValid(SEASON_MDS.length - 1);
    const valid = fullSeasons.filter(fullValid);
    const nS = valid.filter((r) => r.k >= 1990 && r.k <= 2019);
    const goodSeasons = valid.map((r) => r.k).join(", ") || "NULL";
    const env = new Map((await g.sql(`
      WITH c AS (SELECT season, md, sum(coalesce(snow, 0)) OVER (PARTITION BY season ORDER BY date) AS cum FROM ann_daily WHERE season IN (${goodSeasons}))
      SELECT md, max(cum) AS hi, arg_max(season, cum) AS hi_s, min(cum) AS lo, arg_min(season, cum) AS lo_s FROM c GROUP BY md`)).map((r) => [r.md, r]));
    const snowiestDay = (await g.sql("SELECT max(snow) AS v, strftime(arg_max(date, snow), '%Y-%m-%d') AS d FROM ann_daily"))[0];
    const most = valid.reduce((a, r) => (!a || r.total > a.total ? r : a), null);
    const least = valid.reduce((a, r) => (!a || r.total < a.total ? r : a), null);
    const monthlyNormS = MONTHS.map((_, i) => MONTH_DAYS.filter((m) => Number(m.slice(0, 2)) === i + 1 && m !== "02-29").reduce((a, m) => a + (norm.get(m).snow || 0), 0));
    const snowM = monthlyNormS.indexOf(Math.max(...monthlyNormS));
    const normalSeason = monthlyNormS.reduce((a, b) => a + b, 0);
    facts.snowfall = {
      normal_season: round1(normalSeason), average_1990_91_to_2019_20: round1(avg(nS, "total")), snowiest_month: MONTHS[snowM], snowiest_month_normal: round1(monthlyNormS[snowM]),
      extremes: {
        snowiest_day: { value: snowiestDay.v, date: snowiestDay.d },
        snowiest_season: most ? { value: round1(most.total), season: seasonLabel(most.k) } : null,
        least_snowy_season: least ? { value: round1(least.total), season: seasonLabel(least.k) } : null,
      },
      source: normSource("snow"),
    };
    const annRows = valid.map((r) => ({ year: r.k, value: r.total, t_year: seasonLabel(r.k), t_value: F.s(r.total), t_rank: rankText(valid, "total", r.total, r.k, "snowiest", "least snowy") }));

    async function update(s) {
      state.sSeason = s;
      sel.value = String(s);
      onYear(state);
      const latestIdx = SEASON_MDS.indexOf(latest.slice(5));
      const endIdx = s === thisSeason ? latestIdx : SEASON_MDS.length - 1;
      const stats = endIdx === SEASON_MDS.length - 1 ? fullSeasons : await seasonStats(endIdx);
      const isValid = sValid(endIdx);
      const cur = stats.find((r) => r.k === s) || {};
      const v = stats.filter(isValid);
      const nSs = v.filter((r) => r.k >= 1990 && r.k <= 2019);
      const label = endIdx === SEASON_MDS.length - 1 ? seasonLabel(s) : `${seasonLabel(s)} through ${fmtDay(latest, { month: "short", day: "numeric" })}`;
      const rk = (key, hiW, loW) => (isValid(cur) ? rankText(v, key, cur[key], s, hiW, loW) : "incomplete season");
      const obs = new Map((await g.sql(`SELECT md, snow FROM ann_daily WHERE season = ${s}`)).map((r) => [r.md, r.snow]));
      const mds = SEASON_MDS.filter((m) => m !== "02-29" || isLeap(s + 1));
      let cum = 0;
      let ncum = 0;
      const rows = mds.map((m) => {
        const date = `${m >= "07-01" ? s : s + 1}-${m}`;
        const d = obs.get(m);
        const future = date > latest;
        if (isNum(d)) cum += d;
        ncum += norm.get(m).snow || 0;
        const e = env.get(m) || {};
        const r = rec.get(m) || {};
        return {
          date, day: isNum(d) ? d : null, cum: future ? null : cum, norm_cum: normalSeason > 0 ? ncum : null, env_hi: e.hi, env_lo: e.lo,
          t_date: fmtDay(date, { weekday: "short", month: "short", day: "numeric", year: "numeric" }) + (subBy.has(date) ? subTag(date) : provisional.has(date) ? " (provisional)" : ""),
          t_day: isNum(d) ? F.s(d) : future ? "Not yet" : "Not reported",
          t_cum: future ? "–" : F.s(cum), t_norm: F.s(ncum),
          t_hi: isNum(e.hi) ? `${F.s(e.hi)} (${seasonLabel(e.hi_s)})` : "–",
          t_lo: isNum(e.lo) ? `${F.s(e.lo)} (${seasonLabel(e.lo_s)})` : "–",
          t_rec: isNum(r.rec_s) && r.rec_s > 0 ? `${F.s(r.rec_s)} (${r.rec_s_yr})` : "–",
        };
      });
      const domain = [`${s}-07-01`, `${s + 1}-06-30`];
      await draw(fig, cumulativeSpec(rows, domain, U, U.s, "Snowfall since July 1", COLORS.snow, COLORS.snowBand));
      await draw(barsFig, dailyBarsSpec(rows, domain, U, U.s, "Daily snowfall", COLORS.snow));
      const normTot = SEASON_MDS.slice(0, endIdx + 1).filter((m) => m !== "02-29").reduce((a, m) => a + (norm.get(m).snow || 0), 0);
      statsBox.replaceChildren(table(["", label, "1991–2020 average", "Rank", "Station record"], [
        ["Total", F.s(cur.total), F.s(avg(nSs, "total") ?? normTot), rk("total", "snowiest", "least snowy"),
          `most ${maxBy(v, "total", (r) => `${F.s(r.total)} (${seasonLabel(r.k)})`)}; least ${minBy(v, "total", (r) => `${F.s(r.total)} (${seasonLabel(r.k)})`)}`],
        ["Snowiest day", isNum(cur.max_s) && cur.max_s > 0 ? `${F.s(cur.max_s)} on ${fmtDay(cur.max_s_d, { month: "short", day: "numeric" })}` : "None", F.s(avg(nSs, "max_s")), rk("max_s", "highest", "lowest"), `${F.s(snowiestDay.v)} on ${fmtDay(snowiestDay.d)}`],
        [`Days with ${U.us ? "1 in" : "2.5 cm"} or more`, String(cur.d_snow ?? "–"), round1s(avg(nSs, "d_snow")), rk("d_snow", "most", "fewest"), maxBy(v, "d_snow", (r) => `${r.d_snow} (${seasonLabel(r.k)})`)],
        ["First and last snowfall", cur.first_d ? `${fmtDay(cur.first_d, { month: "short", day: "numeric" })} to ${fmtDay(cur.last_d, { month: "short", day: "numeric" })}` : "None yet", null, null, null],
      ]));
      facts.snowfall.selected = {
        label, partial: endIdx !== SEASON_MDS.length - 1, total: round1(cur.total), rank: rk("total", "snowiest", "least snowy"),
        normal_to_date: round1(normTot), snowiest_day: isNum(cur.max_s) && cur.max_s > 0 ? { value: cur.max_s, date: cur.max_s_d } : null,
        first_snow: cur.first_d || null, last_snow: cur.last_d || null,
      };
      await draw(annFig, annualBarsSpec(annRows, s, avg(nS, "total"), U.s, COLORS.snow, "Snowfall"), clickYear(update));
      narrateSoon();
    }
    state.updateS = update;
  }

  // ---- Footer
  const aiNote = h("p", { className: "alm-ai", text: deps.lumen.getKey()
    ? "The summaries are written by an AI model from the numbers on this page, so they may make mistakes; check important values against the charts and tables."
    : "Sign in to Lumen on the GHCN chat tab for AI-written summaries; until then they are plain templated text." });
  page.append(h("footer", { className: "alm-foot" }, aiNote,
    h("p", { className: "fine", text: `Sources: NOAA NCEI GHCN-Daily (station ${st.id}, ${firstYear}–${latest.slice(0, 4)})${provisional.size ? `, with ${[...provisional].sort()[0]} onward from the NOAA Regional Climate Centers' ACIS (provisional)` : ""}${subRows.length ? `; ${[...new Set(subRows.map((r) => fmtDay(r.d, { month: "short", day: "numeric" })))].join(", ")} not reported here and shown from ${[...new Set(subRows.map((r) => `${r.source_name} (${r.source})`))].join(" and ")}, marked * in the day values` : ""}; NOAA NCEI U.S. Climate Normals 1991–2020 where available, otherwise this station's own 1991–2020 averages. Records, ranges and ranks use this station's own history and may differ from official records; a year counts as complete with at least 90% of its days reported. Köppen class after Peel et al. (2007) and Beck et al. (2018).` })));

  onStatus("Drawing charts");
  if (state.updateT) await state.updateT(state.tYear);
  if (state.updateP) await state.updateP(state.pYear);
  if (state.updateS) await state.updateS(state.sSeason);
  onStatus("");
  page.dataset.ready = "true";
  return { station: st, state, facts };
}

// ---------------------------------------------------------------------------

const round1 = (v) => (isNum(v) ? Math.round(v * 10) / 10 : null);
const round2 = (v) => (isNum(v) ? Math.round(v * 100) / 100 : null);
const round1s = (v) => (isNum(v) ? v.toFixed(1) : "–");
const maxBy = (rows, key, fmt) => {
  const r = rows.filter((x) => isNum(x[key])).reduce((a, x) => (!a || x[key] >= a[key] ? x : a), null);
  return r ? fmt(r) : null;
};
const minBy = (rows, key, fmt) => {
  const r = rows.filter((x) => isNum(x[key])).reduce((a, x) => (!a || x[key] <= a[key] ? x : a), null);
  return r ? fmt(r) : null;
};
