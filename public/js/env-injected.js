// AUTO-GENERATED / deploy-injected. Do NOT commit real tokens.
// Netlify: set these as site env vars, then either:
//   - use Netlify "Snippet injection" (post-processing) to insert these lines, or
//   - run `node build-inject-env.js` in the build command, or
//   - paste your values here manually for local testing.
window.__ENV__ = window.__ENV__ || {};

// Backend base URL that delivers submissions to Telegram (the bot token
// lives there, never in the browser). This is the Cloudflare Worker URL.
// The frontend can be hosted on any platform — it just needs to reach this endpoint.
window.__ENV__.apiBase = "https://trigifyx-worker.divyanshugupta415.workers.dev"; // no trailing slash

// Optional: override where the capture script is hosted (defaults to the
// user's own site, relative path).
window.__ENV__.scriptBase = "";

// Deprecated: pure-frontend delivery is replaced by the backend.
window.__ENV__.botToken = "";
