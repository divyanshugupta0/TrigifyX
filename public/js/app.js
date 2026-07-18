/* TrigifyX — frontend app (Firebase v9+ modular SDK)
 * Flow:
 *  1. User signs up / logs in (Firebase Auth)
 *  2. On first login we create a profile in Realtime Database with an API key
 *  3. User links their Telegram account (chat id or @username) -> stored in RTDB
 *  4. Site generates an embeddable <script> snippet the user adds to their site
 *  5. The snippet captures form submits and forwards them to TrigifyXbot -> user's Telegram
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
function copy(text) {
  navigator.clipboard.writeText(text).then(() => toast("Copied to clipboard"));
}

/* ---------- Auth ---------- */
async function signUp(email, password, name, telegram) {
  const auth = (window.__fb || {}).auth;
  const db = (window.__fb || {}).db;
  const token = accessToken();
  const profile = {
    uid: "", email, name: name || "", telegram: telegram || "",
    apiKey: apiKey(), accessToken: token, createdAt: Date.now(), plan: "free"
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
    const prof = { uid: u.uid, email: u.email, name: u.name, telegram: "", apiKey: apiKey(), createdAt: Date.now(), plan: "free" };
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

/* ---------- UI rendering ---------- */
function showAuth() {
  $("#auth-view").classList.remove("hide");
  $("#app-view").classList.add("hide");
}
function showApp() {
  $("#auth-view").classList.add("hide");
  $("#app-view").classList.remove("hide");
}

function renderProfile(p) {
  $("#disp-name").textContent = p.name || "—";
  $("#disp-email").textContent = p.email;
  $("#disp-tg").textContent = p.telegram || "—";
  $("#disp-apikey").textContent = p.apiKey;
  $("#tg-input").value = p.telegram || "";
  $("#disp-plan").textContent = p.plan || "free";
  $("#disp-created").textContent = new Date(p.createdAt).toLocaleDateString();

  // API key is hidden until the user issues it.
  const issued = window.__apikeyIssued;
  $("#apikey-locked").classList.toggle("hide", issued);
  $("#apikey-revealed").classList.toggle("hide", !issued);
  $("#issue-key").classList.toggle("hide", issued);

  // Telegram card always shows the instructions + chat id input.
  // (No separate "linked" state — the chat id is editable any time.)
  const linked = !!p.telegram;
  $("#tg-status").className = "badge " + (linked ? "ok" : "warn");
  $("#tg-status").textContent = linked ? "Linked" : "Not Linked";
  $("#tg-input").value = p.telegram || "";

  // Install snippet shows immediately after the key is issued (not later).
  const showInstall = issued;
  $("#install-card").classList.toggle("hide", !showInstall);

  // Pre-fill the saved website URL.
  $("#site-url").value = p.siteUrl || "";

  renderSnippet(p);
}

function renderSnippet(p) {
  // The capture script is served from the user's OWN site by default
  // (relative path), so it works without depending on an external host.
  // The capture script is served from the user's OWN site by default
  // (relative path), so it works without depending on an external host.
  // Override with ENV.scriptBase only if you host it elsewhere.
  const SCRIPT_BASE = ENV.scriptBase || "";
  const scriptSrc = (SCRIPT_BASE.replace(/\/$/, "") + "/js/trigifyx-capture.js").replace(/^\//, "");

  // The backend that actually delivers to Telegram (bot token stays server-side).
  const ENDPOINT = ENV.apiBase || "";

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

/* ---------- Wire up ---------- */
function bindUI() {
  $("#tab-signin").onclick = () => switchTab("in");
  $("#tab-signup").onclick = () => switchTab("up");

  $("#auth-google").onclick = async () => {
    $("#auth-google").disabled = true;
    try {
      const u = await signInWithGoogle();
      await onLogin(u);
    } catch (e) {
      toast(e.message || "Google sign-in failed");
    } finally {
      $("#auth-google").disabled = false;
    }
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
      $("#auth-submit").disabled = true;
      try {
        const u = await signUp(email, pass, name, tg);
        await onLogin(u);
      } catch (e) {
        toast(e.message || "Sign up failed");
      } finally {
        $("#auth-submit").disabled = false;
      }
      return;
    }

    if (!email || !pass) return toast("Enter email and password");
    $("#auth-submit").disabled = true;
    try {
      const u = await signIn(email, pass);
      await onLogin(u);
    } catch (e) {
      toast(e.message || "Auth failed");
    } finally {
      $("#auth-submit").disabled = false;
    }
  };

  $("#logout").onclick = async () => {
    if (!demoMode() && auth) await signOut(auth);
    currentUser = null;
    showAuth();
  };

  $("#tg-save").onclick = async () => {
    const val = $("#tg-input").value.trim();
    if (!val) return toast("Enter your Telegram chat id");
    const p = await getProfile(currentUser);
    p.telegram = val;
    await saveProfile(currentUser, p);
    const db = (window.__fb || {}).db;
    if (db && p.accessToken) {
      // Write only the telegram sub-path (kept separate from other pub data).
      await set(ref(db, "pub/" + p.accessToken + "/telegram"), val);
    }
    renderProfile(p);
    toast("Telegram account linked");
  };

  // Reveal the API key + install snippet (key already exists in RTDB).
  $("#issue-key").onclick = () => {
    window.__apikeyIssued = true;
    renderProfile(currentProfile());
  };

  // Save the user's website URL (no connection check — just stored).
  $("#site-save").onclick = async () => {
    const raw = $("#site-url").value.trim();
    if (!raw) return toast("Enter your website URL");
    const p = await getProfile(currentUser);
    p.siteUrl = raw;
    await saveProfile(currentUser, p);
    renderProfile(p);
    toast("Website saved");
  };

  $("#copy-key").onclick = () => copy($("#disp-apikey").textContent);
  $("#copy-snippet").onclick = () => copy(window.__lastSnippet || "");

  $("#regen").onclick = async () => {
    const p = await getProfile(currentUser);
    p.apiKey = apiKey();
    await saveProfile(currentUser, p);
    renderProfile(p);
    toast("New API key generated");
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
    p = { uid: u.uid, email: u.email, apiKey: apiKey(), telegram: "", createdAt: Date.now(), plan: "free" };
    await saveProfile(u, p);
  }
  window.__profile = p;
  window.__apikeyIssued = false;
  // Backfill access token for users created before tokens existed.
  if (!p.accessToken) {
    p.accessToken = accessToken();
    await saveProfile(u, p);
  }
  // Ensure the public lookup node exists (for the capture script).
  const db = (window.__fb || {}).db;
  if (db) {
    await set(ref(db, "pub/" + p.accessToken + "/telegram"), p.telegram || "");
    await set(ref(db, "pub/" + p.accessToken + "/uid"), p.uid);
  }
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
    p.name = name;
    p.telegram = tg;
    await saveProfile(u, p);
    window.__profile = p;
    $("#complete-view").classList.add("hide");
    $("#disp-uid").textContent = u.uid;
    renderProfile(p);
    showApp();
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
