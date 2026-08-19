/**
 * Hunt popup — pick a job, approve a plan, watch the trawl, read the shortlist.
 *
 * Two rules govern this file.
 *
 * ESCAPING: every string rendered here — candidate names, headlines, locations,
 * scoring reasons — originates on LinkedIn and is attacker-controlled. A
 * candidate can put anything in their headline. Nothing is ever interpolated
 * into innerHTML; all text goes through textContent. Do not "simplify" this by
 * building HTML strings.
 *
 * LOUD FAILURE: an empty result list is never rendered as a successful search
 * that found nobody. Warnings and halts are shown prominently, because "our
 * extractor broke" and "LinkedIn has no such people" look identical otherwise —
 * the silent-failure class that has bitten this project repeatedly.
 */

const $ = (id) => document.getElementById(id);

/** Ask the background worker to make an authenticated call to RecruitMe. */
function api(path, opts) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "RECRUITME_API", path, opts }, (res) =>
      resolve(res || { ok: false, error: "No response from the extension background worker." }),
    );
  });
}

function show(el, visible) {
  if (el) el.hidden = !visible;
}

function setError(message) {
  const el = $("error-banner");
  if (!el) return;
  el.textContent = message || "";
  show(el, Boolean(message));
}

function clear(el) {
  while (el && el.firstChild) el.removeChild(el.firstChild);
}

/** Build an element with TEXT content only — never markup. */
function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined && text !== null) el.textContent = String(text);
  return el;
}

// ── State ────────────────────────────────────────────────────────────────────

let currentPlan = null;
let running = false;

// ── Job picker ───────────────────────────────────────────────────────────────

async function loadJobs() {
  const res = await api("/api/jobs");
  if (!res.ok) {
    setError(`Could not load your jobs: ${res.error || "unknown error"}`);
    return;
  }
  const jobs = Array.isArray(res.data) ? res.data : res.data?.jobs || [];
  const select = $("job-select");
  clear(select);
  select.appendChild(node("option", null, jobs.length ? "Choose a job…" : "No jobs found"));
  select.firstChild.value = "";
  for (const j of jobs) {
    const opt = node("option", null, j.company ? `${j.title} — ${j.company}` : j.title);
    opt.value = j.id;
    select.appendChild(opt);
  }
  const { lastJobId } = await chrome.storage.local.get("lastJobId");
  if (lastJobId && jobs.some((j) => j.id === lastJobId)) {
    select.value = lastJobId;
    void loadPlan(lastJobId);
  }
}

// ── Plan ─────────────────────────────────────────────────────────────────────

async function loadPlan(jobId) {
  if (!jobId) return;
  setError("");
  $("hunt-btn").disabled = true;
  await chrome.storage.local.set({ lastJobId: jobId });

  const location = $("location-input").value.trim() || undefined;
  const res = await api("/api/hunt/plan", {
    method: "POST",
    body: JSON.stringify({ jobId, location }),
  });

  if (!res.ok) {
    // A 409 means the job has never been analysed. Say so plainly and leave the
    // button disabled — hunting without a parsed role would search for nothing.
    setError(res.error || "Could not build a hunt plan for this job.");
    show($("plan-section"), false);
    return;
  }

  currentPlan = res.data;
  renderPlan(currentPlan);
  show($("plan-section"), true);
  $("hunt-btn").disabled = running;
}

function renderPlan(plan) {
  $("plan-title").textContent = plan.jobTitle || "";
  $("plan-company").textContent = plan.company || "";
  if (!$("location-input").value) $("location-input").value = plan.location || "";

  const list = $("query-list");
  clear(list);
  for (const q of plan.queries || []) {
    const li = node("li");
    li.appendChild(node("span", "query-text", q.query));
    li.appendChild(node("span", "query-rationale", q.rationale));
    list.appendChild(li);
  }

  const chips = $("must-haves");
  clear(chips);
  for (const m of plan.mustHaves || []) chips.appendChild(node("span", "chip", m));

  const l = plan.limits || {};
  $("limits").textContent =
    `Up to ${l.maxProfiles ?? 10} profiles, ${Math.round((l.minMsBetweenProfiles ?? 4000) / 1000)}s apart, ` +
    `${l.maxPages ?? 2} page(s) per search.`;
}

// ── Progress + results ───────────────────────────────────────────────────────

function renderSnapshot(s) {
  if (!s) return;
  running = Boolean(s.running);

  show($("progress-section"), running || s.capturedCount > 0);
  $("progress-queries").textContent = `${s.queriesRun ?? 0}/${s.totalQueries ?? 0}`;
  $("progress-seen").textContent = String(s.seenCount ?? 0);
  $("progress-captured").textContent = String(s.capturedCount ?? 0);
  $("progress-last-action").textContent = describeAction(s.lastAction);

  $("hunt-btn").disabled = running || !currentPlan;
  show($("stop-btn"), running);

  const warn = $("warnings-container");
  clear(warn);
  for (const w of s.warnings || []) warn.appendChild(node("div", "warning", w));
  show(warn, (s.warnings || []).length > 0);

  const halted = $("halted-banner");
  if (s.halted) {
    halted.textContent = `Hunt stopped: ${s.halted}`;
    show(halted, true);
  } else {
    show(halted, false);
  }

  renderResults(s.results || []);
}

function describeAction(a) {
  switch (a) {
    case "search": return "Running a search on LinkedIn";
    case "openProfile": return "Reading a profile";
    case "wait": return "Pausing between profiles";
    case "done": return "Finished";
    case "halted": return "Stopped";
    default: return a ? String(a) : "";
  }
}

function renderResults(results) {
  const list = $("results-list");
  clear(list);
  show($("results-section"), results.length > 0);

  results.forEach((r, i) => {
    const row = node("li", i < 3 ? "result result-top" : "result");

    const head = node("div", "result-head");
    if (i < 3) head.appendChild(node("span", "rank", String(i + 1)));
    head.appendChild(node("span", "result-name", r.name));
    // fit is 0-100; recruiters asked to see it out of 10.
    head.appendChild(node("span", "rating", `${(Number(r.fit || 0) / 10).toFixed(1)}/10`));
    row.appendChild(head);

    if (r.headline) row.appendChild(node("div", "result-headline", r.headline));
    if (r.location) row.appendChild(node("div", "result-location", r.location));

    const badges = node("div", "badges");
    if (r.known) badges.appendChild(node("span", "badge", "already in your library"));
    if (r.evidence === "headline") {
      badges.appendChild(node("span", "badge badge-warn", "judged on headline only — not yet read"));
    }
    if (badges.childNodes.length) row.appendChild(badges);

    if (r.reason) row.appendChild(node("div", "result-reason", r.reason));

    const link = node("a", "result-link", "Open profile");
    link.href = r.url;
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    row.appendChild(link);

    list.appendChild(row);
  });
}

// ── Wiring ───────────────────────────────────────────────────────────────────

$("job-select").addEventListener("change", (e) => loadPlan(e.target.value));
$("location-input").addEventListener("change", () => {
  const id = $("job-select").value;
  if (id) void loadPlan(id);
});

$("hunt-btn").addEventListener("click", () => {
  if (!currentPlan || running) return;
  setError("");
  const plan = { ...currentPlan, location: $("location-input").value.trim() || null };
  chrome.runtime.sendMessage({ type: "RECRUITME_HUNT_START", plan }, (res) => {
    if (res && res.ok === false) setError(res.error || "Could not start the hunt.");
  });
});

$("stop-btn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "RECRUITME_HUNT_ABORT" });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "RECRUITME_HUNT_PROGRESS") renderSnapshot(message.snapshot);
});

// Re-opening the popup mid-hunt must show live progress, not a blank form.
chrome.runtime.sendMessage({ type: "RECRUITME_HUNT_STATE" }, (snapshot) => {
  if (snapshot) renderSnapshot(snapshot);
});

void loadJobs();

// ── Ask: let DeepSeek drive ──────────────────────────────────────────────────
// The deterministic hunt above follows a fixed plan. This is the other mode:
// you say what you want, and the model decides what to search, what to open and
// what to report — reading pages as text, acting in your own session.
//
// Answers are rendered with textContent. The model is summarising pages written
// by third parties; treat its output as text, never markup.

function renderAgent(s) {
  if (!s) return;
  const status = $("ask-status");
  const stop = $("ask-stop-btn");
  const btn = $("ask-btn");
  if (!status) return;

  btn.disabled = Boolean(s.running);
  stop.hidden = !s.running;

  const bits = [];
  if (s.running) bits.push(`step ${s.steps}/${s.maxSteps}`);
  if (s.lastDetail) bits.push(s.lastDetail);
  if (s.halted) bits.push(`stopped: ${s.halted}`);
  status.textContent = bits.join(" · ");

  const out = $("ask-answer");
  clear(out);
  for (const w of s.warnings || []) out.appendChild(node("div", "warning", w));
  if (s.answer) out.appendChild(node("div", null, s.answer));
}

$("ask-btn")?.addEventListener("click", () => {
  const instruction = $("ask-input").value.trim();
  if (!instruction) return;
  setError("");
  clear($("ask-answer"));
  $("ask-status").textContent = "starting…";
  chrome.runtime.sendMessage(
    { type: "RECRUITME_AGENT_RUN", jobId: $("job-select").value || undefined, instruction },
    (res) => {
      if (res && res.ok === false) setError(res.error || "The agent could not start.");
    },
  );
});

$("ask-stop-btn")?.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "RECRUITME_AGENT_ABORT" });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "RECRUITME_AGENT_PROGRESS") renderAgent(message.snapshot);
});

chrome.runtime.sendMessage({ type: "RECRUITME_AGENT_STATE" }, (s) => {
  if (s) renderAgent(s);
});
