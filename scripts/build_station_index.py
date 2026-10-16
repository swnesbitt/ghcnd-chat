"""Build station_index.parquet for the GHCN-Daily chat page.

Joins NOAA's ghcnd-stations.txt (location, name) with ghcnd-inventory.txt
(period of record per element) into one small zstd parquet, about 4 MB, so the
browser does not have to download and parse 48 MB of fixed-width text.

    pip install duckdb
    python scripts/build_station_index.py [output.parquet]
"""

import sys

import duckdb

BUCKET = "https://noaa-ghcn-pds.s3.amazonaws.com/"
ELEMENTS = ("PRCP", "SNOW", "SNWD", "TMAX", "TMIN", "TAVG")


def main(out: str) -> None:
    con = duckdb.connect()
    con.sql("INSTALL httpfs; LOAD httpfs;")

    # Both files are fixed-width; read each line whole and slice it.
    lines = "columns={'l': 'VARCHAR'}, header=false, delim='\\x01', quote='', escape=''"
    con.sql(f"""
        CREATE TABLE st AS
        SELECT trim(substr(l, 1, 11))                    AS id,
               substr(l, 13, 8)::DOUBLE                  AS lat,
               substr(l, 22, 9)::DOUBLE                  AS lon,
               nullif(trim(substr(l, 32, 6)), '')::DOUBLE AS elev,
               trim(substr(l, 39, 2))                    AS state,
               trim(substr(l, 42, 30))                   AS name
        FROM read_csv('{BUCKET}ghcnd-stations.txt', {lines})
    """)
    con.sql(f"""
        CREATE TABLE inv AS
        SELECT trim(substr(l, 1, 11))   AS id,
               substr(l, 32, 4)         AS element,
               substr(l, 37, 4)::INT    AS first_year,
               substr(l, 42, 4)::INT    AS last_year
        FROM read_csv('{BUCKET}ghcnd-inventory.txt', {lines})
    """)
    # elev of -999.9 means unknown.
    con.sql(f"""
        COPY (
            SELECT s.id, s.lat, s.lon,
                   CASE WHEN s.elev <= -999 THEN NULL ELSE s.elev END AS elev,
                   s.state, s.name, i.element, i.first_year, i.last_year
            FROM st s JOIN inv i USING (id)
            WHERE i.element IN {ELEMENTS}
            ORDER BY s.id, i.element
        ) TO '{out}' (FORMAT parquet, COMPRESSION zstd)
    """)
    n_st, n_rows = con.sql(f"SELECT count(DISTINCT id), count(*) FROM '{out}'").fetchone()
    print(f"wrote {out}: {n_st} stations, {n_rows} station-element rows")
    if n_st < 100_000:
        sys.exit("station count is implausibly low; refusing to publish")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "station_index.parquet")
