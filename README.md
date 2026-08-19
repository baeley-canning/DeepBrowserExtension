# Northsource Sourcing Agent

A standalone browser extension that sources candidates on LinkedIn & SEEK the
way Claude-in-Chrome drives a browser: give it a role (or paste a JD), it opens
its own hidden tab, runs skill-based searches across both platforms, reads the
promising profiles, and returns a ranked shortlist with reasons.

It is **not** a form-filling bot and has **no hardcoded selectors** — the agent
reads a structural snapshot of each page (interactive elements labelled with
their role + accessible name) and acts by ref, so a LinkedIn/SEEK redesign is
recovered by re-reading and re-planning the way a human would.

## Repo layout

```
extension/    # the Chrome extension (the product)
  brand.js    # SINGLE SOURCE OF TRUTH — name, billing URL, free tier
  license.js  # entitlement gate (window.SA)
  agent-*.js  # the agent engine (structural snapshot + skill searches)
  tools/      # build-panel-lib.mjs, sync-brand.mjs
server/       # billing + accounts backend (Hono + SQLite + Stripe)
PRODUCT-PLAN.md
```

## Run locally

The extension is standalone (bring your own DeepSeek key):

1. `chrome://extensions` → Developer mode → **Load unpacked** → pick `extension/`.
2. Open the extension panel, paste a DeepSeek API key in Options.
3. Paste a role/JD and send. The free tier is local-only in dev; subscribe when
   you've wired up the backend.

The billing backend runs without Stripe keys in mock mode:

```bash
cd server
npm install
npm start            # http://localhost:8787 — returns mock checkout URLs
```

Set `brand.js.apiBase` (or `RM_BILLING_BASE` at runtime) to your deployed
backend, and set `STRIPE_SECRET_KEY`/`STRIPE_PRICE_ID`/`STRIPE_WEBHOOK_SECRET`
for live billing.

## Monetization

The Chrome Web Store is **distribution-only** (Google deprecated Web Store
payments and the Licensing API). Billing is your own Stripe subscription via
`server/`, with the extension unlocking through a signed license JWT. See
`PRODUCT-PLAN.md` for the full flow and shipping checklist.

## Engine

DeepSeek (text-only) drives the structural-DOM agent. The Claude-API *vision*
engine is the documented growth path, not part of v1.