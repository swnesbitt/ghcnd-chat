"""Browser test for the Daily email tab, with GitHub's API faked in the browser
(secrets are really encrypted, and decrypted here with the fake repository key).

    python test/run_notify_test.py [--chrome /path/to/chrome] [--out DIR]
"""

import argparse
import base64
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from nacl.public import PrivateKey, SealedBox
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_browser_test import MOCK, ROOT, prepare_site  # noqa: E402

REPO = "swnesbitt/ghcnd-chat"
SITE = "http://localhost:8000/"


class FakeGitHub:
    def __init__(self):
        self.key = PrivateKey.generate()
        self.secrets: dict[str, str] = {}
        self.variables: dict[str, str] = {}
        self.dispatches: list[dict] = []
        self.tokens = {"github_pat_good"}
        self.state = {"subscriptions": {"champaign-3s": {"station": "USC00118740", "last_sent": "2026-10-16",
                                                         "last_sent_at": "2026-10-16T14:12:03+00:00", "status": "sent"}}}

    def handle(self, route):
        req = route.request
        u = urlparse(req.url)
        path, method = u.path, req.method
        cors = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE"}
        if method == "OPTIONS":
            return route.fulfill(status=204, headers=cors)
        auth = req.headers.get("authorization", "")
        authed = auth.removeprefix("Bearer ") in self.tokens

        def reply(status, body=None):
            return route.fulfill(status=status, headers={**cors, "Content-Type": "application/json"},
                                 body="" if body is None else json.dumps(body))

        base = f"/repos/{REPO}"
        if path == f"{base}/contents/state.json":
            return reply(200, self.state)
        if path == f"{base}/actions/workflows/notify.yml/runs":
            return reply(200, {"workflow_runs": [{"html_url": "https://github.com/x/runs/1", "created_at": "2026-10-16T19:00:00Z",
                                                  "status": "completed", "conclusion": "success"}]})
        if not authed:
            return reply(401, {"message": "Bad credentials"})
        if path == "/user":
            return reply(200, {"login": "swnesbitt"})
        if path == f"{base}/actions/variables/NOTIFY_CONFIG":
            if method == "GET":
                return reply(200, {"name": "NOTIFY_CONFIG", "value": self.variables["NOTIFY_CONFIG"]}) if "NOTIFY_CONFIG" in self.variables else reply(404, {"message": "Not Found"})
            if method == "PATCH":
                if "NOTIFY_CONFIG" not in self.variables:
                    return reply(404, {"message": "Not Found"})
                self.variables["NOTIFY_CONFIG"] = json.loads(req.post_data)["value"]
                return reply(204)
        if path == f"{base}/actions/variables" and method == "POST":
            b = json.loads(req.post_data)
            self.variables[b["name"]] = b["value"]
            return reply(201)
        if path == f"{base}/actions/secrets":
            return reply(200, {"total_count": len(self.secrets), "secrets": [{"name": k} for k in self.secrets]})
        if path == f"{base}/actions/secrets/public-key":
            return reply(200, {"key_id": "kid1", "key": base64.b64encode(bytes(self.key.public_key)).decode()})
        if path.startswith(f"{base}/actions/secrets/") and method == "PUT":
            b = json.loads(req.post_data)
            assert b["key_id"] == "kid1"
            self.secrets[path.rsplit("/", 1)[1]] = SealedBox(self.key).decrypt(base64.b64decode(b["encrypted_value"])).decode()
            return reply(201)
        if path == f"{base}/actions/workflows/notify.yml/dispatches" and method == "POST":
            self.dispatches.append(json.loads(req.post_data))
            return reply(204)
        return reply(404, {"message": f"unexpected {method} {path}"})


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

    fake = FakeGitHub()
    try:
        with sync_playwright() as p:
            launch = {"headless": True}
            if a.chrome:
                launch["executable_path"] = a.chrome
            if os.environ.get("HTTPS_PROXY"):
                launch["args"] = [f"--proxy-server={os.environ['HTTPS_PROXY']}", "--proxy-bypass-list=localhost;127.0.0.1"]
            browser = p.chromium.launch(**launch)
            ctx = browser.new_context(viewport={"width": 1100, "height": 900})
            ctx.route("https://api.github.com/**", fake.handle)

            # Lumen's OAuth pages, for the daily email's own key.
            def authorize(route):
                q = parse_qs(urlparse(route.request.url).query)
                check(q["name"] == ["ghcnd-chat-daily-email"], "the email key gets its own name on Lumen")
                route.fulfill(status=302, headers={"Location": f"{q['redirect_uri'][0]}?code=abc&state={q['state'][0]}"})

            ctx.route(f"{MOCK}/oauth/authorize*", authorize)
            ctx.route(f"{MOCK}/oauth/token", lambda r: r.fulfill(status=200, headers={"Access-Control-Allow-Origin": "*", "Content-Type": "application/json"},
                                                                  body=json.dumps({"access_token": "sk_email_key"})))
            page = ctx.new_page()
            console = []
            page.on("console", lambda m: console.append(f"{m.type}: {m.text}"))
            page.on("pageerror", lambda e: console.append(f"pageerror: {e}"))

            page.goto(SITE + "#email")
            try:
                page.wait_for_selector("#ntf .ntf-token", timeout=30000)
            finally:
                print("ntf:", (page.text_content("#ntf") or "")[:300], "| console:", [c for c in console if "error" in c][:5])
            check(page.is_visible("#panel-email") and not page.is_visible("#panel-chat"), "#email opens the Daily email tab")
            txt = page.text_content("#ntf")
            check("Create a fine-grained token" in txt and "last daily email" in txt, "signed out: token instructions and the public delivery log")
            href = page.get_attribute(".ntf-token >> xpath=.. >> a", "href")
            check("actions_variables=write" in href and "secrets=write" in href and "target_name=swnesbitt" in href, "token link prefills permissions")

            page.fill("#ntf-token", "github_pat_bad")
            page.click(".ntf-token button[type=submit]")
            page.wait_for_function("() => document.querySelector('#ntf .ntf-error')", timeout=10000)
            check("did not accept" in page.text_content("#ntf .ntf-error"), "a bad token is refused")

            page.fill("#ntf-token", "github_pat_good")
            page.click(".ntf-token button[type=submit]")
            page.wait_for_selector(".ntf-sub", timeout=10000)
            check(page.locator(".ntf-sub").count() == 1 and page.input_value("#ntf-0-station") == "USC00118740"
                  and page.input_value("#ntf-0-to") == "snesbitt@illinois.edu" and page.input_value("#ntf-0-time") == "09:00",
                  "default: Champaign 3S at 9:00 to snesbitt@illinois.edu")
            check("Not saved yet" in page.text_content("#ntf") and "Not set up yet" in page.text_content("#ntf"), "unsaved default and missing mail server are flagged")
            check("Signed in to GitHub as swnesbitt" in page.text_content("#ntf"), "shows the GitHub login")

            # Add O'Hare by ID (looked up in the station index), weekdays only, 7:30.
            page.click("text=Add a station")
            page.fill("#ntf-1-station", "usw00094846")
            page.press("#ntf-1-station", "Tab")
            page.wait_for_function("() => document.querySelector('#ntf-1-station').value === 'USW00094846'", timeout=90000)
            page.fill("#ntf-1-to", "a@example.com, b@example.org")
            page.press("#ntf-1-to", "Tab")
            page.fill("#ntf-1-time", "07:30")
            page.locator(".ntf-sub").nth(1).locator(".ntf-days input").nth(5).uncheck()
            page.locator(".ntf-sub").nth(1).locator(".ntf-days input").nth(6).uncheck()
            check(page.locator(".ntf-sub").nth(1).locator("button", has_text="Send now").is_disabled(), "Send now waits until saved")

            # A bad address is refused before anything is written.
            page.fill("#ntf-0-to", "snesbitt@illinois")
            page.press("#ntf-0-to", "Tab")
            page.click("text=Save changes")
            check("is not an email address" in page.text_content("#ntf .ntf-error") and not fake.secrets, "invalid address refused, nothing saved")
            page.fill("#ntf-0-to", "snesbitt@illinois.edu")
            page.press("#ntf-0-to", "Tab")
            page.click("text=Save changes")
            page.wait_for_function("() => /Saved\\./.test(document.querySelector('#ntf [role=status]')?.textContent || '')", timeout=10000)
            cfg = json.loads(fake.secrets.get("NOTIFY_CONFIG", "{}"))
            subs = cfg.get("subscriptions", [])
            print("saved:", json.dumps(subs)[:400])
            check(len(subs) == 2 and subs[1]["station"] == "USW00094846" and subs[1]["time"] == "07:30"
                  and subs[1]["days"] == ["mon", "tue", "wed", "thu", "fri"] and subs[1]["to"] == ["a@example.com", "b@example.org"]
                  and "CHICAGO" in subs[1]["label"].upper(), "subscriptions saved to the NOTIFY_CONFIG secret (encrypted)")
            check(json.loads(fake.variables["NOTIFY_CONFIG"])["subscriptions"] == subs, "readable copy saved to the NOTIFY_CONFIG variable")

            # The sender accepts what the page saved.
            env = {**os.environ, "NOTIFY_CONFIG": fake.secrets["NOTIFY_CONFIG"]}
            r = subprocess.run([sys.executable, str(ROOT / "scripts" / "send_almanac.py"), "--check", "--state", str(work / "s.json")],
                               env=env, capture_output=True, text=True)
            print(r.stdout.strip())
            check(r.returncode == 0 and "usw00094846-1" in r.stdout, "send_almanac.py reads the saved settings")

            # Send now.
            page.locator(".ntf-sub").nth(1).locator("button", has_text="Send now").click()
            page.wait_for_function("() => /Sending/.test(document.querySelector('#ntf [role=status]')?.textContent || '')", timeout=10000)
            check(fake.dispatches == [{"ref": "main", "inputs": {"subscription": "usw00094846-1"}}], "Send now dispatches the workflow for that subscription")

            # Mail server: Gmail preset.
            check(page.input_value("#ntf-SMTP_HOST") == "smtp.gmail.com" and page.input_value("#ntf-SMTP_PORT") == "587", "Gmail preset fills server and port")
            page.fill("#ntf-SMTP_USERNAME", "someone@gmail.com")
            page.fill("#ntf-SMTP_PASSWORD", "abcd efgh ijkl mnop")
            page.fill("#ntf-MAIL_FROM", "Climate at a glance <someone@gmail.com>")
            page.click("text=Save mail settings")
            page.wait_for_function("() => /Saved SMTP/.test(document.querySelector('#ntf [role=status]')?.textContent || '')", timeout=10000)
            check(fake.secrets.get("SMTP_PASSWORD") == "abcd efgh ijkl mnop" and fake.secrets.get("SMTP_HOST") == "smtp.gmail.com", "mail settings saved as secrets")
            check("Set up." in page.text_content("#ntf") and page.get_attribute("#ntf-SMTP_PASSWORD", "placeholder").startswith("Saved"), "mail server shows as set up, values hidden")
            page.screenshot(path=str(out / "notify.png"), full_page=True)

            # Lumen key for the email, through Lumen's consent page and back.
            page.get_by_role("button", name="Connect Lumen").click()
            page.wait_for_function("() => /Lumen key saved/.test(document.querySelector('#ntf [role=status]')?.textContent || '')", timeout=20000)
            check(fake.secrets.get("LUMEN_API_KEY") == "sk_email_key", "Lumen key stored as the LUMEN_API_KEY secret")
            check(page.evaluate("() => localStorage.getItem('lumen-email-key')") is None and page.evaluate("() => localStorage.getItem('lumen-api-key')") is None,
                  "the email key is not kept in the browser, and the chat key is untouched")
            check("code=" not in page.url and page.url.endswith("#email"), "redirect cleaned up, back on the Daily email tab")

            # The token was not remembered: a new tab (fresh session) asks again.
            page2 = ctx.new_page()
            page2.goto(SITE + "#email")
            page2.wait_for_selector("#ntf .ntf-token", timeout=30000)
            check(True, "token is forgotten in a new tab unless remembered")
            page2.fill("#ntf-token", "github_pat_good")
            page2.check("#ntf-remember")
            page2.click(".ntf-token button[type=submit]")
            page2.wait_for_selector(".ntf-sub", timeout=10000)
            check(page2.evaluate("() => localStorage.getItem('ghcnd-chat:github-token')") == "github_pat_good", "Remember keeps the token")
            page2.close()

            # Almanac → Email this almanac daily.
            page.goto(SITE + "?station=USC00118740")
            page.wait_for_selector(".alm-actions button", timeout=300000)
            page.click(".alm-actions button")
            page.wait_for_selector(".ntf-sub", timeout=10000)
            check(page.is_visible("#panel-email") and page.locator(".ntf-sub").count() == 2, "Email this almanac daily: Champaign 3S is already on the list, no duplicate")
            page.goto(SITE + "?station=USC00111577")
            page.wait_for_selector(".alm-actions button", timeout=300000)
            page.click(".alm-actions button")
            page.wait_for_selector(".ntf-sub >> nth=2", timeout=10000)
            check(page.input_value("#ntf-2-station") == "USC00111577" and "Added" in page.text_content("#ntf [role=status]"), "Email this almanac daily adds a new station")
            page.screenshot(path=str(out / "notify-added.png"), full_page=True)

            errors = [c for c in console if c.startswith("pageerror")]
            print("page errors:", errors)
            check(not errors, "no page errors")
            browser.close()
    finally:
        for pr in procs:
            pr.terminate()
    print(f"{len(failures)} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
