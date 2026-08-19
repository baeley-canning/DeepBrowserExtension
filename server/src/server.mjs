/**
 * Billing + entitlement backend for the sourcing agent.
 *
 * Single-file Hono server + SQLite (mirrors the RecruitMe admin-portal pattern).
 * It is what makes the subscription real, because the Chrome Web Store is
 * distribution-ONLY and cannot process payments.
 *
 * It owns:
 *   - accounts (email-based magic-link-less login stub: email -> session token)
 *   - entitlements (free trial ledger / active subscription)
 *   - Stripe Checkout + webhook (SKIP to dev-mock when STRIPE_SECRET_KEY is unset)
 *   - a signed license JWT the extension stores to prove entitlement
 *   - a usage ledger (hunts) — the server is the real enforcement, not the client
 *
 * Routes (see brand.js endpoints):
 *   POST /api/auth/login           { email }  -> { token }  (mock magic link)
 *   GET  /api/auth/whoami          -> { email, plan, active, huntsUsed }
 *   POST /api/billing/subscribe    -> { url }  (Checkout, or a mock URL in dev)
 *   GET  /api/billing/license      -> { license } (signed JWT if active)
 *   POST /api/billing/portal       -> { url }  (billing portal, or mock)
 *   POST /api/billing/usage        { kind }    -> records a hunt (authoritative)
 *   POST /api/stripe/webhook       (Stripe only)
 *   GET  /                        -> 200 health / admin summary
 *
 * Env:
 *   PORT               (default 8787)
 *   DB_PATH            (default /data/sourcing-agent.sqlite; ./dev.sqlite locally)
 *   STRIPE_SECRET_KEY  (unset -> dev-mock mode; no real charges)
 *   STRIPE_PRICE_ID    (monthly price; used in live mode)
 *   STRIPE_WEBHOOK_SECRET
 *   JWT_SECRET         (HMAC secret for license JWTs; generated at boot in dev)
 *   FREE_HUNTS / FREE_WINDOW_DAYS  (override the default 5/7)
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createHash, randomBytes, randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import Database from "better-sqlite3";

const PORT = Number(process.env.PORT ?? 8787);
const DB_PATH = process.env.DB_PATH ?? new URL("../dev.sqlite", import.meta.url).pathname;
const JWT_SECRET = process.env.JWT_SECRET ?? randomBytes(32);
const FREE_HUNTS = Number(process.env.FREE_HUNTS ?? 5);
const FREE_WINDOW_DAYS = Number(process.env.FREE_WINDOW_DAYS ?? 7);
const hasStripe = Boolean(process.env.STRIPE_SECRET_KEY);
const stripe = hasStripe
  ? (await import("stripe")).default(process.env.STRIPE_SECRET_KEY)
  : null;

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id              TEXT PRIMARY KEY,
    email           TEXT NOT NULL UNIQUE,
    session_token   TEXT,              -- sha256 of the session token we hand out
    stripe_customer TEXT,
    plan            TEXT NOT NULL DEFAULT 'free',   -- free | pro
    created_at      INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS usage (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL REFERENCES users(id),
    kind       TEXT NOT NULL DEFAULT 'hunt',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS usage_user_created ON usage(user_id, created_at);
`);

function hashToken(t) { return createHash("sha256").update(t).digest("hex"); }

function authUser(c) {
  const h = c.req.header("authorization") ?? "";
  const token = h.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const row = db.prepare("SELECT * FROM users WHERE session_token = ?").get(hashToken(token));
  return row ?? null;
}

// Minimal signed JWT (HS256) — no library needed.
const b64 = (s) => Buffer.from(s).toString("base64url");
function signJwt(payload, expSec = 30 * 86400) {
  const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + expSec }));
  const sig = createHmac("sha256", JWT_SECRET).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}
function verifyJwt(token) {
  try {
    const [h, b, s] = token.split(".");
    const expect = createHmac("sha256", JWT_SECRET).update(`${h}.${b}`).digest("base64url");
    if (!timingSafeEqual(Buffer.from(s), Buffer.from(expect))) return null;
    const payload = JSON.parse(Buffer.from(b, "base64url").toString());
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch { return null; }
}

function trialUsage(userId) {
  const started = Date.now() - FREE_WINDOW_DAYS * 86400000;
  const n = db.prepare(
    "SELECT COUNT(*) AS c FROM usage WHERE user_id = ? AND kind = 'hunt' AND created_at > ?"
  ).get(userId, started);
  return n.c;
}

const app = new Hono();

// ── Auth (mock magic-link stub: login returns a session token immediately) ──
app.post("/api/auth/login", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: "A valid email is required." }, 422);

  let user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user) {
    const id = randomUUID();
    db.prepare("INSERT INTO users (id, email, plan, created_at) VALUES (?, ?, 'free', ?)").run(id, email, Date.now());
    user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  }

  const token = randomBytes(32).toString("base64url");
  db.prepare("UPDATE users SET session_token = ? WHERE id = ?").run(hashToken(token), user.id);
  return c.json({ token });
});

app.get("/api/auth/whoami", (c) => {
  const user = authUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  return c.json({ email: user.email, plan: user.plan, active: user.plan === "pro", huntsUsed: trialUsage(user.id) });
});

// ── Billing ──────────────────────────────────────────────────────────────────
app.post("/api/billing/subscribe", async (c) => {
  const user = authUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  if (!hasStripe) {
    return c.json({ url: "http://localhost:8787/dev-checkout?mock=1" });
  }
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer_email: user.email,
    line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
    success_url: `${process.env.PUBLIC_BASE_URL ?? "http://localhost:8787"}/?checkout=success`,
    cancel_url: `${process.env.PUBLIC_BASE_URL ?? "http://localhost:8787"}/?checkout=cancelled`,
    metadata: { userId: user.id },
  });
  return c.json({ url: session.url });
});

app.post("/api/billing/portal", async (c) => {
  const user = authUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  if (!hasStripe) return c.json({ url: "http://localhost:8787/dev-portal?mock=1" });
  const portal = await stripe.billingPortal.sessions.create({ customer: user.stripe_customer, return_url: `https://extension` });
  return c.json({ url: portal.url });
});

app.get("/api/billing/license", (c) => {
  const user = authUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  if (user.plan !== "pro") return c.json({ error: "Not subscribed" }, 402);
  return c.json({ license: signJwt({ sub: user.id, email: user.email, plan: "pro" }) });
});

// The authoritative usage ledger — the extension calls this per hunt. Free-tier
// enforcement also happens here and is returned so the client can reflect it
// but never overrides the server.
app.post("/api/billing/usage", (c) => {
  const user = authUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const n = trialUsage(user.id);
  if (user.plan !== "pro" && n >= FREE_HUNTS) {
    return c.json({ allowed: false, huntsUsed: n, limit: FREE_HUNTS }, 402);
  }
  db.prepare("INSERT INTO usage (user_id, kind, created_at) VALUES (?, 'hunt', ?)").run(user.id, Date.now());
  return c.json({ allowed: true, huntsUsed: n + 1, limit: FREE_HUNTS });
});

// ── Stripe webhook (live only) ───────────────────────────────────────────────
app.post("/api/stripe/webhook", async (c) => {
  if (!hasStripe) return c.json({ error: "Stripe not configured" }, 404);
  const sig = c.req.header("stripe-signature");
  const event = await stripe.webhooks.constructEventAsync(
    await c.req.text(), sig, process.env.STRIPE_WEBHOOK_SECRET,
  );
  if (event.type === "checkout.session.completed") {
    const s = event.data.object;
    const userId = s.metadata?.userId;
    if (s.customer) db.prepare("UPDATE users SET stripe_customer = ? WHERE id = ?").run(s.customer, userId);
    db.prepare("UPDATE users SET plan = 'pro' WHERE id = ?").run(userId);
  } else if (event.type === "customer.subscription.deleted" || event.type === "customer.subscription.updated") {
    const sub = event.data.object;
    if (sub.status !== "active" && sub.status !== "trialing") {
      const row = db.prepare("SELECT id FROM users WHERE stripe_customer = ?").get(sub.customer);
      if (row) db.prepare("UPDATE users SET plan = 'free' WHERE id = ?").run(row.id);
    }
  }
  return c.json({ received: true });
});

app.get("/", (c) => {
  const users = db.prepare("SELECT COUNT(*) c FROM users").get().c;
  const pro = db.prepare("SELECT COUNT(*) c FROM users WHERE plan='pro'").get().c;
  return c.json({ ok: true, users, pro, stripe: hasStripe ? "live" : "mock" });
});

serve({ fetch: app.fetch, port: PORT });
console.log(`[sourcing-agent-server] listening on :${PORT} (Stripe ${hasStripe ? "live" : "MOCK"})`);