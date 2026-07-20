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
  ReCaptchaV3Provider
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
    // Development-only debug token. Enabled when a debug flag/token is
    // present in the env; NEVER enable this in production. Set
    // window.__ENV__.appCheckDebug = true (or a specific token string) only
    // for local development against an unenforced project.
    const debug = window.__ENV__.appCheckDebug;
    if (debug) {
      // `true` asks the SDK to print a debug token to register in the console;
      // a string uses a pre-registered debug token.
      self.FIREBASE_APPCHECK_DEBUG_TOKEN = debug;
    }

    initializeAppCheck(app, {
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
window.__ENV__.firebase = firebaseConfig;
window.__ENV__.databaseURL = firebaseConfig.databaseURL;

// Ensure botToken slot exists (populated by env-injected.js / Netlify snippet).
window.__ENV__.botToken = window.__ENV__.botToken || "";

window.dispatchEvent(new Event("fb-ready"));
