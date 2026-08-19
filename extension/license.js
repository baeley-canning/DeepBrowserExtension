/**
 * Client entitlement gate — the source-of-truth check lives on the billing
 * backend, but the extension mirrors it locally so it keeps working offline and
 * before the backend is deployed.
 *
 * States:
 *   "dev"     — backend unreachable AND no license → free tier (local trial),
 *               so the extension is usable in development without a server.
 *   "trial"   — backend reachable, user has not subscribed → local free tier.
 *   "active"  — a signed license JWT is stored and not expired → full access.
 *
 * The server is authoritative when it is configured and reachable; the local
 * trial is ONLY a fallback and is bounded by BRAND.freeTier. Do not treat the
 * client check as real enforcement — the backend must enforce it too.
 *
 * Published as window.SA. Loaded as a classic script BEFORE panel-lib.js and
 * sidepanel.js in sidepanel.html.
 */
(function (root) {
  const BRAND = root.BRAND || {};
  const KEYS = { license: "saLicense", trial: "saTrial" };

  async function get(keys, defaults) {
    try { return await chrome.storage.local.get(keys); }
    catch { return defaults; }
  }
  async function set(obj) {
    try { await chrome.storage.local.set(obj); } catch { /* ignore */ }
  }

  function jwtExpiry(token) {
    try {
      const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      return payload.exp ? payload.exp * 1000 : null;
    } catch { return null; }
  }

  async function api(path, opts = {}) {
    const base = (BRAND.apiBase || "").replace(/\/$/, "");
    if (!base) throw new Error("No billing endpoint configured (brand.js apiBase).");
    const res = await fetch(`${base}${path}`, {
      ...opts,
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    });
    let data = null;
    try { data = await res.json(); } catch { /* ignore */ }
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
    return data;
  }

  async function trialState() {
    const s = await get(KEYS, {});
    const t = s[KEYS.trial] || { used: 0, startedAt: Date.now() };
    return t;
  }

  /**
   * Authoritative-ish status. Tries the backend first; falls back to the local
   * license JWT, then the local trial. Returns { state, plan, huntsUsed, huntLimit }.
   */
  async function status() {
    // Stored license JWT wins.
    const stored = (await get(KEYS, {}))[KEYS.license];
    if (stored) {
      const exp = jwtExpiry(stored);
      if (exp === null || exp > Date.now()) return { state: "active", plan: "pro", huntsUsed: 0, huntLimit: Infinity };
      await set({ [KEYS.license]: null }); // expired
    }

    const t = await trialState();
    const limit = (BRAND.freeTier && BRAND.freeTier.huntLimit) || 5;
    const windowMs = ((BRAND.freeTier && BRAND.freeTier.windowDays) || 7) * 86400000;
    if (Date.now() - t.startedAt > windowMs) { t.used = 0; t.startedAt = Date.now(); await set({ [KEYS.trial]: t }); }

    // A user who has logged in on the backend may carry a server trial; ask if
    // the token is known. If the backend isn't reachable we just use the local trial.
    const token = (await get({ saSession: null })).saSession;
    if (token) {
      try {
        const me = await api(BRAND.endpoints.whoami, { headers: { Authorization: `Bearer ${token}` } });
        if (me.active || me.plan === "pro") {
          const lic = await api(BRAND.endpoints.license, { headers: { Authorization: `Bearer ${token}` } });
          if (lic && lic.license) { await set({ [KEYS.license]: lic.license }); return { state: "active", plan: "pro", huntsUsed: me.huntsUsed || 0, huntLimit: Infinity }; }
        }
        return { state: "trial", plan: "free", huntsUsed: me.huntsUsed ?? t.used, huntLimit: limit };
      } catch {
        /* backend unreachable — fall through to local trial */
      }
    }

    return { state: "trial", plan: "free", huntsUsed: t.used, huntLimit: limit };
  }

  /**
   * Called before every hunt. Returns { allowed, message } — the panel blocks
   * the run when allowed is false. On "trial", this increments the local
   * counter (the backend is the real ledger once configured).
   */
  async function requireRun() {
    const s = await status();
    if (s.state === "active") return { allowed: true, state: s };
    const limit = s.huntLimit || 5;
    if (s.huntsUsed >= limit) {
      return {
        allowed: false,
        state: s,
        message: `You've used your ${limit} free hunt${limit === 1 ? "" : "s"}. Subscribe to keep searching.`,
      };
    }
    // Local trial ledger.
    const t = await trialState();
    t.used = (t.used || 0) + 1;
    t.startedAt = t.startedAt || Date.now();
    await set({ [KEYS.trial]: t });
    // Best-effort server-side record (the real ledger).
    const token = (await get({ saSession: null })).saSession;
    if (token) { try { await api("/api/billing/usage", { method: "POST", body: JSON.stringify({ kind: "hunt" }), headers: { Authorization: `Bearer ${token}` } }); } catch { /* offline */ } }
    return { allowed: true, state: { ...s, huntsUsed: t.used } };
  }

  async function login(email) {
    const data = await api(BRAND.endpoints.login, { method: "POST", body: JSON.stringify({ email }) });
    if (data && data.token) { await set({ saSession: data.token }); }
    return data;
  }

  async function subscribe() {
    const token = (await get({ saSession: null })).saSession;
    return api(BRAND.endpoints.subscribe, { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {} });
  }

  async function openPortal() {
    const token = (await get({ saSession: null })).saSession;
    return api(BRAND.endpoints.portal, { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {} });
  }

  async function logout() {
    await set({ saSession: null, [KEYS.license]: null });
  }

  root.SA = { status, requireRun, login, subscribe, openPortal, logout };
})(typeof self !== "undefined" ? self : this);