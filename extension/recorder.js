/**
 * Flight recorder.
 *
 * Every failure so far has cost a round trip: the panel showed something vague,
 * the real reason was in a console nobody was looking at, and I guessed. This
 * records what actually happened — worker errors, unhandled rejections, every
 * pipeline step, every tool result, with timestamps — so one click hands over
 * the whole picture instead of a screenshot of a spinner.
 *
 * Kept in chrome.storage.local as a ring buffer. Deliberately small: the last
 * 300 events is far more than one hunt, and it must never grow without bound in
 * a browser the recruiter uses all day.
 *
 * PRIVACY: this can contain candidate names and page snippets. It stays on the
 * machine and is only shared when the recruiter presses "Copy report". Profile
 * BODY text is never recorded — only lengths and counts — so a report is safe
 * to paste without handing over someone's CV.
 */

const KEY = "recruitmeLog";
const MAX = 300;

/** Never let the recorder itself break a hunt. Everything here swallows. */
async function push(entry) {
  try {
    const { [KEY]: log = [] } = await chrome.storage.local.get(KEY);
    log.push({ t: Date.now(), ...entry });
    if (log.length > MAX) log.splice(0, log.length - MAX);
    await chrome.storage.local.set({ [KEY]: log });
  } catch {
    /* recording is best-effort */
  }
}

export const record = {
  step: (phase, detail) => push({ kind: "step", phase, detail }),
  ok: (what, detail) => push({ kind: "ok", what, detail }),
  fail: (what, detail) => push({ kind: "fail", what, detail }),
  note: (detail) => push({ kind: "note", detail }),
};

/** Catch anything that escapes — this is what a dead worker leaves behind. */
export function installErrorCapture(where) {
  try {
    self.addEventListener("error", (e) => {
      void push({ kind: "fail", what: `${where}:error`, detail: `${e.message} @ ${e.filename}:${e.lineno}` });
    });
    self.addEventListener("unhandledrejection", (e) => {
      const r = e.reason;
      void push({
        kind: "fail",
        what: `${where}:unhandledrejection`,
        detail: r?.stack ? String(r.stack).split("\n").slice(0, 3).join(" | ") : String(r),
      });
    });
  } catch {
    /* not available in this context */
  }
}

/** A pasteable report. Relative timestamps — absolute ones tell nobody anything. */
export async function buildReport() {
  let log = [];
  try {
    ({ [KEY]: log = [] } = await chrome.storage.local.get(KEY));
  } catch {
    return "Could not read the log.";
  }
  if (!log.length) return "The log is empty — nothing has run since it was last cleared.";

  const t0 = log[0].t;
  const manifest = chrome.runtime.getManifest();
  const lines = [
    `RecruitMe ${manifest.version} — ${log.length} events over ${Math.round((log[log.length - 1].t - t0) / 1000)}s`,
    `Chrome: ${navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] || "unknown"}`,
    "",
  ];
  for (const e of log) {
    const at = `${String(((e.t - t0) / 1000).toFixed(1)).padStart(7)}s`;
    const tag =
      e.kind === "fail" ? "FAIL" : e.kind === "ok" ? "ok  " : e.kind === "step" ? "step" : "    ";
    const what = e.phase || e.what || "";
    lines.push(`${at}  ${tag}  ${what}${e.detail ? ` — ${e.detail}` : ""}`);
  }
  return lines.join("\n");
}

export async function clearLog() {
  try {
    await chrome.storage.local.remove(KEY);
  } catch {
    /* nothing to do */
  }
}
