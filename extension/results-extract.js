/**
 * Read a LinkedIn people-search results page into candidate cards.
 *
 * This is the thin DOM shim. It collects two things per result — the profile
 * anchor's href and the card container's visible text lines — and hands them to
 * parseCard() in card-parse.js, which holds every judgement and is fully unit
 * tested. Nothing here decides what a candidate IS.
 *
 * Anchoring strategy: find `a[href*="/in/"]` and group by profile slug, exactly
 * as harvestVisibleCards() does in the headless worker. LinkedIn's class names
 * are obfuscated and churn; profile hrefs and visible text do not. We
 * deliberately do NOT use the accessibility tree — reaching it cheaply needs
 * chrome.debugger, which would put a permanent "extension is debugging this
 * browser" banner in the recruiter's daily session for no capability we need.
 *
 * ZERO CARDS IS AN ERROR, NOT AN EMPTY RESULT. A results page that yields
 * nothing means the selectors broke or the page never rendered; reporting "no
 * candidates" would be indistinguishable from a genuinely empty search. That
 * confusion is the exact silent-failure class this codebase keeps getting bitten
 * by, so we distinguish the two by looking for LinkedIn's own no-results marker.
 */

const AUTH_WALL = /\/(checkpoint|authwall|uas\/login|login)/i;
const NO_RESULTS = /no results found|try (?:different|removing some) keywords|didn.t match any/i;

/** Climb from an anchor to the smallest ancestor that looks like a result card. */
function cardContainer(anchor) {
  return (
    anchor.closest('li, [role="listitem"]') ||
    anchor.parentElement?.parentElement?.parentElement ||
    anchor.parentElement ||
    null
  );
}

function visibleLines(el) {
  if (!el) return [];
  return String(el.innerText || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Extract every result card on the current page.
 *
 * @param {(href: string, lines: string[]) => object|null} parseCard
 * @returns {{ok: true, cards: object[]} | {ok: false, reason: string, detail?: string}}
 */
export function extractResultsPage(parseCard, doc = document, loc = location) {
  if (AUTH_WALL.test(String(loc.href || ""))) {
    return { ok: false, reason: "authwall", detail: String(loc.href) };
  }

  const anchors = Array.from(doc.querySelectorAll('a[href*="/in/"]'));
  const bySlug = new Map();

  for (const a of anchors) {
    const container = cardContainer(a);
    const card = parseCard(a.href, visibleLines(container));
    if (!card) continue;
    // First occurrence wins: the first anchor for a person sits in their own
    // card, later ones are "also viewed" or mutual-connection links.
    if (!bySlug.has(card.slug)) bySlug.set(card.slug, card);
  }

  const cards = [...bySlug.values()];
  if (cards.length > 0) return { ok: true, cards };

  // Nothing parsed. Only LinkedIn's own marker makes that legitimate.
  const bodyText = String(doc.body?.innerText || "");
  if (NO_RESULTS.test(bodyText)) return { ok: true, cards: [] };

  return {
    ok: false,
    reason: "extraction-failed",
    detail:
      `Found ${anchors.length} profile link(s) but parsed 0 cards, and LinkedIn did not render ` +
      `its "no results" message. The page layout has probably changed.`,
  };
}

// NOTE: this file is an ES module so it can be unit tested, which means it can
// NEVER be listed directly in manifest content_scripts — MV3 content scripts are
// classic scripts, and a top-level `export` is a syntax error that makes the
// whole script fail to load with nothing in the page console to explain it.
// results-content.js is the classic loader that dynamic-imports this.
