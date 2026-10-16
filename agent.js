// agent.js — the tool-calling loop. Lumen forwards `tools` and `tool_choice`
// to the model backend, so the whole loop runs here in the browser: ask the
// model, run the tools it calls, send the results back, repeat until it answers.

import { CONFIG } from "./config.js";

export const SYSTEM_PROMPT = `You help a meteorologist explore NOAA GHCN-Daily (GHCNd) station observations. You work only through the tools below, which run DuckDB in the user's browser over NOAA's public GHCNd data.

How to work:
1. find_stations to identify stations, by name, or by area: a place ("Peoria, IL") with radius_km, a lat/lon with radius_km, a state, a US county with its state, or a country. Names repeat across states and countries (several stations are named URBANA, in different states). When the place the user means is ambiguous, list the candidates (ID, name, state, coverage) and ask; when one clearly matches, say which one you chose.
2. Load data into the table obs:
   - load_area for questions across many stations over a day or a short period ("the highest temperature in Illinois on 4/5/1974", "rain totals near Peoria last week"). It loads every station in a state, country or radius at once. Never answer an extreme for a state or region from a handful of stations.
   - load_series for long records at one or a few stations (trends, climatologies, records at a site).
3. run_sql to compute. Aggregate in SQL and return small results; never dump raw daily rows.
4. make_chart when a picture helps, with a Vega-Lite spec. The data comes from the chart's own SQL; do not put data or URLs in the spec.

Tables:
- stations(id, name, state, county, country, lat, lon, elev_m) — country is the 2-letter FIPS prefix of the ID; county is the US county
- coverage(id, element, first_year, last_year)
- elements(element, units, description)
- obs(station, element, date DATE, value DOUBLE, m_flag, obs_time) — only what load_series and load_area have loaded; values that failed NOAA quality control are already removed; join stations on obs.station = stations.id for names

Data rules:
- Units in obs: PRCP, SNOW, SNWD in mm; TMAX, TMIN, TAVG in °C. For US stations, answer in °F and inches with the metric value in parentheses, e.g. 99 °F (37.2 °C); elsewhere answer in metric, unless the user asks otherwise.
- obs can hold several stations and elements at once; always filter by station and element.
- A missing day is missing, not zero. For monthly, seasonal or annual totals and means, count the days present and exclude or flag periods with poor coverage (say what threshold you used, e.g., 90% of days).
- m_flag 'T' marks trace precipitation, stored as 0.
- Cooperative observers report the max and min for the 24 hours ending at obs_time (e.g., '0700'); with a morning obs_time, much of a day's TMAX belongs to the previous afternoon. Mention this when ranking one day's extremes across stations.
- TAVG is sparse at US stations; use (TMAX + TMIN) / 2 from same-day pairs for daily mean temperature.
- NOAA updates the data daily; the latest days may be incomplete.

SQL is DuckDB, not SQLite:
- Dates: year(date), month(date), day(date), strftime(date, '%m-%d') with the date first, date_diff('day', a, b). There is no 'now'.
- For "today", use the literal date given at the end of these instructions (DATE 'YYYY-MM-DD'), not current_date: the database clock is UTC and can already be tomorrow.
- The same calendar day in every year: WHERE month(date) = <month> AND day(date) = <day>, with today's numbers.
- One statement per call, no trailing semicolon needed.

Records and extremes: give the value, the date it happened (list ties), the station, and the period of record searched, e.g. "99 °F (37.2 °C) on August 27, 1948, at Buffalo Niagara Intl AP (USW00014733), 1938-2026". Get the date with ORDER BY value DESC LIMIT 5 rather than max(value) next to an ungrouped column.

Answers: name the station ID and period used, put key numbers in a small markdown table, and keep it short. Every number must come from a tool result; never estimate values you did not compute.`;

// The model has no clock, so every request carries the user's local date.
export function systemPrompt(now = new Date()) {
  const date = now.toLocaleDateString("en-CA"); // YYYY-MM-DD in the browser's time zone
  const day = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  return `${SYSTEM_PROMPT}\n\nToday is ${day} (${date}) in the user's time zone. "Today" in a question means this calendar day: month ${now.getMonth() + 1}, day ${now.getDate()}.`;
}

export const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "find_stations",
      description:
        "Search the GHCN-Daily station index by name or ID, and/or by area: a place with radius_km, a lat/lon with radius_km, a state, a US county with its state, or a country. Returns up to `limit` stations with locations and period of record per element, plus total_matching.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Part of the station name (e.g., 'CHAMPAIGN') or an exact 11-character station ID" },
          place: { type: "string", description: "Town or city, best with its state or ISO country: 'Peoria, IL', 'Cordoba, AR'. Searches radius_km around it." },
          county: { type: "string", description: "US county name, with state, e.g., county 'Champaign' and state 'IL'" },
          state: { type: "string", description: "US state or Canadian province code, e.g., 'IL'" },
          country: { type: "string", description: "2-letter FIPS country code (first two characters of the ID), e.g., 'US', 'AR'" },
          lat: { type: "number" },
          lon: { type: "number" },
          radius_km: { type: "number", description: "Search radius around lat/lon; default 50" },
          element: { type: "string", enum: ["PRCP", "SNOW", "SNWD", "TMAX", "TMIN", "TAVG"], description: "Only stations that report this element" },
          min_years: { type: "number", description: "Minimum period of record in years for the element" },
          limit: { type: "number", description: "Maximum stations to return (default 10, max 50)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "load_series",
      description:
        "Load daily observations for one station into table obs (replacing earlier loads of the same station and element). History comes from small per-station files; recent years need whole element-year files, so long requests for stations without per-station files can be refused.",
      parameters: {
        type: "object",
        properties: {
          station: { type: "string", description: "11-character station ID from find_stations" },
          elements: {
            type: "array",
            items: { type: "string", enum: ["PRCP", "SNOW", "SNWD", "TMAX", "TMIN", "TAVG"] },
            description: "Elements to load; default ['PRCP']",
          },
          start_year: { type: "number" },
          end_year: { type: "number" },
        },
        required: ["station"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "load_area",
      description:
        "Load every station in an area for a period of up to one year into table obs, from NOAA's files that hold all stations for an element-year. The area is a place with radius_km ('Peoria, IL', 50), a lat/lon with radius_km, a state, a US county with its state, a country, or a list of station IDs. Use this for 'highest/lowest/most in <area> on <date>' and other many-station questions.",
      parameters: {
        type: "object",
        properties: {
          place: { type: "string", description: "Town or city, best with its state or ISO country: 'Peoria, IL', 'Cordoba, AR'. Searches radius_km around it." },
          county: { type: "string", description: "US county name, with state, e.g., county 'Champaign' and state 'IL'" },
          state: { type: "string", description: "US state or Canadian province code, e.g., 'IL'" },
          country: { type: "string", description: "2-letter FIPS country code, e.g., 'US'" },
          lat: { type: "number" },
          lon: { type: "number" },
          radius_km: { type: "number", description: "Radius around lat/lon; default 50" },
          stations: { type: "array", items: { type: "string" }, description: "Explicit station IDs instead of an area" },
          elements: {
            type: "array",
            items: { type: "string", enum: ["PRCP", "SNOW", "SNWD", "TMAX", "TMIN", "TAVG"] },
          },
          start_date: { type: "string", description: "YYYY-MM-DD" },
          end_date: { type: "string", description: "YYYY-MM-DD; defaults to start_date" },
        },
        required: ["elements", "start_date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_sql",
      description:
        "Run one read-only DuckDB SQL query (SELECT, WITH, SUMMARIZE, DESCRIBE) over stations, coverage, elements and obs. Returns at most 200 rows.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "make_chart",
      description:
        "Show the user a chart. Give a read-only SQL query that returns the rows to plot and a Vega-Lite v6 spec (a JSON object, not a string) whose fields match the query's column names. The rows are inserted as the spec's data, so leave data out. Keep specs simple, e.g. {\"mark\": \"line\", \"encoding\": {\"x\": {\"field\": \"year\", \"type\": \"quantitative\"}, \"y\": {\"field\": \"days_90f\", \"type\": \"quantitative\", \"title\": \"Days at or above 90 °F\"}}}. For several series, return a long table with a series column and encode it as color. For a histogram, return the raw values and use {\"mark\": \"bar\", \"encoding\": {\"x\": {\"field\": \"tmax_f\", \"bin\": {\"step\": 2}, \"type\": \"quantitative\"}, \"y\": {\"aggregate\": \"count\", \"type\": \"quantitative\"}}}.",
      parameters: {
        type: "object",
        properties: {
          sql: { type: "string" },
          vega_lite: { type: "object", description: "Vega-Lite spec without a data property" },
          title: { type: "string" },
        },
        required: ["sql", "vega_lite"],
      },
    },
  },
];

// Keep only the fields a chat request accepts; some backends add reasoning
// fields to replies that they reject when sent back.
function cleanAssistant(msg) {
  const out = { role: "assistant", content: msg.content ?? "" };
  if (msg.tool_calls?.length) out.tool_calls = msg.tool_calls;
  return out;
}

function clip(text, max = 16000) {
  return text.length > max ? text.slice(0, max) + `… [truncated ${text.length - max} characters]` : text;
}

/**
 * Run one user turn.
 * @param {object} o
 * @param {object} o.lumen      client from lumen-oauth.js
 * @param {string} o.model
 * @param {Array}  o.messages   conversation so far, including the new user message; appended to in place
 * @param {object} o.handlers   tool name -> async (args) => result
 * @param {function} o.onStep   UI callback: {type: "thinking" | "tool_start" | "tool_end", ...}
 * @param {AbortSignal} o.signal
 * @returns {Promise<string>} the assistant's final text
 */
export async function runTurn({ lumen, model, messages, handlers, onStep = () => {}, signal }) {
  for (let step = 0; step < CONFIG.maxToolSteps; step++) {
    onStep({ type: "thinking" });
    const resp = await lumen.api("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: systemPrompt() }, ...messages],
        tools: TOOL_SCHEMAS,
        tool_choice: "auto",
        temperature: 0.2,
      }),
      signal,
    });
    const body = await resp.json();
    const msg = body.choices?.[0]?.message;
    if (!msg) throw new Error("The model returned no message.");
    messages.push(cleanAssistant(msg));
    if (!msg.tool_calls?.length) return msg.content ?? "";

    for (const call of msg.tool_calls) {
      const name = call.function?.name;
      let args;
      let result;
      try {
        args = JSON.parse(call.function?.arguments || "{}");
      } catch {
        args = null;
      }
      onStep({ type: "tool_start", id: call.id, name, args });
      if (args === null) {
        result = { error: "Arguments were not valid JSON." };
      } else if (!handlers[name]) {
        result = { error: `Unknown tool ${name}.` };
      } else {
        try {
          result = await handlers[name](args);
        } catch (err) {
          if (signal?.aborted) throw err;
          result = { error: String(err.message || err) };
        }
      }
      onStep({ type: "tool_end", id: call.id, name, args, result });
      messages.push({ role: "tool", tool_call_id: call.id, content: clip(JSON.stringify(result)) });
    }
  }
  throw new Error(`Stopped after ${CONFIG.maxToolSteps} tool steps without an answer. Try a narrower question.`);
}
