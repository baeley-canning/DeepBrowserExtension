/**
 * The agent loop — DeepSeek decides, the browser performs.
 *
 * Standalone: no RecruitMe app, no login, no proxy. Your own DeepSeek key is in
 * extension storage and the calls go straight to api.deepseek.com.
 *
 * This is the Claude-in-Chrome shape, minus vision: the model is handed a
 * STRUCTURAL snapshot of the page (interactive elements with numbered refs +
 * role/name + console/network signals) and acts by ref — get_page_state, then
 * click / type / press / goto. There are no hardcoded selectors, so it recovers
 * from a redesign or a modal the way a human would: look again, re-plan.
 *
 * The loop carries a visited-URL memory so it never re-reads a profile it has
 * already opened — the "twenty variations of the same search" failure is
 * prevented by keeping state here rather than hoping the model remembers.
 *
 * BUDGET + CONTINUE. Each run is bounded (MAX_TOOL_CALLS browser actions) so a
 * runaway loop cannot burn the recruiter's account. When the budget runs out the
 * model is forced to write up what it has, and the run exposes `canContinue`.
 * continueRun() resumes the SAME conversation + seen set with a FRESH budget, so
 * "find more" keeps going through new people instead of re-reading the same
 * eight. The action floor (3s) still holds on every continued leg.
 *
 * Junk rejection is a TOOL PROBLEM, not a prompt problem: a ref that went stale
 * (a click re-rendered the page) returns "call get_page_state again", and the
 * model corrects. The cost of a runaway here is the recruiter's LinkedIn
 * account, so the loop stays paced, never retries a failed tool, and halts hard
 * on any auth wall.
 */
import { chatTurn, fenceUntrusted, SYSTEM_PROMPT } from "./deepseek.js";

// Dual-context binding. The panel loads these files as one classic bundle
// (panel-lib.js) where imports are stripped and dependencies are published on
// window.RM; the module sources are still used by the unit tests. `typeof` is
// safe against the stripped-bundle case where the imported binding does not
// exist at all.
const RM = (typeof window !== "undefined" && window.RM) || {};
const chatTurn$ = RM.chatTurn || (typeof chatTurn !== "undefined" ? chatTurn : null);
const fenceUntrusted$ = RM.fenceUntrusted || (typeof fenceUntrusted !== "undefined" ? fenceUntrusted : null);
const SYSTEM_PROMPT$ = RM.SYSTEM_PROMPT || (typeof SYSTEM_PROMPT !== "undefined" ? SYSTEM_PROMPT : "");

// Hard ceiling on browser actions per run (each "continue" gets a fresh one).
// Raised from 55: two platforms now (LinkedIn + SEEK), and the agentic path
// costs several actions per profile (look → click → look → scroll → read). The
// action-gap floor and the WRAP_UP nudge still bound it, and Continue provides a
// fresh budget per leg, so a higher ceiling stays safe.
const MAX_TOOL_CALLS = 100;
const WRAP_UP_AT = 20;
const MIN_TOOL_GAP_MS = 3000;
// LinkedIn auth/security walls, plus SEEK's login/oauth flows.
const AUTH_WALL_RE = /\/(checkpoint|authwall|uas\/login|login|sign-in|oauth|authenticate)(\?|\/|$)/i;
// Pages the agent may drive: LinkedIn + the SEEK employer / Talent Search portals.
const isSupportedPage = (url) =>
  /(^|\.)linkedin\.com\//i.test(url || "") ||
  /(^|\.)employer\.seek\.com\//i.test(url || "") ||
  /(^|\.)(seek\.co\.nz|seek\.com\.au|seek\.com)\//i.test(url || "");
const isLinkedInPage = (url) => /(^|\.)linkedin\.com\//i.test(url || "");
const isSeekPage = (url) => isSupportedPage(url) && !isLinkedInPage(url);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a));

/**
 * Light scrub of a single profile section before it reaches the model. The
 * untrusted-data fence handled in getPageState/open_profile is the structural
 * defence; this removes the crude prompt-injection lines and strips zero-width
 * / control characters a candidate might smuggle into their own About or
 * headline. Never claim it is complete — it is one layer.
 */
function scrubProfile(text) {
  return String(text || "")
    .split("\n")
    .filter((line) => !/^\s*(ignore|disregard|forget)\b.*\b(previous|prior|above|earlier)\b/i.test(line))
    .filter((line) => !/^\s*(you are|you must|system:|assistant:|role:)\b/i.test(line))
    .map((line) => line.replace(/[\u0000-\u0008\u000b-\u001f\u200b-\u200f\u2060\ufeff]/g, ""))
    .join("\n");
}

/**
 * @param {{getApiKey:()=>Promise<string>, onProgress:Function, tabs:object, now:()=>number}} deps
 */
export function createAgentLoop({ getApiKey, onProgress, tabs, now }) {
  let state = freshState();
  let tabId = null;
  let aborted = false;
  let lastActionAt = 0;
  let apiKey = null;
  /** Which platforms this run may search. Set at run(), reused by continue(). */
  let platforms = { linkedin: true, seek: true };
  /** Human-readable platform scope, carried into the brief + continuations. */
  let platformLine = "Search BOTH LinkedIn and SEEK.";
  /** The missing memory, retained across continue(): profiles already opened. */
  const seenProfiles = new Set();
  /** The entire conversation, retained across continue() so it can resume. */
  let conversation = null;

  function freshState() {
    return {
      running: false,
      steps: 0,
      maxSteps: MAX_TOOL_CALLS,
      lastDetail: "",
      trace: [],
      answer: "",
      halted: null,
      warnings: [],
      canContinue: false,
    };
  }

  const emit = () => onProgress({ ...state, trace: [...state.trace] });

  function detail(text) {
    state.lastDetail = text;
    if (state.trace.length) state.trace[state.trace.length - 1].detail = text;
    emit();
  }

  function warn(text) {
    state.warnings.push(text);
    emit();
  }

  function halt(reason) {
    state.halted = reason;
    state.running = false;
    emit();
  }

  async function pace() {
    const wait = lastActionAt + MIN_TOOL_GAP_MS - now();
    if (wait > 0) await sleep(wait);
    lastActionAt = now();
  }

  const LOCKED_TAB_KEY = "agentLockedTabId";

  async function rememberLockedTab(id) {
    try {
      await chrome.storage.session.set({ [LOCKED_TAB_KEY]: id });
    } catch { /* best effort */ }
  }

  async function ensureTab() {
    // 1. Reuse the in-memory dedicated tab.
    if (tabId !== null) {
      const kept = await tabs.get(tabId).catch(() => null);
      if (kept) return tabId;
      tabId = null;
    }

    // 2. Reuse the tab locked by a previous run / panel reload. The tab is OURS,
    //    so a panel reload must not spawn a fresh one.
    let persisted = null;
    try { persisted = (await chrome.storage.session.get(LOCKED_TAB_KEY))[LOCKED_TAB_KEY]; } catch { /* ignore */ }
    if (persisted) {
      const kept = await tabs.get(persisted).catch(() => null);
      if (kept) {
        tabId = kept.id;
        return tabId;
      }
    }

    // 3. ONE dedicated, hidden agent tab — created once, reused forever. It
    //    starts on a BLANK page and the model drives it to LinkedIn or SEEK via
    //    goto, so we never force a platform and never touch the recruiter's own
    //    tabs. This is the Claude-in-Chrome shape: the agent owns its working
    //    tab; you just give it a task.
    const created = await tabs.create({ url: "about:blank", active: false });
    tabId = created.id;
    await rememberLockedTab(tabId);
    await sleep(500);
    return tabId;
  }

  async function waitForLoad(id, timeoutMs = 20000) {
    return new Promise((resolve) => {
      const listener = (changedId, info) => {
        if (changedId === id && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(true);
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(false);
      }, timeoutMs);
    });
  }

  async function navigate(url) {
    const id = await ensureTab();
    const done = waitForLoad(id);
    await tabs.update(id, { url, active: false });
    await done;
    const t = await tabs.get(id).catch(() => null);
    return t?.url || url;
  }

  function ask(id, message) {
    return new Promise((resolve) => {
      tabs.sendMessage(id, message, (res) => {
        void chrome.runtime.lastError;
        resolve(res && typeof res === "object" ? res : { ok: false, error: "The page did not respond." });
      });
    });
  }

  /** Snapshot from the content script, fenced as untrusted data for the model. */
  async function getPageState() {
    const id = await ensureTab();
    const tab = await tabs.get(id).catch(() => null);
    if (/about:blank/i.test(tab?.url || "")) {
      return "The working tab is still blank. Call goto to open LinkedIn or SEEK first, then read the page.";
    }
    const res = await ask(id, { type: "RECRUITME_SNAPSHOT" });
    if (!res.ok) return `Could not read the page: ${res.error || "unknown error"}`;
    const text = [
      `URL: ${res.url}`,
      `Title: ${res.title}`,
      `Console errors: ${(res.console || []).length ? "\n" + res.console.join("\n") : "(none)"}`,
      `Recent network: ${(res.network || []).length ? "\n" + res.network.slice(-10).join("\n") : "(none)"}`,
      `Interactive elements:\n${res.tree || "(none)"}`,
    ].join("\n");
    return fenceUntrusted$(text);
  }

  async function act(msg) {
    const id = await ensureTab();
    const res = await ask(id, { type: "RECRUITME_ACT", ...msg });
    return res;
  }

  /** Perform one tool call. Returns the string result, or null if we halted. */
  async function runTool(call) {
    state.trace.push({ tool: call.name, detail: "" });
    emit();
    await pace();

    try {
      if (call.name === "get_page_state") {
        detail("reading the page");
        return await getPageState();
      }

      if (call.name === "goto") {
        const url = String(call.args.url || "");
        if (!/^https?:\/\//i.test(url) || !isSupportedPage(url)) {
          return `Refused: "${url}" is not a LinkedIn or SEEK URL.`;
        }
        if (!platforms.linkedin && isLinkedInPage(url)) return "LinkedIn is switched off — enable it or search SEEK instead.";
        if (!platforms.seek && isSeekPage(url)) return "SEEK is switched off — enable it or search LinkedIn instead.";
        detail(url);
        const landed = await navigate(url);
        if (AUTH_WALL_RE.test(landed)) {
          halt("A login or security check appeared. Solve it in the agent's tab, then try again.");
          return null;
        }
        await sleep(rand(1500, 3000));
        return await getPageState();
      }

      if (call.name === "click") {
        const ref = Number(call.args.ref);
        if (!Number.isInteger(ref) || ref < 1) return "click needs a numeric ref from get_page_state.";
        detail(`click ref ${ref}`);
        const res = await act({ action: "click", ref });
        if (!res.ok) return `Click failed: ${res.error}`;
        await sleep(rand(1200, 2200));
        return `Clicked [${ref}] "${res.name || ""}". Re-read get_page_state to see the new page.`;
      }

      if (call.name === "type") {
        const ref = Number(call.args.ref);
        const text = String(call.args.text ?? "");
        if (!Number.isInteger(ref) || ref < 1) return "type needs a numeric ref.";
        detail(`type into ref ${ref}`);
        const res = await act({ action: "type", ref, text });
        if (!res.ok) return `Typing failed: ${res.error}`;
        await sleep(rand(300, 800));
        return `Typed ${res.length} char(s) into [${ref}]. Re-read get_page_state for autocomplete refs, then click the match.`;
      }

      if (call.name === "press") {
        const ref = Number(call.args.ref);
        const key = String(call.args.key || "Enter");
        if (!Number.isInteger(ref) || ref < 1) return "press needs a numeric ref.";
        detail(`press ${key} on ref ${ref}`);
        const res = await act({ action: "press", ref, key });
        if (!res.ok) return `Keypress failed: ${res.error}`;
        await sleep(rand(1500, 2500));
        return `Pressed ${key} on [${ref}].`;
      }

      if (call.name === "seek_search") {
        if (!platforms.seek) return "SEEK is switched off — enable it to search SEEK.";
        const query = String(call.args.query || "").trim();
        const loc = String(call.args.location || "").trim();
        if (!query) return "seek_search needs a query.";
        detail(`SEEK "${query}"${loc ? ` in ${loc}` : ""}`);
        const id = await ensureTab();
        // The results page is where the form-submit lands; the content script
        // fills the keyword + region boxes and submits from the current page.
        const res = await ask(id, { type: "RECRUITME_SEEK_SEARCH", query, location: loc });
        if (!res.ok) return `SEEK search failed: ${res.error}`;
        if (AUTH_WALL_RE.test(res.url || "")) {
          halt("SEEK showed a login or security check. Solve it in the tab, then try again.");
          return null;
        }
        const cards = res.cards || [];
        return (
          fenceUntrusted$(
            `SEEK results (${cards.length} candidate card${cards.length === 1 ? "" : "s"}):\n` +
            cards.map((c, i) => `${i + 1}. ${c.name || "(no name)"} — ${c.headline || ""} — ${c.location || ""}\n   ${c.url}`).join("\n") +
            (res.pageText ? `\n\nPage text:\n${res.pageText.slice(0, 3000)}` : "")
          )
        );
      }

      if (call.name === "seek_profile") {
        if (!platforms.seek) return "SEEK is switched off — enable it to read SEEK profiles.";
        const url = String(call.args.url || "");
        if (!/(^|\.)employer\.seek\.com\/talentsearch\/profile\//i.test(url) &&
            !/\/(?:profile)\/(\d+)/i.test(url)) {
          return `Refused: "${url}" is not a SEEK /talentsearch/profile/<id> URL.`;
        }
        if (seenProfiles.has(url)) {
          state.read = seenProfiles.size;
          return `Already read ${url} this run — do not open it again.`;
        }
        seenProfiles.add(url);
        state.found = seenProfiles.size;
        state.read = seenProfiles.size;
        detail(`SEEK ${url.replace(/^https?:\/\/(www\.)?/, "")}`);
        const landed = await navigate(url);
        if (AUTH_WALL_RE.test(landed)) {
          halt("SEEK showed a login or security check. Solve it in the tab, then try again.");
          return null;
        }
        await sleep(rand(3000, 5000));
        const id = await ensureTab();
        await ask(id, { type: "RECRUITME_SCROLL" });
        await sleep(rand(1200, 2000));
        const text = await ask(id, { type: "RECRUITME_PAGE_TEXT" });
        return fenceUntrusted$(String(text.text || text.error || "(no text)").slice(0, 12000));
      }

      if (call.name === "set_location_filter") {
        if (!platforms.linkedin) return "LinkedIn is switched off — set_location_filter only applies to LinkedIn.";
        const loc = String(call.args.location || "").trim();
        if (!loc) return "No location was given.";
        detail(loc);
        const id = await ensureTab();
        const res = await ask(id, { type: "RECRUITME_SET_LOCATION", location: loc });
        if (!res.ok) return `Could not set the Locations filter: ${res.error}`;
        await sleep(rand(1500, 2500));
        return `Locations filter set to "${res.applied}". It stays applied to later searches.`;
      }

      if (call.name === "open_profile") {
        if (!platforms.linkedin) return "LinkedIn is switched off — enable it to read LinkedIn profiles.";
        const url = String(call.args.url || "");
        if (!/^https:\/\/([a-z]+\.)?linkedin\.com\/in\//i.test(url)) {
          return `Refused: "${url}" is not a linkedin.com/in/ profile URL.`;
        }
        if (seenProfiles.has(url)) {
          state.read = seenProfiles.size;
          return `Already read ${url} this run — do not open it again.`;
        }
        seenProfiles.add(url);
        state.found = seenProfiles.size;
        state.read = seenProfiles.size;
        detail(url.replace(/^https:\/\/(www\.)?/, ""));
        const landed = await navigate(url);
        if (AUTH_WALL_RE.test(landed)) {
          halt("LinkedIn showed a login or security check. Solve it in the tab, then try again.");
          return null;
        }
        await sleep(rand(3000, 5000));
        const id = await ensureTab();

        // Two scrolls so LinkedIn's lazy-loaded Experience / Education sections
        // actually render, then expand any "see more" truncation, BEFORE reading.
        await ask(id, { type: "RECRUITME_SCROLL" });
        await sleep(rand(900, 1500));
        await ask(id, { type: "RECRUITME_SCROLL" });
        await sleep(rand(900, 1500));
        await ask(id, { type: "RECRUITME_EXPAND_PROFILE" });
        await sleep(rand(1200, 2000));

        // STRUCTURED read first. The section-aware reader pulls #experience,
        // #education and #skills with per-section caps, so the model sees the
        // actual work history with section boundaries — not a 12k-chars-of-hero
        // truncation (the bug that left ratings resting on headlines alone).
        const p = await ask(id, { type: "RECRUITME_PROFILE" });
        if (p.ok && p.profile) {
          const d = p.profile;
          const part = (label, v) => (v ? `\n${label}:\n${scrubProfile(v)}` : "");
          const body =
            `Name: ${d.name || "(unknown)"}\n` +
            `Headline: ${d.headline || "(none)"}\n` +
            `Location: ${d.location || "(unknown)"}\n` +
            `URL: ${d.url || url}` +
            part("About", d.about) +
            part("Experience", d.experience) +
            part("Education", d.education) +
            part("Skills", d.skills);
          return fenceUntrusted$(body);
        }

        // Fall back to raw page text — and SAY so, so a silent hero-only read
        // surfaces in the trace instead of passing as a full profile read.
        const text = await ask(id, { type: "RECRUITME_PAGE_TEXT" });
        return (
          "(Structured profile read failed — only raw page text follows.)\n" +
          fenceUntrusted$(String(text.text || text.error || "(no text)").slice(0, 12000))
        );
      }

      if (call.name === "get_page_text") {
        detail("current page");
        const id = await ensureTab();
        const text = await ask(id, { type: "RECRUITME_PAGE_TEXT" });
        return fenceUntrusted$(String(text.text || text.error || "(no text)").slice(0, 12000));
      }

      if (call.name === "scroll_page") {
        detail("loading more");
        const id = await ensureTab();
        await ask(id, { type: "RECRUITME_SCROLL" });
        await sleep(1200);
        return await getPageState();
      }

      return `Unknown tool: ${call.name}`;
    } catch (err) {
      // Never retry, never swallow — hand the failure back and let the model decide.
      return `The tool failed: ${err?.message || String(err)}`;
    }
  }

  /**
   * Drive the chat loop against a given conversation until the model answers,
   * the budget runs out, or the loop halts. Shared by run() and continueRun().
   * Mutates `messages` in place so continuations pick up exactly where they left
   * off.
   */
  async function runLoop(messages) {
    let wrapUpSent = false;

    while (state.running && !aborted && state.steps < MAX_TOOL_CALLS) {
      state.lastDetail = "Thinking…";
      emit();

      const turn = await chatTurn$({ apiKey, messages });

      if (turn.type === "answer") {
        state.answer = turn.text;
        state.running = false;
        emit();
        return;
      }

      messages.push(turn.raw);
      for (const call of turn.calls) {
        if (aborted || state.steps >= MAX_TOOL_CALLS) break;
        state.steps += 1;
        const result = await runTool(call);
        if (result === null) return; // halted
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }

      const left = MAX_TOOL_CALLS - state.steps;
      if (!wrapUpSent && left <= WRAP_UP_AT && state.running) {
        wrapUpSent = true;
        messages.push({
          role: "user",
          content:
            `You have about ${left} browser actions left this leg. Stop searching now unless a ` +
            `couple more profiles are essential, then write your ranked shortlist with what you ` +
            `have. The recruiter can ask you to continue afterwards with a fresh budget.`,
        });
      }
    }

    // NEVER end with nothing. Force a prose write-up with tools disabled; the
    // conversation survives so a later continue() keeps going through NEW people.
    if (state.running && !aborted && !state.answer) {
      state.lastDetail = "Out of actions — writing up what it found";
      emit();
      messages.push({
        role: "user",
        content:
          "You have run out of browser actions for this leg. Do not request any more. Write your " +
          "final ranked shortlist now using only the profiles you already read, rate each out of " +
          "10, name the gaps, and say honestly how far you got and who you did not get to. The " +
          "recruiter can continue the search afterwards.",
      });
      const finalTurn = await chatTurn$({ apiKey, messages, noTools: true }).catch(() => null);
      if (finalTurn?.type === "answer") {
        state.answer = finalTurn.text;
        warn(`Ran out of browser actions after ${state.steps} — this is what it had by then. Continue to go further.`);
      } else {
        halt(`Reached the ${MAX_TOOL_CALLS}-action ceiling and could not produce a summary.`);
      }
      state.running = false;
      emit();
    }
  }

  /** Close the working tab and finalise the persistent flags. */
  async function teardown() {
    state.running = false;
    state.canContinue = Boolean(conversation && !aborted && !state.halted);
    // KEEP the working tab. Closing it here is what made every fresh run and
    // every "continue" spawn another tab — the exact "opening a new tab and
    // operating in there" behaviour to avoid. The locked tab is reused, and the
    // agent never touches any other tab the recruiter is using.
    emit();
  }

  return {
    getState: () => ({ ...state, trace: [...state.trace] }),

    abort() {
      aborted = true;
      halt("Stopped at your request.");
    },

    /** Start a fresh run. Resets memory + conversation. */
    async run({ instruction, location, platforms: requestedPlatforms }) {
      if (state.running) throw new Error("A hunt is already running.");
      apiKey = await getApiKey();
      if (!apiKey) throw new Error("No DeepSeek API key saved — open the extension's Options and paste one.");

      platforms = { linkedin: true, seek: true, ...(requestedPlatforms || {}) };
      platformLine = platforms.linkedin && platforms.seek
        ? "Search BOTH LinkedIn and SEEK."
        : platforms.linkedin
          ? "Search LinkedIn ONLY — do not open SEEK."
          : "Search SEEK ONLY — do not open LinkedIn.";

      state = freshState();
      if (!platforms.linkedin && !platforms.seek) {
        state.halted = "Both LinkedIn and SEEK are switched off — enable at least one and try again.";
        state.running = false;
        emit();
        return this.getState();
      }
      state.running = true;
      aborted = false;
      lastActionAt = 0;
      seenProfiles.clear();
      emit();

      const brief =
        `${instruction}\n\n${platformLine} ` +
        `The working tab starts on a BLANK page — begin by using goto to open your first search` +
        `${location ? `, scoped to ${location}` : ""}.`;
      conversation = [
        { role: "system", content: SYSTEM_PROMPT$ },
        { role: "user", content: brief },
      ];

      try {
        await runLoop(conversation);
      } catch (err) {
        halt(err?.message || String(err));
      } finally {
        await teardown();
      }

      return this.getState();
    },

    /**
     * Resume the last (budget-stopped or naturally-ended) run with a FRESH
     * action budget and full memory of what was already read, so it keeps going
     * through new candidates instead of re-reading the same people.
     */
    async continueRun({ instruction, platforms: requestedPlatforms } = {}) {
      if (state.running) throw new Error("A hunt is already running.");
      if (!conversation) throw new Error("Nothing to continue — start a new hunt first.");
      if (!apiKey) apiKey = await getApiKey();
      if (!apiKey) throw new Error("No DeepSeek API key saved — open the extension's Options and paste one.");
      if (requestedPlatforms) {
        platforms = { ...platforms, ...requestedPlatforms };
        platformLine = platforms.linkedin && platforms.seek
          ? "Search BOTH LinkedIn and SEEK."
          : platforms.linkedin
            ? "Search LinkedIn ONLY — do not open SEEK."
            : "Search SEEK ONLY — do not open LinkedIn.";
      }

      // Capture what must survive before resetting the per-leg state.
      const priorAnswer = state.answer || "";
      const originalBrief = conversation?.[1]?.content || "";
      const readList = [...seenProfiles];

      state.running = true;
      aborted = false;
      lastActionAt = 0;
      state.steps = 0;
      state.answer = "";
      state.halted = null;
      state.warnings = [];
      emit();

      // COMPACT the conversation before continuing. The raw tool history has
      // grown enormous (every page read is up to 12k chars) and overflows the
      // model's context window, which silently truncates the OLDEST turns — the
      // role brief itself. That is the "this session has no prior context"
      // failure. Rebuild a small conversation: system + role brief + the prior
      // ranking + the already-read list + the continue instruction.
      conversation = [
        { role: "system", content: SYSTEM_PROMPT$ },
        { role: "user", content: originalBrief },
        ...(priorAnswer
          ? [{ role: "assistant", content: `Your ranking so far:\n\n${priorAnswer}` }]
          : []),
        {
          role: "user",
          content:
            `Profiles already opened and read — do NOT open these again:\n` +
            `${readList.join("\n") || "(none yet)"}`,
        },
        {
          role: "user",
          content:
            `${platformLine}\n\n` +
            (instruction
              ? `The recruiter's follow-up instruction:\n\n${instruction}\n\nContinue the search where ` +
                `you left off accordingly, then give ONE updated, best-first ranked shortlist over ` +
                `everything read so far. Do not re-read profiles you already reported.`
              : "Continue the search where you left off: find more candidates and read any promising " +
                "profiles you have not opened yet, then give ONE updated, best-first ranked shortlist " +
                "across everything read so far."),
        },
      ];

      try {
        await runLoop(conversation);
      } catch (err) {
        halt(err?.message || String(err));
      } finally {
        await teardown();
      }

      return this.getState();
    },
  };
}