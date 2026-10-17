# GHCN-Daily chat

A static web page for asking questions of NOAA's Global Historical Climatology
Network Daily (GHCNd) record in plain language. There is no server. Everything
runs in the user's browser:

- **Lumen** ([ncsa/lumen](https://github.com/ncsa/lumen) 2.2.0 or later) provides
  the language model. Users sign in with Lumen's OAuth PKCE flow and approve a key
  for this page; the page never sees a password and never needs a shared key.
- **DuckDB-WASM** reads NOAA's parquet files straight from the public bucket
  (`s3://noaa-ghcn-pds/parquet/`), which allows cross-origin reads.
- **The agent loop** runs in the page: the model calls seven tools (find stations,
  load a station's series, load an area, load records, get the NWS forecast, run SQL,
  draw a chart); the page runs them and sends back the results. Lumen forwards
  `tools` and `tool_choice` to the model backend.

```
browser ──PKCE──► Lumen ──► model (tool calling)
   │
   └──► NOAA S3 parquet (DuckDB-WASM, CORS)
```

## Files

| File | What it is |
|------|------------|
| `index.html`, `styles.css` | The page, in University of Illinois brand (Illinois Web Toolkit header and footer, CliMAS unit), and its Content-Security-Policy |
| `geo/us-counties-10m.json` | US county, state and nation outlines for maps ([us-atlas](https://github.com/topojson/us-atlas) 3.0.1, Census 1:10m cartographic boundaries, 840 KB TopoJSON), loaded on the first map |
| `img/climas-icon.jpg` | CliMAS icon, used as the favicon and on the sign-in view |
| `config.js` | Lumen URL, default model, guard-rail limits |
| `app.js` | Sign-in, UI, charts |
| `agent.js` | System prompt, tool schemas, the tool-calling loop |
| `ghcnd.js` | DuckDB-WASM session, station search, the series loader, SQL guard |
| `lumen-oauth.js` | Copied unchanged from `ncsa/lumen` `scripts/web-oauth` (Apache-2.0, see `NOTICE`) |
| `scripts/build_station_index.py` | Builds `station_index.parquet` (about 4 MB: NOAA's station and inventory files plus each US station's county) and `places.parquet` (about 4 MB: GeoNames places of 1,000+ people, loaded only when a question names a place) |
| `.github/workflows/pages.yml` | Rebuilds the index daily and deploys to GitHub Pages |
| `almanac.js` | The Climate at a glance tab |
| `test/` | Headless-Chrome end-to-end tests (`run_browser_test.py` for chat, `run_almanac_test.py` for the almanac) with a scripted mock Lumen |

## Configure

1. **`config.js`**: `lumenBaseUrl` (set to `https://lumen.computes.illinois.edu`)
   and `preferredModel` (set to `gemma-4-31b-it`).
2. **`index.html`**: the same Lumen origin must be in `connect-src` in the CSP
   `<meta>` tag. If it is missing, the page shows a banner saying so.

## Check that the model can call tools

The page only works with a model whose backend returns structured `tool_calls`.
That needs `supports_function_calling` set on the model in Lumen and a tool
parser enabled on the serving backend (vLLM, SGLang). Test it with your own key
before deploying. If you have run Lumen's `lumen.sh`, `LUMEN_API_KEY` is already
set in your shell:

```bash
curl -s https://lumen.computes.illinois.edu/v1/chat/completions \
  -H "Authorization: Bearer $LUMEN_API_KEY" -H "Content-Type: application/json" \
  -d '{"model": "gemma-4-31b-it",
       "messages": [{"role": "user", "content": "Find stations named Champaign in Illinois."}],
       "tools": [{"type": "function", "function": {"name": "find_stations",
         "parameters": {"type": "object", "properties": {
           "query": {"type": "string"}, "state": {"type": "string"}}}}}]}' \
  | python3 -m json.tool
```

The reply should contain `"tool_calls"` with `find_stations` and arguments like
`{"query": "CHAMPAIGN", "state": "IL"}`. If the model instead writes the call as
text in `content`, the backend's tool parser is not enabled; ask the Lumen admins.

## Run locally

```bash
pip install duckdb
python scripts/build_station_index.py      # writes station_index.parquet
python -m http.server 8000
```

Open <http://localhost:8000/> and click **Connect to Lumen**. Lumen accepts
`http://localhost` redirect URIs for development, and the page must be served
over HTTP (not opened as a file) for ES modules and the OAuth redirect to work.

## Deploy to GitHub Pages

1. Push this directory to a GitHub repository.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. The workflow builds the station index and publishes the site on every push to
   `main` and daily at 07:17 UTC. The index is shipped in the Pages artifact rather
   than committed, so the repository does not grow by 4 MB a day; it is in
   `.gitignore` for that reason.

The page's own URL (for example `https://swnesbitt.github.io/ghcnd-chat/`) is the
OAuth redirect URI; Lumen accepts any `https` redirect, so there is nothing to
register.

## How the data loading works

NOAA publishes two parquet layouts of the same data:

| Layout | Contents | Cost for one station |
|--------|----------|----------------------|
| `by_station/STATION=<id>/ELEMENT=<el>/` | One station, one element | About 0.2 MB |
| `by_year/YEAR=<y>/ELEMENT=<el>/` | Every station for one element-year, refreshed daily, sorted by date | The whole element-year (PRCP 2026: 28 MB; TMAX: 10 MB) |

When this was written (October 2026), `by_station` was refreshed daily for some
stations (Champaign 3S, `USC00118740`) and had not changed since February 2025 for
others (Chicago O'Hare, `USW00094846`). `load_series` therefore:

1. reads the station's `by_station` files and finds the last date they hold;
2. if that date is more than ten days old, fills the gap from `by_year`, keeping
   only that station's rows;
3. keeps every downloaded file for the session, so a second station needing the
   same element-year costs nothing more;
4. refuses a call that would download more than `maxDownloadMBPerCall` (250 MB),
   which can happen for stations with no `by_station` files, and tells the model
   to narrow the period.

GHCN-Daily runs a few days behind. For US stations, `load_series` then fills
the newest days from ACIS, the NOAA Regional Climate Centers' database
(`data.rcc-acis.org`, which accepts GHCN-Daily IDs and allows browser
requests). Those values are converted to GHCN units, listed in table
`provisional`, and labeled provisional in answers and in the almanac.

Values are scaled to mm and °C, and rows with a NOAA quality flag are dropped
(the count is reported to the model).

## Climate at a glance

The second tab is an almanac for one station. Enter a GHCN-Daily ID, or a place:
a place lists the nearest stations with their periods of record and starts on
the nearest one with a long, current temperature and precipitation record.
Link to one directly with `?station=USC00118740` or `?place=Champaign, IL`, and
add `&date=2026-01-25` for an almanac as of a past date (observations only).

Sections, each with a blue box of text:

- **Yesterday and today**: the latest report and today's NWS forecast against
  the 1991–2020 normal and the station's record for the date, with a note when
  a morning observer's high belongs to the previous afternoon.
- **The past 5 days and the next 5**: highs and lows against normals and
  records, classified by percentile of the station's 1991–2020 values within a
  week of the date.
- **The past year**: daily temperature departures, cumulative precipitation
  against normal, month by month, and snowfall for October 1 to April 15.
- **One of four seasonal stories**: the spring frost tracker (Mar 1 – Jun 10),
  "How hot is this summer?" (Jun 11 – Aug 31), the fall frost tracker
  (Sep 1 – Dec 10) and "How cold is this winter?" (Dec 11 – Feb). The frost
  trackers use NOAA's 10/50/90% dates, show the forecast lows, flag a forecast
  low within 3°F of a threshold as possible, and say how early or late a date
  is against the station's 1991–2020 seasons. The season stories rank the season
  so far against the same dates in every year on record.
- **Degree days this year**: growing (base 50°F, capped at 86°F), heating and
  cooling (base 65°F) degree days against normal.

Normals are NOAA's 1991–2020 U.S. Climate Normals from NCEI where the station
has them, otherwise computed from the station's own 1991–2020 data (smoothed).
Everything numeric is computed in the page; the model writes only the text in
the boxes, from a summary of those numbers. Signed out, the boxes get plain
templated text.

## Areas

`find_stations` and `load_area` accept the same areas:

- a place with a radius, `"Peoria, IL"` with `radius_km` (default 50); a bare name
  that exists in several states or countries is refused with the candidates;
- a latitude and longitude with a radius;
- a state, a US county with its state, or a country;
- a list of station IDs.

`load_area` loads every station in the area for up to a year from the `by_year`
files, so a statewide question ("the highest temperature in Illinois on 4/5/1974")
costs one element-year download (about 19 MB for 1974 TMAX) and covers all 107
Illinois stations that reported that day.

## Maps

`make_chart` takes an optional `basemap`: `{"level": "states" | "counties", "state": "IL"}`
draws state or county outlines, zoomed to one state if given, under the model's
layers, which then place stations with `longitude`/`latitude` encodings (models
that put lon/lat on x/y are corrected). With `"color_by": {"field": ...}` it shades
counties (query returns `county_fips`) or states (query returns `state`) instead:
a choropleth. Map points default to larger dots with white edges and a viridis
color scale so they read on the gray basemap.

## Security

- **Content-Security-Policy.** `connect-src` allows only this site, Lumen, the
  NOAA bucket, the CDN and DuckDB's extension server. DuckDB's worker inherits
  the policy, so a model-written query cannot send data anywhere else (the test
  checks this).
- **SQL guard.** `run_sql` and `make_chart` accept one read-only statement and
  reject file and network functions, DDL and DML, with an error the model can act on.
- **Rendering.** Model output is rendered as Markdown through DOMPurify; tool
  results and station names are inserted as text. Charts are drawn with Vega's
  expression interpreter, so the CSP needs no `unsafe-eval`, and any `url` in a
  model's chart spec is removed.
- **Campus footer.** The Illinois toolkit footer tries to add the campus OneTrust
  cookie script. The CSP blocks it, because a third-party script could read the
  Lumen key and the page sets no cookies, and the inert "About Cookies" button is
  hidden. The two CSP messages this leaves in the console are expected.
- **The key** is kept in `localStorage`, as in Lumen's example. **Disconnect**
  forgets it in this browser; revoking it on the Lumen Profile page stops it
  everywhere.

## Test

```bash
pip install playwright duckdb && python -m playwright install chromium
python test/run_browser_test.py            # or --chrome /path/to/chrome
```

The test serves a copy of the site pointed at `test/mock_lumen.py`, a scripted
stand-in for Lumen that replays a fixed sequence of tool calls. It runs against
the real NOAA bucket: it loads Champaign 3S (by_station only) and O'Hare (by_station
plus by_year tail), checks the forbidden-SQL refusals, chart rendering, HTML
sanitizing, the CSP blocks, the dark-mode chart redraw and the PKCE redirect, and
writes screenshots to `test/out/`.

## Limits

- The browser holds downloaded files in memory; DuckDB-WASM is limited to about
  4 GB. Questions over thousands of stations, or decades of `by_year` files for
  stations without `by_station` history, belong on a server.
- Answers are only as good as the model's tool use. The system prompt in
  `agent.js` carries the GHCNd rules the model should not have to guess (units,
  missing days are not zeros, trace flags, TAVG sparsity, filtering `obs` by station).
