/**
 * Parsing a LinkedIn people-search result card.
 *
 * These rules are a port of harvestVisibleCards() in
 * scraper-worker/src/scrapers/linkedin-search.ts, which is proven in
 * production — on 2026-08-12 it harvested 7 cards, 7 with names, across three
 * pages of a live search. Keeping ONE set of rules means the extension and the
 * box agree about what a candidate is; two implementations would drift and we
 * would be debugging "why does the extension see different people".
 *
 * Deliberately pure: it takes the anchor's href plus the card container's
 * visible text lines. No DOM, no querySelector, no browser. The content script
 * does the trivial job of collecting those two things; every judgement about
 * what the text MEANS is tested here.
 *
 * Card text on LinkedIn looks like:
 *
 *     Runika Mathur
 *     • 2nd
 *     Senior Software Engineer at Xero
 *     Wellington, New Zealand
 *     Message
 *
 * with the degree line, action buttons, "Current:" prefixes and
 * "X and Y are mutual connections" all needing to be ignored.
 */
import { describe, expect, it } from "vitest";
import { parseCard, slugFromProfileUrl } from "./card-parse.js";

const HREF = "https://www.linkedin.com/in/runika-mathur/";

describe("slugFromProfileUrl", () => {
  it("pulls the slug from a canonical profile URL", () => {
    expect(slugFromProfileUrl(HREF)).toBe("runika-mathur");
  });

  it("ignores query strings and tracking params", () => {
    expect(slugFromProfileUrl("https://www.linkedin.com/in/jane-doe?miniProfileUrn=abc&trk=xyz")).toBe("jane-doe");
  });

  it("handles regional subdomains", () => {
    expect(slugFromProfileUrl("https://nz.linkedin.com/in/kiwi-dev/")).toBe("kiwi-dev");
  });

  it("rejects anything that is not a profile URL", () => {
    for (const bad of [
      "https://www.linkedin.com/company/xero",
      "https://www.linkedin.com/feed/",
      "https://notlinkedin.com/in/someone",
      "",
      null,
      undefined,
      "not a url",
    ]) {
      expect(slugFromProfileUrl(bad)).toBeNull();
    }
  });
});

describe("parseCard — the shape LinkedIn actually renders", () => {
  it("reads name, headline and location from a standard card", () => {
    const card = parseCard(HREF, [
      "Runika Mathur",
      "• 2nd",
      "Senior Software Engineer at Xero",
      "Wellington, New Zealand",
      "Message",
    ]);
    expect(card).toEqual({
      url: "https://www.linkedin.com/in/runika-mathur",
      slug: "runika-mathur",
      name: "Runika Mathur",
      headline: "Senior Software Engineer at Xero",
      location: "Wellington, New Zealand",
    });
  });

  it("strips a degree suffix that shares the name's line", () => {
    const card = parseCard(HREF, ["Runika Mathur • 2nd", "Senior Engineer", "Wellington"]);
    expect(card.name).toBe("Runika Mathur");
  });

  it("skips action buttons wherever they appear", () => {
    const card = parseCard(HREF, [
      "Jane Doe",
      "Connect",
      "Full Stack Developer at PaperKite",
      "Following",
      "Lower Hutt, Wellington, New Zealand",
      "View Jane's profile",
    ]);
    expect(card.headline).toBe("Full Stack Developer at PaperKite");
    expect(card.location).toBe("Lower Hutt, Wellington, New Zealand");
  });

  it("ignores mutual-connection chatter, which names OTHER people", () => {
    const card = parseCard(HREF, [
      "Jane Doe",
      "• 3rd",
      "Software Engineer",
      "Auckland, New Zealand",
      "Teresa Jordan and Han Li are mutual connections",
    ]);
    expect(card.location).toBe("Auckland, New Zealand");
  });

  it("drops a 'Current:' line rather than reading it as the location", () => {
    const card = parseCard(HREF, ["Jane Doe", "• 2nd", "Developer", "Current: Engineer at Xero", "Wellington"]);
    expect(card.location).toBe("Wellington");
  });
});

describe("parseCard — refusing things that are not search results", () => {
  it("returns null with no usable name", () => {
    expect(parseCard(HREF, [])).toBeNull();
    expect(parseCard(HREF, ["Connect", "Message"])).toBeNull();
  });

  it("returns null for a name-only anchor with no headline AND no location", () => {
    // "People also viewed" and mutual-connection links are bare name anchors.
    // Real result cards always carry a headline or at least a location.
    expect(parseCard(HREF, ["Teresa Jordan"])).toBeNull();
  });

  it("keeps a card that has only one detail line", () => {
    // With a single line after the name there is no positional way to know
    // whether it is a headline or a location, and guessing would be worse than
    // useless. What matters is that the card SURVIVES and the text is kept —
    // a real person with a sparse card is still a lead.
    const card = parseCard(HREF, ["Jane Doe", "Wellington, New Zealand"]);
    expect(card).not.toBeNull();
    expect([card.headline, card.location]).toContain("Wellington, New Zealand");
  });

  it("rejects a non-profile href even with perfect text", () => {
    expect(parseCard("https://www.linkedin.com/company/xero", ["Xero", "Software company"])).toBeNull();
  });

  it("never uses a URL or an overlong string as the name", () => {
    // It should skip the implausible line and keep looking, not abort the card
    // — LinkedIn puts all sorts of debris in the first line.
    const withUrl = parseCard(HREF, ["https://spam.example.com", "Engineer", "Wellington"]);
    expect(withUrl?.name).not.toBe("https://spam.example.com");
    const withLongLine = parseCard(HREF, ["x".repeat(80), "Engineer", "Wellington"]);
    expect(withLongLine?.name).not.toBe("x".repeat(80));
  });

  it("never throws on junk input", () => {
    for (const lines of [null, undefined, "not an array", [null, undefined, 42], [""], ["   "]]) {
      expect(() => parseCard(HREF, lines)).not.toThrow();
    }
  });
});

describe("parseCard — the URL it stores", () => {
  it("normalises to a bare canonical profile URL, so dedupe works", () => {
    const a = parseCard("https://www.linkedin.com/in/jane-doe/?trk=abc", ["Jane Doe", "Dev", "Wellington"]);
    const b = parseCard("https://nz.linkedin.com/in/jane-doe", ["Jane Doe", "Dev", "Wellington"]);
    expect(a.url).toBe(b.url);
    expect(a.url).toBe("https://www.linkedin.com/in/jane-doe");
  });
});
