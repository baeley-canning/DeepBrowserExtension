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
import { describe, expect, it } from "vitest";
import { createHunt, nextAction, applyEvent } from "./hunt-queue.js";

const PLAN = {
  jobId: "job-1",
  queries: [
    { query: "Network Operations Manager", rationale: "Alternative title" },
    { query: "Observability Manager", rationale: "Alternative title" },
  ],
  limits: { maxPages: 2, maxProfiles: 3, minMsBetweenProfiles: 4000 },
};

const card = (slug) => ({
  url: `https://www.linkedin.com/in/${slug}`,
  name: slug,
  headline: "Engineer",
  location: "Wellington",
});

describe("hunt queue — running the searches", () => {
  it("starts by running the first query", () => {
    const s = createHunt(PLAN);
    expect(nextAction(s, 0)).toEqual({ type: "search", query: "Network Operations Manager", queryIndex: 0 });
  });

  it("moves to the next query once the first has been extracted", () => {
    let s = createHunt(PLAN);
    s = applyEvent(s, { type: "cards", queryIndex: 0, cards: [card("a")] }, 0);
    // Profiles come first, but once they are exhausted the next query runs.
    s = applyEvent(s, { type: "profileCaptured", url: card("a").url }, 0);
    expect(nextAction(s, 999_999)).toEqual({ type: "search", query: "Observability Manager", queryIndex: 1 });
  });

  it("finishes when every query has run and every profile is captured", () => {
    let s = createHunt({ ...PLAN, queries: [PLAN.queries[0]] });
    s = applyEvent(s, { type: "cards", queryIndex: 0, cards: [card("a")] }, 0);
    s = applyEvent(s, { type: "profileCaptured", url: card("a").url }, 0);
    expect(nextAction(s, 999_999)).toEqual({ type: "done" });
  });
});

describe("hunt queue — opening profiles", () => {
  it("opens a profile from the cards it was given", () => {
    let s = createHunt(PLAN);
    s = applyEvent(s, { type: "cards", queryIndex: 0, cards: [card("a"), card("b")] }, 0);
    expect(nextAction(s, 999_999)).toEqual({ type: "openProfile", url: card("a").url });
  });

  it("waits out the pacing gap rather than opening immediately", () => {
    let s = createHunt(PLAN);
    s = applyEvent(s, { type: "cards", queryIndex: 0, cards: [card("a"), card("b")] }, 0);
    s = applyEvent(s, { type: "profileCaptured", url: card("a").url }, 10_000);
    // 4s minimum gap; only 1s has passed.
    const soon = nextAction(s, 11_000);
    expect(soon.type).toBe("wait");
    expect(soon.untilMs).toBe(14_000);
    // After the gap, it proceeds.
    expect(nextAction(s, 14_001)).toEqual({ type: "openProfile", url: card("b").url });
  });

  it("never opens the same profile twice, even across different queries", () => {
    let s = createHunt(PLAN);
    s = applyEvent(s, { type: "cards", queryIndex: 0, cards: [card("a")] }, 0);
    s = applyEvent(s, { type: "profileCaptured", url: card("a").url }, 0);
    s = applyEvent(s, { type: "cards", queryIndex: 1, cards: [card("a"), card("b")] }, 0);
    expect(nextAction(s, 999_999)).toEqual({ type: "openProfile", url: card("b").url });
  });

  it("stops opening profiles at the cap and reports done", () => {
    let s = createHunt(PLAN); // maxProfiles: 3
    s = applyEvent(s, { type: "cards", queryIndex: 0, cards: ["a", "b", "c", "d", "e"].map(card) }, 0);
    for (const slug of ["a", "b", "c"]) {
      s = applyEvent(s, { type: "profileCaptured", url: card(slug).url }, 0);
    }
    expect(s.capturedCount).toBe(3);
    expect(nextAction(s, 999_999).type).not.toBe("openProfile");
  });

  it("counts a failed profile against the cap too — a retry loop is what flags an account", () => {
    let s = createHunt(PLAN);
    s = applyEvent(s, { type: "cards", queryIndex: 0, cards: ["a", "b", "c", "d"].map(card) }, 0);
    s = applyEvent(s, { type: "profileFailed", url: card("a").url, error: "timeout" }, 0);
    s = applyEvent(s, { type: "profileFailed", url: card("b").url, error: "timeout" }, 0);
    s = applyEvent(s, { type: "profileFailed", url: card("c").url, error: "timeout" }, 0);
    expect(nextAction(s, 999_999).type).not.toBe("openProfile");
  });

  it("does not retry a profile that failed", () => {
    let s = createHunt(PLAN);
    s = applyEvent(s, { type: "cards", queryIndex: 0, cards: [card("a"), card("b")] }, 0);
    s = applyEvent(s, { type: "profileFailed", url: card("a").url, error: "timeout" }, 0);
    expect(nextAction(s, 999_999)).toEqual({ type: "openProfile", url: card("b").url });
  });
});

describe("hunt queue — stopping loudly", () => {
  it("halts permanently on an auth wall and never resumes", () => {
    let s = createHunt(PLAN);
    s = applyEvent(s, { type: "cards", queryIndex: 0, cards: [card("a"), card("b")] }, 0);
    s = applyEvent(s, { type: "authwall" }, 0);
    const a = nextAction(s, 999_999);
    expect(a.type).toBe("halted");
    expect(a.reason).toMatch(/auth/i);
    // Even after more events, it stays halted — no silent resumption.
    s = applyEvent(s, { type: "profileCaptured", url: card("a").url }, 1_000_000);
    expect(nextAction(s, 2_000_000).type).toBe("halted");
  });

  it("treats zero cards as a problem to surface, not an empty result", () => {
    // A results page that yields nothing means our selectors broke or the page
    // never rendered. Reporting "no candidates" would be indistinguishable from
    // a genuinely empty search.
    let s = createHunt(PLAN);
    s = applyEvent(s, { type: "cards", queryIndex: 0, cards: [] }, 0);
    expect(s.emptyQueries).toContain(0);
  });

  it("halts when EVERY query returned zero cards — that is breakage, not a market", () => {
    let s = createHunt(PLAN);
    s = applyEvent(s, { type: "cards", queryIndex: 0, cards: [] }, 0);
    s = applyEvent(s, { type: "cards", queryIndex: 1, cards: [] }, 0);
    const a = nextAction(s, 999_999);
    expect(a.type).toBe("halted");
    expect(a.reason).toMatch(/no candidates|zero|extract/i);
  });

  it("does not halt when only some queries were empty", () => {
    let s = createHunt(PLAN);
    s = applyEvent(s, { type: "cards", queryIndex: 0, cards: [] }, 0);
    s = applyEvent(s, { type: "cards", queryIndex: 1, cards: [card("a")] }, 0);
    expect(nextAction(s, 999_999)).toEqual({ type: "openProfile", url: card("a").url });
  });

  it("can be stopped by the human at any moment", () => {
    let s = createHunt(PLAN);
    s = applyEvent(s, { type: "cards", queryIndex: 0, cards: [card("a")] }, 0);
    s = applyEvent(s, { type: "abort" }, 0);
    expect(nextAction(s, 999_999).type).toBe("halted");
  });
});

describe("hunt queue — reporting progress", () => {
  it("exposes counts the popup can render without recomputing anything", () => {
    let s = createHunt(PLAN);
    s = applyEvent(s, { type: "cards", queryIndex: 0, cards: [card("a"), card("b")] }, 0);
    s = applyEvent(s, { type: "profileCaptured", url: card("a").url }, 0);
    expect(s.seenCount).toBe(2);
    expect(s.capturedCount).toBe(1);
    expect(s.queriesRun).toBe(1);
    expect(s.totalQueries).toBe(2);
  });

  it("never throws on unknown events or junk state", () => {
    const s = createHunt(PLAN);
    expect(() => applyEvent(s, { type: "nonsense" }, 0)).not.toThrow();
    expect(() => applyEvent(s, null, 0)).not.toThrow();
    expect(() => nextAction(createHunt({ queries: [], limits: {} }), 0)).not.toThrow();
  });
});
