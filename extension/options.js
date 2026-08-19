const serverBaseInput  = document.getElementById("serverBase");
const extUsernameInput = document.getElementById("extUsername");
const extPasswordInput = document.getElementById("extPassword");
const saveBtn          = document.getElementById("saveBtn");
const saveStatus       = document.getElementById("saveStatus");
const connectionBadge  = document.getElementById("connectionBadge");
const statusDot        = document.getElementById("statusDot");
const statusText       = document.getElementById("statusText");
const manualOnlyToggle = document.getElementById("manualOnlyToggle");
const manualOnlyRow    = document.getElementById("manualOnlyRow");
const manualOnlyHint   = document.getElementById("manualOnlyHint");

// Auto-capture pacing UI
const hourlyCapInput   = document.getElementById("hourlyCap");
const hourlyCapValue   = document.getElementById("hourlyCapValue");
const dailyCapInput    = document.getElementById("dailyCap");
const dailyCapValue    = document.getElementById("dailyCapValue");
const hourlyCount      = document.getElementById("hourlyCount");
const dailyCount       = document.getElementById("dailyCount");
const pauseRow         = document.getElementById("pauseRow");
const pauseReason      = document.getElementById("pauseReason");
const pauseUntil       = document.getElementById("pauseUntil");
const resumeBtn        = document.getElementById("resumeBtn");

function formatLocalTime(epochMs) {
  if (!epochMs) return "";
  const d = new Date(epochMs);
  const same = (new Date()).toDateString() === d.toDateString();
  return same
    ? `today at ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

async function refreshAutoCaptureStatus() {
  try {
    const r = await sendMessage({ type: "get-auto-capture-status" });
    hourlyCapInput.value = r.hourlyCap;
    hourlyCapValue.textContent = r.hourlyCap;
    dailyCapInput.value = r.dailyCap;
    dailyCapValue.textContent = r.dailyCap;
    hourlyCount.textContent = r.hourly;
    dailyCount.textContent = r.daily;

    if (r.paused) {
      pauseRow.style.display = "block";
      pauseReason.textContent = r.pausedReason || "Detection signal from LinkedIn";
      pauseUntil.textContent = formatLocalTime(r.pausedUntil);
    } else {
      pauseRow.style.display = "none";
    }
  } catch { /* not critical */ }
}

hourlyCapInput.addEventListener("input", () => { hourlyCapValue.textContent = hourlyCapInput.value; });
dailyCapInput.addEventListener("input",  () => { dailyCapValue.textContent  = dailyCapInput.value;  });
hourlyCapInput.addEventListener("change", async () => {
  await sendMessage({ type: "set-auto-capture-caps", hourlyCap: Number(hourlyCapInput.value) });
});
dailyCapInput.addEventListener("change", async () => {
  await sendMessage({ type: "set-auto-capture-caps", dailyCap: Number(dailyCapInput.value) });
});
resumeBtn.addEventListener("click", async () => {
  resumeBtn.disabled = true;
  try {
    await sendMessage({ type: "resume-auto-capture" });
    await refreshAutoCaptureStatus();
  } finally { resumeBtn.disabled = false; }
});

function setManualOnlyUI(enabled) {
  manualOnlyToggle.checked = enabled;
  manualOnlyRow.className = "toggle-row" + (enabled ? " active" : "");
  manualOnlyHint.innerHTML = enabled
    ? "<strong>Manual-only is ON (recommended).</strong> The extension won't open tabs automatically. When you have a pending capture, navigate to the candidate's LinkedIn profile and click the extension icon."
    : "<strong>Auto-capture is ON.</strong> Extension opens LinkedIn tabs and captures automatically. LinkedIn detects this pattern — only enable if you know what you're doing.";
}

manualOnlyToggle.addEventListener("change", async () => {
  const enabled = manualOnlyToggle.checked;
  await chrome.storage.local.set({ manualOnlyMode: enabled });
  setManualOnlyUI(enabled);
  // Tell the background to re-tune the heartbeat alarm interval — auto mode
  // checks for new sessions every 1 min, manual mode every 5 min.
  try {
    await sendMessage({ type: "manual-only-changed" });
  } catch { /* non-fatal */ }
});

function setStatus(element, message, kind = "") {
  element.textContent = message;
  element.className   = kind ? `status ${kind}` : "status";
}

function setConnectionBadge(state, label) {
  const classes = { connected: "connected", disconnected: "disconnected", unconfigured: "unconfigured" };
  const dots    = { connected: "green",     disconnected: "red",          unconfigured: "grey" };
  connectionBadge.className = `connection-badge ${classes[state] ?? "unconfigured"}`;
  statusDot.className       = `dot ${dots[state] ?? "grey"}`;
  statusText.textContent    = label;
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Request failed"));
        return;
      }
      resolve(response);
    });
  });
}

// Load stored settings and check connection on page open.
async function init() {
  try {
    // Load manual-only mode separately (doesn't go through background).
    // Default true — matches background.js getStoredSettings default.
    const stored = await chrome.storage.local.get({ manualOnlyMode: true });
    setManualOnlyUI(stored.manualOnlyMode);

    const response = await sendMessage({ type: "get-config" });
    serverBaseInput.value  = response.serverBase || "";
    extUsernameInput.value = response.username   || "";
    // Never pre-fill password

    if (response.serverBase && response.username) {
      // Try a live connection check
      try {
        await sendMessage({ type: "set-config", serverBase: response.serverBase });
        setConnectionBadge("connected", `Connected · ${new URL(response.serverBase).hostname}`);
      } catch {
        setConnectionBadge("disconnected", "Saved — but connection test failed. Check URL and credentials.");
      }
    } else {
      setConnectionBadge("unconfigured", "Not configured — fill in the fields below and save.");
    }
  } catch (error) {
    setConnectionBadge("unconfigured", "Could not load saved settings.");
  }
}

saveBtn.addEventListener("click", async () => {
  const serverBase = serverBaseInput.value.trim();
  const username   = extUsernameInput.value.trim();
  const password   = extPasswordInput.value;

  if (!serverBase) {
    setStatus(saveStatus, "Enter your RecruitMe server URL.", "error");
    return;
  }
  if (!username || !password) {
    setStatus(saveStatus, "Enter your username and password.", "error");
    return;
  }

  saveBtn.disabled = true;
  setStatus(saveStatus, "Testing connection…", "info");
  setConnectionBadge("unconfigured", "Connecting…");

  try {
    const response = await sendMessage({
      type:       "set-config",
      serverBase,
      username,
      password,
    });
    setConnectionBadge("connected", `Connected · ${new URL(response.serverBase).hostname}`);
    setStatus(saveStatus, "Saved. You can close this page.", "ok");
  } catch (error) {
    setConnectionBadge("disconnected", "Connection failed — check your URL and credentials.");
    setStatus(saveStatus, error.message, "error");
  } finally {
    saveBtn.disabled = false;
  }
});

// Allow Enter in password field to trigger save
extPasswordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveBtn.click();
});

init();
void refreshAutoCaptureStatus();
setInterval(refreshAutoCaptureStatus, 15_000);


// ── DeepSeek key (standalone agent) ──────────────────────────────────────────
// Stored in this browser only. The side panel sends it straight to
// api.deepseek.com; there is no RecruitMe login or server involved.
(() => {
  const field = document.getElementById("deepseekKey");
  const status = document.getElementById("deepseekStatus");
  const button = document.getElementById("saveDeepseek");
  if (!field || !button) return;

  chrome.storage.local.get("deepseekKey").then(({ deepseekKey }) => {
    if (deepseekKey) {
      field.value = deepseekKey;
      status.textContent = "Saved.";
    }
  });

  button.addEventListener("click", async () => {
    const key = field.value.trim();
    if (!key) {
      await chrome.storage.local.remove("deepseekKey");
      status.textContent = "Cleared.";
      return;
    }
    // Fail early and specifically rather than at the first hunt.
    if (!key.startsWith("sk-")) {
      status.textContent = "That doesn't look like a DeepSeek key (they start with sk-).";
      return;
    }
    await chrome.storage.local.set({ deepseekKey: key });
    status.textContent = "Saved.";
  });
})();
