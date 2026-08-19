/**
 * Sourcing Agent side panel — the conversation surface.
 *
 * Standalone product: paste a role or a JD and the agent drives LinkedIn/SEEK
 * in its own hidden tab. Your own DeepSeek key lives in this browser.
 *
 * ESCAPING: every string rendered here — candidate names, headlines, the
 * agent's own summary of pages it read — ultimately originates on LinkedIn and
 * is attacker-controlled. Everything goes through textContent. Never introduce
 * innerHTML here.
 */




// Classic script, no imports. sidepanel.js was briefly a module and the whole
// panel went dead: an extension-page module that cannot resolve an import runs
// nothing and reports nothing, so every button silently stopped working.
// panel-lib.js is loaded as a plain script before this one.
const { createAgentLoop, createDiagnostic, buildReport, record, installErrorCapture } = window.RM || {};
const BRAND = window.BRAND || {};
const SA = window.SA || null;

// Rebrand at load: header name + document title come from brand.js (single source of truth).
(function initBrand() {
  try {
    const bn = document.getElementById("brand-name");
    if (bn && BRAND.name) bn.textContent = BRAND.name;
    if (BRAND.name) document.title = BRAND.name;
  } catch { /* ignore */ }
})();

if (!window.RM) {
  document.getElementById("boot-error").style.display = "block";
  document.getElementById("boot-error").textContent =
    "panel-lib.js did not load, so nothing on this page will work. Reinstall the extension.";
}

installErrorCapture("panel");
void record.note(`panel opened v${chrome.runtime.getManifest().version}`);

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = String(text);
  return n;
}

const thread = $("thread");
let renderedSteps = 0;
let renderedWarnings = 0;
let traceEl = null;

function scrollDown() {
  thread.scrollTop = thread.scrollHeight;
}

function dropEmptyState() {
  const e = $("empty");
  if (e) e.remove();
}

function addUser(text) {
  dropEmptyState();
  const m = el("div", "msg user");
  // A pasted JD is long; show enough to identify the ask without burying the
  // conversation under a wall of someone else's text.
  const shown = text.length > 400 ? `${text.slice(0, 400)}…` : text;
  m.appendChild(el("div", "bubble", shown));
  thread.appendChild(m);
  scrollDown();
}

let workingLine = null;
let workingSince = 0;
let workingLabel = "";
let ticker = null;

function humanSecs(ms) {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, "0")}s`;
}

/**
 * Tick the elapsed time locally.
 *
 * The panel only updated when the runner emitted an event, and a model call can
 * run for a minute with nothing to emit — so it sat on "Thinking…" looking
 * hung. A local ticker proves it is alive and shows how long the current step
 * has actually taken.
 */
let lastProgressAt = 0;
let stallWarned = false;

function startTicker() {
  stopTicker();
  lastProgressAt = Date.now();
  stallWarned = false;
  ticker = setInterval(() => {
    if (!workingLine) return;
    workingLine.textContent = `${workingLabel} · ${humanSecs(Date.now() - workingSince)}`;
    // A step that has not moved in 90s is stuck, not slow. Say so, and say what
    // to do about it, rather than letting the clock tick to four minutes.
    if (!stallWarned && Date.now() - lastProgressAt > 90_000) {
      stallWarned = true;
      thread.appendChild(
        el("div", "banner warn", "No progress for 90 seconds — this looks stuck rather than slow. Log below:"),
      );
      showLog();
      scrollDown();
    }
  }, 1000);
}

function stopTicker() {
  if (ticker) clearInterval(ticker);
  ticker = null;
}

function setWorking(label) {
  if (label !== workingLabel) {
    workingLabel = label;
    workingSince = Date.now();
  }
  if (workingLine) workingLine.textContent = `${workingLabel} · ${humanSecs(Date.now() - workingSince)}`;
}

function startTrace() {
  finished = false;
  renderedSteps = 0;
  renderedWarnings = 0;
  traceEl = el("div", "trace");
  const working = el("div", "working");
  working.appendChild(el("div", "spin"));
  workingLine = el("span", null, "Starting…");
  working.appendChild(workingLine);
  traceEl.appendChild(working);
  thread.appendChild(traceEl);
  workingLabel = "";
  setWorking("Starting");
  startTicker();
  scrollDown();
}

function friendlyTool(t) {
  switch (t) {
    case "get_page_state": return "Looking at the page";
    case "goto": return "Going to a page";
    case "click": return "Clicking";
    case "type": return "Typing";
    case "press": return "Pressing a key";
    case "set_location_filter": return "Setting the location filter";
    case "open_profile": return "Reading profile";
    case "get_page_text": return "Reading page";
    case "scroll_page": return "Scrolling for more";
    default: return t || "Working";
  }
}

/**
 * Render the live trace of tool calls into the panel.
 *
 * The runner emits a snapshot on every step (and on re-open of the panel we
 * replay the cached state), so this is called many times per run. It must be
 * idempotent: `renderedSteps` tracks how many trace entries have already been
 * painted, and only NEW ones are appended above the working line. Everything
 * goes through textContent — trace details originate on LinkedIn, which is
 * attacker-controlled.
 */
function renderTrace(snapshot) {
  if (!traceEl) return;
  const trace = snapshot.trace || [];
  // Paint any steps that have appeared since the last render.
  while (renderedSteps < trace.length) {
    const entry = trace[renderedSteps];
    renderedSteps += 1;
    const s = el("div", "step");
    s.appendChild(el("span", "dot"));
    s.appendChild(el("span", "tool", friendlyTool(entry.tool)));
    if (entry.detail) {
      s.appendChild(document.createTextNode(" "));
      s.appendChild(el("span", null, entry.detail));
    }
    // The working line (spinner + elapsed time) is always the last child.
    traceEl.insertBefore(s, traceEl.lastChild);
  }
  // Render any new warnings inline, as they occur — not deferred to the end.
  // This is why the location-filter warning used to appear after "Ranking":
  // it was stored in state.warnings and only painted by finishTrace().
  const warnings = snapshot.warnings || [];
  while (renderedWarnings < warnings.length) {
    const w = warnings[renderedWarnings];
    renderedWarnings += 1;
    thread.appendChild(el("div", "banner warn", w));
  }
  // Keep the ticking working line describing the CURRENT step.
  const last = trace[trace.length - 1];
  if (last) setWorking(friendlyTool(last.tool));
  scrollDown();
}

let finished = false;

function finishTrace(snapshot) {
  // The loop emits a final snapshot AND the run() promise resolves with one, so
  // this used to render "Stopped: ..." twice. Once per run is enough.
  if (finished) return;
  finished = true;
  stopTicker();
  workingLine = null;
  if (traceEl) {
    const working = traceEl.lastChild;
    if (working && working.className === "working") working.remove();
    if (!traceEl.childNodes.length) traceEl.remove();
    traceEl = null;
  }
  for (let i = renderedWarnings; i < (snapshot.warnings || []).length; i++)
    thread.appendChild(el("div", "banner warn", snapshot.warnings[i]));
  if (snapshot.halted) thread.appendChild(el("div", "banner bad", `Stopped: ${snapshot.halted}`));
  if (snapshot.answer) {
    const m = el("div", "msg agent");
    m.appendChild(el("div", "bubble", snapshot.answer));
    thread.appendChild(m);
  }
  scrollDown();
}

// ── Sending ──────────────────────────────────────────────────────────────────

/** Held open for the duration of a hunt — see the keep-alive note in background.js. */
let keepAlive = null;

function setRunning(running) {
  if (running && !keepAlive) {
    keepAlive = chrome.runtime.connect({ name: "recruitme-hunt" });
  } else if (!running && keepAlive) {
    keepAlive.disconnect();
    keepAlive = null;
  }
  $("send").disabled = running;
  $("stop").hidden = !running;
  $("ask").disabled = running;
  // The Continue button is governed by the last snapshot's canContinue, not by
  // `running` — updated in finishTrace() when the run settles.
}

function setContinue(canContinue) {
  const btn = $("continue");
  if (!btn) return;
  btn.hidden = !canContinue;
}

function autoGrow() {
  const t = $("ask");
  t.style.height = "auto";
  t.style.height = `${Math.min(t.scrollHeight, 180)}px`;
}

/**
 * The agent runs HERE, in the panel.
 *
 * It used to live in the service worker and be driven by messages. Every one of
 * those messages could go unanswered — and did: the panel sat on "Starting" for
 * minutes, and even the log request came back with nothing, because a reply
 * that never arrives looks exactly like a slow one.
 *
 * A side panel is a real document. It has a normal event loop that is not torn
 * down, direct access to chrome.tabs and fetch, and it is open for the whole
 * run by definition — the user is watching it. Running the agent here removes
 * the worker, the messaging, and the cached-state deadlock in one go.
 *
 * The engine is the agentic loop (Claude-in-Chrome shape, minus vision): the
 * model reads a structural snapshot of the page and acts by ref — look, then
 * click / type / press — so it recovers from a redesign the way a human would.
 */
const runner = createAgentLoop({
  getApiKey: async () => (await chrome.storage.local.get("deepseekKey")).deepseekKey || "",
  onProgress: (snapshot) => {
    if (snapshot.running) {
      lastProgressAt = Date.now();
      renderTrace(snapshot);
      const bits = [];
      if (snapshot.found) bits.push(`${snapshot.found} opened`);
      if (snapshot.read) bits.push(`${snapshot.read} read`);
      if ($("hint")) $("hint").textContent = bits.join(" · ") || "agent working";
    } else {
      finishTrace(snapshot);
      setRunning(false);
      setContinue(Boolean(snapshot.canContinue));
    }
  },
  tabs: chrome.tabs,
  now: () => Date.now(),
});

function readPlatforms() {
  return {
    linkedin: $("platform-linkedin")?.checked ?? true,
    seek: $("platform-seek")?.checked ?? true,
  };
}

/**
 * Entitlement gate before each hunt. When the billing backend is reachable it
 * is authoritative; otherwise a local trial applies (bounded by BRAND.freeTier)
 * so the tool is usable in development.
 */
async function gateHunt() {
  if (!SA || !BRAND.freeTierEnabled) return true;
  let g;
  try { g = await SA.requireRun(); } catch { return true; }
  if (g.allowed) return true;

  dropEmptyState();
  const m = el("div", "msg agent");
  m.appendChild(el("div", "bubble", g.message || "You've reached your free tier."));
  const btn = el("button", "ghost", "Subscribe");
  btn.style.marginTop = "8px";
  btn.addEventListener("click", async () => {
    try {
      const s = await SA.subscribe();
      if (s && s.url) return chrome.tabs.create({ url: s.url });
      thread.appendChild(el("div", "banner warn", "No checkout URL returned."));
    } catch (err) {
      thread.appendChild(el("div", "banner warn", `Could not start checkout: ${err?.message || err}`));
    }
  });
  m.appendChild(btn);
  thread.appendChild(m);
  scrollDown();
  return false;
}

async function send() {
  const typed = $("ask").value.trim();
  const location = $("location")?.value.trim() || "";
  const platforms = readPlatforms();
  const docs = attached.map((a) => `--- ${a.name} ---\n${a.text}`).join("\n\n");
  const instruction = docs ? `${typed}\n\n${docs}`.trim() : typed;
  if (!instruction) return;

  // Entitlement gate (free tier mirrored client-side; server is the real ledger).
  if (!(await gateHunt())) return;

  addUser(typed || `Attached: ${attached.map((a) => a.name).join(", ")}`);

  // A SHORT message after a run has ended is a follow-up: resume the search
  // with its brief + memory, not a fresh hunt (which wipes the role brief).
  // A long pasted JD (or an attachment) always starts fresh.
  const prior = runner.getState();
  const isFollowUp =
    !prior.running &&
    prior.canContinue &&
    !docs.length &&
    instruction.length < 400;

  $("ask").value = "";
  attached.length = 0;
  renderAttachments();
  autoGrow();
  setContinue(false);
  setRunning(true);
  startTrace();
  try {
    if (isFollowUp) {
      await runner.continueRun({ instruction, platforms });
    } else {
      await runner.run({ instruction, location, platforms });
    }
  } catch (err) {
    // A throw here is the real reason, in the same context — no message can
    // swallow it on the way back.
    finishTrace({ warnings: [], halted: err?.message || String(err) });
    setRunning(false);
  }
}

$("send")?.addEventListener("click", send);
$("stop")?.addEventListener("click", () => runner.abort());

$("continue")?.addEventListener("click", async () => {
  if (!(await gateHunt())) return;
  setContinue(false);
  setRunning(true);
  startTrace();
  try {
    await runner.continueRun({ platforms: readPlatforms() });
  } catch (err) {
    finishTrace({ warnings: [], halted: err?.message || String(err) });
    setRunning(false);
  }
});
$("ask")?.addEventListener("input", autoGrow);
$("ask")?.addEventListener("keydown", (e) => {
  // Enter sends, Shift+Enter is a newline — but a pasted JD is multi-line, so
  // Enter only sends when the field is a single line. Otherwise you would fire
  // the moment you pressed Enter partway through pasting.
  if (e.key === "Enter" && !e.shiftKey && !$("ask").value.includes("\n")) {
    e.preventDefault();
    send();
  }
});
// Registered defensively: a throw anywhere in this file used to take every
// listener after it with it, which is how the prompts and the paperclip both
// went dead at once.
for (const b of document.querySelectorAll(".suggest")) {
  b.addEventListener("click", () => {
    $("ask").value = b.dataset.fill;
    autoGrow();
    $("ask").focus();
    $("ask").setSelectionRange($("ask").value.length, $("ask").value.length);
  });
}

// Kept only for anything the worker still broadcasts.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "RECRUITME_AGENT_PROGRESS") return;
  const s = message.snapshot || {};
  if (s.running) {
    lastProgressAt = Date.now();
    renderTrace(s);
    const bits = [];
    if (s.found) bits.push(`${s.found} found`);
    if (s.read) bits.push(`${s.read} read`);
    $("hint") && ($("hint").textContent = bits.join(" · "));
  }
  else {
    finishTrace(s);
    setRunning(false);
  }
});

// Re-opening the panel mid-run shows live state, not a blank thread.
{
  // The runner lives in this document, so its state is simply readable.
  const s = runner.getState();
  if (s.running) {
    dropEmptyState();
    setRunning(true);
    startTrace();
    renderTrace(s);
  }
}

// ── Attachments ──────────────────────────────────────────────────────────────
//
// A recruiter is usually holding the JD as a PDF, not as text they can paste.
// It is read entirely in this browser with a vendored pdf.js — the extension is
// standalone, so there is no server to post a file to and nothing is uploaded
// anywhere.

/** @type {{name: string, text: string}[]} */
const attached = [];

function renderAttachments() {
  const box = $("attachments");
  while (box.firstChild) box.removeChild(box.firstChild);
  attached.forEach((a, i) => {
    const chip = el("span", "chip");
    chip.appendChild(el("span", "nm", a.name));
    chip.appendChild(el("span", "sz", `${Math.round(a.text.length / 1000)}k chars`));
    const x = el("button", null, "×");
    x.title = "Remove";
    x.addEventListener("click", () => {
      attached.splice(i, 1);
      renderAttachments();
    });
    chip.appendChild(x);
    box.appendChild(chip);
  });
}

function showPending(name) {
  const box = $("attachments");
  const chip = el("span", "chip loading");
  chip.id = "pending-chip";
  chip.appendChild(el("span", "nm", name));
  chip.appendChild(el("span", "sz", "reading…"));
  box.appendChild(chip);
}

async function attachFile(file) {
  if (!file) return;
  showPending(file.name);
  try {
    // Read it HERE. The extension is standalone — there is no server to post a
    // file to, and nothing is uploaded anywhere.
    const { readDocument } = await import("./read-document.js");
    const doc = await readDocument(file);
    attached.push({ name: doc.name, text: doc.text });
    if (doc.truncated) {
      thread.appendChild(el("div", "banner warn", `${doc.name}: only the first 40,000 characters were used.`));
    }
  } catch (err) {
    thread.appendChild(el("div", "banner bad", `Couldn't read ${file.name}: ${err.message}`));
    scrollDown();
  } finally {
    const p = document.getElementById("pending-chip");
    if (p) p.remove();
    renderAttachments();
  }
}

$("attach")?.addEventListener("click", () => $("file")?.click());
$("file")?.addEventListener("change", async (e) => {
  for (const f of Array.from(e.target.files || [])) await attachFile(f);
  e.target.value = ""; // let the same file be picked again
});

// Drag-and-drop onto the panel, and paste-a-file from the clipboard.
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  for (const f of Array.from(e.dataTransfer?.files || [])) await attachFile(f);
});
$("ask")?.addEventListener("paste", async (e) => {
  const files = Array.from(e.clipboardData?.files || []);
  if (!files.length) return;
  e.preventDefault();
  for (const f of files) await attachFile(f);
});


// ── Diagnose ─────────────────────────────────────────────────────────────────
// Proves card extraction, the Locations filter and the profile section reader
// against a live page. Free — no model calls — so run it whenever a hunt
// behaves oddly, and paste the report.

let diagBubble = null;

$("diagnose")?.addEventListener("click", () => {
  dropEmptyState();
  const m = el("div", "msg agent");
  diagBubble = el("div", "bubble", "Running diagnostic…");
  m.appendChild(diagBubble);
  thread.appendChild(m);
  scrollDown();
  $("diagnose").disabled = true;
  const diag = createDiagnostic({
    tabs: chrome.tabs,
    onProgress: (text) => {
      diagBubble.textContent = text;
      scrollDown();
    },
  });
  diag
    .run({})
    .catch((err) => {
      diagBubble.textContent = `Diagnostic failed: ${err?.message || err}`;
    })
    .finally(() => {
      $("diagnose").disabled = false;
    });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "RECRUITME_DIAGNOSE_PROGRESS") return;
  if (diagBubble) {
    diagBubble.textContent = message.text;
    scrollDown();
  }
});


// ── Worker health ────────────────────────────────────────────────────────────
// If the service worker failed to load, every button silently does nothing.
// Check once on open and say so plainly rather than letting the first hunt hang.
// No worker ping any more. The panel does not need the worker to hunt, to
// diagnose or to show its log — and a ping whose reply never arrived was
// indistinguishable from a healthy one, which is how a dead path looked fine.


// ── Copy report ──────────────────────────────────────────────────────────────
// Hands over everything the recorder captured — worker errors, every step,
// every failure, with timings. One click instead of hunting through a console.
// Profile body text is never recorded, only lengths, so this is safe to paste.
$("report")?.addEventListener("click", async () => {
  const text = await buildReport().catch((e) => `Could not read the log: ${e?.message || e}`);
  {
    try {
      await navigator.clipboard.writeText(text);
      $("report").textContent = "Copied";
      setTimeout(() => ($("report").textContent = "Copy report"), 2000);
    } catch {
      // Clipboard can be refused; show it so it can be selected by hand.
      void showLog();
    }
  }
});

// The panel's own failures belong in the same report as the worker's.
// Straight into the log. Routing these through the worker meant the errors
// most worth seeing were the ones least likely to arrive.
window.addEventListener("error", (e) => {
  void record.fail("panel", `${e.message} @ ${e.filename}:${e.lineno}`);
});
window.addEventListener("unhandledrejection", (e) => {
  void record.fail("panel", String(e.reason?.stack || e.reason).split("\n").slice(0, 2).join(" | "));
});


// ── Show the log inline ──────────────────────────────────────────────────────
// Asking someone to open chrome://extensions and find a service-worker console
// is friction that costs a whole round trip. The log renders here instead, so a
// screenshot of the panel carries everything needed to diagnose it.
async function showLog() {
  let text;
  try {
    // Read the log DIRECTLY. Asking the worker for it was the one path
    // guaranteed to fail when the worker was the thing being diagnosed.
    text = await buildReport();
  } catch (err) {
    text = `Could not read the log: ${err?.message || err}`;
  }
  {
    dropEmptyState();
    const m = el("div", "msg agent");
    const b = el("div", "bubble", text);
    b.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, monospace";
    b.style.fontSize = "11.5px";
    b.style.maxHeight = "260px";
    b.style.overflowY = "auto";
    m.appendChild(b);
    thread.appendChild(m);
    scrollDown();
  }
}

// A "Show log" control next to Copy report, for when you just want to look.
(() => {
  const bar = $("report")?.parentElement;
  if (!bar) return;
  const btn = el("button", "ghost", "Show log");
  btn.type = "button";
  btn.title = "Show what the extension recorded, here in the panel";
  btn.addEventListener("click", showLog);
  bar.insertBefore(btn, $("report"));
})();

// Proof the module actually executed. sidepanel.html checks for this shortly
// after load: if it is missing, the page rendered with no code attached and it
// says so instead of leaving every button silently inert.
window.__recruitmePanelReady = true;
void record.note("panel ready");