/* ==========================================================================
 * TrigifyX Capture Script
 * Version: 3.0
 * Author: TrigifyX
 *
 * Secure frontend capture library.
 * - No Telegram Bot Token in browser
 * - Offline Queue
 * - Automatic Retry
 * - Duplicate Prevention
 * - Dynamic Form Detection
 * ========================================================================== */

(function () {
    "use strict";

    /* -------------------------------------------------------
       Configuration
    ------------------------------------------------------- */

    const cfg = window.TRIGIFYX || {};
    const ENV = window.__ENV__ || {};

    const ACCESS_TOKEN = cfg.accessToken || "";
    const API_BASE = (cfg.endpoint || ENV.apiBase || "").replace(/\/$/, "");

    if (!ACCESS_TOKEN) {
        console.warn("[TrigifyX] Missing accessToken.");
        return;
    }

    if (!API_BASE) {
        console.warn("[TrigifyX] Missing endpoint.");
        return;
    }

    /* -------------------------------------------------------
       Storage Keys
    ------------------------------------------------------- */

    const STORAGE = {
        QUEUE: "trigifyx_queue_v2",
        SENT: "trigifyx_sent_v2"
    };

    /* -------------------------------------------------------
       Runtime State
    ------------------------------------------------------- */

    const inFlight = new Set();
    const recent = new Set();

    /* -------------------------------------------------------
       Local Storage Helpers
    ------------------------------------------------------- */

    function read(key, fallback) {
        try {
            const value = localStorage.getItem(key);
            return value ? JSON.parse(value) : fallback;
        } catch {
            return fallback;
        }
    }

    function write(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (_) {}
    }

    /* -------------------------------------------------------
       Queue Helpers
    ------------------------------------------------------- */

    function getQueue() {
        return read(STORAGE.QUEUE, []);
    }

    function saveQueue(queue) {
        write(STORAGE.QUEUE, queue);
    }

    function enqueue(item) {
        const queue = getQueue();

        const exists = queue.some(q => q.id === item.id);

        if (!exists) {
            queue.push(item);
            saveQueue(queue);
        }
    }

    function dequeue(id) {
        const queue = getQueue().filter(x => x.id !== id);
        saveQueue(queue);
    }

    /* -------------------------------------------------------
       Delivered Signatures
    ------------------------------------------------------- */

    function delivered() {
        return read(STORAGE.SENT, {});
    }

    function alreadyDelivered(signature) {
        return !!delivered()[signature];
    }

    function markDelivered(signature) {

        const map = delivered();

        map[signature] = Date.now();

        const keys = Object.keys(map);

        if (keys.length > 300) {

            keys.sort((a, b) => map[a] - map[b]);

            while (keys.length > 300) {
                delete map[keys.shift()];
            }
        }

        write(STORAGE.SENT, map);
    }

    /* -------------------------------------------------------
       Form Data Collection
    ------------------------------------------------------- */

    function collect(form) {

        const data = {};

        const elements = form.querySelectorAll(
            "input,textarea,select"
        );

        elements.forEach(el => {

            if (el.disabled)
                return;

            if (
                el.type === "submit" ||
                el.type === "button" ||
                el.type === "reset"
            )
                return;

            if (el.type === "password")
                return;

            const name =
                el.name ||
                el.id ||
                null;

            if (!name)
                return;

            if (
                el.type === "checkbox" ||
                el.type === "radio"
            ) {

                if (!el.checked)
                    return;

                if (data[name])
                    data[name] += ", " + el.value;
                else
                    data[name] = el.value;

                return;
            }

            const value = (el.value || "").trim();

            if (value !== "")
                data[name] = value;

        });

        return data;
    }

    /* -------------------------------------------------------
       Submission Signature
    ------------------------------------------------------- */

    function signature(fields) {

        return JSON.stringify(fields) +
            "|" +
            location.origin +
            location.pathname;

    }

        /* -------------------------------------------------------
       Send To Worker
    ------------------------------------------------------- */

    async function deliver(item) {

        const response = await fetch(
            API_BASE + "/api/submit",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    accessToken: item.token,
                    fields: item.fields,
                    page: item.page
                })
            }
        );

        if (!response.ok) {
            throw new Error("HTTP " + response.status);
        }

        return response.json();

    }

    /* -------------------------------------------------------
       Retry Delay
    ------------------------------------------------------- */

    function retryDelay(attempt) {

        return Math.min(
            1000 * Math.pow(2, attempt),
            30000
        );

    }

    /* -------------------------------------------------------
       Send One Queue Item
    ------------------------------------------------------- */

    async function sendOne(item, attempt = 0) {

        if (inFlight.has(item.id))
            return;

        if (alreadyDelivered(item.signature)) {

            dequeue(item.id);
            return;

        }

        inFlight.add(item.id);

        try {

            const result = await deliver(item);

            if (!result.ok)
                throw new Error("Worker rejected request");

            dequeue(item.id);

            markDelivered(item.signature);

            recent.delete(item.signature);

            console.log(
                "[TrigifyX] Delivered successfully."
            );

        }
        catch (err) {

            console.warn(
                "[TrigifyX] Delivery failed.",
                err.message
            );

            if (attempt < 5) {

                setTimeout(function () {

                    sendOne(
                        item,
                        attempt + 1
                    );

                }, retryDelay(attempt));

            }
            else {

                console.warn(
                    "[TrigifyX] Item kept in offline queue."
                );

                recent.delete(item.signature);

            }

        }
        finally {

            inFlight.delete(item.id);

        }

    }

    /* -------------------------------------------------------
       Flush Offline Queue
    ------------------------------------------------------- */

    function flushQueue() {

        const queue = getQueue();

        if (!queue.length)
            return;

        console.log(
            "[TrigifyX] Flushing",
            queue.length,
            "queued submissions."
        );

        queue.forEach(item => {

            sendOne(item);

        });

    }

    /* -------------------------------------------------------
       Connectivity Recovery
    ------------------------------------------------------- */

    window.addEventListener(
        "online",
        flushQueue
    );

    document.addEventListener(
        "visibilitychange",
        function () {

            if (!document.hidden)
                flushQueue();

        }
    );

    window.addEventListener(
        "focus",
        flushQueue
    );

        /* -------------------------------------------------------
       Submit Handler
    ------------------------------------------------------- */

    function handleSubmit(form, event) {

        // Don't block the site's normal submission.
        // Queue the data and let the website continue normally.

        const fields = collect(form);

        if (!Object.keys(fields).length)
            return;

        const sig = signature(fields);

        // Already delivered
        if (alreadyDelivered(sig))
            return;

        // Duplicate within current page session
        if (recent.has(sig))
            return;

        recent.add(sig);

        // Remove from memory after a short period
        setTimeout(function () {
            recent.delete(sig);
        }, 5000);

        const item = {
            id:
                Date.now() +
                "_" +
                Math.random()
                    .toString(36)
                    .slice(2, 10),

            token: ACCESS_TOKEN,

            signature: sig,

            fields: fields,

            page: location.href,

            ts: Date.now()
        };

        // Prevent duplicate queue entries
        const queue = getQueue();

        const exists = queue.some(function (q) {
            return q.signature === sig;
        });

        if (!exists) {
            enqueue(item);
        }

        sendOne(item);

        // NOTE:
        // We intentionally DO NOT call:
        //
        // event.preventDefault();
        // event.stopPropagation();
        //
        // This ensures the website's own form
        // continues to work normally.

    }

    /* -------------------------------------------------------
       Attach Form
    ------------------------------------------------------- */

    function attach(form) {

        if (form.__trigifyxAttached)
            return;

        form.__trigifyxAttached = true;

        form.addEventListener(
            "submit",
            function (e) {

                try {

                    handleSubmit(form, e);

                }
                catch (err) {

                    console.warn(
                        "[TrigifyX]",
                        err
                    );

                }

            },
            false
        );

    }

    /* -------------------------------------------------------
       Scan Existing Forms
    ------------------------------------------------------- */

    function scan() {

        const forms =
            document.querySelectorAll("form");

        forms.forEach(function (form) {

            attach(form);

        });

    }


        /* -------------------------------------------------------
       Observe Dynamically Added Forms
    ------------------------------------------------------- */

    function startObserver() {

        if (!window.MutationObserver)
            return;

        const observer = new MutationObserver(function (mutations) {

            mutations.forEach(function (mutation) {

                mutation.addedNodes.forEach(function (node) {

                    if (node.nodeType !== 1)
                        return;

                    // Directly added form
                    if (node.tagName === "FORM") {
                        attach(node);
                        return;
                    }

                    // Forms inside newly added containers
                    if (node.querySelectorAll) {

                        const forms =
                            node.querySelectorAll("form");

                        forms.forEach(function (form) {
                            attach(form);
                        });

                    }

                });

            });

        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });

    }

    /* -------------------------------------------------------
       Initialization
    ------------------------------------------------------- */

    function init() {

        console.log(
            "[TrigifyX] Capture initialized."
        );

        scan();

        flushQueue();

        startObserver();

    }

    /* -------------------------------------------------------
       DOM Ready
    ------------------------------------------------------- */

    if (document.readyState === "loading") {

        document.addEventListener(
            "DOMContentLoaded",
            init
        );

    }
    else {

        init();

    }

})();