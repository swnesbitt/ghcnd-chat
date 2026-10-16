// Deployment settings. If you change lumenBaseUrl, also add the same origin to
// connect-src in the Content-Security-Policy <meta> tag in index.html, or the
// browser will block the request (the page tells you when that happens).

export const CONFIG = {
  // Your Lumen server (no trailing /v1).
  lumenBaseUrl: "https://lumen.computes.illinois.edu",

  // Shown on the Lumen consent page, and the name the API key gets on the
  // user's Lumen Profile page. Letters, digits, ".", "_" and "-" only.
  clientId: "ghcnd-chat",
  keyName: "ghcnd-chat",

  // Model selected by default when the user has access to it; otherwise the
  // first model that advertises tool calling.
  preferredModel: "gemma-4-31b-it",

  // NOAA Open Data Dissemination bucket for GHCN-Daily.
  bucket: "https://noaa-ghcn-pds.s3.amazonaws.com",

  // Station index built by scripts/build_station_index.py, served next to this page.
  stationIndexUrl: "station_index.parquet",
  // Gazetteer (GeoNames cities1000), loaded the first time a question names a place.
  placesUrl: "places.parquet",

  // Guard rails for the browser. by_year files cannot be filtered by station
  // before download, so a station with no by_station history (or a request
  // reaching into the recent tail) pulls whole element-years.
  maxDownloadMBPerCall: 250,
  maxSqlRows: 200,
  maxChartRows: 20000,
  maxToolSteps: 20,
};
