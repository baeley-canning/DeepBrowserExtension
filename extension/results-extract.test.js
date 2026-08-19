/**
 * Reading a results page into cards — and, more importantly, telling the
 * difference between "LinkedIn has nobody" and "our extractor broke".
 *
 * Those two look identical from the outside, and confusing them is the exact
 * silent-failure class this codebase keeps getting bitten by: on 2026-08-12 a
 * SEEK search reported success on 0 cards, and a LinkedIn search reported
 * failure while holding 4 real candidates. A hunt that quietly says "no
 * candidates found" when its selectors have rotted is worse than one that
 * crashes.
 */
import { describe, expect, it } from "vitest";
import { extractResultsPage } from "./results-extract.js";
import { parseCard } from "./card-parse.js";

/** Minimal stand-in for a card container element. */
function el(lines, href) {
  const node = {
    innerText: lines.join("\n"),
    closest: () => node,
    parentElement: null,
    href,
  };
  return node;
}

/** Fake document whose querySelectorAll returns anchors bound to containers. */
function fakeDoc(cards, bodyText = "") {
  const anchors = cards.map(({ href, lines }) => {
    const container = el(lines, href);
    return { href, closest: () => container, parentElement: container };
  });
  return { querySelectorAll: () => anchors, body: { innerText: bodyText } };
}

const loc = (href = "https://www.linkedin.com/search/results/people/?keywords=x") => ({ href });

describe("extractResultsPage", () => {
  it("turns anchors plus their card text into candidates", () => {
    const doc = fakeDoc([
      {
        href: "https://www.linkedin.com/in/jane-doe",
        lines: ["Jane Doe", "• 2nd", "Senior Software Engineer at Xero", "Wellington, New Zealand"],
      },
      {
        href: "https://www.linkedin.com/in/sam-smith",
        lines: ["Sam Smith", "Network Operations Manager at Spark", "Auckland, New Zealand"],
      },
    ]);
    const out = extractResultsPage(parseCard, doc, loc());
    expect(out.ok).toBe(true);
    expect(out.cards.map((c) => c.name)).toEqual(["Jane Doe", "Sam Smith"]);
    expect(out.cards[0].headline).toBe("Senior Software Engineer at Xero");
  });

  it("keeps one entry per person when they appear more than once on the page", () => {
    const same = {
      href: "https://www.linkedin.com/in/jane-doe",
      lines: ["Jane Doe", "Engineer", "Wellington"],
    };
    const out = extractResultsPage(parseCard, fakeDoc([same, same, same]), loc());
    expect(out.cards).toHaveLength(1);
  });

  it("reports an auth wall instead of pretending the page was empty", () => {
    const out = extractResultsPage(parseCard, fakeDoc([]), loc("https://www.linkedin.com/authwall?x=1"));
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("authwall");
  });

  it("accepts a genuine zero ONLY when LinkedIn says so itself", () => {
    const doc = fakeDoc([], "No results found. Try different keywords.");
    const out = extractResultsPage(parseCard, doc, loc());
    expect(out.ok).toBe(true);
    expect(out.cards).toEqual([]);
  });

  it("reports extraction failure when nothing parsed and there is no no-results marker", () => {
    // Profile links present but no card text parsed => our selectors rotted.
    const doc = fakeDoc(
      [{ href: "https://www.linkedin.com/in/jane-doe", lines: [] }],
      "Some unrelated page content",
    );
    const out = extractResultsPage(parseCard, doc, loc());
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("extraction-failed");
    expect(out.detail).toMatch(/1 profile link/i);
  });

  it("reports extraction failure on a page with no profile links at all", () => {
    const out = extractResultsPage(parseCard, fakeDoc([], "Something else entirely"), loc());
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("extraction-failed");
  });

  it("never throws on a hostile or malformed page", () => {
    const nasty = { querySelectorAll: () => [{ href: null, closest: () => null }], body: null };
    expect(() => extractResultsPage(parseCard, nasty, loc())).not.toThrow();
  });
});
