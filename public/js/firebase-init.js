// Firebase v9+ modular init. Exposes window.__fb and window.__ENV__.firebase.
// The bot token (TELEGRAM_BOT_TOKEN) is NOT here — it is injected at deploy
// time into window.__ENV__.botToken (e.g. Netlify env var + snippet injection,
// or public/js/env-injected.js). This keeps the source token-free while still
// enabling pure-frontend delivery (no backend server required).
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-analytics.js";

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

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);
let analytics = null;
try { analytics = getAnalytics(app); } catch (e) {}

window.__fb = { app, auth, db, analytics };
window.__ENV__ = window.__ENV__ || {};
window.__ENV__.firebase = firebaseConfig;
window.__ENV__.databaseURL = firebaseConfig.databaseURL;

// Ensure botToken slot exists (populated by env-injected.js / Netlify snippet).
window.__ENV__.botToken = window.__ENV__.botToken || "";

window.dispatchEvent(new Event("fb-ready"));
