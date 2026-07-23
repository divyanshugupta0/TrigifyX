// Firebase v9+ modular init. Exposes window.__fb and window.__ENV__.firebase.
// The bot token (TELEGRAM_BOT_TOKEN) is NOT here — it is injected at deploy
// time into window.__ENV__.botToken (e.g. Netlify env var + snippet injection,
// or public/js/env-injected.js). This keeps the source token-free while still
// enabling pure-frontend delivery (no backend server required).
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-analytics.js";
import {
  initializeAppCheck,
  ReCaptchaV3Provider,
  getToken as getAppCheckToken
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app-check.js";

const firebaseConfig = {
  apiKey: "AIzaSyCJjM215Zn0_Xp4zAFFjwz9HWCbGV8_Qck",
  authDomain: "trigifyx.firebaseapp.com",
  databaseURL: "https://trigifyx-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "trigifyx",
  storageBucket: "trigifyx.firebasestorage.app",
  messagingSenderId: "451990279059",
  appId: "1:451990279059:web:72ae65b82ed5429ced0e66",
  measurementId: "G-GBMFKM3N98"
};

// Existing Firebase initialization — unchanged. All other services reuse
// this single `app` instance (no duplicate initialization).
const app = initializeApp(firebaseConfig);

window.__ENV__ = window.__ENV__ || {};

// ---------------------------------------------------------------------------
// Firebase App Check (reCAPTCHA v3)
// ---------------------------------------------------------------------------
// App Check attaches an attestation token to every supported Firebase request
// (Realtime Database, Auth, Storage, Functions). Firebase verifies the token
// server-side using the reCAPTCHA secret registered in the Firebase Console —
// we never verify it manually.
//
// The reCAPTCHA v3 SITE KEY is provided via the project's env mechanism
// (window.__ENV__.appCheckSiteKey, set in js/config.js or env-injected.js),
// never hardcoded. IMPORTANT: this must be a reCAPTCHA *v3* key generated on
// the Firebase Console > App Check page — a classic v2 "checkbox" key will not
// work here.
//
// Guards ensure App Check is initialized exactly once, and any failure is
// logged without crashing the app (the UI still loads).
let appCheckInstance = null;
(function initAppCheck() {
  const siteKey = window.__ENV__.appCheckSiteKey || "";
  if (!siteKey) {
    // No key configured yet — skip App Check so the app keeps working.
    console.warn(
      "[AppCheck] Skipped: window.__ENV__.appCheckSiteKey is not set. " +
      "Add your reCAPTCHA v3 site key (from Firebase Console > App Check)."
    );
    return;
  }
  if (window.__fbAppCheckInitialized) return; // never initialize twice
  try {
    // Development-only debug token. In local development, reCAPTCHA v3 often
    // cannot issue a token (unregistered host), which surfaces as
    // appCheck/recaptcha-error. To avoid that locally we enable the App Check
    // DEBUG provider, which bypasses reCAPTCHA and prints a debug token to the
    // console — register that token in Firebase Console > App Check > Manage
    // debug tokens. This is auto-enabled ONLY on localhost/127.0.0.1 (never in
    // production). You can also force it via window.__ENV__.appCheckDebug.
    const host = (self.location && self.location.hostname) || "";
    const isLocalhost =
      host === "localhost" || host === "127.0.0.1" || host === "[::1]";
    const debug = window.__ENV__.appCheckDebug || (isLocalhost ? true : false);
    if (debug) {
      // `true` asks the SDK to print a debug token to register in the console;
      // a string uses a pre-registered debug token.
      self.FIREBASE_APPCHECK_DEBUG_TOKEN = debug;
      console.warn(
        "[AppCheck] DEBUG token mode enabled (local dev). Register the printed " +
        "debug token in Firebase Console > App Check > Manage debug tokens."
      );
    }

    appCheckInstance = initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(siteKey),
      isTokenAutoRefreshEnabled: true // auto-refresh tokens before expiry
    });

    window.__fbAppCheckInitialized = true;
    console.info("[AppCheck] Initialized with reCAPTCHA v3.");
  } catch (e) {
    // Do not crash the app if App Check fails to initialize.
    console.error("[AppCheck] Initialization failed:", e);
  }
})();

const auth = getAuth(app);
const db = getDatabase(app);
let analytics = null;
try { analytics = getAnalytics(app); } catch (e) {}

window.__fb = { app, auth, db, analytics };
window.__fb.appCheckEnabled = !!(window.__ENV__.appCheckSiteKey || "");

// Expose an on-demand App Check token fetch so the UI can show a "Verifying…"
// status when the user submits the auth form. Because reCAPTCHA v3 is
// invisible, this call is what actually runs the reCAPTCHA assessment and
// returns a fresh attestation token. Resolves to the token string, or throws
// if App Check is unavailable / verification fails.
window.__fb.getAppCheckToken = async function (forceRefresh) {
  if (!appCheckInstance) {
    // App Check not initialized (e.g. no site key) — treat as a no-op so the
    // app still works, but signal that no token was produced.
    return null;
  }
  const result = await getAppCheckToken(appCheckInstance, !!forceRefresh);
  return result && result.token ? result.token : null;
};
window.__ENV__.firebase = firebaseConfig;
window.__ENV__.databaseURL = firebaseConfig.databaseURL;

// Ensure botToken slot exists (populated by env-injected.js / Netlify snippet).
window.__ENV__.botToken = window.__ENV__.botToken || "";

window.dispatchEvent(new Event("fb-ready"));
