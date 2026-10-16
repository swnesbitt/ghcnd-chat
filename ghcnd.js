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
      SELECT DISTINCT id, name, state, substr(id, 1, 2) AS country,
             lat, lon, elev AS elev_m
      FROM 'station_index.parquet';
    CREATE TABLE obs (station VARCHAR, element VARCHAR, date DATE, value DOUBLE, m_flag VARCHAR);
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
  const RAW_COLS = "ID, DATE, DATA_VALUE, M_FLAG, Q_FLAG";

  // ---- Tools --------------------------------------------------------------

  async function findStations({ query, state, country, lat, lon, radius_km, element, min_years, limit = 10 } = {}) {
    const where = [];
    const hasPoint = Number.isFinite(lat) && Number.isFinite(lon);
    if (query) {
      const term = String(query).trim().toUpperCase();
      where.push(STATION_RE.test(term) ? `s.id = ${sqlString(term)}` : `s.name ILIKE ${sqlString("%" + term + "%")}`);
    }
    if (state) where.push(`s.state = ${sqlString(String(state).toUpperCase())}`);
    if (country) where.push(`s.country = ${sqlString(String(country).toUpperCase())}`);
    if (element) {
      const el = String(element).toUpperCase();
      if (!ELEMENTS[el]) throw new ToolError(`Unknown element ${element}. Use one of ${Object.keys(ELEMENTS).join(", ")}.`);
      const minY = Number.isFinite(min_years) ? Math.max(0, Math.floor(min_years)) : 0;
      where.push(`EXISTS (SELECT 1 FROM coverage c WHERE c.id = s.id AND c.element = ${sqlString(el)}
                  AND c.last_year - c.first_year + 1 >= ${minY})`);
    }
    if (!where.length && !hasPoint) throw new ToolError("Give a name, station ID, state, country or lat/lon.");

    // Haversine distance in km when a point is given.
    const dist = hasPoint
      ? `2 * 6371 * asin(sqrt(pow(sin(radians(s.lat - ${lat}) / 2), 2) +
           cos(radians(${lat})) * cos(radians(s.lat)) * pow(sin(radians(s.lon - ${lon}) / 2), 2)))`
      : "NULL";
    const radius = Number.isFinite(radius_km) ? radius_km : 50;
    const n = Math.min(Math.max(1, Math.floor(limit) || 10), 50);
    const sortEl = sqlString(element ? String(element).toUpperCase() : "PRCP");

    const sql = `
      WITH s AS (SELECT s.*, ${dist} AS distance_km FROM stations s
                 ${where.length ? "WHERE " + where.join(" AND ") : ""})
      SELECT s.id, s.name, s.state, s.country, round(s.lat, 4) AS lat, round(s.lon, 4) AS lon,
             s.elev_m, round(s.distance_km, 1) AS distance_km,
             (SELECT string_agg(c.element || ' ' || c.first_year || '-' || c.last_year, ', ' ORDER BY c.element)
                FROM coverage c WHERE c.id = s.id) AS coverage
      FROM s
      ${hasPoint ? `WHERE s.distance_km <= ${radius}` : ""}
      ORDER BY ${hasPoint ? "s.distance_km," : ""}
               (SELECT max(c.last_year - c.first_year) FROM coverage c
                 WHERE c.id = s.id AND c.element = ${sortEl}) DESC NULLS LAST
      LIMIT ${n}`;
    const rows = toRows(await q(sql));
    return { stations: rows, note: rows.length ? undefined : "No stations matched." };
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
          SELECT ID, ${sqlString(p.el)}, strptime(DATE, '%Y%m%d')::DATE, DATA_VALUE::DOUBLE * ${scale}, M_FLAG
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
      downloaded_mb_this_session: Math.round(stats.bytes / 1e5) / 10,
      table: "obs(station, element, date, value, m_flag)",
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
    runSql,
    select,
    stats: () => ({ ...stats }),
    loaded: () => [...loaded.values()],
  };
}
