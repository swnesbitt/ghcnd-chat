// format.js — clean up model text before it is rendered as Markdown.
//
// Models often write inline LaTeX math ("$\le 35$ °F", "$-2.8^\circ$C") even
// when told not to, and the page renders plain Markdown, so it would show up
// raw. This turns the common commands into Unicode and drops the $ delimiters,
// touching only $…$ spans that contain a backslash command or a ^/_ script, so
// prices like "$5 and $10" are left alone.

const COMMANDS = {
  le: "≤", leq: "≤", leqslant: "≤", ge: "≥", geq: "≥", geqslant: "≥",
  lt: "<", gt: ">", ne: "≠", neq: "≠", approx: "≈", sim: "~", simeq: "≃",
  pm: "±", mp: "∓", times: "×", cdot: "·", div: "÷", degree: "°", circ: "°",
  to: "→", rightarrow: "→", leftarrow: "←", Rightarrow: "⇒", infty: "∞",
  Delta: "Δ", delta: "δ", mu: "μ", sigma: "σ", Sigma: "Σ", alpha: "α", beta: "β",
  gamma: "γ", lambda: "λ", rho: "ρ", theta: "θ", pi: "π", percent: "%",
};

function convertMath(body) {
  let s = body
    .replace(/\\text\{([^}]*)\}/g, "$1")
    .replace(/\\mathrm\{([^}]*)\}/g, "$1")
    .replace(/\^\{?\\circ\}?/g, "°") // ^\circ and ^{\circ}
    .replace(/\\%/g, "%")
    .replace(/\\,|\\;|\\!|\\ /g, " ")
    .replace(/\\([A-Za-z]+)/g, (m, name) => COMMANDS[name] ?? m)
    .replace(/\^\{([^}]*)\}|\^(\S)/g, (m, a, b) => toSuper(a ?? b))
    .replace(/_\{([^}]*)\}|_(\S)/g, (m, a, b) => a ?? b);
  return s.replace(/\s{2,}/g, " ").trim();
}

const SUPER = { 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹", "-": "⁻", "+": "⁺" };
const toSuper = (t) => [...t].map((c) => SUPER[c] ?? c).join("");

export function cleanModelText(text) {
  if (!text) return text;
  return text
    // $$…$$ and $…$ spans that are clearly math.
    .replace(/\$\$([^$]{1,200})\$\$/g, (m, body) => convertMath(body))
    .replace(/\$([^$\n]{1,120})\$/g, (m, body) => (/[\\^_]/.test(body) ? convertMath(body) : m))
    // \( … \) inline math.
    .replace(/\\\(([^)]{1,120})\\\)/g, (m, body) => convertMath(body))
    // Stray commands outside delimiters, e.g. "\le 35 °F".
    .replace(/\\(le|leq|ge|geq|ne|neq|approx|pm|times|circ|degree)\b/g, (m, name) => COMMANDS[name]);
}
