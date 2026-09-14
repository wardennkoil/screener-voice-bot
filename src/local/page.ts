/**
 * The laptop test page. Plain HTML + JS, served inline so there is no build
 * step. Captures the microphone as 16-bit PCM, streams it to the server,
 * plays back the assistant's speech, and reports playback position so the
 * server knows exactly what was heard when you interrupt.
 */
export function localPageHtml(opts: { sampleRate: number; studyName: string; persona: string }): string {
  const cfg = JSON.stringify({ sampleRate: opts.sampleRate, persona: opts.persona });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Screener voice test</title>
<style>
  :root { --bg:#f6f5f1; --ink:#1d1c19; --muted:#6f6c64; --card:#fff; --accent:#0f766e; --warn:#b45309; --line:#e6e2d8; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
  main { max-width: 720px; margin: 0 auto; padding: 32px 20px 60px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: var(--muted); margin: 0 0 20px; }
  .bar { display:flex; align-items:center; gap:12px; margin-bottom:16px; flex-wrap: wrap; }
  button { font: inherit; padding: 10px 18px; border-radius: 999px; border: 1px solid var(--line); background: var(--card); cursor: pointer; }
  button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
  button:disabled { opacity: .5; cursor: default; }
  .pill { padding: 6px 12px; border-radius: 999px; font-size: 13px; background: #ecebe6; color: var(--muted); }
  .pill[data-state="listening"] { background: #dcfce7; color: #166534; }
  .pill[data-state="thinking"] { background: #fef3c7; color: #92400e; }
  .pill[data-state="speaking"] { background: #dbeafe; color: #1e40af; }
  .pill[data-state="ended"] { background: #fee2e2; color: #991b1b; }
  .log { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px 16px; min-height: 260px; }
  .turn { display: flex; gap: 10px; padding: 6px 0; border-bottom: 1px dashed var(--line); }
  .turn:last-child { border-bottom: 0; }
  .who { width: 56px; flex: none; color: var(--muted); font-size: 13px; padding-top: 2px; }
  .turn.partial .text { color: var(--muted); font-style: italic; }
  .turn.interrupted .text::after { content: " (interrupted)"; color: var(--warn); font-size: 12px; }
  .meta { margin-top: 12px; color: var(--muted); font-size: 13px; }
  .lat { font-variant-numeric: tabular-nums; }
  .note { margin-top: 20px; color: var(--muted); font-size: 13px; }
  .err { color: #991b1b; }
</style>
</head>
<body>
<main>
  <h1>Talk to ${escapeHtml(opts.persona)}</h1>
  <p class="sub">${escapeHtml(opts.studyName)} screener, running on your laptop. Answer the phone like a real person would.</p>
  <div class="bar">
    <label>Your first name <input id="name" value="Jordan" style="font: inherit; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; width: 120px;"></label>
    <button id="start" class="primary">Start call</button>
    <button id="hangup" disabled>Hang up</button>
    <span id="state" class="pill" data-state="idle">idle</span>
  </div>
  <div id="log" class="log"></div>
  <div class="meta">Last turn: <span id="lat" class="lat">—</span></div>
  <p class="note">Use headphones if you want to test interrupting mid-sentence; without them the speaker can leak into the mic. Say "Hello?" after clicking Start, as you would when picking up.</p>
</main>
<script>
const CFG = ${cfg};
const $ = (id) => document.getElementById(id);
const logEl = $("log"), stateEl = $("state"), latEl = $("lat");
let ws, audioCtx, micStream, workletNode, playing = { turn: 0, nextTime: 0, sources: [], startTime: 0, totalSec: 0 }, playedTimer, partialEl, assistantEl;

function setState(s) { stateEl.dataset.state = s; stateEl.textContent = s; }
function addTurn(role, text, cls) {
  const el = document.createElement("div"); el.className = "turn " + (cls || "");
  el.innerHTML = '<div class="who"></div><div class="text"></div>';
  el.querySelector(".who").textContent = role; el.querySelector(".text").textContent = text;
  logEl.appendChild(el); logEl.scrollTop = logEl.scrollHeight; return el;
}

const WORKLET = \`
class PcmCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Int16Array(${Math.round(opts.sampleRate * 0.08)}); this.i = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]; if (!ch) return true;
    for (let k = 0; k < ch.length; k++) {
      const s = Math.max(-1, Math.min(1, ch[k]));
      this.buf[this.i++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.i >= this.buf.length) { this.port.postMessage(this.buf.buffer.slice(0)); this.i = 0; }
    }
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);\`;

async function start() {
  $("start").disabled = true;
  setState("mic permission");
  try {
    audioCtx = new AudioContext({ sampleRate: CFG.sampleRate });
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    await audioCtx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" })));
    const src = audioCtx.createMediaStreamSource(micStream);
    workletNode = new AudioWorkletNode(audioCtx, "pcm-capture");
    src.connect(workletNode);
    workletNode.port.onmessage = (e) => { if (ws && ws.readyState === 1) ws.send(e.data); };
  } catch (err) {
    addTurn("error", "Microphone unavailable: " + err.message, "err"); $("start").disabled = false; setState("idle"); return;
  }
  setState("connecting");
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(proto + "://" + location.host + "/local-ws");
  ws.binaryType = "arraybuffer";
  ws.onopen = () => { ws.send(JSON.stringify({ type: "start", sampleRate: CFG.sampleRate, name: $("name").value })); $("hangup").disabled = false; setState("listening"); logEl.innerHTML = ""; };
  ws.onmessage = (e) => { if (e.data instanceof ArrayBuffer) onAudio(e.data); else onJson(JSON.parse(e.data)); };
  ws.onclose = () => { stopAll(); setState("ended"); $("start").disabled = false; $("hangup").disabled = true; };
  ws.onerror = () => addTurn("error", "connection error", "err");
}

function onJson(m) {
  if (m.type === "state") setState(m.state);
  else if (m.type === "turn") { beginTurn(m.id); assistantEl = null; }
  else if (m.type === "transcript") {
    if (m.role === "you") {
      if (!m.final) { if (!partialEl) partialEl = addTurn("you", m.text, "partial"); else partialEl.querySelector(".text").textContent = m.text; }
      else { if (partialEl) { partialEl.remove(); partialEl = null; } addTurn("you", m.text, ""); }
    } else {
      // One line per assistant turn, updated as the words stream in.
      if (!assistantEl) assistantEl = addTurn(m.role, m.text, "");
      else assistantEl.querySelector(".text").textContent = m.text;
      if (m.interrupted) assistantEl.classList.add("interrupted");
      if (m.final) assistantEl = null;
      logEl.scrollTop = logEl.scrollHeight;
    }
  }
  else if (m.type === "clear") { clearPlayback(m.turn); }
  else if (m.type === "latency") { latEl.textContent = (m.eotDelayMs != null ? "turn detected " + m.eotDelayMs + " ms after your last word · " : "") + "first token " + m.firstTokenMs + " ms · first audio " + m.firstAudioMs + " ms"; }
  else if (m.type === "end") { addTurn("system", "Call ended (" + m.reason + ")"); stopAll(); }
  else if (m.type === "error") { addTurn("error", m.message, "err"); }
}

function beginTurn(id) {
  playing.turn = id; playing.sources = []; playing.startTime = 0; playing.totalSec = 0; playing.nextTime = 0;
}

function onAudio(buf) {
  const view = new DataView(buf);
  const turn = view.getUint32(0, true);
  if (turn !== playing.turn) return; // stale audio after an interruption
  const pcm = new Int16Array(buf, 4);
  const ab = audioCtx.createBuffer(1, pcm.length, CFG.sampleRate);
  const ch = ab.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
  const src = audioCtx.createBufferSource(); src.buffer = ab; src.connect(audioCtx.destination);
  const now = audioCtx.currentTime;
  if (playing.nextTime < now) { playing.nextTime = now + 0.02; }
  if (!playing.startTime) { playing.startTime = playing.nextTime; startPlayedReports(); }
  src.start(playing.nextTime);
  playing.nextTime += ab.duration; playing.totalSec += ab.duration;
  playing.sources.push(src);
  src.onended = () => { playing.sources = playing.sources.filter((s) => s !== src); };
}

function playedMs() {
  if (!playing.startTime) return 0;
  return Math.max(0, Math.min(playing.totalSec, audioCtx.currentTime - playing.startTime)) * 1000;
}

function startPlayedReports() {
  clearInterval(playedTimer);
  playedTimer = setInterval(() => {
    if (!ws || ws.readyState !== 1) return;
    const ms = playedMs();
    ws.send(JSON.stringify({ type: "played", turn: playing.turn, ms: Math.round(ms) }));
    if (playing.startTime && audioCtx.currentTime >= playing.nextTime && playing.sources.length === 0) {
      ws.send(JSON.stringify({ type: "playback_done", turn: playing.turn, ms: Math.round(ms) }));
      clearInterval(playedTimer);
    }
  }, 200);
}

function clearPlayback(turn) {
  const ms = playedMs();
  for (const s of playing.sources) { try { s.stop(); } catch (e) {} }
  playing.sources = [];
  clearInterval(playedTimer);
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "played", turn: playing.turn, ms: Math.round(ms), cleared: true }));
  playing.turn = -1;
}

function stopAll() {
  clearInterval(playedTimer);
  for (const s of playing.sources) { try { s.stop(); } catch (e) {} }
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  if (audioCtx && audioCtx.state !== "closed") audioCtx.close();
}

$("start").onclick = start;
$("hangup").onclick = () => { if (ws) { ws.send(JSON.stringify({ type: "hangup" })); ws.close(); } };
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
