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
 */
// NOTE: do NOT import URL from "node:url" here. This file is dynamically
// imported as an ES module BY THE BROWSER (agent-page.js / results-content.js),
// and a bare "node:url" specifier cannot be resolved outside Node — the whole
// import fails with "Failed to fetch dynamically imported module". The URL
// global exists in both browsers and Node.js, so the global is always used.

/** @param {string} line */
function cleanLine(line) {
  if (typeof line !== "string") return null;
  const beforeSeparator = line.split(" • ")[0];
  const trimmed = beforeSeparator.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** @param {string} line */
function isActionWord(line) {
  if (typeof line !== "string") return false;
  const lower = line.trim().toLowerCase();
  if (lower === "connect" || lower === "message" || lower === "follow" || lower === "following" ||
      lower === "pending" || lower === "save" || lower === "connection" || lower === "connections") {
    return true;
  }
  return /^view .+ profile$/.test(lower);
}

/** @param {string} line */
function isPlausibleName(line) {
  const cleaned = cleanLine(line);
  if (!cleaned) return false;
  if (cleaned.length > 60) return false;
  if (/^https?:/i.test(cleaned)) return false;
  if (isActionWord(cleaned)) return false;
  return true;
}

/** "https://www.linkedin.com/in/jane-doe?trk=x" -> "jane-doe"; null if not a profile URL. */
export function slugFromProfileUrl(href) {
  if (typeof href !== "string" || href.trim() === "") return null;
  try {
    const url = new URL(href);
    const host = url.hostname.toLowerCase();
    if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "in" || parts.length < 2) return null;
    return decodeURIComponent(parts[1]);
  } catch {
    return null;
  }
}

/**
 * @param {string} href  the anchor's href
 * @param {string[]} lines  visible text lines of the card container, in order
 * @returns {{url,slug,name,headline,location}|null}
 */
export function parseCard(href, lines) {
  const slug = slugFromProfileUrl(href);
  if (!slug) return null;

  if (!Array.isArray(lines)) return null;
  const textLines = lines.filter((l) => typeof l === "string");

  let name = null;
  let nameIndex = -1;
  for (let i = 0; i < textLines.length; i++) {
    const cleaned = cleanLine(textLines[i]);
    if (cleaned && isPlausibleName(cleaned)) {
      name = cleaned;
      nameIndex = i;
      break;
    }
  }
  if (!name) return null;

  const afterName = textLines.slice(nameIndex + 1);
  const usefulLines = [];
  for (const line of afterName) {
    const l = line.trim();
    if (!l) continue;
    if (l.startsWith("•")) continue;
    if (isActionWord(l)) continue;
    if (/^current:/i.test(l)) continue;
    if (l.toLowerCase().includes("mutual connection")) continue;
    usefulLines.push(l);
  }

  const headline = usefulLines[0] || null;
  const location = usefulLines[1] || null;

  if (!headline && !location) return null;

  return {
    url: `https://www.linkedin.com/in/${slug}`,
    slug,
    name,
    headline,
    location,
  };
}
