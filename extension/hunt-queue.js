/**
 * The trawl state machine.
 *
 * Everything that decides WHAT THE BROWSER DOES NEXT lives here, as a pure
 * function of state, so pacing and stop-conditions are testable instead of
 * buried in tab callbacks. This matters more than usual: on 2026-08-12 a
 * fast-failing loop in the headless worker ran roughly six times faster than
 * intended and got the owner's LinkedIn account flagged. That loop's pacing was
 * spread across callbacks and nobody could see it. This one is a reducer.
 *
 * It runs in the recruiter's OWN logged-in session, so the cost of getting it
 * wrong is their daily account, not a bot's.
 *
 * Contract: `nextAction(state, nowMs)` returns what to do now; the caller
 * applies events back with `applyEvent`. The machine never opens anything
 * itself.
 */

/**
 * Build initial state from a plan.
 * @param {Object} plan - { jobId, queries, limits }
 * @returns {Object} initial state
 */
export function createHunt(plan) {
  const queries = Array.isArray(plan?.queries) ? plan.queries : [];
  const limits = plan?.limits || {};
  const maxProfiles = limits.maxProfiles ?? 10;
  const minMsBetweenProfiles = limits.minMsBetweenProfiles ?? 4000;

  return {
    jobId: plan?.jobId,
    queries,
    limits: { ...limits, maxProfiles, minMsBetweenProfiles },
    queriesRun: 0,
    totalQueries: queries.length,
    emptyQueries: [],
    queue: [],
    seen: new Set(),
    capturedCount: 0,
    seenCount: 0,
    lastProfileAtMs: null,
    halted: null,
  };
}

/**
 * What should happen now? Pure — never mutates, never performs the action.
 * @param {Object} state
 * @param {number} nowMs
 * @returns {Object} action
 */
export function nextAction(state, nowMs) {
  if (state.halted) {
    return { type: "halted", reason: state.halted };
  }

  // All queries run and all empty → breakage, halt loudly.
  if (
    state.queriesRun === state.totalQueries &&
    state.totalQueries > 0 &&
    state.emptyQueries.length === state.totalQueries
  ) {
    return {
      type: "halted",
      reason: "no candidates could be extracted — every query returned zero cards",
    };
  }

  // Profiles take priority over starting the next search.
  if (state.queue.length > 0 && state.capturedCount < state.limits.maxProfiles) {
    if (state.lastProfileAtMs !== null) {
      const gap = state.limits.minMsBetweenProfiles;
      const untilMs = state.lastProfileAtMs + gap;
      if (nowMs < untilMs) {
        return { type: "wait", untilMs };
      }
    }
    return { type: "openProfile", url: state.queue[0] };
  }

  // Next unrun query.
  if (state.queriesRun < state.totalQueries) {
    const queryIndex = state.queriesRun;
    return {
      type: "search",
      query: state.queries[queryIndex].query,
      queryIndex,
    };
  }

  return { type: "done" };
}

/**
 * Fold an event into state, returning NEW state. Pure.
 * @param {Object} state
 * @param {Object} event
 * @param {number} nowMs
 * @returns {Object} new state
 */
export function applyEvent(state, event, nowMs) {
  if (!event || typeof event !== "object" || !event.type) {
    return state;
  }

  switch (event.type) {
    case "cards": {
      if (
        !Number.isInteger(event.queryIndex) ||
        event.queryIndex < 0 ||
        event.queryIndex >= state.totalQueries ||
        !Array.isArray(event.cards)
      ) {
        return state;
      }

      const newQueue = [...state.queue];
      const newSeen = new Set(state.seen);
      let newSeenCount = state.seenCount;

      for (const card of event.cards) {
        if (card && typeof card.url === "string" && !newSeen.has(card.url)) {
          newSeen.add(card.url);
          newQueue.push(card.url);
          newSeenCount++;
        }
      }

      const newEmptyQueries =
        event.cards.length === 0
          ? [...state.emptyQueries, event.queryIndex]
          : state.emptyQueries;

      return {
        ...state,
        queue: newQueue,
        seen: newSeen,
        seenCount: newSeenCount,
        queriesRun: state.queriesRun + 1,
        emptyQueries: newEmptyQueries,
      };
    }

    case "profileCaptured":
    case "profileFailed": {
      if (typeof event.url !== "string") {
        return state;
      }
      return {
        ...state,
        queue: state.queue.filter((url) => url !== event.url),
        capturedCount: state.capturedCount + 1,
        lastProfileAtMs: nowMs,
      };
    }

    case "authwall":
      return { ...state, halted: "auth wall detected — stopping" };

    case "abort":
      return { ...state, halted: "aborted by user" };

    default:
      return state;
  }
}
