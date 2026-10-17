// notify.js — the Daily email tab: edits the subscriptions and mail settings
// that .github/workflows/notify.yml uses to email the almanac each morning.
//
// There is no server, so settings are stored in the repository itself through
// the GitHub API, with a fine-grained token the maintainer pastes here:
//   - NOTIFY_CONFIG (repository secret): the subscriptions the workflow reads.
//     A secret, because the repository and its Actions logs are public and the
//     subscriptions hold email addresses.
//   - NOTIFY_CONFIG (repository variable): the same settings, readable, so this
//     page can show them again. Variables are visible only to people with
//     access to the repository.
//   - SMTP_HOST, SMTP_PORT, SMTP_USERNAME, SMTP_PASSWORD, MAIL_FROM and
//     LUMEN_API_KEY (secrets): mail server and the key for AI-written text.
// Secrets are encrypted in the browser with the repository's public key
// (libsodium sealed box) before they are sent, as GitHub requires.

import nacl from "https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/+esm";
import blake from "https://cdn.jsdelivr.net/npm/blakejs@1.2.1/+esm";
import { createLumenClient } from "./lumen-oauth.js";
import { CONFIG } from "./config.js";

const API = "https://api.github.com";
const REPO = CONFIG.repo;
const WORKFLOW = "notify.yml";
const TOKEN_KEY = "ghcnd-chat:github-token";
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles",
  "America/Anchorage", "Pacific/Honolulu", "America/Puerto_Rico", "UTC"];
const EMAIL = /^[^@\s,;<>"]+@[^@\s,;<>"]+\.[A-Za-z]{2,}$/;
const STATION = /^[A-Z0-9]{11}$/;
const MAIL_SECRETS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USERNAME", "SMTP_PASSWORD", "MAIL_FROM"];

// Matches DEFAULT_CONFIG in scripts/send_almanac.py: what the workflow sends
// until settings are first saved here.
const DEFAULT_SUB = () => ({
  id: "champaign-3s", station: "USC00118740", label: "Champaign 3S, IL", to: ["snesbitt@illinois.edu"],
  time: "09:00", timezone: "America/Chicago", days: [...DAYS], enabled: true, ai: true, pdf: true,
  delivery: "auto", github: [REPO.split("/")[0]],
});
const GH_USER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const DELIVERY = [
  ["auto", "Email if a mail server is set up, otherwise GitHub notification"],
  ["email", "Email only (needs the mail server below)"],
  ["github", "GitHub notification only"],
];

// A second Lumen client, so the key for the daily email is its own key
// (named on the Lumen Profile page) and never the one this browser chats with.
const emailLumen = createLumenClient({
  baseUrl: CONFIG.lumenBaseUrl,
  clientId: CONFIG.clientId,
  keyName: `${CONFIG.keyName}-daily-email`,
  storageKey: "lumen-email-key",
});

let deps = null;
let root = null;
let state = { token: null, login: null, subs: null, saved: null, secrets: null, log: null, runs: null, loaded: false };
let pendingStation = null;

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return node;
};

const store = {
  get() {
    try { return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY); } catch { return null; }
  },
  set(token, remember) {
    try {
      sessionStorage.setItem(TOKEN_KEY, token);
      if (remember) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY);
    } catch { /* storage unavailable */ }
  },
  clear() {
    try { sessionStorage.removeItem(TOKEN_KEY); localStorage.removeItem(TOKEN_KEY); } catch { /* */ }
  },
};

// ---------------------------------------------------------------------------
// GitHub API

async function gh(path, { method = "GET", body, raw = false, auth = true } = {}) {
  const headers = { Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (auth && state.token) headers.Authorization = `Bearer ${state.token}`;
  if (body) headers["Content-Type"] = "application/json";
  const r = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  const text = await r.text();
  if (!r.ok) {
    let msg = text;
    try { msg = JSON.parse(text).message; } catch { /* not JSON */ }
    const err = new Error(`GitHub: ${msg || r.status}`);
    err.status = r.status;
    throw err;
  }
  if (raw) return text;
  return text ? JSON.parse(text) : null;
}

const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// libsodium crypto_box_seal: ephemeral key pair, nonce = BLAKE2b(epk || pk, 24 bytes).
export function sealedBox(message, publicKey) {
  const eph = nacl.box.keyPair();
  const nonceIn = new Uint8Array(64);
  nonceIn.set(eph.publicKey, 0);
  nonceIn.set(publicKey, 32);
  const nonce = blake.blake2b(nonceIn, undefined, 24);
  const boxed = nacl.box(new TextEncoder().encode(message), nonce, publicKey, eph.secretKey);
  const out = new Uint8Array(32 + boxed.length);
  out.set(eph.publicKey, 0);
  out.set(boxed, 32);
  return out;
}

let publicKey = null;
async function putSecret(name, value) {
  publicKey ||= await gh(`/repos/${REPO}/actions/secrets/public-key`);
  await gh(`/repos/${REPO}/actions/secrets/${name}`, {
    method: "PUT",
    body: { encrypted_value: b64(sealedBox(String(value), unb64(publicKey.key))), key_id: publicKey.key_id },
  });
}

async function putVariable(name, value) {
  try {
    await gh(`/repos/${REPO}/actions/variables/${name}`, { method: "PATCH", body: { name, value } });
  } catch (err) {
    if (err.status !== 404) throw err;
    await gh(`/repos/${REPO}/actions/variables`, { method: "POST", body: { name, value } });
  }
}

// ---------------------------------------------------------------------------
// Loading

async function loadPublic() {
  const [log, runs] = await Promise.allSettled([
    gh(`/repos/${REPO}/contents/state.json?ref=notify-state`, { raw: true, auth: false }).then(JSON.parse),
    gh(`/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=5`, { auth: false }),
  ]);
  state.log = log.status === "fulfilled" ? log.value : null;
  state.runs = runs.status === "fulfilled" ? runs.value.workflow_runs : null;
}

async function loadPrivate() {
  const user = await gh("/user");
  state.login = user.login;
  let saved = null;
  try {
    saved = JSON.parse((await gh(`/repos/${REPO}/actions/variables/NOTIFY_CONFIG`)).value);
  } catch (err) {
    if (err.status === 403) throw new Error("This token cannot read the repository's variables. It needs Variables: Read and write on this repository.");
    if (err.status !== 404) throw err;
  }
  state.saved = saved;
  state.subs = structuredClone(saved?.subscriptions || [DEFAULT_SUB()]);
  try {
    const s = await gh(`/repos/${REPO}/actions/secrets?per_page=100`);
    state.secrets = new Set(s.secrets.map((x) => x.name));
  } catch (err) {
    if (err.status === 403) throw new Error("This token cannot see the repository's secrets. It needs Secrets: Read and write on this repository.");
    throw err;
  }
}

async function refresh({ quiet = false } = {}) {
  if (!quiet) render("Loading");
  await loadPublic();
  if (state.token) {
    try {
      await loadPrivate();
    } catch (err) {
      state.subs = null;
      render();
      return message(err.message, true);
    }
  }
  state.loaded = true;
  render();
  if (pendingStation && state.subs) {
    const st = pendingStation;
    pendingStation = null;
    addStationFromAlmanac(st);
  }
  await finishLumenKey();
}

// ---------------------------------------------------------------------------
// Rendering

let msgNode = null;
function message(text, isError = false) {
  if (!msgNode) return;
  msgNode.textContent = text;
  msgNode.hidden = !text;
  msgNode.classList.toggle("ntf-error", isError);
}

function fmtWhen(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function deliveryLine(sub) {
  const s = state.log?.subscriptions?.[sub.id];
  if (!s) return state.saved || sub.id === "champaign-3s" ? "Not sent yet." : "Not sent yet (save first).";
  const parts = [];
  if (s.last_sent) parts.push(`Last sent ${fmtWhen(s.last_sent_at)}.`);
  if (s.issue) parts.push(el("a", { href: `https://github.com/${REPO}/issues/${s.issue}`, target: "_blank", rel: "noopener", textContent: "Open its GitHub issue" }));
  if (s.status?.startsWith("failed")) parts.push(`Last attempt ${fmtWhen(s.last_attempt_at)} ${s.status}.`);
  if (s.last_test) parts.push(`Test ${fmtWhen(s.last_test)}: ${s.last_test_status}.`);
  return parts.length ? parts.flatMap((x) => [x, " "]) : "Not sent yet.";
}

function tokenUrl() {
  const owner = REPO.split("/")[0];
  const q = new URLSearchParams({
    name: "ghcnd-chat daily email",
    description: `Lets the Daily email tab on GHCN-Daily Chat edit the email settings of ${REPO}.`,
    target_name: owner,
    expires_in: "366",
    actions: "write",
    secrets: "write",
    actions_variables: "write",
  });
  return `https://github.com/settings/personal-access-tokens/new?${q}`;
}

function tokenSection() {
  if (state.token) {
    return el("p", { className: "fine ntf-who" },
      `Signed in to GitHub as ${state.login || "…"}. `,
      el("button", { type: "button", className: "quiet", textContent: "Forget token", onclick: () => {
        store.clear();
        state = { ...state, token: null, login: null, subs: null, saved: null, secrets: null };
        render();
      } }));
  }
  const input = el("input", { type: "password", id: "ntf-token", autocomplete: "off", spellcheck: false, placeholder: "github_pat_…" });
  const remember = el("input", { type: "checkbox", id: "ntf-remember" });
  const form = el("form", { className: "ntf-token" },
    el("label", { htmlFor: "ntf-token", textContent: "GitHub token" }),
    el("div", { className: "alm-row" }, input, el("button", { type: "submit", className: "primary", textContent: "Connect" })),
    el("label", { className: "ntf-check" }, remember, " Remember on this device (otherwise it is forgotten when you close the tab)"));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const t = input.value.trim();
    if (!t) return;
    state.token = t;
    try {
      await loadPrivate();
      store.set(t, remember.checked);
      await refresh({ quiet: true });
    } catch (err) {
      state.token = null;
      message(err.status === 401 ? "GitHub did not accept that token." : err.message, true);
    }
  });
  return el("div", { className: "ntf-card" },
    el("h2", { textContent: "Sign in to change the settings" }),
    el("p", {},
      `The settings are kept in the ${REPO} repository, so changing them takes a GitHub token with access to it. `,
      el("a", { href: tokenUrl(), target: "_blank", rel: "noopener", textContent: "Create a fine-grained token" }),
      ": under Repository access choose Only select repositories and pick ", el("code", { textContent: REPO.split("/")[1] }),
      "; the link fills in the permissions it needs (Actions, Secrets and Variables: Read and write). Then paste it here."),
    form,
    el("p", { className: "fine" }, "The token stays in this browser and is sent only to api.github.com."));
}

function subCard(sub, i) {
  const id = (k) => `ntf-${i}-${k}`;
  const isSaved = state.saved?.subscriptions?.some((s) => s.id === sub.id) || (!state.saved && sub.id === "champaign-3s");
  const stationIn = el("input", { id: id("station"), value: sub.station, autocomplete: "off", spellcheck: false });
  const stationName = el("span", { className: "fine", textContent: sub.label || "" });
  stationIn.addEventListener("change", async () => {
    const q = stationIn.value.trim();
    if (!q) return;
    stationName.textContent = "Looking up…";
    try {
      const st = await deps.lookupStation(q);
      if (!isSaved && st.id !== sub.station) sub.id = newId(st.id, sub);
      sub.station = st.id;
      sub.label = `${st.name}${st.state ? `, ${st.state}` : ""}`;
      stationIn.value = st.id;
      stationName.textContent = sub.label;
    } catch (err) {
      stationName.textContent = err.message;
    }
  });
  const to = el("input", { id: id("to"), value: sub.to.join(", "), type: "text", autocomplete: "off", placeholder: "netid@illinois.edu, someone@example.com" });
  to.addEventListener("change", () => (sub.to = to.value.split(/[,;\s]+/).filter(Boolean)));
  sub.delivery ||= "auto";
  sub.github ||= [REPO.split("/")[0]];
  const delivery = el("select", { id: id("delivery") }, DELIVERY.map(([v, t]) => el("option", { value: v, textContent: t, selected: v === sub.delivery })));
  delivery.addEventListener("change", () => (sub.delivery = delivery.value));
  const ghUsers = el("input", { id: id("github"), value: sub.github.map((u) => `@${u}`).join(", "), type: "text", autocomplete: "off", spellcheck: false, placeholder: "@swnesbitt" });
  ghUsers.addEventListener("change", () => (sub.github = ghUsers.value.split(/[,;\s]+/).map((u) => u.replace(/^@/, "")).filter(Boolean)));
  const time = el("input", { id: id("time"), type: "time", value: sub.time, step: 900 });
  time.addEventListener("change", () => (sub.time = time.value));
  const zones = ZONES.includes(sub.timezone) ? ZONES : [sub.timezone, ...ZONES];
  const tz = el("select", { id: id("tz") }, zones.map((z) => el("option", { value: z, textContent: z.replace(/_/g, " "), selected: z === sub.timezone })));
  tz.addEventListener("change", () => (sub.timezone = tz.value));
  const days = el("div", { className: "ntf-days", role: "group", ariaLabel: "Days" },
    DAYS.map((d, k) => {
      const box = el("input", { type: "checkbox", checked: sub.days.includes(d) });
      box.addEventListener("change", () => (sub.days = DAYS.filter((x, j) => (j === k ? box.checked : sub.days.includes(x)))));
      return el("label", { className: "ntf-check" }, box, ` ${DAY_NAMES[k]}`);
    }));
  const toggle = (key, label) => {
    const box = el("input", { type: "checkbox", checked: !!sub[key] });
    box.addEventListener("change", () => (sub[key] = box.checked));
    return el("label", { className: "ntf-check" }, box, ` ${label}`);
  };
  const sendNow = el("button", { type: "button", className: "quiet", textContent: "Send now", disabled: !isSaved,
    title: isSaved ? "Render and email this almanac now" : "Save first" });
  sendNow.addEventListener("click", async () => {
    sendNow.disabled = true;
    try {
      await gh(`/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, { method: "POST", body: { ref: "main", inputs: { subscription: sub.id } } });
      message(`Sending ${sub.label || sub.station} now. It takes 2 to 4 minutes; the result shows under Recent sends.`);
      setTimeout(() => refresh({ quiet: true }), 8000);
    } catch (err) {
      message(err.message, true);
    } finally {
      sendNow.disabled = false;
    }
  });
  const remove = el("button", { type: "button", className: "quiet", textContent: "Remove" });
  remove.addEventListener("click", () => {
    state.subs.splice(i, 1);
    render();
    message("Removed. Save changes to stop these emails.");
  });
  const field = (label, forId, ...input) => el("div", { className: "ntf-field" }, el("label", { htmlFor: forId, textContent: label }), ...input);
  return el("fieldset", { className: "ntf-card ntf-sub" },
    el("legend", { textContent: sub.label || sub.station }),
    field("Station (GHCN-Daily ID or place)", id("station"), stationIn, stationName),
    field("Delivery", id("delivery"), delivery),
    field("Email addresses (separate with commas)", id("to"), to),
    field("GitHub accounts to notify (GitHub emails them a copy)", id("github"), ghUsers),
    el("div", { className: "ntf-row" }, field("Time", id("time"), time), field("Time zone", id("tz"), tz)),
    days,
    el("div", { className: "ntf-opts" }, toggle("enabled", "On"), toggle("ai", "AI-written text"), toggle("pdf", "Attach the full almanac as a PDF")),
    el("p", { className: "fine" }, ...[deliveryLine(sub)].flat()),
    el("div", { className: "ntf-actions" }, sendNow, remove));
}

function validate(subs) {
  for (const s of subs) {
    const name = s.label || s.station;
    if (!STATION.test(s.station)) return `${name}: the station must be a GHCN-Daily ID such as USC00118740.`;
    if (s.delivery === "email" && !s.to.length) return `${name}: add at least one email address.`;
    if (s.delivery === "github" && !s.github.length) return `${name}: add at least one GitHub account.`;
    if (s.delivery === "auto" && !s.to.length && !s.github.length) return `${name}: add an email address or a GitHub account.`;
    const badUser = s.github.find((u) => !GH_USER.test(u));
    if (badUser) return `${name}: "${badUser}" is not a GitHub username.`;
    const bad = s.to.find((a) => !EMAIL.test(a));
    if (bad) return `${name}: "${bad}" is not an email address.`;
    if (!/^\d{2}:\d{2}$/.test(s.time)) return `${name}: set a time.`;
    if (!s.days.length) return `${name}: pick at least one day.`;
  }
  return null;
}

async function save(btn) {
  const err = validate(state.subs);
  if (err) return message(err, true);
  btn.disabled = true;
  message("Saving");
  try {
    const cfg = JSON.stringify({ version: 1, updated: new Date().toISOString(), subscriptions: state.subs });
    await putSecret("NOTIFY_CONFIG", cfg);
    await putVariable("NOTIFY_CONFIG", cfg);
    state.saved = JSON.parse(cfg);
    render();
    message("Saved. The next run (within 15 minutes) uses these settings.");
  } catch (e) {
    message(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

// Subscription ids key the delivery log, so they are fixed once saved.
function newId(station, self = null) {
  const slug = station.toLowerCase();
  let n = 1;
  while (state.subs.some((s) => s !== self && s.id === `${slug}-${n}`)) n++;
  return `${slug}-${n}`;
}

function addSubscription(st = null) {
  const base = st?.id || "USC00118740";
  const first = state.subs[0];
  state.subs.push({
    id: newId(base), station: base, label: st ? `${st.name}${st.state ? `, ${st.state}` : ""}` : "",
    to: first ? [...first.to] : [], time: "09:00", timezone: first?.timezone || "America/Chicago",
    days: [...DAYS], enabled: true, ai: true, pdf: true,
    delivery: first?.delivery || "auto", github: first ? [...(first.github || [])] : [REPO.split("/")[0]],
  });
}

const PRESETS = {
  gmail: { SMTP_HOST: "smtp.gmail.com", SMTP_PORT: "587", note: "Gmail: turn on 2-Step Verification, then create an app password (myaccount.google.com/apppasswords) and use it as the password. The username is the Gmail address." },
  outlook: { SMTP_HOST: "smtp.office365.com", SMTP_PORT: "587", note: "Microsoft 365: works only if your organization allows SMTP sign-in for the account (many, including Illinois, turn it off)." },
  other: { note: "Any mail server or email service with SMTP (SendGrid, Mailgun, Amazon SES, Resend…). Port 587 uses STARTTLS; 465 uses TLS." },
};

function mailSection() {
  const have = (n) => state.secrets?.has(n);
  const inputs = {};
  const mk = (name, label, props = {}) => {
    inputs[name] = el("input", { id: `ntf-${name}`, autocomplete: "off", spellcheck: false,
      placeholder: have(name) ? "Saved (leave empty to keep)" : "", ...props });
    return el("div", { className: "ntf-field" }, el("label", { htmlFor: `ntf-${name}`, textContent: label }), inputs[name]);
  };
  const note = el("p", { className: "fine" });
  const preset = el("select", { id: "ntf-preset" },
    el("option", { value: "gmail", textContent: "Gmail (app password)" }),
    el("option", { value: "outlook", textContent: "Microsoft 365 / Outlook" }),
    el("option", { value: "other", textContent: "Other SMTP server" }));
  const applyPreset = (fill) => {
    const p = PRESETS[preset.value];
    note.textContent = p.note;
    if (fill) for (const k of ["SMTP_HOST", "SMTP_PORT"]) if (p[k]) inputs[k].value = p[k];
  };
  preset.addEventListener("change", () => applyPreset(true));
  const fields = [mk("SMTP_HOST", "Server"), mk("SMTP_PORT", "Port", { inputMode: "numeric" }),
    mk("SMTP_USERNAME", "Username"), mk("SMTP_PASSWORD", "Password", { type: "password" }),
    mk("MAIL_FROM", "From (for example: Climate at a glance <you@gmail.com>)")];
  applyPreset(!have("SMTP_HOST"));
  const btn = el("button", { type: "button", className: "primary", textContent: "Save mail settings" });
  btn.addEventListener("click", async () => {
    const changes = Object.entries(inputs).map(([k, v]) => [k, v.value.trim()]).filter(([, v]) => v);
    if (!changes.length) return message("Nothing to save: fill in the fields to change.");
    const port = changes.find(([k]) => k === "SMTP_PORT");
    if (port && !/^\d+$/.test(port[1])) return message("The port must be a number (587 or 465).", true);
    btn.disabled = true;
    try {
      for (const [k, v] of changes) await putSecret(k, v);
      for (const [k] of changes) state.secrets.add(k);
      render();
      message(`Saved ${changes.map(([k]) => k).join(", ")}.`);
    } catch (e) {
      message(e.message, true);
    } finally {
      btn.disabled = false;
    }
  });
  const missing = MAIL_SECRETS.filter((n) => n !== "SMTP_USERNAME" && n !== "SMTP_PASSWORD" && !have(n));
  return el("section", { className: "ntf-card" },
    el("h2", { textContent: "Mail server" }),
    el("p", {}, missing.length
      ? `Not set up yet (missing ${missing.join(", ")}). Until a mail server is saved, the almanac goes out as a GitHub notification: a comment on the station's issue in ${REPO} that mentions the GitHub accounts above, which GitHub emails to them.`
      : "Set up. Saved values are not shown; fill in a field only to change it."),
    el("div", { className: "ntf-field" }, el("label", { htmlFor: "ntf-preset", textContent: "Provider" }), preset),
    note, ...fields, el("div", { className: "ntf-actions" }, btn));
}

function lumenSection() {
  const have = state.secrets?.has("LUMEN_API_KEY");
  const btn = el("button", { type: "button", className: have ? "quiet" : "primary", textContent: have ? "Replace the Lumen key" : "Connect Lumen" });
  btn.addEventListener("click", () => emailLumen.login());
  return el("section", { className: "ntf-card" },
    el("h2", { textContent: "AI-written text" }),
    el("p", {}, have
      ? "A Lumen key is saved, so the blue boxes in each email are written by the model. Revoking the key on your Lumen Profile page (it is named "
      : "Without a Lumen key the blue boxes show the page's plain summaries. Connect Lumen to create a key just for the daily email (named ",
      el("code", { textContent: `${CONFIG.keyName}-daily-email` }),
      have ? ") stops that, and the emails fall back to plain summaries." : ") and store it as a repository secret."),
    el("div", { className: "ntf-actions" }, btn));
}

function logSection() {
  const items = [];
  for (const r of state.runs || []) {
    items.push(el("li", {},
      el("a", { href: r.html_url, target: "_blank", rel: "noopener", textContent: fmtWhen(r.created_at) }),
      `: ${r.status === "completed" ? (r.conclusion === "success" ? "sent" : r.conclusion) : r.status}`));
  }
  return el("section", { className: "ntf-card" },
    el("h2", { textContent: "Recent sends" }),
    state.log?.subscriptions && Object.keys(state.log.subscriptions).length
      ? el("ul", { className: "ntf-log" }, Object.entries(state.log.subscriptions).map(([k, s]) =>
        el("li", {}, `${s.station || k}: `, s.last_sent ? `last daily email ${fmtWhen(s.last_sent_at)}` : "no daily email yet",
          s.status?.startsWith("failed") ? `; last attempt ${s.status}` : "")))
      : el("p", { className: "fine", textContent: "No daily emails sent yet." }),
    items.length ? el("h3", { textContent: "Sent on request" }) : null,
    items.length ? el("ul", { className: "ntf-log" }, items) : null,
    el("p", { className: "fine" },
      el("a", { href: `https://github.com/${REPO}/actions/workflows/${WORKFLOW}`, target: "_blank", rel: "noopener", textContent: "All runs on GitHub" }),
      " (addresses are hidden in the logs)."));
}

function render(loading = null) {
  if (!root) return;
  msgNode = el("p", { className: "ntf-msg", role: "status", ariaLive: "polite", hidden: true });
  const parts = [
    el("h1", { textContent: "Daily email" }),
    el("p", {}, "Each morning a scheduled job opens the Climate at a glance page for a station and emails it: the text, tables and charts in the message and the full page as a PDF. It runs on GitHub Actions, so it sends whether or not anyone has this page open, and arrives within about 15 minutes of the time set. With no mail server set up, it posts the almanac to a GitHub issue and mentions your GitHub account, so GitHub emails it to you (from notifications@github.com, to your GitHub notification address)."),
  ];
  if (loading) {
    parts.push(el("p", { className: "fine", textContent: `${loading}…` }));
  } else {
    parts.push(tokenSection());
    if (state.token && state.subs) {
      const saveBtn = el("button", { type: "button", className: "primary", textContent: "Save changes" });
      saveBtn.addEventListener("click", () => save(saveBtn));
      const addBtn = el("button", { type: "button", className: "quiet", textContent: "Add a station" });
      addBtn.addEventListener("click", () => { addSubscription(); render(); });
      parts.push(
        el("h2", { className: "ntf-h", textContent: "Stations and recipients" }),
        state.saved ? null : el("p", { className: "fine", textContent: "Not saved yet: until you save, the job sends the default below (Champaign 3S at 9:00 a.m. Central to snesbitt@illinois.edu)." }),
        ...state.subs.map(subCard),
        state.subs.length ? null : el("p", { className: "fine", textContent: "No stations: saving this sends no email." }),
        el("div", { className: "ntf-actions" }, saveBtn, addBtn),
        mailSection(),
        lumenSection());
    }
    parts.push(logSection(), msgNode);
  }
  root.replaceChildren(...parts.filter(Boolean));
}

// ---------------------------------------------------------------------------
// The Lumen key for the email: Lumen redirects back here with ?code=…

let lumenKeyWaiting = false;

export function isEmailLumenRedirect() {
  try { return !!sessionStorage.getItem("lumen-email-key:pending"); } catch { return false; }
}

export async function handleEmailLumenRedirect() {
  await emailLumen.handleRedirect();
  lumenKeyWaiting = true;
}

async function finishLumenKey() {
  const key = emailLumen.getKey();
  if (!key) return;
  if (!state.token || !state.secrets) {
    if (lumenKeyWaiting) message("Lumen key created. Connect your GitHub token to store it for the daily email.");
    return;
  }
  try {
    await putSecret("LUMEN_API_KEY", key);
    state.secrets.add("LUMEN_API_KEY");
    emailLumen.logout(); // the browser does not need it; it lives in the repository secret now
    lumenKeyWaiting = false;
    render();
    message("Lumen key saved for the daily email.");
  } catch (err) {
    message(err.message, true);
  }
}

// ---------------------------------------------------------------------------

export function initNotify(d) {
  deps = d;
  root = d.root;
  state.token = store.get();
}

export async function showNotify() {
  if (!state.loaded) await refresh();
  else await refresh({ quiet: true });
}

// "Email this almanac daily" from the almanac tab.
export function addStationFromAlmanac(st) {
  if (state.subs) {
    const have = state.subs.some((s) => s.station === st.id);
    if (!have) addSubscription(st);
    render();
    message(have ? `${st.name} is already on the list.` : `Added ${st.name}. Set the recipients and time, then save.`);
  } else {
    pendingStation = st;
  }
}
