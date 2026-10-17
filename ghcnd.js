// ghcnd.js — DuckDB-WASM over NOAA's GHCN-Daily parquet on S3, entirely in the browser.
//
// Data layout (s3://noaa-ghcn-pds/parquet/):
//   by_station/STATION=<id>/ELEMENT=<el>/*.parquet   small per-station files; when this
//                                                     was written some stations were
//                                                     refreshed daily and others had
//                                                     not changed since February 2025
//   by_year/YEAR=<y>/ELEMENT=<el>/*.parquet          all stations for one element-year;
//                                                     refreshed daily; no per-station
//                                                     statistics, so a station lookup
//                                                     reads every file of the element-year
// Files have hashed names, so they are found with S3 ListObjectsV2.
//
// load_series uses by_station for history and fills the remaining tail from
// by_year. The cutoff is read from the data, not hard-coded, so it adapts if
// NOAA refreshes by_station again. Downloaded files are kept in DuckDB's
// in-memory file system for the session, so a by_year element-year is fetched
// once no matter how many stations use it.

import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.32.0/+esm";
import { CONFIG } from "./config.js";

// Elements carried in the station index, with the scale from GHCN-Daily
// integers to the units reported in obs.value.
export const ELEMENTS = {
  PRCP: { scale: 0.1, units: "mm", description: "Precipitation" },
  SNOW: { scale: 1, units: "mm", description: "Snowfall" },
  SNWD: { scale: 1, units: "mm", description: "Snow depth" },
  TMAX: { scale: 0.1, units: "degC", description: "Maximum temperature" },
  TMIN: { scale: 0.1, units: "degC", description: "Minimum temperature" },
  TAVG: { scale: 0.1, units: "degC", description: "Average temperature (sparse in the US)" },
};

const STATION_RE = /^[A-Z0-9]{11}$/;

export class ToolError extends Error {}

// ---------------------------------------------------------------------------
// DuckDB setup

export async function openDatabase() {
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  // Workers must be same-origin, so the worker is a blob that imports the CDN script.
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" })
  );
  const worker = new Worker(workerUrl);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);
  await db.open({
    query: { castBigIntToDouble: true, castDecimalToDouble: true, castTimestampToDate: true },
  });
  return db;
}

// ---------------------------------------------------------------------------
// Arrow → plain JSON rows

function convertValue(v, type) {
  if (v === null || v === undefined) return null;
  const t = String(type);
  if (t.startsWith("Date")) {
    const d = v instanceof Date ? v : new Date(Number(v));
    return d.toISOString().slice(0, 10);
  }
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v.toJSON === "function") return v.toJSON();
  return String(v);
}

function toRows(table, limit = Infinity) {
  const fields = table.schema.fields;
  const rows = [];
  for (const row of table) {
    if (rows.length >= limit) break;
    const o = {};
    for (const f of fields) o[f.name] = convertValue(row[f.name], f.type);
    rows.push(o);
  }
  return rows;
}

const sqlString = (s) => `'${String(s).replace(/'/g, "''")}'`;

// ---------------------------------------------------------------------------
// The session: one database, one connection, a file cache and the loaded data.

export async function createGhcnd({ onActivity = () => {} } = {}) {
  const db = await openDatabase();
  const conn = await db.connect();
  const q = (sql) => conn.query(sql);

  const stats = { bytes: 0, files: 0 };
  const registered = new Map(); // S3 key -> Promise<registered file name>

  // Station index → stations (one row each) and coverage (one row per element).
  onActivity({ kind: "status", text: "Loading station index" });
  const indexResp = await fetch(new URL(CONFIG.stationIndexUrl, location.href));
  if (!indexResp.ok) throw new Error(`Station index not found (${indexResp.status})`);
  await db.registerFileBuffer("station_index.parquet", new Uint8Array(await indexResp.arrayBuffer()));
  await q(`
    CREATE TABLE coverage AS
      SELECT id, element, first_year, last_year FROM 'station_index.parquet';
    CREATE TABLE stations AS
      SELECT DISTINCT id, name, state, county, county_fips, substr(id, 1, 2) AS country,
             lat, lon, elev AS elev_m
      FROM 'station_index.parquet';
    CREATE TABLE obs (station VARCHAR, element VARCHAR, date DATE, value DOUBLE, m_flag VARCHAR, obs_time VARCHAR);
    CREATE TABLE provisional (station VARCHAR, element VARCHAR, date DATE);
    CREATE TABLE elements (element VARCHAR, units VARCHAR, description VARCHAR);
  `);
  for (const [el, e] of Object.entries(ELEMENTS)) {
    await q(`INSERT INTO elements VALUES (${sqlString(el)}, ${sqlString(e.units)}, ${sqlString(e.description)})`);
  }
  const loaded = new Map(); // "STATION/ELEMENT" -> summary, for the side rail

  // ---- S3 helpers ---------------------------------------------------------

  async function listParquet(prefix) {
    const out = [];
    let token = null;
    do {
      const params = new URLSearchParams({ "list-type": "2", prefix });
      if (token) params.set("continuation-token", token);
      const resp = await fetch(`${CONFIG.bucket}/?${params}`);
      if (!resp.ok) throw new ToolError(`Listing ${prefix} failed: HTTP ${resp.status}`);
      const xml = new DOMParser().parseFromString(await resp.text(), "application/xml");
      for (const c of xml.getElementsByTagName("Contents")) {
        const key = c.getElementsByTagName("Key")[0].textContent;
        if (key.endsWith(".parquet")) {
          out.push({ key, size: Number(c.getElementsByTagName("Size")[0].textContent) });
        }
      }
      token = xml.getElementsByTagName("NextContinuationToken")[0]?.textContent ?? null;
    } while (token);
    return out;
  }

  function fetchFile(key) {
    if (!registered.has(key)) {
      const name = "s3_" + key.replace(/[^A-Za-z0-9._-]/g, "_");
      const p = (async () => {
        const resp = await fetch(`${CONFIG.bucket}/${key}`);
        if (!resp.ok) throw new ToolError(`Download of ${key} failed: HTTP ${resp.status}`);
        const buf = new Uint8Array(await resp.arrayBuffer());
        const size = buf.byteLength; // read before the buffer is transferred to the worker
        await db.registerFileBuffer(name, buf);
        stats.bytes += size;
        stats.files += 1;
        onActivity({ kind: "download", stats: { ...stats } });
        return name;
      })();
      p.catch(() => registered.delete(key)); // let a failed download be retried
      registered.set(key, p);
    }
    return registered.get(key);
  }

  async function fetchAll(keys, limit = 4) {
    const names = new Array(keys.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, keys.length) }, async () => {
      while (next < keys.length) {
        const i = next++;
        names[i] = await fetchFile(keys[i]);
      }
    });
    await Promise.all(workers);
    return names;
  }

  const fileList = (names) => `[${names.map(sqlString).join(", ")}]`;
  const RAW_COLS = "ID, DATE, DATA_VALUE, M_FLAG, Q_FLAG, OBS_TIME";

  // ---- Tools --------------------------------------------------------------

  // ---- Areas: a state, a US county, a country, a radius around a place or
  // a point, or a list of stations. Shared by find_stations and load_area.

  let placesReady = null;
  function ensurePlaces() {
    placesReady ||= (async () => {
      const resp = await fetch(new URL(CONFIG.placesUrl, location.href));
      if (!resp.ok) throw new ToolError(`Place list not found (${resp.status}).`);
      await db.registerFileBuffer("places.parquet", new Uint8Array(await resp.arrayBuffer()));
      await q("CREATE TABLE places AS SELECT * FROM 'places.parquet'");
    })().catch((err) => {
      placesReady = null;
      throw err;
    });
    return placesReady;
  }

  // "Peoria", "Peoria, IL", "Cordoba, AR" (a US state or an ISO country code
  // after the comma), with state or country as separate hints.
  async function resolvePlace(place, state, country) {
    await ensurePlaces();
    let [name, region] = String(place).split(",").map((x) => x.trim());
    region = (region || state || "").toUpperCase();
    const iso = String(country || "").toUpperCase();
    const where = [`(lower(name) = lower(${sqlString(name)}) OR lower(asciiname) = lower(${sqlString(name)}))`];
    if (region.length === 2) where.push(`((country = 'US' AND admin1 = ${sqlString(region)}) OR country = ${sqlString(region)})`);
    else if (iso.length === 2) where.push(`country = ${sqlString(iso)}`);
    const rows = toRows(await q(`SELECT name, admin1, country, lat, lon, population FROM places
                                 WHERE ${where.join(" AND ")} ORDER BY population DESC LIMIT 8`));
    if (!rows.length) {
      throw new ToolError(`No populated place named "${place}" in the gazetteer (GeoNames, places of 1,000+ people). ` +
        "Give lat and lon instead, or a nearby larger town.");
    }
    // Same name in different states or countries, with no hint: ask rather than guess.
    const distinct = new Set(rows.map((r) => `${r.country}/${r.admin1}`));
    if (!region && !iso && distinct.size > 1) {
      const list = rows.map((r) => `${r.name}, ${r.country === "US" ? r.admin1 : r.country} (pop. ${r.population})`).join("; ");
      throw new ToolError(`"${name}" is ambiguous: ${list}. Call again with the state or country, e.g. place: "${name}, ${rows[0].country === "US" ? rows[0].admin1 : rows[0].country}".`);
    }
    return rows[0];
  }

  async function resolveArea({ state, country, county, place, lat, lon, radius_km, stations: ids } = {}) {
    const where = [];
    const labels = [];
    let point = null;
    let resolved = null;
    const st = state ? String(state).trim().toUpperCase() : "";
    const ctry = country ? String(country).trim().toUpperCase() : "";

    if (place) {
      resolved = await resolvePlace(place, st, ctry);
      point = { lat: resolved.lat, lon: resolved.lon };
      labels.push(`${resolved.name}, ${resolved.country === "US" ? resolved.admin1 : resolved.country}`);
    } else if (Number.isFinite(lat) && Number.isFinite(lon)) {
      point = { lat, lon };
      labels.push(`${lat}, ${lon}`);
    }
    if (point) {
      const r = Number.isFinite(radius_km) && radius_km > 0 ? Math.min(radius_km, 1000) : 50;
      point.radius = r;
      where.push(`${distanceSql(point)} <= ${r}`);
      labels[labels.length - 1] = `within ${r} km of ${labels[labels.length - 1]}`;
    }
    if (county) {
      if (!st) {
        const states = toRows(await q(`SELECT DISTINCT state FROM stations WHERE lower(county) = lower(${sqlString(countyName(county))}) ORDER BY 1`));
        throw new ToolError(`County names repeat across states; give the state too.${states.length ? ` "${countyName(county)}" exists in ${states.map((r) => r.state).join(", ")}.` : ""}`);
      }
      where.push(`s.state = ${sqlString(st)} AND lower(s.county) = lower(${sqlString(countyName(county))})`);
      labels.push(`${countyName(county)} County, ${st}`);
    } else if (!place) {
      // With a place, state and country only pick which place is meant.
      if (st) {
        where.push(`s.state = ${sqlString(st)}`);
        labels.push(st);
      }
      if (ctry) {
        where.push(`s.country = ${sqlString(ctry)}`);
        labels.push(ctry);
      }
    }
    if (Array.isArray(ids) && ids.length) {
      const list = ids.map((x) => String(x).trim().toUpperCase()).filter((x) => STATION_RE.test(x));
      if (!list.length) throw new ToolError("stations must be 11-character station IDs.");
      where.push(`s.id IN (${list.map(sqlString).join(", ")})`);
      labels.push(`${list.length} listed stations`);
    }
    return { where, label: labels.join(", "), point, place: resolved };
  }

  const countyName = (c) => String(c).trim().replace(/\s+(county|parish|borough|census area|municipality)$/i, "");

  // Haversine distance in km from a point to each station s.
  const distanceSql = (p) =>
    `2 * 6371 * asin(sqrt(pow(sin(radians(s.lat - ${p.lat}) / 2), 2) +
       cos(radians(${p.lat})) * cos(radians(s.lat)) * pow(sin(radians(s.lon - ${p.lon}) / 2), 2)))`;

  // ---- Tools --------------------------------------------------------------

  async function findStations({ query, element, min_years, limit = 10, ...areaArgs } = {}) {
    const area = await resolveArea(areaArgs);
    const where = [...area.where];
    if (query) {
      const term = String(query).trim().toUpperCase();
      where.push(STATION_RE.test(term) ? `s.id = ${sqlString(term)}` : `s.name ILIKE ${sqlString("%" + term + "%")}`);
    }
    if (element) {
      const el = String(element).toUpperCase();
      if (!ELEMENTS[el]) throw new ToolError(`Unknown element ${element}. Use one of ${Object.keys(ELEMENTS).join(", ")}.`);
      const minY = Number.isFinite(min_years) ? Math.max(0, Math.floor(min_years)) : 0;
      where.push(`EXISTS (SELECT 1 FROM coverage c WHERE c.id = s.id AND c.element = ${sqlString(el)}
                  AND c.last_year - c.first_year + 1 >= ${minY})`);
    }
    if (!where.length) throw new ToolError("Give a name, station ID, state, county, country, place, or lat/lon.");
    const n = Math.min(Math.max(1, Math.floor(limit) || 10), 50);
    const sortEl = sqlString(element ? String(element).toUpperCase() : "PRCP");
    const dist = area.point ? distanceSql(area.point) : "NULL";

    const base = `SELECT s.*, ${dist} AS distance_km FROM stations s WHERE ${where.join(" AND ")}`;
    const total = toRows(await q(`SELECT count(*) AS n FROM (${base})`))[0].n;
    const rows = toRows(await q(`
      WITH s AS (${base})
      SELECT s.id, s.name, s.state, s.county, s.country, round(s.lat, 4) AS lat, round(s.lon, 4) AS lon,
             s.elev_m, round(s.distance_km, 1) AS distance_km,
             (SELECT string_agg(c.element || ' ' || c.first_year || '-' || c.last_year, ', ' ORDER BY c.element)
                FROM coverage c WHERE c.id = s.id) AS coverage
      FROM s
      ORDER BY ${area.point ? "s.distance_km," : ""}
               (SELECT max(c.last_year - c.first_year) FROM coverage c
                 WHERE c.id = s.id AND c.element = ${sortEl}) DESC NULLS LAST
      LIMIT ${n}`));
    return {
      area: area.label || undefined,
      place: area.place || undefined,
      total_matching: total,
      stations: rows,
      note: !rows.length ? "No stations matched."
        : total > rows.length ? `Showing ${rows.length} of ${total}. To analyze all of them on a day or period, use load_area with the same area.` : undefined,
    };
  }

  async function loadSeries({ station, elements, start_year, end_year } = {}) {
    const id = String(station || "").trim().toUpperCase();
    if (!STATION_RE.test(id)) throw new ToolError(`"${station}" is not a GHCN-Daily station ID (11 characters).`);
    const els = (Array.isArray(elements) && elements.length ? elements : ["PRCP"]).map((e) => String(e).toUpperCase());
    for (const el of els) {
      if (!ELEMENTS[el]) throw new ToolError(`Unknown element ${el}. Use one of ${Object.keys(ELEMENTS).join(", ")}.`);
    }
    const cov = toRows(await q(`SELECT element, first_year, last_year FROM coverage WHERE id = ${sqlString(id)}`));
    if (!cov.length) throw new ToolError(`Station ${id} is not in the station index.`);
    const nowYear = new Date().getUTCFullYear();

    // Plan every element first so the download budget covers the whole call.
    const plans = [];
    for (const el of els) {
      const c = cov.find((r) => r.element === el);
      if (!c) {
        plans.push({ el, skip: `${id} has no ${el} record.` });
        continue;
      }
      const y0 = Math.max(c.first_year, Number.isFinite(start_year) ? start_year : c.first_year);
      const y1 = Math.min(c.last_year, nowYear, Number.isFinite(end_year) ? end_year : nowYear);
      if (y0 > y1) {
        plans.push({ el, skip: `${id} has ${el} only for ${c.first_year}-${c.last_year}.` });
        continue;
      }
      plans.push({ el, y0, y1, history: await listParquet(`parquet/by_station/STATION=${id}/ELEMENT=${el}/`) });
    }

    // History pass: by_station is small; read it to find where it ends.
    for (const p of plans) {
      if (p.skip || !p.history.length) continue;
      p.historyNames = await fetchAll(p.history.map((f) => f.key));
      const r = toRows(await q(`SELECT max(DATE) AS last FROM read_parquet(${fileList(p.historyNames)}, hive_partitioning = false)`));
      p.historyLast = r[0].last; // YYYYMMDD string
    }

    // Tail plan: by_year element-years after the history ends (or the whole
    // range when the station has no by_station files).
    // Some stations' by_station files are refreshed daily and others stopped in
    // February 2025; history ending within the last ten days needs no tail.
    const recent = new Date(Date.now() - 10 * 864e5).toISOString().slice(0, 10).replace(/-/g, "");
    let tailBytes = 0;
    for (const p of plans) {
      if (p.skip) continue;
      const fromYear = p.historyLast ? Math.max(p.y0, Number(p.historyLast.slice(0, 4))) : p.y0;
      p.tail = [];
      if (!p.historyLast || (p.historyLast < `${p.y1}1231` && p.historyLast < recent)) {
        for (let y = fromYear; y <= p.y1; y++) {
          const files = await listParquet(`parquet/by_year/YEAR=${y}/ELEMENT=${p.el}/`);
          const fresh = files.filter((f) => !registered.has(f.key));
          tailBytes += fresh.reduce((s, f) => s + f.size, 0);
          p.tail.push(...files);
        }
      }
    }
    const tailMB = tailBytes / 1e6;
    if (tailMB > CONFIG.maxDownloadMBPerCall) {
      throw new ToolError(
        `This request would download about ${Math.round(tailMB)} MB of by_year files ` +
          `(limit ${CONFIG.maxDownloadMBPerCall} MB per call), because by_year files hold every station. ` +
          `Ask for a shorter period, fewer elements, or recent years only.`
      );
    }

    const summaries = [];
    for (const p of plans) {
      if (p.skip) {
        summaries.push({ element: p.el, loaded: false, reason: p.skip });
        continue;
      }
      const parts = [];
      const lo = `${p.y0}0101`;
      const hi = `${p.y1}1231`;
      if (p.historyNames) {
        parts.push(`SELECT ${RAW_COLS} FROM read_parquet(${fileList(p.historyNames)}, hive_partitioning = false)
                    WHERE DATE BETWEEN '${lo}' AND '${hi}'`);
      }
      if (p.tail.length) {
        const names = await fetchAll(p.tail.map((f) => f.key));
        const after = p.historyLast ? `AND DATE > '${p.historyLast}'` : "";
        parts.push(`SELECT ${RAW_COLS} FROM read_parquet(${fileList(names)}, hive_partitioning = false)
                    WHERE ID = ${sqlString(id)} AND DATE BETWEEN '${lo}' AND '${hi}' ${after}`);
      }
      const scale = ELEMENTS[p.el].scale;
      await q(`DELETE FROM obs WHERE station = ${sqlString(id)} AND element = ${sqlString(p.el)}`);
      await q(`
        CREATE OR REPLACE TEMP TABLE _raw AS ${parts.join(" UNION ALL ")};
        INSERT INTO obs
          SELECT ID, ${sqlString(p.el)}, strptime(DATE, '%Y%m%d')::DATE, round(DATA_VALUE::DOUBLE * ${scale}, 1), M_FLAG, OBS_TIME
          FROM _raw WHERE Q_FLAG IS NULL;`);
      const s = toRows(await q(`
        SELECT count(*) FILTER (WHERE Q_FLAG IS NULL) AS days,
               count(*) FILTER (WHERE Q_FLAG IS NOT NULL) AS qc_removed,
               strftime(min(strptime(DATE, '%Y%m%d')), '%Y-%m-%d') AS first_date,
               strftime(max(strptime(DATE, '%Y%m%d')), '%Y-%m-%d') AS last_date
        FROM _raw`))[0];
      await q("DROP TABLE _raw");
      const span = s.first_date ? (Date.parse(s.last_date) - Date.parse(s.first_date)) / 864e5 + 1 : 0;
      const summary = {
        element: p.el,
        units: ELEMENTS[p.el].units,
        loaded: s.days > 0,
        days: s.days,
        first_date: s.first_date,
        last_date: s.last_date,
        days_present_pct: span ? Math.round((1000 * s.days) / span) / 10 : 0,
        qc_flagged_removed: s.qc_removed,
        source: [
          p.historyNames ? `by_station through ${p.historyLast.replace(/(\d{4})(\d\d)(\d\d)/, "$1-$2-$3")}` : null,
          p.tail.length ? `by_year ${Number((p.historyLast || lo).slice(0, 4))}-${p.y1}` : null,
        ].filter(Boolean).join(" + "),
      };
      summaries.push(summary);
      if (summary.loaded) {
        const c = cov.find((r) => r.element === p.el);
        loaded.set(`${id}/${p.el}`, { station: id, ...summary, record_first: c.first_year, record_last: c.last_year });
      }
    }
    // GHCN-Daily runs a few days behind; fill the newest days from ACIS.
    let provisional = null;
    const wantsRecent = !Number.isFinite(end_year) || end_year >= nowYear;
    if (wantsRecent && /^(US|RQ|VQ|AQ|GQ|CQ)/.test(id)) {
      try {
        provisional = await fillRecent(id, plans.filter((p) => !p.skip).map((p) => p.el));
      } catch (err) {
        provisional = { error: `Could not reach ACIS for recent days: ${err.message}` };
      }
      if (provisional?.added) {
        for (const sm of summaries) {
          const days = provisional.by_element[sm.element];
          if (days) {
            sm.provisional_days = days;
            sm.last_date = provisional.last_date[sm.element];
            sm.source += ` + ACIS provisional through ${sm.last_date}`;
            const k = `${id}/${sm.element}`;
            if (loaded.has(k)) loaded.get(k).last_date = sm.last_date;
          }
        }
      }
    }

    const meta = toRows(await q(`SELECT name, state FROM stations WHERE id = ${sqlString(id)}`))[0];
    loaded.forEach((v) => {
      if (v.station === id) Object.assign(v, meta);
    });
    onActivity({ kind: "loaded", loaded: [...loaded.values()] });
    return {
      station: id,
      name: meta?.name,
      state: meta?.state,
      results: summaries,
      provisional: provisional?.added
        ? `${provisional.added} recent values (${provisional.first_date} to ${provisional.last_any}) are provisional reports from the NOAA Regional Climate Centers' ACIS, not yet in GHCN-Daily; they are listed in table provisional(station, element, date).`
        : provisional?.error,
      downloaded_mb_this_session: Math.round(stats.bytes / 1e5) / 10,
      table: "obs(station, element, date, value, m_flag, obs_time)",
    };
  }

  // ACIS (Applied Climate Information System, NOAA Regional Climate Centers)
  // carries the same co-op and first-order stations within about a day, and
  // accepts GHCN-Daily IDs. Values after a station's last GHCN-Daily date are
  // added to obs in GHCN units and listed in provisional.
  const ACIS = "https://data.rcc-acis.org/StnData";
  const ACIS_ELEMS = { TMAX: "maxt", TMIN: "mint", PRCP: "pcpn", SNOW: "snow", SNWD: "snwd" };

  async function fillRecent(id, elements) {
    const els = elements.filter((e) => ACIS_ELEMS[e]);
    if (!els.length) return null;
    const last = Object.fromEntries(toRows(await q(`
      SELECT element, strftime(max(date), '%Y-%m-%d') AS d FROM obs
      WHERE station = ${sqlString(id)} AND element IN (${els.map(sqlString).join(", ")}) GROUP BY element`)).map((r) => [r.element, r.d]));
    const today = new Date().toLocaleDateString("en-CA");
    const starts = els.map((e) => last[e]).filter(Boolean).sort();
    if (!starts.length) return null;
    const from = new Date(Date.parse(`${starts[0]}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
    if (from > today) return null;
    const params = new URLSearchParams({ sid: id, sdate: from, edate: today, elems: els.map((e) => ACIS_ELEMS[e]).join(","), output: "json" });
    const resp = await fetch(`${ACIS}?${params}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const body = await resp.json();
    if (body.error) return null; // station not in ACIS
    const rows = [];
    for (const rec of body.data || []) {
      const date = rec[0];
      els.forEach((el, i) => {
        if (!last[el] || date <= last[el]) return;
        const raw = String(rec[i + 1] ?? "M").trim();
        if (raw === "M" || raw === "S" || raw === "") return;
        const trace = raw === "T";
        const v = trace ? 0 : parseFloat(raw);
        if (!Number.isFinite(v)) return;
        // To GHCN-Daily units: degC, mm; snow and depth in whole mm.
        const value = el === "TMAX" || el === "TMIN" ? Math.round(((v - 32) * 5) / 9 * 10) / 10
          : el === "PRCP" ? Math.round(v * 25.4 * 10) / 10 : Math.round(v * 25.4);
        rows.push({ el, date, value, trace });
      });
    }
    if (!rows.length) return { added: 0 };
    await q(`INSERT INTO obs VALUES ${rows.map((r) =>
      `(${sqlString(id)}, ${sqlString(r.el)}, DATE '${r.date}', ${r.value}, ${r.trace ? "'T'" : "NULL"}, NULL)`).join(", ")}`);
    await q(`DELETE FROM provisional WHERE station = ${sqlString(id)}`);
    await q(`INSERT INTO provisional VALUES ${rows.map((r) => `(${sqlString(id)}, ${sqlString(r.el)}, DATE '${r.date}')`).join(", ")}`);
    const by = {};
    const lastDate = {};
    for (const r of rows) {
      by[r.el] = (by[r.el] || 0) + 1;
      if (!lastDate[r.el] || r.date > lastDate[r.el]) lastDate[r.el] = r.date;
    }
    const dates = rows.map((r) => r.date).sort();
    return { added: rows.length, by_element: by, last_date: lastDate, first_date: dates[0], last_any: dates[dates.length - 1] };
  }

  // Every station in an area for a short period, from by_year files. Those
  // hold all stations for an element-year, so one download covers a whole
  // state (or country) at once; this is the tool for "highest in Illinois on
  // a date" questions, where loading stations one at a time misses most of them.
  const MAX_AREA_DAYS = 366;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  async function loadArea({ state, country, county, place, lat, lon, radius_km, stations: ids, elements, start_date, end_date } = {}) {
    const start = String(start_date || "").trim();
    const end = String(end_date || start).trim();
    if (!DATE_RE.test(start) || !DATE_RE.test(end)) throw new ToolError("start_date and end_date must be YYYY-MM-DD.");
    if (end < start) throw new ToolError("end_date is before start_date.");
    const days = (Date.parse(end) - Date.parse(start)) / 864e5 + 1;
    if (days > MAX_AREA_DAYS) {
      throw new ToolError(`load_area covers at most ${MAX_AREA_DAYS} days; for long records at a few stations use load_series.`);
    }
    const els = (Array.isArray(elements) && elements.length ? elements : ["TMAX"]).map((e) => String(e).toUpperCase());
    for (const el of els) {
      if (!ELEMENTS[el]) throw new ToolError(`Unknown element ${el}. Use one of ${Object.keys(ELEMENTS).join(", ")}.`);
    }

    // The area, as a set of station IDs from the index.
    const area = await resolveArea({ state, country, county, place, lat, lon, radius_km, stations: ids });
    if (!area.where.length) throw new ToolError("Give a state, county (with state), country, place, lat/lon, or a list of stations.");
    const label = area.label;
    await q(`CREATE OR REPLACE TEMP TABLE _area AS SELECT s.id FROM stations s WHERE ${area.where.join(" AND ")}`);
    const nArea = toRows(await q("SELECT count(*) AS n FROM _area"))[0].n;
    if (!nArea) throw new ToolError(`No stations in the index match ${label}.`);

    // Plan downloads: one element-year at a time, inside the per-call budget.
    const y0 = Number(start.slice(0, 4));
    const y1 = Number(end.slice(0, 4));
    let bytes = 0;
    const plan = [];
    for (const el of els) {
      const files = [];
      for (let y = y0; y <= y1; y++) files.push(...(await listParquet(`parquet/by_year/YEAR=${y}/ELEMENT=${el}/`)));
      bytes += files.filter((f) => !registered.has(f.key)).reduce((a, f) => a + f.size, 0);
      plan.push({ el, files });
    }
    if (bytes / 1e6 > CONFIG.maxDownloadMBPerCall) {
      throw new ToolError(`This would download about ${Math.round(bytes / 1e6)} MB (limit ${CONFIG.maxDownloadMBPerCall} MB per call). Use fewer elements or a shorter period.`);
    }

    const lo = start.replace(/-/g, "");
    const hi = end.replace(/-/g, "");
    const results = [];
    for (const { el, files } of plan) {
      if (!files.length) {
        results.push({ element: el, loaded: false, reason: `NOAA has no ${el} files for ${y0}-${y1}.` });
        continue;
      }
      const names = await fetchAll(files.map((f) => f.key));
      await q(`
        CREATE OR REPLACE TEMP TABLE _raw AS
          SELECT ${RAW_COLS} FROM read_parquet(${fileList(names)}, hive_partitioning = false)
          WHERE DATE BETWEEN '${lo}' AND '${hi}' AND ID IN (SELECT id FROM _area);
        DELETE FROM obs WHERE element = ${sqlString(el)} AND date BETWEEN DATE '${start}' AND DATE '${end}'
          AND station IN (SELECT id FROM _area);
        INSERT INTO obs
          SELECT ID, ${sqlString(el)}, strptime(DATE, '%Y%m%d')::DATE, round(DATA_VALUE::DOUBLE * ${ELEMENTS[el].scale}, 1), M_FLAG, OBS_TIME
          FROM _raw WHERE Q_FLAG IS NULL;`);
      const r = toRows(await q(`
        SELECT count(DISTINCT ID) FILTER (WHERE Q_FLAG IS NULL) AS stations_reporting,
               count(*) FILTER (WHERE Q_FLAG IS NULL) AS rows,
               count(*) FILTER (WHERE Q_FLAG IS NOT NULL) AS qc_removed
        FROM _raw`))[0];
      await q("DROP TABLE _raw");
      const summary = {
        element: el,
        units: ELEMENTS[el].units,
        loaded: r.rows > 0,
        stations_reporting: r.stations_reporting,
        rows: r.rows,
        qc_flagged_removed: r.qc_removed,
      };
      results.push(summary);
      if (summary.loaded) {
        loaded.set(`area:${label}/${el}/${start}/${end}`, {
          kind: "area",
          station: `${r.stations_reporting} ${r.stations_reporting === 1 ? "station" : "stations"} reporting`,
          name: label,
          element: el,
          first_date: start,
          last_date: end,
          days_present_pct: Math.round((1000 * r.rows) / (r.stations_reporting * days)) / 10,
          record_first: y0,
          record_last: y1,
        });
      }
    }
    await q("DROP TABLE _area");
    onActivity({ kind: "loaded", loaded: [...loaded.values()] });
    return {
      area: label,
      place: area.place || undefined,
      stations_in_index: nArea,
      start_date: start,
      end_date: end,
      results,
      downloaded_mb_this_session: Math.round(stats.bytes / 1e5) / 10,
      table: "obs(station, element, date, value, m_flag, obs_time); join stations for names",
    };
  }

  // Precomputed records (scripts/build_records.py, refreshed monthly): one file
  // per US state, Canadian province or other country. load_records fetches the
  // files covering an area into table records and puts the area's station IDs
  // in area_stations, so all-time and monthly extremes for a whole state need
  // no raw data at all.
  let recordsMeta = null;
  const recordRegions = new Set();
  const MAX_RECORD_REGIONS = 12;

  async function loadRecords(areaArgs = {}) {
    if (!recordsMeta) {
      const resp = await fetch(new URL(CONFIG.recordsBase + "meta.json", location.href));
      if (!resp.ok) throw new ToolError("The records table has not been built yet; use load_area or load_series instead.");
      recordsMeta = await resp.json();
      await q(`CREATE TABLE IF NOT EXISTS records (id VARCHAR, element VARCHAR, month TINYINT, stat VARCHAR,
                 value DOUBLE, date DATE, runner_up DOUBLE, n_years SMALLINT, n_days INTEGER)`);
    }
    const area = await resolveArea(areaArgs);
    if (!area.where.length) throw new ToolError("Give a state, county (with state), country, place, lat/lon, or a list of stations.");
    await q(`CREATE OR REPLACE TABLE area_stations AS SELECT s.id FROM stations s WHERE ${area.where.join(" AND ")}`);
    const regions = toRows(await q(`
      SELECT DISTINCT CASE WHEN s.state <> '' THEN s.country || '-' || s.state ELSE s.country END AS region
      FROM stations s JOIN area_stations a USING (id)`)).map((r) => r.region);
    if (!regions.length) throw new ToolError(`No stations in the index match ${area.label}.`);
    if (regions.length > MAX_RECORD_REGIONS) {
      throw new ToolError(`That area spans ${regions.length} states or countries; records load at most ${MAX_RECORD_REGIONS} at a time. Narrow the area.`);
    }
    const missing = [];
    for (const region of regions) {
      if (recordRegions.has(region)) continue;
      if (!recordsMeta.regions[region]) {
        missing.push(region);
        continue;
      }
      const resp = await fetch(new URL(`${CONFIG.recordsBase}${region}.parquet`, location.href));
      if (!resp.ok) {
        missing.push(region);
        continue;
      }
      const buf = new Uint8Array(await resp.arrayBuffer());
      const size = buf.byteLength;
      const name = `records_${region}.parquet`;
      await db.registerFileBuffer(name, buf);
      await q(`INSERT INTO records SELECT * FROM '${name}'`);
      stats.bytes += size;
      stats.files += 1;
      onActivity({ kind: "download", stats: { ...stats } });
      recordRegions.add(region);
    }
    const n = toRows(await q(`
      SELECT count(DISTINCT r.id) AS stations, string_agg(DISTINCT r.element, ', ' ORDER BY r.element) AS elements
      FROM records r JOIN area_stations a USING (id)`))[0];
    return {
      area: area.label,
      place: area.place || undefined,
      regions_loaded: regions.filter((r) => recordRegions.has(r)),
      regions_without_records: missing.length ? missing : undefined,
      stations_with_records: n.stations,
      elements: n.elements,
      data_through: recordsMeta.data_through,
      built_at: recordsMeta.built_at,
      tables:
        "records(id, element, month, stat, value, date, runner_up, n_years, n_days) holds whole regions; " +
        "join area_stations(id) to restrict to this area, and stations for names. month 0 = all months; " +
        "stat 'max' or 'min'; value in the same units as obs.",
    };
  }

  // NWS forecast from the National Digital Forecast Database (api.weather.gov):
  // the 2.5 km grid cell containing a station (or place, or point), reduced to
  // local calendar days so it lines up with GHCN-Daily. US coverage only.
  //   TMAX  daytime max (°C), dated by the local day it is forecast for
  //   TMIN  overnight min (°C), dated by the morning it ends, as co-op observers report it
  //   PRCP, SNOW  totals (mm), 6-hour amounts split across local days by hour
  //   POP   highest chance of precipitation in the day (%)
  //   GUST  highest wind gust in the day (km/h)
  const NWS = "https://api.weather.gov";

  async function nwsJson(url) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let resp;
      try {
        resp = await fetch(url, { headers: { Accept: "application/geo+json" } });
      } catch (err) {
        // Network error or timeout: wait and try again, then give up clearly.
        if (attempt === 2) throw new ToolError(`The National Weather Service API could not be reached (${err.message}).`);
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      if (resp.ok) return resp.json();
      if (resp.status === 404) return null;
      if (attempt === 2 || resp.status < 500) {
        const body = await resp.json().catch(() => ({}));
        throw new ToolError(`The National Weather Service API returned ${resp.status}: ${body.detail || body.title || resp.statusText}`);
      }
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); // NWS gridpoints often 500 once, then work
    }
  }

  // ISO 8601 duration like PT6H, P1D, P1DT12H to hours.
  const durHours = (d) => {
    const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(d);
    return m ? (Number(m[1] || 0) * 24 + Number(m[2] || 0) + Number(m[3] || 0) / 60) : 1;
  };

  async function getForecast({ station, place, lat, lon, state, country } = {}) {
    let point;
    let label;
    let stationRow = null;
    if (station) {
      const id = String(station).trim().toUpperCase();
      if (!STATION_RE.test(id)) throw new ToolError(`"${station}" is not a GHCN-Daily station ID.`);
      stationRow = toRows(await q(`SELECT id, name, state, lat, lon, elev_m FROM stations WHERE id = ${sqlString(id)}`))[0];
      if (!stationRow) throw new ToolError(`Station ${id} is not in the station index.`);
      point = { lat: stationRow.lat, lon: stationRow.lon };
      label = `${stationRow.name}, ${stationRow.state} (${id})`;
    } else if (place) {
      const p = await resolvePlace(place, state ? String(state).toUpperCase() : "", country ? String(country).toUpperCase() : "");
      point = { lat: p.lat, lon: p.lon };
      label = `${p.name}, ${p.country === "US" ? p.admin1 : p.country}`;
    } else if (Number.isFinite(lat) && Number.isFinite(lon)) {
      point = { lat, lon };
      label = `${lat}, ${lon}`;
    } else {
      throw new ToolError("Give a station ID, a place, or lat and lon.");
    }

    const pts = await nwsJson(`${NWS}/points/${point.lat.toFixed(4)},${point.lon.toFixed(4)}`);
    if (!pts) throw new ToolError(`No National Weather Service forecast covers ${label}; NWS forecasts cover the US and its territories only.`);
    const P = pts.properties;
    const tz = P.timeZone;
    const [grid, text] = await Promise.all([nwsJson(P.forecastGridData), nwsJson(P.forecast).catch(() => null)]);
    if (!grid) throw new ToolError("The NWS forecast grid for this point is unavailable right now; try again shortly.");
    const G = grid.properties;

    const localDate = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: tz });
    const series = (name) => (G[name]?.values || []).map((v) => {
      const [start, dur] = v.validTime.split("/");
      const t0 = Date.parse(start);
      return { t0, hours: durHours(dur), value: v.value };
    }).filter((v) => v.value !== null && v.value !== undefined);

    const daily = new Map(); // "date|element" -> {value, hours}
    const put = (date, element, value, combine, hours = 0) => {
      const key = `${date}|${element}`;
      const cur = daily.get(key);
      daily.set(key, cur ? { value: combine(cur.value, value), hours: cur.hours + hours } : { value, hours });
    };
    for (const v of series("maxTemperature")) put(localDate(v.t0 + (v.hours / 2) * 36e5), "TMAX", v.value, Math.max);
    for (const v of series("minTemperature")) put(localDate(v.t0 + v.hours * 36e5 - 1), "TMIN", v.value, Math.min);
    for (const [name, el] of [["quantitativePrecipitation", "PRCP"], ["snowfallAmount", "SNOW"]]) {
      for (const v of series(name)) {
        const h = Math.max(1, Math.round(v.hours));
        for (let i = 0; i < h; i++) put(localDate(v.t0 + i * 36e5), el, v.value / h, (a, b) => a + b, 1);
      }
    }
    for (const [name, el] of [["probabilityOfPrecipitation", "POP"], ["windGust", "GUST"]]) {
      for (const v of series(name)) {
        const h = Math.max(1, Math.round(v.hours));
        for (let i = 0; i < h; i++) put(localDate(v.t0 + i * 36e5), el, v.value, Math.max);
      }
    }
    const units = { TMAX: "degC", TMIN: "degC", PRCP: "mm", SNOW: "mm", POP: "%", GUST: "km/h" };
    const rows = [...daily.entries()]
      .map(([k, v]) => {
        const [date, element] = k.split("|");
        const partial = (element === "PRCP" || element === "SNOW") && v.hours < 24;
        return { date, element, value: Math.round(v.value * 10) / 10, units: units[element], partial_day: partial };
      })
      .sort((a, b) => a.date.localeCompare(b.date) || a.element.localeCompare(b.element));

    const key = stationRow ? stationRow.id : label;
    await q(`CREATE TABLE IF NOT EXISTS forecast (station VARCHAR, date DATE, element VARCHAR, value DOUBLE,
               units VARCHAR, partial_day BOOLEAN, issued TIMESTAMP)`);
    await q(`DELETE FROM forecast WHERE station = ${sqlString(key)}`);
    const issued = G.updateTime ? `TIMESTAMP '${G.updateTime.slice(0, 19).replace("T", " ")}'` : "NULL";
    if (rows.length) {
      await q(`INSERT INTO forecast VALUES ${rows.map((r) =>
        `(${sqlString(key)}, DATE '${r.date}', ${sqlString(r.element)}, ${r.value}, ${sqlString(r.units)}, ${r.partial_day}, ${issued})`).join(", ")}`);
    }

    // Grid cell center, and its distance from the station.
    const ring = grid.geometry?.coordinates?.[0] || [];
    const cLon = ring.length ? ring.slice(0, -1).reduce((a, c) => a + c[0], 0) / (ring.length - 1) : null;
    const cLat = ring.length ? ring.slice(0, -1).reduce((a, c) => a + c[1], 0) / (ring.length - 1) : null;
    const km = cLat === null ? null : 2 * 6371 * Math.asin(Math.sqrt(
      Math.sin(((cLat - point.lat) * Math.PI) / 360) ** 2 +
      Math.cos((point.lat * Math.PI) / 180) * Math.cos((cLat * Math.PI) / 180) * Math.sin(((cLon - point.lon) * Math.PI) / 360) ** 2));

    return {
      for: label,
      station: stationRow ? stationRow.id : undefined,
      nws_grid: `${P.gridId} ${P.gridX},${P.gridY}`,
      grid_cell_center: cLat === null ? undefined : { lat: Math.round(cLat * 1e4) / 1e4, lon: Math.round(cLon * 1e4) / 1e4, km_from_point: Math.round(km * 10) / 10 },
      grid_elevation_m: G.elevation?.value != null ? Math.round(G.elevation.value) : undefined,
      station_elevation_m: stationRow?.elev_m ?? undefined,
      issued: G.updateTime,
      time_zone: tz,
      table: `forecast(station, date, element, value, units, partial_day, issued) with station = '${key}'`,
      daily: rows,
      text_forecast: (text?.properties?.periods || []).slice(0, 14).map((p) => `${p.name}: ${p.temperature}°${p.temperatureUnit}, ${p.shortForecast}`),
      source: `NWS National Digital Forecast Database via ${P.forecastGridData}`,
    };
  }

  // Read-only SQL over the session tables. The CSP in index.html is what
  // really stops the database from reaching other hosts; this guard keeps the
  // model on SELECT-style queries over loaded data and gives a clear error.
  const FIRST_WORD = /^(with|select|from|summarize|describe|pivot|unpivot|values)\b/i;
  const FORBIDDEN =
    /\b(read_\w+|copy|attach|detach|install|load|pragma|set|reset|export|import|create|insert|update|delete|drop|alter|call|checkpoint|glob|parquet_\w+|sniff_csv|query_table)\b|https?:|s3:|\/\//i;

  function guardSql(sql) {
    const text = String(sql || "").trim().replace(/;+\s*$/, "");
    if (!text) throw new ToolError("Empty query.");
    if (text.includes(";")) throw new ToolError("Send one statement at a time.");
    if (!FIRST_WORD.test(text)) throw new ToolError("Only read-only queries (SELECT, WITH, SUMMARIZE, DESCRIBE, PIVOT) are allowed.");
    const m = text.replace(/'(?:[^']|'')*'/g, "''").match(FORBIDDEN);
    if (m) throw new ToolError(`"${m[0]}" is not allowed here; query the tables stations, coverage, obs and elements.`);
    return text;
  }

  async function select(sql, maxRows) {
    const text = guardSql(sql);
    let table;
    try {
      table = await q(`SELECT * FROM (${text}) LIMIT ${maxRows + 1}`);
    } catch (err) {
      throw new ToolError(String(err.message || err).split("\n").slice(0, 6).join("\n"));
    }
    const rows = toRows(table);
    const truncated = rows.length > maxRows;
    if (truncated) rows.length = maxRows;
    return { columns: table.schema.fields.map((f) => f.name), rows, truncated };
  }

  async function runSql({ query } = {}) {
    const r = await select(query, CONFIG.maxSqlRows);
    if (r.truncated) r.note = `Showing the first ${CONFIG.maxSqlRows} rows; aggregate further.`;
    return r;
  }

  return {
    db,
    findStations,
    loadSeries,
    loadArea,
    loadRecords,
    getForecast,
    // Unguarded SQL for the page's own code (the almanac); never exposed to the model.
    sql: async (text) => toRows(await q(text)),
    runSql,
    select,
    stats: () => ({ ...stats }),
    loaded: () => [...loaded.values()],
  };
}
