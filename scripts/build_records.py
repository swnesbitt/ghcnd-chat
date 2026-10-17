"""Build per-station monthly and all-time records from every GHCN-Daily value.

For each station, element and calendar month (and month 0 = all months) this
keeps the highest value with its date, the lowest value with its date for the
temperature elements, the runner-up value (a lone record far above the
runner-up is usually a data error), how many years and days of data the station has for that
month, and writes one small parquet file per US state or Canadian province
(e.g. records/US-NY.parquet) and per country elsewhere (records/AR.parquet), so
the browser fetches only the region a question is about.

It reads all of NOAA's by_year parquet files (about 8.5 GB for the six
elements), which takes roughly 10 to 20 minutes, so the Pages workflow caches
the output and rebuilds it weekly.

    pip install duckdb
    python scripts/build_records.py records [--elements SNOW,TMAX] [--index station_index.parquet]
"""

import argparse
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import duckdb

BUCKET = "https://noaa-ghcn-pds.s3.amazonaws.com/"

# element: (scale from GHCN integers to obs units, statistics kept)
SPEC = {
    "PRCP": (0.1, ("max",)),
    "SNOW": (1, ("max",)),
    "SNWD": (1, ("max",)),
    "TMAX": (0.1, ("max", "min")),
    "TMIN": (0.1, ("max", "min")),
    "TAVG": (0.1, ("max", "min")),
}


def list_keys(prefix: str) -> list[str]:
    keys, token = [], None
    while True:
        q = {"list-type": "2", "prefix": prefix}
        if token:
            q["continuation-token"] = token
        with urllib.request.urlopen(BUCKET + "?" + urllib.parse.urlencode(q), timeout=120) as r:
            xml = r.read().decode()
        keys += re.findall(r"<Key>([^<]+\.parquet)</Key>", xml)
        m = re.search(r"<NextContinuationToken>([^<]+)</NextContinuationToken>", xml)
        if not m:
            return keys
        token = m.group(1)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("out", nargs="?", default="records")
    ap.add_argument("--elements", default=",".join(SPEC))
    ap.add_argument("--index", default="station_index.parquet")
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    elements = [e.strip().upper() for e in a.elements.split(",") if e.strip()]

    con = duckdb.connect()
    con.sql("INSTALL httpfs; LOAD httpfs; SET preserve_insertion_order = false;")
    con.sql("""CREATE TABLE rec (id VARCHAR, element VARCHAR, month TINYINT, stat VARCHAR,
                                 value DOUBLE, date DATE, runner_up DOUBLE, n_years SMALLINT, n_days INTEGER)""")

    keys = list_keys("parquet/by_year/")
    for el in elements:
        scale, stats = SPEC[el]
        urls = [BUCKET + k for k in keys if f"/ELEMENT={el}/" in k]
        t0 = time.time()
        # One pass per element: monthly groups and the all-time group together.
        con.sql(f"""
            CREATE OR REPLACE TEMP TABLE agg AS
            WITH o AS (
                SELECT ID, DATE, DATA_VALUE AS v, substr(DATE, 5, 2)::TINYINT AS m
                FROM read_parquet({urls}, hive_partitioning = false)
                WHERE Q_FLAG IS NULL AND DATA_VALUE IS NOT NULL
            )
            SELECT ID AS id, coalesce(m, 0) AS month,
                   max(v) AS vmax, arg_max(DATE, v) AS dmax, max(v, 2)[2] AS vmax2,
                   min(v) AS vmin, arg_min(DATE, v) AS dmin, min(v, 2)[2] AS vmin2,
                   count(DISTINCT substr(DATE, 1, 4)) AS n_years, count(*) AS n_days
            FROM o GROUP BY GROUPING SETS ((ID, m), (ID))
        """)
        for stat in stats:
            v, d, v2 = ("vmax", "dmax", "vmax2") if stat == "max" else ("vmin", "dmin", "vmin2")
            con.sql(f"""
                INSERT INTO rec
                SELECT id, '{el}', month, '{stat}', round({v} * {scale}, 1),
                       strptime({d}, '%Y%m%d')::DATE, round({v2} * {scale}, 1), n_years, n_days
                FROM agg
            """)
        n = con.sql(f"SELECT count(*) FROM rec WHERE element = '{el}'").fetchone()[0]
        print(f"{el}: {len(urls)} files, {n} record rows, {time.time() - t0:.0f} s", flush=True)

    # Regions: state or province where NOAA gives one, otherwise the country.
    con.sql(f"""
        CREATE TABLE reg AS
        SELECT DISTINCT id,
               CASE WHEN state <> '' THEN substr(id, 1, 2) || '-' || state ELSE substr(id, 1, 2) END AS region
        FROM '{a.index}'
    """)
    regions = [r[0] for r in con.sql("SELECT DISTINCT region FROM reg ORDER BY 1").fetchall()]
    meta_regions = {}
    for region in regions:
        path = out / f"{region}.parquet"
        con.sql(f"""
            COPY (SELECT r.* FROM rec r JOIN reg g USING (id) WHERE g.region = '{region}'
                  ORDER BY r.element, r.id, r.month, r.stat)
            TO '{path}' (FORMAT parquet, COMPRESSION zstd)
        """)
        stations = con.sql(f"SELECT count(DISTINCT id) FROM '{path}'").fetchone()[0]
        if stations:
            meta_regions[region] = {"stations": stations, "bytes": path.stat().st_size}
        else:
            path.unlink()

    through = con.sql("SELECT max(date) FROM rec").fetchone()[0]
    total = con.sql("SELECT count(*) FROM rec").fetchone()[0]
    meta = {
        "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "data_through": str(through),
        "elements": elements,
        "regions": meta_regions,
    }
    (out / "meta.json").write_text(json.dumps(meta, indent=1))
    size = sum(r["bytes"] for r in meta_regions.values()) / 1e6
    print(f"wrote {len(meta_regions)} region files ({size:.1f} MB), {total} rows, data through {through}")
    if len(elements) == len(SPEC) and total < 1_000_000:
        sys.exit("record count is implausibly low; refusing to publish")


if __name__ == "__main__":
    main()
