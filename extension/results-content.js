/**
 * Classic content script for LinkedIn people-search result pages.
 *
 * Deliberately tiny. MV3 content scripts are CLASSIC scripts — a top-level
 * `export` or `import` is a syntax error that makes the entire file fail to
 * load, with nothing in the page console explaining why. So the real logic
 * lives in ES modules (card-parse.js, results-extract.js) where it can be unit
 * tested, and this file pulls them in with dynamic import() of extension URLs.
 * Both must therefore be listed in web_accessible_resources.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "RECRUITME_EXTRACT_RESULTS") return undefined;

  (async () => {
    try {
      const [{ parseCard }, { extractResultsPage }] = await Promise.all([
        import(chrome.runtime.getURL("card-parse.js")),
        import(chrome.runtime.getURL("results-extract.js")),
      ]);
      sendResponse(extractResultsPage(parseCard));
    } catch (err) {
      // Never swallow: a failed import means the extension is misconfigured
      // (missing web_accessible_resources) and every hunt would silently find
      // nobody. Report it as a real extraction failure so the popup shows it.
      sendResponse({
        ok: false,
        reason: "extraction-failed",
        detail: `Could not load the extractor modules: ${String(err?.message || err)}`,
      });
    }
  })();

  return true; // keep the message channel open for the async response
});
