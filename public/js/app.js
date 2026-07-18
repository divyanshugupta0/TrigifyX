  // The capture script is served FROM THE WORKER (no file upload needed).
  // The snippet's <script src> points at <apiBase>/trigifyx-capture.js,
  // and the same apiBase is passed as the endpoint. Users only paste the
  // snippet — they never host any file themselves.
  const ENDPOINT = ENV.apiBase || "";
  const scriptSrc = ENDPOINT
    ? ENDPOINT.replace(/\/$/, "") + "/trigifyx-capture.js"
    : "js/trigifyx-capture.js";

  // SECURITY: the public snippet contains ONLY the per-user access token
  // and the backend endpoint. The Telegram destination (chat id) and the bot
  // token are resolved server-side — never embedded in the page source.
  const token = p.accessToken || "";
  const endpointLine = ENDPOINT ? '\n    endpoint: "' + ENDPOINT + '",' : "";
  const snippet =
`<!-- TrigifyX: paste this before </body> on every page with a form -->
<script>
  window.TRIGIFYX = {
    accessToken: "${token}",${endpointLine}
  };
</script>
<script src="${scriptSrc}" defer></script>`;

  $("#snippet").textContent = snippet;
