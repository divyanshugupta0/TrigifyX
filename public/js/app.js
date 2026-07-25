/* TrigifyX — unified frontend app (Firebase v9+ modular SDK)
 *
 * Sections:
 *   - Landing (marketing + auth)
 *   - Login (standalone)
 *   - Signup (standalone)
 *   - Form Messaging Dashboard
 *   - Security Alerts Dashboard
 *   - Settings
 *
 * Shared authentication for both features.
 */
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile,
  GoogleAuthProvider,
  signInWithPopup,
  deleteUser
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";
import {
  ref,
  set,
  get,
  update,
  remove
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
function uid() { return "u_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
function apiKey() {
  const r = () => Math.random().toString(36).slice(2);
  return "tgx_" + r() + r() + r();
}
function accessToken() {
  const c = globalThis.crypto || globalThis.msCrypto;
  if (c && c.getRandomValues) {
    const a = new Uint8Array(36);
    c.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  let s = "";
  for (let i = 0; i < 72; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}
function accessCode() {
  return Math.floor(10000 + Math.random() * 90000).toString();
}
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

function friendlyError(e) {
  const code = (e && e.code) || "";
  const map = {
    "auth/email-already-in-use": "That email is already registered. Try signing in instead.",
    "auth/invalid-email": "Enter a valid email address.",
    "auth/weak-password": "Password must be at least 6 characters.",
    "auth/wrong-password": "Incorrect email or password.",
    "auth/invalid-credential": "Incorrect email or password.",
    "auth/user-not-found": "No account found with that email.",
    "auth/too-many-requests": "Too many attempts. Please wait a moment and try again.",
    "auth/popup-closed-by-user": "Google sign-in was closed before completing.",
    "auth/network-request-failed": "Network error. Check your connection and try again."
  };
  if (map[code]) return map[code];
  if (e && typeof e.message === "string" && e.message && !/firebase/i.test(e.message)) {
    return e.message;
  }
  return "Something went wrong. Please try again.";
}

async function withLoading(btn, loadingLabel, fn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = loadingLabel;
  try {
    await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function verifyRecaptcha(btn) {
  const getToken = (window.__fb || {}).getAppCheckToken;
  if (typeof getToken !== "function") return true;
  const original = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Verifying you're human…";
  }
  try {
    const token = await getToken(true);
    return true;
  } catch (e) {
    toast("reCAPTCHA verification failed. Please try again.");
    return false;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = original;
    }
  }
}

/* ---------- Auth ---------- */
async function signUp(email, password, name, telegram) {
  const auth = (window.__fb || {}).auth;
  const db = (window.__fb || {}).db;
  const token = accessToken();
  const normalizedTelegram = (telegram || "").replace(/^@/, "").trim().toLowerCase();
  const profile = {
    uid: "", email, name: name || "", telegram: normalizedTelegram,
    telegram_chat_id: "", apiKey: apiKey(), accessToken: token, createdAt: Date.now(), plan: "free",
    apiKeyIssued: false, siteUrl: ""
  };
  if (demoMode()) {
    const u = { uid: uid(), email, name: profile.name, telegram: profile.telegram, accessToken: token };
    Demo.saveUser(u, profile);
    profile.uid = u.uid;
    return u;
  }
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  profile.uid = cred.user.uid;
  if (name) {
    try { await updateProfile(cred.user, { displayName: name }); } catch (e) {}
  }
  try {
    await set(ref(db, "users/" + cred.user.uid), profile);
    await set(ref(db, "pub/" + token + "/telegram"), normalizedTelegram);
    await set(ref(db, "pub/" + token + "/telegram_chat_id"), "");
    await set(ref(db, "pub/" + token + "/uid"), cred.user.uid);
  } catch (writeErr) {
    console.error("[signUp] profile write failed:", writeErr);
    try { await signOut(auth); } catch (_) {}
    try { await deleteUser(cred.user); } catch (_) {}
    throw new Error("Failed to save profile. Please try again.");
  }
  return cred.user;
}

async function signIn(email, password) {
  const auth = (window.__fb || {}).auth;
  if (demoMode()) {
    const all = Object.keys(localStorage)
      .filter(k => k.startsWith("tgx_user_"))
      .map(k => JSON.parse(localStorage.getItem(k)))
      .find(u => u.email === email);
    if (!all) throw new Error("No demo account with that email. Sign up first.");
    return all;
  }
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

async function signInWithGoogle() {
  const auth = (window.__fb || {}).auth;
  if (demoMode()) {
    const u = { uid: uid(), email: "demo.google@trigifyx.app", name: "Google User", telegram: "" };
    const prof = {
      uid: u.uid, email: u.email, name: u.name, telegram: "", telegram_chat_id: "", apiKey: apiKey(),
      createdAt: Date.now(), plan: "free", apiKeyIssued: false, siteUrl: ""
    };
    Demo.saveUser(u, prof);
    return u;
  }
  const provider = new GoogleAuthProvider();
  const cred = await signInWithPopup(auth, provider);
  return cred.user;
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
async function clearUsedAccessCode(u, p) {
  if (!p) return;
  p._accessCode = null;
  p._accessCodeExpiresAt = null;
  await saveProfile(u, p);
}

async function mergeTokenMeta(p) {
  if (!p || !p.accessToken) return;
  const db = (window.__fb || {}).db;
  if (!db) return;
  try {
    const [metaSnap, tgChatSnap] = await Promise.all([
      get(ref(db, "pub/" + p.accessToken + "/meta")),
      get(ref(db, "pub/" + p.accessToken + "/telegram_chat_id"))
    ]);
    const m = metaSnap.val();
    if (m) {
      if (typeof m.submissionCount === "number") p.submissionCount = m.submissionCount;
      if (typeof m.lastSubmissionAt !== "undefined") p.lastSubmissionAt = m.lastSubmissionAt;
      if (typeof m.lastSubmissionPage !== "undefined") p.lastSubmissionPage = m.lastSubmissionPage;
      if (typeof m.exposedChances === "number") p.exposedChances = m.exposedChances;
      if (typeof m.lastExposureAt !== "undefined") p.lastExposureAt = m.lastExposureAt;
      if (typeof m.blocked === "boolean") p.blocked = m.blocked;
    }
    const tgChat = tgChatSnap.val();
    if (tgChat) p.telegram_chat_id = String(tgChat);
    window.__profile = p;
  } catch (_) { /* best-effort */ }
}

/* ---------- Section Navigation ---------- */
function hideAllSections() {
  const sections = [
    "landing-view", "login-view", "signup-view", "complete-view",
    "app-view", "messaging-view", "security-alerts-view", "settings-view"
  ];
  sections.forEach(id => {
    const el = $("#" + id);
    if (el) el.classList.add("hide");
  });
}

function showSection(section) {
  hideAllSections();

  const protectedSections = ["messaging", "security-alerts", "settings"];
  if (protectedSections.includes(section) && !currentUser) {
    showLogin();
    toast("Please sign in to access this section");
    return;
  }

  const map = {
    "landing": "landing-view",
    "login": "login-view",
    "signup": "signup-view",
    "complete": "complete-view",
    "messaging": "messaging-view",
    "security-alerts": "security-alerts-view",
    "settings": "settings-view"
  };
  const targetId = map[section];
  if (targetId) {
    const el = $("#" + targetId);
    if (el) el.classList.remove("hide");
  }

  // Update nav active state
  document.querySelectorAll(".nav-link").forEach(link => {
    link.classList.toggle("active", link.getAttribute("data-section") === section);
  });

  // Footer visibility: hide on auth pages, show elsewhere
  const footer = $("#page-footer");
  const hideFooter = ["login", "signup", "complete"].includes(section);
  if (footer) {
    footer.classList.toggle("hide", hideFooter);
  }
}

function showLanding() {
  showSection("landing");
}

function showLogin() {
  showSection("login");
  updateNavForGuest();
}

function showSignup() {
  showSection("signup");
  updateNavForGuest();
}

function showApp() {
  updateNavForUser();
  renderMessagingDashboard();
  showSection("messaging");
}

function updateNavForGuest() {
  $("#nav-guest").classList.remove("hide");
  $("#profile-menu").classList.add("hide");
  document.querySelectorAll(".protected-nav").forEach(el => el.classList.add("hide"));
  document.querySelectorAll(".landing-only").forEach(el => el.classList.remove("hide"));
}

function updateNavForUser() {
  $("#nav-guest").classList.add("hide");
  $("#profile-menu").classList.remove("hide");
  document.querySelectorAll(".protected-nav").forEach(el => el.classList.remove("hide"));
  document.querySelectorAll(".landing-only").forEach(el => el.classList.add("hide"));
}

/* ---------- Messaging Dashboard ---------- */
function renderMessagingDashboard() {
  const p = currentProfile();
  if (!p) return;

  $("#msg-disp-name").textContent = p.name || "—";
  $("#msg-disp-email").textContent = p.email;
  $("#msg-disp-uid").textContent = p.uid || "—";
  $("#msg-disp-created").textContent = new Date(p.createdAt).toLocaleDateString();
  $("#msg-disp-plan").textContent = p.plan || "free";

  // Topbar
  const label = p.name || p.email || "";
  $("#user-avatar").textContent = label ? label.trim().charAt(0).toUpperCase() : "?";
  $("#top-uid").textContent = p.name || p.email || "";
  $("#profile-dropdown-email").textContent = p.email || "—";

  const hasToken = !!(p.accessToken && p.accessToken.trim());
  $("#msg-apikey-revealed").classList.toggle("hide", !hasToken);
  if (hasToken) {
    $("#msg-disp-apikey").textContent = p.accessToken;
  }

  const linked = !!p.telegram_chat_id;
  const tgStatus = $("#msg-tg-status");
  if (tgStatus) {
    tgStatus.className = "badge " + (linked ? "ok" : "warn");
    tgStatus.textContent = linked ? "Linked" : "Not Linked";
  }

  const accessSection = $("#msg-access-code-section");
  if (accessSection) {
    accessSection.classList.toggle("hide", linked);
  }

  if (p._accessCode && p._accessCodeExpiresAt && p._accessCodeExpiresAt > Date.now()) {
    const display = $("#msg-access-code-display");
    const timer = $("#msg-access-code-timer");
    if (display && timer) {
      display.textContent = p._accessCode;
      display.classList.remove("hide");
    }
  }

  if (!window.__accessCodeTimer) {
    window.__accessCodeTimer = setInterval(() => {
      const p = currentProfile();
      if (!p || !p._accessCodeExpiresAt || !p._accessCode) {
        const timer = $("#msg-access-code-timer");
        const display = $("#msg-access-code-display");
        if (timer) timer.textContent = "0:00";
        if (display) display.classList.add("hide");
        return;
      }
      const remaining = Math.max(0, Math.floor((p._accessCodeExpiresAt - Date.now()) / 1000));
      const m = Math.floor(remaining / 60).toString().padStart(2, "0");
      const s = (remaining % 60).toString().padStart(2, "0");
      const timerEl = $("#msg-access-code-timer");
      const displayEl = $("#msg-access-code-display");
      if (timerEl) timerEl.textContent = m + ":" + s;
      if (remaining <= 0) {
        if (displayEl) displayEl.classList.add("hide");
        window.__accessCode = null;
        window.__accessCodeExpiresAt = null;
      }
    }, 1000);
  }

  $("#msg-install-card").classList.toggle("hide", !p.apiKeyIssued || p.setupComplete);
  renderSites(p);

  const setupDone = !!p.setupComplete;
  $("#msg-acct-extra").classList.toggle("hide", !setupDone);
  if (setupDone) {
    const sites = getSites(p);
    $("#msg-acct-site").textContent = sites.length
      ? (sites.length === 1 ? sites[0] : sites.length + " sites")
      : "—";
    $("#msg-acct-tg").textContent = p.telegram;
    $("#msg-acct-apikey").textContent = p.accessToken || "—";
  }

  $("#msg-setup-main").classList.toggle("hide", setupDone);
  $("#msg-live-main").classList.toggle("hide", !setupDone);

  updateTestMsgUI(p);
  renderSnippet(p);
  $("#msg-snippet-2").textContent = window.__lastSnippet || "";

  if (setupDone) renderDashboard(p);
}

function renderSnippet(p) {
  const ENDPOINT = ENV.apiBase || "";
  const scriptSrc = ENDPOINT
    ? ENDPOINT.replace(/\/$/, "") + "/trigifyx-capture.js"
    : "js/trigifyx-capture.js";

  const token = p.accessToken || "";
  const endpointLine = ENDPOINT ? '\n    endpoint: "' + ENDPOINT + '",' : "";
  const snippet =
`<!-- TrigifyX: paste before </body> on every page with a form -->
<!-- Also upload js/trigifyx-capture.js to your site (same folder as this page) -->
<script>
  window.TRIGIFYX = {
    accessToken: "${token}",${endpointLine}
  };
</script>
<script src="${scriptSrc}" defer></script>`;

  $("#msg-snippet").textContent = snippet;
  window.__lastSnippet = snippet;
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderSites(p) {
  const ul = $("#msg-site-list");
  if (!ul) return;
  const sites = getSites(p);
  const sig = JSON.stringify(sites);
  if (ul.dataset.sitesSig === sig) return;
  ul.dataset.sitesSig = sig;

  if (!sites.length) {
    ul.innerHTML = '<li class="empty">No sites registered yet — add your first site above.</li>';
    return;
  }
  ul.innerHTML = sites.map((s, i) =>
    '<li class="site-item">' +
      '<span class="site-url" title="' + escapeHtml(s) + '">' + escapeHtml(s) + '</span>' +
      '<button class="btn ghost site-remove" data-site-index="' + i + '">Remove</button>' +
    '</li>'
  ).join("");
}

function renderDashboard(p) {
  const sites = getSites(p);
  const firstShort = sites.length ? sites[0].replace(/^https?:\/\//, "") : "—";
  $("#msg-disp-site-short").textContent = sites.length > 1
    ? sites.length + " sites"
    : firstShort;
  $("#msg-dash-site").textContent = sites.length
    ? (sites.length === 1 ? sites[0] : sites.join(", "))
    : "—";
  $("#msg-dash-tg").textContent = p.telegram || "—";
  $("#msg-dash-terms").textContent = p.termsAcceptedAt
    ? new Date(p.termsAcceptedAt).toLocaleString()
    : "—";

  const exposed = p.exposedChances || 0;
  $("#msg-dash-exposed").textContent = exposed + " / 3";
  const blocked = !!p.blocked;
  $("#msg-blocked-banner").classList.toggle("hide", !blocked);
  const badge = $("#msg-disp-status-badge");
  if (badge) {
    badge.className = "badge " + (blocked ? "warn" : "ok");
    badge.textContent = blocked ? "Blocked" : "Live";
  }
  if (blocked) {
    const t = $("#msg-test-msg-btn-2");
    if (t) { t.disabled = true; t.textContent = "Token Blocked"; }
  }

  $("#msg-dash-last").textContent = p.lastSubmissionAt
    ? new Date(p.lastSubmissionAt).toLocaleString() +
      (p.lastSubmissionPage ? " · " + p.lastSubmissionPage : "")
    : "—";

  const count = p.submissionCount || 0;
  $("#msg-disp-submissions").textContent = count;
  const log = $("#msg-submission-log");
  if (!count) {
    log.innerHTML = '<li class="empty">No submissions yet — they\'ll appear the moment someone fills a form.</li>';
  } else {
    log.innerHTML =
      '<li>' +
        '<div class="sub-site">' + (p.lastSubmissionPage || "your form") + '</div>' +
        '<div class="sub-when">' + count + ' total · last ' +
          (p.lastSubmissionAt ? new Date(p.lastSubmissionAt).toLocaleString() : "—") +
        '</div>' +
      '</li>';
  }
}

const TEST_MSG_LIMIT = 3;

function updateTestMsgUI(p) {
  const used = p.testMessageCount || 0;
  const remaining = Math.max(0, TEST_MSG_LIMIT - used);
  const countEl = $("#msg-test-msg-count");
  if (countEl) {
    countEl.textContent = remaining + " test message" + (remaining === 1 ? "" : "s") + " left";
  }
  const disabled = remaining <= 0 || !p.telegram;
  const btn = $("#msg-test-msg-btn");
  const btn2 = $("#msg-test-msg-btn-2");
  if (btn) btn.disabled = disabled;
  if (btn2) btn2.disabled = disabled;
}

async function sendTestMessage() {
  const p = currentProfile() || (await getProfile(currentUser));
  const used = p.testMessageCount || 0;

  if (used >= TEST_MSG_LIMIT) {
    toast("You've used all " + TEST_MSG_LIMIT + " test messages");
    return;
  }
  if (!p.telegram) {
    toast("Link your Telegram chat ID first");
    return;
  }

  await withLoading($("#msg-test-msg-btn"), "Sending…", async () => {
    try {
      const ENDPOINT = ENV.apiBase || "";
      const res = await fetch(
        (ENDPOINT ? ENDPOINT.replace(/\/$/, "") : "") + "/test-message",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accessToken: p.accessToken })
        }
      );
      if (!res.ok) throw new Error("Failed to send test message");

      p.testMessageCount = used + 1;
      await saveProfile(currentUser, p);
      renderMessagingDashboard();
      toast("Test message sent to Telegram");
    } catch (e) {
      toast(friendlyError(e));
    }
  });
}

/* ---------- Validation ---------- */
function isValidSiteUrl(v) {
  return /^https?:\/\/.+\..+/i.test(v.trim());
}

/* ---------- Sites (multi-site per token) ---------- */
function getSites(p) {
  const out = [];
  const seen = new Set();
  const push = (v) => {
    if (!v) return;
    const s = String(v).trim();
    if (!s) return;
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };
  if (p && Array.isArray(p.siteUrls)) p.siteUrls.forEach(push);
  if (p && p.siteUrl) push(p.siteUrl);
  return out;
}

function setSites(p, sites) {
  const list = [];
  const seen = new Set();
  (sites || []).forEach((v) => {
    if (!v) return;
    const s = String(v).trim();
    if (!s) return;
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    list.push(s);
  });
  p.siteUrls = list;
  p.siteUrl = list.length ? list[0] : "";
  return list;
}

async function mirrorSitesToPub(p) {
  const db = (window.__fb || {}).db;
  if (!db || !p || !p.accessToken) return;
  const list = getSites(p);
  await set(ref(db, "pub/" + p.accessToken + "/siteUrls"), list);
  await set(ref(db, "pub/" + p.accessToken + "/siteUrl"), list.length ? list[0] : null);
}

/* ---------- Security Alerts ---------- */
function startOtpTimer() {
  if (window.__otpTimer) clearInterval(window.__otpTimer);
  const otpExpiresAt = window.__otpExpiresAt || (Date.now() + 5 * 60 * 1000);
  window.__otpExpiresAt = otpExpiresAt;

  window.__otpTimer = setInterval(() => {
    const remaining = Math.max(0, Math.floor((otpExpiresAt - Date.now()) / 1000));
    const m = Math.floor(remaining / 60).toString().padStart(2, "0");
    const s = (remaining % 60).toString().padStart(2, "0");
    const timerEl = $("#sec-otp-timer");
    if (timerEl) timerEl.textContent = m + ":" + s;
    if (remaining <= 0) {
      clearInterval(window.__otpTimer);
      window.__otpTimer = null;
      window.__securityOtpPending = false;
      const p = window.__profile;
      if (p) renderSecurityAlerts(p);
    }
  }, 1000);
}

function renderSecurityAlerts(p) {
  if (!p) return;
  window.__profile = p;

  $("#sec-disp-name").textContent = p.name || "—";
  $("#sec-disp-email").textContent = p.email;
  $("#sec-disp-uid").textContent = p.uid || "—";
  $("#sec-disp-created").textContent = new Date(p.createdAt).toLocaleDateString();
  $("#sec-disp-plan").textContent = p.plan || "free";

  const label = p.name || p.email || "";
  $("#user-avatar").textContent = label ? label.trim().charAt(0).toUpperCase() : "?";
  $("#top-uid").textContent = p.name || p.email || "";
  $("#profile-dropdown-email").textContent = p.email || "—";

  const tgLinked = !!p.telegram_chat_id;
  const tgLinkStatus = $("#sec-tg-link-status");
  if (tgLinkStatus) {
    tgLinkStatus.innerHTML = tgLinked
      ? '<span class="badge ok">Linked</span>'
      : '<span class="badge warn">Not Linked</span>';
  }

  const tgStatusCard = $("#sec-disp-tg-status");
  if (tgStatusCard) {
    tgStatusCard.innerHTML = tgLinked
      ? '<span class="badge ok">Linked</span>'
      : '<span class="badge warn">Not Linked</span>';
  }

  if (tgLinked) {
    $("#sec-tg-setup-section").classList.add("inactive");
    $("#sec-tg-setup-section").classList.remove("active");
    $("#sec-tg-linked-section").classList.add("active");
    $("#sec-tg-linked-username").textContent = "@" + (p.telegram || "—");
    $("#sec-tg-linked-chatid").textContent = p.telegram_chat_id || "—";
  } else {
    $("#sec-tg-setup-section").classList.remove("inactive");
    $("#sec-tg-setup-section").classList.add("active");
    $("#sec-tg-linked-section").classList.remove("active");
  }

  if (p._accessCode && p._accessCodeExpiresAt && p._accessCodeExpiresAt > Date.now()) {
    const display = $("#sec-access-code-display");
    const timer = $("#sec-access-code-timer");
    if (display && timer) {
      display.textContent = p._accessCode;
      display.classList.remove("hide");
    }
  }

  const securityApiKey = p.securityApiKey || "";
  const securityApiKeyIssued = !!p.securityApiKeyIssued;
  const apikeyNotIssued = $("#sec-apikey-not-issued");
  const apikeyOtpSection = $("#sec-apikey-otp-section");
  const apikeyIssued = $("#sec-apikey-issued");
  const issueBtn = $("#sec-issue-apikey-btn");

  if (securityApiKeyIssued && securityApiKey) {
    apikeyNotIssued.classList.add("hide");
    apikeyOtpSection.classList.add("hide");
    apikeyIssued.classList.remove("hide");
    $("#sec-apikey-display").textContent = securityApiKey;
    $("#sec-disp-apikey-status").innerHTML = '<span class="badge ok">Issued</span>';
  } else if (window.__securityOtpPending) {
    apikeyNotIssued.classList.add("hide");
    apikeyOtpSection.classList.remove("hide");
    apikeyIssued.classList.add("hide");
    $("#sec-disp-apikey-status").innerHTML = '<span class="badge warn">Pending OTP</span>';
  } else {
    apikeyNotIssued.classList.remove("hide");
    apikeyOtpSection.classList.add("hide");
    apikeyIssued.classList.add("hide");
    $("#sec-disp-apikey-status").innerHTML = '<span class="badge warn">Not Issued</span>';
  }

  if (issueBtn) {
    issueBtn.disabled = !tgLinked || securityApiKeyIssued;
    if (!tgLinked) {
      issueBtn.textContent = "Issue API Key (Requires Telegram Link)";
    } else if (securityApiKeyIssued) {
      issueBtn.textContent = "API Key Already Issued";
    } else {
      issueBtn.textContent = "Issue Security Alerts API Key";
    }
  }
}
function renderSettings(p) {
  if (!p) return;
  $("#set-disp-name").textContent = p.name || "—";
  $("#set-disp-email").textContent = p.email || "—";
  $("#set-disp-uid").textContent = p.uid || "—";
  $("#set-disp-created").textContent = new Date(p.createdAt).toLocaleDateString();
  $("#set-disp-plan").textContent = p.plan || "free";
  $("#set-name").value = p.name || "";
  $("#set-telegram").value = p.telegram || "";
}

/* ---------- Wire up ---------- */
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

  // Nav links
  document.querySelectorAll(".nav-link").forEach(link => {
    link.onclick = async (e) => {
      e.preventDefault();
      const section = link.getAttribute("data-section");
      if (section === "messaging") {
        const p = await getProfile(currentUser);
        if (p) {
          window.__profile = p;
          await mergeTokenMeta(p);
          renderMessagingDashboard();
        }
        showSection("messaging");
      } else if (section === "security-alerts") {
        const p = await getProfile(currentUser);
        if (p) {
          window.__profile = p;
          await mergeTokenMeta(p);
          renderSecurityAlerts(p);
        }
        showSection("security-alerts");
      } else if (section === "settings") {
        const p = await getProfile(currentUser);
        if (p) {
          window.__profile = p;
          renderSettings(p);
        }
        showSection("settings");
      } else {
        showLanding();
      }
    };
  });

  // Guest nav buttons
  $("#nav-login-btn").onclick = (e) => { e.preventDefault(); showLogin(); };
  $("#nav-signup-btn").onclick = (e) => { e.preventDefault(); showSignup(); };

  // Landing page handlers
  $("#auth-submit").onclick = (e) => { e.preventDefault(); showSignup(); };

  document.querySelectorAll(".goto-login").forEach(el => {
    el.onclick = (e) => { e.preventDefault(); showLogin(); };
  });

  document.querySelectorAll(".goto-signup").forEach(el => {
    el.onclick = (e) => { e.preventDefault(); showSignup(); };
  });

  // Google on landing goes to signup flow
  $("#auth-google").onclick = async () => {
    if (!(await verifyRecaptcha($("#auth-google")))) return;
    await withLoading($("#auth-google"), "Connecting…", async () => {
      try {
        const u = await signInWithGoogle();
        await onLogin(u);
      } catch (e) {
        toast(friendlyError(e));
      }
    });
  };

  // Standalone login form
  $("#login-submit").onclick = async () => {
    const email = $("#login-email").value.trim();
    const pass = $("#login-pass").value;
    if (!email || !pass) return toast("Enter email and password");
    if (!(await verifyRecaptcha($("#login-submit")))) return;
    await withLoading($("#login-submit"), "Signing in…", async () => {
      try {
        const u = await signIn(email, pass);
        await onLogin(u);
      } catch (e) {
        toast(friendlyError(e));
      }
    });
  };

  // Standalone signup form
  $("#signup-submit").onclick = async () => {
    const name = $("#signup-name").value.trim();
    const tg = $("#signup-tg").value.trim();
    const email = $("#signup-email").value.trim();
    const pass = $("#signup-pass").value;
    const pass2 = $("#signup-pass2").value;
    if (!name) return toast("Enter your full name");
    if (!email || !pass) return toast("Enter email and password");
    if (pass.length < 6) return toast("Password must be at least 6 characters");
    if (pass !== pass2) return toast("Passwords do not match");
    if (!(await verifyRecaptcha($("#signup-submit")))) return;
    await withLoading($("#signup-submit"), "Creating account…", async () => {
      try {
        const u = await signUp(email, pass, name, tg);
        await onLogin(u);
      } catch (e) {
        toast(friendlyError(e));
      }
    });
  };

  // Google signup
  $("#signup-google").onclick = async () => {
    if (!(await verifyRecaptcha($("#signup-google")))) return;
    await withLoading($("#signup-google"), "Connecting…", async () => {
      try {
        const u = await signInWithGoogle();
        await onLogin(u);
      } catch (e) {
        toast(friendlyError(e));
      }
    });
  };

  // Google login
  $("#login-google").onclick = async () => {
    if (!(await verifyRecaptcha($("#login-google")))) return;
    await withLoading($("#login-google"), "Connecting…", async () => {
      try {
        const u = await signInWithGoogle();
        await onLogin(u);
      } catch (e) {
        toast(friendlyError(e));
      }
    });
  };

  // Google on landing page
  $("#auth-google").onclick = async () => {
    if (!(await verifyRecaptcha($("#auth-google")))) return;
    await withLoading($("#auth-google"), "Connecting…", async () => {
      try {
        const u = await signInWithGoogle();
        await onLogin(u);
      } catch (e) {
        toast(friendlyError(e));
      }
    });
  };

  // Enter-key for auth forms
  ["login-email", "login-pass", "signup-email", "signup-pass", "signup-pass2", "signup-name", "signup-tg"].forEach((id) => {
    const el = $("#" + id);
    if (el) el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        if (id === "login-email" || id === "login-pass") $("#login-submit").click();
        else $("#signup-submit").click();
      }
    });
  });

  // Logout
  $("#logout").onclick = async () => {
    const auth = (window.__fb || {}).auth;
    if (!demoMode() && auth) await signOut(auth);
    currentUser = null;
    window.__profile = null;
    if (window.__metaTimer) clearInterval(window.__metaTimer);
    if (window.__accessCodeTimer) clearInterval(window.__accessCodeTimer);
    hideAllSections();
    updateNavForGuest();
    $("#landing-view").classList.remove("hide");
    toast("Logged out");
  };

  // Messaging dashboard handlers
  $("#msg-tg-check").onclick = async () => {
    const btn = $("#msg-tg-check");
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
        const accessSection = $("#msg-access-code-section");
        if (accessSection) accessSection.classList.add("hide");
        const fresh = await getProfile(currentUser);
        if (fresh) {
          window.__profile = fresh;
          renderMessagingDashboard();
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

  $("#msg-regen-access-code").onclick = async () => {
    await withLoading($("#msg-regen-access-code"), "Refreshing…", async () => {
      const p = await getProfile(currentUser);
      const db = (window.__fb || {}).db;
      if (!db || !p || !p.accessToken) return toast("Access token not ready");
      const code = accessCode();
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
      renderMessagingDashboard();
      toast("New access code generated");
    });
  };

  $("#msg-site-save").onclick = async () => {
    const raw = $("#msg-site-url").value.trim();
    if (!raw) return toast("Enter your website URL");
    if (!isValidSiteUrl(raw)) return toast("Include the full URL, e.g. https://yoursite.com");
    let origin;
    try {
      origin = new URL(raw).origin;
    } catch (_) {
      return toast("Enter a valid URL");
    }
    await withLoading($("#msg-site-save"), "Adding…", async () => {
      const p = await getProfile(currentUser);
      const sites = getSites(p);
      if (sites.some((s) => s.toLowerCase() === origin.toLowerCase())) {
        toast("That site is already registered");
        return;
      }
      sites.push(origin);
      setSites(p, sites);
      await saveProfile(currentUser, p);
      await mirrorSitesToPub(p);
      $("#msg-site-url").value = "";
      window.__profile = p;
      renderMessagingDashboard();
      toast("Site added");
    });
  };

  $("#msg-site-list").addEventListener("click", async (e) => {
    const btn = e.target.closest(".site-remove");
    if (!btn) return;
    const idx = parseInt(btn.getAttribute("data-site-index"), 10);
    if (isNaN(idx)) return;
    const p = await getProfile(currentUser);
    const sites = getSites(p);
    if (idx < 0 || idx >= sites.length) return;
    const removed = sites.splice(idx, 1)[0];
    setSites(p, sites);
    await saveProfile(currentUser, p);
    await mirrorSitesToPub(p);
    window.__profile = p;
    renderMessagingDashboard();
    toast("Removed " + removed);
  });

  $("#msg-copy-key").onclick = () => copy($("#msg-disp-apikey").textContent, $("#msg-copy-key"));
  $("#msg-copy-snippet").onclick = () => copy(window.__lastSnippet || "", $("#msg-copy-snippet"));
  $("#msg-copy-snippet-2").onclick = () => copy(window.__lastSnippet || "", $("#msg-copy-snippet-2"));
  $("#msg-test-msg-btn").onclick = sendTestMessage;
  $("#msg-test-msg-btn-2").onclick = sendTestMessage;

  const refreshFinish = () => {
    const p = currentProfile();
    const ready = p && p.setupComplete ? true
      : ($("#msg-received-check").checked && $("#msg-terms-check").checked);
    $("#msg-finish-setup").disabled = !ready;
  };
  $("#msg-received-check").onchange = refreshFinish;
  $("#msg-terms-check").onchange = refreshFinish;

  $("#msg-finish-setup").onclick = async () => {
    const p = currentProfile() || (await getProfile(currentUser));
    if (!$("#msg-received-check").checked) return toast("Confirm you received the test message");
    if (!$("#msg-terms-check").checked) return toast("Please accept the Terms & Conditions");
    if (!p.termsAcceptedAt) p.termsAcceptedAt = new Date().toISOString();
    p.setupComplete = true;
    await saveProfile(currentUser, p);
    window.__profile = p;
    renderMessagingDashboard();
    toast("Setup complete — you're all set!");
  };

  // Terms modal for messaging
  const openTerms = () => $("#terms-modal").classList.remove("hide");
  const closeTerms = () => $("#terms-modal").classList.add("hide");
  $("#msg-terms-open").onclick = (e) => { e.preventDefault(); openTerms(); };
  $("#terms-close").onclick = closeTerms;
  $("#terms-modal").addEventListener("click", (e) => {
    if (e.target === $("#terms-modal")) closeTerms();
  });
  $("#terms-accept").onclick = () => {
    const p = currentProfile();
    if (p) p.termsAcceptedAt = new Date().toISOString();
    $("#msg-terms-check").checked = true;
    closeTerms();
    refreshFinish();
    toast("Terms accepted");
  };

  $("#msg-edit-settings").onclick = () => {
    const p = currentProfile();
    if (p) { p.setupComplete = false; saveProfile(currentUser, p); }
    window.__profile = p;
    renderMessagingDashboard();
  };

  $("#msg-regen").onclick = async () => {
    const ok = confirm(
      "Regenerating your access token will break any install snippet already live on a site until you update it there too. Continue?"
    );
    if (!ok) return;
    await withLoading($("#msg-regen"), "Regenerating…", async () => {
      const p = await getProfile(currentUser);
      const oldToken = p.accessToken;
      const newToken = accessToken();
      p.accessToken = newToken;
      await saveProfile(currentUser, p);

      const db = (window.__fb || {}).db;
      if (db) {
        p.telegram = (p.telegram || "").replace(/^@/, "").trim().toLowerCase();
        await set(ref(db, "pub/" + newToken + "/telegram"), p.telegram);
        await set(ref(db, "pub/" + newToken + "/telegram_chat_id"), p.telegram_chat_id || "");
        await set(ref(db, "pub/" + newToken + "/uid"), p.uid);
        await mirrorSitesToPub(p);
        try {
          await set(ref(db, "pub/" + newToken + "/meta"), {
            blocked: false,
            exposedChances: 0
          });
        } catch (_) {}
        if (oldToken && oldToken !== newToken) {
          try {
            await set(ref(db, "pub/" + oldToken + "/telegram"), null);
            await set(ref(db, "pub/" + oldToken + "/telegram_chat_id"), null);
            await set(ref(db, "pub/" + oldToken + "/uid"), null);
            await set(ref(db, "pub/" + oldToken + "/siteUrl"), null);
            await set(ref(db, "pub/" + oldToken + "/siteUrls"), null);
            await set(ref(db, "pub/" + oldToken + "/meta"), { blocked: true, exposedChances: 3 });
          } catch (_) {}
        }
      }

      p.blocked = false;
      p.exposedChances = 0;
      await saveProfile(currentUser, p);
      window.__profile = p;
      renderMessagingDashboard();
      toast("New access token generated — update your install snippet");
    });
  };

  // Settings handlers
  $("#set-save-profile").onclick = async () => {
    await withLoading($("#set-save-profile"), "Saving…", async () => {
      const p = await getProfile(currentUser);
      const name = $("#set-name").value.trim();
      const telegram = $("#set-telegram").value.trim();
      if (!name) return toast("Enter your name");
      p.name = name;
      p.telegram = (telegram || "").replace(/^@/, "").trim().toLowerCase();
      await saveProfile(currentUser, p);
      window.__profile = p;
      renderSettings(p);
      renderMessagingDashboard();
      toast("Profile updated");
    });
  };

  $("#set-delete-account").onclick = async () => {
    const ok = confirm("Are you sure? This will permanently delete your account and all data. This cannot be undone.");
    if (!ok) return;
    await withLoading($("#set-delete-account"), "Deleting…", async () => {
      const auth = (window.__fb || {}).auth;
      const db = (window.__fb || {}).db;
      const p = await getProfile(currentUser);

      // Delete Firebase data
      if (db && p && p.accessToken) {
        try { await remove(ref(db, "pub/" + p.accessToken)); } catch (_) {}
        try { await remove(ref(db, "users/" + p.uid)); } catch (_) {}
        try { await remove(ref(db, "accesscode/")); } catch (_) {}
      }

      // Delete auth user
      if (auth && currentUser) {
        try { await deleteUser(currentUser); } catch (_) {}
      }

      // Clear local storage
      if (demoMode() && p) {
        localStorage.removeItem("tgx_profile_" + p.uid);
        localStorage.removeItem("tgx_user_" + p.uid);
      }

      currentUser = null;
      window.__profile = null;
      if (window.__metaTimer) clearInterval(window.__metaTimer);
      if (window.__accessCodeTimer) clearInterval(window.__accessCodeTimer);
      showLanding();
      toast("Account deleted");
    });
  };

  // Security alerts handlers
  $("#sec-tg-check").onclick = async () => {
    const btn = $("#sec-tg-check");
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
        const accessSection = $("#sec-access-code-section");
        if (accessSection) accessSection.classList.add("hide");
        const fresh = await getProfile(currentUser);
        if (fresh) {
          window.__profile = fresh;
          renderSecurityAlerts(fresh);
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

  $("#sec-regen-access-code").onclick = async () => {
    await withLoading($("#sec-regen-access-code"), "Refreshing…", async () => {
      const p = await getProfile(currentUser);
      const db = (window.__fb || {}).db;
      if (!db || !p || !p.accessToken) return toast("Access token not ready");
      const code = accessCode();
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
      renderSecurityAlerts(p);
      toast("New access code generated");
    });
  };

  $("#sec-issue-apikey-btn").onclick = async () => {
    const p = await getProfile(currentUser);
    if (!p || !p.telegram_chat_id) {
      toast("Please link your Telegram first");
      return;
    }

    await withLoading($("#sec-issue-apikey-btn"), "Sending OTP…", async () => {
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
        renderSecurityAlerts(p);
        toast("OTP sent to your Telegram");
      } catch (e) {
        toast(e.message || "Failed to send OTP");
      }
    });
  };

  $("#sec-verify-otp-btn").onclick = async () => {
    const otpInput = $("#sec-otp-input");
    const otp = otpInput.value.trim();

    if (!otp || !/^\d{6}$/.test(otp)) {
      toast("Enter a valid 6-digit OTP");
      return;
    }

    await withLoading($("#sec-verify-otp-btn"), "Verifying…", async () => {
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

        p.securityApiKey = data.securityApiKey;
        p.securityApiKeyIssued = true;
        await saveProfile(currentUser, p);
        window.__profile = p;

        renderSecurityAlerts(p);
        toast("Security Alerts API key issued successfully!");
      } catch (e) {
        toast(e.message || "OTP verification failed");
      }
    });
  };

  $("#sec-cancel-otp-btn").onclick = () => {
    window.__securityOtpPending = false;
    if (window.__otpTimer) clearInterval(window.__otpTimer);
    window.__otpTimer = null;
    const p = window.__profile;
    if (p) renderSecurityAlerts(p);
  };

  $("#sec-copy-apikey").onclick = () => {
    copy($("#sec-apikey-display").textContent, $("#sec-copy-apikey"));
  };

  $("#sec-copy-snippet").onclick = () => {
    copy($("#sec-snippet").textContent, $("#sec-copy-snippet"));
  };

  $("#sec-copy-example-payload").onclick = () => {
    copy($("#sec-example-payload").textContent, $("#sec-copy-example-payload"));
  };

  $("#sec-send-test-alert").onclick = async () => {
    const p = await getProfile(currentUser);
    if (!p || !p.securityApiKey) {
      toast("Issue a Security Alerts API key first");
      return;
    }

    const alertType = $("#sec-test-alert-type").value;
    const severity = $("#sec-test-severity").value;
    const title = $("#sec-test-title").value.trim() || "Test Alert";
    const message = $("#sec-test-message").value.trim() || "This is a test security alert from TrigifyX.";

    await withLoading($("#sec-send-test-alert"), "Sending…", async () => {
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
        $("#sec-test-title").value = "";
        $("#sec-test-message").value = "";
      } catch (e) {
        toast(e.message || "Failed to send alert");
      }
    });
  };

  $("#sec-regenerate-apikey").onclick = async () => {
    const ok = confirm(
      "Regenerating your Security Alerts API key will break any integrations using the current key. Continue?"
    );
    if (!ok) return;

    await withLoading($("#sec-regenerate-apikey"), "Regenerating…", async () => {
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
        p.securityApiKeyIssued = true;
        await saveProfile(currentUser, p);
        window.__profile = p;
        renderSecurityAlerts(p);
        toast("Security Alerts API key regenerated");
      } catch (e) {
        toast(e.message || "Failed to regenerate API key");
      }
    });
  };

  $("#sec-tg-unlink").onclick = async () => {
    const ok = confirm("Unlink Telegram? You will need to re-link to issue Security Alerts API keys.");
    if (!ok) return;

    await withLoading($("#sec-tg-unlink"), "Unlinking…", async () => {
      try {
        const p = await getProfile(currentUser);
        p.telegram_chat_id = "";
        p.telegram = "";
        await saveProfile(currentUser, p);
        window.__profile = p;
        renderSecurityAlerts(p);
        toast("Telegram unlinked");
      } catch (e) {
        toast("Failed to unlink Telegram");
      }
    });
  };
}

/* ---------- Helpers ---------- */
function currentProfile() {
  return window.__profile || null;
}

function switchTab(mode) {
  const authMode = $("#auth-mode");
  if (authMode) authMode.value = mode;
  const tabSignup = $("#tab-signup");
  const tabSignin = $("#tab-signin");
  if (!tabSignup && !tabSignin) return;
  const up = mode === "up";
  if (tabSignup) tabSignup.classList.toggle("active", up);
  if (tabSignin) tabSignin.classList.toggle("active", !up);
  const authTitle = $("#auth-title");
  if (authTitle) authTitle.textContent = up ? "Create your TrigifyX account" : "Welcome back to TrigifyX";
  const authSubmit = $("#auth-submit");
  if (authSubmit) authSubmit.textContent = up ? "Sign up" : "Sign in";
  const signupOnly = $("#signup-only");
  const signupOnly2 = $("#signup-only-2");
  const show = up ? "remove" : "add";
  if (signupOnly) signupOnly.classList[show]("hide");
  if (signupOnly2) signupOnly2.classList[show]("hide");
  if (!up) {
    const authName = $("#auth-name");
    const authTg = $("#auth-tg");
    const authPass2 = $("#auth-pass2");
    if (authName) authName.value = "";
    if (authTg) authTg.value = "";
    if (authPass2) authPass2.value = "";
  }
}

async function onLogin(u) {
  currentUser = u;
  let p = await getProfile(u);
  if (!p) {
    p = {
      uid: u.uid, email: u.email, apiKey: apiKey(), telegram: "",
      createdAt: Date.now(), plan: "free", apiKeyIssued: true, siteUrl: ""
    };
    await saveProfile(u, p);
  }

  let needsSave = false;
  if (!p.accessToken) { p.accessToken = accessToken(); needsSave = true; }
  if (!p.apiKeyIssued) { p.apiKeyIssued = true; needsSave = true; }
  if (typeof p.siteUrl === "undefined") { p.siteUrl = ""; needsSave = true; }
  if (!Array.isArray(p.siteUrls)) {
    p.siteUrls = p.siteUrl ? [p.siteUrl] : [];
    needsSave = true;
  }
  if (typeof p.testMessageCount === "undefined") { p.testMessageCount = 0; needsSave = true; }
  if (typeof p.setupComplete === "undefined") { p.setupComplete = false; needsSave = true; }
  if (typeof p.termsAcceptedAt === "undefined") { p.termsAcceptedAt = null; needsSave = true; }
  if (typeof p.blocked === "undefined") { p.blocked = false; needsSave = true; }
  if (typeof p.exposedChances === "undefined") { p.exposedChances = 0; needsSave = true; }
  if (typeof p.submissionCount === "undefined") { p.submissionCount = 0; needsSave = true; }
  if (typeof p.lastSubmissionAt === "undefined") { p.lastSubmissionAt = null; needsSave = true; }
  if (typeof p.securityApiKey === "undefined") { p.securityApiKey = ""; needsSave = true; }
  if (typeof p.securityApiKeyIssued === "undefined") { p.securityApiKeyIssued = false; needsSave = true; }
  if (typeof p.telegram_chat_id === "undefined") { p.telegram_chat_id = ""; needsSave = true; }
  if (needsSave) await saveProfile(u, p);

  window.__profile = p;

  await mergeTokenMeta(p);

  const db = (window.__fb || {}).db;
  if (db) {
    if (p && p.accessToken) {
      p.telegram = (p.telegram || "").replace(/^@/, "").trim().toLowerCase();
      await set(ref(db, "pub/" + p.accessToken + "/telegram"), p.telegram);
      await set(ref(db, "pub/" + p.accessToken + "/telegram_chat_id"), p.telegram_chat_id || "");
      await set(ref(db, "pub/" + p.accessToken + "/uid"), p.uid);
      await mirrorSitesToPub(p);
    }
    await mirrorSitesToPub(p);
  }

  if (window.__metaTimer) clearInterval(window.__metaTimer);
  window.__metaTimer = setInterval(async () => {
    if (!currentUser) return;
    const fresh = currentProfile();
    if (!fresh) return;
    await mergeTokenMeta(fresh);
    renderMessagingDashboard();
  }, 8000);

  if (db && p.accessToken) {
    const code = accessCode();
    p._accessCode = code;
    p._accessCodeExpiresAt = Date.now() + 5 * 60 * 1000;
    try {
      await set(ref(db, "accesscode/" + code), {
        token: p.accessToken,
        ttl: Date.now(),
        expiresAt: p._accessCodeExpiresAt,
      });
    } catch (_) {}
  }

  const missing = !p.name || !p.telegram;
  if (missing) {
    showProfileComplete(u, p);
    return;
  }

  showApp();
}

function showProfileComplete(u, p) {
  showSection("complete");
  $("#complete-email").textContent = u.email || p.email || "—";
  $("#complete-name").value = p.name || (u.displayName || "");
  $("#complete-tg").value = p.telegram || "";
  $("#complete-save").onclick = async () => {
    const name = $("#complete-name").value.trim();
    const tg = $("#complete-tg").value.trim();
    if (!name) return toast("Please enter your full name");
    if (!tg) return toast("Please enter your Telegram username or chat id");
    await withLoading($("#complete-save"), "Saving…", async () => {
      p.name = name;
      p.telegram = (tg || "").replace(/^@/, "").trim().toLowerCase();
      await saveProfile(u, p);
      window.__profile = p;
      showApp();
      toast("Profile complete!");
    });
  };
}

/* ---------- Boot ---------- */
let booted = false;
function boot() {
  if (booted) return;
  booted = true;
  try {
    bindUI();
  } catch (e) {
    console.error("[app] bindUI failed:", e);
  }

  const auth = (window.__fb || {}).auth;
  if (!demoMode() && auth) {
    onAuthStateChanged(auth, async (u) => {
      if (u) await onLogin(u);
      else showLanding();
    });
  } else {
    showLanding();
  }
}

if ((window.__fb || {}).auth) {
  boot();
} else {
  window.addEventListener("fb-ready", boot);
  setTimeout(() => {
    if ((window.__fb || {}).auth) boot();
  }, 1500);
}