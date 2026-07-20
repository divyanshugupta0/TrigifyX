// This file is intentionally a placeholder. Your real Firebase config lives in
// public/js/firebase-init.js (loaded as a module). If you prefer to keep secrets
// here instead, set window.__ENV__.firebase = { apiKey, authDomain, databaseURL,
// projectId, appId } before app.js loads. Do NOT commit real secrets.
window.__ENV__ = window.__ENV__ || {};

// -----------------------------------------------------------------------------
// Firebase App Check — reCAPTCHA v3 SITE KEY
// -----------------------------------------------------------------------------
// Generate this key in the Firebase Console > App Check > (register this web
// app) > reCAPTCHA v3. It is DIFFERENT from a classic reCAPTCHA v2 "checkbox"
// key. The matching secret is managed by Firebase automatically — do not put
// any secret here. The site key is public and safe to ship in the client.
//
// Leave empty to disable App Check (the app still runs). Set it here for a
// committed default, or override it per-deploy in js/env-injected.js.
window.__ENV__.appCheckSiteKey =
  window.__ENV__.appCheckSiteKey || "6Ld5XlwtAAAAAJZ-CxPbmmstAowSUot28_CUXcT3";

// Development only: set to `true` to have the App Check SDK print a debug
// token you can register in the Firebase Console, or to a pre-registered
// debug token string. NEVER enable this in production.
window.__ENV__.appCheckDebug = window.__ENV__.appCheckDebug || false;
