/**
 * The background trawl driver.
 *
 * This file deliberately contains NO decisions — they all live in the tested
 * state machine in `hunt-queue.js`. The driver's only job is to execute the
 * machine's instructions against the browser: open tabs, wait, extract, and
 * feed events back. It adds no pacing of its own beyond the settle waits
 * described in the task, because the cost of a runaway loop here is the
 * recruiter's own LinkedIn account (one was flagged on 2026-08-12 by a loop
 * running ~6x too fast). All timing, stop-conditions, and ordering come from
 * `nextAction` / `applyEvent`.
 */

import { createHunt, nextAction, applyEvent } from "./hunt-queue.js";

const SEARCH_URL_PREFIX = "https://www.linkedin.com/search/results/people/?keywords=";
const AUTH_WALL_MARKERS = ["/authwall", "authwall"];

/**
 * Create a hunt driver that executes a trawl plan against the browser.
 *
 * @param {Object} deps - injected dependencies
 * @param {Function} deps.requestRecruitMe - (path, opts) => parsed JSON, throws on failure
 * @param {Function} deps.onProgress - (snapshot) => void, called after every state change
 * @param {Object} deps.tabs - chrome.tabs (create/remove/update/onUpdated/sendMessage)
 * @param {Object} deps.runtime - chrome.runtime
 * @param {Function} deps.now - () => Date.now
 * @returns {{ start: Function, abort: Function, getState: Function }}
 */
export function createHuntDriver({ requestRecruitMe, onProgress, tabs, runtime, now }) {
  let state = null;
  let huntTabId = null;
  let running = false;
  let warnings = [];
  let lastAction = "idle";
  let results = [];
  let aborted = false;

  function emitProgress() {
    if (!state) return;
    onProgress({
      running,
      jobId: state.jobId,
      queriesRun: state.queriesRun,
      totalQueries: state.totalQueries,
      seenCount: state.seenCount,
      capturedCount: state.capturedCount,
      halted: state.halted,
      warnings: [...warnings],
      lastAction,
      results: [...results],
    });
  }

  function randomBetween(min, max) {
    return min + Math.random() * (max - min);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function waitForTabLoad(tabId, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("tab load timed out"));
      }, timeoutMs);

      function listener(updatedTabId, changeInfo) {
        if (updatedTabId === tabId && changeInfo.status === "complete") {
          cleanup();
          resolve();
        }
      }

      function cleanup() {
        clearTimeout(timeout);
        tabs.onUpdated.removeListener(listener);
      }

      tabs.onUpdated.addListener(listener);
    });
  }

  async function openInHuntTab(url) {
    if (huntTabId === null) {
      const tab = await tabs.create({ url, active: false });
      huntTabId = tab.id;
    } else {
      await tabs.update(huntTabId, { url, active: false });
    }
    return huntTabId;
  }

  async function extractCards(tabId) {
    const response = await tabs.sendMessage(tabId, { type: "RECRUITME_EXTRACT_RESULTS" });
    return response;
  }

  async function postCards(jobId, cards, location) {
    return requestRecruitMe("/api/hunt/cards", {
      method: "POST",
      body: JSON.stringify({ jobId, cards, location }),
    });
  }

  async function handleSearch(action) {
    lastAction = "search";
    emitProgress();

    const url = SEARCH_URL_PREFIX + encodeURIComponent(action.query);
    const tabId = await openInHuntTab(url);

    try {
      await waitForTabLoad(tabId, 30000);
      await sleep(randomBetween(1500, 3000));

      const reply = await extractCards(tabId);

      if (reply.ok) {
        const serverResult = await postCards(state.jobId, reply.cards, action.query);
        results = serverResult.results || [];
        state = applyEvent(state, { type: "cards", queryIndex: action.queryIndex, cards: serverResult.results || [] }, now());
      } else if (reply.reason === "authwall") {
        state = applyEvent(state, { type: "authwall" }, now());
      } else {
        warnings.push(`extraction failed for query "${action.query}": ${reply.detail || "unknown"}`);
        state = applyEvent(state, { type: "cards", queryIndex: action.queryIndex, cards: [] }, now());
      }
    } catch (err) {
      warnings.push(`search failed for query "${action.query}": ${err.message}`);
      state = applyEvent(state, { type: "cards", queryIndex: action.queryIndex, cards: [] }, now());
    }

    emitProgress();
  }

  async function handleOpenProfile(action) {
    lastAction = "openProfile";
    emitProgress();

    const tabId = await openInHuntTab(action.url);

    try {
      await waitForTabLoad(tabId, 30000);
      await sleep(randomBetween(6000, 10000));

      const tab = await tabs.get(tabId);
      const isAuthWall = AUTH_WALL_MARKERS.some((marker) => tab.url && tab.url.includes(marker));

      if (isAuthWall) {
        state = applyEvent(state, { type: "profileFailed", url: action.url, error: "auth wall" }, now());
        state = applyEvent(state, { type: "authwall" }, now());
      } else {
        state = applyEvent(state, { type: "profileCaptured", url: action.url }, now());
      }
    } catch (err) {
      state = applyEvent(state, { type: "profileFailed", url: action.url, error: err.message }, now());
    }

    emitProgress();
  }

  async function handleWait(action) {
    lastAction = "wait";
    emitProgress();
    const delay = action.untilMs - now();
    if (delay > 0) {
      await sleep(delay);
    }
  }

  async function runLoop() {
    while (running && !aborted) {
      const action = nextAction(state, now());

      if (action.type === "done" || action.type === "halted") {
        lastAction = action.type;
        emitProgress();
        break;
      }

      if (action.type === "search") {
        await handleSearch(action);
      } else if (action.type === "openProfile") {
        await handleOpenProfile(action);
      } else if (action.type === "wait") {
        await handleWait(action);
      } else {
        warnings.push(`unknown action type: ${action.type}`);
        break;
      }
    }

    // Cleanup
    if (huntTabId !== null) {
      try {
        await tabs.remove(huntTabId);
      } catch (err) {
        warnings.push(`failed to close hunt tab: ${err.message}`);
      }
      huntTabId = null;
    }

    running = false;
    emitProgress();
  }

  return {
    /**
     * Start a hunt. Rejects if one is already running.
     * @param {Object} plan - { jobId, queries, limits }
     */
    async start(plan) {
      if (running) {
        throw new Error("a hunt is already running");
      }

      running = true;
      aborted = false;
      warnings = [];
      results = [];
      lastAction = "start";
      state = createHunt(plan);
      emitProgress();

      await runLoop();
    },

    /**
     * Abort the current hunt.
     */
    abort() {
      if (!running) return;
      aborted = true;
      state = applyEvent(state, { type: "abort" }, now());
      emitProgress();
    },

    /**
     * Get the current state snapshot.
     */
    getState() {
      return {
        running,
        jobId: state?.jobId,
        queriesRun: state?.queriesRun ?? 0,
        totalQueries: state?.totalQueries ?? 0,
        seenCount: state?.seenCount ?? 0,
        capturedCount: state?.capturedCount ?? 0,
        halted: state?.halted ?? null,
        warnings: [...warnings],
        lastAction,
        results: [...results],
      };
    },
  };
}
