/**
 * Diagnose — prove the three DOM-dependent pieces against a live LinkedIn page.
 *
 * Card extraction, the Locations filter driver and the profile section reader
 * all depend on markup I cannot see from outside the browser. Every failure so
 * far has been "it didn't work" followed by me guessing which of the three
 * broke. This runs each in order and reports exactly what it found.
 *
 * No model calls, so it costs nothing and can be run as often as needed. It is
 * the fastest way to turn a vague failure into a named one.
 */

import { record } from "./recorder.js";

// Dual-context binding. The panel loads these files as one classic bundle
// (panel-lib.js) where imports are stripped and dependencies are published on
// window.RM; the module sources are still used by the unit tests. `typeof` is
// safe against the stripped-bundle case where the imported binding does not
// exist at all.
const RM = (typeof window !== "undefined" && window.RM) || {};
const record$ = RM.record || (typeof record !== "undefined" ? record : null);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createDiagnostic({ onProgress, tabs }) {
  let tabId = null;

  const ask = (id, msg) =>
    new Promise((resolve) => {
      tabs.sendMessage(id, msg, (res) => {
        void chrome.runtime.lastError;
        resolve(res || { ok: false, error: "No reply from the page — the content script may not be loaded." });
      });
    });

  async function navigate(url) {
    if (tabId === null) {
      const tab = await tabs.create({ url, active: false });
      tabId = tab.id;
    } else {
      await tabs.update(tabId, { url, active: false });
    }
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const t = await tabs.get(tabId).catch(() => null);
      if (t && t.status === "complete") break;
    }
    return (await tabs.get(tabId).catch(() => null))?.url || url;
  }

  return {
    async run({ location = "Wellington, New Zealand", query = "software engineer" } = {}) {
      const lines = [];
      const say = (s) => {
        lines.push(s);
        record$.note(s);
        onProgress(lines.join("\n"));
      };

      try {
        say("Opening LinkedIn people search…");
        const landed = await navigate(
          `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(query)}`,
        );

        if (/\/(checkpoint|authwall|uas\/login|login)(\?|\/|$)/i.test(landed)) {
          say("BLOCKED — LinkedIn showed a login or security check.");
          say("Sign in to LinkedIn in a normal tab, then run this again.");
          return lines.join("\n");
        }
        say(`Landed on: ${landed.slice(0, 90)}`);
        await sleep(2500);

        // ── 1. Card extraction ────────────────────────────────────────────
        const cards = await ask(tabId, { type: "RECRUITME_EXTRACT_CARDS" });
        if (cards.ok) {
          say(`CARDS: OK — ${cards.cards.length} candidate(s) parsed.`);
          const sample = cards.cards[0];
          if (sample) {
            say(`  first: ${sample.name || "(no name)"} — ${sample.headline || "(no headline)"}`);
            say(`  location field: ${sample.location || "(empty)"}`);
          } else {
            say("  ...but the list is empty. LinkedIn rendered its no-results message.");
          }
        } else {
          say(`CARDS: FAILED — ${cards.reason || ""} ${cards.error || cards.detail || ""}`.trim());
        }

        // ── 2. Locations filter ───────────────────────────────────────────
        const loc = await ask(tabId, { type: "RECRUITME_SET_LOCATION", location });
        if (loc.ok) {
          say(`LOCATION FILTER: OK — applied "${loc.applied}".`);
          say(`  url now: ${(loc.url || "").slice(0, 110)}`);
          if (!loc.confirmed) say("  NOTE: clicked through, but the URL did not visibly change.");
        } else {
          say(`LOCATION FILTER: FAILED — ${loc.error}`);
        }

        // ── 3. Profile section reader ─────────────────────────────────────
        const target = cards.ok && cards.cards[0]?.url;
        if (!target) {
          say("PROFILE READ: skipped — no candidate URL to open.");
        } else {
          say(`Opening ${target.replace("https://www.linkedin.com", "")}…`);
          await navigate(target);
          await sleep(3500);
          const p = await ask(tabId, { type: "RECRUITME_PROFILE" });
          if (p.ok) {
            const d = p.profile;
            say("PROFILE READ: OK");
            for (const key of ["name", "headline", "location", "about", "experience", "education", "skills"]) {
              const v = d[key] || "";
              say(`  ${key.padEnd(10)} ${v ? `${String(v.length).padStart(5)} chars` : "    — MISSING"}`);
            }
          } else {
            say(`PROFILE READ: FAILED — ${p.error}`);
            say("  (this usually means LinkedIn renamed its #experience / #education section ids)");
          }
        }

        say("");
        say("Done. Paste this whole report back if anything says FAILED or MISSING.");
      } catch (err) {
        say(`Diagnostic crashed: ${err?.message || String(err)}`);
      } finally {
        if (tabId !== null) {
          await tabs.remove(tabId).catch(() => {});
          tabId = null;
        }
      }
      return lines.join("\n");
    },
  };
}
