/**
 * Page access for the agent, on any LinkedIn page.
 *
 * The agent works the way Claude's browser agent works but without vision: it
 * reads a STRUCTURAL snapshot of the page — interactive elements labelled with
 * their role + accessible name, each given a numbered ref — plus the page's own
 * console + network signals, then decides what to click / type / press by ref.
 * There are no hardcoded selector paths, so a LinkedIn redesign does not break
 * navigation: the model re-reads the snapshot and re-plans, the way a human
 * would look again and find the new button.
 *
 * Classic script on purpose: MV3 content scripts are not modules, and a
 * top-level `export` is a syntax error that makes the whole file fail to load
 * with nothing in the page console to explain it.
 *
 * It never decides anything. It returns observations and performs the
 * individual, explicitly-requested action; the model holds the plan.
 */
(() => {
  const MAX_CHARS = 12000;
  const MAX_REFS = 250;

  // ── Main-world signal bridge ──────────────────────────────────────────────
  // Injects bridge.js into the PAGE world so console / network signals are
  // visible to us (an isolated world cannot see them). Best-effort: a CSP that
  // blocks the script simply yields empty signals, never a broken agent.
  let bridgeReady = false;
  function injectBridge() {
    if (bridgeReady) return;
    bridgeReady = true;
    try {
      const s = document.createElement("script");
      s.src = chrome.runtime.getURL("bridge.js");
      s.onload = () => s.remove();
      (document.head || document.documentElement).appendChild(s);
    } catch { /* ignore */ }
  }
  injectBridge();

  function waitForSignals(timeoutMs = 600) {
    return new Promise((resolve) => {
      const settle = { console: [], network: [] };
      const t = setTimeout(() => resolve(settle), timeoutMs);
      const onMsg = (e) => {
        if (!e || e.source !== window) return;
        if (e.data && e.data.type === "rm:snapshot-signals") {
          resolve({ console: e.data.console || [], network: e.data.network || [] });
          clearTimeout(t);
          window.removeEventListener("message", onMsg);
        }
      };
      window.addEventListener("message", onMsg);
      // Ask the main world. If bridge.js never loaded, the timeout settles empty.
      window.postMessage({ type: "rm:snapshot-request" }, "*");
    });
  }

  // ── Structural snapshot ───────────────────────────────────────────────────
  function visible(el) {
    if (!el || el.nodeType !== 1) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    let s;
    try { s = getComputedStyle(el); } catch { return true; }
    if (s.display === "none" || s.visibility === "hidden") return false;
    return parseFloat(s.opacity || "1") > 0;
  }

  function isInteractive(el) {
    const tag = (el.tagName || "").toLowerCase();
    if (["a", "button", "input", "textarea", "select", "option"].includes(tag)) return true;
    if ((el.getAttribute("contenteditable") || "") === "true") return true;
    const role = (el.getAttribute("role") || "").toLowerCase();
    return [
      "button", "link", "menuitem", "option", "tab", "textbox", "combobox",
      "searchbox", "checkbox", "radio", "listbox", "tab", "switch",
    ].includes(role);
  }

  /** Best-effort accessible name, the way a screen reader would announce it. */
  function accessibleName(el) {
    const attr =
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("title") ||
      el.getAttribute("alt") ||
      "";
    if (attr && attr.trim()) return attr.trim().replace(/\s+/g, " ").slice(0, 120);

    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const label = document.getElementById(labelledBy);
      if (label && (label.innerText || label.textContent || "").trim()) {
        return (label.innerText || label.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120);
      }
    }
    const text = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
    return text.slice(0, 120);
  }

  /** element type + role for a compact "what is this" descriptor. */
  function describe(el) {
    const tag = (el.tagName || "").toLowerCase();
    const role = (el.getAttribute("role") || "").toLowerCase() || tag;
    const type = (el.getAttribute("type") || "").toLowerCase();
    return type ? `${tag}[${type}]` : role;
  }

  // Refs assigned per snapshot; a ref is valid until the next snapshot. A
  // re-render may invalidate a ref, and the agent re-reads state then.
  const refStore = new Map();

  async function buildSnapshot() {
    const els = Array.from(document.querySelectorAll("*")).filter(
      (el) => visible(el) && isInteractive(el),
    ).slice(0, MAX_REFS);

    refStore.clear();
    const refs = [];
    const tree = [];
    els.forEach((el, i) => {
      const ref = i + 1;
      refStore.set(ref, el);
      el.setAttribute("data-rm-ref", String(ref));
      const name = accessibleName(el);
      refs.push({ ref, tag: el.tagName.toLowerCase(), role: (el.getAttribute("role") || "").toLowerCase(), name });
      tree.push(`[${ref}] ${describe(el)}${name ? ` "${name}"` : ""}`);
    });

    const { console: consoleLog, network: networkLog } = await waitForSignals();
    return {
      url: location.href,
      title: document.title,
      refs,
      tree: tree.join("\n"),
      console: consoleLog,
      network: networkLog,
    };
  }

  // ── Content (kept for the deterministic hunt) ─────────────────────────────
  const CHROME_LINES = new Set([
    "home", "my network", "jobs", "messaging", "notifications", "me",
    "for business", "learning",
    "people", "1st", "2nd", "3rd+", "actively hiring", "locations",
    "current companies", "all filters",
    "about", "accessibility", "help center", "privacy & terms", "ad choices",
    "advertising", "business services", "get the linkedin app", "more",
    "my apps", "groups", "manage billing", "crosscheck", "talent",
    "hire with ai", "talent insights", "sales", "sales navigator",
    "services marketplace", "explore more for business", "hire on linkedin",
    "find, attract and recruit talent", "sell with linkedin",
    "unlock sales opportunities", "post a job for free", "find quality candidates",
    "advertise on linkedin", "acquire customers and grow your business",
    "get started with premium", "expand and leverage your network",
    "learn with linkedin", "courses to develop your employees", "admin center",
    "manage billing and account details", "create a company page",
  ]);

  function isChromeLine(line) {
    const t = line.trim().toLowerCase();
    if (!t) return true;
    if (CHROME_LINES.has(t)) return true;
    if (/^\d+\s+notifications?$/.test(t)) return true;
    if (/^are these results helpful\??$/.test(t)) return true;
    if (/^your feedback helps us improve search results$/.test(t)) return true;
    if (/^(next|previous)$/.test(t)) return true;
    if (/^linkedin corporation(?: ©|$)/.test(t)) return true;
    if (/^\d{1,2}$/.test(t) && Number(t) >= 1 && Number(t) <= 99) return true;
    return false;
  }

  function readableText() {
    if (!document.body) return "";
    return String(document.body.innerText || "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => !isChromeLine(l))
      .join("\n");
  }

  function pageText() {
    const full = readableText();
    if (full.length <= MAX_CHARS) return { text: full, truncated: false };
    return { text: full.slice(0, MAX_CHARS), truncated: true };
  }

  async function scrollDown() {
    const start = window.scrollY;
    const target = Math.min(start + window.innerHeight * 2, document.body.scrollHeight);
    for (let y = start; y < target; y += 400) {
      window.scrollTo({ top: y, behavior: "instant" });
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo({ top: target, behavior: "instant" });
    return { scrolledTo: target, pageHeight: document.body.scrollHeight };
  }

  // ── Ref-based actions ─────────────────────────────────────────────────────
  function getRef(ref) {
    const n = Number(ref);
    const el = refStore.get(n);
    if (!el || !document.documentElement.contains(el)) return null;
    return { el, n };
  }

  function setNativeValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter ? setter.call(input, value) : (input.value = value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function doAct(msg) {
    const action = msg.action;
    if (action === "snapshot") return buildSnapshot();

    if (action === "goto") {
      const url = String(msg.url || "");
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: "goto needs an absolute URL." };
      location.href = url;
      return { ok: true, navigating: true };
    }

    const { el, n } = getRef(msg.ref) || {};
    if (!el) {
      return { ok: false, error: `Ref ${msg.ref} is no longer on the page — call get_page_state and use a fresh ref.` };
    }

    if (action === "click") {
      el.click();
      return { ok: true, clicked: n, name: accessibleName(el) };
    }

    if (action === "type") {
      const text = String(msg.text ?? "");
      el.focus();
      if (el.tagName && el.tagName.toLowerCase() === "input" || el.tagName?.toLowerCase() === "textarea") {
        setNativeValue(el, text);
      } else if ((el.getAttribute("contenteditable") || "") === "true") {
        el.textContent = text;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      } else {
        // Rich comboboxes (LinkedIn's search) respond to keystrokes.
        for (const ch of text) {
          el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
          el.dispatchEvent(new KeyboardEvent("keypress", { key: ch, bubbles: true }));
          el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
        }
      }
      return { ok: true, typed: n, length: text.length };
    }

    if (action === "press") {
      const key = String(msg.key || "Enter");
      const opts = { key, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent("keydown", opts));
      el.dispatchEvent(new KeyboardEvent("keypress", opts));
      el.dispatchEvent(new KeyboardEvent("keyup", opts));
      if (key === "Enter") el.click();
      return { ok: true, pressed: key, target: n };
    }

    if (action === "scroll") {
      const info = await scrollDown();
      return { ok: true, ...info };
    }

    return { ok: false, error: `Unknown action: ${action}` };
  }

  // ── Structured profile read (kept for the deterministic hunt) ─────────────
  function sectionAfter(id) {
    const anchor = document.getElementById(id);
    if (!anchor) return "";
    const section = anchor.closest("section") || anchor.parentElement;
    if (!section) return "";
    return (section.innerText || "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => !/^(company logo|logo|·|see more|show all|\d+ skills?)$/i.test(l))
      .join("\n");
  }

  function structuredProfile() {
    const topCard = document.querySelector("main section");
    const topLines = (topCard?.innerText || "")
      .split("\n").map((l) => l.trim()).filter(Boolean);
    return {
      url: location.href.split("?")[0],
      name: topLines[0] || document.title.replace(/\s*\|.*$/, "").trim(),
      headline: topLines[1] || "",
      location: topLines.find((l) => /,\s*(new zealand|nz|australia)/i.test(l)) || topLines[2] || "",
      about: sectionAfter("about").slice(0, 1200),
      experience: sectionAfter("experience").slice(0, 4000),
      education: sectionAfter("education").slice(0, 800),
      skills: sectionAfter("skills").slice(0, 600),
    };
  }

  // ── Legacy Locations filter driver (kept for the deterministic hunt) ──────
  const vis = (el) => el && el.offsetParent !== null;
  function findByText(selector, re) {
    return Array.from(document.querySelectorAll(selector)).find(
      (el) => vis(el) && re.test((el.innerText || el.textContent || "").trim()),
    );
  }
  async function until(fn, timeoutMs = 6000, everyMs = 150) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const v = fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, everyMs));
    }
    return null;
  }
  async function setLocationFilter(location) {
    const chip = await until(
      () => findByText("button", /^locations?\b/i) || document.querySelector('button[aria-label*="location" i]'),
      8000,
    );
    if (!chip) return { ok: false, error: 'No "Locations" filter button on this page.' };
    chip.click();
    const input = await until(() =>
      Array.from(document.querySelectorAll('input[type="text"], input[role="combobox"]')).find(
        (i) => vis(i) && /location|city|region|add a/i.test(i.getAttribute("placeholder") || i.getAttribute("aria-label") || ""),
      ),
    );
    if (!input) return { ok: false, error: "The Locations dropdown did not open." };
    input.focus();
    setNativeValue(input, location);
    const option = await until(() => {
      const opts = Array.from(document.querySelectorAll('[role="option"], li')).filter(
        (o) => vis(o) && (o.innerText || "").trim().length > 2,
      );
      return (
        opts.find((o) => new RegExp(`^${location}\\b`, "i").test((o.innerText || "").trim())) ||
        opts.find((o) => (o.innerText || "").toLowerCase().includes(location.toLowerCase()))
      );
    }, 7000);
    if (!option) return { ok: false, error: `No autocomplete match for "${location}".` };
    option.click();
    await new Promise((r) => setTimeout(r, 600));
    const show = findByText("button", /show results|apply/i);
    if (show) show.click();
    return { ok: true, applied: (option.innerText || location).split("\n")[0].trim(), url: window.location.href };
  }

  // ── SEEK Talent Search ─────────────────────────────────────────────────────
  // Structure-only port of scraper-worker/seek-search.ts. SEEK's search only
  // runs on FORM SUBMIT (it builds a searchId), so this fills the keyword box,
  // optionally the "Suburb, city or region" box and its "All <region>" option,
  // then clicks the pink SEEK button and waits for the /search/profiles results.
  // The keyword box accepts the same boolean operators as LinkedIn.
  const SEEK_AUTH = /login\.seek\.com|authenticate\.seek\.com|\/oauth\/|\/sign-in/i;
  const seekHost = () => {
    // NZ employer portal by default — identical to the scraper's SEEK_EMPLOYER_HOST.
    if (/employer\.seek\.com/.test(location.hostname)) return location.origin;
    return "https://nz.employer.seek.com";
  };

  function seekCards() {
    const out = [];
    const seen = new Set();
    const idOf = (href) => {
      const m = href.match(/\/profile\/(\d+)/);
      return m ? m[1] : null;
    };
    for (const a of Array.from(document.querySelectorAll('a[href*="/profile/"]'))) {
      const id = idOf(a.href);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      let el = a;
      let card = null;
      for (let i = 0; i < 10 && el; i++) {
        const ids = new Set(
          Array.from(el.querySelectorAll('a[href*="/profile/"]'))
            .map((x) => idOf(x.href))
            .filter(Boolean),
        );
        const lineCount = (el.innerText || "").split("\n").filter((s) => s.trim()).length;
        if (ids.size === 1 && lineCount >= 2) card = el;
        if (ids.size > 1) break;
        el = el.parentElement;
      }
      let name = null;
      let headline = null;
      let locationLine = null;
      if (card) {
        const lines = (card.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
        name = lines[0] ?? null;
        headline = lines[1] ?? null;
        locationLine = lines.find((l) => /,\s*[A-Z]{2}$/.test(l)) ?? null;
      }
      out.push({
        url: `${seekHost()}/talentsearch/profile/${id}`,
        name,
        headline,
        location: locationLine,
        seekId: id,
      });
    }
    return out;
  }

  async function untilUrl(re, timeoutMs = 25000, everyMs = 300) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (re.test(location.href)) return true;
      await new Promise((r) => setTimeout(r, everyMs));
    }
    return false;
  }

  async function seekSearch(query, loc) {
    if (SEEK_AUTH.test(location.href)) return { ok: false, error: "SEEK asked for a login / auth wall — sign in manually in this tab, then try again." };

    // Keyword box: the first visible text-ish input on the talentsearch form.
    const kwBox = Array.from(document.querySelectorAll('input[type="text"], input[type="search"], textarea, [contenteditable="true"]'))
      .find((el) => visible(el)) || null;
    if (!kwBox) return { ok: false, error: "SEEK keyword box not found — are you on the Talent Search page?" };
    kwBox.focus();
    setNativeValue(kwBox, query);
    await new Promise((r) => setTimeout(r, rand2(400, 800)));

    if (loc) {
      const locBox = Array.from(document.querySelectorAll('input[type="text"], input[role="combobox"]'))
        .find((el) => visible(el) && /suburb, city or region/i.test(el.getAttribute("placeholder") || el.getAttribute("aria-label") || ""));
      if (locBox) {
        locBox.focus();
        setNativeValue(locBox, loc);
        await new Promise((r) => setTimeout(r, 1800));
        // Prefer the "All <region>" option; fall back to the first suggestion.
        let option = Array.from(document.querySelectorAll('[role="option"], li'))
          .find((o) => visible(o) && new RegExp(`^all\\s+${loc}`, "i").test((o.innerText || "").trim()));
        if (!option) {
          option = Array.from(document.querySelectorAll('[role="option"], li')).find((o) => visible(o) && (o.innerText || "").trim().length > 2);
        }
        if (option) option.click();
        await new Promise((r) => setTimeout(r, 600));
      }
    }

    // Submit via the pink SEEK button (more reliable than Enter with two fields).
    const seekBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => visible(b) && /^(seek|search)$/i.test((b.innerText || b.getAttribute("aria-label") || "").trim()),
    );
    if (seekBtn) seekBtn.click();
    else kwBox.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    const reached = await untilUrl(/\/search\/profiles/);
    if (!reached) return { ok: false, error: "SEEK did not land on results — the form may have changed." };
    await new Promise((r) => setTimeout(r, 2500));
    if (SEEK_AUTH.test(location.href)) return { ok: false, error: "SEEK asked for a login during search." };

    return {
      ok: true,
      url: location.href,
      cards: seekCards(),
      pageText: readableText().slice(0, 6000),
    };
  }

  // Keep a small helper so seekSearch can pace without importing the humanizer.
  function rand2(a, b) { return a + Math.floor(Math.random() * (b - a)); }

  // ── Message dispatch ──────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "RECRUITME_SEEK_SEARCH") {
      seekSearch(String(message.query || ""), String(message.location || ""))
        .then((r) => sendResponse(r))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    }

    if (message?.type === "RECRUITME_SNAPSHOT") {
      buildSnapshot()
        .then((snap) => sendResponse({ ok: true, ...snap }))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    }

    if (message?.type === "RECRUITME_ACT") {
      doAct(message)
        .then((r) => sendResponse(r))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    }

    if (message?.type === "RECRUITME_PAGE_TEXT") {
      try {
        const { text, truncated } = pageText();
        sendResponse({ ok: true, text, truncated, url: location.href, title: document.title });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
      return false;
    }

    if (message?.type === "RECRUITME_PROFILE") {
      try {
        const p = structuredProfile();
        const usable = (p.experience || p.about || p.headline || "").length > 80;
        sendResponse({ ok: usable, profile: p, url: location.href, error: usable ? null : "profile sections did not render" });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
      return false;
    }

    if (message?.type === "RECRUITME_EXTRACT_CARDS") {
      (async () => {
        try {
          const [{ parseCard }, { extractResultsPage }] = await Promise.all([
            import(chrome.runtime.getURL("card-parse.js")),
            import(chrome.runtime.getURL("results-extract.js")),
          ]);
          sendResponse(extractResultsPage(parseCard));
        } catch (err) {
          sendResponse({ ok: false, error: `Extractor failed to load: ${String(err?.message || err)}` });
        }
      })();
      return true;
    }

    if (message?.type === "RECRUITME_OPEN_PROFILE") {
      try {
        const slug = String(message.slug || "");
        if (!slug) return sendResponse({ ok: false, error: "No slug provided." });
        const link = Array.from(document.querySelectorAll('a[href*="/in/"]')).find(
          (a) => a.href.includes(`/in/${slug}`),
        );
        if (!link) return sendResponse({ ok: false, error: `No profile link found for slug: ${slug}` });
        link.click();
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
      return false;
    }

    if (message?.type === "RECRUITME_EXPAND_PROFILE") {
      try {
        let clicked = 0;
        for (const btn of document.querySelectorAll('button[aria-expanded="false"]')) {
          if (btn.offsetParent !== null) { btn.click(); clicked += 1; }
        }
        for (const btn of document.querySelectorAll("button")) {
          const label = (btn.innerText || btn.getAttribute("aria-label") || "").toLowerCase();
          if ((label.includes("see more") || label.includes("show more") || label.includes("…")) && btn.offsetParent !== null) {
            btn.click();
            clicked += 1;
          }
        }
        sendResponse({ ok: true, expanded: clicked });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
      return false;
    }

    if (message?.type === "RECRUITME_SET_LOCATION") {
      setLocationFilter(String(message.location || ""))
        .then((r) => sendResponse(r))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    }

    if (message?.type === "RECRUITME_SCROLL") {
      scrollDown()
        .then((info) => sendResponse({ ok: true, ...info }))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    }

    return undefined;
  });
})();