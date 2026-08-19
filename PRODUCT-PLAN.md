# Sourcing Agent — Product Plan

A standalone browser extension that sources candidates on LinkedIn & SEEK the
way Claude-in-Chrome drives a browser, sold as its own subscription product.

## Hard fact that shapes everything

**The Chrome Web Store cannot process payments.** Google deprecated the Web
Store payments platform and the Licensing API. The store is distribution-only:
it hosts the listing and the auto-update channel, but you must run your own
billing. This project already accounts for that — billing is a small backend
(`server/`) using Stripe Checkout + webhooks, and the extension unlocks via a
signed license JWT.

## Engine decision (locked)

**DeepSeek + structural DOM.** No vision, no per-screenshot/per-token cost.
The agent reads a role/aria-labeled structural snapshot and acts by ref, so it
keeps the Claude-like resilience (re-read + re-plan on redesign) at near-zero
marginal cost. Vision via Claude API is the growth path if/when the product
justifies it.

## Repo layout

```
sourcing-agent/
  extension/       # the product (formerly the RecruitMe Chrome extension)
    brand.js       # SINGLE SOURCE OF TRUTH — name + billing URL + free tier
    license.js     # entitlement gate (window.SA)
    ...            # agent engine (agent-loop.js, agent-page.js, deepseek.js, …)
    tools/sync-brand.mjs   # propagate brand.js -> manifest
  server/          # billing + accounts backend (Hono + SQLite + Stripe)
    src/server.mjs
  PRODUCT-PLAN.md
```

## Monetization flow

1. Install from Chrome Web Store (free).
2. Free tier: `BRAND.freeTier` (default 5 hunts / 7 days), enforced by the
   backend (`POST /api/billing/usage`), mirrored client-side for UX.
3. Subscribe: extension calls `POST /api/billing/subscribe` → Stripe Checkout
   URL → user completes payment → `checkout.session.completed` webhook flips
   the user to `pro`.
4. Pro: extension stores a signed license JWT (`GET /api/billing/license`),
   expires after 30 days and refreshes on next online check.
5. Cancel: Stripe billing portal; webhook downgrades on subscription end.

Dev mode: with `STRIPE_SECRET_KEY` unset the server returns mock checkout URLs
and never charges. `brand.js` `freeTierEnabled:false` disables the client gate.

## The "more like Claude" roadmap (in priority order)

These are the features that separate it from a form-filling bot, all built on
top of the existing agentic loop — not a rewrite:

1. **Persistent cross-run memory** — remember every profile read across hunts
   (currently per-run), so the agent never re-reads and can say "already saw X".
2. **Multi-tab workflows** — let the agent open a second tab to cross-reference
   a profile against a job ad or a sheet, then bring results back.
3. **Record & replay** — capture a manual click/type sequence (e.g. "tag this
   candidate in the ATS") and let the agent replay it on demand.
4. **Scheduled runs** — re-run a saved search on a timer (the recruiter's
   "watch the market" loop), surfacing new profiles into a feed.
5. **Skill-graph ranking** — reuse the deterministic Fit score from the agent's
   structural reads to rank candidates without an extra model call.
6. **Vision (optional, later)** — swap DeepSeek for Claude vision on hard pages
   only, priced accordingly; not part of v1.

## Shipping checklist (Chrome Web Store)

- [ ] Final name/domain set in `brand.js` + `node tools/sync-brand.mjs`
- [ ] Icon set (16/32/48/128) in `extension/icons/`
- [ ] Store listing: screenshots, promo tile, description
- [ ] Privacy policy + support URL (billing + extension)
- [ ] Billing backend deployed (Railway/Fly/Render) + `brand.js.apiBase` set
- [ ] Stripe account + price + webhook secret configured (`server/`)
- [ ] Own the Chrome Web Store developer account ($5 one-time)

## Decisions still open (owner)

- Real product name + domain
- Price point (monthly/annual)
- Hosting target for `server/` (Railway/Fly/Render)