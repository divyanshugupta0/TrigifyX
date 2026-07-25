/* TrigifyX Security Alerts — frontend app (Firebase v9+ modular SDK)
 * Flow:
 *  1. User must be logged in (shared auth with main TrigifyX app)
 *  2. Telegram must be linked and verified (messaging service)
 *  3. User requests Security Alerts API key -> OTP sent to Telegram
 *  4. User verifies OTP -> API key issued
 *  5. User can send security alerts via HTTPS API
 *
 * Shared authentication with main app via Firebase Auth.
 */
import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";
import {
  ref,
  get,
  set,
  update
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";

const ENV = window.__ENV__ || {};
const BOT_USERNAME = "TrigifyXbot";

let currentUser = null;

/* ---------- Demo-mode storage (localStorage) ---------- */
const Demo = {
  profile(uid) {
    return JSON.parse(localStorage.getItem("tgx_profile_" + uid) || "null");
  },
  saveProfile(uid, p) {
    localStorage.setItem("tgx_profile_" + uid, JSON.stringify(p));
  },
  user(uid) {
    return JSON.parse(localStorage.getItem("tgx_user_" + uid) || "null");
  },
  saveUser(u, p) {
    localStorage.setItem("tgx_user_" + u.uid, JSON.stringify(u));
    if (p) this.saveProfile(u.uid, p);
  },
};

function demoMode() {
  const f = window.__fb || {};
  return !f.db || window.__DEMO__ === true;
}

/* ---------- Helpers ---------- */
function $(s) { return document.querySelector(s); }
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove("show"), 2200);
}
function copy(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    toast("Copied to clipboard");
    if (btn) {
      const original = btn.textContent;
      btn.textContent = "Copied";
      clearTimeout(btn._ct);
      btn._ct = setTimeout(() => { btn.textContent = original; }, 1500);
    }
  });
}

/* ---------- Auth (shared with main app) ---------- */
async function checkAuth() {
  const auth = (window.__fb || {}).auth;
  if (!auth) {
    // Firebase not loaded yet, wait
    return new Promise((resolve) => {
      const check = () => {
        if ((window.__fb || {}).auth) {
          resolve(checkAuth());
        }
      };
      window.addEventListener("fb-ready", check);
      setTimeout(() => resolve(null), 2000);
    });
  }

  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      unsubscribe();
      if (u) {
        currentUser = u;
        resolve(u);
      } else {
        // Not logged in - redirect to main app login
        window.location.href = "/?redirect=/security-alerts/";
        resolve(null);
      }
    });
  });
}

async function getProfile(u) {
  const db = (window.__fb || {}).db;
  if (demoMode()) return Demo.profile(u.uid);
  const snap = await get(ref(db, "users/" + u.uid));
  return snap.val();
}

async function saveProfile(u, p) {
  const db = (window.__fb || {}).db;
  if (demoMode()) return Demo.saveProfile(u.uid, p);
  return set(ref(db, "users/" + u.uid), p);
}

/* ---------- UI rendering ---------- */
function showAuth() {
  console.log("[security-alerts] showAuth");
  $("#auth-view").classList.remove("hide");
  $("#app-view").classList.add("hide");
  $("#profile-menu").classList.add("hide");
  $("#profile-menu").classList.remove("open");
}

function showApp() {
  console.log("[security-alerts] showApp");
  $("#auth-view").classList.add("hide");
  $("#app-view").classList.remove("hide");
  $("#profile-menu").classList.remove("hide");
}

function renderProfile(p) {
  window.__profile = p;

  $("#disp-name").textContent = p.name || "—";
  $("#disp-email").textContent = p.email;
  $("#disp-tg-status").innerHTML = p.telegram_chat_id
    ? '<span class="badge ok">Linked</span>'
    : '<span class="badge warn">Not Linked</span>';
  $("#disp-plan").textContent = p.plan || "free";
  $("#disp-created").textContent = new Date(p.createdAt).toLocaleDateString();

  // Topbar profile avatar / dropdown
  const label = p.name || p.email || "";
  $("#user-avatar").textContent = label ? label.trim().charAt(0).toUpperCase() : "?";
  $("#top-uid").textContent = p.name || p.email || "";
  $("#profile-dropdown-email").textContent = p.email || "—";

  // Telegram link status
  const tgLinked = !!p.telegram_chat_id;
  const tgLinkStatus = $("#tg-link-status");
  if (tgLinkStatus) {
    tgLinkStatus.innerHTML = tgLinked
      ? '<span class="badge ok">Linked</span>'
      : '<span class="badge warn">Not Linked</span>';
  }

  if (tgLinked) {
    $("#tg-setup-section").classList.add("inactive");
    $("#tg-setup-section").classList.remove("active");
    $("#tg-linked-section").classList.add("active");
    $("#tg-linked-username").textContent = "@" + (p.telegram || "—");
    $("#tg-linked-chatid").textContent = p.telegram_chat_id || "—";
  } else {
    $("#tg-setup-section").classList.remove("inactive");
    $("#tg-setup-section").classList.add("active");
    $("#tg-linked-section").classList.remove("active");
  }

  // Access code timer (shared with main app logic)
  if (p._accessCode && p._accessCodeExpiresAt && p._accessCodeExpiresAt > Date.now()) {
    const display = $("#access-code-display");
    const timer = $("#access-code-timer");
    if (display && timer) {
      display.textContent = p._accessCode;
      display.classList.remove("hide");
    }
  }

  if (!window.__accessCodeTimer) {
    window.__accessCodeTimer = setInterval(() => {
      const p = window.__profile;
      if (!p || !p._accessCodeExpiresAt || !p._accessCode) {
        const timer = $("#access-code-timer");
        const display = $("#access-code-display");
        if (timer) timer.textContent = "0:00";
        if (display) display.classList.add("hide");
        return;
      }
      const remaining = Math.max(0, Math.floor((p._accessCodeExpiresAt - Date.now()) / 1000));
      const m = Math.floor(remaining / 60).toString().padStart(2, "0");
      const s = (remaining % 60).toString().padStart(2, "0");
      const timerEl = $("#access-code-timer");
      const displayEl = $("#access-code-display");
      if (timerEl) timerEl.textContent = m + ":" + s;
      if (remaining <= 0) {
        if (displayEl) displayEl.classList.add("hide");
      }
    }, 1000);
  }

  // Security Alerts API Key status
  const securityApiKey = p.securityApiKey || "";
  const apikeyNotIssued = $("#apikey-not-issued");
  const apikeyOtpSection = $("#apikey-otp-section");
  const apikeyIssued = $("#apikey-issued");
  const issueBtn = $("#issue-apikey-btn");

  if (securityApiKey) {
    // API key already issued
    apikeyNotIssued.classList.remove("active");
    apikeyOtpSection.classList.remove("active");
    apikeyIssued.classList.add("active");
    $("#security-apikey-display").textContent = securityApiKey;
    $("#disp-apikey-status").innerHTML = '<span class="badge ok">Issued</span>';
  } else if (window.__securityOtpPending) {
    // OTP pending
    apikeyNotIssued.classList.remove("active");
    apikeyOtpSection.classList.add("active");
    apikeyIssued.classList.remove("active");
    $("#disp-apikey-status").innerHTML = '<span class="badge warn">Pending OTP</span>';
  } else {
    // Not issued
    apikeyNotIssued.classList.add("active");
    apikeyOtpSection.classList.remove("active");
    apikeyIssued.classList.remove("active");
    $("#disp-apikey-status").innerHTML = '<span class="badge warn">Not Issued</span>';
  }

  // Enable/disable issue button based on Telegram link status
  if (issueBtn) {
    issueBtn.disabled = !tgLinked || !!securityApiKey;
    if (!tgLinked) {
      issueBtn.textContent = "Issue API Key (Requires Telegram Link)";
    } else if (securityApiKey) {
      issueBtn.textContent = "API Key Already Issued";
    } else {
      issueBtn.textContent = "Issue Security Alerts API Key";
    }
  }
}

/* ---------- OTP Timer ---------- */
function startOtpTimer() {
  if (window.__otpTimer) clearInterval(window.__otpTimer);
  const otpExpiresAt = window.__otpExpiresAt || (Date.now() + 5 * 60 * 1000);
  window.__otpExpiresAt = otpExpiresAt;

  window.__otpTimer = setInterval(() => {
    const remaining = Math.max(0, Math.floor((otpExpiresAt - Date.now()) / 1000));
    const m = Math.floor(remaining / 60).toString().padStart(2, "0");
    const s = (remaining % 60).toString().padStart(2, "0");
    const timerEl = $("#otp-timer");
    if (timerEl) timerEl.textContent = m + ":" + s;
    if (remaining <= 0) {
      clearInterval(window.__otpTimer);
      window.__otpTimer = null;
      window.__securityOtpPending = false;
      const p = window.__profile;
      if (p) renderProfile(p);
    }
  }, 1000);
}

/* ---------- Wire up UI ---------- */
function bindUI() {
  // Profile dropdown
  $("#profile-trigger").onclick = (e) => {
    e.stopPropagation();
    const menu = $("#profile-menu");
    const open = menu.classList.toggle("open");
    $("#profile-trigger").setAttribute("aria-expanded", open ? "true" : "false");
  };
  document.addEventListener("click", (e) => {
    const menu = $("#profile-menu");
    if (menu.classList.contains("open") && !menu.contains(e.target)) {
      menu.classList.remove("open");
      $("#profile-trigger").setAttribute("aria-expanded", "false");
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      $("#profile-menu").classList.remove("open");
      $("#profile-trigger").setAttribute("aria-expanded", "false");
    }
  });

  // Logout
  $("#logout").onclick = async () => {
    const auth = (window.__fb || {}).auth;
    if (!demoMode() && auth) await auth.signOut();
    currentUser = null;
    window.__profile = null;
    window.location.href = "/?redirect=/security-alerts/";
  };

  // Check Telegram link
  $("#tg-check").onclick = async () => {
    const btn = $("#tg-check");
    if (btn && btn.classList.contains("linked-success")) return;
    if (btn && btn.classList.contains("spinning")) return;

    btn.classList.add("spinning");
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = "Checking…";

    let linked = false;
    let chatId = "";
    try {
      await new Promise((resolve) => setTimeout(resolve, 5000));

      for (let attempt = 1; attempt <= 3; attempt++) {
        const p = await getProfile(currentUser);
        if (!p) {
          toast("Profile not found");
          return;
        }
        chatId = p.telegram_chat_id || "";
        if (chatId) {
          linked = true;
          break;
        }
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 1200));
        }
      }

      if (linked) {
        const accessSection = $("#access-code-section");
        if (accessSection) accessSection.classList.add("hide");
        const fresh = await getProfile(currentUser);
        if (fresh) {
          window.__profile = fresh;
          renderProfile(fresh);
        }
        toast("Telegram linked: " + chatId);
      } else {
        toast("Not linked yet — send /config to @TrigifyXbot in Telegram and enter the access code");
      }
    } finally {
      btn.classList.remove("spinning");
      if (linked) {
        btn.classList.add("linked-success");
        btn.textContent = "Linked Successfully";
        btn.disabled = true;
      } else {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    }
  };

  // Refresh access code
  $("#regen-access-code").onclick = async () => {
    await withLoading($("#regen-access-code"), "Refreshing…", async () => {
      const p = await getProfile(currentUser);
      const db = (window.__fb || {}).db;
      if (!db || !p || !p.accessToken) return toast("Access token not ready");
      const code = Math.floor(10000 + Math.random() * 90000).toString();
      p._accessCode = code;
      p._accessCodeExpiresAt = Date.now() + 5 * 60 * 1000;
      try {
        await set(ref(db, "accesscode/" + code), {
          token: p.accessToken,
          ttl: Date.now(),
          expiresAt: p._accessCodeExpiresAt,
        });
      } catch (_) {}
      window.__profile = p;
      renderProfile(p);
      toast("New access code generated");
    });
  };

  // Issue API Key - send OTP
  $("#issue-apikey-btn").onclick = async () => {
    const p = await getProfile(currentUser);
    if (!p || !p.telegram_chat_id) {
      toast("Please link your Telegram first");
      return;
    }

    await withLoading($("#issue-apikey-btn"), "Sending OTP…", async () => {
      try {
        const ENDPOINT = (ENV.apiBase || "").replace(/\/$/, "");
        const res = await fetch(
          ENDPOINT + "/api/security-alerts/send-otp",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accessToken: p.accessToken })
          }
        );

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "Failed to send OTP" }));
          throw new Error(err.error || "Failed to send OTP");
        }

        window.__securityOtpPending = true;
        window.__otpExpiresAt = Date.now() + 5 * 60 * 1000;
        startOtpTimer();
        renderProfile(p);
        toast("OTP sent to your Telegram");
      } catch (e) {
        toast(e.message || "Failed to send OTP");
      }
    });
  };

  // Verify OTP and issue API key
  $("#verify-otp-btn").onclick = async () => {
    const otpInput = $("#otp-input");
    const otp = otpInput.value.trim();

    if (!otp || !/^\d{6}$/.test(otp)) {
      toast("Enter a valid 6-digit OTP");
      return;
    }

    await withLoading($("#verify-otp-btn"), "Verifying…", async () => {
      try {
        const p = await getProfile(currentUser);
        if (!p || !p.accessToken) {
          toast("Profile not found");
          return;
        }

        const ENDPOINT = (ENV.apiBase || "").replace(/\/$/, "");
        const res = await fetch(
          ENDPOINT + "/api/security-alerts/verify-otp",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              accessToken: p.accessToken,
              otp: otp
            })
          }
        );

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "OTP verification failed" }));
          throw new Error(err.error || "OTP verification failed");
        }

        const data = await res.json();
        window.__securityOtpPending = false;
        if (window.__otpTimer) clearInterval(window.__otpTimer);
        window.__otpTimer = null;

        // Update profile with new security API key
        p.securityApiKey = data.securityApiKey;
        await saveProfile(currentUser, p);
        window.__profile = p;

        renderProfile(p);
        toast("Security Alerts API key issued successfully!");
      } catch (e) {
        toast(e.message || "OTP verification failed");
      }
    });
  };

  // Cancel OTP
  $("#cancel-otp-btn").onclick = () => {
    window.__securityOtpPending = false;
    if (window.__otpTimer) clearInterval(window.__otpTimer);
    window.__otpTimer = null;
    const p = window.__profile;
    if (p) renderProfile(p);
  };

  // Copy security API key
  $("#copy-security-apikey").onclick = () => {
    copy($("#security-apikey-display").textContent, $("#copy-security-apikey"));
  };

  // Copy security snippet
  $("#copy-security-snippet").onclick = () => {
    copy($("#security-snippet").textContent, $("#copy-security-snippet"));
  };

  // Copy example payload
  $("#copy-example-payload").onclick = () => {
    copy($("#example-payload").textContent, $("#copy-example-payload"));
  };

  // Send test alert
  $("#send-test-alert").onclick = async () => {
    const p = await getProfile(currentUser);
    if (!p || !p.securityApiKey) {
      toast("Issue a Security Alerts API key first");
      return;
    }

    const alertType = $("#test-alert-type").value;
    const severity = $("#test-severity").value;
    const title = $("#test-title").value.trim() || "Test Alert";
    const message = $("#test-message").value.trim() || "This is a test security alert from TrigifyX.";

    await withLoading($("#send-test-alert"), "Sending…", async () => {
      try {
        const ENDPOINT = (ENV.apiBase || "").replace(/\/$/, "");
        const res = await fetch(
          ENDPOINT + "/api/security-alerts/send",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": "Bearer " + p.securityApiKey
            },
            body: JSON.stringify({
              alert_type: alertType,
              severity: severity,
              title: title,
              message: message,
              source: "dashboard_test",
              timestamp: new Date().toISOString()
            })
          }
        );

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "Failed to send alert" }));
          throw new Error(err.error || "Failed to send alert");
        }

        toast("Test alert sent to Telegram");
        $("#test-title").value = "";
        $("#test-message").value = "";
      } catch (e) {
        toast(e.message || "Failed to send alert");
      }
    });
  };

  // Regenerate security API key
  $("#regenerate-security-apikey").onclick = async () => {
    const ok = confirm(
      "Regenerating your Security Alerts API key will break any integrations using the current key. Continue?"
    );
    if (!ok) return;

    await withLoading($("#regenerate-security-apikey"), "Regenerating…", async () => {
      try {
        const p = await getProfile(currentUser);
        const ENDPOINT = (ENV.apiBase || "").replace(/\/$/, "");
        const res = await fetch(
          ENDPOINT + "/api/security-alerts/regenerate",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": "Bearer " + p.securityApiKey
            },
            body: JSON.stringify({ accessToken: p.accessToken })
          }
        );

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "Failed to regenerate" }));
          throw new Error(err.error || "Failed to regenerate API key");
        }

        const data = await res.json();
        p.securityApiKey = data.securityApiKey;
        await saveProfile(currentUser, p);
        window.__profile = p;
        renderProfile(p);
        toast("Security Alerts API key regenerated");
      } catch (e) {
        toast(e.message || "Failed to regenerate API key");
      }
    });
  };

  // Unlink Telegram
  $("#tg-unlink").onclick = async () => {
    const ok = confirm("Unlink Telegram? You will need to re-link to issue Security Alerts API keys.");
    if (!ok) return;

    await withLoading($("#tg-unlink"), "Unlinking…", async () => {
      try {
        const p = await getProfile(currentUser);
        p.telegram_chat_id = "";
        p.telegram = "";
        await saveProfile(currentUser, p);
        window.__profile = p;
        renderProfile(p);
        toast("Telegram unlinked");
      } catch (e) {
        toast("Failed to unlink Telegram");
      }
    });
  };
}

/* ---------- Helpers ---------- */
function withLoading(btn, loadingLabel, fn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = loadingLabel;
  try {
    return fn().finally(() => {
      btn.disabled = false;
      btn.textContent = original;
    });
  } catch (e) {
    btn.disabled = false;
    btn.textContent = original;
    throw e;
  }
}

/* ---------- Boot ---------- */
async function boot() {
  try {
    bindUI();

    // Check if user is authenticated
    const user = await checkAuth();
    if (!user) {
      showAuth();
      return;
    }

    // Load profile
    let p = await getProfile(user);
    if (!p) {
      p = {
        uid: user.uid,
        email: user.email,
        name: user.displayName || "",
        telegram: "",
        telegram_chat_id: "",
        apiKey: "",
        accessToken: "",
        createdAt: Date.now(),
        plan: "free",
        apiKeyIssued: false,
        siteUrl: "",
        securityApiKey: ""
      };
      await saveProfile(user, p);
    }

    // Backfill missing fields
    let needsSave = false;
    if (!p.securityApiKey) { p.securityApiKey = ""; needsSave = true; }
    if (typeof p.telegram_chat_id === "undefined") { p.telegram_chat_id = ""; needsSave = true; }
    if (needsSave) await saveProfile(user, p);

    window.__profile = p;

    // Mirror required fields to pub node
    const db = (window.__fb || {}).db;
    if (db && p.accessToken) {
      p.telegram = (p.telegram || "").replace(/^@/, "").trim().toLowerCase();
      await set(ref(db, "pub/" + p.accessToken + "/telegram"), p.telegram);
      await set(ref(db, "pub/" + p.accessToken + "/telegram_chat_id"), p.telegram_chat_id || "");
      await set(ref(db, "pub/" + p.accessToken + "/uid"), p.uid);
    }

    renderProfile(p);
    showApp();
  } catch (e) {
    console.error("[security-alerts] boot failed:", e);
    showAuth();
  }
}

// Boot when Firebase is ready
if ((window.__fb || {}).auth) {
  boot();
} else {
  window.addEventListener("fb-ready", boot);
  setTimeout(() => {
    if ((window.__fb || {}).auth) boot();
  }, 1500);
}