/**
 * Main-world signal bridge for the agent.
 *
 * MV3 content scripts run in an ISOLATED world: their `console` and `fetch`
 * are separate objects, so they cannot see the page's own errors or network
 * traffic. This file is injected into the PAGE's main world (via a
 * web_accessible_resource <script>), where it patches console / fetch / XHR /
 * error handlers and publishes a small ring buffer back to the content script
 * over window.postMessage. The agent uses those signals the way Claude uses
 * console + network logs: to notice a page that's erroring rather than loading.
 *
 * Purely observational. It reads nothing, writes nothing, and its one job is to
 * hand a short list of strings to the content script on request. If the page's
 * CSP blocks this injection, the agent still works — it just sees empty
 * console/network signals.
 */
(() => {
  if (window.__recruitMeBridge) return;
  try { window.__recruitMeBridge = true; } catch { /* frozen window */ }

  const MAX = 30;
  const consoleBuf = [];
  const networkBuf = [];

  function push(arr, s) {
    if (typeof s !== "string" || !s) return;
    arr.push(s.slice(0, 300));
    if (arr.length > MAX) arr.shift();
  }

  // ── Console + runtime errors ──────────────────────────────────────────────
  for (const method of ["error", "warn"]) {
    const orig = console[method];
    if (typeof orig !== "function") continue;
    try {
      console[method] = function (...args) {
        try {
          push(consoleBuf, args.map((a) => (a && a.message) || String(a)).join(" "));
        } catch { /* never throw from a console shim */ }
        return orig.apply(this, args);
      };
    } catch { /* ignore */ }
  }
  window.addEventListener("error", (e) => {
    push(consoleBuf, `${e.message} @ ${e.filename || "?"}:${e.lineno || "?"}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    push(consoleBuf, String((r && (r.message || r.stack)) || r).slice(0, 300));
  });

  // ── Network ───────────────────────────────────────────────────────────────
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    try {
      window.fetch = function (...args) {
        const url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
        return origFetch
          .apply(this, args)
          .then((res) => {
            try { push(networkBuf, `FETCH ${res.status} ${url}`); } catch { /* ignore */ }
            return res;
          })
          .catch((err) => {
            try { push(networkBuf, `FETCH ERR ${url} ${err && err.message}`); } catch { /* ignore */ }
            throw err;
          });
      };
    } catch { /* ignore */ }
  }

  try {
    const open = XMLHttpRequest.prototype.open;
    const send = XMLHttpRequest.prototype.send;
    let current;
    XMLHttpRequest.prototype.open = function (method, url) {
      current = { method, url };
      return open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      const req = current;
      const url = (req && req.url) || "";
      const method = (req && req.method) || "XHR";
      this.addEventListener("loadend", () => {
        try {
          push(networkBuf, `${method} ${String(this.status || "?")} ${url}`);
        } catch { /* ignore */ }
      });
      return send.apply(this, arguments);
    };
  } catch { /* ignore */ }

  // ── Respond to snapshot requests from the isolated content script ─────────
  window.addEventListener("message", (e) => {
    if (!e || e.source !== window) return;
    if (e.data && e.data.type === "rm:snapshot-request") {
      window.postMessage(
        { type: "rm:snapshot-signals", console: [...consoleBuf], network: [...networkBuf] },
        "*",
      );
    }
  });
})();