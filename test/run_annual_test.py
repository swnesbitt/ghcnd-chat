"""Browser test for the Annual climate tab, against the real NOAA and NCEI
services and the scripted mock Lumen.

    python test/run_annual_test.py [--chrome /path/to/chrome] [--out DIR]
"""

import argparse
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_browser_test import ROOT, prepare_site  # noqa: E402

SITE = "http://localhost:8000/"


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

    def wait_ready(page):
        try:
            page.wait_for_selector("article.ann[data-ready], #ann-out .error-block", timeout=300000)
        finally:
            print("status:", page.text_content("#ann-status"), "| out:", (page.text_content("#ann-out") or "")[:300])
        for _ in range(240):
            if page.evaluate("() => !document.querySelector('.alm-pending') && document.querySelector('#ann-status').textContent === ''"):
                break
            page.wait_for_timeout(500)

    try:
        with sync_playwright() as p:
            launch = {"headless": True}
            if a.chrome:
                launch["executable_path"] = a.chrome
            if os.environ.get("HTTPS_PROXY"):
                launch["args"] = [f"--proxy-server={os.environ['HTTPS_PROXY']}", "--proxy-bypass-list=localhost;127.0.0.1"]
            browser = p.chromium.launch(**launch)

            # Signed in (mock model), Champaign 3S by ID.
            ctx = browser.new_context(viewport={"width": 1280, "height": 900})
            ctx.add_init_script("localStorage.setItem('lumen-api-key', 'sk_test')")
            page = ctx.new_page()
            console = []
            page.on("console", lambda m: console.append(f"{m.type}: {m.text}"))
            page.on("pageerror", lambda e: console.append(f"pageerror: {e}"))
            t0 = time.time()
            page.goto(SITE + "?annual=USC00118740")
            wait_ready(page)
            print(f"annual page took {time.time() - t0:.1f}s")
            check(page.is_visible("#panel-annual") and not page.is_visible("#panel-almanac"), "?annual= opens the Annual climate tab")
            check(page.text_content("#tab-almanac") == "Daily almanac", "almanac tab renamed to Daily almanac")
            heads = page.eval_on_selector_all(".ann .alm-section h2", "h => h.map(x => x.textContent)")
            print("sections:", heads)
            check(heads == ["Temperature", "Precipitation", "Snowfall"], "three sections")
            kop = page.text_content(".ann-koppen") or ""
            print("koppen:", kop)
            check("Köppen Dfa" in kop, "Champaign is Köppen Dfa (hot-summer humid continental)")
            n_charts = page.locator(".ann .alm-chart svg.marks").count()
            print("charts:", n_charts)
            check(n_charts == 8, "8 charts (temperature + annual; precip cumulative, daily, annual; snow cumulative, daily, annual)")
            check(page.input_value("#ann-t-year") == "2026" and "(so far)" in page.text_content("#ann-t-year option[value='2026']"), "defaults to this year, marked so far")
            tables = page.eval_on_selector_all(".ann-table", "t => t.map(x => x.innerText.replace(/\\t/g, ' | '))")
            for t in tables:
                print("table:\n  " + t.replace("\n", "\n  "))
            check("through Oct" in tables[0] and "Mean high" in tables[0] and " of " in tables[0], "temperature table: year so far, ranks")
            boxes = page.eval_on_selector_all(".ann .alm-box", "b => b.map(x => x.textContent.trim())")
            check(len(boxes) == 3 and all("MOCK-NARRATIVE" in b for b in boxes), "a model summary under each chart")

            # Hover over a day on the temperature chart shows its values.
            fig = page.locator(".ann .alm-chart").first
            box = fig.locator("svg.marks").bounding_box()
            page.mouse.move(box["x"] + box["width"] * 0.55, box["y"] + box["height"] * 0.5)
            page.wait_for_timeout(800)
            tip = page.text_content("#vg-tooltip-element") if page.locator("#vg-tooltip-element").count() else ""
            print("tooltip:", " | ".join((tip or "").split())[:300])
            check("Record high" in tip and "Normal" in tip and "Observed" in tip, "hovering a day shows observed, normal, mean and record values")
            page.screenshot(path=str(out / "annual-2026.png"), full_page=True)

            # Pick another year from the menu.
            page.select_option("#ann-t-year", "2012")
            page.wait_for_function("() => document.querySelectorAll('.ann-table th[scope=col]')[1]?.textContent === '2012'", timeout=30000)
            t2012 = page.locator(".ann-table").first.inner_text()
            print("2012:", " | ".join(t2012.split("\n")[:4]))
            check("2012" in t2012 and "warmest" in t2012, "2012 selected: complete year, ranked (2012 was very warm)")
            check("year=2012" in page.url, "URL keeps the year")

            # Click a year on the precipitation year-by-year chart.
            pf = page.locator("section[aria-labelledby=ann-prcp] .alm-chart").nth(2)
            pb = pf.locator("svg.marks").bounding_box()
            # The bar under the middle of the plot: find a spot over a bar from Vega's own scenegraph.
            pf.scroll_into_view_if_needed()
            page.wait_for_timeout(300)
            spot = page.evaluate("""() => {
              const svg = [...document.querySelectorAll("section[aria-labelledby=ann-prcp] .alm-chart")][2].querySelector("svg.marks");
              const bars = [...svg.querySelectorAll("path[role=graphics-symbol], g.mark-rect path")];
              const r = bars[Math.floor(bars.length / 2)].getBoundingClientRect();
              return { x: r.x + r.width / 2, y: r.y + r.height - 3, n: bars.length };
            }""")
            print("bars:", spot["n"])
            page.mouse.click(spot["x"], spot["y"])
            page.wait_for_timeout(2500)
            py = page.input_value("#ann-p-year")
            print("precip year after click:", py)
            check(py not in ("2026", ""), "clicking a bar in the year-by-year chart selects that year")
            page.screenshot(path=str(out / "annual-2012.png"), full_page=True)

            errors = [c for c in console if c.startswith("pageerror")]
            print("page errors:", errors)
            check(not errors, "no page errors")
            ctx.close()

            # Signed out, a place, a non-US station (metric units).
            ctx2 = browser.new_context(viewport={"width": 390, "height": 844})
            page2 = ctx2.new_page()
            page2.on("pageerror", lambda e: console.append(f"pageerror2: {e}"))
            page2.goto(SITE + "#annual")
            page2.fill("#ann-input", "Toronto, Canada")
            page2.click("#ann-form button[type=submit]")
            wait_ready(page2)
            kop2 = page2.text_content(".ann-koppen") or ""
            print("toronto:", page2.text_content(".ann .alm-head h1"), "|", kop2)
            check(page2.locator("#ann-choices li").count() >= 3, "a place lists nearby stations")
            check("°C" in page2.locator(".ann-table").first.inner_text() and "Köppen D" in kop2, "metric units and a D climate for Toronto")
            check("Sign in to Lumen" in page2.text_content(".ann .alm-ai"), "signed out: templated summaries")
            page2.screenshot(path=str(out / "annual-phone.png"), full_page=True)
            check(not any(c.startswith("pageerror2") for c in console), "no page errors on the phone layout")
            browser.close()
    finally:
        for pr in procs:
            pr.terminate()
    print(f"{len(failures)} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
