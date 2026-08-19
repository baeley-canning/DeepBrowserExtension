const OBSERVE_INTERVAL_MS = 2500;
const MIN_EXPANDED_PROFILE_TEXT_CHARS = 1100;

const SAFE_SECTION_HEADING_RE =
  /\b(about|experience|education|licenses|certifications|skills|top skills)\b/i;
const BLOCKED_SECTION_HEADING_RE =
  /\b(activity|posts|featured|recommendations|interests|people also viewed|more profiles for you|people you may know|pages for you|explore premium profiles|groups|services)\b/i;

const STOP_LINE_PATTERNS = [
  /^more profiles for you$/i,
  /^people you may know$/i,
  /^pages for you$/i,
  /^explore premium profiles$/i,
  /^linkedin corporation/i,
  /^recommendation transparency$/i,
  /^select language$/i,
  /^manage your account and privacy$/i,
  /^visit our help center\.$/i,
];

const NOISE_LINE_PATTERNS = [
  /^message$/i,
  /^follow$/i,
  /^connect$/i,
  /^contact info$/i,
  /^save in sales navigator$/i,
  /^activity$/i,
  /^open to$/i,
  /^more$/i,
  /^show all$/i,
  /^show all\s+[\u2192>]$/i,
  /^show all \d+ .+$/i,
  /^see all$/i,
  /^see all \d+ .+$/i,
  /^\u2026\s*more$/i,
  /^\.{3}\s*more$/i,
  /^[\u00b7\u2022]?\s*\d+(st|nd|rd|th)$/i,
  /^connections?$/i,
  /^followers$/i,
  /^\d+\+?\s+connections?$/i,
  /^\d+\+?\s+followers$/i,
  /^\d+\s+endorsements?$/i,
  /^.* has no recent posts$/i,
  /^recent posts .* displayed here\.$/i,
  /^from .* industry$/i,
  /^.{3,60} is a mutual connection$/i,
  /^\d+ mutual connections?$/i,
  /^you(?:'re| are) connected$/i,
  /^\d+ connections? in common$/i,
];

const INTRO_NAME_SELECTORS = [
  "h1.text-heading-xlarge",
  "h1.inline.t-24.v-align-middle.break-words",
  "h1",
];

const INTRO_HEADLINE_SELECTORS = [
  ".pv-text-details__left-panel .text-body-medium",
  ".text-body-medium.break-words",
  ".pv-top-card .text-body-medium",
];

const INTRO_LOCATION_SELECTORS = [
  ".pv-text-details__left-panel .text-body-small.inline.t-black--light.break-words",
  ".pv-text-details__left-panel .text-body-small",
  ".text-body-small.inline.t-black--light.break-words",
  ".pv-top-card .text-body-small",
];

const SECTION_CONTAINER_SELECTOR =
  "section, div.artdeco-card, div.pvs-card, div[data-view-name], div[data-section]";

const PROFILE_SECTION_DEFINITIONS = [
  { key: "about", label: "About", ids: ["about", "summary"], headingRe: /^about$/i },
  { key: "experience", label: "Experience", ids: ["experience"], headingRe: /^experience$/i },
  { key: "education", label: "Education", ids: ["education"], headingRe: /^education$/i },
  { key: "skills", label: "Top skills", ids: ["skills"], headingRe: /^(skills|top skills)$/i },
  {
    key: "licenses_certifications",
    label: "Licenses & certifications",
    ids: ["licenses certifications", "licenses and certifications", "certifications"],
    headingRe: /licenses|certifications/i,
  },
];

const CORE_SECTION_KEYS = new Set(["about", "experience", "education", "skills", "licenses_certifications"]);

let lastObservedUrl = "";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLinkedInProfilePage() {
  return /linkedin\.com\/in\//i.test(location.href);
}

function isRootLinkedInProfile(url = "") {
  // Root profile only — excludes sub-pages like /details/experience
  return /linkedin\.com\/in\/[^/?#]+\/?([?#].*)?$/i.test(url);
}

function cleanText(value) {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeLineKey(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function normalizeSectionKey(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function splitIntoLines(value) {
  return cleanText(value)
    .split(/\n+/)
    .map((line) => cleanText(line))
    .filter(Boolean);
}

function isVisible(element) {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isNearViewport(element) {
  const rect = element.getBoundingClientRect();
  return rect.bottom >= -140 && rect.top <= window.innerHeight + 140;
}

// Lines like {"data":{"$type":"...","trackingId":"..."} or
// urn:li:fsd_profile:ACoAAB... — LinkedIn's hydration/tracking payloads.
// They sneak in when textContent is read on detached documents or when a
// future LinkedIn layout starts rendering <code>/<pre> blocks visibly.
function looksLikeJsonOrTrackingNoise(line) {
  if (!line) return false;
  if (line.length < 12) return false;
  if (/^[{[]/.test(line)) return true;
  if (/"\$type"|"trackingId"|"urn:li:|urn:li:fsd_|"include":|"\*elements":/i.test(line)) return true;
  // High-density punctuation gate — only fires on lines that ALSO contain a
  // JSON-structural char ("/{/}/[/]). Skill CSVs like "AWS, GCP, Azure, K8s,
  // DDD, TDD" can hit ~18% comma/colon density but contain no JSON tokens, so
  // requiring quotes-or-braces saves them from a false positive.
  if (line.length > 80 && /["{}[\]]/.test(line)) {
    const punct = (line.match(/["{}[\]:,]/g) || []).length;
    if (punct / line.length > 0.18) return true;
  }
  return false;
}

function filterProfileLines(lines) {
  const filtered = [];
  const seen = new Set();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (STOP_LINE_PATTERNS.some((pattern) => pattern.test(line))) break;
    if (NOISE_LINE_PATTERNS.some((pattern) => pattern.test(line))) continue;
    if (looksLikeJsonOrTrackingNoise(line)) continue;
    if (/^\d+$/.test(line) && /^(connections?|followers)$/i.test(lines[i + 1] || "")) {
      i += 1;
      continue;
    }
    if (/^about accessibility talent solutions/i.test(line)) break;

    const key = normalizeLineKey(line);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    filtered.push(line);
  }

  return filtered;
}

function parentSectionHeading(element) {
  let node = element.parentElement;
  while (node && node !== document.body) {
    if (node.matches?.(SECTION_CONTAINER_SELECTOR)) {
      const heading = node.querySelector("h2, h3");
      const text = heading ? cleanText(heading.innerText || "") : "";
      if (text && (SAFE_SECTION_HEADING_RE.test(text) || BLOCKED_SECTION_HEADING_RE.test(text))) {
        return text;
      }
    }
    node = node.parentElement;
  }
  return "";
}

function matchesSafeInlineExpanderClass(element) {
  const className = typeof element.className === "string" ? element.className : "";
  return /inline-show-more-text__button|lt-line-clamp__more|see-more-less-toggle/i.test(className);
}

function shouldExpand(element) {
  if (element.tagName !== "BUTTON") return false;
  if (element.closest("a") || element.closest('[role="link"]')) return false;
  if (element.getAttribute("href")) return false;
  if (element.closest("nav, header, footer, aside, [role='dialog']")) return false;

  const label = cleanText(
    element.innerText ||
      element.getAttribute("aria-label") ||
      element.getAttribute("title") ||
      ""
  );
  if (!label) return false;
  // Accept the standard inline-expand variants AND LinkedIn's "Show all N
  // experiences / education / certifications" pattern. The latter is what
  // appears under sections that have more entries than fit inline — without
  // matching it we miss the click and historical roles never load.
  if (!/^see more$|^show more$|^show \d+ more|^show all (?:\d+ )?(?:experiences?|education|certifications?|skills|projects?|publications?|volunteer)/i.test(label)) return false;

  const heading = parentSectionHeading(element);
  if (!heading || BLOCKED_SECTION_HEADING_RE.test(heading)) return false;

  if (matchesSafeInlineExpanderClass(element)) return SAFE_SECTION_HEADING_RE.test(heading);
  return SAFE_SECTION_HEADING_RE.test(heading);
}

async function waitForMain() {
  for (let i = 0; i < 30; i += 1) {
    const main = document.querySelector("main");
    if (!main) { await sleep(400); continue; }
    const text = cleanText(main.innerText || "");
    // Detect login/auth walls before they pass the length check and get
    // submitted as a "profile". The login page has a <main> with 200+ chars
    // of form text that would otherwise pass silently.
    if (/sign in|email or phone|forgot your password|join now/i.test(text)) {
      throw new Error("Not logged into LinkedIn — please sign in and try again");
    }
    if (text.length > 120) return main;
    await sleep(400);
  }
  throw new Error("LinkedIn profile content did not finish loading");
}

// Human-paced timings used by auto-capture. Manual-trigger captures keep
// the original snappy timings — the user is watching, no need to fake idle.
const HUMAN_TIMING = {
  betweenClicksMs: [800, 2000],   // pause between "Show more" clicks
  afterClickPassMs: [1500, 3500], // pause after a full pass of clicks
};
function rand([min, max]) { return min + Math.floor(Math.random() * (max - min)); }

async function isHumanPacedMode() {
  // Auto-capture mode means manualOnlyMode is OFF in storage.
  return new Promise((resolve) => {
    try {
      chrome.storage?.local?.get?.({ manualOnlyMode: true }, (s) => {
        resolve(s?.manualOnlyMode === false);
      }) ?? resolve(false);
    } catch { resolve(false); }
  });
}

async function expandInlineSections(clicked, options = {}) {
  const { visibleOnly = false, passes = 4 } = options;
  const human = await isHumanPacedMode();
  const clickGap = human ? rand(HUMAN_TIMING.betweenClicksMs) : 180;
  const passGap  = human ? rand(HUMAN_TIMING.afterClickPassMs) : 350;

  for (let pass = 0; pass < passes; pass += 1) {
    let clickedThisPass = 0;
    const controls = Array.from(document.querySelectorAll("main section button, main div.artdeco-card button"));

    for (const control of controls) {
      if (!(control instanceof HTMLElement)) continue;
      if (!isVisible(control) || (visibleOnly && !isNearViewport(control)) || !shouldExpand(control)) continue;

      const key = `${cleanText(control.innerText || "")}:${control.getAttribute("aria-label") || ""}:${parentSectionHeading(control)}`;
      if (clicked.has(key)) continue;

      clicked.add(key);
      control.click();
      clickedThisPass += 1;
      await sleep(human ? rand(HUMAN_TIMING.betweenClicksMs) : clickGap);

      if (!isLinkedInProfilePage()) {
        lastObservedUrl = "";
        history.back();
        await sleep(1500);
        return false;
      }
    }

    if (!clickedThisPass) break;
    await sleep(human ? rand(HUMAN_TIMING.afterClickPassMs) : passGap);
  }

  return true;
}

async function scrollProfile(clicked) {
  const human = await isHumanPacedMode();
  // Smaller step + longer pause in human mode → looks like reading.
  const step = human
    ? Math.max(Math.floor(window.innerHeight * 0.45), 280)
    : Math.max(Math.floor(window.innerHeight * 0.85), 520);
  let lastHeight = document.body.scrollHeight;
  let stableBottomPasses = 0;

  window.scrollTo({ top: 0, behavior: "auto" });
  // Initial dwell — "reading the header / about" before scrolling. This is
  // the most important signal for LinkedIn's "viewed your profile" feature.
  await sleep(human ? rand([6000, 14000]) : 250);

  for (let pass = 0; pass < (human ? 40 : 26); pass += 1) {
    const nextTop = Math.min(
      Math.max(0, document.body.scrollHeight - window.innerHeight),
      pass === 0 ? 0 : window.scrollY + step
    );
    window.scrollTo({ top: nextTop, behavior: human ? "smooth" : "auto" });
    await sleep(human ? rand([1200, 2800]) : 500);

    if (clicked) {
      const expanded = await expandInlineSections(clicked, { visibleOnly: true, passes: 1 });
      if (!expanded) return false;
    }

    // Reading dwell on whatever just came into view.
    await sleep(human ? rand([2000, 5000]) : 320);

    // Occasional small scroll-up — humans rarely read straight to the bottom.
    if (human && Math.random() < 0.18 && window.scrollY > 200) {
      window.scrollTo({ top: window.scrollY - rand([120, 280]), behavior: "smooth" });
      await sleep(rand([800, 1800]));
    }

    const nextHeight = document.body.scrollHeight;
    const atBottom = window.scrollY + window.innerHeight >= nextHeight - 60;
    if (Math.abs(nextHeight - lastHeight) < 80 && atBottom) {
      stableBottomPasses += 1;
      if (stableBottomPasses >= 2) break;
    } else {
      stableBottomPasses = 0;
    }
    lastHeight = nextHeight;
  }

  window.scrollTo({ top: 0, behavior: human ? "smooth" : "auto" });
  await sleep(human ? rand([1500, 3000]) : 350);
  return true;
}

function verifyCaptureTarget(startUrl) {
  const endUrl = location.href.replace(/[?#].*$/, "");
  if (!isLinkedInProfilePage() || endUrl !== startUrl) {
    lastObservedUrl = "";
    throw new Error("Page navigated during capture - will retry automatically");
  }
}

function firstNonEmptyText(root, selectors) {
  for (const selector of selectors) {
    const element = root.querySelector(selector);
    if (!(element instanceof HTMLElement)) continue;
    const value = cleanText(element.innerText || element.textContent || "");
    // Skip JSON/hydration noise — name/headline selectors should never return
    // a hydration blob, but if LinkedIn ships a layout where they do, fall
    // through to the next selector instead of dumping JSON into the intro.
    if (value && !looksLikeJsonOrTrackingNoise(value)) return value;
  }
  return "";
}

function findIntroCard(main) {
  const nameEl = main.querySelector(INTRO_NAME_SELECTORS.join(", "));
  if (nameEl instanceof HTMLElement) {
    const card = nameEl.closest(SECTION_CONTAINER_SELECTOR);
    if (card instanceof HTMLElement) return card;
    if (nameEl.parentElement instanceof HTMLElement) return nameEl.parentElement;
  }

  const fallback = main.querySelector("section, div.artdeco-card");
  return fallback instanceof HTMLElement ? fallback : null;
}

function extractIntroText(main) {
  const introCard = findIntroCard(main);
  const introRoot = introCard || main;
  const name =
    firstNonEmptyText(introRoot, INTRO_NAME_SELECTORS) || firstNonEmptyText(main, INTRO_NAME_SELECTORS);
  const headline =
    firstNonEmptyText(introRoot, INTRO_HEADLINE_SELECTORS) ||
    firstNonEmptyText(main, INTRO_HEADLINE_SELECTORS);
  const location =
    firstNonEmptyText(introRoot, INTRO_LOCATION_SELECTORS) ||
    firstNonEmptyText(main, INTRO_LOCATION_SELECTORS);

  const lines = [];
  for (const value of [name, headline, location]) {
    if (value) lines.push(value);
  }

  if (introCard) {
    const introLines = filterProfileLines(splitIntoLines(introCard.innerText || ""));
    const seen = new Set(lines.map(normalizeLineKey));
    for (const line of introLines) {
      const key = normalizeLineKey(line);
      if (!key || seen.has(key)) continue;
      if (SAFE_SECTION_HEADING_RE.test(line) || BLOCKED_SECTION_HEADING_RE.test(line)) break;
      seen.add(key);
      lines.push(line);
      if (lines.length >= 8) break;
    }
  }

  return lines.join("\n");
}

function getSectionDefinitionForHeading(heading) {
  return PROFILE_SECTION_DEFINITIONS.find((definition) => definition.headingRe.test(heading)) || null;
}

// LinkedIn renders section headings as <h2><span aria-hidden="true">Experience</span><span class="visually-hidden">Experience</span></h2>.
// innerText only returns rendered text, which on LinkedIn's a11y wrapping
// can return EMPTY for the heading (visually-hidden uses clip:rect to hide
// from sighted users; aria-hidden visibility depends on CSS). Result: every
// section appears headerless and the scraper falls through to "no Experience
// detected" → /details/experience/ deep-fetch never runs → Brendan-class
// captures stay thin. Use textContent (returns ALL text including hidden
// spans), then trim; dedup logic in cleanText collapses any whitespace.
function readHeadingText(headingNode) {
  if (!headingNode) return "";
  // Prefer aria-hidden="true" span (visible to sighted users); fall back to
  // textContent which catches every variant including visually-hidden copy.
  const visible = headingNode.querySelector("span[aria-hidden='true']");
  const raw = visible?.textContent ?? headingNode.textContent ?? headingNode.innerText ?? "";
  return cleanText(raw);
}

function getSectionHeading(container) {
  const heading = readHeadingText(container.querySelector("h2, h3"));
  if (heading) return heading;

  const idMatch = Array.from(container.querySelectorAll("[id]"))
    .map((element) => normalizeSectionKey(element.id))
    .find(Boolean);
  if (!idMatch) return "";

  return getSectionDefinitionForHeading(idMatch)?.label || "";
}

function findClosestSectionContainer(element) {
  const container = element.closest(SECTION_CONTAINER_SELECTOR);
  return container instanceof HTMLElement ? container : null;
}

function findSectionContainers(main, definition) {
  const containers = [];
  const seen = new Set();

  const addContainer = (element) => {
    const container = findClosestSectionContainer(element);
    if (!(container instanceof HTMLElement)) return;
    if (seen.has(container)) return;

    const heading = getSectionHeading(container);
    if (heading && BLOCKED_SECTION_HEADING_RE.test(heading)) return;

    seen.add(container);
    containers.push(container);
  };

  for (const heading of Array.from(main.querySelectorAll("h2, h3"))) {
    if (!(heading instanceof HTMLElement)) continue;
    const headingText = readHeadingText(heading);
    if (!definition.headingRe.test(headingText)) continue;
    addContainer(heading);
  }

  for (const anchor of Array.from(main.querySelectorAll("[id]"))) {
    if (!(anchor instanceof HTMLElement)) continue;
    const idKey = normalizeSectionKey(anchor.id);
    if (!definition.ids.includes(idKey)) continue;
    addContainer(anchor);
  }

  return containers;
}

function buildSectionText(container, definition) {
  const rawHeading = getSectionHeading(container) || definition.label;
  if (!rawHeading || BLOCKED_SECTION_HEADING_RE.test(rawHeading)) return "";

  const lines = filterProfileLines(splitIntoLines(container.innerText || ""));
  const removableKeys = new Set([normalizeSectionKey(rawHeading), ...definition.ids]);
  while (lines.length > 0 && removableKeys.has(normalizeSectionKey(lines[0]))) {
    lines.shift();
  }

  if (lines.length === 0) return "";
  return `${rawHeading}\n${lines.join("\n")}`;
}

function extractStructuredSections(main) {
  const parts = [];
  const sectionKeys = [];

  for (const definition of PROFILE_SECTION_DEFINITIONS) {
    let bestSectionText = "";

    for (const container of findSectionContainers(main, definition)) {
      const sectionText = buildSectionText(container, definition);
      if (sectionText.length > bestSectionText.length) {
        bestSectionText = sectionText;
      }
    }

    if (!bestSectionText) continue;
    sectionKeys.push(definition.key);
    parts.push(bestSectionText);
  }

  return { parts, sectionKeys };
}

function extractVisibleMainProfileText(main) {
  const lines = filterProfileLines(splitIntoLines(main.innerText || ""));
  if (lines.length === 0) return "";

  const useful = [];
  for (const line of lines) {
    if (/^search$/i.test(line)) continue;
    if (/^home$/i.test(line)) continue;
    if (/^my network$/i.test(line)) continue;
    if (/^jobs$/i.test(line)) continue;
    if (/^messaging$/i.test(line)) continue;
    if (/^notifications$/i.test(line)) continue;
    useful.push(line);
  }

  return cleanText(useful.join("\n"));
}

function mergeCaptureText(primaryText, fallbackText) {
  if (!fallbackText || fallbackText.length <= primaryText.length + 80) return primaryText;

  const primaryKeys = new Set(splitIntoLines(primaryText).map(normalizeLineKey).filter(Boolean));
  const additionalLines = splitIntoLines(fallbackText).filter((line) => {
    const key = normalizeLineKey(line);
    return key && !primaryKeys.has(key);
  });

  if (additionalLines.length === 0) return primaryText;
  return cleanText([primaryText, "Visible LinkedIn profile text", ...additionalLines].filter(Boolean).join("\n"));
}

function collectProfileText(startUrl, options = {}) {
  const { allowShort = false } = options;
  verifyCaptureTarget(startUrl);

  const main = document.querySelector("main");
  if (!(main instanceof HTMLElement)) {
    throw new Error("LinkedIn profile content did not finish loading");
  }

  const intro = extractIntroText(main);
  const { parts: sections, sectionKeys } = extractStructuredSections(main);
  const structuredText = cleanText([intro, ...sections].filter(Boolean).join("\n\n"));
  const fallbackText = extractVisibleMainProfileText(main);
  const merged = mergeCaptureText(structuredText, fallbackText);
  // Last-line defence: re-run the noise filter over the FULLY MERGED text.
  // This catches cases where structured/fallback extraction already passed
  // their per-line filters but a layout change exposed hydration JSON via a
  // path we didn't anticipate. Without this, a single bad capture can save
  // ~100k of "trackingId/$type/urn:li:" garbage, poisoning the AI scorer.
  const cleaned = filterProfileLines(splitIntoLines(merged)).join("\n");
  const profileText = cleaned.slice(0, 100000);

  if (!allowShort && profileText.length < 200) {
    throw new Error("Captured profile text was too short");
  }

  return {
    linkedinUrl: startUrl,
    profileText,
    sectionKeys,
    capturedAt: new Date().toISOString(),
    title: document.title,
  };
}

// Year-range patterns inside a section. Mirrors server-side detection in
// scoring.ts: catches "1998-2001", "Mar 1997 – Jun 1998", and the
// LinkedIn "Since 2018" / "5 yrs" current-role markers.
const SECTION_YEAR_RANGE_RE = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)?\.?\s*(?:19|20)\d{2}\s*(?:[-–—]|to)\s*(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)?\.?\s*(?:19|20)\d{2}|present|current|now)|\bsince\s+(?:19|20)\d{2}|\b\d+\s*yrs?\b/gi;

function countSectionRoles(profileText, sectionKey) {
  const found = findSectionHeader(profileText, sectionKey);
  if (!found) return 0;
  const allHeaders = Object.values(SECTION_HEADERS).flat().map(escapeForRegex);
  const nextRe = new RegExp(`\\n(${allHeaders.join("|")})\\n`, "i");
  const after = profileText.slice(found.index + found.header.length + 1);
  const nextRel = after.search(nextRe);
  const sectionEnd = nextRel === -1 ? profileText.length : found.index + found.header.length + 1 + nextRel;
  const sectionText = profileText.slice(found.index, sectionEnd);
  return (sectionText.match(SECTION_YEAR_RANGE_RE) ?? []).length;
}

function needsDeeperCapture(capture) {
  const coreSectionCount = capture.sectionKeys.filter((key) => CORE_SECTION_KEYS.has(key)).length;
  const hasIntro = !!capture.profileText.split(/\n+/)[0] && !SAFE_SECTION_HEADING_RE.test(capture.profileText.split(/\n+/)[0]);
  const hasExperience = capture.sectionKeys.includes("experience");
  const hasEducation = capture.sectionKeys.includes("education");

  // NEW: even when Experience is detected, the inline view often only shows
  // the most recent 2-3 roles before "Show all N experiences" cuts off. If
  // the captured Experience section has fewer than 3 dated roles, force the
  // deep fetch — historical work is the most likely source of must-have
  // signals (Brendan's C++ at NZ Customs and Sybase at ACC are 20+ years
  // old, deep in his history).
  const experienceRoleCount = hasExperience ? countSectionRoles(capture.profileText, "experience") : 0;
  const experienceLooksThin = hasExperience && experienceRoleCount < 3;

  return (
    capture.profileText.length < MIN_EXPANDED_PROFILE_TEXT_CHARS ||
    !hasIntro ||
    coreSectionCount < 3 ||
    (!hasExperience && !hasEducation) ||
    experienceLooksThin
  );
}

function buildDetailsUrl(profileBaseUrl, section) {
  try {
    const url = new URL(profileBaseUrl);
    const match = url.pathname.match(/^(\/in\/[^/]+)\/?/i);
    if (!match) return "";
    url.pathname = `${match[1]}/details/${section}/`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function buildExperienceDetailsUrl(profileBaseUrl) {
  return buildDetailsUrl(profileBaseUrl, "experience");
}

// ── Stricter deep-section merging helpers ────────────────────────────────────
// Each LinkedIn section can be detected by a small set of header strings.
// We use these for two things:
//   1. Locate the precise byte-range a section occupies inside the main capture
//      (so we can replace experience with the deep version, not just append).
//   2. Decide whether to skip a deep fetch entirely because the main capture
//      already covers the section adequately.
const SECTION_HEADERS = {
  experience:               ["Experience"],
  education:                ["Education"],
  skills:                   ["Skills", "Top skills"],
  licenses_certifications:  [
    "Licenses & Certifications",
    "Licenses & certifications",
    "Licenses and Certifications",
    "Certifications",
  ],
};

// Soft cap so a single bloated deep page can't monopolise the 100k profileText
// budget. 25k ≈ 5 dense pages of A4 — plenty for any one section.
const MAX_SECTION_CHARS = 25000;

function escapeForRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Returns { header, index } pointing at the section header inside profileText,
// or null if no known header for that section is present.
function findSectionHeader(profileText, sectionKey) {
  const headers = SECTION_HEADERS[sectionKey] || [];
  for (const header of headers) {
    const re = new RegExp(`(^|\\n)${escapeForRegex(header)}\\n`, "i");
    const match = re.exec(profileText);
    if (match) {
      // match.index points at the leading \n (or 0); the actual header starts
      // one char later when we matched a \n.
      const headerStart = match.index === 0 ? 0 : match.index + 1;
      return { header, index: headerStart };
    }
  }
  return null;
}

// Returns the number of chars in profileText between this section's header and
// the next known section header (or end of text). 0 if header is absent.
function getSectionContentSize(profileText, sectionKey) {
  const found = findSectionHeader(profileText, sectionKey);
  if (!found) return 0;
  const after = profileText.slice(found.index + found.header.length + 1); // +1 for the \n after header
  const allHeaders = Object.values(SECTION_HEADERS).flat().map(escapeForRegex);
  const nextRe = new RegExp(`\\n(${allHeaders.join("|")})\\n`, "i");
  const nextIdx = after.search(nextRe);
  return nextIdx === -1 ? after.length : nextIdx;
}

// Cap a single section's text at MAX_SECTION_CHARS, truncating at a line
// boundary so we don't slice mid-word.
function capSectionText(sectionText) {
  if (sectionText.length <= MAX_SECTION_CHARS) return sectionText;
  const truncated = sectionText.slice(0, MAX_SECTION_CHARS);
  const lastNewline = truncated.lastIndexOf("\n");
  return lastNewline > MAX_SECTION_CHARS / 2 ? truncated.slice(0, lastNewline) : truncated;
}

// Once-retry wrapper for deep-page fetches. LinkedIn frequently 429s on
// rapid successive requests but recovers within ~600ms; a single retry
// rescues a meaningful fraction of captures without hammering the server.
async function fetchDeepPageHtml(detailsUrl) {
  const result = { html: "", status: 0, finalUrl: "", reason: "" };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(detailsUrl, {
        credentials: "include",
        cache: "no-store",
        redirect: "follow",
      });
      result.status = response.status;
      result.finalUrl = response.url || detailsUrl;
      if (response.ok) {
        result.html = await response.text();
        result.reason = "ok";
        return result;
      }
      // Retry transient failures only; permanent client errors are final.
      if (response.status !== 429 && response.status < 500) {
        result.reason = `http_${response.status}`;
        return result;
      }
      result.reason = `http_${response.status}`;
    } catch (err) {
      result.reason = "network_error";
      result.status = 0;
    }
    if (attempt === 0) await sleep(600);
  }
  return result;
}

// Verify the response landed on the deep page we asked for instead of being
// redirected to the main profile / a login wall / a 404 shell. The previous
// check ("html contains '/details/skills' or 'Skills'") false-positives on
// any profile that has the word "Skills" in their headline.
function isDeepPageResponseValid(finalUrl, requestedSection) {
  if (!finalUrl) return false;
  try {
    const u = new URL(finalUrl);
    return new RegExp(`/in/[^/]+/details/${requestedSection}/?$`, "i").test(u.pathname);
  } catch {
    return false;
  }
}

function extractLinesFromDetachedDocument(doc) {
  const root = doc.querySelector("main") || doc.body;
  if (!root) return [];

  // Strip script/style/code blocks BEFORE extraction — LinkedIn embeds tens
  // of KB of Ember prerender JSON in <code> tags inside <main>, which
  // textContent would pull through. Removing them up front lets us safely
  // use textContent fallback below.
  for (const noise of root.querySelectorAll("script, style, code, noscript")) {
    noise.remove();
  }

  const selectors = [
    "main h1",
    "main h2",
    "main h3",
    "main li",
    "main p",
    "main span[aria-hidden='true']",
    "main span.visually-hidden",
    "main div[aria-label]",
    // LinkedIn's current /details/<section>/ pages render entries inside
    // listitem divs and data-view-name'd component wrappers. Without these
    // selectors, the entire deep page's content is invisible to extraction.
    "main div[role='listitem']",
    "main article",
    "main div[data-view-name]",
    "main span[dir='ltr']",
  ];
  const raw = [];

  for (const element of Array.from(root.querySelectorAll(selectors.join(", ")))) {
    const value = cleanText(
      element.getAttribute?.("aria-label") ||
        element.textContent ||
        ""
    );
    if (value) raw.push(value);
  }

  // Last-resort fallback: if scoped selectors returned almost nothing
  // (LinkedIn changed their DOM and our selectors no longer match), pull
  // textContent from the whole main tree. We've already stripped script/
  // style/code/noscript above, so this no longer drags JSON garbage in.
  // Threshold: <30 lines means our targeted selectors likely missed the
  // primary content.
  if (raw.length < 30) {
    const fullText = cleanText(root.textContent || "");
    if (fullText.length > 0) raw.push(fullText);
  }

  return filterProfileLines(raw.flatMap(splitIntoLines));
}

// Returns { text, meta } where meta records what happened so the server can
// later prove the deep page was actually used. text is "" on any failure.
async function fetchExperienceDetailsText(profileBaseUrl) {
  const meta = { fetched: false, status: 0, reason: "skipped", finalUrl: "", chars: 0 };
  const detailsUrl = buildExperienceDetailsUrl(profileBaseUrl);
  if (!detailsUrl) {
    meta.reason = "no_url";
    return { text: "", meta };
  }

  meta.fetched = true;
  const fetched = await fetchDeepPageHtml(detailsUrl);
  meta.status = fetched.status;
  meta.finalUrl = fetched.finalUrl;
  if (!fetched.html) {
    meta.reason = fetched.reason || "empty_response";
    return { text: "", meta };
  }
  if (!isDeepPageResponseValid(fetched.finalUrl, "experience")) {
    meta.reason = "redirected_away";
    return { text: "", meta };
  }

  const doc = new DOMParser().parseFromString(fetched.html, "text/html");
  const lines = extractLinesFromDetachedDocument(doc);
  console.log("[RecruitMe] /details/experience/ raw extraction", {
    htmlBytes: fetched.html.length,
    linesExtracted: lines.length,
    firstFiveLines: lines.slice(0, 5),
    finalUrl: fetched.finalUrl,
  });
  while (lines.length > 0 && /^experience$/i.test(lines[0])) lines.shift();

  const useful = [];
  const seen = new Set();
  for (const line of lines) {
    if (/^(experience|profile|linkedin|search)$/i.test(line)) continue;
    if (/^skip to main content$/i.test(line)) continue;
    // Filter LinkedIn nav / footer / ad clutter that the broader textContent
    // fallback now captures. Keep the work-history content intact.
    if (/^(home|jobs|messaging|notifications|me|work|sign in|sign out|join now|about|accessibility|talent solutions|community guidelines|professional community policies|privacy & terms|brand policy|guest controls|language|ad options|why am i seeing this ad|manage your ad preferences|hide or report this ad|i don'?t want to see this ad)$/i.test(line)) continue;
    const key = normalizeLineKey(line);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    useful.push(line);
  }

  // Threshold lowered from (3 lines / 160 chars) to (2 lines / 80 chars) to
  // match the other deep-page extractor (fetchDetailsPageText). LinkedIn's
  // /details/experience/ page sometimes renders short entries (job title +
  // dates only) that contain genuine work-history evidence; the previous
  // floor was rejecting Brendan-class profiles where the historical roles
  // were captured as 2 dense lines.
  if (useful.length < 2 || useful.join("\n").length < 80) {
    meta.reason = "too_thin";
    meta.chars = useful.join("\n").length;
    console.warn("[RecruitMe] experience deep-page too_thin", {
      lines: useful.length,
      chars: useful.join("\n").length,
      url: detailsUrl,
    });
    return { text: "", meta };
  }

  const text = capSectionText(`Experience\n${useful.join("\n")}`);
  meta.reason = "ok";
  meta.chars = text.length;
  return { text, meta };
}

// Returns { capture, mode, charsAdded } so callers can record exactly how the
// merge resolved. mode: "replace" (main had Experience, replaced with deep),
// "append" (no Experience in main, added the deep block), "skip-too-small"
// (deep block was discarded as not useful).
function mergeExperienceSection(mainCapture, fullExperienceText) {
  if (!fullExperienceText || fullExperienceText.length < 160) {
    return { capture: mainCapture, mode: "skip-too-small", charsAdded: 0 };
  }

  const before = mainCapture.profileText.length;
  const profileText = mainCapture.profileText;
  const found = findSectionHeader(profileText, "experience");

  let merged;
  let mode;
  if (!found) {
    merged = cleanText(`${profileText}\n\n${fullExperienceText}`).slice(0, 100000);
    mode = "append";
  } else {
    // Replace from the start of the existing Experience header to the start of
    // the next known section, with the deep block (which has its own header).
    const allHeaders = Object.values(SECTION_HEADERS).flat().map(escapeForRegex);
    const nextRe = new RegExp(`\\n(${allHeaders.join("|")})\\n`, "i");
    const after = profileText.slice(found.index + found.header.length + 1);
    const nextRel = after.search(nextRe);
    const sliceEnd = nextRel === -1 ? profileText.length : found.index + found.header.length + 1 + nextRel;
    merged = cleanText(
      profileText.slice(0, found.index) + fullExperienceText + (nextRel === -1 ? "" : "\n\n" + profileText.slice(sliceEnd + 1))
    ).slice(0, 100000);
    mode = "replace";
  }

  return {
    capture: {
      ...mainCapture,
      profileText: merged,
      sectionKeys: [...new Set([...mainCapture.sectionKeys, "experience"])],
    },
    mode,
    charsAdded: merged.length - before,
  };
}

async function enrichWithExperienceDetails(mainCapture, profileBaseUrl) {
  const { text, meta: fetchMeta } = await fetchExperienceDetailsText(profileBaseUrl);
  const { capture, mode, charsAdded } = mergeExperienceSection(mainCapture, text);
  const sectionMeta = {
    key: "experience",
    fetched: fetchMeta.fetched,
    status: fetchMeta.status,
    finalUrl: fetchMeta.finalUrl,
    fetchOutcome: fetchMeta.reason,
    deepChars: fetchMeta.chars,
    mergeMode: mode,
    charsAdded,
  };
  if (charsAdded > 0) {
    console.log("[RecruitMe] merged full experience details", {
      before: mainCapture.profileText.length,
      after: capture.profileText.length,
      mode,
      deepChars: fetchMeta.chars,
    });
  } else {
    // Make failures audible. Without this, Brendan-class captures are
    // silent: extension submits a thin profile, server scores it 22%, no
    // log explains why the deep fetch didn't help.
    console.warn("[RecruitMe] experience deep-fetch did NOT enrich capture", {
      fetchOutcome: fetchMeta.reason,
      mergeMode: mode,
      mainChars: mainCapture.profileText.length,
      deepChars: fetchMeta.chars,
      finalUrl: fetchMeta.finalUrl,
      status: fetchMeta.status,
    });
  }
  return { capture, sectionMeta };
}

async function fetchDetailsPageText(profileBaseUrl, section, sectionLabel) {
  const meta = { fetched: false, status: 0, reason: "skipped", finalUrl: "", chars: 0 };
  const detailsUrl = buildDetailsUrl(profileBaseUrl, section);
  if (!detailsUrl) {
    meta.reason = "no_url";
    return { text: "", meta };
  }

  meta.fetched = true;
  const fetched = await fetchDeepPageHtml(detailsUrl);
  meta.status = fetched.status;
  meta.finalUrl = fetched.finalUrl;
  if (!fetched.html) {
    meta.reason = fetched.reason || "empty_response";
    return { text: "", meta };
  }
  // Strict response check: was the request *not* redirected to the main profile
  // (or login wall)? Without this, any /details/x request that 200s on a redirect
  // back to /in/<slug> would be parsed as if it were the deep page.
  if (!isDeepPageResponseValid(fetched.finalUrl, section)) {
    meta.reason = "redirected_away";
    return { text: "", meta };
  }

  const doc = new DOMParser().parseFromString(fetched.html, "text/html");
  const lines = extractLinesFromDetachedDocument(doc);

  const useful = [];
  const seen = new Set();
  for (const line of lines) {
    if (new RegExp(`^(${escapeForRegex(sectionLabel)}|profile|linkedin|search|skills)$`, "i").test(line)) continue;
    if (/^skip to main content$/i.test(line)) continue;
    const key = normalizeLineKey(line);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    useful.push(line);
  }

  if (useful.length < 2 || useful.join("\n").length < 60) {
    meta.reason = "too_thin";
    return { text: "", meta };
  }

  const text = capSectionText(`${sectionLabel}\n${useful.join("\n")}`);
  meta.reason = "ok";
  meta.chars = text.length;
  return { text, meta };
}

// Decide whether to merge a deep section into the main capture, and which mode
// to use:
//   - "skip-already-present": main has this section header AND substantial
//      content under it (>500 chars). The deep page would mostly duplicate.
//   - "replace":              main has the header but content is thin (<500
//      chars), so we substitute the deep version for the slim main one.
//   - "append":               header absent from main, append fresh.
//   - "skip-empty":           deep page returned no usable text.
function mergeSection(mainCapture, sectionText, sectionKey, sectionLabel) {
  if (!sectionText || sectionText.length < 60) {
    return { capture: mainCapture, mode: "skip-empty", charsAdded: 0 };
  }
  const before = mainCapture.profileText.length;
  const existingSize = getSectionContentSize(mainCapture.profileText, sectionKey);
  const SUBSTANTIAL = 500;

  if (existingSize > SUBSTANTIAL) {
    return { capture: mainCapture, mode: "skip-already-present", charsAdded: 0 };
  }

  let merged;
  let mode;
  if (existingSize > 0) {
    // Replace the slim existing block. Reuse the experience-merge logic: the
    // main capture has a header, find the next-section boundary, splice in.
    const found = findSectionHeader(mainCapture.profileText, sectionKey);
    if (!found) {
      merged = cleanText(`${mainCapture.profileText}\n\n${sectionText}`).slice(0, 100000);
      mode = "append";
    } else {
      const allHeaders = Object.values(SECTION_HEADERS).flat().map(escapeForRegex);
      const nextRe = new RegExp(`\\n(${allHeaders.join("|")})\\n`, "i");
      const after = mainCapture.profileText.slice(found.index + found.header.length + 1);
      const nextRel = after.search(nextRe);
      const sliceEnd = nextRel === -1 ? mainCapture.profileText.length : found.index + found.header.length + 1 + nextRel;
      merged = cleanText(
        mainCapture.profileText.slice(0, found.index) + sectionText + (nextRel === -1 ? "" : "\n\n" + mainCapture.profileText.slice(sliceEnd + 1))
      ).slice(0, 100000);
      mode = "replace";
    }
  } else {
    merged = cleanText(`${mainCapture.profileText}\n\n${sectionText}`).slice(0, 100000);
    mode = "append";
  }

  return {
    capture: {
      ...mainCapture,
      profileText: merged,
      sectionKeys: [...new Set([...mainCapture.sectionKeys, sectionKey])],
    },
    mode,
    charsAdded: merged.length - before,
  };
}

async function enrichWithSkillsAndCertifications(mainCapture, profileBaseUrl) {
  const [skills, certs, education] = await Promise.all([
    fetchDetailsPageText(profileBaseUrl, "skills",         "Skills"),
    fetchDetailsPageText(profileBaseUrl, "certifications", "Licenses & Certifications"),
    fetchDetailsPageText(profileBaseUrl, "education",      "Education"),
  ]);

  const sections = [
    { key: "skills",                   label: "Skills",                     ...skills },
    { key: "licenses_certifications",  label: "Licenses & Certifications",  ...certs },
    { key: "education",                label: "Education",                  ...education },
  ];

  let enriched = mainCapture;
  const sectionMetas = [];
  for (const s of sections) {
    const merge = mergeSection(enriched, s.text, s.key, s.label);
    enriched = merge.capture;
    sectionMetas.push({
      key:          s.key,
      fetched:      s.meta.fetched,
      status:       s.meta.status,
      finalUrl:     s.meta.finalUrl,
      fetchOutcome: s.meta.reason,
      deepChars:    s.meta.chars,
      mergeMode:    merge.mode,
      charsAdded:   merge.charsAdded,
    });
  }

  if (enriched.profileText.length > mainCapture.profileText.length + 60) {
    console.log("[RecruitMe] merged skills/certs/education", {
      skills: skills.text.length,
      certs:  certs.text.length,
      education: education.text.length,
      totalAfter: enriched.profileText.length,
    });
  }
  return { capture: enriched, sectionMetas };
}

async function waitForRootProfilePage(expectedUrl = "") {
  const expectedSlug = normaliseLinkedInSlug(expectedUrl);
  for (let i = 0; i < 60; i += 1) {
    await sleep(200);
    if (!isRootLinkedInProfile(location.href)) continue;
    if (!expectedSlug || linkedInProfileMatches(location.href, expectedUrl)) return true;
  }
  return false;
}

// Each call to enrichWithExperienceDetails / enrichWithSkillsAndCertifications
// now returns its own metadata. captureProfile rolls them up into a single
// captureMeta object that travels with the profileText to the server, so the
// server (and a recruiter looking at the candidate detail panel) can verify
// which deep pages were actually fetched, which were skipped, and why.
async function enrichAll(capture, startUrl) {
  const expResult  = await enrichWithExperienceDetails(capture, startUrl);
  const restResult = await enrichWithSkillsAndCertifications(expResult.capture, startUrl);
  return {
    capture: restResult.capture,
    sectionMetas: [expResult.sectionMeta, ...restResult.sectionMetas],
  };
}

async function captureProfile() {
  const startUrl = location.href.replace(/[?#].*$/, "");
  console.log("[RecruitMe] captureProfile START", { url: startUrl, version: chrome?.runtime?.getManifest?.()?.version });
  if (!isLinkedInProfilePage()) {
    throw new Error("Not on a LinkedIn profile page");
  }

  await waitForMain();
  console.log("[RecruitMe] waitForMain complete");
  await sleep(700);

  const clicked = new Set();
  const expandedAtTop = await expandInlineSections(clicked, { visibleOnly: true, passes: 2 });
  console.log("[RecruitMe] first expandInlineSections done", { ok: expandedAtTop, clicks: clicked.size });
  if (!expandedAtTop) {
    throw new Error("Page navigated during capture - will retry automatically");
  }

  console.log("[RecruitMe] starting scrollProfile (you should see the page scroll now)");
  const scrolled = await scrollProfile(clicked);
  console.log("[RecruitMe] scrollProfile done", { ok: scrolled });
  if (!scrolled) {
    throw new Error("Page navigated during capture - will retry automatically");
  }

  let capture = collectProfileText(startUrl, { allowShort: true });
  const mainChars = capture.profileText.length;
  let lastSectionMetas = [];

  // Surface the deep-fetch decision in DevTools so the user can verify the
  // extension is doing what it should. Without this, the user sees no
  // visible activity and assumes the extension stopped working.
  const expRoles = countSectionRoles(capture.profileText, "experience");
  console.log("[RecruitMe] capture decision", {
    mainChars,
    sections: capture.sectionKeys,
    experienceRolesDetected: expRoles,
    willDeepFetch: needsDeeperCapture(capture) || expRoles < 3,
    note: expRoles < 3 ? "deep-fetch forced — fewer than 3 dated roles inline" : "main capture looks complete",
  });

  const finalize = (cap) => {
    if (cap.profileText.length < 200) {
      throw new Error(buildTooShortCaptureMessage(cap, "final validation"));
    }
    cap.captureMeta = {
      capturedAt: new Date().toISOString(),
      mainProfileChars: mainChars,
      finalProfileChars: cap.profileText.length,
      sections: lastSectionMetas,
    };
    return cap;
  };

  if (!needsDeeperCapture(capture)) {
    const r = await enrichAll(capture, startUrl);
    capture = r.capture; lastSectionMetas = r.sectionMetas;
    return finalize(capture);
  }

  const expanded = await expandInlineSections(clicked, { visibleOnly: false, passes: 6 });
  if (!expanded) {
    throw new Error("Page navigated during capture - will retry automatically");
  }

  const rescrolled = await scrollProfile(clicked);
  if (!rescrolled) {
    throw new Error("Page navigated during capture - will retry automatically");
  }

  capture = collectProfileText(startUrl, { allowShort: true });
  if (!needsDeeperCapture(capture)) {
    const r = await enrichAll(capture, startUrl);
    capture = r.capture; lastSectionMetas = r.sectionMetas;
    return finalize(capture);
  }

  await sleep(800);
  capture = collectProfileText(startUrl, { allowShort: true });
  let r = await enrichAll(capture, startUrl);
  capture = r.capture; lastSectionMetas = r.sectionMetas;

  if (capture.profileText.length < 200) {
    await sleep(1200);
    const finalRescrolled = await scrollProfile(clicked);
    if (finalRescrolled) {
      capture = collectProfileText(startUrl, { allowShort: true });
      r = await enrichAll(capture, startUrl);
      capture = r.capture; lastSectionMetas = r.sectionMetas;
    }
  }
  return finalize(capture);
}

let captureInProgress = false;
let captureInProgressSessionId = "";

function normaliseLinkedInSlug(url = "") {
  const m = url.match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  return m ? m[1].toLowerCase() : "";
}

function linkedInSlugAliasKey(url = "") {
  return normaliseLinkedInSlug(url)
    .replace(/-[a-z0-9]*\d[a-z0-9]{5,}$/i, "")
    .replace(/[^a-z0-9]/g, "");
}

function linkedInProfileMatches(a = "", b = "") {
  const aSlug = normaliseLinkedInSlug(a);
  const bSlug = normaliseLinkedInSlug(b);
  if (!aSlug || !bSlug) return false;
  if (aSlug === bSlug) return true;

  const aKey = linkedInSlugAliasKey(a);
  const bKey = linkedInSlugAliasKey(b);
  return aKey.length >= 6 && aKey === bKey;
}

// Read LinkedIn's <link rel="canonical"> from the current page. LinkedIn
// always carries one and it points at the user's currently-active vanity slug,
// regardless of which slug the visitor arrived through. We use this as an
// extra match candidate so the popup doesn't reject captures when:
//   - The recruiter's stored URL uses a numeric-suffix slug
//     (alex-wardega-2b3b16267) but the user has since edited their custom URL
//     to a vanity one (alexjwardega), or vice versa.
//   - Middle-initial differences (alex-wardega vs alex-j-wardega) prevent the
//     alias-key fallback from firing.
// Pure DOM read; no fetch, no async, no leak risk.
function getLinkedInCanonicalUrl() {
  if (typeof document === "undefined") return "";
  try {
    const link = document.querySelector('link[rel="canonical"]');
    return link?.getAttribute("href") || "";
  } catch {
    return "";
  }
}

// Like linkedInProfileMatches, but also tries the page's canonical URL.
// Used at the capture-validation step where we have access to document.
function linkedInProfileMatchesWithCanonical(currentUrl, expectedUrl) {
  if (linkedInProfileMatches(currentUrl, expectedUrl)) return true;
  const canonical = getLinkedInCanonicalUrl();
  if (canonical && linkedInProfileMatches(canonical, expectedUrl)) return true;
  return false;
}

// Send a message to the background service worker and await the response.
// The SW has host permissions so it can POST to the RecruitMe server without
// any CORS ambiguity that affects content-script fetch() calls.
function sendToServiceWorker(data, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Service worker response timed out")),
      timeoutMs
    );
    chrome.runtime.sendMessage(data, (response) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response?.ok) {
        resolve(response);
      } else {
        reject(new Error(response?.error || "Service worker request failed"));
      }
    });
  });
}

// ── Option A: cross-navigation capture state machine ────────────────────────
// Background fetch of /details/experience/ (the previous "invisible" deep
// fetch) gets blocked by LinkedIn anti-bot. The fix is to navigate the visible
// tab to the details page, extract from the live DOM, then navigate back.
// Navigation kills the content script, so progress has to live in
// chrome.storage.local — every new content-script instance picks up where the
// previous one left off via resumeNavigationCaptureIfNeeded().
//
// Stages:
//   "navigating_to_details"        — main capture done, expecting the tab to
//                                    arrive on /details/experience/
//   "details_done_navigating_back" — deep extraction done, expecting the tab
//                                    to return to the root profile to
//                                    finalize + POST
const NAV_CAPTURE_STATE_KEY = "recruitmeNavigationCapture";
const NAV_CAPTURE_STALE_MS  = 5 * 60_000;
const NAV_CAPTURE_SENTINEL  = "__recruitme_navigated__";
const EXPERIENCE_DETAILS_PATH_RE = /\/in\/[^/]+\/details\/experience\/?/i;

function readNavCaptureState() {
  return new Promise((resolve) => {
    if (!chrome?.storage?.local?.get) { resolve(null); return; }
    try {
      chrome.storage.local.get([NAV_CAPTURE_STATE_KEY], (result) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(result?.[NAV_CAPTURE_STATE_KEY] || null);
      });
    } catch { resolve(null); }
  });
}

function writeNavCaptureState(state) {
  return new Promise((resolve) => {
    if (!chrome?.storage?.local?.set) { resolve(); return; }
    try {
      chrome.storage.local.set({ [NAV_CAPTURE_STATE_KEY]: state }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch { resolve(); }
  });
}

function clearNavCaptureState() {
  return new Promise((resolve) => {
    if (!chrome?.storage?.local?.remove) { resolve(); return; }
    try {
      chrome.storage.local.remove([NAV_CAPTURE_STATE_KEY], () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch { resolve(); }
  });
}

// Pull experience text out of the LIVE /details/experience/ DOM. We serialize
// + re-parse so extractLinesFromDetachedDocument's destructive cleanup
// (script/style/code removal) doesn't mutate the page the recruiter sees.
function extractExperienceFromLiveDocument() {
  const meta = { reason: "ok", chars: 0, status: 200, finalUrl: location.href.replace(/[?#].*$/, "") };
  let lines = [];
  try {
    const html = document.documentElement.outerHTML;
    const doc  = new DOMParser().parseFromString(html, "text/html");
    lines = extractLinesFromDetachedDocument(doc);
  } catch (e) {
    console.warn("[RecruitMe] extractExperienceFromLiveDocument failed:", e?.message || e);
    meta.reason = "extract_failed";
    return { text: "", meta };
  }
  while (lines.length > 0 && /^experience$/i.test(lines[0])) lines.shift();

  const useful = [];
  const seen = new Set();
  for (const line of lines) {
    if (/^(experience|profile|linkedin|search)$/i.test(line)) continue;
    if (/^skip to main content$/i.test(line)) continue;
    if (/^(home|jobs|messaging|notifications|me|work|sign in|sign out|join now|about|accessibility|talent solutions|community guidelines|professional community policies|privacy & terms|brand policy|guest controls|language|ad options|why am i seeing this ad|manage your ad preferences|hide or report this ad|i don'?t want to see this ad)$/i.test(line)) continue;
    const key = normalizeLineKey(line);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    useful.push(line);
  }

  const usefulText = useful.join("\n");
  meta.chars = usefulText.length;
  if (useful.length < 2 || usefulText.length < 80) {
    meta.reason = "too_thin";
    return { text: "", meta };
  }
  const text = capSectionText(`Experience\n${usefulText}`);
  meta.chars = text.length;
  return { text, meta };
}

function buildDeepExperienceFailureMessage(meta = {}, mainChars = 0) {
  const reason = meta.reason || "unknown";
  const status = meta.status ? `status ${meta.status}` : "no HTTP status";
  const chars = Number.isFinite(meta.chars) ? meta.chars : 0;
  const finalUrl = meta.finalUrl ? ` finalUrl=${String(meta.finalUrl).slice(0, 160)}` : "";
  return `LinkedIn experience details capture failed (${reason}, ${status}, ${chars} chars, main profile ${mainChars} chars).${finalUrl}`;
}

function buildTooShortCaptureMessage(capture, context = "final") {
  const chars = capture?.profileText?.length ?? 0;
  const sections = Array.isArray(capture?.sectionKeys) && capture.sectionKeys.length
    ? capture.sectionKeys.join(",")
    : "none";
  const title = capture?.title ? ` title=${String(capture.title).slice(0, 120)}` : "";
  return `Captured profile text was too short during ${context} (${chars} chars, sections=${sections}). Reload LinkedIn, confirm you are signed in, and try again.${title}`;
}

// Light scroll helper used on the details page only — humanlike enough to
// trigger LinkedIn's lazy-load without the full multi-minute scrollProfile.
async function scrollDetailsPage() {
  window.scrollTo({ top: 0, behavior: "auto" });
  await sleep(400);
  let lastH = document.body.scrollHeight;
  for (let i = 0; i < 14; i += 1) {
    window.scrollTo({ top: window.scrollY + Math.max(window.innerHeight * 0.8, 500), behavior: "auto" });
    await sleep(550);
    const h = document.body.scrollHeight;
    const atBottom = window.scrollY + window.innerHeight >= h - 60;
    if (h === lastH && atBottom) break;
    lastH = h;
  }
  window.scrollTo({ top: 0, behavior: "auto" });
  await sleep(300);
}

// Used by the navigation flow to send the saved main capture (no enrichAll)
// across the chrome.storage boundary.
function summarizeMainCaptureForState(capture, mainChars) {
  return {
    profileText: capture.profileText,
    sectionKeys: capture.sectionKeys,
    title: capture.title || "",
    headline: capture.headline || "",
    location: capture.location || "",
    linkedinUrl: capture.linkedinUrl || "",
    mainProfileChars: mainChars,
  };
}

// Auto-capture orchestration with optional cross-navigation deep-fetch.
// Mirrors captureProfile's main-page work, but instead of always calling
// enrichAll (background fetch), it navigates to /details/experience/ when the
// inline view doesn't already have ≥3 dated roles. The actual return-from-
// details + POST is handled by resumeNavigationCaptureIfNeeded() in the
// content-script instance that loads after the navigation back to root.
//
// Throws NAV_CAPTURE_SENTINEL when navigation has been kicked off — caller
// must treat that as "not an error, just resume in a new lifecycle".
async function captureWithOptionalDeepNavigation(sessionId, serverBase, expectedUrl) {
  const startUrl = location.href.replace(/[?#].*$/, "");
  console.log("[RecruitMe] captureWithOptionalDeepNavigation START", { url: startUrl, version: chrome?.runtime?.getManifest?.()?.version });
  if (!isLinkedInProfilePage()) {
    throw new Error("Not on a LinkedIn profile page");
  }

  await waitForMain();
  await sleep(700);

  const clicked = new Set();
  if (!await expandInlineSections(clicked, { visibleOnly: true, passes: 2 })) {
    throw new Error("Page navigated during capture - will retry automatically");
  }
  if (!await scrollProfile(clicked)) {
    throw new Error("Page navigated during capture - will retry automatically");
  }

  let capture = collectProfileText(startUrl, { allowShort: true });
  const mainCharsFirstPass = capture.profileText.length;

  // If the first pass looks thin, run the broader expand+scroll once before
  // deciding to deep-navigate — matches captureProfile's existing two-pass
  // behaviour so we don't trigger needless navigations on profiles that just
  // need more clicks to fully render inline.
  if (needsDeeperCapture(capture)) {
    if (!await expandInlineSections(clicked, { visibleOnly: false, passes: 6 })) {
      throw new Error("Page navigated during capture - will retry automatically");
    }
    if (!await scrollProfile(clicked)) {
      throw new Error("Page navigated during capture - will retry automatically");
    }
    capture = collectProfileText(startUrl, { allowShort: true });
  }
  const mainChars = capture.profileText.length;

  const expRoles = countSectionRoles(capture.profileText, "experience");
  const wantsDeepNav = needsDeeperCapture(capture) || expRoles < 3;
  console.log("[RecruitMe] capture decision (navigation-aware)", {
    mainCharsFirstPass,
    mainChars,
    sections: capture.sectionKeys,
    experienceRolesDetected: expRoles,
    wantsDeepNav,
  });

  if (wantsDeepNav) {
    const detailsUrl = buildExperienceDetailsUrl(startUrl);
    if (detailsUrl && chrome?.storage?.local) {
      await writeNavCaptureState({
        sessionId, serverBase, expectedUrl,
        startUrl, detailsUrl,
        mainCapture: summarizeMainCaptureForState(capture, mainChars),
        deepText: null,
        deepMeta: null,
        stage: "navigating_to_details",
        startedAt: Date.now(),
      });
      console.log("[RecruitMe] navigating tab to /details/experience/", { detailsUrl });
      try { location.assign(detailsUrl); } catch (e) {
        console.warn("[RecruitMe] location.assign failed; clearing nav state", e?.message || e);
        await clearNavCaptureState();
        throw e;
      }
      // Throw a sentinel so runCaptureAndPost knows NOT to POST or report
      // an error — the resume function on the next page lifecycle will
      // continue from the saved state.
      throw new Error(NAV_CAPTURE_SENTINEL);
    }
  }

  // Inline path: same enrichment behaviour as the original captureProfile.
  let r = await enrichAll(capture, startUrl);
  let finalCapture = r.capture;
  let sectionMetas = r.sectionMetas;

  if (finalCapture.profileText.length < 200) {
    await sleep(1200);
    if (await scrollProfile(clicked)) {
      const more = collectProfileText(startUrl, { allowShort: true });
      r = await enrichAll(more, startUrl);
      finalCapture = r.capture; sectionMetas = r.sectionMetas;
    }
  }

  if (finalCapture.profileText.length < 200) {
    throw new Error(buildTooShortCaptureMessage(finalCapture, "navigation-aware inline validation"));
  }

  finalCapture.captureMeta = {
    capturedAt: new Date().toISOString(),
    mainProfileChars: mainChars,
    finalProfileChars: finalCapture.profileText.length,
    sections: sectionMetas,
    captureMethod: "inline",
  };
  return finalCapture;
}

// Runs on script load. Reads chrome.storage.local for in-flight nav state and
// either extracts (on details page) or finalizes + POSTs (on root page).
async function resumeNavigationCaptureIfNeeded() {
  const state = await readNavCaptureState();
  if (!state) return;

  // Stale state guard — covers the cases where the user closed the tab,
  // navigated to a different site, or LinkedIn didn't redirect as expected.
  if (Date.now() - (state.startedAt || 0) > NAV_CAPTURE_STALE_MS) {
    console.warn("[RecruitMe] nav-capture state stale; clearing", { ageMs: Date.now() - (state.startedAt || 0) });
    await clearNavCaptureState();
    return;
  }

  // Slug must match the in-flight session — otherwise we're either on a
  // different profile or another tab navigated us off-target.
  const stateSlug   = normaliseLinkedInSlug(state.startUrl);
  const currentSlug = normaliseLinkedInSlug(location.href);
  if (!stateSlug || stateSlug !== currentSlug) return;

  if (state.stage === "navigating_to_details") {
    if (!EXPERIENCE_DETAILS_PATH_RE.test(location.href)) return; // not on details yet — wait for next tick

    captureInProgress = true;
    captureInProgressSessionId = state.sessionId || "";
    try {
      console.log("[RecruitMe] resume: on /details/experience/, waiting for content");
      await waitForMain();
      await sleep(800);
      await scrollDetailsPage();

      const { text: deepText, meta: deepMeta } = extractExperienceFromLiveDocument();
      console.log("[RecruitMe] resume: details extraction done", {
        chars: deepText.length,
        reason: deepMeta.reason,
        firstLine: deepText.split("\n").slice(0, 2).join(" | ").slice(0, 200),
      });

      await writeNavCaptureState({
        ...state,
        deepText,
        deepMeta,
        stage: "details_done_navigating_back",
      });

      console.log("[RecruitMe] resume: navigating back to root profile", { startUrl: state.startUrl });
      try { location.assign(state.startUrl); } catch (e) {
        console.warn("[RecruitMe] back-navigation failed:", e?.message || e);
      }
      // Script will die during navigation — finalize runs in the next lifecycle.
    } catch (err) {
      console.warn("[RecruitMe] resume details step failed:", err?.message || err);
      // Fall through: navigate back with no deepText. Finalize will still
      // report the deep failure from the root page rather than silently
      // treating a main-only fallback as success.
      await writeNavCaptureState({
        ...state,
        deepText: null,
        deepMeta: { reason: "details_step_failed", status: 0, chars: 0, finalUrl: location.href.replace(/[?#].*$/, "") },
        stage: "details_done_navigating_back",
      });
      try { location.assign(state.startUrl); } catch { /* unloading */ }
    }
    return;
  }

  if (state.stage === "details_done_navigating_back") {
    if (!isRootLinkedInProfile(location.href)) return; // not back at root yet

    captureInProgress = true;
    captureInProgressSessionId = state.sessionId || "";
    try {
      // Brief settle pause; we don't actually need the live page since the
      // mainCapture is already in storage.
      await sleep(400);

      const mainCap = state.mainCapture;
      let finalText = mainCap.profileText;
      let mergeMode = "skip";
      let charsAdded = 0;
      const deepMeta = state.deepMeta || {
        reason: state.deepText ? "ok" : "empty",
        status: state.deepText ? 200 : 0,
        chars: state.deepText?.length || 0,
        finalUrl: state.detailsUrl,
      };

      if (!state.deepText) {
        const failure = buildDeepExperienceFailureMessage(deepMeta, mainCap.profileText.length).slice(0, 500);
        console.warn("[RecruitMe] resume: details capture failed; reporting session error", {
          failure,
          deepMeta,
          mainChars: mainCap.profileText.length,
        });
        await sendToServiceWorker(
          { type: "submit-capture-error", sessionId: state.sessionId, error: failure, serverBase: state.serverBase },
          15_000,
        ).catch(() => {});
        await clearNavCaptureState();
        return;
      }

      const merged = mergeExperienceSection(mainCap, state.deepText);
      finalText = merged.capture.profileText;
      mergeMode = merged.mode;
      charsAdded = merged.charsAdded;

      if (mergeMode === "skip-too-small") {
        const failure = buildDeepExperienceFailureMessage(
          { ...deepMeta, reason: "merge_skip_too_small", chars: state.deepText.length },
          mainCap.profileText.length
        ).slice(0, 500);
        console.warn("[RecruitMe] resume: details capture too small after merge; reporting session error", {
          failure,
          deepMeta,
          mainChars: mainCap.profileText.length,
          deepChars: state.deepText.length,
        });
        await sendToServiceWorker(
          { type: "submit-capture-error", sessionId: state.sessionId, error: failure, serverBase: state.serverBase },
          15_000,
        ).catch(() => {});
        await clearNavCaptureState();
        return;
      }

      const captureMeta = {
        capturedAt: new Date().toISOString(),
        mainProfileChars: mainCap.profileText.length,
        finalProfileChars: finalText.length,
        sections: [{
          key: "experience",
          fetched: true,
          status: deepMeta.status ?? 200,
          finalUrl: deepMeta.finalUrl || state.detailsUrl,
          fetchOutcome: deepMeta.reason || "ok",
          deepChars: deepMeta.chars ?? state.deepText.length,
          mergeMode,
          charsAdded,
        }],
        captureMethod: "navigation",
      };

      console.log("[RecruitMe] resume: POSTing capture", { chars: finalText.length, sessionId: state.sessionId, mergeMode });

      await sendToServiceWorker({
        type: "submit-capture-result",
        sessionId: state.sessionId,
        linkedinUrl: mainCap.linkedinUrl || state.startUrl,
        profileText: finalText,
        candidateName: mainCap.title || "",
        captureMeta,
        serverBase: state.serverBase,
      }, 120_000);

      console.log("[RecruitMe] resume: capture posted, clearing state");
      await clearNavCaptureState();
    } catch (err) {
      const msg = (err?.message || "Capture failed (post-navigation)").slice(0, 500);
      console.warn("[RecruitMe] resume finalize failed:", msg);
      await sendToServiceWorker(
        { type: "submit-capture-error", sessionId: state.sessionId, error: msg, serverBase: state.serverBase },
        15_000,
      ).catch(() => {});
      await clearNavCaptureState();
    } finally {
      captureInProgress = false;
      captureInProgressSessionId = "";
    }
  }
}

async function runCaptureAndPost(sessionId, serverBase, expectedUrl) {
  console.log("[RecruitMe] runCaptureAndPost start", { sessionId, expectedUrl, currentUrl: location.href });
  let captureTimer;
  try {
    if (!isRootLinkedInProfile(location.href)) {
      if (expectedUrl && linkedInProfileMatches(location.href, expectedUrl)) {
        location.assign(expectedUrl);
        const restored = await waitForRootProfilePage(expectedUrl);
        if (!restored) {
          throw new Error("LinkedIn profile did not return to the main profile page");
        }
      } else {
        throw new Error("LinkedIn profile was not on the main profile page");
      }
    }

    if (expectedUrl) {
      const currentSlug = normaliseLinkedInSlug(location.href);
      const expectedSlug = normaliseLinkedInSlug(expectedUrl);
      // Match against current URL OR the page's <link rel="canonical">. Catches
      // the LinkedIn-vanity-slug-changed-since-discovery case where the URL we
      // originally stored no longer matches the user's current vanity slug.
      if (!linkedInProfileMatchesWithCanonical(location.href, expectedUrl)) {
        const canonical = getLinkedInCanonicalUrl();
        const canonicalSlug = canonical ? normaliseLinkedInSlug(canonical) : "";
        throw new Error(
          `LinkedIn URL mismatch (expected ${expectedSlug || "?"}, got ${currentSlug || "?"}` +
          (canonicalSlug && canonicalSlug !== currentSlug ? ` / canonical ${canonicalSlug}` : "") +
          ")"
        );
      }
    }

    // Human-paced auto-capture takes 2–4 minutes per profile (slow scroll +
    // dwell + click-to-expand). Manual / non-human-paced captures are still
    // fast. Pick the timeout based on which mode is active.
    const human = await isHumanPacedMode();
    const captureTimeoutMs = human ? 360_000 : 70_000;
    const capture = await Promise.race([
      captureWithOptionalDeepNavigation(sessionId, serverBase, expectedUrl),
      new Promise((_, reject) => {
        captureTimer = setTimeout(
          () => reject(new Error("Profile capture timed out — reload the LinkedIn tab and try again")),
          captureTimeoutMs
        );
      }),
    ]);
    clearTimeout(captureTimer);

    console.log("[RecruitMe] capture done", { chars: capture.profileText.length, sections: capture.sectionKeys });
    // Hand the captured data to the service worker for the server POST.
    // The SW's host permissions bypass CORS restrictions that affect content scripts.
    await sendToServiceWorker(
      {
        type: "submit-capture-result",
        sessionId,
        linkedinUrl: capture.linkedinUrl,
        profileText: capture.profileText,
        candidateName: capture.title || "",
        captureMeta: capture.captureMeta,
        serverBase,
      },
      120_000
    );
  } catch (error) {
    clearTimeout(captureTimer);
    const msg = (error?.message || "Capture failed").slice(0, 500);
    // Navigation sentinel: capture handed off to /details/experience/ + the
    // resume function will finalize in the next content-script lifecycle.
    // Don't POST an error — the recruiter would see "Capture failed" mid-flow.
    if (msg === NAV_CAPTURE_SENTINEL) {
      console.log("[RecruitMe] capture handed off to navigation resume");
      return;
    }
    console.warn("[RecruitMe] capture failed:", msg);
    await sendToServiceWorker(
      { type: "submit-capture-error", sessionId, error: msg, serverBase },
      15_000
    ).catch((swErr) => {
      console.warn("[RecruitMe] failed to report error via SW:", swErr?.message || swErr);
      // Last-resort direct message — SW already handles badge/state for normal path
      chrome.runtime.sendMessage(
        { type: "capture-error", sessionId, error: msg },
        () => void chrome.runtime.lastError
      );
    });
  } finally {
    captureInProgress = false;
    captureInProgressSessionId = "";
    // Restore so the setInterval doesn't immediately re-send linkedin-page-observed.
    // Wrap in try/catch — if location.href throws (e.g. tab unloaded), the flag
    // has already been reset above so we don't leave it stuck.
    try {
      lastObservedUrl = location.href.replace(/[?#].*$/, "");
    } catch { /* tab navigated away — safe to ignore */ }
  }
}

function notifyBackground() {
  if (captureInProgress) return; // Don't send while a capture is running — avoids API spam
  if (!isLinkedInProfilePage()) return;
  if (!isRootLinkedInProfile(location.href)) return; // Skip sub-pages like /details/experience

  const linkedinUrl = location.href.replace(/[?#].*$/, "");
  if (linkedinUrl === lastObservedUrl) return;
  lastObservedUrl = linkedinUrl;

  // Wipe the stale overlay before fetching match data for the new profile —
  // otherwise the "On 2 jobs" pill from the previous candidate remains
  // visible until the new fetch resolves, which is confusing.
  removeOverlay();
  lastMatchQueriedUrl = "";

  chrome.runtime.sendMessage(
    {
      type: "linkedin-page-observed",
      linkedinUrl,
      title: document.title,
    },
    () => {
      void chrome.runtime.lastError;
    }
  );

  // Q2.3 — surface RecruitMe match info while the recruiter is browsing.
  // This is independent of the capture pipeline above: even if the candidate
  // isn't queued for a server-driven fetch, we still want to show "in 2 jobs"
  // or "add to {Job}?" on the page.
  void renderProfileMatchOverlay(linkedinUrl);
}

// ─── Q2.3: in-page profile match overlay ──────────────────────────────────────
// A tiny floating widget that calls /api/extension/profile-match for the
// current LinkedIn profile and renders one of three states:
//   1. On 1+ active jobs already → info pill linking back to the app
//   2. In library, not on the active jobs → "Add to {job}" buttons
//   3. Unknown person → no overlay (the existing capture flow handles new captures)
const OVERLAY_ID = "recruitme-profile-match-overlay";

function getOverlayServerBase(serverBase) {
  if (!serverBase) return "";
  return serverBase.replace(/\/+$/, "");
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function removeOverlay() {
  // Defensive: in test contexts the document mock may not implement
  // getElementById, and we don't want a missing-method to abort notifyBackground.
  try {
    const existing = document.getElementById?.(OVERLAY_ID);
    if (existing && typeof existing.remove === "function") existing.remove();
  } catch { /* DOM not fully available; nothing to remove */ }
}

// ── Draggable bubble shell ─────────────────────────────────────────────────
// Fluffy cloud aesthetic — soft white, generous rounding, layered shadows.
// Draggable by the header bar; position persists within the page session.
let overlayPos = { right: 20, bottom: 20 }; // remembered across re-renders
// Minimize state — when true the overlay collapses to a small floating
// ball; clicking the ball expands back to the full bubble. Persists across
// re-renders within the page session so a recruiter who minimised on one
// profile keeps the minimised state when navigating to the next.
let overlayMinimized = false;
const MIN_BALL_ID = "recruitme-min-ball";

// Last-rendered overlay context — stored so we can re-build the full overlay
// when the user clicks the minimised ball without re-fetching from the server.
let lastOverlayBuilder = null;

// Sticky "✓ Captured" state for the current profile — the recruiter sees
// this both immediately after a capture finishes (via the capture-complete
// message from the SW) and when revisiting a recently-captured profile
// (read from chrome.storage.local on overlay render).
let capturedBannerForUrl = "";  // url where the banner is currently active
let capturedBannerName = "";    // candidate name to display
let capturedBannerAt = 0;       // epoch ms when capture finished

function makeDraggable(container, handle) {
  let dragging = false, startX, startY, startLeft, startTop;
  handle.style.cursor = "grab";
  handle.addEventListener("mousedown", (e) => {
    if (e.target.closest("a, button")) return; // don't hijack clicks
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = container.getBoundingClientRect();
    startLeft = rect.left;
    startTop  = rect.top;
    container.style.transition = "none";
    handle.style.cursor = "grabbing";
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const newLeft = Math.max(0, Math.min(window.innerWidth  - container.offsetWidth,  startLeft + dx));
    const newTop  = Math.max(0, Math.min(window.innerHeight - container.offsetHeight, startTop  + dy));
    container.style.left   = newLeft + "px";
    container.style.top    = newTop  + "px";
    container.style.right  = "auto";
    container.style.bottom = "auto";
    overlayPos = { left: newLeft, top: newTop };
  });
  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    handle.style.cursor = "grab";
  });
}

function buildOverlayShell() {
  removeOverlay();
  const container = document.createElement("div");
  container.id = OVERLAY_ID;

  // Base position — use remembered pos or default bottom-right
  const posStyle = overlayPos.left !== undefined
    ? `left:${overlayPos.left}px;top:${overlayPos.top}px`
    : `right:${overlayPos.right}px;bottom:${overlayPos.bottom}px`;

  container.style.cssText = `
    position:fixed;${posStyle};
    z-index:2147483647;
    width:300px;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    font-size:13px;
    color:#1e293b;
    background:linear-gradient(135deg,rgba(255,255,255,0.98) 0%,rgba(248,250,255,0.98) 100%);
    border:1px solid rgba(148,163,184,0.25);
    border-radius:20px;
    box-shadow:
      0 0 0 1px rgba(255,255,255,0.8) inset,
      0 4px 6px rgba(15,23,42,0.04),
      0 12px 28px rgba(15,23,42,0.10),
      0 32px 48px rgba(15,23,42,0.06);
    backdrop-filter:blur(12px);
    -webkit-backdrop-filter:blur(12px);
    overflow:hidden;
    animation:recruitme-pop 0.18s cubic-bezier(0.34,1.56,0.64,1) both;
    line-height:1.45;
  `;

  // Inject animation keyframes once
  if (!document.getElementById("recruitme-styles")) {
    const style = document.createElement("style");
    style.id = "recruitme-styles";
    style.textContent = `
      @keyframes recruitme-pop {
        from { opacity:0; transform:scale(0.88) translateY(6px); }
        to   { opacity:1; transform:scale(1)    translateY(0);   }
      }
      @keyframes recruitme-spin {
        from { transform: rotate(0deg); }
        to   { transform: rotate(360deg); }
      }
    `;
    document.head.appendChild(style);
  }

  return container;
}

// Shared header bar used by all overlay states — draggable + minimize + close.
function buildHeader(label, accent) {
  return `
    <div id="recruitme-drag-handle" style="
      display:flex;align-items:center;gap:8px;
      padding:10px 14px 8px;
      background:linear-gradient(135deg,${accent}18 0%,${accent}08 100%);
      border-bottom:1px solid ${accent}20;
    ">
      <span style="
        display:inline-flex;align-items:center;justify-content:center;
        width:22px;height:22px;border-radius:50%;
        background:${accent};color:#fff;
        font-size:11px;font-weight:700;flex-shrink:0;
        box-shadow:0 2px 6px ${accent}50;
      ">R</span>
      <span style="font-weight:600;font-size:12px;color:#334155;flex:1">${label}</span>
      <button id="recruitme-overlay-minimize" aria-label="Minimize to ball" title="Minimize" style="
        background:none;border:none;color:#94a3b8;cursor:pointer;
        width:20px;height:20px;display:flex;align-items:center;justify-content:center;
        border-radius:50%;font-size:18px;line-height:1;padding:0 0 4px;
        transition:background 0.15s,color 0.15s;
      " onmouseover="this.style.background='#f1f5f9';this.style.color='#475569'"
         onmouseout="this.style.background='none';this.style.color='#94a3b8'">−</button>
      <button id="recruitme-overlay-close" aria-label="Close" style="
        background:none;border:none;color:#94a3b8;cursor:pointer;
        width:20px;height:20px;display:flex;align-items:center;justify-content:center;
        border-radius:50%;font-size:16px;line-height:1;padding:0;
        transition:background 0.15s,color 0.15s;
      " onmouseover="this.style.background='#f1f5f9';this.style.color='#475569'"
         onmouseout="this.style.background='none';this.style.color='#94a3b8'">×</button>
    </div>
  `;
}

// Wire the minimize button on every overlay state. Called after the header
// has been inserted so the button is queryable.
function wireMinimizeButton(container) {
  container.querySelector("#recruitme-overlay-minimize")?.addEventListener("click", () => {
    overlayMinimized = true;
    showMinimizedBall();
  });
}

// Tell the recruiter their profile was received by the app — paints a green
// "✓ Captured" banner at the top of the overlay bubble for ~10 minutes.
// Idempotent: re-paints whether the bubble was open, minimised, or absent.
function showCapturedBanner(candidateName) {
  capturedBannerForUrl = location.href.replace(/[?#].*$/, "");
  capturedBannerName = candidateName || "Profile";
  capturedBannerAt = Date.now();
  // Re-render whichever state is currently active so the banner shows.
  if (overlayMinimized) {
    showMinimizedBall();
  } else if (typeof lastOverlayBuilder === "function") {
    lastOverlayBuilder();
  } else {
    // No overlay rendered yet on this page — paint a standalone banner.
    paintStandaloneCapturedBanner(candidateName);
  }
}

function paintStandaloneCapturedBanner(candidateName) {
  removeOverlay();
  const container = buildOverlayShell();
  container.innerHTML = `
    <div style="padding:16px;text-align:center;">
      <div style="
        display:inline-flex;align-items:center;justify-content:center;
        width:36px;height:36px;border-radius:50%;
        background:#10b981;color:#fff;
        font-size:18px;font-weight:700;
        box-shadow:0 4px 10px rgba(16,185,129,0.30);
        margin-bottom:8px;
      ">✓</div>
      <p style="margin:0;font-weight:600;color:#065f46;font-size:13px;">
        Captured ${escapeHtml(candidateName || "profile")}
      </p>
      <p style="margin:4px 0 0;font-size:11px;color:#475569;">
        Sent to RecruitMe — scoring now.
      </p>
    </div>
  `;
  document.body.appendChild(container);
  // Auto-dismiss after 8s — recruiter has seen it, don't pollute the page.
  setTimeout(() => {
    if (capturedBannerForUrl === location.href.replace(/[?#].*$/, "")) {
      removeOverlay();
    }
  }, 8000);
}

// Returns { name, at, fresh } if the current profile URL was captured
// recently, otherwise null. Read from chrome.storage.local so the state
// survives popup-close, SW restart, page navigations.
async function getCapturedStateForCurrentProfile() {
  // First check the in-memory banner that was just set by capture-complete.
  const url = location.href.replace(/[?#].*$/, "");
  if (capturedBannerForUrl === url && Date.now() - capturedBannerAt < 30 * 60_000) {
    return { name: capturedBannerName, at: capturedBannerAt };
  }
  // Then check the persistent recentCaptures list.
  return new Promise((resolve) => {
    try {
      chrome.storage?.local?.get?.({ recentCaptures: [] }, (s) => {
        const match = (s?.recentCaptures || []).find((r) => r?.linkedinUrl === url);
        if (match && Date.now() - match.at < 30 * 60_000) {
          resolve({ name: match.name, at: match.at });
        } else {
          resolve(null);
        }
      }) ?? resolve(null);
    } catch { resolve(null); }
  });
}

function capturedBannerHTML(name, at) {
  const ms = Date.now() - at;
  const mins = Math.floor(ms / 60_000);
  const ago = mins < 1 ? "just now" : `${mins}m ago`;
  return `
    <div style="
      display:flex;align-items:center;gap:10px;
      padding:10px 14px;
      background:linear-gradient(135deg,#ecfdf5 0%,#d1fae5 100%);
      border-bottom:1px solid #a7f3d0;
      color:#065f46;
    ">
      <span style="
        display:inline-flex;align-items:center;justify-content:center;
        width:22px;height:22px;border-radius:50%;
        background:#10b981;color:#fff;
        font-size:12px;font-weight:700;flex-shrink:0;
        box-shadow:0 2px 6px rgba(16,185,129,0.30);
      ">✓</span>
      <div style="flex:1;min-width:0;">
        <p style="margin:0;font-weight:600;font-size:12px;color:#065f46;">
          Sent to RecruitMe
        </p>
        <p style="margin:1px 0 0;font-size:11px;color:#047857;">
          ${escapeHtml(name)} · ${ago}
        </p>
      </div>
    </div>
  `;
}

// Live "in progress" banner — for the window between Fetch click and capture
// completion. Tells the recruiter their action was registered without making
// them open the popup or guess. label is "Queued" or "Capturing now..."
function pendingBannerHTML(label, name) {
  return `
    <div style="
      display:flex;align-items:center;gap:10px;
      padding:10px 14px;
      background:linear-gradient(135deg,#eff6ff 0%,#dbeafe 100%);
      border-bottom:1px solid #bfdbfe;
      color:#1e40af;
    ">
      <span style="
        display:inline-flex;align-items:center;justify-content:center;
        width:22px;height:22px;border-radius:50%;
        background:#3b82f6;color:#fff;
        flex-shrink:0;
        box-shadow:0 2px 6px rgba(59,130,246,0.30);
      ">
        <span style="
          display:inline-block;width:10px;height:10px;
          border:2px solid #fff;border-top-color:transparent;
          border-radius:50%;
          animation:recruitme-spin 0.9s linear infinite;
        "></span>
      </span>
      <div style="flex:1;min-width:0;">
        <p style="margin:0;font-weight:600;font-size:12px;color:#1e3a8a;">
          ${escapeHtml(label)}
        </p>
        <p style="margin:1px 0 0;font-size:11px;color:#1e40af;">
          ${name ? escapeHtml(name) + " · " : ""}sent to RecruitMe
        </p>
      </div>
    </div>
  `;
}

// Returns one of: { kind: "captured", name, at } | { kind: "pending"|"processing", name } | null
// Combines the local recentCaptures state with a live /pending query so the
// bubble can show the in-flight state, not just post-completion.
async function getCaptureStatusForCurrentProfile(linkedinUrl) {
  // Live status from the server — this catches the "I just clicked Fetch"
  // case where there's nothing in recentCaptures yet but the session
  // exists with status=pending or processing.
  const live = await new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "check-pending", linkedinUrl }, (response) => {
        resolve(response && response.ok ? response : null);
      });
    } catch { resolve(null); }
  });

  if (live && live.active) {
    if (live.status === "processing") {
      return { kind: "processing", name: live.candidateName || "Profile" };
    }
    if (live.status === "pending") {
      return { kind: "pending", name: live.candidateName || "Profile" };
    }
  }

  // Otherwise check the local recentCaptures cache for a recent success.
  const cached = await getCapturedStateForCurrentProfile();
  if (cached) return { kind: "captured", name: cached.name, at: cached.at };
  return null;
}

function statusBannerHTML(status) {
  if (!status) return "";
  if (status.kind === "captured") return capturedBannerHTML(status.name, status.at);
  if (status.kind === "processing") return pendingBannerHTML("Capturing now…", status.name);
  if (status.kind === "pending") return pendingBannerHTML("Queued for capture", status.name);
  return "";
}

// Render the small floating ball that shows when the overlay is minimised.
// Three visual states based on the capture status of the current profile:
//   - pending/processing → blue with a spinner (capture in flight)
//   - captured            → green with a ✓ (sent to RecruitMe)
//   - none                → blue with R + a + badge (default)
function showMinimizedBall(status) {
  removeOverlay();
  document.getElementById(MIN_BALL_ID)?.remove();

  const posStyle = overlayPos.left !== undefined
    ? `left:${overlayPos.left}px;top:${overlayPos.top}px`
    : `right:${overlayPos.right}px;bottom:${overlayPos.bottom}px`;

  const isCaptured  = status?.kind === "captured";
  const isPending   = status?.kind === "pending" || status?.kind === "processing";

  const grad = isCaptured
    ? "linear-gradient(135deg,#10b981 0%,#059669 100%)"
    : "linear-gradient(135deg,#3b82f6 0%,#2563eb 100%)";
  const shadow = isCaptured
    ? "0 4px 10px rgba(16,185,129,0.30), 0 8px 24px rgba(15,23,42,0.18)"
    : "0 4px 10px rgba(37,99,235,0.30), 0 8px 24px rgba(15,23,42,0.18)";

  const ball = document.createElement("button");
  ball.id = MIN_BALL_ID;
  ball.type = "button";
  ball.setAttribute(
    "aria-label",
    isCaptured ? `Captured ${status.name} — click to expand`
      : isPending ? `Capturing ${status.name} — click to expand`
      : "Expand RecruitMe overlay",
  );
  ball.title = isCaptured
    ? `Sent to RecruitMe: ${status.name}`
    : isPending
      ? (status.kind === "processing" ? `Capturing now: ${status.name}` : `Queued: ${status.name}`)
      : "Expand RecruitMe (click +)";
  ball.style.cssText = `
    position:fixed;${posStyle};
    z-index:2147483647;
    width:44px;height:44px;
    border:none;border-radius:50%;cursor:pointer;
    background:${grad};
    color:#fff;font-weight:700;font-size:13px;
    display:flex;align-items:center;justify-content:center;
    box-shadow:0 0 0 1px rgba(255,255,255,0.3) inset, ${shadow};
    transition:transform 0.15s, box-shadow 0.15s;
    animation:recruitme-pop 0.18s cubic-bezier(0.34,1.56,0.64,1) both;
  `;
  ball.innerHTML = isCaptured
    ? `<span style="font-size:18px;line-height:1;">✓</span>`
    : isPending
      ? `<span style="
          display:inline-block;width:14px;height:14px;
          border:2px solid #fff;border-top-color:transparent;
          border-radius:50%;
          animation:recruitme-spin 0.9s linear infinite;
        "></span>`
      : `
        <span style="font-size:14px;line-height:1;">R</span>
        <span style="
          position:absolute;bottom:-2px;right:-2px;
          width:18px;height:18px;border-radius:50%;
          background:#fff;color:#2563eb;
          display:flex;align-items:center;justify-content:center;
          font-size:14px;font-weight:700;line-height:1;
          box-shadow:0 2px 6px rgba(15,23,42,0.20);
          border:1px solid #dbeafe;
        " aria-hidden="true">+</span>
      `;
  ball.onmouseover = () => { ball.style.transform = "scale(1.08)"; };
  ball.onmouseout  = () => { ball.style.transform = "scale(1)";    };

  // Drag support — same pattern as the bubble's makeDraggable but with a
  // click-vs-drag threshold so the recruiter can either reposition the ball
  // (drag >3px) or expand it back to the full bubble (clean click <3px).
  let dragging = false;
  let movedPx = 0;
  let startX = 0, startY = 0, startLeft = 0, startTop = 0;
  ball.style.cursor = "grab";
  ball.addEventListener("mousedown", (e) => {
    dragging = true;
    movedPx = 0;
    startX = e.clientX;
    startY = e.clientY;
    const rect = ball.getBoundingClientRect();
    startLeft = rect.left;
    startTop  = rect.top;
    ball.style.transition = "none";
    ball.style.cursor = "grabbing";
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    movedPx = Math.max(movedPx, Math.abs(dx), Math.abs(dy));
    const newLeft = Math.max(0, Math.min(window.innerWidth  - ball.offsetWidth,  startLeft + dx));
    const newTop  = Math.max(0, Math.min(window.innerHeight - ball.offsetHeight, startTop  + dy));
    ball.style.left   = newLeft + "px";
    ball.style.top    = newTop  + "px";
    ball.style.right  = "auto";
    ball.style.bottom = "auto";
    // Persist position so the bubble re-opens at the same spot.
    overlayPos = { left: newLeft, top: newTop };
  });
  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    ball.style.cursor = "grab";
  });

  ball.addEventListener("click", () => {
    // Don't expand if this was the end of a drag (user moved >3px).
    if (movedPx > 3) return;
    overlayMinimized = false;
    document.getElementById(MIN_BALL_ID)?.remove();
    // Re-render the last-known overlay state without re-fetching.
    if (typeof lastOverlayBuilder === "function") {
      lastOverlayBuilder();
    }
  });
  document.body.appendChild(ball);
}

function renderOnActiveJobs(container, data, serverBase) {
  const base = getOverlayServerBase(serverBase);
  const jobs = (data.onActiveJobs || []).slice(0, 4);
  const moreCount = (data.onActiveJobs || []).length - jobs.length;
  // Use first candidateId for contact logging (all jobs have same candidate)
  const firstCandidateId = jobs[0]?.candidateId || "";
  // Default the contact-log to the first active job. The dropdown below
  // lets the recruiter pick a different one when the candidate is on multiple.
  const defaultJobId = jobs[0]?.jobId || "";

  const jobPills = jobs.map((j) =>
    `<a href="${base}/jobs/${encodeURIComponent(j.jobId)}" target="_blank" rel="noopener" style="
      display:inline-flex;align-items:center;gap:4px;
      background:#eff6ff;border:1px solid #bfdbfe;color:#1d4ed8;
      border-radius:20px;padding:3px 10px;font-size:11px;font-weight:500;
      text-decoration:none;white-space:nowrap;
    ">${escapeHtml(j.jobTitle)}</a>`
  ).join(" ");

  const contacts = (data.recentContacts || []).slice(0, 2);
  // "re: [Role]" suffix — clickable link to that job page when present so a
  // recruiter can jump straight to the role context for a colleague's contact.
  const roleSuffix = (c) => {
    if (!c.jobId || !c.jobTitle) return "";
    const url = `${base}/jobs/${encodeURIComponent(c.jobId)}`;
    return ` · re: <a href="${url}" target="_blank" rel="noopener" style="color:#2563eb;text-decoration:none;">${escapeHtml(c.jobTitle)}</a>`;
  };
  const contactRows = contacts.map((c) =>
    `<div style="display:flex;align-items:flex-start;gap:6px;font-size:11px;color:#64748b;padding:3px 0">
      <span style="font-size:13px;line-height:1.4">${c.type === "call" ? "📞" : c.type === "email" ? "✉️" : "💬"}</span>
      <span style="flex:1;min-width:0">
        <strong style="color:#475569">${escapeHtml(c.userName)}</strong> ${escapeHtml(c.type)}d <span style="color:#94a3b8">· ${escapeHtml(c.relativeDate)}</span>${roleSuffix(c)}${c.note ? `<br><span style="color:#94a3b8">${escapeHtml(c.note)}</span>` : ""}
      </span>
    </div>`
  ).join("");

  // Job picker — only shown when the candidate is on 2+ active jobs so the
  // recruiter can specify which role the contact is about. Dropdown sits
  // right above the Messaged/Called buttons.
  const jobPicker = jobs.length > 1 ? `
    <div style="margin-top:10px;border-top:1px solid #f1f5f9;padding-top:10px">
      <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:#64748b">
        <span>About:</span>
        <select id="recruitme-contact-job" style="
          flex:1;font-size:11px;padding:4px 6px;
          border:1px solid #e2e8f0;border-radius:6px;background:#fff;color:#1e293b;
        ">
          ${jobs.map((j) => `<option value="${escapeHtml(j.jobId)}">${escapeHtml(j.jobTitle)}</option>`).join("")}
        </select>
      </label>
    </div>` : "";

  const logButtons = firstCandidateId ? `
    ${jobPicker}
    <div style="display:flex;gap:6px;margin-top:${jobs.length > 1 ? 6 : 10}px;${jobs.length > 1 ? "" : "border-top:1px solid #f1f5f9;padding-top:10px"}">
      <button class="recruitme-log-contact" data-type="message" data-candidate-id="${escapeHtml(firstCandidateId)}" data-default-job-id="${escapeHtml(defaultJobId)}" style="
        flex:1;display:flex;align-items:center;justify-content:center;gap:4px;
        background:#f0fdf4;border:1px solid #86efac;color:#15803d;
        border-radius:8px;padding:5px 8px;font-size:11px;font-weight:500;cursor:pointer;
      ">💬 Messaged</button>
      <button class="recruitme-log-contact" data-type="call" data-candidate-id="${escapeHtml(firstCandidateId)}" data-default-job-id="${escapeHtml(defaultJobId)}" style="
        flex:1;display:flex;align-items:center;justify-content:center;gap:4px;
        background:#eff6ff;border:1px solid #bfdbfe;color:#1d4ed8;
        border-radius:8px;padding:5px 8px;font-size:11px;font-weight:500;cursor:pointer;
      ">📞 Called</button>
    </div>
    <div id="recruitme-contact-status" style="font-size:11px;color:#64748b;text-align:center;display:none;padding-top:4px"></div>
  ` : "";

  container.innerHTML = `
    ${buildHeader("Already in RecruitMe", "#10b981")}
    <div style="padding:10px 14px 12px">
      <div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:${contactRows ? 10 : 0}px">
        ${jobPills}
        ${moreCount > 0 ? `<span style="font-size:11px;color:#94a3b8;align-self:center">+${moreCount} more</span>` : ""}
      </div>
      ${contactRows ? `
        <div style="border-top:1px solid #f1f5f9;padding-top:8px">
          <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#94a3b8;margin-bottom:4px">Contact history</div>
          ${contactRows}
        </div>` : ""}
      ${logButtons}
    </div>
  `;

  container.querySelectorAll(".recruitme-log-contact").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const candidateId = btn.getAttribute("data-candidate-id");
      const contactType = btn.getAttribute("data-type");
      const defaultJobId = btn.getAttribute("data-default-job-id") || "";
      // Use the dropdown-selected job when the recruiter picked one,
      // otherwise the default (single-job case = the only job).
      const picker = container.querySelector("#recruitme-contact-job");
      const jobId  = (picker && picker.value) || defaultJobId;
      const statusEl = container.querySelector("#recruitme-contact-status");
      container.querySelectorAll(".recruitme-log-contact").forEach((b) => { b.disabled = true; b.style.opacity = "0.6"; });
      if (statusEl) { statusEl.style.display = "block"; statusEl.textContent = "Logging…"; }
      try {
        const res = await sendToServiceWorker({ type: "log-contact", candidateId, contactType, jobId }, 8000);
        if (!res?.ok) throw new Error(res?.error || "Failed");
        if (statusEl) { statusEl.style.color = "#059669"; statusEl.textContent = `✓ ${contactType === "call" ? "Call" : "Message"} logged`; }
        // Refresh overlay after 1.5s to show updated contact history
        setTimeout(() => { removeOverlay(); lastMatchQueriedUrl = ""; renderProfileMatchOverlay(location.href.replace(/[?#].*$/, "")); }, 1500);
      } catch (e) {
        if (statusEl) { statusEl.style.color = "#dc2626"; statusEl.textContent = e.message || "Error logging contact"; }
        container.querySelectorAll(".recruitme-log-contact").forEach((b) => { b.disabled = false; b.style.opacity = "1"; });
      }
    });
  });

  container.querySelector("#recruitme-overlay-close")?.addEventListener("click", removeOverlay);
  wireMinimizeButton(container);
  makeDraggable(container, container.querySelector("#recruitme-drag-handle"));
}

function renderSuggestedJobs(container, data, linkedinUrl, serverBase) {
  const suggested = (data.suggestedJobs || []).slice(0, 3);
  // Library candidates with no active job match still get the bubble — the
  // recruiter wants to be able to log "messaged" / "called" against them too.
  // They just won't see the jobId-tagged "re: Role" — events are untagged.
  const libCandidateId = data.libraryCandidateId || "";
  if (suggested.length === 0 && !data.inLibrary) { removeOverlay(); return; }

  const accent = data.inLibrary ? "#3b82f6" : "#8b5cf6";
  const label  = data.inLibrary ? "In your library" : "Not yet tracked";

  const jobButtons = suggested.map((j) =>
    `<button class="recruitme-add-to-job"
      data-job-id="${escapeHtml(j.id)}"
      data-job-title="${escapeHtml(j.title)}"
      style="
        display:flex;align-items:center;gap:6px;width:100%;text-align:left;
        background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;
        padding:7px 10px;margin-top:5px;cursor:pointer;color:#1e293b;font-size:12px;
        transition:background 0.12s,border-color 0.12s;
      "
      onmouseover="this.style.background='#eff6ff';this.style.borderColor='#bfdbfe'"
      onmouseout="this.style.background='#f8fafc';this.style.borderColor='#e2e8f0'"
    >
      <span style="color:#3b82f6;font-size:14px">+</span>
      <span><strong>${escapeHtml(j.title)}</strong>${j.company ? ` <span style="color:#94a3b8;font-size:11px">· ${escapeHtml(j.company)}</span>` : ""}</span>
    </button>`
  ).join("");

  // Contact history for this library candidate so colleagues see what you've
  // already done. Same shape as the on-active-jobs view.
  const base = getOverlayServerBase(serverBase);
  const contacts = (data.recentContacts || []).slice(0, 2);
  const roleSuffix = (c) => {
    if (!c.jobId || !c.jobTitle) return "";
    const url = `${base}/jobs/${encodeURIComponent(c.jobId)}`;
    return ` · re: <a href="${url}" target="_blank" rel="noopener" style="color:#2563eb;text-decoration:none;">${escapeHtml(c.jobTitle)}</a>`;
  };
  const contactRows = contacts.map((c) =>
    `<div style="display:flex;align-items:flex-start;gap:6px;font-size:11px;color:#64748b;padding:3px 0">
      <span style="font-size:13px;line-height:1.4">${c.type === "call" ? "📞" : c.type === "email" ? "✉️" : "💬"}</span>
      <span style="flex:1;min-width:0">
        <strong style="color:#475569">${escapeHtml(c.userName)}</strong> ${escapeHtml(c.type)}d <span style="color:#94a3b8">· ${escapeHtml(c.relativeDate)}</span>${roleSuffix(c)}${c.note ? `<br><span style="color:#94a3b8">${escapeHtml(c.note)}</span>` : ""}
      </span>
    </div>`
  ).join("");

  // Messaged/Called buttons — only when we have a candidate ID to attach the
  // event to (i.e. they're already in the library). For genuinely unknown
  // people, the recruiter has to add-to-job first to create the candidate.
  // No job picker here because by definition this candidate isn't on any
  // active job; events log with jobId=null and display untagged.
  const logButtons = libCandidateId ? `
    <div style="display:flex;gap:6px;margin-top:10px;border-top:1px solid #f1f5f9;padding-top:10px">
      <button class="recruitme-log-contact" data-type="message" data-candidate-id="${escapeHtml(libCandidateId)}" data-default-job-id="" style="
        flex:1;display:flex;align-items:center;justify-content:center;gap:4px;
        background:#f0fdf4;border:1px solid #86efac;color:#15803d;
        border-radius:8px;padding:5px 8px;font-size:11px;font-weight:500;cursor:pointer;
      ">💬 Messaged</button>
      <button class="recruitme-log-contact" data-type="call" data-candidate-id="${escapeHtml(libCandidateId)}" data-default-job-id="" style="
        flex:1;display:flex;align-items:center;justify-content:center;gap:4px;
        background:#eff6ff;border:1px solid #bfdbfe;color:#1d4ed8;
        border-radius:8px;padding:5px 8px;font-size:11px;font-weight:500;cursor:pointer;
      ">📞 Called</button>
    </div>
    <div id="recruitme-contact-status" style="font-size:11px;color:#64748b;text-align:center;display:none;padding-top:4px"></div>
  ` : "";

  container.innerHTML = `
    ${buildHeader(label, accent)}
    <div style="padding:10px 14px 12px">
      ${suggested.length > 0 ? `
        <div style="font-size:11px;color:#64748b;margin-bottom:2px">Add to one of your active jobs:</div>
        ${jobButtons}
      ` : ""}
      ${contactRows ? `
        <div style="${suggested.length > 0 ? "border-top:1px solid #f1f5f9;padding-top:8px;margin-top:10px" : ""}">
          <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#94a3b8;margin-bottom:4px">Contact history</div>
          ${contactRows}
        </div>` : ""}
      ${logButtons}
      <div id="recruitme-overlay-status" style="margin-top:8px;font-size:11px;color:#64748b;display:none"></div>
    </div>
  `;
  container.querySelectorAll(".recruitme-add-to-job").forEach((btn) =>
    btn.addEventListener("click", (e) => handleAddToJobClick(e.currentTarget, linkedinUrl, serverBase))
  );
  // Same contact-log handler as renderOnActiveJobs — sends jobId when set.
  container.querySelectorAll(".recruitme-log-contact").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const candidateId = btn.getAttribute("data-candidate-id");
      const contactType = btn.getAttribute("data-type");
      const jobId = btn.getAttribute("data-default-job-id") || "";
      const statusEl = container.querySelector("#recruitme-contact-status");
      container.querySelectorAll(".recruitme-log-contact").forEach((b) => { b.disabled = true; b.style.opacity = "0.6"; });
      if (statusEl) { statusEl.style.display = "block"; statusEl.textContent = "Logging…"; }
      try {
        const res = await sendToServiceWorker({ type: "log-contact", candidateId, contactType, jobId }, 8000);
        if (!res?.ok) throw new Error(res?.error || "Failed");
        if (statusEl) { statusEl.style.color = "#059669"; statusEl.textContent = `✓ ${contactType === "call" ? "Call" : "Message"} logged`; }
        setTimeout(() => { removeOverlay(); lastMatchQueriedUrl = ""; renderProfileMatchOverlay(location.href.replace(/[?#].*$/, "")); }, 1500);
      } catch (e) {
        if (statusEl) { statusEl.style.color = "#dc2626"; statusEl.textContent = e.message || "Error logging contact"; }
        container.querySelectorAll(".recruitme-log-contact").forEach((b) => { b.disabled = false; b.style.opacity = "1"; });
      }
    });
  });
  container.querySelector("#recruitme-overlay-close")?.addEventListener("click", removeOverlay);
  wireMinimizeButton(container);
  makeDraggable(container, container.querySelector("#recruitme-drag-handle"));
}

async function handleAddToJobClick(button, linkedinUrl, serverBase) {
  const jobId = button.getAttribute("data-job-id");
  const jobTitle = button.getAttribute("data-job-title") || "job";
  const status = document.getElementById("recruitme-overlay-status");
  const setStatus = (text, colour = "#64748b") => {
    if (!status) return;
    status.style.display = "block";
    status.style.color = colour;
    status.textContent = text;
  };
  // Disable all add buttons during a single capture so the recruiter doesn't
  // queue two simultaneous captures of the same profile.
  document.querySelectorAll(".recruitme-add-to-job").forEach((b) => {
    b.disabled = true;
    b.style.opacity = "0.6";
    b.style.cursor = "not-allowed";
  });
  setStatus(`Capturing profile…`);
  try {
    const capture = await captureProfile();
    if (!capture?.profileText || capture.profileText.length < 100) {
      throw new Error(buildTooShortCaptureMessage(capture, "add-to-job import"));
    }
    setStatus(`Adding to ${jobTitle}…`);
    const res = await sendToServiceWorker(
      {
        type: "submit-add-to-job",
        jobId,
        linkedinUrl,
        profileText: capture.profileText,
        captureMeta: capture.captureMeta,
      },
      120000
    );
    if (!res?.ok) throw new Error(res?.error || "Add to job failed");
    setStatus(`✓ Added to ${jobTitle}`, "#059669");
    const base = getOverlayServerBase(serverBase);
    if (base) {
      // Linkify the success message after a short delay so the user can click through.
      setTimeout(() => {
        if (status) {
          status.innerHTML = `✓ Added to <a href="${base}/jobs/${encodeURIComponent(jobId)}" target="_blank" rel="noopener" style="color:#059669;text-decoration:underline">${escapeHtml(jobTitle)}</a>`;
        }
      }, 100);
    }
  } catch (err) {
    setStatus(err?.message || "Failed to add. Try again.", "#dc2626");
    document.querySelectorAll(".recruitme-add-to-job").forEach((b) => {
      b.disabled = false;
      b.style.opacity = "1";
      b.style.cursor = "pointer";
    });
  }
}

// Tracks the last URL we fetched match data for so we don't refetch on every
// notify cycle.
let lastMatchQueriedUrl = "";

async function renderProfileMatchOverlay(linkedinUrl) {
  if (!linkedinUrl) return;
  if (lastMatchQueriedUrl === linkedinUrl) return;
  lastMatchQueriedUrl = linkedinUrl;

  // Two parallel fetches: match data (slow) and live capture status (fast).
  // The capture banner needs to surface even when match data fails or
  // hasn't returned yet.
  const statusPromise = getCaptureStatusForCurrentProfile(linkedinUrl).catch(() => null);
  const matchPromise  = sendToServiceWorker({ type: "query-profile-match", linkedinUrl }, 8000)
    .catch(() => null);

  const [status, res] = await Promise.all([statusPromise, matchPromise]);

  const data = res?.ok ? res.data : null;
  const onActive = data ? (data.onActiveJobs || []).length > 0 : false;
  const hasMatchContent = data
    ? (onActive || data.inLibrary || (data.suggestedJobs || []).length > 0)
    : false;

  if (!hasMatchContent && !status) {
    // No match data AND no capture state — genuinely nothing to show.
    return;
  }

  // Build closure that paints the overlay. Stashed in a module variable so
  // the minimised ball can call it on click without re-querying.
  const builder = () => {
    const container = buildOverlayShell();
    if (hasMatchContent && data && res) {
      if (onActive) {
        renderOnActiveJobs(container, data, res.serverBase);
      } else {
        renderSuggestedJobs(container, data, linkedinUrl, res.serverBase);
      }
    }
    // Always prepend the status banner when present, above whatever match
    // content rendered (or as the sole content for captured/pending
    // profiles that don't match any job).
    const banner = statusBannerHTML(status);
    if (banner) container.insertAdjacentHTML("afterbegin", banner);
    document.body.appendChild(container);
  };
  lastOverlayBuilder = builder;

  if (overlayMinimized) {
    // Recruiter previously minimised — keep the ball visible. Pass the
    // status so the ball can render green ✓ when captured, or blue spinner
    // when pending/processing.
    showMinimizedBall(status);
  } else {
    builder();
  }

  // Re-poll while a capture is in progress so the bubble updates from
  // "Queued" → "Capturing now…" → "✓ Sent to RecruitMe" without the
  // recruiter having to refresh.
  if (status && (status.kind === "pending" || status.kind === "processing")) {
    schedulePendingPoll(linkedinUrl);
  }
}

// Poll the bubble's status banner every 5s while a capture is in flight,
// up to 3 minutes. Stops as soon as the status moves to "captured" or null.
let pendingPollTimer = null;
function schedulePendingPoll(linkedinUrl) {
  if (pendingPollTimer) clearTimeout(pendingPollTimer);
  const startedAt = Date.now();
  const tick = async () => {
    if (Date.now() - startedAt > 3 * 60_000) return;
    if (location.href.replace(/[?#].*$/, "") !== linkedinUrl) return; // user navigated away
    const status = await getCaptureStatusForCurrentProfile(linkedinUrl).catch(() => null);
    if (status?.kind === "captured" || !status) {
      // Force a re-render with the new status — bypass the lastMatchQueriedUrl cache.
      lastMatchQueriedUrl = "";
      removeOverlay();
      void renderProfileMatchOverlay(linkedinUrl);
      return;
    }
    // Still pending/processing — keep polling and re-render to refresh the label.
    lastMatchQueriedUrl = "";
    removeOverlay();
    void renderProfileMatchOverlay(linkedinUrl);
    pendingPollTimer = setTimeout(tick, 5000);
  };
  pendingPollTimer = setTimeout(tick, 5000);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Auto-capture: content script owns the full capture + POST so the
  // service worker doesn't need to stay alive for 30-60 seconds.
  if (message?.type === "capture-and-post") {
    if (captureInProgress) {
      if (captureInProgressSessionId && captureInProgressSessionId !== message.sessionId) {
        sendResponse({ ok: false, error: "Another RecruitMe capture is already running in this tab" });
        return false;
      }
      sendResponse({ ok: true, status: "in-progress" });
      return false;
    }
    captureInProgress = true;
    captureInProgressSessionId = message.sessionId || "";
    sendResponse({ ok: true, status: "started" });
    void runCaptureAndPost(message.sessionId, message.serverBase, message.linkedinUrl);
    return false;
  }

  // Background fired this when a capture for THIS tab finished — show a
  // green banner inside the on-page bubble so the recruiter knows the
  // profile was received by the app.
  if (message?.type === "capture-complete-banner") {
    showCapturedBanner(message.candidateName);
    sendResponse({ ok: true });
    return false;
  }

  // Manual capture (popup button): synchronous so popup gets real-time result.
  if (message?.type === "capture-profile") {
    void captureProfile()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "ping-profile") {
    sendResponse({
      ok: true,
      data: { linkedinUrl: location.href.replace(/[?#].*$/, ""), title: document.title },
    });
  }
});

// Resume any in-flight navigation capture from a previous content-script
// lifecycle. Runs at multiple delays because we may load before the LinkedIn
// SPA has finished routing — early calls just no-op until the URL/DOM matches.
void resumeNavigationCaptureIfNeeded();
setTimeout(() => void resumeNavigationCaptureIfNeeded(), 1500);
setTimeout(() => void resumeNavigationCaptureIfNeeded(), 4000);
setTimeout(() => void resumeNavigationCaptureIfNeeded(), 8000);

notifyBackground();
setTimeout(notifyBackground, 1500);
setTimeout(notifyBackground, 4000);
setInterval(() => {
  // Re-check resume on every observe tick so SPA URL transitions
  // (root → /details/experience/ → root) get picked up promptly.
  void resumeNavigationCaptureIfNeeded();

  if (!isLinkedInProfilePage()) {
    // Clean up the match overlay when the recruiter clicks off a profile —
    // we don't want a stale "On 2 jobs" pill (or its minimised ball)
    // hovering on the LinkedIn home.
    removeOverlay();
    document.getElementById(MIN_BALL_ID)?.remove();
    lastMatchQueriedUrl = "";
    return;
  }
  const linkedinUrl = location.href.replace(/[?#].*$/, "");
  if (linkedinUrl !== lastObservedUrl) {
    notifyBackground();
  }
}, OBSERVE_INTERVAL_MS);
