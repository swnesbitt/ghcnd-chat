"""A stand-in for Lumen's /v1 API with a scripted model, for testing the page
without a real key or model. It replays a fixed sequence of tool calls for
each user question and records every request in requests.jsonl.

    python test/mock_lumen.py [port]
"""

import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = "requests.jsonl"

SCRIPT = [
    ("find_stations", {"query": "CHAMPAIGN", "state": "IL", "element": "PRCP", "limit": 5}),
    ("load_series", {"station": "USC00118740", "elements": ["PRCP", "TMAX"], "start_year": 1990}),
    # O'Hare's by_station files stopped in February 2025, so this exercises the by_year tail.
    ("load_series", {"station": "USW00094846", "elements": ["PRCP"], "start_year": 2020}),
    ("run_sql", {"query": """
        WITH y AS (
          SELECT year(date) AS year, count(*) AS days, sum(value) AS total_mm
          FROM obs WHERE station = 'USC00118740' AND element = 'PRCP'
          GROUP BY 1)
        SELECT year, days, round(total_mm, 1) AS total_mm FROM y
        WHERE days >= 0.9 * 365 ORDER BY total_mm DESC LIMIT 10"""}),
    ("run_sql", {"query": "SELECT * FROM read_csv('https://example.com/leak.csv')"}),
    ("run_sql", {"query": "SELECT 1; DROP TABLE obs"}),
    ("make_chart", {
        "title": "Layered spec with nulls, sent as a string",
        "sql": "SELECT year(date) AS year, sum(value) AS total_mm FROM obs WHERE station = 'USC00118740' AND element = 'PRCP' GROUP BY 1 ORDER BY 1",
        "vega_lite": json.dumps({"layer": [{"mark": "line", "encoding": None}, None],
                                 "encoding": {"x": {"field": "year", "type": "quantitative"},
                                              "y": {"field": "total_mm", "type": "quantitative"}},
                                 "autosize": None, "config": None}),
    }),
    # Histogram with the count channel left out: the page must add it.
    ("make_chart", {
        "title": "Histogram without y",
        "sql": """SELECT value * 9 / 5 + 32 AS tmax_f FROM obs
                  WHERE station = 'USC00118740' AND element = 'TMAX' AND month(date) = 10 AND day(date) = 16""",
        "vega_lite": {"mark": "bar", "encoding": {"x": {"field": "tmax_f", "bin": True, "type": "quantitative"}}},
    }),
    ("make_chart", {
        "title": "Annual precipitation, Champaign 3S",
        "sql": """SELECT year(date) AS year, round(sum(value) / 25.4, 2) AS inches, count(*) AS days
                  FROM obs WHERE station = 'USC00118740' AND element = 'PRCP'
                  GROUP BY 1 HAVING count(*) >= 330 ORDER BY 1""",
        "vega_lite": {
            "mark": {"type": "bar"},
            "encoding": {
                "x": {"field": "year", "type": "ordinal", "axis": {"labelAngle": 0, "values": [1990, 2000, 2010, 2020]}},
                "y": {"field": "inches", "type": "quantitative", "title": "Precipitation (in)"},
                "tooltip": [{"field": "year"}, {"field": "inches"}, {"field": "days"}],
            },
            "data": {"url": "https://example.com/should-be-stripped.json"},
        },
    }),
]

FINAL = """The wettest years at **CHAMPAIGN 3S** (`USC00118740`) since 1990, counting only years with at least 90% of days present:

| Year | Total (mm) |
|---|---|
| (see query result) | |

<img src=x onerror="document.body.dataset.xss='1'">"""


class Handler(BaseHTTPRequestHandler):
    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")

    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def do_GET(self):
        if self.headers.get("Authorization") != "Bearer sk_test":
            return self.reply(401, {"error": {"message": "Invalid API key", "type": "invalid_request_error"}})
        if self.path.startswith("/v1/models"):
            return self.reply(200, {"data": [
                {"id": "gemma-4-31b-it", "status": "ok", "supports_function_calling": True},
                {"id": "plain-chat-model", "status": "ok", "supports_function_calling": False},
                {"id": "offline-model", "status": "down"},
            ]})
        if self.path.startswith("/v1/usage"):
            return self.reply(200, {"requests": 0, "coins_available": -2})
        self.reply(404, {"error": {"message": "not found"}})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        with open(LOG, "a") as f:
            f.write(json.dumps(body) + "\n")
        msgs = body["messages"]
        last_user = max(i for i, m in enumerate(msgs) if m["role"] == "user")
        n_tools = sum(1 for m in msgs[last_user:] if m["role"] == "tool")
        if not body.get("tools"):
            return self.reply(400, {"error": {"message": "expected tools"}})
        if n_tools < len(SCRIPT):
            name, args = SCRIPT[n_tools]
            msg = {"role": "assistant", "content": None, "reasoning_content": "scripted",
                   "tool_calls": [{"id": f"call_{n_tools}", "type": "function",
                                   "function": {"name": name, "arguments": json.dumps(args)}}]}
        else:
            msg = {"role": "assistant", "content": FINAL}
        self.reply(200, {"choices": [{"index": 0, "message": msg, "finish_reason": "stop"}],
                         "usage": {"prompt_tokens": 1, "completion_tokens": 1}})

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5001
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
