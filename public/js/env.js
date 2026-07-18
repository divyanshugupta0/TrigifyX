/* TrigifyX — environment bootstrap.
 *
 * Firebase config is provided by /js/firebase-init.js (a module that sets
 * window.__fb and window.__ENV__.firebase from your real config).
 *
 * The app itself decides demo mode in app.js: if window.__fb / Realtime
 * Database is unavailable, it falls back to localStorage so the UI stays
 * fully usable. No secrets are needed here.
 */
(function () {
  // Optional: if you prefer a separate config.js (gitignored) instead of
  // hardcoding in firebase-init.js, it can set window.__ENV__ here.
  window.__ENV__ = window.__ENV__ || {};
})();
