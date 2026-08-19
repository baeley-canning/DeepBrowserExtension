// Plain classic worker: it imports nothing. The hunt moved to the side panel,
// so there is no module graph here to fail to resolve.

// The hunt, the diagnostic and the log all live in the SIDE PANEL now — a real
// document with a normal event loop. The worker keeps only the legacy capture
// flow, so it no longer imports anything that could fail to resolve.

const DEFAULT_SERVER_BASES = [
  "https://recruitme-production-8cc6.up.railway.app",
  "https://recruitme.railway.app",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

// Bases that may receive the user's Basic-auth credentials. Anything outside
// this set (or the configured serverBase / lastWorkingServerBase) gets probed
// without credentials so a misconfigured / squatted host can't harvest them.
const LOOPBACK_BASE_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i;
function isCredentialSafeBase(base, settings) {
  if (!base) return false;
  const normalised = base.replace(/\/+$/, "");
  if (LOOPBACK_BASE_RE.test(normalised)) return true;
  const configured = (settings?.serverBase || "").replace(/\/+$/, "");
  const lastWorking = (settings?.lastWorkingServerBase || "").replace(/\/+$/, "");
  return Boolean(
    (configured && normalised.toLowerCase() === configured.toLowerCase()) ||
    (lastWorking && normalised.toLowerCase() === lastWorking.toLowerCase())
  );
}

const PENDING_CAPTURE_ALARM = "recruitme-pending-capture-check";
const NEXT_CAPTURE_ALARM    = "recruitme-next-capture";
const activeAutoCaptures = new Map(); // sessionId -> startedAt timestamp
const pendingSessionEnsures = new Set();
const autoOpenedTabs = new Set(); // Tab IDs auto-opened by the extension for background capture
const recentAutoCaptureLookups = new Map(); // url -> timestamp; throttles checkPendingCapture calls
const AUTO_CAPTURE_LOOKUP_COOLDOWN_MS = 12_000;
const ERROR_BADGE_COLOR = "#b91c1c";

// ─── Safe-pacing config ───────────────────────────────────────────────────
// Auto-capture mode rate-limits itself to look like a human recruiter. These
// constants are the defaults; the user can override caps from options.html.
const DEFAULT_HOURLY_CAP   = 10;
const DEFAULT_DAILY_CAP    = 30;
// Random gap between two profile captures. Combined with each profile taking
// 2–4 minutes of paced scroll/click, this produces a cadence of ~5–8 min/profile.
const JITTER_MIN_MS        = 90_000;   //  90s
const JITTER_MAX_MS        = 240_000;  // 240s
// When LinkedIn shows a captcha / authwall / 429 we back off for 24h.
const AUTO_PAUSE_MS        = 24 * 60 * 60 * 1000;
// LinkedIn's account-restriction signals come in many flavours — captcha,
// authwall, "we noticed unusual activity", "please verify your identity",
// "your account has been restricted", and the not-logged-in redirect.
// Catching any of these triggers a 24h pause so we don't keep digging.
const AUTO_PAUSE_PATTERNS  = /captcha|challenge|authwall|999|429|rate.?limit|unusual.?activity|verify.?(identity|account)|account.?(restricted|restriction)|action.?required|sign[- ]?in|not.?logged.?in/i;

async function setExtensionError(message) {
  const error = message || "RecruitMe extension error";
  await chrome.storage.local.set({ lastError: error });
  await chrome.action.setBadgeText({ text: "!" });
  await chrome.action.setBadgeBackgroundColor({ color: ERROR_BADGE_COLOR });
  await chrome.action.setTitle({ title: `RecruitMe LinkedIn Capture\n${error}` });
}

async function clearExtensionError() {
  await chrome.storage.local.set({ lastError: "" });
  await chrome.action.setBadgeText({ text: "" });
  await chrome.action.setTitle({ title: "RecruitMe LinkedIn Capture" });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normaliseServerBase(base = "") {
  const trimmed = base.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

async function getStoredSettings() {
  return chrome.storage.local.get({
    serverBase: "",
    lastWorkingServerBase: "",
    lastError: "",
    extUsername: "",
    extPassword: "",
    // Default ON for new installs — protects users' LinkedIn accounts.
    // Auto-capture fires on every LinkedIn profile tab load, which LinkedIn
    // detects as automation. Manual-only means the user triggers each capture
    // deliberately from the popup; one profile at a time, human-paced.
    manualOnlyMode: true,
  });
}

// ─── Cap tracking ─────────────────────────────────────────────────────────
// Counts roll over hourly / daily based on epoch timestamps stored alongside
// each count, so the cap is enforced even if the service worker is restarted
// or the user reboots their machine mid-day.
const HOUR_MS = 3_600_000;
const DAY_MS  = 86_400_000;

async function getCaps() {
  const { hourlyCap, dailyCap } = await chrome.storage.local.get({
    hourlyCap: DEFAULT_HOURLY_CAP,
    dailyCap:  DEFAULT_DAILY_CAP,
  });
  return { hourlyCap, dailyCap };
}

async function getCaptureCounts() {
  const stored = await chrome.storage.local.get({ captureCounts: null });
  const c = stored.captureCounts;
  const now = Date.now();
  if (!c) return { hourly: 0, daily: 0, hourStart: now, dayStart: now };
  // Roll over expired windows so callers always see a live snapshot.
  const out = { ...c };
  if (now - out.hourStart > HOUR_MS) { out.hourly = 0; out.hourStart = now; }
  if (now - out.dayStart  > DAY_MS)  { out.daily  = 0; out.dayStart  = now; }
  return out;
}

async function incrementCaptureCounts() {
  const counts = await getCaptureCounts();
  counts.hourly += 1;
  counts.daily  += 1;
  await chrome.storage.local.set({ captureCounts: counts });
}

async function isUnderCap() {
  const counts = await getCaptureCounts();
  const { hourlyCap, dailyCap } = await getCaps();
  return counts.hourly < hourlyCap && counts.daily < dailyCap;
}

// ─── Recent captures (popup history) ──────────────────────────────────────
// Persist the last few completed captures so the popup can show "Last
// captured: Jane Smith 2 min ago" without re-fetching from the server.
const MAX_RECENT_CAPTURES = 8;

async function recordRecentCapture(candidateName, sessionId, linkedinUrl) {
  if (!candidateName) return;
  try {
    const { recentCaptures } = await chrome.storage.local.get({ recentCaptures: [] });
    // De-dupe by both sessionId and url so a re-capture of the same profile
    // updates instead of stacking. Storing the URL lets the on-page bubble
    // detect "this is the profile I just captured" and show a banner.
    const url = (linkedinUrl || "").replace(/[?#].*$/, "");
    const next = [
      { name: candidateName, sessionId: sessionId || "", linkedinUrl: url, at: Date.now() },
      ...recentCaptures.filter((r) => r?.sessionId !== sessionId && r?.linkedinUrl !== url),
    ].slice(0, MAX_RECENT_CAPTURES);
    await chrome.storage.local.set({ recentCaptures: next });
  } catch { /* non-fatal */ }
}

// ─── Auto-pause (LinkedIn detection backoff) ──────────────────────────────
async function isAutoPaused() {
  const { autoPausedUntil } = await chrome.storage.local.get({ autoPausedUntil: 0 });
  return autoPausedUntil > Date.now();
}

async function pauseAutoCapture(reason = "Detection signal") {
  await chrome.storage.local.set({
    autoPausedUntil:  Date.now() + AUTO_PAUSE_MS,
    autoPausedReason: String(reason).slice(0, 200),
  });
  await setExtensionError(`Auto-capture paused 24h: ${reason}`).catch(() => {});
}

async function resumeAutoCapture() {
  await chrome.storage.local.remove(["autoPausedUntil", "autoPausedReason"]);
  await clearExtensionError().catch(() => {});
}

// Build a Basic Authorization header from stored credentials, or return null.
async function getBasicAuthHeader() {
  const { extUsername, extPassword } = await getStoredSettings();
  if (!extUsername || !extPassword) return null;
  const encoded = btoa(`${extUsername}:${extPassword}`);
  return `Basic ${encoded}`;
}

async function getServerBases() {
  const settings = await getStoredSettings();
  const bases = [
    normaliseServerBase(settings.serverBase || ""),
    normaliseServerBase(settings.lastWorkingServerBase || ""),
    ...DEFAULT_SERVER_BASES,
  ].filter(Boolean);
  return [...new Set(bases)];
}

function withTimeout(url, options = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Request timed out")), timeoutMs);
    fetch(url, options)
      .then((response) => {
        clearTimeout(timer);
        resolve(response);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

async function requestRecruitMe(path, options = {}, preferredBase = "", overrides = {}) {
  const allowFallback = overrides.allowFallback !== false;
  let bases;
  if (preferredBase && !allowFallback) {
    bases = [preferredBase];
  } else if (preferredBase) {
    bases = [preferredBase, ...(await getServerBases()).filter((base) => base !== preferredBase)];
  } else {
    bases = await getServerBases();
  }
  const rememberFailure = overrides.rememberFailure !== false;
  const acceptData = typeof overrides.acceptData === "function" ? overrides.acceptData : null;
  const timeoutMs =
    typeof overrides.timeoutMs === "number"
      ? overrides.timeoutMs
      : typeof options.timeoutMs === "number"
      ? options.timeoutMs
      : 10000;

  let lastError = new Error("Could not connect to RecruitMe");

  // Attach stored credentials automatically so every request is authenticated.
  const authHeader = await getBasicAuthHeader().catch(() => null);
  const settings = await getStoredSettings().catch(() => ({}));

  for (const base of bases) {
    try {
      const headers = new Headers(options.headers || {});
      const requestOptions = { ...options };
      delete requestOptions.timeoutMs;

      if (requestOptions.body && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }
      // Only attach credentials to bases the user has explicitly configured
      // (serverBase / lastWorkingServerBase) or loopback. A misconfigured or
      // squatted railway.app fallback must not receive the recruiter's
      // Basic-auth password.
      if (authHeader && !headers.has("Authorization") && isCredentialSafeBase(base, settings)) {
        headers.set("Authorization", authHeader);
      }

      const response = await withTimeout(`${base}${path}`, { ...requestOptions, headers }, timeoutMs);
      const text = await response.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { error: text };
        }
      }

      if (!response.ok) {
        lastError = new Error(data?.error || `RecruitMe request failed (${response.status})`);
        continue;
      }

      if (acceptData && !acceptData(data)) {
        lastError = new Error("RecruitMe server had no matching pending capture");
        continue;
      }

      await chrome.storage.local.set({ lastWorkingServerBase: base });
      await clearExtensionError();
      return { base, data };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (rememberFailure) {
    await setExtensionError(lastError.message);
  }
  throw lastError;
}

function toUserFacingCaptureError(error) {
  const message = error instanceof Error ? error.message : String(error || "");

  if (/Receiving end does not exist|Could not establish connection/i.test(message)) {
    return "RecruitMe could not attach to the LinkedIn tab. Reload the extension and try again.";
  }
  if (/Request timed out/i.test(message)) {
    return "RecruitMe took too long to respond. Check the app is running and the server URL in the popup.";
  }
  if (/LinkedIn URL mismatch/i.test(message)) {
    return "The open LinkedIn profile did not match the queued candidate.";
  }
  if (/not contain enough usable profile text|too short/i.test(message)) {
    return "RecruitMe only captured the profile header. Reload the LinkedIn tab, make sure you are signed in, then try Fetch profile again.";
  }

  return message || "LinkedIn capture failed";
}

async function markPendingCaptureError(pending, error, preferredBase = "") {
  if (!pending?.sessionId) return;

  const message = toUserFacingCaptureError(error).slice(0, 500);
  await setExtensionError(message);

  try {
    await requestRecruitMe(
      "/api/extension/fetch-session/error",
      {
        method: "POST",
        body: JSON.stringify({
          sessionId: pending.sessionId,
          error: message,
        }),
      },
      preferredBase,
      { rememberFailure: false }
    );
  } catch (reportError) {
    console.warn("RecruitMe failed to report capture error:", reportError);
  }
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "LinkedIn capture failed"));
        return;
      }
      resolve(response);
    });
  });
}

async function checkPendingCapture(linkedinUrl) {
  try {
    const { base, data } = await requestRecruitMe(
      `/api/extension/fetch-session/pending?linkedinUrl=${encodeURIComponent(linkedinUrl)}`,
      {},
      "",
      {
        rememberFailure: false,
        acceptData: (data) => Boolean(data?.active || data?.pending),
      }
    );
    return { base, data };
  } catch {
    return { base: "", data: { pending: false, active: false, status: "idle" } };
  }
}

async function getPendingSessions() {
  let base = "";
  let data = null;
  try {
    ({ base, data } = await requestRecruitMe(
      "/api/extension/fetch-session",
      {},
      "",
      {
        rememberFailure: false,
        acceptData: (data) => (Array.isArray(data) ? data.length > 0 : Boolean(data)),
      }
    ));
  } catch {
    data = null;
  }
  const sessions = Array.isArray(data) ? data : data ? [data] : [];
  return {
    base,
    sessions: sessions.filter((session) => session?.status === "pending" && session.linkedinUrl),
  };
}

function isRootLinkedInProfile(url = "") {
  // Must be linkedin.com/in/<username> with no sub-path (e.g. not /details/experience)
  return /linkedin\.com\/in\/[^/?#]+\/?([?#].*)?$/.test(url);
}

function normaliseLinkedInUrl(url = "") {
  if (!url) return "";

  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/in\/([^/?#]+)/i);
    if (!match) return "";
    return `https://www.linkedin.com/in/${match[1].toLowerCase()}`;
  } catch {
    const match = url.match(/linkedin\.com\/in\/([^/?#\s]+)/i);
    return match ? `https://www.linkedin.com/in/${match[1].toLowerCase()}` : "";
  }
}

function linkedInSlugAliasKey(url = "") {
  const match = url.match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  const slug = match ? match[1] : "";
  return slug
    .toLowerCase()
    .replace(/-[a-z0-9]*\d[a-z0-9]{5,}$/i, "")
    .replace(/[^a-z0-9]/g, "");
}

function linkedInProfileMatches(a = "", b = "") {
  if (!a || !b) return false;
  if (normaliseLinkedInUrl(a) === normaliseLinkedInUrl(b)) return true;

  const aKey = linkedInSlugAliasKey(a);
  const bKey = linkedInSlugAliasKey(b);
  return aKey.length >= 6 && aKey === bKey;
}

async function findLinkedInProfileTab(linkedinUrl) {
  const targetUrl = normaliseLinkedInUrl(linkedinUrl);
  if (!targetUrl) return null;

  // Query LinkedIn tabs by URL, plus any tabs currently loading (status filter
  // is widely supported; about:blank as a tabs.query URL pattern is not). For
  // the loading set we match pendingUrl, restricted to tabs whose own url is
  // still empty/about:blank so we don't grab a tab the user has navigated
  // away from but whose pendingUrl is briefly stale.
  const [linkedinTabs, loadingTabs] = await Promise.all([
    chrome.tabs.query({ url: ["https://www.linkedin.com/in/*"] }),
    chrome.tabs.query({ status: "loading" }),
  ]);
  const candidates = [
    ...linkedinTabs.filter((tab) => linkedInProfileMatches(tab.url || "", targetUrl)),
    ...loadingTabs.filter((tab) => {
      const url = tab.url || "";
      const isFresh = !url || url === "about:blank";
      return isFresh && linkedInProfileMatches(tab.pendingUrl || "", targetUrl);
    }),
  ];
  return (
    candidates.find((tab) => isRootLinkedInProfile(tab.url || tab.pendingUrl || "")) ||
    candidates[0] ||
    null
  );
}

async function openPendingProfileTab(linkedinUrl) {
  // Race guard: the app's window.open propagation to the tabs API can lag
  // 100–300ms. If the alarm fires in that gap we'd open a duplicate. Sleep
  // briefly and re-check before creating; if the user's tab has appeared,
  // adopt it instead of creating a second one.
  await sleep(400);
  const existing = await findLinkedInProfileTab(linkedinUrl);
  if (existing?.id) return existing.id;

  // Open as a regular new tab in the user's last-focused normal window
  // (not a separate Chrome window). active: true is required so LinkedIn's
  // IntersectionObserver fires (innerHeight > 0).
  const opts = { url: linkedinUrl, active: true };
  try {
    const lastFocused = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    if (lastFocused?.id) opts.windowId = lastFocused.id;
  } catch { /* fall through to default window */ }
  const created = await chrome.tabs.create(opts);
  const tabId = created?.id ?? null;
  if (tabId) autoOpenedTabs.add(tabId);
  return tabId;
}

async function waitForTabComplete(tabId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error("LinkedIn tab closed before capture could start");
    if (tab.status === "complete" && tab.url) return tab;
    await sleep(250);
  }
  throw new Error("LinkedIn tab did not finish loading in time");
}

async function prepareTabForCapture(tabId, linkedinUrl) {
  let tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) throw new Error("LinkedIn tab is no longer available");

  const currentUrl = tab.url || "";
  const needsNavigation =
    !linkedInProfileMatches(currentUrl, linkedinUrl) ||
    !isRootLinkedInProfile(currentUrl);

  if (needsNavigation) {
    tab = await chrome.tabs.update(tabId, { url: linkedinUrl, active: true });
    await waitForTabComplete(tabId);
  } else if (!tab.active) {
    tab = await chrome.tabs.update(tabId, { active: true });
    await sleep(1200);
  }

  return tab;
}

async function notifyCaptureDone(candidateName) {
  const name = candidateName || "Profile";
  try {
    await chrome.notifications.create(`recruitme-done-${Date.now()}`, {
      type: "basic",
      iconUrl:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAA7AAAAOwBeShxvQAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAAHpSURBVFiF7ZaxbtswEIa/o2zHhiEjQAYDHQIkQ4cCHQIUKFC0Q4c+QR8gj9CXyFP0EfoEfYU+Q5cgQ4ECBQoUCIokJMWS2CEt2ZItWxIlWxIlkSSboqoqVdX9cM/x7o47AgCO4zgOgJQSwB4ASinlnHMAOI7jOE8ppZQCAHgAIgB4AKICeAAgAnhRSnkDIOecAwDgnHMOAAB6AJ4BeALwBEAPwBMAD0AppdwB4A4AW2ttbQCklFJKKaWUUkoppZRSSilmAGCttbW2tpQCAIAQQgghhBBCCCGEEEIIIYQQQgghhBBCCCEAQAghgBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQggh5H8HYIwxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGAAAgAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQyY7QAAAAASUVORK5CYII=",
      title: "RecruitMe — Profile sent",
      message: `${name} has been captured and sent to RecruitMe for scoring.`,
      priority: 2,
    });
  } catch {
    // Notification permission not granted — not critical
  }
}

// Initiates an auto-capture: sends capture-and-post to content script which handles
// the full capture + POST to server independently of the service worker lifecycle.
async function initiateCapture(tabId, pending, preferredBase = "") {
  console.log("[RecruitMe] initiateCapture", { tabId, sessionId: pending.sessionId, url: pending.linkedinUrl });
  return sendMessageToTab(tabId, {
    type: "capture-and-post",
    sessionId: pending.sessionId,
    linkedinUrl: pending.linkedinUrl,
    serverBase: preferredBase,
  });
  // Content script has acked — it now handles capture + POST without the SW.
}

// Tracks sessions currently being captured. Key is sessionId (NOT sessionId:tabId)
// so the same session can never trigger duplicate captures across two tabs. Value is
// the timestamp the capture started — the lock auto-releases after this many ms as
// a safety net, in case the content script never sends capture-complete/error.
// Human-paced auto-capture takes 2–4 min/profile + enrich phase, so the lock has
// to comfortably exceed that or it'll release mid-capture and trigger a duplicate
// run that could double-spike the rate to LinkedIn.
const SESSION_LOCK_MAX_AGE_MS = 10 * 60 * 1000; // 10 min

function isSessionLocked(sessionId) {
  const startedAt = activeAutoCaptures.get(sessionId);
  if (!startedAt) return false;
  if (Date.now() - startedAt > SESSION_LOCK_MAX_AGE_MS) {
    activeAutoCaptures.delete(sessionId);
    return false;
  }
  return true;
}

// Persist active captures to chrome.storage.session so the lock survives
// service worker restarts within the same browser session. When the SW is
// killed mid-capture the in-memory activeAutoCaptures Map is wiped, but the
// storage entry lives on — processNextCapture can check it before
// deciding to re-fire the alarm for a session that's still in-flight.
async function persistActiveCaptureStart(sessionId) {
  try {
    const stored = await chrome.storage.session.get({ activeCaptureIds: [] });
    const ids = new Set(stored.activeCaptureIds);
    ids.add(sessionId);
    await chrome.storage.session.set({ activeCaptureIds: [...ids] });
  } catch { /* non-fatal */ }
}
async function persistActiveCaptureEnd(sessionId) {
  try {
    const stored = await chrome.storage.session.get({ activeCaptureIds: [] });
    const ids = new Set(stored.activeCaptureIds);
    ids.delete(sessionId);
    await chrome.storage.session.set({ activeCaptureIds: [...ids] });
  } catch { /* non-fatal */ }
}
async function isCapturePersisted(sessionId) {
  try {
    const stored = await chrome.storage.session.get({ activeCaptureIds: [] });
    return stored.activeCaptureIds.includes(sessionId);
  } catch { return false; }
}

async function capturePendingSessionInTab(tabId, pending, preferredBase = "") {
  if (isSessionLocked(pending.sessionId)) return;
  // Also check the persisted set — covers SW-restart scenario where
  // activeAutoCaptures was wiped but the capture is still running.
  if (await isCapturePersisted(pending.sessionId)) return;

  activeAutoCaptures.set(pending.sessionId, Date.now());
  await persistActiveCaptureStart(pending.sessionId);

  try {
    await prepareTabForCapture(tabId, pending.linkedinUrl);
    await sleep(1400);
    let captureStarted = false;
    try {
      const response = await initiateCapture(tabId, pending, preferredBase);
      if (response?.status !== "started" && response?.status !== "in-progress") {
        throw new Error("LinkedIn capture did not start");
      }
      captureStarted = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Receiving end does not exist|Could not establish connection/i.test(message)) {
        await chrome.tabs.reload(tabId).catch(() => {});
        await waitForTabComplete(tabId);
        await sleep(1800);
        const response = await initiateCapture(tabId, pending, preferredBase);
        if (response?.status !== "started" && response?.status !== "in-progress") {
          throw new Error("LinkedIn capture did not start after reload");
        }
        captureStarted = true;
      } else {
        throw error;
      }
    }

    // Advance the session to "processing" on the server as soon as content.js
    // confirms it has started. This prevents the alarm loop from treating the
    // session as still-pending and re-firing a duplicate capture while the first
    // one is running (the alarm fires every 30s; captures can take 30-60s).
    if (captureStarted) {
      requestRecruitMe(
        "/api/extension/fetch-session",
        { method: "PATCH", body: JSON.stringify({ sessionId: pending.sessionId, status: "processing" }) },
        preferredBase,
        { rememberFailure: false }
      ).catch(() => {}); // fire-and-forget; failure is non-fatal
    }

    // Lock stays held until capture-complete / capture-error message clears it,
    // or until SESSION_LOCK_MAX_AGE_MS elapses (whichever comes first).
  } catch (error) {
    activeAutoCaptures.delete(pending.sessionId);
    await persistActiveCaptureEnd(pending.sessionId);
    await markPendingCaptureError(pending, error, preferredBase);
  }
}

async function maybeAutoCapture(tabId, linkedinUrl) {
  // Manual-only mode: skip all auto-capture. The recruiter navigates to the
  // profile themselves and triggers capture via the popup. Toggle in Options.
  // Default MUST be true (manual-only) to match every other gate in this file
  // (lines 71, 665, 726, 923, 951, 1173). A false default here was the
  // outlier — it meant a fresh install with no stored config silently turned
  // on auto-capture against LinkedIn the first time content.js ran.
  const { manualOnlyMode } = await chrome.storage.local.get({ manualOnlyMode: true });
  if (manualOnlyMode) {
    console.log("[RecruitMe] Auto-capture skipped (manual-only mode is ON)");
    return;
  }

  // Normalise trailing slash so "profile/" and "profile" share the same cooldown key.
  const normUrl = linkedinUrl.replace(/\/$/, "");
  const lastLookup = recentAutoCaptureLookups.get(normUrl);
  if (lastLookup && Date.now() - lastLookup < AUTO_CAPTURE_LOOKUP_COOLDOWN_MS) return;
  recentAutoCaptureLookups.set(normUrl, Date.now());

  const pending = await checkPendingCapture(linkedinUrl);
  console.log("[RecruitMe] maybeAutoCapture", { tabId, linkedinUrl, status: pending.data?.status, sessionId: pending.data?.sessionId });
  if (!pending.data?.active || !pending.data?.sessionId) return;
  if (pending.data.status !== "pending") return;
  await capturePendingSessionInTab(tabId, pending.data, pending.base);
}

// ─── Serial, capped, jittered capture loop ────────────────────────────────
// Replaces the previous "open up to 3 tabs every 30s" approach. We now
// process exactly one pending session at a time, with a random 90–240s
// gap between captures. After each capture finishes (or errors), the
// completion handlers schedule the next NEXT_CAPTURE_ALARM.

async function scheduleNextCapture() {
  const delay = JITTER_MIN_MS + Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS);
  await chrome.alarms.create(NEXT_CAPTURE_ALARM, { when: Date.now() + delay });
}

// Module-level mutex so two concurrent alarm firings can't both pass the
// cap+pause checks and double-dispatch. The whole processNextCapture body
// runs under this gate.
let processNextCaptureInFlight = false;

// Pre-flight reservation: bump counts before dispatch, roll back on failure.
// Without this, two alarms could both observe currentHourly=9, isUnderCap()
// would return true for both, and we'd silently fire two captures in the
// same hour-cap window — exactly the spike pattern LinkedIn flags.
async function decrementCaptureCounts() {
  const counts = await getCaptureCounts();
  counts.hourly = Math.max(0, counts.hourly - 1);
  counts.daily  = Math.max(0, counts.daily  - 1);
  await chrome.storage.local.set({ captureCounts: counts });
}

async function processNextCapture() {
  if (processNextCaptureInFlight) return;
  processNextCaptureInFlight = true;
  let reservedQuota = false;
  try {
    const { manualOnlyMode } = await chrome.storage.local.get({ manualOnlyMode: true });
    if (manualOnlyMode) return;

    if (await isAutoPaused()) {
      console.log("[RecruitMe] auto-capture paused — skipping cycle");
      return;
    }
    if (!(await isUnderCap())) {
      console.log("[RecruitMe] hourly/daily cap reached — re-checking in 1h");
      await chrome.alarms.create(NEXT_CAPTURE_ALARM, { when: Date.now() + HOUR_MS });
      return;
    }

    // If there's already a capture running we don't fire another. The
    // capture-complete handler will schedule the next one.
    if (activeAutoCaptures.size > 0) return;

    const { base, sessions } = await getPendingSessions();
    if (!sessions.length) return;

    const session = sessions[0];
    if (pendingSessionEnsures.has(session.sessionId)) return;
    pendingSessionEnsures.add(session.sessionId);

    // Reserve quota BEFORE dispatch so a concurrent processNextCapture
    // can't read the same pre-increment counts and double-fire. The
    // submit-capture-result/error handlers no longer re-increment.
    await incrementCaptureCounts();
    reservedQuota = true;

    try {
      const existingTab = await findLinkedInProfileTab(session.linkedinUrl);
      if (existingTab?.id) {
        if (existingTab.status === "complete") {
          await capturePendingSessionInTab(existingTab.id, session, base);
        }
      } else {
        await openPendingProfileTab(session.linkedinUrl);
      }
      // Quota stays reserved — the capture is now owned by the content
      // script + completion handlers. Even if it errors out, the reservation
      // is intentional (we still hit LinkedIn).
      reservedQuota = false;
    } catch (error) {
      console.warn("[RecruitMe] processNextCapture failed:", error);
      // Dispatch itself blew up before we ever pinged LinkedIn — refund.
    } finally {
      pendingSessionEnsures.delete(session.sessionId);
    }
  } finally {
    if (reservedQuota) await decrementCaptureCounts().catch(() => {});
    processNextCaptureInFlight = false;
  }
}

async function ensurePendingCaptureAlarm() {
  // Heartbeat that picks up sessions newly created in the app. When auto-
  // capture is on, a 5-min gap was the cause of the recruiter clicking
  // Fetch then having to manually open profiles — drop to 1 min so a new
  // session is captured automatically within ~60s. Manual mode keeps the
  // 5-min cadence (nothing to fire there, no point waking up often).
  const { manualOnlyMode } = await chrome.storage.local.get({ manualOnlyMode: true });
  const periodInMinutes = manualOnlyMode ? 5 : 1;
  // chrome.alarms.create replaces an existing alarm with the same name, so
  // toggling manualOnlyMode in options can re-tune this alarm via set-config.
  await chrome.alarms.create(PENDING_CAPTURE_ALARM, { periodInMinutes });
}

async function getActiveLinkedInTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || !tab.url.includes("linkedin.com/in/")) {
    throw new Error("Open a LinkedIn profile first");
  }
  return tab;
}

// Legacy manual capture helper kept for non-session callers. Pending-session
// manual captures use capturePendingSessionInTab so they get the same
// navigation-aware /details/experience reliability path as auto-captures.
async function doManualCapture(tabId, pending, preferredBase) {
  const capture = await sendMessageToTab(tabId, { type: "capture-profile" });
  return requestRecruitMe(
    "/api/extension/fetch-session/complete",
    {
      method: "POST",
      timeoutMs: 120000,
      body: JSON.stringify({
        sessionId: pending.sessionId,
        linkedinUrl: capture.data.linkedinUrl,
        profileText: capture.data.profileText,
      }),
    },
    preferredBase
  );
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "linkedin-page-observed") {
    const tabId = sender.tab?.id;
    if (!tabId || !message.linkedinUrl) {
      sendResponse({ ok: false, error: "Missing LinkedIn tab context" });
      return;
    }
    // Skip sub-pages like /details/experience — only capture from root profile pages
    if (!isRootLinkedInProfile(message.linkedinUrl)) {
      sendResponse({ ok: true, skipped: true });
      return false;
    }

    void maybeAutoCapture(tabId, message.linkedinUrl)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "capture-complete") {
    console.log("[RecruitMe] capture-complete", { sessionId: message.sessionId, candidateName: message.candidateName });
    if (message.sessionId) {
      activeAutoCaptures.delete(message.sessionId);
      void persistActiveCaptureEnd(message.sessionId);
    }
    const tabId = sender.tab?.id;
    if (tabId && autoOpenedTabs.has(tabId)) {
      autoOpenedTabs.delete(tabId);
      chrome.tabs.remove(tabId).catch(() => {});
    }
    // Quota was already reserved at dispatch time; just schedule next.
    void scheduleNextCapture().catch(() => {});
    void recordRecentCapture(message.candidateName, message.sessionId, sender.tab?.url || "").catch(() => {});
    // Tell the content script to show the "captured ✓" banner in the
    // overlay bubble. The content script is on the same tab as the
    // capture so this is a direct messaging hop.
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        type: "capture-complete-banner",
        candidateName: message.candidateName || "Profile",
      }).catch(() => { /* tab may have closed already */ });
    }
    void clearExtensionError().catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "capture-error") {
    console.log("[RecruitMe] capture-error", { sessionId: message.sessionId, error: message.error });
    if (message.sessionId) {
      activeAutoCaptures.delete(message.sessionId);
      void persistActiveCaptureEnd(message.sessionId);
    }
    const tabId = sender.tab?.id;
    if (tabId && autoOpenedTabs.has(tabId)) {
      autoOpenedTabs.delete(tabId);
      chrome.tabs.remove(tabId).catch(() => {});
    }
    // If the error looks like LinkedIn's bot-detection wall, pause auto-capture
    // for 24h. Manual captures from the popup still work.
    if (AUTO_PAUSE_PATTERNS.test(message.error || "")) {
      void pauseAutoCapture(message.error).catch(() => {});
    } else {
      void scheduleNextCapture().catch(() => {});
      void setExtensionError(message.error || "Capture failed").catch(() => {});
    }
    sendResponse({ ok: true });
    return false;
  }

  // Content script captured the profile and hands it to the service worker to POST.
  // Routing via the SW avoids cross-origin CORS ambiguity that content scripts have
  // when running inside a LinkedIn (or other) page context.
  if (message?.type === "submit-capture-result") {
    void (async () => {
      const { sessionId, linkedinUrl, profileText, candidateName, captureMeta, serverBase } = message;
      const tabId = sender.tab?.id;
      try {
        await requestRecruitMe(
          "/api/extension/fetch-session/complete",
          {
            method: "POST",
            timeoutMs: 120000,
            body: JSON.stringify({ sessionId, linkedinUrl, profileText, captureMeta }),
          },
          serverBase || "",
          { rememberFailure: false }
        );
        if (sessionId) { activeAutoCaptures.delete(sessionId); void persistActiveCaptureEnd(sessionId); }
        if (tabId && autoOpenedTabs.has(tabId)) {
          autoOpenedTabs.delete(tabId);
          chrome.tabs.remove(tabId).catch(() => {});
        }
        // Quota was already reserved at dispatch time; just schedule next.
        void scheduleNextCapture().catch(() => {});
        void recordRecentCapture(candidateName, sessionId, linkedinUrl).catch(() => {});
        // If the tab that owned the capture is still open, tell the content
        // script to show the "captured ✓" banner inside the overlay bubble.
        if (tabId) {
          chrome.tabs.sendMessage(tabId, {
            type: "capture-complete-banner",
            candidateName: candidateName || "Profile",
          }).catch(() => { /* tab may have closed already */ });
        }
        void clearExtensionError().catch(() => {});
        sendResponse({ ok: true });
      } catch (error) {
        // POST failed — report error to server and set badge
        const errMsg = (error instanceof Error ? error.message : String(error)).slice(0, 500);
        console.warn("[RecruitMe] submit-capture-result failed:", errMsg);
        if (sessionId) { activeAutoCaptures.delete(sessionId); void persistActiveCaptureEnd(sessionId); }
        if (tabId && autoOpenedTabs.has(tabId)) {
          autoOpenedTabs.delete(tabId);
          chrome.tabs.remove(tabId).catch(() => {});
        }
        await requestRecruitMe(
          "/api/extension/fetch-session/error",
          { method: "POST", body: JSON.stringify({ sessionId, error: errMsg }) },
          serverBase || "",
          { rememberFailure: false }
        ).catch(() => {});
        await setExtensionError(errMsg).catch(() => {});
        sendResponse({ ok: false, error: errMsg });
      }
    })();
    return true;
  }

  // Content script captured an error — let the SW report it to the server.
  if (message?.type === "submit-capture-error") {
    void (async () => {
      const { sessionId, error: errMsg, serverBase } = message;
      const tabId = sender.tab?.id;
      if (sessionId) { activeAutoCaptures.delete(sessionId); void persistActiveCaptureEnd(sessionId); }
      if (tabId && autoOpenedTabs.has(tabId)) {
        autoOpenedTabs.delete(tabId);
        chrome.tabs.remove(tabId).catch(() => {});
      }
      await requestRecruitMe(
        "/api/extension/fetch-session/error",
        { method: "POST", body: JSON.stringify({ sessionId, error: errMsg }) },
        serverBase || "",
        { rememberFailure: false }
      ).catch(() => {});
      // Detection-style errors (captcha / 999 / authwall / 429) trigger a
      // 24h pause so we don't keep digging the hole. Other errors just feed
      // back into the pacing loop.
      if (AUTO_PAUSE_PATTERNS.test(errMsg || "")) {
        await pauseAutoCapture(errMsg).catch(() => {});
      } else {
        await scheduleNextCapture().catch(() => {});
        await setExtensionError(errMsg || "Capture failed").catch(() => {});
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message?.type === "get-auto-capture-status") {
    void (async () => {
      const counts        = await getCaptureCounts();
      const caps          = await getCaps();
      const paused        = await isAutoPaused();
      const { autoPausedUntil, autoPausedReason, manualOnlyMode, recentCaptures } = await chrome.storage.local.get({
        autoPausedUntil: 0, autoPausedReason: "", manualOnlyMode: true, recentCaptures: [],
      });
      // Opening the popup is a strong signal the user wants something to
      // happen — opportunistically kick the loop so any queued sessions
      // get picked up immediately instead of waiting for the next alarm.
      if (!manualOnlyMode) void processNextCapture().catch(() => {});
      sendResponse({
        ok: true,
        manualOnlyMode,
        paused,
        pausedUntil: paused ? autoPausedUntil : 0,
        pausedReason: paused ? autoPausedReason : "",
        hourly: counts.hourly,
        daily: counts.daily,
        hourlyCap: caps.hourlyCap,
        dailyCap: caps.dailyCap,
        recentCaptures: Array.isArray(recentCaptures) ? recentCaptures.slice(0, 5) : [],
      });
    })();
    return true;
  }

  if (message?.type === "manual-only-changed") {
    // Re-tune the heartbeat to match the new mode and kick the loop if
    // the user just turned auto-capture ON (so any queued sessions get
    // picked up immediately without waiting for the next alarm tick).
    void (async () => {
      await ensurePendingCaptureAlarm();
      const { manualOnlyMode } = await chrome.storage.local.get({ manualOnlyMode: true });
      if (!manualOnlyMode) void processNextCapture().catch(() => {});
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message?.type === "resume-auto-capture") {
    void resumeAutoCapture()
      .then(() => scheduleNextCapture())
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message?.type === "set-auto-capture-caps") {
    const { hourlyCap, dailyCap } = message;
    void (async () => {
      const updates = {};
      if (Number.isFinite(hourlyCap)) updates.hourlyCap = Math.max(1, Math.min(50, hourlyCap));
      if (Number.isFinite(dailyCap))  updates.dailyCap  = Math.max(1, Math.min(200, dailyCap));
      await chrome.storage.local.set(updates);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message?.type === "get-config") {
    void getStoredSettings()
      .then((settings) =>
        sendResponse({
          ok: true,
          serverBase: settings.serverBase || settings.lastWorkingServerBase || DEFAULT_SERVER_BASES[0],
          username:   settings.extUsername || "",
          lastError:  settings.lastError || "",
        })
      )
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "set-config") {
    void (async () => {
      const serverBase = normaliseServerBase(message.serverBase || "") || DEFAULT_SERVER_BASES[0];
      // Store credentials before the connection test so requestRecruitMe picks them up.
      if (message.username !== undefined) {
        await chrome.storage.local.set({
          extUsername: message.username || "",
          extPassword: message.password || "",
        });
      }
      const { base } = await requestRecruitMe(
        "/api/extension/fetch-session",
        {},
        serverBase,
        { rememberFailure: false, allowFallback: false }
      );
      await chrome.storage.local.set({ serverBase, lastWorkingServerBase: base, lastError: "" });
      await ensurePendingCaptureAlarm();
      await maybeKickAutoCapture();
      return base;
    })()
      .then((base) => sendResponse({ ok: true, serverBase: base }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "get-session") {
    void requestRecruitMe("/api/extension/fetch-session")
      .then(({ base, data }) => sendResponse({ ok: true, session: data, serverBase: base }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "check-pending") {
    void checkPendingCapture(message.linkedinUrl)
      .then(({ base, data }) =>
        sendResponse({
          ok: true,
          pending: Boolean(data?.pending),
          active: Boolean(data?.active),
          status: data?.status || "idle",
          sessionId: data?.sessionId || "",
          candidateName: data?.candidateName || "",
          message: data?.message || "",
          error: data?.error || "",
          serverBase: base,
        })
      )
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  // Q2.3: ask the server which jobs already include this LinkedIn URL and
  // which active jobs the candidate could be added to. Used by the in-page
  // overlay so the recruiter sees match info without leaving the profile.
  if (message?.type === "query-profile-match") {
    if (!message.linkedinUrl) {
      sendResponse({ ok: false, error: "linkedinUrl required" });
      return false;
    }
    void requestRecruitMe(
      `/api/extension/profile-match?url=${encodeURIComponent(message.linkedinUrl)}`,
      {},
      "",
      { rememberFailure: false }
    )
      .then(({ data, base }) => sendResponse({ ok: true, data, serverBase: base }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  // Q2.3: manual "Add to {job}" path. Captures via the content script first,
  // then POSTs the captured profileText to /api/extension/import bound to the
  // chosen job. Mirrors the auto-capture flow but without a server-side
  // pending FetchSession — recruiter intent comes from the overlay click.
  if (message?.type === "submit-add-to-job") {
    const { jobId, linkedinUrl, profileText, captureMeta } = message;
    if (!jobId || !linkedinUrl || !profileText) {
      sendResponse({ ok: false, error: "jobId, linkedinUrl, profileText required" });
      return false;
    }
    void requestRecruitMe(
      "/api/extension/import",
      {
        method: "POST",
        timeoutMs: 90000,
        body: JSON.stringify({ jobId, linkedinUrl, profileText, captureMeta }),
      },
      "",
      { rememberFailure: false }
    )
      .then(({ data }) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "log-contact") {
    const { candidateId, contactType, note, jobId } = message;
    if (!candidateId || !contactType) {
      sendResponse({ ok: false, error: "candidateId and contactType required" });
      return false;
    }
    void requestRecruitMe(
      `/api/candidates/${encodeURIComponent(candidateId)}/contacts`,
      {
        method: "POST",
        timeoutMs: 10000,
        body: JSON.stringify({
          type: contactType,
          note: note || undefined,
          // Tag the contact with the role it was about so the bubble can
          // render "re: [Role]" for other recruiters in the same org.
          jobId: jobId || undefined,
        }),
      },
      "",
      { rememberFailure: false }
    )
      .then(({ data }) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "manual-capture-pending") {
    void (async () => {
      const tab = await getActiveLinkedInTab();
      const pending = await checkPendingCapture(tab.url);
      if (!pending.data?.active || !pending.data?.sessionId) {
        throw new Error("No pending RecruitMe fetch matches this LinkedIn profile");
      }
      if (pending.data.status === "processing") {
        throw new Error(pending.data.message || "RecruitMe is already scoring this profile");
      }
      if (pending.data.status === "completed") {
        throw new Error(pending.data.message || "RecruitMe already captured this profile");
      }
      if (pending.data.status === "error") {
        throw new Error(pending.data.error || pending.data.message || "Last RecruitMe capture failed");
      }
      if (!pending.data.pending) {
        throw new Error("No pending RecruitMe fetch matches this LinkedIn profile");
      }
      await capturePendingSessionInTab(tab.id, pending.data, pending.base);
      const candidateName = pending.data.candidateName || "Profile";
      return { candidateName, status: "started" };
    })()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});

async function checkForExtensionUpdate() {
  try {
    const bases = await getServerBases();
    const preferredBase = bases[0] || "";
    for (const base of bases) {
      try {
        const res = await fetch(`${base}/api/extension/version`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) continue;
        const data = await res.json();
        const latestVersion = data?.version;
        const manifest = chrome.runtime.getManifest();
        const currentVersion = manifest.version;
        if (latestVersion && latestVersion !== currentVersion) {
          await chrome.action.setBadgeText({ text: "!" });
          await chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" });
          await chrome.action.setTitle({ title: `RecruitMe update available (${currentVersion} → ${latestVersion}). Visit LinkedIn Setup in the app to download.` });
          console.log(`[RecruitMe] Extension update available: ${currentVersion} → ${latestVersion}`);
        }
        return;
      } catch { /* try next base */ }
    }
  } catch { /* non-fatal */ }
}

// Bootstrap helper: kick the loop only when auto-capture is enabled.
// Without this guard a service-worker restart would fire a capture before
// the recruiter had a chance to interact with the popup.
async function maybeKickAutoCapture() {
  const { manualOnlyMode } = await chrome.storage.local.get({ manualOnlyMode: true });
  if (manualOnlyMode) return;
  void processNextCapture().catch(() => {});
}

chrome.runtime.onInstalled.addListener(() => {
  void ensurePendingCaptureAlarm();
  void clearExtensionError().catch(() => {});
  void maybeKickAutoCapture();
  void checkForExtensionUpdate().catch(() => {});
  // Drop stale scraperWindowId from <=1.4.15 installs that used a dedicated
  // capture window. The key is no longer read; clearing it is just hygiene.
  void chrome.storage.local.remove(["scraperWindowId"]).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  void ensurePendingCaptureAlarm();
  void maybeKickAutoCapture();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === NEXT_CAPTURE_ALARM) {
    void processNextCapture().catch(() => {});
    return;
  }
  if (alarm.name === PENDING_CAPTURE_ALARM) {
    // Slow heartbeat — just nudges the loop awake if it stalled.
    void maybeKickAutoCapture();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  // Only trigger for root profile pages; sub-pages like /details/experience are skipped
  if (!tab.url || !isRootLinkedInProfile(tab.url)) return;

  void maybeAutoCapture(tabId, tab.url.replace(/[?#].*$/, "")).catch((error) => {
    console.warn("RecruitMe auto-capture on tab update failed:", error);
  });
});

void ensurePendingCaptureAlarm();
void maybeKickAutoCapture();

// ── Side panel ───────────────────────────────────────────────────────────────
//
// The hunt, the diagnostic and the log all run in the SIDE PANEL — a real
// document with a normal event loop, direct access to chrome.tabs, and open for
// the whole run because the user is watching it. The worker deliberately does
// none of it: when it did, every message from the panel went unanswered and a
// reply that never arrives is indistinguishable from a slow one.
//
// The icon opens launch.html (a popup always renders); that popup calls
// sidePanel.open() from a real click, which is the gesture the API requires.
function applyPanelBehavior() {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false }).catch(() => {});
}
applyPanelBehavior();
chrome.runtime.onInstalled.addListener(applyPanelBehavior);
chrome.runtime.onStartup.addListener(applyPanelBehavior);
