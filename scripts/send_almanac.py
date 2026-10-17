"""Email the Climate at a glance almanac to subscribers.

Runs from .github/workflows/notify.yml every 15 minutes. For each subscription
that is due (its local send time has passed today and it has not been sent
today), it opens the live almanac in headless Chrome, so the message shows
exactly what the page shows, and delivers it one of two ways:

- email (needs a mail server): HTML with each section's text, tables and charts
  (as inline images), the full almanac as a PDF attachment, and plain text;
- GitHub notification (needs nothing): a comment on the station's "Daily
  almanac" issue in this repository that @mentions the subscriber's GitHub
  account, so GitHub emails it to them from notifications@github.com. Charts
  and the PDF are uploaded to the notify-images release (pruned after 30 days).

A subscription's delivery is "auto" (email when a mail server is set up and it
has addresses, otherwise GitHub), "email" or "github".

Subscriptions come from the NOTIFY_CONFIG environment variable (the workflow
passes the NOTIFY_CONFIG repository secret, written by the Daily email tab), or
DEFAULT_CONFIG below when it is unset. Delivery state (what was sent when, no
addresses) is a JSON file the workflow keeps on the notify-state branch.

    python scripts/send_almanac.py --check                 # list what is due
    python scripts/send_almanac.py --send                  # send what is due
    python scripts/send_almanac.py --send --only ID        # send one now
    python scripts/send_almanac.py --send --only ID --dry-run out/   # write files, no email

GitHub delivery uses GITHUB_TOKEN (the workflow's own token). Mail settings (environment): SMTP_HOST, SMTP_PORT (587 STARTTLS or 465 TLS),
SMTP_USERNAME, SMTP_PASSWORD, MAIL_FROM. LUMEN_API_KEY, if set, lets the page
write the AI text; without it the boxes show the page's plain summaries.
"""

from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import os
import re
import smtplib
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid, parseaddr
from pathlib import Path
from zoneinfo import ZoneInfo

DEFAULT_CONFIG = {
    "version": 1,
    "subscriptions": [
        {
            "id": "champaign-3s",
            "station": "USC00118740",
            "label": "Champaign 3S, IL",
            "to": ["snesbitt@illinois.edu"],
            "time": "09:00",
            "timezone": "America/Chicago",
            "days": ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
            "enabled": True,
            "ai": True,
            "pdf": True,
            "delivery": "auto",
            "github": ["swnesbitt"],
        }
    ],
}

DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
STATION_RE = re.compile(r"^[A-Z0-9]{11}$")
EMAIL_RE = re.compile(r"^[^@\s,;<>\"]+@[^@\s,;<>\"]+\.[A-Za-z]{2,}$")
TIME_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
GH_USER_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$")
DELIVERIES = ("auto", "email", "github")
IMAGES_TAG = "notify-images"
KEEP_IMAGES = dt.timedelta(days=30)
LEAD = dt.timedelta(minutes=5)      # a run up to 5 minutes early still counts
LATE = dt.timedelta(hours=6)        # give up on a day's email this long after its time
MAX_ATTEMPTS = 3                    # per subscription per day


class ConfigError(ValueError):
    pass


def log(msg: str) -> None:
    print(msg, flush=True)


# ---------------------------------------------------------------------------
# Configuration and state


def load_config() -> dict:
    raw = os.environ.get("NOTIFY_CONFIG", "").strip()
    cfg = json.loads(raw) if raw else DEFAULT_CONFIG
    subs = cfg.get("subscriptions")
    if not isinstance(subs, list):
        raise ConfigError("NOTIFY_CONFIG has no subscriptions list")
    seen = set()
    for s in subs:
        sid = str(s.get("id", ""))
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", sid) or sid in seen:
            raise ConfigError(f"bad or duplicate subscription id {sid!r}")
        seen.add(sid)
        s["station"] = str(s.get("station", "")).upper()
        if not STATION_RE.match(s["station"]):
            raise ConfigError(f"{sid}: station must be an 11-character GHCN-Daily ID")
        to = s.get("to") or []
        if isinstance(to, str):
            to = re.split(r"[,;\s]+", to)
        s["to"] = [a.strip() for a in to if a.strip()]
        for a in s["to"]:
            if not EMAIL_RE.match(a):
                raise ConfigError(f"{sid}: not an email address: {a!r}")
        if not TIME_RE.match(str(s.get("time", ""))):
            raise ConfigError(f"{sid}: time must be HH:MM")
        try:
            ZoneInfo(s.get("timezone") or "America/Chicago")
        except Exception as exc:  # noqa: BLE001
            raise ConfigError(f"{sid}: unknown time zone {s.get('timezone')!r}") from exc
        s.setdefault("timezone", "America/Chicago")
        days = [d for d in (s.get("days") or DAYS) if d in DAYS]
        s["days"] = days or DAYS
        s.setdefault("enabled", True)
        s.setdefault("ai", True)
        s.setdefault("pdf", True)
        s.setdefault("delivery", "auto")
        if s["delivery"] not in DELIVERIES:
            raise ConfigError(f"{sid}: delivery must be one of {', '.join(DELIVERIES)}")
        gh = s.get("github")
        if gh is None:
            gh = [repo_owner()]
        if isinstance(gh, str):
            gh = re.split(r"[,;\s]+", gh)
        s["github"] = [u.strip().lstrip("@") for u in gh if u.strip().lstrip("@")]
        for u in s["github"]:
            if not GH_USER_RE.match(u):
                raise ConfigError(f"{sid}: not a GitHub username: {u!r}")
    return cfg


def repo_owner() -> str:
    return os.environ.get("GITHUB_REPOSITORY", "swnesbitt/ghcnd-chat").split("/", 1)[0]


def smtp_ready() -> bool:
    return bool(os.environ.get("SMTP_HOST", "").strip())


def channel(sub: dict) -> tuple[str | None, str]:
    """How this subscription is delivered right now: ("email" | "github" | None, why not)."""
    d = sub["delivery"]
    if d in ("email", "auto") and sub["to"] and smtp_ready():
        return "email", ""
    if d == "email":
        return None, "email delivery needs a mail server and at least one address"
    if sub["github"]:
        return "github", ""
    return None, "no GitHub accounts to notify"


def mask_addresses(cfg: dict) -> None:
    """Hide recipient addresses in public Actions logs."""
    if os.environ.get("GITHUB_ACTIONS") != "true":
        return
    for s in cfg["subscriptions"]:
        for a in s["to"]:
            print(f"::add-mask::{a}", flush=True)


def load_state(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {"subscriptions": {}}


def save_state(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")


def due(sub: dict, st: dict, now: dt.datetime) -> tuple[bool, str]:
    tz = ZoneInfo(sub["timezone"])
    local = now.astimezone(tz)
    today = local.date().isoformat()
    if not sub.get("enabled", True):
        return False, "disabled"
    ch, why = channel(sub)
    if not ch:
        return False, why
    if DAYS[local.weekday()] not in sub["days"]:
        return False, f"not scheduled on {DAYS[local.weekday()]}"
    hh, mm = map(int, sub["time"].split(":"))
    at = local.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if local < at - LEAD:
        return False, f"before {sub['time']} {sub['timezone']}"
    if local > at + LATE:
        return False, "send window passed"
    if st.get("last_sent") == today:
        return False, "already sent today"
    if st.get("attempt_date") == today and st.get("attempts", 0) >= MAX_ATTEMPTS:
        return False, f"{MAX_ATTEMPTS} failed attempts today"
    return True, "due"


# ---------------------------------------------------------------------------
# Rendering the live page

# Runs in the page: turns the rendered almanac into email-safe HTML (inline
# styles, tables, placeholders for chart images) and plain text.
EXTRACT_JS = r"""
() => {
  const art = document.querySelector("article.alm");
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const INK = "#13294b", SOFT = "#474948", RULE = "#d4d6d4";
  const HEAD = "font-family:Montserrat,'Helvetica Neue',Arial,sans-serif;color:" + INK;
  const parts = [], text = [];
  let n = 0;
  const baseColor = getComputedStyle(art).color;

  const inlineTable = (t) => {
    const c = t.cloneNode(true);
    const src = t.querySelectorAll("*"), dst = c.querySelectorAll("*");
    src.forEach((e, i) => {
      const cs = getComputedStyle(e), x = dst[i], st = [];
      x.removeAttribute("class"); x.removeAttribute("id");
      if (e.tagName === "TH" || e.tagName === "TD") {
        st.push("padding:6px 14px 6px 0", "border-bottom:1px solid " + RULE, "text-align:left", "vertical-align:top");
        if (cs.whiteSpace === "nowrap") st.push("white-space:nowrap");
      }
      const fw = parseInt(cs.fontWeight, 10);
      if (fw >= 600) st.push("font-weight:" + (fw >= 700 ? 700 : 600));
      if (cs.fontStyle === "italic") st.push("font-style:italic");
      if (cs.color !== baseColor) st.push("color:" + cs.color);
      if (cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)") st.push("background-color:" + cs.backgroundColor);
      const fs = parseFloat(cs.fontSize);
      if (Math.abs(fs - 16) > 0.5) st.push("font-size:" + Math.round(fs) + "px");
      if (cs.display === "inline-block") st.push("display:inline-block", "padding:0 6px");
      if (st.length) x.setAttribute("style", st.join(";"));
    });
    c.removeAttribute("class");
    c.setAttribute("cellpadding", "0");
    c.setAttribute("cellspacing", "0");
    c.setAttribute("style", "border-collapse:collapse;width:100%;font-size:15px;line-height:1.35;margin:4px 0 10px;color:" + INK);
    text.push([...t.querySelectorAll("tr")].map((r) => [...r.children].map((cell) => cell.innerText.replace(/\s+/g, " ").trim()).join(" | ")).join("\n"));
    return '<div style="overflow-x:auto">' + c.outerHTML + "</div>";
  };

  const boxHtml = (b) => {
    const c = b.cloneNode(true);
    if (!c.querySelector("p, ul, ol")) return '<p style="margin:0">' + esc(b.textContent.trim()) + "</p>";
    c.querySelectorAll("p").forEach((p) => p.setAttribute("style", "margin:0 0 8px"));
    c.querySelectorAll("ul, ol").forEach((p) => p.setAttribute("style", "margin:0 0 8px;padding-left:20px"));
    c.querySelectorAll("a").forEach((a) => a.setAttribute("style", "color:" + INK));
    return c.innerHTML;
  };

  const walk = (node) => {
    for (const e of node.children) {
      if (e.tagName === "H2") {
        parts.push('<h2 style="' + HEAD + ';font-size:21px;font-weight:700;margin:30px 0 10px">' + esc(e.textContent) + "</h2>");
        text.push("", e.textContent.toUpperCase());
      } else if (e.classList.contains("alm-box")) {
        parts.push('<div style="background-color:#e9f6fb;border-left:4px solid #009fd4;padding:12px 16px;margin:0 0 14px;font-size:16px;line-height:1.55;color:' + INK + '">' + boxHtml(e) + "</div>");
        text.push(e.innerText.trim());
      } else if (e.matches("figure.alm-chart")) {
        if (e.querySelector("svg.marks, canvas")) {
          e.dataset.emailChart = String(n);
          parts.push('<img src="cid:__CHART' + n + '__" width="660" alt="' + esc(e.getAttribute("aria-label") || "Chart") + '" style="display:block;width:100%;max-width:660px;height:auto;border:0;margin:6px 0 14px">');
          n++;
        }
      } else if (e.tagName === "TABLE") {
        parts.push(inlineTable(e));
      } else if (e.tagName === "H3") {
        parts.push('<h3 style="' + HEAD + ';font-size:17px;font-weight:700;margin:20px 0 4px">' + esc(e.textContent) + "</h3>");
        text.push("", e.textContent);
      } else if (e.tagName === "P" || !e.children.length) {
        const t = e.innerText.trim();
        if (t) {
          const strong = e.classList.contains("alm-rank");
          parts.push('<p style="margin:4px 0 8px;font-size:' + (strong ? "17px;font-weight:600" : "14px;color:" + SOFT) + '">' + esc(t) + "</p>");
          text.push(t);
        }
      } else {
        walk(e);
      }
    }
  };

  const head = art.querySelector(".alm-head");
  const title = head.querySelector("h1").textContent;
  const metas = [...head.querySelectorAll(".alm-meta")].map((p) => p.textContent);
  for (const sec of art.querySelectorAll("section.alm-section")) walk(sec);
  const foot = [...art.querySelectorAll(".alm-foot p")].map((p) => p.textContent);
  const firstBox = art.querySelector(".alm-box");
  return {
    title, metas, foot, charts: n,
    body: parts.join("\n"),
    text: text.join("\n"),
    preheader: firstBox ? firstBox.innerText.trim().replace(/\s+/g, " ").slice(0, 180) : "",
    headline: (window.almanacResult && window.almanacResult.headline) || "",
    station: (window.almanacResult && window.almanacResult.station) || null,
    aiNote: (art.querySelector(".alm-ai") || {}).textContent || "",
  };
}
"""

HIDE_CHROME_CSS = """
.vega-embed details, .vega-embed .vega-actions { display: none !important; }
"""


def launch_browser(p, chrome: str | None):
    opts = {"headless": True}
    if chrome:
        opts["executable_path"] = chrome
    elif os.environ.get("GITHUB_ACTIONS") == "true":
        opts["channel"] = "chrome"  # Google Chrome is preinstalled on GitHub's Ubuntu runners
    if os.environ.get("HTTPS_PROXY") and os.environ.get("GITHUB_ACTIONS") != "true":
        opts["args"] = [f"--proxy-server={os.environ['HTTPS_PROXY']}", "--proxy-bypass-list=localhost;127.0.0.1"]
    return p.chromium.launch(**opts)


def render(browser, sub: dict, site: str, lumen_key: str | None) -> dict:
    ctx = browser.new_context(
        viewport={"width": 740, "height": 1000},
        device_scale_factor=2,
        timezone_id=sub["timezone"],
        locale="en-US",
        color_scheme="light",
    )
    if lumen_key and sub.get("ai", True):
        ctx.add_init_script(f"try {{ localStorage.setItem('lumen-api-key', {json.dumps(lumen_key)}); }} catch (e) {{}}")
    page = ctx.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    try:
        url = f"{site}?station={sub['station']}"
        t0 = time.time()
        page.goto(url, wait_until="domcontentloaded", timeout=120000)
        page.wait_for_selector("article.alm[data-ready], #alm-out .error-block", timeout=480000)
        if page.locator("#alm-out .error-block").count():
            raise RuntimeError("almanac failed: " + (page.text_content("#alm-out .error-text") or "unknown error"))
        page.add_style_tag(content=HIDE_CHROME_CSS)
        page.wait_for_timeout(800)
        log(f"  rendered in {time.time() - t0:.0f}s")
        data = page.evaluate(EXTRACT_JS)
        # The page's sign-in hint means nothing in an email.
        data["foot"] = [f.replace(" Sign in to Lumen on the GHCN chat tab for AI-written summaries; until then the boxes show plain summaries.",
                                  " This copy has no AI text; the boxes show plain summaries.") for f in data["foot"]]
        charts = []
        for i in range(data["charts"]):
            fig = page.locator(f'figure[data-email-chart="{i}"]')
            fig.scroll_into_view_if_needed()
            charts.append(fig.screenshot(type="png", animations="disabled"))
        data["chart_png"] = charts
        data["pdf"] = page.pdf(
            format="Letter",
            print_background=True,
            margin={"top": "0.5in", "bottom": "0.6in", "left": "0.5in", "right": "0.5in"},
            display_header_footer=True,
            header_template="<span></span>",
            footer_template=(
                '<div style="font-size:8px;color:#666;width:100%;padding:0 0.5in;font-family:Arial,sans-serif;'
                'display:flex;justify-content:space-between"><span>GHCN-Daily Chat, Illinois CliMAS</span>'
                '<span><span class="pageNumber"></span> of <span class="totalPages"></span></span></div>'
            ),
        ) if sub.get("pdf", True) else None
        data["page_errors"] = errors
        return data
    finally:
        ctx.close()


# ---------------------------------------------------------------------------
# The email


def email_html(d: dict, sub: dict, site: str, cids: list[str]) -> str:
    body = d["body"]
    for i, cid in enumerate(cids):
        body = body.replace(f"cid:__CHART{i}__", f"cid:{cid}")
    live = f"{site}?station={sub['station']}"
    settings = f"{site}#email"
    e = html.escape
    metas = "".join(f'<p style="margin:2px 0;font-size:14px;color:#474948">{e(m)}</p>' for m in d["metas"])
    foot = "".join(f'<p style="margin:0 0 8px;font-size:13px;line-height:1.45;color:#474948">{e(m)}</p>' for m in d["foot"])
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><title>{e(d['title'])}</title></head>
<body style="margin:0;padding:0;background-color:#eef0f3">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">{e(d['preheader'])}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#eef0f3"><tr><td align="center" style="padding:16px 8px">
<table role="presentation" width="700" cellpadding="0" cellspacing="0" style="width:100%;max-width:700px;background-color:#ffffff;font-family:'Source Sans 3','Source Sans Pro','Segoe UI',Arial,sans-serif;color:#13294b">
<tr><td style="background-color:#13294b;padding:14px 20px">
  <div style="font-family:Montserrat,'Helvetica Neue',Arial,sans-serif;font-size:12px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:#ffffff">Illinois Climate, Meteorology &amp; Atmospheric Sciences</div>
  <div style="font-family:Montserrat,'Helvetica Neue',Arial,sans-serif;font-size:20px;font-weight:700;color:#ffffff;margin-top:2px">Climate at a glance</div>
</td></tr>
<tr><td style="background-color:#ff5f05;height:4px;line-height:4px;font-size:0">&nbsp;</td></tr>
<tr><td style="padding:20px 20px 8px">
  <h1 style="font-family:Montserrat,'Helvetica Neue',Arial,sans-serif;font-size:26px;font-weight:700;margin:0 0 6px;color:#13294b">{e(d['title'])}</h1>
  {metas}
  <p style="margin:14px 0 0"><a href="{e(live)}" style="display:inline-block;background-color:#c84113;color:#ffffff;text-decoration:none;font-weight:700;padding:9px 16px">Open the live almanac</a></p>
</td></tr>
<tr><td style="padding:0 20px 8px;font-size:16px;line-height:1.45">
{body}
</td></tr>
<tr><td style="padding:16px 20px 20px;border-top:1px solid #d4d6d4">
  {foot}
  <p style="margin:12px 0 0;font-size:13px;color:#474948">You get this because this address is on the daily email list for station {e(sub['station'])}.
  <a href="{e(settings)}" style="color:#13294b">Change or stop these emails</a>.</p>
</td></tr>
</table></td></tr></table></body></html>"""


def email_text(d: dict, sub: dict, site: str) -> str:
    lines = [d["title"], *d["metas"], ""]
    if d.get("headline"):
        lines += [d["headline"], ""]
    lines += [d["text"].strip(), "", *d["foot"], "",
              f"Live almanac: {site}?station={sub['station']}",
              f"Change or stop these emails: {site}#email"]
    return "\n".join(lines) + "\n"


def build_message(d: dict, sub: dict, site: str, sender: str, local_day: dt.date) -> tuple[EmailMessage, str]:
    day = f"{local_day:%A}, {local_day:%B} {local_day.day}"
    name = sub.get("label") or d["title"]
    subject = f"{name}, {day}" + (f". {d['headline']}" if d.get("headline") else "")
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = sender
    msg["Date"] = formatdate(localtime=False)
    msg["Message-ID"] = make_msgid(domain="ghcnd-chat.local")
    msg["Auto-Submitted"] = "auto-generated"
    msg["X-Auto-Response-Suppress"] = "All"
    msg["List-Unsubscribe"] = f"<{site}#email>"
    msg.set_content(email_text(d, sub, site))
    cids = [make_msgid(idstring=f"chart{i}", domain="ghcnd-chat.local")[1:-1] for i in range(len(d["chart_png"]))]
    msg.add_alternative(email_html(d, sub, site, cids), subtype="html")
    html_part = msg.get_payload()[1]
    for cid, png in zip(cids, d["chart_png"]):
        html_part.add_related(png, maintype="image", subtype="png", cid=f"<{cid}>", filename=f"{cid.split('.')[0]}.png")
    if d.get("pdf"):
        msg.add_attachment(d["pdf"], maintype="application", subtype="pdf",
                           filename=f"almanac-{sub['station']}-{local_day.isoformat()}.pdf")
    return msg, subject


def smtp_send(msg: EmailMessage, recipients: list[str]) -> None:
    host = os.environ.get("SMTP_HOST", "").strip()
    if not host:
        raise RuntimeError("SMTP_HOST is not set; add the mail server on the Daily email tab")
    port = int(os.environ.get("SMTP_PORT") or 587)
    user = os.environ.get("SMTP_USERNAME", "").strip()
    pw = os.environ.get("SMTP_PASSWORD", "")
    ctx = ssl.create_default_context()
    server = smtplib.SMTP_SSL(host, port, context=ctx, timeout=60) if port == 465 else smtplib.SMTP(host, port, timeout=60)
    try:
        server.ehlo()
        if port != 465 and server.has_extn("starttls"):
            server.starttls(context=ctx)
            server.ehlo()
        if user:
            server.login(user, pw)
        for to in recipients:
            del msg["To"]
            msg["To"] = to
            server.send_message(msg, to_addrs=[to])
    finally:
        try:
            server.quit()
        except Exception:  # noqa: BLE001
            pass


# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# GitHub notification delivery


class GitHub:
    def __init__(self, repo: str, token: str):
        self.repo, self.token = repo, token

    def req(self, method: str, url: str, body=None, data: bytes | None = None, ctype: str = "application/json"):
        if not self.token:
            raise RuntimeError("GITHUB_TOKEN is not set")
        if not url.startswith("https://"):
            url = f"https://api.github.com/repos/{self.repo}{url}"
        if body is not None:
            data = json.dumps(body).encode()
        r = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": f"Bearer {self.token}", "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28", "Content-Type": ctype, "User-Agent": "ghcnd-chat-notify"})
        try:
            with urllib.request.urlopen(r, timeout=60) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as exc:
            msg = exc.read().decode(errors="replace")[:300]
            err = RuntimeError(f"GitHub {method} {url.split('?')[0]}: {exc.code} {msg}")
            err.status = exc.code
            raise err from None
        return json.loads(raw) if raw else None


def images_release(gh: GitHub) -> dict:
    try:
        return gh.req("GET", f"/releases/tags/{IMAGES_TAG}")
    except RuntimeError as exc:
        if getattr(exc, "status", None) != 404:
            raise
    return gh.req("POST", "/releases", {
        "tag_name": IMAGES_TAG, "name": "Daily almanac images", "prerelease": True, "make_latest": "false",
        "body": "Charts and PDFs for the daily almanac issue comments, posted by .github/workflows/notify.yml. Files older than 30 days are deleted.",
    })


def upload(gh: GitHub, rel: dict, name: str, data: bytes, ctype: str) -> str:
    url = f"https://uploads.github.com/repos/{gh.repo}/releases/{rel['id']}/assets?name={urllib.parse.quote(name)}"
    return gh.req("POST", url, data=data, ctype=ctype)["browser_download_url"]


def prune_images(gh: GitHub, rel: dict, now: dt.datetime) -> None:
    page = 1
    while True:
        assets = gh.req("GET", f"/releases/{rel['id']}/assets?per_page=100&page={page}")
        for x in assets:
            if now - dt.datetime.fromisoformat(x["created_at"].replace("Z", "+00:00")) > KEEP_IMAGES:
                gh.req("DELETE", f"/releases/assets/{x['id']}")
        if len(assets) < 100:
            return
        page += 1


def _emph(style: str, text: str) -> str:
    if not text.strip():
        return text
    if re.search(r"font-weight:(600|700)", style):
        text = f"<strong>{text}</strong>"
    if "font-style:italic" in style:
        text = f"<em>{text}</em>"
    return text


def github_comment(d: dict, sub: dict, site: str, local_day: dt.date, chart_urls: list[str], pdf_url: str | None) -> str:
    body = d["body"]
    for i, u in enumerate(chart_urls):
        body = body.replace(f"cid:__CHART{i}__", u)
    # GitHub drops style attributes: the blue boxes become block quotes.
    body = re.sub(r'<div style="background-color:#e9f6fb[^"]*">(.*?)</div>', r"<blockquote>\1</blockquote>", body, flags=re.S)
    # Keep bold and italic cells (the big values, forecast rows) as tags.
    body = re.sub(r'<(div|td|th|span)([^>]*?)\sstyle="([^"]*)"([^>]*)>([^<]*)</\1>',
                  lambda m: f"<{m[1]}{m[2]}{m[4]}>" + _emph(m[3], m[5]) + f"</{m[1]}>", body)
    body = re.sub(r'\sstyle="[^"]*"', "", body)
    body = re.sub(r"\n\s*\n+", "\n", body).strip()
    e = html.escape
    live = f"{site}?station={sub['station']}"
    day = f"{local_day:%A}, {local_day:%B} {local_day.day}, {local_day.year}"
    mentions = " ".join("@" + u for u in sub["github"])
    links = [f"[Live almanac]({live})"] + ([f"[Full almanac (PDF)]({pdf_url})"] if pdf_url else [])
    head = (f"{mentions} **{e(sub.get('label') or d['title'])}, {day}.** {e(d.get('headline') or '')}\n\n"
            f"{' · '.join(links)}\n\n")
    foot = "<br>\n".join(e(f) for f in d["foot"])
    tail = (f"\n\n<sub>{foot}</sub>\n\n<sub>Posted by the daily almanac job for {e(sub.get('label') or d['title'])} ({sub['station']}). "
            f"Change or stop it on the [Daily email tab]({site}#email).</sub>\n")
    md = head + body + tail
    if len(md) > 64000:  # GitHub's comment limit is 65,536 characters
        md = head + "<blockquote>" + e(d.get("preheader") or "") + "</blockquote>" + tail
    return md


def post_to_github(gh: GitHub, d: dict, sub: dict, site: str, local_day: dt.date, now: dt.datetime, st: dict) -> str:
    rel = images_release(gh)
    stamp = f"{sub['id']}-{local_day.isoformat()}-{now:%H%M}"
    charts = [upload(gh, rel, f"{stamp}-chart{i}.png", png, "image/png") for i, png in enumerate(d["chart_png"])]
    pdf = upload(gh, rel, f"almanac-{sub['station']}-{local_day.isoformat()}-{now:%H%M}.pdf", d["pdf"], "application/pdf") if d.get("pdf") else None
    try:
        prune_images(gh, rel, now)
    except RuntimeError as exc:
        log(f"  could not prune old images: {exc}")
    title = f"Daily almanac: {sub.get('label') or d['title']} ({sub['station']})"
    issue = None
    if st.get("issue"):
        try:
            issue = gh.req("GET", f"/issues/{st['issue']}")
        except RuntimeError:
            issue = None
    if not issue or issue.get("title") != title:
        found = [i for i in gh.req("GET", "/issues?state=open&per_page=100&creator=github-actions%5Bbot%5D")
                 if i.get("title") == title and "pull_request" not in i]
        issue = found[0] if found else gh.req("POST", "/issues", {
            "title": title,
            "body": (f"Each morning the daily almanac job posts the [Climate at a glance]({site}?station={sub['station']}) "
                     f"page for {sub.get('label') or d['title']} here, and the GitHub accounts it mentions get it by email "
                     "(from notifications@github.com, if email notifications for mentions are on). "
                     f"Change or stop it on the [Daily email tab]({site}#email)."),
        })
    st["issue"] = issue["number"]
    c = gh.req("POST", f"/issues/{issue['number']}/comments", {"body": github_comment(d, sub, site, local_day, charts, pdf)})
    return c["html_url"]


def default_site() -> str:
    repo = os.environ.get("GITHUB_REPOSITORY", "swnesbitt/ghcnd-chat")
    owner, name = repo.split("/", 1)
    return f"https://{owner}.github.io/{name}/"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="list due subscriptions and exit")
    mode.add_argument("--send", action="store_true", help="render and send")
    ap.add_argument("--only", default="", help="subscription id (sends it now, whether or not it is due)")
    ap.add_argument("--state", default="state/state.json")
    ap.add_argument("--site", default=os.environ.get("SITE_URL") or default_site())
    ap.add_argument("--dry-run", metavar="DIR", help="write .eml, .html, charts and PDF here instead of sending")
    ap.add_argument("--chrome", default=os.environ.get("CHROME_PATH"))
    a = ap.parse_args()
    site = a.site if a.site.endswith("/") else a.site + "/"

    try:
        cfg = load_config()
    except (ConfigError, ValueError) as exc:
        log(f"::error::Subscription settings are invalid: {exc}")
        return 1
    mask_addresses(cfg)
    state_path = Path(a.state)
    state = load_state(state_path)
    sstate = state.setdefault("subscriptions", {})
    now = dt.datetime.now(dt.timezone.utc)

    subs = cfg["subscriptions"]
    if a.only:
        subs = [s for s in subs if s["id"] == a.only]
        if not subs:
            log(f"::error::No subscription with id {a.only!r}")
            return 1
        todo = subs
    else:
        todo = []
        for s in subs:
            ok, why = due(s, sstate.get(s["id"], {}), now)
            log(f"{s['id']} ({s['station']}, {s['time']} {s['timezone']}, by {channel(s)[0] or 'nothing'}): {why}")
            if ok:
                todo.append(s)

    if a.check:
        out = os.environ.get("GITHUB_OUTPUT")
        if out:
            with open(out, "a") as f:
                f.write(f"due={','.join(s['id'] for s in todo)}\n")
        return 0
    if not todo:
        log("Nothing to send.")
        return 0

    from playwright.sync_api import sync_playwright

    sender = os.environ.get("MAIL_FROM", "").strip() or os.environ.get("SMTP_USERNAME", "").strip()
    if not a.dry_run and not sender and any(channel(s)[0] == "email" for s in todo):
        log("::error::MAIL_FROM (or SMTP_USERNAME) is not set")
        return 1
    gh = GitHub(os.environ.get("GITHUB_REPOSITORY", "swnesbitt/ghcnd-chat"), os.environ.get("GITHUB_TOKEN", ""))
    if sender and not parseaddr(sender)[0]:
        sender = formataddr(("Climate at a glance", parseaddr(sender)[1]))
    lumen_key = os.environ.get("LUMEN_API_KEY", "").strip() or None
    if not lumen_key:
        log("LUMEN_API_KEY is not set: the email will use the page's plain summaries instead of AI text.")

    failures = 0
    with sync_playwright() as p:
        browser = launch_browser(p, a.chrome)
        for s in todo:
            st = sstate.setdefault(s["id"], {})
            local_day = now.astimezone(ZoneInfo(s["timezone"])).date()
            forced = bool(a.only)
            ch, why = channel(s)
            if a.dry_run and not ch:
                ch = "github"
            try:
                if not ch:
                    raise RuntimeError(why)
                who = f"{len(s['to'])} address(es)" if ch == "email" else "GitHub " + ", ".join("@" + u for u in s["github"])
                log(f"Sending {s['id']} ({s['station']}) by {ch} to {who}{' (on request)' if forced else ''}")
                d = None
                for attempt in range(2):  # the NWS and NOAA services are occasionally slow
                    try:
                        d = render(browser, s, site, lumen_key)
                        break
                    except Exception as exc:  # noqa: BLE001
                        if attempt:
                            raise
                        log(f"  render failed ({exc}); retrying in 30 s")
                        time.sleep(30)
                if d["page_errors"]:
                    log(f"  page errors: {d['page_errors'][:3]}")
                msg, subject = build_message(d, s, site, sender or "Climate at a glance <noreply@example.com>", local_day)
                log(f"  subject: {subject}")
                log(f"  {len(d['chart_png'])} charts, PDF {len(d['pdf'] or b'') // 1024} KB, message {len(msg.as_bytes()) // 1024} KB")
                if a.dry_run:
                    out = Path(a.dry_run)
                    out.mkdir(parents=True, exist_ok=True)
                    msg["To"] = ", ".join(s["to"])
                    (out / f"{s['id']}.eml").write_bytes(msg.as_bytes())
                    preview = email_html(d, s, site, [f"{s['id']}-chart{i}.png" for i in range(len(d["chart_png"]))])
                    (out / f"{s['id']}.html").write_text(preview.replace('src="cid:', 'src="'))
                    for i, png in enumerate(d["chart_png"]):
                        (out / f"{s['id']}-chart{i}.png").write_bytes(png)
                    if d.get("pdf"):
                        (out / f"{s['id']}.pdf").write_bytes(d["pdf"])
                    (out / f"{s['id']}.txt").write_text(msg.get_body(("plain",)).get_content())
                    md = github_comment(d, s, site, local_day, [f"{s['id']}-chart{i}.png" for i in range(len(d["chart_png"]))],
                                        f"{s['id']}.pdf" if d.get("pdf") else None)
                    (out / f"{s['id']}.md").write_text(md)
                    log(f"  wrote {out / (s['id'] + '.eml')} and {s['id']}.md ({len(md) // 1024} KB comment)")
                    continue
                if ch == "email":
                    smtp_send(msg, s["to"])
                else:
                    url = post_to_github(gh, d, s, site, local_day, now, st)
                    log(f"  posted {url}")
                stamp = now.isoformat(timespec="seconds")
                if forced:
                    st.update(last_test=stamp, last_test_status="sent")
                else:
                    st.update(last_sent=local_day.isoformat(), last_sent_at=stamp, status="sent", attempts=0)
                st["station"] = s["station"]
                log("  sent")
            except Exception as exc:  # noqa: BLE001
                failures += 1
                reason = str(exc).splitlines()[0][:300]
                for addr in s["to"]:
                    reason = reason.replace(addr, "<recipient>")
                log(f"::error::{s['id']}: {reason}")
                if forced:
                    st.update(last_test=now.isoformat(timespec="seconds"), last_test_status=f"failed: {reason}")
                else:
                    today = local_day.isoformat()
                    st["attempts"] = (st.get("attempts", 0) if st.get("attempt_date") == today else 0) + 1
                    st.update(attempt_date=today, status=f"failed: {reason}", last_attempt_at=now.isoformat(timespec="seconds"))
        browser.close()
    if not a.dry_run:
        # Forget subscriptions that no longer exist.
        for k in list(sstate):
            if k not in {s["id"] for s in cfg["subscriptions"]}:
                del sstate[k]
        state["updated"] = now.isoformat(timespec="seconds")
        save_state(state_path, state)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
