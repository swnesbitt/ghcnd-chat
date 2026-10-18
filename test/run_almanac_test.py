"""Browser test for the Daily almanac tab, against the real NOAA, NCEI and
NWS services and the scripted mock Lumen.

    python test/run_almanac_test.py [--chrome /path/to/chrome] [--out DIR]
"""

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_browser_test import ROOT, prepare_site  # noqa: E402


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
                launch["args"] = [f"--proxy-server={os.environ['HTTPS_PROXY']}", "--proxy-bypass-list=localhost;127.0.0.1"]
            browser = p.chromium.launch(**launch)

            # Signed in: deep link by station ID, narrative from the (mock) model.
            ctx = browser.new_context(viewport={"width": 1280, "height": 900})
            ctx.add_init_script("localStorage.setItem('lumen-api-key', 'sk_test')")
            page = ctx.new_page()
            console = []
            page.on("console", lambda m: console.append(f"{m.type}: {m.text}"))
            page.on("pageerror", lambda e: console.append(f"pageerror: {e}"))
            t0 = time.time()
            page.goto("http://localhost:8000/?station=USC00118740")
            try:
                page.wait_for_selector(".alm-foot, #alm-out .error-block", timeout=300000)
            finally:
                print("status:", page.text_content("#alm-status"), "| out:", (page.text_content("#alm-out") or "")[:600])
                print("console:", "\n".join(c for c in console if c.startswith(("error", "pageerror")))[:2000])
            for _ in range(240):
                if page.evaluate("() => !document.querySelector('.alm-pending') && document.querySelector('#alm-status').textContent === ''"):
                    break
                page.wait_for_timeout(500)
            print(f"almanac took {time.time() - t0:.1f}s")
            check(page.is_visible("#panel-almanac") and not page.is_visible("#panel-chat"), "deep link opens the almanac tab")
            heads = page.eval_on_selector_all(".alm-section h2", "h => h.map(x => x.textContent)")
            print("sections:", heads)
            check(heads[:2] == ["Yesterday and today", "The past 5 days and the next 5"] and "The past year" in heads
                  and "First frost and freeze" in heads and "Degree days this year" in heads, "all five sections present")
            boxes = page.eval_on_selector_all(".alm-box", "b => b.map(x => x.textContent.trim())")
            check(len(boxes) == 5 and all("MOCK-NARRATIVE" in b for b in boxes), "every section has a blue box with the model's text")
            n_charts = page.locator(".alm-chart svg.marks").count()
            print("charts:", n_charts)
            check(n_charts >= 6, "charts drawn (window, precip, departures, cumulative precip, snow, frost, GDD)")
            now = page.text_content(".alm-now")
            print("now table:", " | ".join(now.split()))
            check("normal 65°F" in now, "today's normal high matches NCEI (Oct 17: 65.4°F)")
            win_rows = page.eval_on_selector_all("#alm-outlook ~ .alm-scroll tbody tr", "r => r.map(x => x.innerText.replace(/\\t/g, ' | '))")
            print("window rows:\n  " + "\n  ".join(win_rows))
            check(any("Oct 16" in r and "Provisional" in r and "72°F" in r for r in win_rows), "Oct 16 filled from ACIS (72°F) and marked provisional")
            check(("(provisional)" in now and "Oct 16" in now) or "(from a nearby station*)" in now, "latest report is provisional (or from a nearby station when this one has not reported)")
            check("AI model" in page.text_content(".alm-ai") and "may make mistakes" in page.text_content(".alm-ai"), "AI note at the bottom")
            check(page.url.endswith("?station=USC00118740"), "URL holds the station for sharing")
            notes = page.eval_on_selector_all(".alm-subnote", "n => n.map(x => x.textContent)")
            print("nearby-station notes:", notes[:1])
            frost = page.text_content("#alm-frost + .alm-box ~ .alm-scroll") if page.locator("#alm-frost").count() else ""
            print("frost table:", " | ".join(frost.split())[:300])
            dd = page.locator("#alm-degree_days").locator("xpath=..").text_content()
            print("degree days:", " | ".join(dd.split())[:400])
            page.screenshot(path=str(out / "almanac-desktop.png"), full_page=True)
            page.set_viewport_size({"width": 390, "height": 844})
            page.wait_for_timeout(800)
            page.screenshot(path=str(out / "almanac-phone.png"), full_page=True)
            errors = [c for c in console if c.startswith(("error", "pageerror")) and "onetrust" not in c.lower()
                      and "inline script" not in c and "version.json" not in c and "404" not in c]
            print("console errors:", errors)
            check(not any(c.startswith("pageerror") for c in console), "no page errors")
            frost_txt = page.locator("#alm-frost").locator("xpath=..").text_content()
            check("Forecast lows" in frost_txt and "1991–2020" in frost_txt and ("Possible" in frost_txt or "None forecast" in frost_txt or "Oct" in frost_txt),
                  "frost tracker shows forecast lows and 1991–2020 timing")
            rows = page.eval_on_selector_all(".alm-frost tbody tr", "r => r.map(x => [...x.children].map(c => c.textContent).join(' | '))")
            print("frost rows:\n  " + "\n  ".join(rows))

            def run_hist(date, title):
                page.set_viewport_size({"width": 1280, "height": 900})
                page.goto(f"http://localhost:8000/?station=USC00118740&date={date}")
                page.wait_for_selector(".alm-foot, #alm-out .error-block", timeout=300000)
                for _ in range(240):
                    if page.evaluate("() => !document.querySelector('.alm-pending') && document.querySelector('#alm-status').textContent === ''"):
                        break
                    page.wait_for_timeout(500)
                heads = page.eval_on_selector_all(".alm-section h2", "h => h.map(x => x.textContent)")
                rank = page.text_content(".alm-rank") if page.locator(".alm-rank").count() else ""
                tbl = page.locator("#alm-season").locator("xpath=..").locator("table").text_content() if page.locator("#alm-season").count() else ""
                print(date, heads, "|", rank)
                print("  season table:", " | ".join(tbl.split())[:500])
                page.screenshot(path=str(out / f"almanac-{date}.png"), full_page=True)
                return heads, rank

            heads_s, rank_s = run_hist("2026-07-20", "How hot is this summer?")
            check("How hot is this summer?" in heads_s and "First frost and freeze" not in heads_s and "warmest of" in rank_s, "summer story replaces the frost tracker in July")
            heads_w, rank_w = run_hist("2026-01-25", "How cold is this winter?")
            check("How cold is this winter?" in heads_w and "coldest of" in rank_w, "winter story in January")
            heads_p, _ = run_hist("2026-04-10", "Last frost and freeze")
            check("Last frost and freeze" in heads_p, "spring frost tracker in April")
            page.goto("http://localhost:8000/?station=USC00118740")
            page.wait_for_selector(".alm-foot", timeout=300000)
            page.click("#tab-chat")
            check(page.is_visible("#panel-chat") and not page.is_visible("#panel-almanac"), "chat tab switches back")
            ctx.close()

            # Not signed in: place name, templated text.
            ctx2 = browser.new_context(viewport={"width": 1280, "height": 900})
            p2 = ctx2.new_page()
            p2.goto("http://localhost:8000/?place=Champaign,%20IL")
            p2.wait_for_selector(".alm-foot", timeout=300000)
            for _ in range(240):
                if p2.evaluate("() => document.querySelector('#alm-status').textContent === ''"):
                    break
                p2.wait_for_timeout(500)
            boxes2 = p2.eval_on_selector_all(".alm-box", "b => b.map(x => x.textContent.trim())")
            print("template now box:", boxes2[0][:200])
            check(len(boxes2) >= 4 and not any("MOCK" in b for b in boxes2) and all(len(b) > 20 for b in boxes2), "signed out: plain summaries fill the boxes")
            check("Sign in to Lumen" in p2.text_content(".alm-ai"), "signed out: note says how to get AI text")
            print("place resolved to:", p2.text_content(".alm-head h1"), p2.url)
            items = p2.eval_on_selector_all(".alm-stations li", "l => l.map(x => x.innerText.replace(/\\n/g, ' / '))")
            print("stations listed:\n  " + "\n  ".join(items))
            check(len(items) == 4 and "Selected" in items[0] and p2.is_visible(".alm-choices > button"), "place lists the selected station plus the 3 closest, with a More button")
            check(any("Selected" in i for i in items) or p2.locator(".alm-station[aria-current='true']").count() == 0,
                  "recommended station marked when it is among the closest")
            p2.click(".alm-choices > button")
            n_more = p2.locator(".alm-stations li").count()
            check(n_more == 11, "More stations shows 7 more")
            retired_on = p2.eval_on_selector_all(".alm-stations li", "l => l.filter(x => x.innerText.includes('no longer reporting')).length")
            check(p2.is_checked(".alm-hide input >> nth=0") and not p2.is_checked(".alm-hide input >> nth=1") and retired_on == 0, "stations no longer reporting are hidden by default; 30+ years off")
            p2.uncheck(".alm-hide input >> nth=0")
            retired_off = p2.eval_on_selector_all(".alm-stations li", "l => l.filter(x => x.innerText.includes('no longer reporting')).length")
            print("no-longer-reporting stations shown with the toggle off:", retired_off, "| label:", p2.text_content(".alm-hide"))
            check(retired_off > 0, "turning the toggle off shows them")
            p2.check(".alm-hide input >> nth=0")
            before = p2.locator(".alm-stations li").count()
            p2.check(".alm-hide input >> nth=1")
            spans = p2.eval_on_selector_all(".alm-stations li", "l => l.map(x => x.innerText)")
            print("30+ years filter:", before, "->", len(spans), "|", p2.text_content(".alm-filters"))
            import re as _re
            def long_enough(t):
                ys = [int(b) - int(a) + 1 for a, b in _re.findall(r"(?:Temperature|Precipitation) (\d{4})–(\d{4})", t)]
                return (max(ys or [0]) >= 30 and "no longer reporting" not in t) or "Selected" in t or "Recommended" in t
            check(all(long_enough(t) for t in spans) and len(spans) >= 3, "30+ years toggle keeps only current long records (plus the selected one)")
            p2.uncheck(".alm-hide input >> nth=1")
            first_name = p2.text_content(".alm-head h1")
            other = p2.locator(".alm-station:not([aria-current='true'])").first
            other_name = other.locator(".alm-st-name").text_content()
            other.click()
            p2.wait_for_function("() => true")
            for _ in range(300):
                h1 = p2.text_content(".alm-head h1") if p2.locator(".alm-head h1").count() else ""
                err = p2.locator("#alm-out .error-block").count()
                if (h1 and h1 != first_name) or err:
                    break
                p2.wait_for_timeout(500)
            print("switched to:", p2.text_content("#alm-out")[:160])
            check(other_name.split(",")[0] in (p2.text_content("#alm-out") or ""), "picking another station renders its almanac")
            p2.screenshot(path=str(out / "almanac-place.png"), full_page=False)

            # Words from a station's name, not a place.
            for _ in range(300):
                if p2.evaluate("() => !document.querySelector('#alm-form button').disabled"):
                    break
                p2.wait_for_timeout(500)
            for query, want in [("Willard airport, IL", "WILLARD AP"), ("O'Hare airport", "OHARE")]:
                p2.fill("#alm-input", query)
                p2.evaluate("() => { document.querySelector('#alm-choices').hidden = true; }")
                p2.click("#alm-form button[type=submit]")
                for _ in range(120):
                    if p2.evaluate("() => !document.querySelector('#alm-choices').hidden || !!document.querySelector('#alm-out .error-text')"):
                        break
                    p2.wait_for_timeout(500)
                sel = p2.text_content("#alm-choices [aria-current=true] .alm-st-name") if p2.locator("#alm-choices [aria-current=true]").count() else ""
                print(f"{query!r} ->", sel)
                check(want in sel, f'"{query}" finds the station by name')
                for _ in range(300):
                    if p2.evaluate("() => !document.querySelector('#alm-form button').disabled"):
                        break
                    p2.wait_for_timeout(500)
            ctx2.close()
            browser.close()
    finally:
        for pr in procs:
            pr.terminate()
    print(f"\n{len(failures)} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
