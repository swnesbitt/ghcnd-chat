"""End-to-end test in headless Chrome against the real NOAA bucket and the
scripted mock Lumen in mock_lumen.py.

    pip install playwright
    python test/run_browser_test.py [--chrome /path/to/chrome] [--out DIR]

The test copies the site to a temporary directory, points config.js and the CSP
at http://localhost:5001, seeds a fake key so no sign-in is needed, asks the
first example question and checks the transcript, the guard rails, the chart,
the rail and the CSP.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SITE_FILES = ["index.html", "styles.css", "app.js", "agent.js", "ghcnd.js", "format.js", "almanac.js", "config.js",
              "lumen-oauth.js", "station_index.parquet", "places.parquet"]
MOCK = "http://localhost:5001"


def prepare_site(dst: Path) -> None:
    for f in SITE_FILES:
        shutil.copy(ROOT / f, dst / f)
    shutil.copytree(ROOT / "img", dst / "img")
    shutil.copytree(ROOT / "geo", dst / "geo")
    cfg = (dst / "config.js").read_text()
    cfg = re.sub(r'lumenBaseUrl: "[^"]*"', f'lumenBaseUrl: "{MOCK}"', cfg)
    (dst / "config.js").write_text(cfg)
    html = (dst / "index.html").read_text()
    html = html.replace("connect-src 'self'", f"connect-src 'self' {MOCK}")
    (dst / "index.html").write_text(html)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--chrome", default=None)
    ap.add_argument("--out", default=str(ROOT / "test" / "out"))
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    work = Path(tempfile.mkdtemp())
    site = work / "site"
    site.mkdir()
    prepare_site(site)

    procs = [
        subprocess.Popen([sys.executable, str(ROOT / "test" / "mock_lumen.py"), "5001"], cwd=work),
        subprocess.Popen([sys.executable, "-m", "http.server", "8000", "--bind", "127.0.0.1"], cwd=site,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL),
    ]
    time.sleep(1.5)
    failures = []

    def check(cond, msg):
        print(("PASS " if cond else "FAIL ") + msg)
        if not cond:
            failures.append(msg)

    try:
        with sync_playwright() as p:
            launch = {"headless": True}
            if a.chrome:
                launch["executable_path"] = a.chrome
            if os.environ.get("HTTPS_PROXY"):
                # Passed as Chrome flags: Playwright's proxy option forces loopback
                # traffic through the proxy too.
                launch["args"] = [f"--proxy-server={os.environ['HTTPS_PROXY']}",
                                  "--proxy-bypass-list=localhost;127.0.0.1"]
            browser = p.chromium.launch(**launch)
            ctx = browser.new_context(viewport={"width": 1280, "height": 900})
            ctx.add_init_script("localStorage.setItem('lumen-api-key', 'sk_test')")
            page = ctx.new_page()
            console = []
            page.on("console", lambda m: console.append(f"{m.type}: {m.text}"))
            page.on("pageerror", lambda e: console.append(f"pageerror: {e}"))
            page.on("response", lambda r: r.status >= 400 and console.append(f"error: HTTP {r.status} {r.url}"))

            page.goto("http://localhost:8000/")
            page.wait_for_function("document.querySelector('#model').options.length > 0", timeout=60000)
            opts = page.eval_on_selector_all("#model option", "os => os.map(o => o.value)")
            check(page.input_value("#model") == "gemma-4-31b-it", "preferred model selected")
            check("offline-model" not in opts, "down models hidden")
            page.wait_for_function("document.querySelector('#status').textContent === ''", timeout=120000)
            page.screenshot(path=str(out / "01-empty.png"), full_page=True)

            t0 = time.time()
            page.click(".examples button >> nth=0")
            page.wait_for_selector("#send:not([hidden])", timeout=600000)
            print(f"turn took {time.time() - t0:.1f}s")
            page.wait_for_timeout(1000)

            steps = page.eval_on_selector_all(".step summary", "s => s.map(x => x.textContent)")
            print("steps:", json.dumps(steps, indent=1))
            if len(steps) < 21:
                print("LOG:", page.text_content("#log"), "\nBANNER:", page.text_content("#banner"))
                print("CONSOLE:", "\n".join(console[-20:]))
                return 1
            check(len(steps) == 21, "twenty-one tool steps shown")
            check(not any(s.endswith("(failed)") for s in steps[:6]), "search, loads, area load and queries succeeded")
            check(steps[6].endswith("(failed)") and steps[7].endswith("(failed)"), "forbidden SQL refused")
            check(not steps[8].endswith("(failed)"), "messy layered spec (string, nulls) still renders")
            check(not steps[9].endswith("(failed)"), "histogram without y renders")
            check(not steps[10].endswith("(failed)"), "chart step succeeded")
            n_marks = page.locator(".chart svg.marks, .chart canvas.marks").count()
            if n_marks != 7:
                print("CHART DOM:", page.evaluate("document.querySelector('.chart')?.outerHTML.slice(0, 600)"))
            check(n_marks == 7, "all seven charts rendered")
            check(page.evaluate("document.body.dataset.xss") is None, "answer HTML sanitized")
            check(page.locator(".answer table").count() == 1, "answer markdown table rendered")
            ans = page.text_content(".answer table")
            check("≤ 35" in ans and "$" not in ans, "LaTeX inequality rendered as ≤")
            check(page.locator("#records li:not(.axis)").count() == 5, "rail shows three series and two area loads")
            print("downloaded:", page.text_content("#downloaded"))

            # What the model saw from each tool.
            reqs = [json.loads(l) for l in (work / "requests.jsonl").read_text().splitlines()]
            last = reqs[-1]["messages"]
            check(reqs[-1]["messages"][0]["role"] == "system", "system prompt sent")
            check("Today is" in reqs[-1]["messages"][0]["content"], "system prompt carries today's date")
            tool_out = [m["content"] for m in last if m["role"] == "tool"]
            area = json.loads(tool_out[3])
            print("area load:", json.dumps(area)[:400])
            check(area["results"][0]["stations_reporting"] >= 100, "load_area loaded 100+ Illinois stations")
            check("USC00117551" in tool_out[4] and "14.4" in tool_out[4], "Illinois max on 1974-04-05 is Rushville, 14.4 C")
            check("ambiguous" in tool_out[11] and "AZ" in tool_out[11], "bare 'Peoria' is refused as ambiguous")
            peoria = json.loads(tool_out[12])
            print("Peoria:", peoria.get("place"), peoria.get("total_matching"), [x["name"] for x in peoria["stations"][:4]])
            check(peoria["place"]["admin1"] == "IL" and peoria["total_matching"] > 0
                  and all(x["distance_km"] <= 30 for x in peoria["stations"]), "Peoria, IL resolves and stays within 30 km")
            champ = json.loads(tool_out[13])
            check(any(x["id"] == "USC00118740" for x in champ["stations"]), "Champaign County, IL includes Champaign 3S")
            schuyler = json.loads(tool_out[14])
            print("Schuyler:", json.dumps(schuyler)[:300])
            check(schuyler["results"][0]["stations_reporting"] >= 1, "county load_area works")
            hist = page.evaluate("[...document.querySelectorAll('.chart')][1].querySelector('svg.marks').textContent")
            check("Count" in hist, "histogram got a count axis")
            check(not steps[15].endswith("(failed)") and not steps[16].endswith("(failed)"), "map steps succeeded")
            paths = page.evaluate("[...document.querySelectorAll('.chart')].slice(3, 5).map(c => c.querySelectorAll('svg.marks path').length)")
            print("map paths:", paths)
            check(len(paths) == 2 and all(n >= 100 for n in paths), "both maps draw Illinois's 102 counties")
            for i in (3, 4):
                page.locator(".chart").nth(i).screenshot(path=str(out / f"map-{i}.png"))
            check(not steps[17].endswith("(failed)") and not steps[18].endswith("(failed)"), "scatter steps succeeded")
            xaxes = page.evaluate("""[...document.querySelectorAll('.chart')].slice(5).map(c =>
                [...c.querySelectorAll('svg.marks [aria-label^="X-axis"]')].map(a => a.getAttribute('aria-label')).join(' | '))""")
            print("x axes:", xaxes)
            check("values from 19" in xaxes[0] and "from 0 " not in xaxes[0], "year scatter axis starts near the data, not at year 0")
            check("utc scale" in xaxes[1] and "2024" in xaxes[1], "date column drawn on a UTC time axis")
            for i in (5, 6):
                page.locator(".chart").nth(i).screenshot(path=str(out / f"scatter-{i}.png"))

            # Copy log from a failed step: has the question, calls and errors, never the key.
            ctx.grant_permissions(["clipboard-read", "clipboard-write"])
            failed_step = page.locator(".step.failed").first
            failed_step.locator("summary").click()
            failed_step.locator(".copy-log button").click()
            page.wait_for_function("[...document.querySelectorAll('.copy-log button')].some(b => b.textContent === 'Log copied')")
            copied = page.evaluate("navigator.clipboard.readText()")
            print("copied log head:", copied[:300].replace("\n", " / "))
            check("GHCN-Daily Chat log" in copied and "What were the ten wettest years" in copied
                  and "run_sql failed" in copied and "read_csv" in copied, "copied log has question, calls and errors")
            check("sk_test" not in copied, "copied log never includes the Lumen key")
            fc = json.loads(tool_out[19])
            print("forecast:", fc.get("for"), fc.get("nws_grid"), fc.get("grid_cell_center"), fc.get("issued"))
            print("  daily TMAX/TMIN:", [(r["date"], r["element"], r["value"]) for r in fc.get("daily", []) if r["element"] in ("TMAX", "TMIN")][:8])
            print("  text:", fc.get("text_forecast", [])[:3])
            check(fc.get("nws_grid", "").startswith("ILX") and fc["grid_cell_center"]["km_from_point"] < 2.5
                  and sum(r["element"] == "TMAX" for r in fc["daily"]) >= 5, "forecast for Champaign 3S from its NDFD grid cell")
            check("TMAX" in tool_out[20] and "error" not in tool_out[20], "forecast table queryable")
            check(all("reasoning_content" not in m for m in last), "reasoning fields stripped")
            for m in last:
                if m["role"] == "tool":
                    print("TOOL RESULT:", m["content"][:900], "\n")

            page.screenshot(path=str(out / "02-answer.png"), full_page=True)

            # CSP: the page and DuckDB's worker cannot reach other hosts.
            blocked = page.evaluate("""async () => {
                try { await fetch('https://example.com/'); return false; } catch { return true; } }""")
            check(blocked, "CSP blocks fetch to other hosts")
            duck = page.evaluate("""async () => {
                const m = await import('./ghcnd.js');
                const db = await m.openDatabase();
                const c = await db.connect();
                let leak = 'not attempted';
                try { await c.query("SELECT * FROM read_csv('https://example.com/x.csv')"); leak = 'allowed'; }
                catch (e) { leak = 'blocked: ' + String(e.message).slice(0, 120); }
                return leak;
            }""")
            print("duckdb external read:", duck)
            check(duck.startswith("blocked"), "CSP blocks DuckDB worker reads from other hosts")

            # A model without tool calling gets a warning.
            page.select_option("#model", "plain-chat-model")
            check("does not support tool calling" in page.text_content("#status"), "warns about models without tool calling")
            page.select_option("#model", "gemma-4-31b-it")

            # Campus header and footer from the Illinois Web Toolkit.
            check(page.evaluate("!!document.querySelector('ilw-header').shadowRoot"), "Illinois header rendered")
            check(not page.is_visible("#ot-sdk-btn"), "inert cookie button hidden")
            check("snesbitt@illinois.edu" in page.text_content("ilw-footer"), "contact info in footer")
            page.set_viewport_size({"width": 390, "height": 844})
            page.screenshot(path=str(out / "04-phone.png"), full_page=True)

            errors = [c for c in console if c.startswith(("error", "pageerror"))]
            print("console errors:", json.dumps(errors, indent=1))

            # Without a key: the connect view, and Connect starts the PKCE flow.
            ctx2 = browser.new_context(viewport={"width": 1280, "height": 900})
            p2 = ctx2.new_page()
            p2.goto("http://localhost:8000/")
            p2.wait_for_selector("#connect-view:not([hidden])")
            check(not p2.is_visible("#app") and not p2.is_visible("#session"), "chat hidden until connected")
            p2.screenshot(path=str(out / "00-connect.png"))
            with p2.expect_request(lambda r: "/oauth/authorize" in r.url) as req:
                p2.click("#connect")
            url = req.value.url
            print("authorize URL:", url)
            check(url.startswith(MOCK + "/oauth/authorize?") and "client_id=ghcnd-chat" in url
                  and "code_challenge_method=S256" in url, "Connect starts the PKCE flow")
            ctx2.close()
            browser.close()
    finally:
        for pr in procs:
            pr.terminate()
    print(f"\n{len(failures)} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
