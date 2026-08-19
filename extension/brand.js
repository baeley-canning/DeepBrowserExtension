/**
 * SINGLE SOURCE OF TRUTH for the product brand and billing endpoint.
 *
 * This is the only file that names the product. When the real name/domain are
 * decided, edit the values here and re-run `node tools/sync-brand.mjs` — that
 * rewrites the manifest + this file's consumers so the name propagates without
 * hand-editing every string. NO other file may hard-code the product name or
 * the billing URL; read them from here (or the synced manifest).
 *
 * This extension is a STANDALONE product. It is deliberately split from
 * RecruitMe: no RecruitMe endpoints, no RecruitMe auth, no RecruitMe brand.
 */

// Classic script (no imports): loaded by the panel before panel-lib.js, and
// also readable by the sync script under Node by require/simple eval.
(function (root) {
  var BRAND = {
    // Placeholder identity — rename here, then run `node tools/sync-brand.mjs`.
    name: "Northsource Sourcing Agent",
    shortName: "Northsource",
    productExtId: "northsource-sourcing-agent",

    // Billing/auth backend (your own server — the Chrome Web Store is
    // distribution-only and cannot process subscriptions). Env-overridable so
    // local dev can point at http://localhost:8787 without editing this file.
    apiBase:
      (typeof root !== "undefined" && root.RM_BILLING_BASE) ||
      (typeof process !== "undefined" && process.env && process.env.RM_BILLING_BASE) ||
      "https://northsource.example",

    // Account + entitlement endpoints on the backend (paths, not full URLs).
    endpoints: {
      login: "/api/auth/login",
      whoami: "/api/auth/whoami",
      subscribe: "/api/billing/subscribe",
      license: "/api/billing/license",
      portal: "/api/billing/portal",
    },

    // Free tier, enforced client-side AND server-side (the server is the truth;
    // this is only UX). A run = one hunt. Off by default in dev.
    freeTier: { huntLimit: 5, windowDays: 7 },
    freeTierEnabled: true,
  };

  root.BRAND = root.BRAND || BRAND;
  if (typeof module !== "undefined" && module.exports) module.exports = BRAND;
})(typeof self !== "undefined" ? self : this);