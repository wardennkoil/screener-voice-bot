import { escapeHtml } from "../local/page.js";

/**
 * The admin panel. Plain HTML + JS served inline (no build step), like the
 * laptop page. It reads the /admin/api endpoints: an overview across calls and,
 * per call, the transcript alongside measured stats and the AI analysis.
 * All transcript text is untrusted and goes through esc() before rendering.
 */
export function adminPageHtml(opts: { studyName: string; persona: string; model: string }): string {
  const cfg = JSON.stringify({ persona: opts.persona, model: opts.model }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Screener Call Analytics</title>
<style>
  :root {
    color-scheme: light;
    --page: #f9f9f7; --surface: #fcfcfb; --raised: #ffffff; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
    --grid: #e1e0d9; --axis: #c3c2b7; --line: rgba(11,11,11,0.10); --hover: rgba(11,11,11,0.04); --sel: rgba(42,120,214,0.10);
    --s1: #2a78d6; --s1-soft: #86b6ef; --pos: #2a78d6; --neg: #e34948; --mid: #b9b8b1;
    --good: #0ca30c; --good-ink: #006300; --warning: #fab219; --warning-ink: #8a5a00; --serious: #ec835a; --serious-ink: #a4461f; --critical: #d03b3b; --critical-ink: #b42323;
    --bot-bubble: #eef4fc; --person-bubble: #ffffff; --tool: #f3f2ee;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --page: #0d0d0d; --surface: #1a1a19; --raised: #20201f; --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
      --grid: #2c2c2a; --axis: #383835; --line: rgba(255,255,255,0.10); --hover: rgba(255,255,255,0.05); --sel: rgba(57,135,229,0.18);
      --s1: #3987e5; --s1-soft: #1c5cab; --pos: #3987e5; --neg: #e66767; --mid: #5d5d58;
      --good-ink: #0ca30c; --warning-ink: #fab219; --serious-ink: #ec835a; --critical-ink: #e66767;
      --bot-bubble: #1a2a3f; --person-bubble: #262625; --tool: #262625;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19; --raised: #20201f; --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --line: rgba(255,255,255,0.10); --hover: rgba(255,255,255,0.05); --sel: rgba(57,135,229,0.18);
    --s1: #3987e5; --s1-soft: #1c5cab; --pos: #3987e5; --neg: #e66767; --mid: #5d5d58;
    --good-ink: #0ca30c; --warning-ink: #fab219; --serious-ink: #ec835a; --critical-ink: #e66767;
    --bot-bubble: #1a2a3f; --person-bubble: #262625; --tool: #262625;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body { background: var(--page); color: var(--ink); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  button { font: inherit; color: inherit; }
  a { color: var(--s1); }
  .app { display: grid; grid-template-columns: 300px 1fr; grid-template-rows: auto 1fr; height: 100vh; }
  header { grid-column: 1 / -1; display: flex; align-items: center; gap: 16px; padding: 12px 20px; border-bottom: 1px solid var(--line); background: var(--surface); }
  header h1 { font-size: 16px; margin: 0; font-weight: 650; }
  header .study { color: var(--muted); font-size: 13px; }
  header .spacer { flex: 1; }
  .btn { padding: 6px 14px; border-radius: 8px; border: 1px solid var(--line); background: var(--raised); cursor: pointer; font-size: 13px; }
  .btn:hover { background: var(--hover); }
  .btn.primary { background: var(--s1); border-color: var(--s1); color: #fff; }
  .btn.primary:hover { filter: brightness(1.08); }
  .btn:disabled { opacity: .5; cursor: default; }
  .tag { font-size: 12px; color: var(--muted); border: 1px solid var(--line); border-radius: 6px; padding: 2px 8px; white-space: nowrap; }

  nav.rail { border-right: 1px solid var(--line); background: var(--surface); overflow-y: auto; }
  .rail-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px 8px; }
  .rail-head a { font-weight: 600; text-decoration: none; color: var(--ink); padding: 4px 8px; margin-left: -8px; border-radius: 6px; }
  .rail-head a.active { background: var(--sel); }
  .rail-head .count { color: var(--muted); font-size: 12px; }
  .call-item { display: block; padding: 10px 16px; border-top: 1px solid var(--line); text-decoration: none; color: inherit; }
  .call-item:hover { background: var(--hover); }
  .call-item.active { background: var(--sel); }
  .ci-top { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; }
  .ci-when { font-weight: 600; }
  .ci-dur { color: var(--muted); font-variant-numeric: tabular-nums; }
  .ci-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; align-items: center; }
  .ci-line { color: var(--muted); font-size: 12px; margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  main { overflow-y: auto; padding: 20px 24px 60px; }
  .chip { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--ink-2); background: var(--raised); white-space: nowrap; }
  .chip .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .chip.good { color: var(--good-ink); } .chip.good .dot { background: var(--good); }
  .chip.warning { color: var(--warning-ink); } .chip.warning .dot { background: var(--warning); }
  .chip.serious { color: var(--serious-ink); } .chip.serious .dot { background: var(--serious); }
  .chip.critical { color: var(--critical-ink); } .chip.critical .dot { background: var(--critical); }
  .chip.neutral .dot { background: var(--mid); }
  .chip.pos .dot { background: var(--pos); } .chip.neg .dot { background: var(--neg); } .chip.mid .dot { background: var(--mid); }
  .spin { width: 10px; height: 10px; border: 2px solid var(--line); border-top-color: var(--s1); border-radius: 50%; animation: spin 0.9s linear infinite; display: inline-block; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }

  h2 { font-size: 20px; margin: 0; font-weight: 650; }
  h3 { font-size: 13px; margin: 0 0 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 600; }
  .sub { color: var(--muted); }
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 16px; }
  .stack > * + * { margin-top: 16px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 16px 0; }
  .tile .v { font-size: 26px; font-weight: 650; line-height: 1.2; }
  .tile .l { color: var(--muted); font-size: 12px; }
  .tile .d { color: var(--ink-2); font-size: 12px; margin-top: 2px; }
  .grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 16px; }

  .bars { display: grid; grid-template-columns: minmax(90px, max-content) 1fr auto; gap: 6px 10px; align-items: center; font-size: 13px; }
  .bars .lab { color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bars .track { height: 14px; position: relative; }
  .bars .fill { position: absolute; left: 0; top: 0; bottom: 0; background: var(--s1); border-radius: 0 4px 4px 0; min-width: 2px; }
  .bars .fill.soft { background: var(--s1-soft); }
  .bars .val { font-variant-numeric: tabular-nums; color: var(--ink); text-align: right; white-space: nowrap; }
  .legend { display: flex; gap: 14px; font-size: 12px; color: var(--ink-2); margin-bottom: 10px; flex-wrap: wrap; }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
  .stackbar { display: flex; height: 16px; gap: 2px; margin: 4px 0 8px; }
  .stackbar > div { height: 100%; }
  .stackbar > div:first-child { border-radius: 4px 0 0 4px; } .stackbar > div:last-child { border-radius: 0 4px 4px 0; }
  .stackbar > div:only-child { border-radius: 4px; }

  .list { list-style: none; margin: 0; padding: 0; }
  .list li { padding: 8px 0; border-top: 1px solid var(--line); }
  .list li:first-child { border-top: 0; padding-top: 0; }
  .muted { color: var(--muted); }
  .small { font-size: 12px; }
  .empty { color: var(--muted); padding: 24px; text-align: center; }

  .detail-head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; margin-bottom: 16px; }
  .detail-head .grow { flex: 1; }
  .back { display: none; width: 100%; text-decoration: none; font-size: 13px; }
  .detail { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(320px, 1fr); gap: 16px; align-items: start; }
  .col { min-width: 0; }

  .chart { position: relative; }
  .chart svg { display: block; width: 100%; overflow: visible; }
  .chart .pt { cursor: pointer; }
  .tip { position: fixed; z-index: 10; pointer-events: none; max-width: 320px; background: var(--raised); color: var(--ink); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; font-size: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.14); display: none; }
  .tip b { font-weight: 600; }

  .turns { display: flex; flex-direction: column; gap: 10px; }
  .turn { display: grid; grid-template-columns: 44px 1fr; gap: 8px; scroll-margin-top: 80px; }
  .turn .t { color: var(--muted); font-size: 12px; padding-top: 8px; font-variant-numeric: tabular-nums; text-align: right; }
  .turn .body { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .turn.person .body { align-items: flex-end; }
  .bubble { max-width: 85%; padding: 8px 12px; border-radius: 12px; border: 1px solid var(--line); white-space: pre-wrap; overflow-wrap: anywhere; }
  .turn.assistant .bubble { background: var(--bot-bubble); border-top-left-radius: 4px; }
  .turn.person .bubble { background: var(--person-bubble); border-top-right-radius: 4px; }
  .who { font-size: 11px; color: var(--muted); display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .turn.person .who { justify-content: flex-end; }
  .turn.system .body { align-items: center; }
  .sysnote { font-size: 12px; color: var(--muted); font-style: italic; text-align: center; max-width: 90%; }
  .heard { font-size: 12px; color: var(--warning-ink); }
  .heard s { color: var(--muted); }
  .tools { display: flex; flex-wrap: wrap; gap: 4px; max-width: 85%; }
  .tool { font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--tool); border: 1px solid var(--line); border-radius: 6px; padding: 2px 6px; color: var(--ink-2); max-width: 100%; overflow-wrap: anywhere; }
  .tool.err { border-color: var(--critical); color: var(--critical-ink); }
  .turn.flagged .bubble, .turn.flagged .sysnote { box-shadow: 0 0 0 2px var(--flag, var(--warning)); }
  .turn.pulse .bubble { animation: pulse 1.4s ease-out 1; }
  @keyframes pulse { 0% { box-shadow: 0 0 0 6px var(--sel); } 100% { box-shadow: 0 0 0 0 transparent; } }
  .devnote { max-width: 85%; font-size: 12px; border-left: 3px solid var(--flag, var(--warning)); padding: 4px 8px; background: var(--hover); border-radius: 0 6px 6px 0; }
  .turn.person .devnote { align-self: flex-end; }

  .score { display: flex; align-items: baseline; gap: 6px; }
  .score .big { font-size: 30px; font-weight: 650; }
  .meter { display: grid; grid-template-columns: 90px 1fr 28px; gap: 8px; align-items: center; font-size: 13px; margin-top: 6px; }
  .meter .track { height: 8px; background: var(--grid); border-radius: 4px; overflow: hidden; }
  .meter .fill { height: 100%; background: var(--s1); border-radius: 4px; }
  .meter .n { text-align: right; font-variant-numeric: tabular-nums; }
  .dev[data-jump] { cursor: pointer; }
  .dev[data-jump]:hover { background: var(--hover); }
  .dev .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .dev .kind { font-weight: 600; }
  .dev .sugg { color: var(--ink-2); font-size: 12px; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; font-weight: 600; color: var(--muted); font-size: 12px; padding: 4px 6px; border-bottom: 1px solid var(--line); }
  td { padding: 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
  td.num { font-variant-numeric: tabular-nums; color: var(--ink-2); white-space: nowrap; }
  .kv { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; font-size: 13px; }
  .kv .k { color: var(--ink-2); } .kv .v { font-variant-numeric: tabular-nums; text-align: right; }
  .talk { display: flex; height: 10px; gap: 2px; margin: 6px 0 2px; }
  .talk div:first-child { background: var(--s1); border-radius: 4px 0 0 4px; } .talk div:last-child { background: var(--s1-soft); border-radius: 0 4px 4px 0; }
  .notice { padding: 10px 12px; border-radius: 8px; background: var(--hover); border: 1px solid var(--line); font-size: 13px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .jump { cursor: pointer; color: var(--s1); text-decoration: underline; text-underline-offset: 2px; background: none; border: 0; padding: 0; font-size: inherit; }

  @media (max-width: 1180px) { .detail { grid-template-columns: 1fr; } }
  @media (max-width: 800px) {
    .app { grid-template-columns: 1fr; grid-template-rows: auto auto 1fr; height: auto; min-height: 100vh; }
    header { flex-wrap: wrap; padding: 10px 16px; }
    nav.rail { border-right: 0; border-bottom: 1px solid var(--line); max-height: 40vh; }
    .app.showing-call nav.rail { display: none; }
    .back { display: block; }
    main { padding: 16px; overflow: visible; }
    .bubble, .tools, .devnote { max-width: 100%; }
    .grid2 { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<div class="app" id="app">
  <header>
    <h1>Call analytics</h1>
    <span class="study">${escapeHtml(opts.studyName)}</span>
    <span class="spacer"></span>
    <span class="tag" title="Model used for analysis">${escapeHtml(opts.model)}</span>
    <button class="btn" id="analyzeAll">Analyze all pending</button>
  </header>
  <nav class="rail" id="rail"><div class="empty">Loading…</div></nav>
  <main id="main"><div class="empty">Loading…</div></main>
</div>
<div class="tip" id="tip"></div>
<script>
const CFG = ${cfg};
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const state = { calls: [], route: { view: "overview" }, detail: null, overview: null, pollTimer: null };

const OUTCOME_TONE = { completed: "good", partial: "warning", callback_requested: "warning", declined: "serious", wrong_person: "neutral", voicemail: "neutral", no_response: "serious", hung_up: "serious", no_answer: "neutral", busy: "neutral", failed: "critical" };
const ELIGIBLE = { yes: ["good", "Eligible"], no: ["critical", "Not eligible"], undetermined: ["neutral", "Undetermined"] };
const KIND_LABEL = { person_question: "Person asked a question", off_topic: "Off-topic tangent", confusion: "Confusion", hesitation_or_objection: "Hesitation / objection", answer_changed: "Answer changed", bot_off_script: "Bot went off script", bot_reordered_or_skipped: "Reordered / skipped", bot_error: "Bot error", technical_issue: "Technical issue", other: "Other" };
const SEV_TONE = { high: "critical", medium: "serious", low: "warning" };
const SEV_VAR = { high: "var(--critical)", medium: "var(--serious)", low: "var(--warning)" };
const HANDLING = { well: ["good", "handled well"], adequate: ["neutral", "handled adequately"], poor: ["critical", "handled poorly"] };

function chip(tone, text, title) { return '<span class="chip ' + tone + '"' + (title ? ' title="' + esc(title) + '"' : "") + '><span class="dot"></span>' + esc(text) + "</span>"; }
function label(s) { return String(s || "").replace(/_/g, " "); }
function sentTone(score) { return score > 0.2 ? "pos" : score < -0.2 ? "neg" : "mid"; }
function sentColor(score) { return score > 0.2 ? "var(--pos)" : score < -0.2 ? "var(--neg)" : "var(--mid)"; }
function fmtScore(n) { return (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toFixed(2); }
function fmtDur(s) { s = Math.round(s || 0); const m = Math.floor(s / 60); return m ? m + "m " + String(s % 60).padStart(2, "0") + "s" : s + "s"; }
function fmtClock(s) { s = Math.round(s || 0); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }
function fmtWhen(iso) { const d = new Date(iso); return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + ", " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); }
function fmtMs(ms) { return ms == null ? "–" : ms >= 1000 ? (ms / 1000).toFixed(1) + " s" : Math.round(ms) + " ms"; }
function pct(n) { return Math.round(n * 100) + "%"; }

async function api(path, init) {
  const res = await fetch(path, { credentials: "same-origin", ...init });
  if (!res.ok) throw new Error((await res.text().catch(() => "")) || res.statusText);
  return res.json();
}

/* ---------- tooltip ---------- */
const tip = $("#tip");
function showTip(html, x, y) {
  tip.innerHTML = html; tip.style.display = "block";
  const r = tip.getBoundingClientRect();
  let left = x + 14, top = y + 14;
  if (left + r.width > innerWidth - 8) left = x - r.width - 14;
  if (top + r.height > innerHeight - 8) top = y - r.height - 14;
  tip.style.left = Math.max(8, left) + "px"; tip.style.top = Math.max(8, top) + "px";
}
function hideTip() { tip.style.display = "none"; }
document.addEventListener("mouseover", (e) => { const el = e.target.closest("[data-tip]"); if (el) showTip(el.dataset.tip, e.clientX, e.clientY); });
document.addEventListener("mousemove", (e) => { const el = e.target.closest("[data-tip]"); if (el) showTip(el.dataset.tip, e.clientX, e.clientY); else if (!e.target.closest("svg.sent")) hideTip(); });

/* ---------- routing ---------- */
function parseRoute() {
  const m = location.hash.match(/^#\\/call\\/([A-Za-z0-9_-]+)/);
  return m ? { view: "call", sid: m[1] } : { view: "overview" };
}
window.addEventListener("hashchange", () => { state.route = parseRoute(); render(); });

async function refreshList() {
  const { calls } = await api("/admin/api/calls");
  state.calls = calls;
  renderRail();
}

async function render() {
  $("#app").classList.toggle("showing-call", state.route.view === "call");
  renderRail();
  hideTip();
  if (state.route.view === "call") await loadCall(state.route.sid);
  else await loadOverview();
  schedulePoll();
}

function schedulePoll() {
  clearTimeout(state.pollTimer);
  const busy = (s) => s === "queued" || s === "running";
  const anyBusy = state.calls.some((c) => busy(c.analysisStatus)) || (state.detail && busy(state.detail.analysisStatus));
  if (!anyBusy) return;
  state.pollTimer = setTimeout(async () => {
    try {
      await refreshList();
      if (state.route.view === "call" && state.detail) {
        const d = await api("/admin/api/calls/" + state.route.sid);
        const prev = state.detail;
        const changed = d.analysisStatus !== prev.analysisStatus || (d.analysis ? d.analysis.createdAt : null) !== (prev.analysis ? prev.analysis.createdAt : null);
        if (d.sid === state.route.sid && prev.sid === d.sid && changed) { state.detail = d; renderCall(); }
      } else if (state.route.view === "overview") {
        state.overview = await api("/admin/api/overview"); renderOverview();
      }
    } catch {}
    schedulePoll();
  }, 3000);
}

/* ---------- rail ---------- */
function statusChip(c) {
  const s = c.analysisStatus;
  if (s === "queued" || s === "running") return '<span class="chip neutral"><span class="spin"></span>' + (s === "queued" ? "Queued" : "Analyzing") + "</span>";
  if (s === "error") return chip("critical", "Analysis failed");
  if (c.analysis) return chip(sentTone(c.analysis.sentimentScore), label(c.analysis.sentimentLabel), "Sentiment " + fmtScore(c.analysis.sentimentScore));
  return "";
}
function renderRail() {
  const rail = $("#rail");
  const active = state.route.view === "call" ? state.route.sid : null;
  const head = '<div class="rail-head"><a href="#/" class="' + (active ? "" : "active") + '">Overview</a><span class="count">' + state.calls.length + " calls</span></div>";
  if (!state.calls.length) { rail.innerHTML = head + '<div class="empty">No calls yet. Transcripts appear here after each call.</div>'; return; }
  rail.innerHTML = head + state.calls.map((c) => {
    const el = ELIGIBLE[c.eligible] || ELIGIBLE.undetermined;
    const dev = c.analysis && c.analysis.deviations ? '<span class="chip ' + (c.analysis.highSeverity ? "critical" : "neutral") + '" title="Deviations from the plan"><span class="dot"></span>' + c.analysis.deviations + " off-plan</span>" : "";
    return '<a class="call-item' + (c.sid === active ? " active" : "") + '" href="#/call/' + esc(c.sid) + '">' +
      '<div class="ci-top"><span class="ci-when">' + esc(fmtWhen(c.startedAt)) + '</span><span class="ci-dur">' + fmtDur(c.durationS) + "</span></div>" +
      '<div class="ci-meta">' + chip(OUTCOME_TONE[c.outcome] || "neutral", label(c.outcome)) + (c.eligible !== "undetermined" ? chip(el[0], el[1]) : "") + statusChip(c) + dev + "</div>" +
      '<div class="ci-line">' + esc(c.analysis ? c.analysis.summary : (c.firstPersonLine ? "“" + c.firstPersonLine + "”" : c.answered + "/" + c.required + " answers")) + "</div></a>";
  }).join("");
}

/* ---------- overview ---------- */
async function loadOverview() {
  if (!state.overview) $("#main").innerHTML = '<div class="empty">Loading overview…</div>';
  try { state.overview = await api("/admin/api/overview"); renderOverview(); }
  catch (err) { $("#main").innerHTML = '<div class="empty">Could not load: ' + esc(err.message) + "</div>"; }
}

function barRows(rows, max, opts = {}) {
  if (!rows.length) return '<div class="muted small">Nothing yet.</div>';
  return '<div class="bars">' + rows.map((r) => {
    const w = max ? (r.value / max) * 100 : 0;
    const soft = r.soft != null ? '<div class="fill soft" style="width:' + (max ? (r.soft / max) * 100 : 0) + '%"></div>' : "";
    return '<div class="lab" title="' + esc(r.label) + '">' + esc(r.label) + '</div><div class="track" data-tip="' + esc(r.tip || "") + '">' + soft + '<div class="fill" style="width:' + w + '%"></div></div><div class="val">' + esc(r.text ?? r.value) + "</div>";
  }).join("") + "</div>";
}

function renderOverview() {
  const o = state.overview;
  if (state.route.view !== "overview" || !o) return;
  if (!o.calls) { $("#main").innerHTML = '<div class="empty">No calls yet. Make a call from the laptop page at <a href="/local">/local</a> and it will show up here with its analysis.</div>'; return; }
  const completed = o.outcomes.completed || 0;
  const pending = state.calls.filter((c) => c.analysisStatus === "none" || c.analysisStatus === "stale").length;
  const tiles = [
    ["Calls", o.calls, o.analyzed + " analyzed"],
    ["Completed", pct(completed / o.calls), completed + " of " + o.calls],
    ["Eligible", o.eligible.yes || 0, (o.eligible.no || 0) + " not eligible"],
    ["Avg sentiment", o.avgSentiment == null ? "–" : fmtScore(o.avgSentiment), o.avgSentiment == null ? "needs analysis" : "−1 negative · +1 positive"],
    ["Plan adherence", o.avgAdherence == null ? "–" : o.avgAdherence, "out of 100"],
    ["Reply latency", fmtMs(o.medianLatencyMs), "median time to first word"],
  ];
  const outcomes = Object.entries(o.outcomes).sort((a, b) => b[1] - a[1]);
  const maxOutcome = Math.max(...outcomes.map((x) => x[1]));
  const funnelMax = o.calls;
  const sentOrder = [["positive", "var(--pos)"], ["mixed", "var(--mid)"], ["neutral", "var(--grid)"], ["negative", "var(--neg)"]];
  const sentTotal = sentOrder.reduce((n, [k]) => n + (o.sentimentLabels[k] || 0), 0);
  const kindMax = Math.max(0, ...o.deviationKinds.map((k) => k.count));

  $("#main").innerHTML =
    '<div class="detail-head"><div class="grow"><h2>Overview</h2><div class="sub">Every call ' + esc(CFG.persona) + ' has made, with patterns across them.</div></div>' +
    (pending ? '<span class="muted small">' + pending + " call" + (pending > 1 ? "s" : "") + " not analyzed yet</span>" : "") + "</div>" +
    '<div class="tiles">' + tiles.map(([l, v, d]) => '<div class="card tile"><div class="l">' + esc(l) + '</div><div class="v">' + esc(v) + '</div><div class="d">' + esc(d) + "</div></div>").join("") + "</div>" +
    '<div class="grid2">' +
      '<div class="card"><h3>Where calls get to</h3><div class="legend"><span><i style="background:var(--s1-soft)"></i>Reached</span><span><i style="background:var(--s1)"></i>Answered</span></div>' +
        barRows(o.funnel.map((f, i) => ({ label: (i + 1) + ". " + label(f.id), value: f.answered, soft: f.reached, text: f.answered + " / " + f.reached, tip: "<b>" + esc(label(f.id)) + "</b><br>Reached in " + f.reached + " of " + o.calls + " calls<br>Answered in " + f.answered })), funnelMax) + "</div>" +
      '<div class="card"><h3>Where conversations went off plan</h3>' +
        (o.analyzed ? barRows(o.deviationKinds.map((k) => ({ label: KIND_LABEL[k.kind] || label(k.kind), value: k.count, text: k.count + (k.high ? " · " + k.high + " high" : ""), tip: "<b>" + esc(KIND_LABEL[k.kind] || k.kind) + "</b><br>" + k.count + " times across calls" + (k.high ? "<br>" + k.high + " high severity" : "") })), kindMax) : '<div class="muted small">Run the analysis to see deviations.</div>') + "</div>" +
      '<div class="card"><h3>Outcomes</h3>' + barRows(outcomes.map(([k, v]) => ({ label: label(k), value: v, tip: "<b>" + esc(label(k)) + "</b><br>" + v + " call" + (v > 1 ? "s" : "") })), maxOutcome) + "</div>" +
      '<div class="card"><h3>Sentiment mix</h3>' + (sentTotal ?
        '<div class="stackbar">' + sentOrder.filter(([k]) => o.sentimentLabels[k]).map(([k, c]) => '<div style="flex:' + o.sentimentLabels[k] + ";background:" + c + '" data-tip="<b>' + k + "</b><br>" + o.sentimentLabels[k] + ' calls"></div>').join("") + "</div>" +
        '<div class="legend">' + sentOrder.map(([k, c]) => '<span><i style="background:' + c + '"></i>' + k + " " + (o.sentimentLabels[k] || 0) + "</span>").join("") + "</div>"
        : '<div class="muted small">Run the analysis to see sentiment.</div>') +
        '<div class="kv" style="margin-top:12px"><span class="k">Average call length</span><span class="v">' + fmtDur(o.avgDurationS) + '</span><span class="k">Average answers recorded</span><span class="v">' + o.avgAnswered + " / " + o.required + "</span></div></div>" +
    "</div>" +
    '<div class="grid2" style="margin-top:16px">' +
      '<div class="card"><h3>Needs attention</h3>' + (o.attention.length ? '<ul class="list">' + o.attention.slice(0, 12).map((a) => '<li><a href="#/call/' + esc(a.sid) + '">' + esc(fmtWhen(a.startedAt)) + '</a> <span class="muted">· ' + esc(a.reasons.join(" · ")) + "</span></li>").join("") + "</ul>" : '<div class="muted small">Nothing flagged.</div>') + "</div>" +
      '<div class="card"><h3>Doubtful answers</h3>' + (o.dataConcerns.length ? '<ul class="list">' + o.dataConcerns.map((d) => '<li><b>' + esc(label(d.questionId)) + '</b> <span class="muted">· ' + d.count + " call" + (d.count > 1 ? "s" : "") + "</span>" + d.examples.slice(0, 2).map((e) => '<div class="small">' + esc(e.concern) + ' <a href="#/call/' + esc(e.sid) + '">open</a></div>').join("") + "</li>").join("") + "</ul>" : '<div class="muted small">No recorded answers were questioned.</div>') + "</div>" +
    "</div>" +
    '<div class="card" style="margin-top:16px"><h3>Recommendations from recent calls</h3>' + (o.recommendations.length ? '<ul class="list">' + o.recommendations.slice(0, 12).map((r) => "<li>" + esc(r.text) + ' <a class="small" href="#/call/' + esc(r.sid) + '">from call</a></li>').join("") + "</ul>" : '<div class="muted small">Recommendations appear once calls are analyzed.</div>') + "</div>";
}

/* ---------- call detail ---------- */
async function loadCall(sid) {
  if (!state.detail || state.detail.sid !== sid) $("#main").innerHTML = '<div class="empty">Loading call…</div>';
  const current = () => state.route.view === "call" && state.route.sid === sid;
  try {
    const d = await api("/admin/api/calls/" + sid);
    if (!current()) return; // the user moved on while this was loading
    state.detail = d; renderCall();
  } catch (err) {
    if (!current()) return;
    state.detail = null; $("#main").innerHTML = '<div class="empty">Could not load this call: ' + esc(err.message) + "</div>";
  }
}

function toolsByTurn(d) {
  // Attach each tool call to the first bot turn at or after it (the reply it was made in).
  const bots = d.turns.filter((t) => t.role === "assistant");
  const map = new Map();
  for (const c of d.toolCalls) {
    const owner = bots.find((b) => b.at >= c.at) || bots[bots.length - 1];
    if (!owner) continue;
    if (!map.has(owner.index)) map.set(owner.index, []);
    map.get(owner.index).push(c);
  }
  return map;
}

function toolChip(c) {
  const r = c.result || {};
  const a = c.args || {};
  let text = c.name;
  if (c.name === "record_answer") text = "record " + a.question_id + " = " + JSON.stringify(a.value);
  else if (c.name === "skip_question") text = "skip " + a.question_id;
  else if (c.name === "confirm_identity") text = "identity: " + a.result;
  else if (c.name === "record_consent") text = "consent: " + (a.proceed ? "yes" : "no");
  else if (c.name === "end_call") text = "end call: " + a.reason;
  else if (c.name === "flag_for_human") text = "flag for human";
  const err = r.ok === false;
  const tipHtml = "<b>" + esc(c.name) + "</b><br>" + esc(JSON.stringify(a)) + (err ? '<br><span style="color:var(--critical-ink)">Error: ' + esc(r.error) + "</span>" : r.message ? "<br>" + esc(r.message) : "");
  return '<span class="tool' + (err ? " err" : "") + '" data-tip="' + esc(tipHtml) + '">' + (err ? "✕ " : "✓ ") + esc(text) + "</span>";
}

function renderCall() {
  const d = state.detail;
  if (!d || state.route.view !== "call" || d.sid !== state.route.sid) return;
  const a = d.analysis ? d.analysis.analysis : null;
  const s = d.stats;
  const el = ELIGIBLE[d.eligible] || ELIGIBLE.undetermined;
  const sentByTurn = new Map((a ? a.turn_sentiment : []).map((x) => [x.turn, x]));
  const devByTurn = new Map();
  (a ? a.deviations : []).forEach((dv, i) => { if (!devByTurn.has(dv.turn)) devByTurn.set(dv.turn, []); devByTurn.get(dv.turn).push({ ...dv, i }); });
  const tools = toolsByTurn(d);

  const head = '<div class="detail-head"><a class="back" href="#/">← All calls</a><div class="grow"><h2>' + esc(fmtWhen(d.startedAt)) + '</h2><div class="sub">' + esc(d.sid) + " · " + fmtDur(s.durationS) + " · " + s.requiredAnswered + "/" + s.required + " required answers</div></div>" +
    chip(OUTCOME_TONE[d.outcome] || "neutral", label(d.outcome)) + chip(el[0], el[1]) + analysisControl(d) + "</div>";

  const turnsHtml = d.turns.map((t) => {
    const devs = devByTurn.get(t.index) || [];
    const worst = devs.find((x) => x.severity === "high") || devs.find((x) => x.severity === "medium") || devs[0];
    const flagStyle = worst ? ' style="--flag:' + SEV_VAR[worst.severity] + '"' : "";
    const devHtml = devs.map((x) => '<div class="devnote"' + ' style="--flag:' + SEV_VAR[x.severity] + '"><b>' + esc(KIND_LABEL[x.kind] || x.kind) + "</b> · " + esc(x.severity) + " · " + esc((HANDLING[x.handling] || HANDLING.adequate)[1]) + "<br>" + esc(x.description) + "</div>").join("");
    const cls = "turn " + t.role + (devs.length ? " flagged" : "");
    const time = '<div class="t">' + fmtClock(t.offsetS) + "</div>";
    if (t.role === "system") return '<div class="' + cls + '" id="turn-' + t.index + '"' + flagStyle + ">" + time + '<div class="body"><div class="sysnote">' + esc(t.text) + "</div>" + devHtml + "</div></div>";
    const who = t.role === "assistant" ? esc(CFG.persona) + " (bot)" : "Person";
    const sent = sentByTurn.get(t.index);
    const sentChip = sent ? chip(sentTone(sent.score), sent.emotion || label(sentTone(sent.score)), "Sentiment " + fmtScore(sent.score)) : "";
    const note = t.note ? '<span class="muted" title="Phone-system note">' + esc(t.note) + "</span>" : "";
    const heard = t.interrupted ? '<div class="heard">Interrupted. Heard only: “' + esc(t.heard || "") + '”</div>' : "";
    const tl = tools.get(t.index);
    const toolHtml = tl ? '<div class="tools">' + tl.map(toolChip).join("") + "</div>" : "";
    return '<div class="' + cls + '" id="turn-' + t.index + '"' + flagStyle + ">" + time + '<div class="body"><div class="who">#' + t.index + " · " + who + sentChip + note + '</div><div class="bubble">' + esc(t.text) + "</div>" + heard + toolHtml + devHtml + "</div></div>";
  }).join("");

  const sentChart = a && a.turn_sentiment.length ? '<div class="card"><h3>Sentiment over the call</h3><div class="legend"><span><i style="background:var(--s1)"></i>Person sentiment</span><span><i style="background:var(--critical)"></i>Off-plan moment</span></div><div class="chart" id="sentChart"></div></div>' : "";

  $("#main").innerHTML = head + '<div class="detail"><div class="col stack">' + sentChart + '<div class="card"><h3>Transcript</h3><div class="turns">' + turnsHtml + '</div></div></div><div class="col stack">' + insights(d, a) + "</div></div>";
  if (a && a.turn_sentiment.length) drawSentiment(d, a);
}

function analysisControl(d) {
  const s = d.analysisStatus;
  if (s === "queued" || s === "running") return '<span class="chip neutral"><span class="spin"></span>' + (s === "queued" ? "Queued for analysis" : "Analyzing…") + "</span>";
  if (s === "too_short") return '<span class="muted small">Too short to analyze</span>';
  const labelText = d.analysis ? "Re-analyze" : "Analyze";
  return '<button class="btn' + (d.analysis ? "" : " primary") + '" data-action="analyze" data-sid="' + esc(d.sid) + '">' + labelText + "</button>";
}

function insights(d, a) {
  const s = d.stats;
  const blocks = [];
  if (d.analysisStatus === "error") blocks.push('<div class="notice">' + chip("critical", "Analysis failed") + '<span class="small">' + esc(d.analysisError) + "</span></div>");
  if (d.analysis && d.analysis.stale) blocks.push('<div class="notice">' + chip("warning", "Out of date") + '<span class="small">The transcript changed after this analysis. Re-analyze to refresh it.</span></div>');
  if (!a) {
    const msg = d.analysisStatus === "too_short" ? "This call is too short for an AI analysis. The measured stats are below." :
      d.analysisStatus === "queued" || d.analysisStatus === "running" ? "The AI analysis is on its way. This panel updates by itself." :
      "No AI analysis yet. Click Analyze to get sentiment, where the call went off plan, answer checks and recommendations.";
    blocks.push('<div class="card"><div class="muted">' + esc(msg) + "</div></div>");
  } else {
    const sTone = sentTone(a.sentiment.score);
    blocks.push('<div class="card"><h3>Summary</h3><p style="margin:0 0 12px">' + esc(a.summary) + '</p><div class="ci-meta">' +
      chip(sTone, label(a.sentiment.label) + " " + fmtScore(a.sentiment.score), a.sentiment.explanation) + chip("neutral", "trend: " + a.sentiment.trajectory) + chip("neutral", "engagement: " + a.engagement) +
      (a.ai_suspicion.detected ? chip("warning", "suspected a bot", a.ai_suspicion.evidence) : "") + "</div>" +
      (a.sentiment.explanation ? '<p class="small muted" style="margin:10px 0 0">' + esc(a.sentiment.explanation) + "</p>" : "") +
      (a.ai_suspicion.detected && a.ai_suspicion.evidence ? '<p class="small" style="margin:6px 0 0"><b>Bot suspicion:</b> ' + esc(a.ai_suspicion.evidence) + "</p>" : "") + "</div>");

    const q = a.bot_quality;
    blocks.push('<div class="card"><h3>Plan adherence &amp; bot quality</h3><div class="score"><span class="big">' + Math.round(a.adherence.score) + '</span><span class="muted">/ 100 plan adherence</span></div><p class="small muted" style="margin:4px 0 10px">' + esc(a.adherence.explanation) + "</p>" +
      [["Naturalness", q.naturalness], ["Empathy", q.empathy], ["Clarity", q.clarity], ["Efficiency", q.efficiency]].map(([k, v]) => '<div class="meter"><span>' + k + '</span><div class="track"><div class="fill" style="width:' + (v / 5) * 100 + '%"></div></div><span class="n">' + (+v).toFixed(1).replace(/\\.0$/, "") + "</span></div>").join("") +
      (q.issues.length ? '<ul class="list" style="margin-top:12px">' + q.issues.map((x) => "<li>" + jumpBtn(x.turn) + " " + esc(x.issue) + "</li>").join("") + "</ul>" : "") + "</div>");

    blocks.push('<div class="card"><h3>Where it went off plan (' + a.deviations.length + ")</h3>" + (a.deviations.length ? '<ul class="list">' + a.deviations.map((x) => {
      const h = HANDLING[x.handling] || HANDLING.adequate;
      const at = x.turn >= 0;
      return '<li class="dev"' + (at ? ' data-jump="' + x.turn + '"' : "") + '><div class="row"><span class="kind">' + esc(KIND_LABEL[x.kind] || x.kind) + "</span>" + chip(SEV_TONE[x.severity], x.severity) + chip(h[0], h[1]) + (at ? '<span class="muted small">#' + x.turn + "</span>" : "") + "</div><div>" + esc(x.description) + "</div>" + (x.suggestion ? '<div class="sugg">Fix: ' + esc(x.suggestion) + "</div>" : "") + "</li>";
    }).join("") + "</ul>" : '<div class="muted small">The call followed the plan.</div>') + "</div>");
  }

  // Planned vs actual questions, with the analyst's doubts next to the recorded value.
  const concerns = new Map((a ? a.data_quality : []).map((x) => [x.question_id, x]));
  blocks.push('<div class="card"><h3>Planned vs actual</h3><div style="overflow-x:auto"><table><thead><tr><th>Plan</th><th>Asked</th><th>Question</th><th>Recorded</th></tr></thead><tbody>' +
    s.coverage.map((c) => {
      const con = concerns.get(c.id);
      const val = c.status === "answered" ? esc(JSON.stringify(c.value)) : c.status === "skipped" ? '<span class="muted">skipped' + (c.skipReason ? ": " + esc(c.skipReason) : "") + "</span>" : '<span class="muted">not reached</span>';
      const order = c.actualPosition == null ? "–" : c.actualPosition + (c.outOfOrder ? " ↺" : "");
      return "<tr><td class=num>" + c.plannedPosition + "</td><td class=num" + (c.outOfOrder ? ' title="Asked ahead of a question planned before it"' : "") + ">" + order + "</td><td>" + esc(label(c.id)) + (c.followUp ? ' <span class="muted small">follow-up</span>' : "") +
        (c.verbatim ? '<div class="small muted">“' + esc(c.verbatim) + "”</div>" : "") + "</td><td>" + val +
        (con ? '<div style="margin-top:4px">' + chip(con.confidence === "low" ? "critical" : con.confidence === "medium" ? "warning" : "good", con.confidence + " confidence") + '</div><div class="small">' + esc(con.concern) + "</div>" : "") + "</td></tr>";
    }).join("") + "</tbody></table></div></div>");

  const total = s.personWords + s.assistantWords;
  blocks.push('<div class="card"><h3>Call mechanics</h3>' +
    '<div class="small">Talk time by words</div><div class="talk"><div style="flex:' + (s.personWords || 0.001) + '" data-tip="Person: ' + s.personWords + ' words"></div><div style="flex:' + (s.assistantWords || 0.001) + '" data-tip="Bot: ' + s.assistantWords + ' words heard"></div></div>' +
    '<div class="legend"><span><i style="background:var(--s1)"></i>Person ' + (total ? pct(s.personTalkShare) : "–") + '</span><span><i style="background:var(--s1-soft)"></i>Bot ' + (total ? pct(1 - s.personTalkShare) : "–") + "</span></div>" +
    '<div class="kv">' +
      kv("Reply latency, median", fmtMs(s.latency.p50Ms)) + kv("Reply latency, 90th pct", fmtMs(s.latency.p90Ms)) + kv("Slowest reply", fmtMs(s.latency.maxMs)) +
      kv("Interruptions", s.interruptions) + kv("Silence nudges", s.silenceNudges) + kv("Tool calls", s.toolCalls) + kv("Tool errors", s.toolErrors.length) + kv("Out-of-order answers", s.outOfOrder) +
    "</div>" +
    (s.toolErrors.length ? '<ul class="list" style="margin-top:10px">' + s.toolErrors.map((e) => '<li class="small"><b>' + esc(e.name) + "</b>: " + esc(e.error) + "</li>").join("") + "</ul>" : "") +
    (s.flags.length ? '<div style="margin-top:10px"><div class="small"><b>Flagged for the study team</b></div><ul class="list">' + s.flags.map((f) => '<li class="small">' + esc(f) + "</li>").join("") + "</ul></div>" : "") +
    (d.notes && d.notes.length ? '<div class="small muted" style="margin-top:8px">Notes: ' + esc(d.notes.join(" · ")) + "</div>" : "") + "</div>");

  if (a && a.key_moments.length) blocks.push('<div class="card"><h3>Key moments</h3><ul class="list">' + a.key_moments.map((m) => "<li>" + jumpBtn(m.turn) + " " + esc(m.note) + "</li>").join("") + "</ul></div>");
  if (a && a.recommendations.length) blocks.push('<div class="card"><h3>Recommendations</h3><ol style="margin:0;padding-left:20px">' + a.recommendations.map((r) => '<li style="margin-bottom:6px">' + esc(r) + "</li>").join("") + "</ol></div>");
  if (d.analysis) blocks.push('<div class="small muted">Analyzed ' + esc(fmtWhen(d.analysis.createdAt)) + " by " + esc(d.analysis.model) + "</div>");
  return blocks.join("");
}

function kv(k, v) { return '<span class="k">' + esc(k) + '</span><span class="v">' + esc(v) + "</span>"; }
function jumpBtn(turn) { return turn >= 0 ? '<button class="jump" data-jump="' + turn + '">#' + turn + "</button>" : ""; }

function jumpTo(turn) {
  const el = document.getElementById("turn-" + turn);
  if (!el) return;
  el.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
  el.classList.remove("pulse"); void el.offsetWidth; el.classList.add("pulse");
}

/* Sentiment line: person turns over call time, -1..+1 around a neutral baseline, off-plan moments marked on the time axis. */
function drawSentiment(d, a) {
  const host = $("#sentChart");
  if (!host) return;
  const W = Math.max(280, host.clientWidth), H = 170, L = 64, R = 12, T = 10, B = 40;
  const turnAt = new Map(d.turns.map((t) => [t.index, t]));
  const pts = a.turn_sentiment.map((s) => ({ ...s, t: turnAt.get(s.turn) })).filter((p) => p.t);
  const maxT = Math.max(d.stats.durationS, ...d.turns.map((t) => t.offsetS), 1);
  const x = (s) => L + (s / maxT) * (W - L - R);
  const y = (v) => T + ((1 - v) / 2) * (H - T - B);
  const step = [10, 15, 30, 60, 120, 300].find((s) => maxT / s <= 6) || 600;
  let g = "";
  [[1, "Positive"], [0, "Neutral"], [-1, "Negative"]].forEach(([v, name]) => {
    g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="' + (v === 0 ? "var(--axis)" : "var(--grid)") + '" stroke-width="1"' + (v === 0 ? "" : ' stroke-dasharray="2 3"') + "/>";
    g += '<text x="' + (L - 8) + '" y="' + (y(v) + 4) + '" text-anchor="end" font-size="11" fill="var(--muted)">' + name + "</text>";
  });
  for (let s = 0; s <= maxT; s += step) g += '<text x="' + x(s) + '" y="' + (H - B + 16) + '" text-anchor="middle" font-size="11" fill="var(--muted)" style="font-variant-numeric:tabular-nums">' + fmtClock(s) + "</text>";
  // Off-plan markers sit on a strip under the plot.
  const devs = a.deviations.map((dv) => ({ ...dv, t: turnAt.get(dv.turn) })).filter((dv) => dv.t);
  devs.forEach((dv) => {
    const cx = x(dv.t.offsetS), cy = H - 8;
    const tipHtml = "<b>" + esc(KIND_LABEL[dv.kind] || dv.kind) + "</b> · " + esc(dv.severity) + " · #" + dv.turn + "<br>" + esc(dv.description);
    g += '<g class="pt" data-jump="' + dv.turn + '" data-tip="' + esc(tipHtml) + '"><rect x="' + (cx - 8) + '" y="' + (cy - 10) + '" width="16" height="18" fill="transparent"/><path d="M' + cx + " " + (cy - 6) + " L" + (cx + 5) + " " + (cy + 3) + " L" + (cx - 5) + " " + (cy + 3) + ' Z" fill="' + SEV_VAR[dv.severity] + '" stroke="var(--surface)" stroke-width="1.5"/></g>';
  });
  if (pts.length > 1) g += '<path d="' + pts.map((p, i) => (i ? "L" : "M") + x(p.t.offsetS).toFixed(1) + " " + y(p.score).toFixed(1)).join(" ") + '" fill="none" stroke="var(--s1)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
  g += '<line id="xhair" y1="' + T + '" y2="' + (H - B) + '" stroke="var(--axis)" stroke-width="1" visibility="hidden"/>';
  pts.forEach((p) => {
    g += '<circle cx="' + x(p.t.offsetS) + '" cy="' + y(p.score) + '" r="4.5" fill="' + sentColor(p.score) + '" stroke="var(--surface)" stroke-width="2" pointer-events="none"/>';
  });
  host.innerHTML = '<svg class="sent" viewBox="0 0 ' + W + " " + H + '" height="' + H + '" role="img" aria-label="Person sentiment across the call">' + g + "</svg>";
  const svg = host.querySelector("svg"), xhair = svg.querySelector("#xhair");
  const nearest = (evt) => {
    const r = svg.getBoundingClientRect();
    const px = ((evt.clientX - r.left) / r.width) * W;
    let best = null, bd = Infinity;
    pts.forEach((p) => { const dd = Math.abs(x(p.t.offsetS) - px); if (dd < bd) { bd = dd; best = p; } });
    return bd < 40 ? best : null;
  };
  svg.addEventListener("mousemove", (e) => {
    if (e.target.closest("[data-tip]")) { xhair.setAttribute("visibility", "hidden"); return; }
    const p = nearest(e);
    if (!p) { xhair.setAttribute("visibility", "hidden"); hideTip(); return; }
    const px = x(p.t.offsetS);
    xhair.setAttribute("x1", px); xhair.setAttribute("x2", px); xhair.setAttribute("visibility", "visible");
    showTip("<b>#" + p.turn + " · " + esc(p.emotion || "") + "</b> " + fmtScore(p.score) + " · " + fmtClock(p.t.offsetS) + "<br>“" + esc(p.t.text.slice(0, 160)) + (p.t.text.length > 160 ? "…" : "") + "”", e.clientX, e.clientY);
  });
  svg.addEventListener("mouseleave", () => { xhair.setAttribute("visibility", "hidden"); hideTip(); });
  svg.addEventListener("click", (e) => { if (e.target.closest("[data-jump]")) return; const p = nearest(e); if (p) jumpTo(p.turn); });
}

let resizeTimer;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.route.view === "call" && state.detail && state.detail.analysis) drawSentiment(state.detail, state.detail.analysis.analysis); }, 150); });

/* ---------- actions ---------- */
document.addEventListener("click", async (e) => {
  const j = e.target.closest("[data-jump]");
  if (j) { jumpTo(+j.dataset.jump); return; }
  const btn = e.target.closest("[data-action=analyze]");
  if (btn) {
    btn.disabled = true;
    try {
      await api("/admin/api/calls/" + btn.dataset.sid + "/analyze", { method: "POST" });
      if (state.detail && state.detail.sid === btn.dataset.sid) { state.detail.analysisStatus = "queued"; renderCall(); }
      await refreshList(); schedulePoll();
    }
    catch (err) { btn.disabled = false; alert("Could not start the analysis: " + err.message); }
  }
});
$("#analyzeAll").addEventListener("click", async (e) => {
  const b = e.currentTarget; b.disabled = true;
  try {
    const { queued } = await api("/admin/api/analyze-pending", { method: "POST" });
    b.textContent = queued ? "Queued " + queued : "All analyzed";
    await refreshList();
    if (state.route.view === "call" && state.detail) await loadCall(state.route.sid);
    schedulePoll();
  } catch (err) { alert("Could not queue: " + err.message); }
  setTimeout(() => { b.disabled = false; b.textContent = "Analyze all pending"; }, 2500);
});

(async () => {
  state.route = parseRoute();
  try { await refreshList(); } catch (err) { $("#rail").innerHTML = '<div class="empty">' + esc(err.message) + "</div>"; }
  render();
})();
</script>
</body>
</html>`;
}
