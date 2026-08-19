import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import vm from "vm";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadContentScriptContext(overrides = {}) {
  const code = fs.readFileSync(path.join(__dirname, "content.js"), "utf8");
  const listeners = [];
  const context = {
    console,
    URL,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    location: { href: "https://example.com/" },
    document: { querySelector: () => null, body: null },
    window: {},
    chrome: {
      runtime: {
        lastError: null,
        sendMessage: () => {},
        onMessage: {
          addListener: (listener) => listeners.push(listener),
        },
      },
    },
    ...overrides,
  };

  vm.createContext(context);
  vm.runInContext(code, context);
  return { context, listeners };
}

describe("RecruitMe content script", () => {
  it("builds LinkedIn experience details URLs without preserving query strings", () => {
    const { context } = loadContentScriptContext();

    expect(
      context.buildExperienceDetailsUrl("https://www.linkedin.com/in/jane-candidate/?miniProfileUrn=abc#top")
    ).toBe("https://www.linkedin.com/in/jane-candidate/details/experience/");
  });

  it("treats LinkedIn numeric-suffix redirects as the same profile", () => {
    const { context } = loadContentScriptContext();

    expect(
      context.linkedInProfileMatches(
        "https://www.linkedin.com/in/ranjana-tyagi-3755b615/",
        "https://www.linkedin.com/in/ranjanatyagi/"
      )
    ).toBe(true);
    expect(
      context.linkedInProfileMatches(
        "https://www.linkedin.com/in/ranjana-tyagi-3755b615/",
        "https://www.linkedin.com/in/someone-else/"
      )
    ).toBe(false);
  });

  it("falls back to the page's <link rel=canonical> when slug variants don't match directly", () => {
    // Real-world case: RecruitMe stored the numeric-suffix slug from SerpAPI,
    // user has since changed their vanity slug to include a middle initial.
    // The two slugs don't share a normalised alias key, so naive matching
    // fails — but the page itself carries a canonical URL we can use.
    const { context } = loadContentScriptContext({
      location: { href: "https://www.linkedin.com/in/alexjwardega/" },
      document: {
        querySelector: (sel) =>
          sel === 'link[rel="canonical"]'
            ? { getAttribute: () => "https://www.linkedin.com/in/alex-wardega-2b3b16267/" }
            : null,
        body: null,
      },
    });

    // Direct match fails (different slugs, the alias keys also differ).
    expect(
      context.linkedInProfileMatches(
        "https://www.linkedin.com/in/alexjwardega/",
        "https://www.linkedin.com/in/alex-wardega-2b3b16267/"
      )
    ).toBe(false);

    // But the canonical-aware matcher succeeds because the page exposes the
    // expected URL via <link rel="canonical">.
    expect(
      context.linkedInProfileMatchesWithCanonical(
        "https://www.linkedin.com/in/alexjwardega/",
        "https://www.linkedin.com/in/alex-wardega-2b3b16267/"
      )
    ).toBe(true);
  });

  it("does not match unrelated profiles even with a canonical present", () => {
    const { context } = loadContentScriptContext({
      location: { href: "https://www.linkedin.com/in/alexjwardega/" },
      document: {
        querySelector: () => ({
          getAttribute: () => "https://www.linkedin.com/in/alex-wardega-2b3b16267/",
        }),
        body: null,
      },
    });

    expect(
      context.linkedInProfileMatchesWithCanonical(
        "https://www.linkedin.com/in/alexjwardega/",
        "https://www.linkedin.com/in/some-other-person/"
      )
    ).toBe(false);
  });

  it("replaces a short root Experience section with fetched full experience details", () => {
    const { context } = loadContentScriptContext();
    const capture = {
      profileText: "Jane Candidate\nEngineer\n\nExperience\nShort role\n\nEducation\nVictoria University",
      sectionKeys: ["experience", "education"],
    };
    const fullExperienceText = [
      "Experience",
      "Senior Engineer",
      "Acme",
      "Built hiring platforms, integrations, reporting workflows, and production data systems across a multi-year programme.",
      "Earlier Engineer",
      "Beta",
      "Owned API integrations, frontend delivery, search workflows, and internal automation for recruiting teams.",
    ].join("\n");

    // mergeExperienceSection now returns { capture, mode, charsAdded } so the
    // caller can record proof-of-merge metadata. The merged profile text lives
    // on .capture.
    const result = context.mergeExperienceSection(capture, fullExperienceText);
    const merged = result.capture;

    expect(merged.profileText).toContain("Earlier Engineer");
    expect(merged.profileText).not.toContain("Short role");
    expect(merged.profileText).toContain("Education\nVictoria University");
    expect(merged.sectionKeys).toContain("experience");
    expect(result.mode).toBe("replace");
    expect(result.charsAdded).toBeGreaterThan(0);
  });

  // ── Stricter deep-section merging — proof the audit-driven fixes hold ─────
  it("findSectionHeader matches case-insensitively and returns the right index", () => {
    const { context } = loadContentScriptContext();
    const text = "Jane\nEngineer\n\nExperience\nCurrent role\n\nEducation\nUni";
    const exp = context.findSectionHeader(text, "experience");
    expect(exp).not.toBeNull();
    expect(exp.header).toBe("Experience");
    expect(text.slice(exp.index, exp.index + 10)).toBe("Experience");
    const skills = context.findSectionHeader(text, "skills");
    expect(skills).toBeNull();
  });

  it("getSectionContentSize stops at the next known section header (not at random keywords)", () => {
    const { context } = loadContentScriptContext();
    const text = "About\n\nSkills\nReact, Rails, leadership\n\nEducation\nUni";
    const size = context.getSectionContentSize(text, "skills");
    // "React, Rails, leadership" plus the leading newline before "Education" — bounded.
    expect(size).toBeGreaterThan(10);
    expect(size).toBeLessThan(40);
  });

  // Deep section text needs ≥60 chars to be considered useful — match real
  // LinkedIn output so the merge logic, not the early-exit, is what's tested.
  const SKILLS_DEEP = "Skills\nReact\nRails\nLeadership\nSystem design\nMentoring\nDistributed systems";

  it("mergeSection appends a fresh skills block when the main capture has no Skills header", () => {
    const { context } = loadContentScriptContext();
    const main = {
      profileText: "Jane\nEngineer\n\nExperience\nLong-form experience block.",
      sectionKeys: ["experience"],
    };
    const result = context.mergeSection(main, SKILLS_DEEP, "skills", "Skills");
    expect(result.mode).toBe("append");
    expect(result.capture.profileText).toContain("Skills\nReact\nRails\nLeadership");
    expect(result.capture.sectionKeys).toContain("skills");
    expect(result.charsAdded).toBeGreaterThan(0);
  });

  // The bug this guards against: previous appendSection used
  // profileText.includes(normalizeLineKey("skills")) so any profile mentioning
  // the word "skills" (basically all of them) silently blocked the deep fetch.
  it("mergeSection does not false-positive on the word 'skills' appearing in unrelated text", () => {
    const { context } = loadContentScriptContext();
    const main = {
      profileText: "Jane\nEngineer with strong technical skills\n\nExperience\nLong-form experience block.",
      sectionKeys: ["experience"],
    };
    const result = context.mergeSection(main, SKILLS_DEEP, "skills", "Skills");
    // Should still append because there's no actual "Skills\n..." header in main.
    expect(result.mode).toBe("append");
    expect(result.capture.profileText).toContain("Skills\nReact\nRails\nLeadership");
  });

  it("mergeSection skips deep fetch when main already has a substantial section", () => {
    const { context } = loadContentScriptContext();
    const main = {
      // 600+ chars under the Skills header — main capture is already detailed.
      profileText: "Jane\nEngineer\n\nSkills\n" + "React experience across multiple complex products with end-to-end ownership. ".repeat(10),
      sectionKeys: ["skills"],
    };
    const result = context.mergeSection(main, SKILLS_DEEP, "skills", "Skills");
    expect(result.mode).toBe("skip-already-present");
    expect(result.charsAdded).toBe(0);
  });

  it("mergeSection replaces a thin existing section with a richer deep version", () => {
    const { context } = loadContentScriptContext();
    const main = {
      profileText: "Jane\nEngineer\n\nSkills\nReact\n\nEducation\nUni",
      sectionKeys: ["skills", "education"],
    };
    const skillsText = "Skills\nReact\nRails\nLeadership\nSystem design\nMentoring junior engineers across multiple teams";
    const result = context.mergeSection(main, skillsText, "skills", "Skills");
    expect(result.mode).toBe("replace");
    // Education should still be present below.
    expect(result.capture.profileText).toContain("Education\nUni");
    expect(result.capture.profileText).toContain("Mentoring junior engineers");
    expect(result.charsAdded).toBeGreaterThan(0);
  });

  it("isDeepPageResponseValid only accepts URLs that landed on the requested deep page", () => {
    const { context } = loadContentScriptContext();
    expect(context.isDeepPageResponseValid("https://www.linkedin.com/in/jane/details/skills/", "skills")).toBe(true);
    expect(context.isDeepPageResponseValid("https://www.linkedin.com/in/jane/details/skills",  "skills")).toBe(true);
    // Redirected back to main profile — must reject.
    expect(context.isDeepPageResponseValid("https://www.linkedin.com/in/jane/", "skills")).toBe(false);
    // Wrong section requested.
    expect(context.isDeepPageResponseValid("https://www.linkedin.com/in/jane/details/education/", "skills")).toBe(false);
    // Login wall.
    expect(context.isDeepPageResponseValid("https://www.linkedin.com/login", "skills")).toBe(false);
  });

  it("capSectionText preserves short sections and truncates oversize ones at a line boundary", () => {
    const { context } = loadContentScriptContext();
    const short = "Skills\nReact\nRails";
    expect(context.capSectionText(short)).toBe(short);
    const huge = "Skills\n" + Array.from({ length: 5000 }, (_, i) => `line-${i} contents go here`).join("\n");
    const capped = context.capSectionText(huge);
    expect(capped.length).toBeLessThanOrEqual(25000);
    // Should not slice mid-word — if we cut in the middle of "line-NNN" the
    // tail wouldn't end at a newline boundary.
    expect(capped.endsWith("\n") || /line-\d+ contents go here$/.test(capped)).toBe(true);
  });

  it("builds a deep-experience failure message with reason, status, chars, and main size", () => {
    const { context } = loadContentScriptContext();

    const message = context.buildDeepExperienceFailureMessage(
      {
        reason: "too_thin",
        status: 200,
        chars: 42,
        finalUrl: "https://www.linkedin.com/in/jane/details/experience/",
      },
      734
    );

    expect(message).toContain("too_thin");
    expect(message).toContain("status 200");
    expect(message).toContain("42 chars");
    expect(message).toContain("main profile 734 chars");
    expect(message).toContain("/details/experience/");
  });

  it("builds too-short diagnostics with char count and detected sections", () => {
    const { context } = loadContentScriptContext();
    const message = context.buildTooShortCaptureMessage(
      { profileText: "Jane\nEngineer", sectionKeys: ["experience"], title: "Jane | LinkedIn" },
      "final validation"
    );

    expect(message).toContain("final validation");
    expect(message).toContain("13 chars");
    expect(message).toContain("sections=experience");
    expect(message).toContain("Jane | LinkedIn");
  });

  it("filterProfileLines drops embedded LinkedIn hydration JSON and tracking noise", () => {
    const { context } = loadContentScriptContext();
    const lines = [
      "Senior Software Engineer at Arlo",
      "Wellington, New Zealand",
      `{"data":{"$type":"com.linkedin.voyager.dash.identity.profile.Profile","trackingId":"abc123==","entityUrn":"urn:li:fsd_profile:ACoAAAAAAAA"}}`,
      "About",
      "Full-stack engineer with 8 years building Rails and React apps.",
      `{"include":[{"$type":"com.linkedin.voyager.dash.deco.identity.profile.WebProfile","*elements":["urn:li:fsd_profile:..."]}]}`,
      "Experience",
      "Software Engineer at Arlo · 2021 – Present",
    ];
    const out = context.filterProfileLines(lines);
    expect(out).toEqual([
      "Senior Software Engineer at Arlo",
      "Wellington, New Zealand",
      "About",
      "Full-stack engineer with 8 years building Rails and React apps.",
      "Experience",
      "Software Engineer at Arlo · 2021 – Present",
    ]);
  });

  it("filterProfileLines keeps long human prose with normal punctuation", () => {
    const { context } = loadContentScriptContext();
    const lines = [
      "Built and shipped a real-time analytics platform handling 50k events per second, using Kafka, ClickHouse, and a custom Go ingestion service. Cut p99 latency from 800ms to 120ms by introducing batched writes and tuning JVM heap for the consumers.",
      "Mentored 3 juniors through their first production deployment; one is now leading their own team.",
    ];
    const out = context.filterProfileLines(lines);
    expect(out).toEqual(lines);
  });

  it("filterProfileLines keeps a comma-heavy skills CSV (false-positive guard)", () => {
    const { context } = loadContentScriptContext();
    const lines = [
      "Skills: C#, .NET, ASP.NET MVC, Web API, Razor, JavaScript, TypeScript, React, AWS, Docker, Octopus Deploy, Git, PowerShell",
      "Tech stack — Node.js, Postgres, Redis, Kafka, Elasticsearch, Kubernetes, Terraform, GitHub Actions",
      // Short-acronym CSVs hit a punctuation density that would otherwise
      // trip the JSON heuristic; the JSON-structural-char guard saves them.
      "AWS, GCP, Azure, K8s, DDD, TDD, BDD, CRM, ERP, CMS, ETL, EDI, AML, KYC, B2B, B2C, SaaS, IaaS",
    ];
    const out = context.filterProfileLines(lines);
    expect(out).toEqual(lines);
  });

  it("looksLikeJsonOrTrackingNoise flags hydration blobs but not real headlines", () => {
    const { context } = loadContentScriptContext();
    // Hydration / tracking — must be flagged.
    expect(context.looksLikeJsonOrTrackingNoise(`{"$type":"com.linkedin.voyager.dash.identity.profile.Profile","trackingId":"abc=="}`)).toBe(true);
    expect(context.looksLikeJsonOrTrackingNoise(`urn:li:fsd_profile:ACoAAAAAAAA-some-blob-here`)).toBe(true);
    expect(context.looksLikeJsonOrTrackingNoise(`[{"id":"x","entityUrn":"urn:li:foo"},{"id":"y"}]`)).toBe(true);
    // Real headlines / locations / skills — must NOT be flagged.
    expect(context.looksLikeJsonOrTrackingNoise(`Philip Chan`)).toBe(false);
    expect(context.looksLikeJsonOrTrackingNoise(`Senior Software Engineer at Arlo Training Management Software`)).toBe(false);
    expect(context.looksLikeJsonOrTrackingNoise(`Wellington, Wellington, New Zealand`)).toBe(false);
    expect(context.looksLikeJsonOrTrackingNoise(`Skills: C#, .NET, ASP.NET MVC, Web API, Razor, JavaScript, TypeScript, React, AWS, Docker`)).toBe(false);
  });

  it("extension defaults manualOnlyMode to true at every storage read", () => {
    // Every chrome.storage.local.get({ manualOnlyMode: ... }) must default to
    // true. A fresh install with no stored config has to land in manual-only,
    // not silently turn on auto-capture against LinkedIn. A regression here
    // would re-introduce the original LinkedIn-rate-limit risk.
    const files = ["background.js", "content.js", "popup.js", "options.js"];
    for (const file of files) {
      const code = fs.readFileSync(path.join(__dirname, file), "utf8");
      const matches = code.match(/manualOnlyMode:\s*(true|false)/g) ?? [];
      // At least background.js must declare the default; the others may not
      // touch it. Whatever they declare, it must be true.
      for (const m of matches) {
        expect(`${file} → ${m}`).toBe(`${file} → manualOnlyMode: true`);
      }
    }
  });

  it("routes popup pending captures through the navigation-aware capture-and-post path", () => {
    const code = fs.readFileSync(path.join(__dirname, "background.js"), "utf8");
    const manualHandler = code.slice(code.indexOf('message?.type === "manual-capture-pending"'));

    expect(manualHandler).toContain("capturePendingSessionInTab(tab.id, pending.data, pending.base)");
    expect(manualHandler).not.toContain("doManualCapture(tab.id, pending.data, pending.base)");
  });

  it("does not delete in-flight fetch sessions from the job page unmount cleanup", () => {
    const pagePath = path.resolve(__dirname, "../../src/app/jobs/[id]/page.tsx");
    const code = fs.readFileSync(pagePath, "utf8");
    const unmountCleanup = code.slice(
      code.indexOf("return () => {\n      // Unmount can be a route change"),
      code.indexOf("const handleSaveSalary")
    );

    expect(unmountCleanup).toContain("clearInterval(entry.pollInterval)");
    expect(unmountCleanup).not.toContain("method: \"DELETE\"");
  });

  it("rejects a second capture session while the tab is already capturing", () => {
    const { listeners } = loadContentScriptContext({
      location: { href: "https://www.linkedin.com/in/jane-candidate/" },
    });
    const listener = listeners[0];
    const responses = [];

    listener(
      {
        type: "capture-and-post",
        sessionId: "session-1",
        linkedinUrl: "https://www.linkedin.com/in/jane-candidate/",
        serverBase: "https://recruitme-production-8cc6.up.railway.app",
      },
      {},
      (response) => responses.push(response)
    );
    listener(
      {
        type: "capture-and-post",
        sessionId: "session-2",
        linkedinUrl: "https://www.linkedin.com/in/jane-candidate/",
        serverBase: "https://recruitme-production-8cc6.up.railway.app",
      },
      {},
      (response) => responses.push(response)
    );

    expect(responses[0]).toEqual({ ok: true, status: "started" });
    expect(responses[1]).toEqual({
      ok: false,
      error: "Another RecruitMe capture is already running in this tab",
    });
  });
});
