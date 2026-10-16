"""Build the lookup tables the GHCN-Daily chat page loads in the browser.

station_index.parquet (about 4 MB)
    NOAA's ghcnd-stations.txt (location, name) joined with ghcnd-inventory.txt
    (period of record per element), plus the US county each US station falls
    in, from the Census Bureau's 1:500k cartographic county boundaries.

places.parquet (about 3 MB, loaded only when a question names a place)
    GeoNames cities1000: every populated place of 1,000 people or more
    worldwide, with coordinates, used to turn "near Peoria" into a point.

    pip install duckdb
    python scripts/build_station_index.py [output directory]
"""

import io
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

import duckdb

NOAA = "https://noaa-ghcn-pds.s3.amazonaws.com/"
COUNTIES = "https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_county_500k.zip"
GEONAMES = "https://download.geonames.org/export/dump/cities1000.zip"
ELEMENTS = ("PRCP", "SNOW", "SNWD", "TMAX", "TMIN", "TAVG")


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=300) as r:
        return r.read()


def main(out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp())
    con = duckdb.connect()
    con.sql("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial;")

    # ---- Stations and inventory (fixed-width text; read whole lines and slice)
    lines = "columns={'l': 'VARCHAR'}, header=false, delim='\\x01', quote='', escape=''"
    con.sql(f"""
        CREATE TABLE st AS
        SELECT trim(substr(l, 1, 11))                    AS id,
               substr(l, 13, 8)::DOUBLE                  AS lat,
               substr(l, 22, 9)::DOUBLE                  AS lon,
               nullif(trim(substr(l, 32, 6)), '')::DOUBLE AS elev,
               trim(substr(l, 39, 2))                    AS state,
               trim(substr(l, 42, 30))                   AS name
        FROM read_csv('{NOAA}ghcnd-stations.txt', {lines})
    """)
    con.sql(f"""
        CREATE TABLE inv AS
        SELECT trim(substr(l, 1, 11))   AS id,
               substr(l, 32, 4)         AS element,
               substr(l, 37, 4)::INT    AS first_year,
               substr(l, 42, 4)::INT    AS last_year
        FROM read_csv('{NOAA}ghcnd-inventory.txt', {lines})
    """)

    # ---- US county for each US station (point in polygon)
    zip_path = tmp / "counties.zip"
    zip_path.write_bytes(fetch(COUNTIES))
    shp = f"/vsizip/{zip_path}/" + Path(COUNTIES).stem + ".shp"
    con.sql(f"CREATE TABLE county AS SELECT NAME AS county, STUSPS AS county_state, GEOID AS county_fips, geom FROM ST_Read('{shp}')")
    con.sql("""
        CREATE TABLE st_county AS
        SELECT s.id, c.county, c.county_fips
        FROM st s JOIN county c
          ON s.id LIKE 'US%' AND ST_Contains(c.geom, ST_Point(s.lon, s.lat))
    """)

    # elev of -999.9 means unknown.
    station_out = out_dir / "station_index.parquet"
    con.sql(f"""
        COPY (
            SELECT s.id, s.lat, s.lon,
                   CASE WHEN s.elev <= -999 THEN NULL ELSE s.elev END AS elev,
                   s.state, s.name, sc.county, sc.county_fips,
                   i.element, i.first_year, i.last_year
            FROM st s JOIN inv i USING (id) LEFT JOIN st_county sc USING (id)
            WHERE i.element IN {ELEMENTS}
            ORDER BY s.id, i.element
        ) TO '{station_out}' (FORMAT parquet, COMPRESSION zstd)
    """)
    n_st, n_rows, n_cty = con.sql(
        f"SELECT count(DISTINCT id), count(*), count(DISTINCT id) FILTER (WHERE county IS NOT NULL) FROM '{station_out}'"
    ).fetchone()
    print(f"wrote {station_out}: {n_st} stations ({n_cty} with a US county), {n_rows} station-element rows")
    if n_st < 100_000 or n_cty < 30_000:
        sys.exit("station or county counts are implausibly low; refusing to publish")

    # ---- Places (GeoNames cities1000, tab-separated inside a zip)
    with zipfile.ZipFile(io.BytesIO(fetch(GEONAMES))) as z:
        (tmp / "cities1000.txt").write_bytes(z.read("cities1000.txt"))
    places_out = out_dir / "places.parquet"
    cols = ("{'geonameid': 'BIGINT', 'name': 'VARCHAR', 'asciiname': 'VARCHAR', 'alternatenames': 'VARCHAR', "
            "'lat': 'DOUBLE', 'lon': 'DOUBLE', 'feature_class': 'VARCHAR', 'feature_code': 'VARCHAR', "
            "'country': 'VARCHAR', 'cc2': 'VARCHAR', 'admin1': 'VARCHAR', 'admin2': 'VARCHAR', 'admin3': 'VARCHAR', "
            "'admin4': 'VARCHAR', 'population': 'BIGINT', 'elevation': 'VARCHAR', 'dem': 'VARCHAR', "
            "'timezone': 'VARCHAR', 'modified': 'VARCHAR'}")
    con.sql(f"""
        COPY (
            SELECT name, asciiname, country, admin1, round(lat, 4) AS lat, round(lon, 4) AS lon, population
            FROM read_csv('{tmp / "cities1000.txt"}', delim='\\t', header=false, quote='', columns={cols})
            ORDER BY asciiname
        ) TO '{places_out}' (FORMAT parquet, COMPRESSION zstd)
    """)
    n_pl = con.sql(f"SELECT count(*) FROM '{places_out}'").fetchone()[0]
    print(f"wrote {places_out}: {n_pl} places")
    if n_pl < 100_000:
        sys.exit("place count is implausibly low; refusing to publish")


if __name__ == "__main__":
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else Path("."))
