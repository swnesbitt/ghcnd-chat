"""Build per-station monthly and all-time records from every GHCN-Daily value.

For each station, element and calendar month (and month 0 = all months) this
keeps the highest value with its date, the lowest value with its date for the
temperature elements, the runner-up value (a lone record far above the
runner-up is usually a data error), how many years and days of data the station has for that
month, and writes one small parquet file per US state or Canadian province
(e.g. records/US-NY.parquet) and per country elsewhere (records/AR.parquet), so
the browser fetches only the region a question is about.

It reads all of NOAA's by_year parquet files (about 8.5 GB for the six
elements) in batches of whole years so memory stays flat; it takes roughly 30
to 60 minutes on a GitHub runner and runs monthly (.github/workflows/records.yml).

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


def list_keys(prefix: str) -> list[tuple[str, int]]:
    keys, token = [], None
    while True:
        q = {"list-type": "2", "prefix": prefix}
        if token:
            q["continuation-token"] = token
        with urllib.request.urlopen(BUCKET + "?" + urllib.parse.urlencode(q), timeout=120) as r:
            xml = r.read().decode()
        keys += [(k, int(n)) for k, n in re.findall(r"<Key>([^<]+\.parquet)</Key>.*?<Size>(\d+)</Size>", xml)]
        m = re.search(r"<NextContinuationToken>([^<]+)</NextContinuationToken>", xml)
        if not m:
            return keys
        token = m.group(1)


def batches(files: list[tuple[str, int, int]], target_bytes: int) -> list[list[str]]:
    """Group (key, size, year) into runs of whole years of about target_bytes each."""
    by_year: dict[int, list[tuple[str, int]]] = {}
    for key, size, year in files:
        by_year.setdefault(year, []).append((key, size))
    out, cur, cur_bytes = [], [], 0
    for year in sorted(by_year):
        size = sum(s for _, s in by_year[year])
        if cur and cur_bytes + size > target_bytes:
            out.append(cur)
            cur, cur_bytes = [], 0
        cur += [k for k, _ in by_year[year]]
        cur_bytes += size
    if cur:
        out.append(cur)
    return out


# Per batch of whole years: per station and month (and month 0 = all months),
# the two highest and two lowest values, the dates of the extremes, and the
# number of years and days. Batches hold disjoint years, so they fold together
# exactly: top-2 of the union is top-2 of the partial top-2s, counts add.
BATCH_SQL = """
    WITH o AS (
        SELECT ID, DATE, DATA_VALUE AS v, substr(DATE, 5, 2)::TINYINT AS m
        FROM read_parquet({files}, hive_partitioning = false)
        WHERE Q_FLAG IS NULL AND DATA_VALUE IS NOT NULL
    )
    SELECT ID AS id, coalesce(m, 0)::TINYINT AS month,
           max(v, 2) AS top_max, arg_max(DATE, v) AS dmax,
           min(v, 2) AS top_min, arg_min(DATE, v) AS dmin,
           count(DISTINCT substr(DATE, 1, 4))::INTEGER AS n_years, count(*)::BIGINT AS n_days
    FROM o GROUP BY GROUPING SETS ((ID, m), (ID))
"""

FOLD_SQL = """
    CREATE OR REPLACE TABLE acc AS
    SELECT id, month,
           list_slice(list_sort(flatten(list(top_max)), 'DESC'), 1, 2) AS top_max,
           arg_max(dmax, top_max[1]) AS dmax,
           list_slice(list_sort(flatten(list(top_min)), 'ASC'), 1, 2) AS top_min,
           arg_min(dmin, top_min[1]) AS dmin,
           sum(n_years)::INTEGER AS n_years, sum(n_days)::BIGINT AS n_days
    FROM (SELECT * FROM acc UNION ALL SELECT * FROM batch)
    GROUP BY id, month
"""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("out", nargs="?", default="records")
    ap.add_argument("--elements", default=",".join(SPEC))
    ap.add_argument("--index", default="station_index.parquet")
    ap.add_argument("--years", help="limit to a year range for testing, e.g. 1990-2005")
    ap.add_argument("--batch-mb", type=int, default=400, help="compressed MB of files per batch")
    ap.add_argument("--memory", default="9GB", help="DuckDB memory limit (GitHub runners have 16 GB)")
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    elements = [e.strip().upper() for e in a.elements.split(",") if e.strip()]
    y0, y1 = (int(x) for x in a.years.split("-")) if a.years else (0, 9999)

    con = duckdb.connect()
    con.sql(f"""INSTALL httpfs; LOAD httpfs;
               SET preserve_insertion_order = false;
               SET memory_limit = '{a.memory}';
               SET temp_directory = '{out.resolve()}.spill';""")
    con.sql("""CREATE TABLE rec (id VARCHAR, element VARCHAR, month TINYINT, stat VARCHAR,
                                 value DOUBLE, date DATE, runner_up DOUBLE, n_years SMALLINT, n_days INTEGER)""")

    keys = list_keys("parquet/by_year/")
    for el in elements:
        scale, stats = SPEC[el]
        files = []
        for key, size in keys:
            m = re.search(rf"YEAR=(\d+)/ELEMENT={el}/", key)
            if m and y0 <= int(m.group(1)) <= y1:
                files.append((BUCKET + key, size, int(m.group(1))))
        t0 = time.time()
        con.sql("""CREATE OR REPLACE TABLE acc (id VARCHAR, month TINYINT, top_max BIGINT[], dmax VARCHAR,
                                                top_min BIGINT[], dmin VARCHAR, n_years INTEGER, n_days BIGINT)""")
        groups = batches(files, a.batch_mb * 1_000_000)
        for i, group in enumerate(groups, 1):
            con.sql("CREATE OR REPLACE TEMP TABLE batch AS " + BATCH_SQL.format(files=group))
            con.sql(FOLD_SQL)
            con.sql("DROP TABLE batch")
            print(f"  {el} batch {i}/{len(groups)} ({len(group)} files), {time.time() - t0:.0f} s", flush=True)
        for stat in stats:
            top, d = ("top_max", "dmax") if stat == "max" else ("top_min", "dmin")
            con.sql(f"""
                INSERT INTO rec
                SELECT id, '{el}', month, '{stat}', round({top}[1] * {scale}, 1),
                       strptime({d}, '%Y%m%d')::DATE, round({top}[2] * {scale}, 1), n_years, n_days
                FROM acc
            """)
        con.sql("DROP TABLE acc")
        n = con.sql(f"SELECT count(*) FROM rec WHERE element = '{el}'").fetchall()[0][0]
        print(f"{el}: {len(files)} files in {len(groups)} batches, {n} record rows, {time.time() - t0:.0f} s", flush=True)

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
        stations = con.sql(f"SELECT count(DISTINCT id) FROM '{path}'").fetchall()[0][0]
        if stations:
            meta_regions[region] = {"stations": stations, "bytes": path.stat().st_size}
        else:
            path.unlink()

    through = con.sql("SELECT max(date) FROM rec").fetchall()[0][0]
    total = con.sql("SELECT count(*) FROM rec").fetchall()[0][0]
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
