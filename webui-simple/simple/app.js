/*
 * A plain web page for qBittorrent, made for screen readers first.
 *
 * Three pages, switched by the URL hash:
 *   #/          the torrent list: each torrent's name, what it is doing, and
 *               speeds only while something is moving, under collapsible
 *               group headings (Seeding and Stopped start collapsed)
 *   #/t/<hash>  one torrent: a status sentence, Stop/Start and Remove, the
 *               useful facts, and files, trackers and peers behind disclosures
 *   #/add       add torrents from magnet links, web addresses or files
 *
 * Everything comes from qBittorrent's WebUI API on this origin. Text that
 * comes from torrents and their swarms (names, file names, tracker messages,
 * peer clients) is only ever set with textContent.
 */

"use strict";

(() => {
    /* ---------- settings ---------- */

    // how often the page asks qBittorrent for changes
    const POLL_INTERVAL_MS = 2000;
    // slower retries while qBittorrent can't be reached
    const POLL_RETRY_MS = 5000;
    // one failed poll is usually a laptop waking up; say something after two
    const FAILURES_BEFORE_UNREACHABLE = 2;
    // messages arriving this close together are spoken as one
    const ANNOUNCE_BATCH_MS = 300;
    // the region is emptied before each message so a repeat is still spoken;
    // a clear and a set closer together than this get merged and the repeat
    // stays silent
    const ANNOUNCE_RESET_MS = 150;
    // more events of one kind than this in one update are summarised
    // ("51 torrents have missing files" when the media share drops)
    const ANNOUNCE_MAX_NAMES = 3;
    // and emptied afterwards so stale text doesn't sit at the end of the page
    const ANNOUNCE_CLEAR_MS = 5000;
    const SEARCH_DEBOUNCE_MS = 400;
    // after Stop, Start or Remove, wait this long for qBittorrent to show it
    const ACTION_CONFIRM_TIMEOUT_MS = 10000;
    const ACTION_CONFIRM_POLL_MS = 1000;
    // open disclosures (files, trackers, peers) refresh this often
    const DISCLOSURE_REFRESH_MS = 10000;
    // qBittorrent's eta value for "unknown"
    const ETA_UNKNOWN = 8640000;
    // ratios above this are qBittorrent's stand-in for infinity
    const RATIO_INFINITE = 9999;
    const MAM_TRACKER = /myanonamouse/i;
    const MAM_REQUIRED_SEEDING_HOURS = 72;
    const SECONDS_PER_HOUR = 3600;
    const GROUP_STATE_STORAGE_KEY = "qbtSimple.expandedGroups";

    /* ---------- torrent states ---------- */

    const STATE_WORDS = {
        downloading: "Downloading",
        forcedDL: "Downloading (forced)",
        metaDL: "Getting metadata",
        forcedMetaDL: "Getting metadata (forced)",
        stalledDL: "Stalled",
        queuedDL: "Queued",
        checkingDL: "Checking",
        checkingUP: "Checking",
        checkingResumeData: "Checking",
        moving: "Moving",
        uploading: "Seeding",
        stalledUP: "Seeding",
        forcedUP: "Seeding (forced)",
        queuedUP: "Queued",
        stoppedDL: "Stopped",
        stoppedUP: "Finished",
        // qBittorrent 4 names, should the daemon ever be downgraded
        pausedDL: "Stopped",
        pausedUP: "Finished",
        error: "Error",
        missingFiles: "Files missing",
    };
    const PROBLEM_STATES = new Set(["error", "missingFiles"]);
    const STOPPED_STATES = new Set(["stoppedDL", "stoppedUP", "pausedDL", "pausedUP"]);
    const DOWNLOADING_STATES = new Set(["downloading", "forcedDL", "metaDL", "forcedMetaDL", "stalledDL", "queuedDL", "checkingDL"]);
    const SEEDING_STATES = new Set(["uploading", "stalledUP", "forcedUP", "queuedUP", "checkingUP"]);
    // states in which data is really being fetched: leaving one of these with
    // nothing left is a finished download (a recheck finishing is not)
    const FETCHING_STATES = new Set(["downloading", "forcedDL", "metaDL", "forcedMetaDL", "stalledDL", "queuedDL"]);

    const GROUPS = [
        { id: "problems", title: "Problems", expandedByDefault: true },
        { id: "downloading", title: "Downloading", expandedByDefault: true },
        { id: "seeding", title: "Seeding", expandedByDefault: false },
        { id: "stopped", title: "Stopped", expandedByDefault: false },
    ];

    const TRACKER_STATUS_WORDS = ["disabled", "not contacted yet", "working", "updating", "not working"];

    const stateWord = (state) => STATE_WORDS[state] ?? "Unknown";

    const FINISHED_STATES = new Set([...SEEDING_STATES, "stoppedUP", "pausedUP"]);
    const UNFINISHED_STATES = new Set([...DOWNLOADING_STATES, "stoppedDL", "pausedDL"]);

    // what each torrent's state last said about it being finished, for the
    // states that don't say (checkingResumeData on every start, moving)
    const lastKnownFinished = new Map();

    /**
     * Whether the download is finished. Decided by state, as qBittorrent's own
     * interface does: while a torrent is being checked its progress is the
     * check's progress, not the download's.
     */
    const isFinished = (torrent) => {
        if (FINISHED_STATES.has(torrent.state))
            return true;
        if (UNFINISHED_STATES.has(torrent.state))
            return false;
        return lastKnownFinished.get(torrent.hash) ?? (torrent.completion_on > 0);
    };

    const isStopped = (torrent) => STOPPED_STATES.has(torrent.state);

    // the button next to Remove: what it says and does for this state.
    // qBittorrent reports errors and missing files ahead of "stopped", and
    // start clears the error / reloads the files, so a problem offers Try again.
    // Moving and checkingResumeData hide whether it's running: no button.
    const toggleActionFor = (torrent) => {
        if (PROBLEM_STATES.has(torrent.state))
            return { label: "Try again", endpoint: "api/v2/torrents/start", done: (info) => (info !== null) && !PROBLEM_STATES.has(info.state), success: "Retried", failure: "is still in trouble", checked: "recovered" };
        if ((torrent.state === "moving") || (torrent.state === "checkingResumeData"))
            return null;
        if (isStopped(torrent))
            return { label: "Start", endpoint: "api/v2/torrents/start", done: (info) => (info !== null) && !isStopped(info), success: "Started", failure: "didn't start", checked: "started" };
        return { label: "Stop", endpoint: "api/v2/torrents/stop", done: (info) => (info !== null) && isStopped(info), success: "Stopped", failure: "didn't stop", checked: "stopped" };
    };

    const isChecking = (torrent) => String(torrent.state).startsWith("checking");

    /** Which list heading a torrent belongs under. */
    const groupOf = (torrent) => {
        if (PROBLEM_STATES.has(torrent.state))
            return "problems";
        if (STOPPED_STATES.has(torrent.state))
            return "stopped";
        return isFinished(torrent) ? "seeding" : "downloading";
    };

    /* ---------- formatting ---------- */

    const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];
    // no seconds: a value read on a page that refreshes every 2 s would change
    // under the reading cursor all the time
    const DURATION_UNITS = [["day", 86400], ["hour", 3600], ["minute", 60]];
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

    const formatSize = (bytes) => {
        if (!Number.isFinite(bytes) || (bytes < 0))
            return "unknown";
        let value = bytes;
        let unit = 0;
        while ((value >= 1024) && (unit < (SIZE_UNITS.length - 1))) {
            value /= 1024;
            ++unit;
        }
        const digits = ((unit === 0) || (value >= 100)) ? 0 : 1;
        return `${value.toFixed(digits)} ${SIZE_UNITS[unit]}`;
    };

    const formatSpeed = (bytesPerSecond) => `${formatSize(bytesPerSecond)}/s`;

    const plural = (count, noun) => `${count} ${noun}${(count === 1) ? "" : "s"}`;

    /** The largest unit and the one right below it: "2 days 4 hours", "12 minutes". */
    const formatDuration = (seconds) => {
        if (!Number.isFinite(seconds) || (seconds < 60))
            return "less than a minute";
        const total = Math.floor(seconds);
        const index = DURATION_UNITS.findIndex(([, size]) => total >= size);
        const [name, size] = DURATION_UNITS[index];
        const first = Math.floor(total / size);
        const parts = [plural(first, name)];
        const next = DURATION_UNITS[index + 1];
        if (next !== undefined) {
            const second = Math.floor((total - (first * size)) / next[1]);
            if (second > 0)
                parts.push(plural(second, next[0]));
        }
        return parts.join(" ");
    };

    const formatDate = (epochSeconds) => new Date(epochSeconds * 1000)
        .toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

    const hostOf = (url) => {
        try {
            return new URL(url).hostname || url;
        }
        catch {
            return url;
        }
    };

    /** Speeds worth saying: only directions where something is moving. */
    const speedParts = (torrent) => {
        const parts = [];
        if (torrent.dlspeed > 0)
            parts.push(`${formatSpeed(torrent.dlspeed)} down`);
        if (torrent.upspeed > 0)
            parts.push(`${formatSpeed(torrent.upspeed)} up`);
        return parts;
    };

    /** What follows the name on the list: state, then any moving speeds. */
    const listLineText = (torrent) => [stateWord(torrent.state), ...speedParts(torrent)].map((part) => `, ${part}`).join("");

    /** The sentence at the top of a torrent's page. */
    const statusSentence = (torrent) => {
        const parts = [stateWord(torrent.state)];
        const percent = Math.floor((torrent.progress ?? 0) * 100);
        if (isChecking(torrent))
            parts.push(`${percent}% checked`);
        else if (!isFinished(torrent))
            parts.push(`${percent}% done`);
        parts.push(...speedParts(torrent));
        if (DOWNLOADING_STATES.has(torrent.state) && (torrent.eta > 0) && (torrent.eta < ETA_UNKNOWN))
            parts.push(`about ${formatDuration(torrent.eta)} left`);
        return `${parts.join(", ")}.`;
    };

    /** Label/value pairs for a torrent's page; empty or placeholder values are left out. */
    const factsOf = (torrent) => {
        const facts = [["Size", formatSize(torrent.size)]];
        facts.push(["Downloaded", formatSize(torrent.downloaded)]);
        facts.push(["Uploaded", formatSize(torrent.uploaded)]);
        if (Number.isFinite(torrent.ratio))
            facts.push(["Ratio", (torrent.ratio >= RATIO_INFINITE) ? "infinite" : torrent.ratio.toFixed(2)]);
        facts.push(["Connected to", `${plural(torrent.num_seeds ?? 0, "seed")} and ${plural(torrent.num_leechs ?? 0, "peer")}`]);
        if (torrent.added_on > 0)
            facts.push(["Added", formatDate(torrent.added_on)]);
        if (torrent.completion_on > 0)
            facts.push(["Finished", formatDate(torrent.completion_on)]);
        if (torrent.seeding_time > 0)
            facts.push(["Seeded for", formatDuration(torrent.seeding_time)]);
        if (torrent.category)
            facts.push(["Category", torrent.category]);
        if (torrent.tags)
            facts.push(["Tags", torrent.tags]);
        if (torrent.tracker)
            facts.push(["Tracker", hostOf(torrent.tracker)]);
        if (torrent.save_path)
            facts.push(["Saved in", torrent.save_path]);
        return facts;
    };

    /* ---------- DOM helpers ---------- */

    /** Create an element; string children become text nodes, never markup. */
    const el = (tag, attributes = {}, ...children) => {
        const element = document.createElement(tag);
        for (const [name, value] of Object.entries(attributes)) {
            if (value === false || value === null || value === undefined)
                continue;
            if (name === "text")
                element.textContent = value;
            else if (name.startsWith("on"))
                element.addEventListener(name.slice(2), value);
            else if (value === true)
                element.setAttribute(name, "");
            else
                element.setAttribute(name, value);
        }
        for (const child of children) {
            if (child !== null && child !== undefined)
                element.append(child);
        }
        return element;
    };

    /** Only touch the DOM when the text really changed. */
    const setText = (element, text) => {
        if (element.textContent !== text)
            element.textContent = text;
    };

    const main = document.getElementById("main");

    const focusHeading = (heading) => {
        heading.focus();
    };

    // true while the page that started some async work is still showing
    // (router is defined further down; this only runs after start-up)
    const stillOn = (generation) => router.generation === generation;

    /* ---------- announcements ---------- */

    // One persistent, visually hidden status region (index.html). Only
    // discrete events go through it: finished downloads, new problems,
    // connection changes and the results of the user's own actions.
    const announcer = (() => {
        const region = document.getElementById("announcer");
        let pending = [];
        // a message waiting out the gap between clearing and writing
        let writing = null;
        let batchTimer = -1;
        let resetTimer = -1;
        let clearTimer = -1;

        const flush = () => {
            const message = pending.join(". ");
            pending = [];
            writing = message;
            window.clearTimeout(clearTimer);
            region.textContent = "";
            resetTimer = window.setTimeout(() => {
                region.textContent = message;
                writing = null;
                clearTimer = window.setTimeout(() => {
                    region.textContent = "";
                }, ANNOUNCE_CLEAR_MS);
            }, ANNOUNCE_RESET_MS);
        };

        return {
            say(message) {
                if (!message)
                    return;
                if (writing !== null) {
                    // put the not-yet-written message back in front
                    window.clearTimeout(resetTimer);
                    pending.unshift(writing);
                    writing = null;
                }
                pending.push(message);
                window.clearTimeout(batchTimer);
                batchTimer = window.setTimeout(flush, ANNOUNCE_BATCH_MS);
            },
        };
    })();

    /* ---------- talking to qBittorrent ---------- */

    class SignedOutError extends Error {}

    class ApiError extends Error {
        constructor(status, text) {
            super(text ? `qBittorrent said: ${text}` : `qBittorrent answered with error ${status}`);
            this.status = status;
        }
    }

    class UnreachableError extends Error {}

    // fetch() follows the sign-in redirect to another site and then fails
    // exactly like a network outage; asking for redirects to be handed back
    // lets an expired sign-in be told apart from qBittorrent being down.
    // Signed out: a redirect, 401, 403, or a success that is really the
    // sign-in page. Any 5xx (the tunnel or the proxy can't get through,
    // usually with an HTML error page) is an outage, not a sign-out.
    const apiFetch = async (path, options = {}) => {
        let response;
        try {
            response = await fetch(path, { cache: "no-store", credentials: "same-origin", redirect: "manual", ...options });
        }
        catch {
            throw new UnreachableError("Can't reach qBittorrent");
        }
        const type = response.headers.get("content-type") ?? "";
        if ((response.type === "opaqueredirect") || (response.status === 401) || (response.status === 403))
            throw new SignedOutError();
        if (response.status >= 500)
            throw new UnreachableError(`Can't reach qBittorrent (error ${response.status})`);
        if (response.ok && type.includes("text/html"))
            throw new SignedOutError();
        return response;
    };

    const apiJson = async (path) => {
        const response = await apiFetch(path);
        if (!response.ok)
            throw new ApiError(response.status, (await response.text()).trim());
        return response.json();
    };

    const apiPost = async (path, params) => {
        const response = await apiFetch(path, { method: "POST", body: params });
        if (!response.ok)
            throw new ApiError(response.status, (await response.text()).trim());
        return response;
    };

    /* ---------- data ---------- */

    const store = {
        torrents: new Map(), // hash -> merged torrent record (with .hash)
        categories: new Map(),
        server: {},
        rid: 0,
        loaded: false,
        // torrents seen fetching data with some left to get; the next time
        // one shows up finished, that's a completed download
        fetching: new Set(),
    };

    /**
     * Merge a sync/maindata response and return the announcements it calls
     * for. Changes are judged against this page's own previous record of each
     * torrent, so a full update (which every response becomes when another
     * tab shares the session) still announces correctly.
     */
    const applyMaindata = (json, announceChanges) => {
        const previous = new Map();
        for (const [hash, torrent] of store.torrents)
            previous.set(hash, { state: torrent.state });

        if (json.full_update) {
            store.torrents.clear();
            store.categories.clear();
        }
        for (const [hash, partial] of Object.entries(json.torrents ?? {})) {
            const current = store.torrents.get(hash) ?? { hash };
            store.torrents.set(hash, Object.assign(current, partial, { hash }));
        }
        for (const hash of json.torrents_removed ?? [])
            store.torrents.delete(hash);
        for (const [name, category] of Object.entries(json.categories ?? {}))
            store.categories.set(name, category);
        for (const name of json.categories_removed ?? [])
            store.categories.delete(name);
        Object.assign(store.server, json.server_state ?? {});
        if (Number.isFinite(json.rid))
            store.rid = json.rid;

        const finished = [];
        const errored = [];
        const missing = [];
        for (const torrent of store.torrents.values()) {
            if (FINISHED_STATES.has(torrent.state))
                lastKnownFinished.set(torrent.hash, true);
            else if (UNFINISHED_STATES.has(torrent.state))
                lastKnownFinished.set(torrent.hash, false);

            if (FETCHING_STATES.has(torrent.state) && (torrent.amount_left > 0)) {
                store.fetching.add(torrent.hash);
            }
            else if (store.fetching.has(torrent.hash) && FINISHED_STATES.has(torrent.state) && (torrent.amount_left === 0)) {
                // reached through a recheck-on-completion too; a seed that is
                // only ever seen checking never got the flag
                store.fetching.delete(torrent.hash);
                finished.push(String(torrent.name));
            }

            const before = previous.get(torrent.hash);
            if ((before !== undefined) && !PROBLEM_STATES.has(before.state) && PROBLEM_STATES.has(torrent.state))
                ((torrent.state === "missingFiles") ? missing : errored).push(String(torrent.name));
        }
        for (const hash of [...store.fetching]) {
            if (!store.torrents.has(hash))
                store.fetching.delete(hash);
        }
        for (const hash of [...lastKnownFinished.keys()]) {
            if (!store.torrents.has(hash))
                lastKnownFinished.delete(hash);
        }

        if (!announceChanges)
            return [];
        const summarise = (names, one, many) => {
            if (names.length === 0)
                return [];
            if (names.length > ANNOUNCE_MAX_NAMES)
                return [many(names.length)];
            return names.map(one);
        };
        return [
            ...summarise(finished, (name) => `Finished downloading ${name}`, (count) => `${count} torrents finished downloading`),
            ...summarise(errored, (name) => `${name} has an error`, (count) => `${count} torrents have errors`),
            ...summarise(missing, (name) => `${name}: files missing`, (count) => `${count} torrents have missing files`),
        ];
    };

    /* ---------- connection banner ---------- */

    const banner = (() => {
        const element = document.getElementById("banner");
        return {
            show(...children) {
                element.replaceChildren(...children);
                element.hidden = false;
            },
            clear() {
                element.hidden = true;
                element.replaceChildren();
            },
        };
    })();

    const showSignedOut = () => {
        if (poller.signedOut)
            return;
        poller.signedOut = true;
        banner.show(
            el("span", { text: "You're signed out. " }),
            el("button", { type: "button", text: "Reload to sign in", onclick: () => window.location.reload() }));
        announcer.say("You're signed out. Reload the page to sign in.");
    };

    /* ---------- live updates ---------- */

    const poller = {
        timer: -1,
        paused: false,
        failures: 0,
        signedOut: false,
        inFlight: false,

        schedule(delay) {
            window.clearTimeout(this.timer);
            if (this.paused || this.signedOut)
                return;
            this.timer = window.setTimeout(() => this.poll(), delay);
        },

        async poll() {
            if (this.inFlight || this.signedOut || this.paused || document.hidden)
                return;
            this.inFlight = true;
            try {
                const json = await apiJson(`api/v2/sync/maindata?rid=${store.rid}`);
                const reconnected = this.failures >= FAILURES_BEFORE_UNREACHABLE;
                // nothing is announced for what was already true when the page
                // loaded; what happened during an outage is said as such
                const events = applyMaindata(json, store.loaded);
                this.failures = 0;
                store.loaded = true;
                if (reconnected) {
                    banner.clear();
                    announcer.say("Connected to qBittorrent again");
                    if (events.length > 0)
                        announcer.say(`While qBittorrent was unreachable: ${events.join(", ")}`);
                }
                else {
                    for (const event of events)
                        announcer.say(event);
                }
                router.update();
                this.schedule(POLL_INTERVAL_MS);
            }
            catch (error) {
                if (error instanceof SignedOutError) {
                    showSignedOut();
                }
                else {
                    ++this.failures;
                    if (this.failures === FAILURES_BEFORE_UNREACHABLE) {
                        banner.show(el("span", { text: "Can't reach qBittorrent. Trying again every few seconds." }));
                        announcer.say("Can't reach qBittorrent");
                    }
                    this.schedule(POLL_RETRY_MS);
                }
            }
            finally {
                this.inFlight = false;
            }
        },

        setPaused(paused) {
            this.paused = paused;
            if (paused)
                window.clearTimeout(this.timer);
            else
                this.poll();
        },
    };

    document.addEventListener("visibilitychange", () => {
        if (!document.hidden)
            poller.poll();
    });

    /* ---------- actions ---------- */

    const CONFIRMED = "confirmed";
    const NOT_CONFIRMED = "not confirmed";
    const UNCHECKED = "unchecked";

    /**
     * qBittorrent answers 200 even when it did nothing (an unknown hash is
     * skipped silently, and the arr apps or the cleanup job may have removed
     * the torrent a moment ago), so an action only counts once a fresh read
     * of the torrent shows it. Runs on its own reads, so it works while live
     * updates are paused. Resolves CONFIRMED, NOT_CONFIRMED (qBittorrent was
     * read and the change isn't there) or UNCHECKED (it couldn't be read).
     */
    const confirmAction = async (hash, isDone) => {
        const deadline = Date.now() + ACTION_CONFIRM_TIMEOUT_MS;
        let readOnce = false;
        while (Date.now() < deadline) {
            await new Promise((resolve) => window.setTimeout(resolve, ACTION_CONFIRM_POLL_MS));
            try {
                const info = await apiJson(`api/v2/torrents/info?hashes=${encodeURIComponent(hash)}`);
                readOnce = true;
                const torrent = Array.isArray(info) ? (info[0] ?? null) : null;
                if (isDone(torrent)) {
                    if ((torrent !== null) && store.torrents.has(hash))
                        Object.assign(store.torrents.get(hash), torrent);
                    if (torrent === null)
                        store.torrents.delete(hash);
                    return CONFIRMED;
                }
            }
            catch (error) {
                if (error instanceof SignedOutError) {
                    showSignedOut();
                    return UNCHECKED;
                }
                // a dropped read is retried until the deadline
            }
        }
        return readOnce ? NOT_CONFIRMED : UNCHECKED;
    };

    const hashParams = (hash, extra = {}) => new URLSearchParams({ hashes: hash, ...extra });

    /* ---------- the torrent list (#/) ---------- */

    const loadExpandedGroups = () => {
        try {
            return JSON.parse(window.localStorage.getItem(GROUP_STATE_STORAGE_KEY) ?? "{}") ?? {};
        }
        catch {
            return {};
        }
    };

    const listView = {
        query: "",
        // set when leaving a torrent's page, so coming back lands on it
        returnHash: null,
        // set after a remove: where the removed torrent was
        returnSlot: null,

        enter() {
            document.title = "qBittorrent, torrents";
            this.expanded = loadExpandedGroups();
            this.items = new Map(); // hash -> { li, meta }
            this.groups = new Map();

            const heading = el("h1", { tabindex: "-1", text: "Torrents" });
            this.summary = el("p", { id: "summary" });
            this.search = el("input", {
                type: "search",
                id: "search",
                "aria-label": "Search torrents",
                placeholder: "Search torrents",
                autocomplete: "off",
            });
            this.search.value = this.query;
            let searchTimer = -1;
            this.closedWhileSearching = new Set();
            this.search.addEventListener("input", () => {
                window.clearTimeout(searchTimer);
                searchTimer = window.setTimeout(() => {
                    if (this.query.trim() === "")
                        this.closedWhileSearching.clear();
                    this.query = this.search.value;
                    const count = this.reconcile();
                    if (this.query.trim() !== "")
                        announcer.say((count === 0) ? "No torrents found" : `${plural(count, "torrent")} found`);
                }, SEARCH_DEBOUNCE_MS);
            });

            const groupNodes = GROUPS.map((group) => {
                const listId = `group-${group.id}`;
                const toggle = el("button", {
                    type: "button",
                    class: "group-toggle",
                    "aria-controls": listId,
                    onclick: () => this.toggleGroup(group.id),
                });
                const list = el("ul", { id: listId, class: "torrents" });
                const container = el("div", { class: "group", hidden: true }, el("h2", {}, toggle), list);
                this.groups.set(group.id, { group, container, toggle, list });
                return container;
            });
            this.emptyMessage = el("p", { hidden: true });

            main.replaceChildren(
                heading,
                this.summary,
                el("p", {}, el("a", { href: "#/add", text: "Add torrent" })),
                el("p", {}, this.search),
                ...groupNodes,
                this.emptyMessage);

            // an item kept in place because it had focus moves once focus leaves
            main.addEventListener("focusout", this.onFocusOut);

            if (!store.loaded)
                setText(this.summary, "Loading torrents…");
            this.update();
            this.restoreFocus(heading);
        },

        leave() {
            main.removeEventListener("focusout", this.onFocusOut);
            this.items = null;
            this.groups = null;
        },

        onFocusOut: () => {
            window.setTimeout(() => {
                if (router.current === listView)
                    listView.update();
            }, 0);
        },

        isExpanded(groupId) {
            // while searching, every group with a match opens unless closed
            // during this search; that choice isn't saved
            if (this.query.trim() !== "")
                return !this.closedWhileSearching.has(groupId);
            const group = GROUPS.find((g) => g.id === groupId);
            return this.expanded[groupId] ?? group.expandedByDefault;
        },

        toggleGroup(groupId) {
            if (this.query.trim() !== "") {
                if (this.closedWhileSearching.has(groupId))
                    this.closedWhileSearching.delete(groupId);
                else
                    this.closedWhileSearching.add(groupId);
                this.reconcile();
                return;
            }
            this.expanded[groupId] = !this.isExpanded(groupId);
            try {
                window.localStorage.setItem(GROUP_STATE_STORAGE_KEY, JSON.stringify(this.expanded));
            }
            catch {
                // private browsing: the choice just isn't remembered
            }
            this.reconcile();
        },

        restoreFocus(fallback) {
            const hash = this.returnHash;
            const slot = this.returnSlot;
            this.returnHash = null;
            this.returnSlot = null;
            if (hash !== null) {
                const item = this.items.get(hash);
                if (item !== undefined && item.li.getClientRects().length > 0) {
                    item.li.querySelector("a").focus();
                    return;
                }
                const torrent = store.torrents.get(hash);
                if (torrent !== undefined) {
                    this.groups.get(groupOf(torrent)).toggle.focus();
                    return;
                }
            }
            if (slot !== null) {
                const entry = this.groups.get(slot.groupId);
                const links = [...entry.list.querySelectorAll("a")];
                const target = links[Math.min(slot.index, links.length - 1)];
                if (target !== undefined && target.getClientRects().length > 0) {
                    target.focus();
                    return;
                }
                if (!entry.container.hidden) {
                    entry.toggle.focus();
                    return;
                }
            }
            focusHeading(fallback);
        },

        update() {
            if (this.items === null)
                return;
            if (store.loaded)
                setText(this.summary, this.summaryText());
            this.reconcile();
        },

        summaryText() {
            const server = store.server;
            const moving = [];
            if (server.dl_info_speed > 0)
                moving.push(`downloading at ${formatSpeed(server.dl_info_speed)}`);
            if (server.up_info_speed > 0)
                moving.push(`uploading at ${formatSpeed(server.up_info_speed)}`);
            let text = (moving.length > 0) ? `${moving.join(", ")}.` : "nothing transferring.";
            text = text[0].toUpperCase() + text.slice(1);
            if (server.connection_status === "firewalled")
                text += " Firewalled.";
            else if (server.connection_status === "disconnected")
                text += " Not connected to the internet.";
            if (server.use_alt_speed_limits)
                text += " Alternative speed limits are on.";
            return text;
        },

        createItem(torrent) {
            const link = el("a", { href: `#/t/${encodeURIComponent(torrent.hash)}` });
            const meta = el("span", { class: "meta" });
            const li = el("li", {}, link, meta);
            li.dataset.hash = torrent.hash;
            return { li, link, meta };
        },

        /**
         * Bring the lists in line with the data. The item that has keyboard
         * focus is never moved or removed (that would drop focus); it moves
         * to its new place once focus leaves it. Returns how many torrents
         * are shown.
         */
        reconcile() {
            if (this.items === null)
                return 0;
            const query = this.query.trim().toLowerCase();
            const focusedLi = document.activeElement?.closest?.("li[data-hash]") ?? null;

            const byGroup = new Map(GROUPS.map((group) => [group.id, []]));
            for (const torrent of store.torrents.values()) {
                if (query && !String(torrent.name).toLowerCase().includes(query))
                    continue;
                byGroup.get(groupOf(torrent)).push(torrent);
            }

            let shown = 0;
            const wanted = new Set();
            for (const group of GROUPS) {
                const entry = this.groups.get(group.id);
                const torrents = byGroup.get(group.id).sort((a, b) => collator.compare(String(a.name), String(b.name)));
                shown += torrents.length;
                const lis = torrents.map((torrent) => {
                    wanted.add(torrent.hash);
                    let item = this.items.get(torrent.hash);
                    if (item === undefined) {
                        item = this.createItem(torrent);
                        this.items.set(torrent.hash, item);
                    }
                    setText(item.link, String(torrent.name));
                    setText(item.meta, listLineText(torrent));
                    return item.li;
                });
                this.arrange(entry.list, lis, focusedLi);

                const expanded = this.isExpanded(group.id);
                const holdsFocus = (focusedLi !== null) && entry.list.contains(focusedLi);
                entry.container.hidden = (torrents.length === 0) && !holdsFocus;
                entry.list.hidden = !expanded && !holdsFocus;
                entry.toggle.setAttribute("aria-expanded", entry.list.hidden ? "false" : "true");
                setText(entry.toggle, `${group.title} (${torrents.length})`);
            }

            const focusedItem = (focusedLi !== null) ? this.items.get(focusedLi.dataset.hash) : undefined;
            if ((focusedItem !== undefined) && !wanted.has(focusedLi.dataset.hash) && !store.torrents.has(focusedLi.dataset.hash))
                this.moveFocusOffItem(focusedLi, wanted);
            for (const [hash, item] of this.items) {
                if (wanted.has(hash))
                    continue;
                if ((item.li === focusedLi) && (document.activeElement !== null) && item.li.contains(document.activeElement))
                    continue; // filtered out under focus; tidied when focus leaves
                item.li.remove();
                this.items.delete(hash);
            }

            this.emptyMessage.hidden = shown > 0;
            if (shown === 0)
                setText(this.emptyMessage, query ? "No torrents match." : (store.loaded ? "No torrents." : ""));
            return shown;
        },

        /**
         * Order `ul` as `desired`, moving every item except `pinned` (the
         * focused one), which stays where it is even if it now belongs to
         * another group.
         */
        arrange(ul, desired, pinned) {
            const pinnedHere = (pinned !== null) && (pinned.parentElement === ul);
            let cursor = ul.firstElementChild;
            for (const li of desired) {
                if ((cursor === pinned) && pinnedHere && !desired.includes(pinned))
                    cursor = cursor.nextElementSibling;
                if (li === pinned) {
                    if (pinnedHere)
                        cursor = li.nextElementSibling;
                    continue;
                }
                if (li === cursor)
                    cursor = cursor.nextElementSibling;
                else
                    ul.insertBefore(li, cursor);
            }
        },

        /**
         * The focused torrent is going away: focus the nearest torrent in the
         * same list that is staying (the cleanup job removes whole seasons in
         * one pass), else the group's heading button, else the page heading.
         */
        moveFocusOffItem(li, staying) {
            const stays = (candidate) => (candidate !== null) && staying.has(candidate.dataset.hash);
            for (let next = li.nextElementSibling, previous = li.previousElementSibling; (next !== null) || (previous !== null);) {
                if (stays(next)) {
                    next.querySelector("a").focus();
                    return;
                }
                if (stays(previous)) {
                    previous.querySelector("a").focus();
                    return;
                }
                next = next?.nextElementSibling ?? null;
                previous = previous?.previousElementSibling ?? null;
            }
            const entry = [...this.groups.values()].find((candidate) => candidate.list.contains(li));
            if ((entry !== undefined) && [...entry.list.children].some(stays))
                entry.toggle.focus();
            else
                focusHeading(main.querySelector("h1"));
        },
    };

    /* ---------- one torrent (#/t/<hash>) ---------- */

    const torrentView = {
        enter({ hash }) {
            this.hash = hash;
            this.pending = false;
            listView.returnHash = hash;

            this.heading = el("h1", { tabindex: "-1" });
            this.status = el("p", { id: "status" });
            this.toggleButton = el("button", { type: "button", onclick: () => this.toggle() });
            this.removeButton = el("button", { type: "button", class: "danger", text: "Remove", onclick: () => this.openConfirm() });
            this.actions = el("p", { class: "actions" }, this.toggleButton, this.removeButton);

            this.confirmHeading = el("h2", { tabindex: "-1", text: "Remove this torrent?" });
            this.warning = el("p", { id: "warning" });
            this.deleteFiles = el("input", { type: "checkbox", id: "deleteFiles" });
            this.confirm = el("div", { class: "confirm", hidden: true },
                this.confirmHeading,
                this.warning,
                el("p", {}, el("label", {}, this.deleteFiles, " Also delete the downloaded files")),
                el("p", { class: "actions" },
                    // the warning arrives after focus lands on the heading;
                    // tied to the button so it is heard either way
                    el("button", { type: "button", class: "danger", text: "Remove", "aria-describedby": "warning", onclick: () => this.remove() }),
                    el("button", { type: "button", text: "Cancel", onclick: () => this.closeConfirm() })));

            this.facts = el("ul", { id: "facts" });
            this.gone = el("p", { hidden: true, tabindex: "-1", text: "This torrent is no longer in qBittorrent." });

            this.disclosures = [
                this.makeDisclosure("Files", () => this.loadFiles()),
                this.makeDisclosure("Trackers", () => this.loadTrackers()),
                this.makeDisclosure("Peers", () => this.loadPeers()),
            ];

            main.replaceChildren(
                el("p", {}, el("a", { href: "#/", text: "All torrents" })),
                this.heading,
                this.status,
                this.gone,
                this.actions,
                this.confirm,
                this.facts,
                ...this.disclosures.map((disclosure) => disclosure.details));

            this.update();
            focusHeading(this.heading);
        },

        leave() {
            for (const disclosure of this.disclosures)
                window.clearInterval(disclosure.timer);
            this.disclosures = [];
        },

        torrent() {
            return store.torrents.get(this.hash);
        },

        update() {
            const torrent = this.torrent();
            if (torrent === undefined) {
                if (!store.loaded) {
                    setText(this.heading, "Torrent");
                    setText(this.status, "Loading…");
                    return;
                }
                this.showGone();
                return;
            }
            if (!this.gone.hidden) {
                this.gone.hidden = true;
                this.actions.hidden = false;
                this.status.hidden = false;
            }
            document.title = `qBittorrent, ${torrent.name}`;
            setText(this.heading, String(torrent.name));
            setText(this.status, statusSentence(torrent));
            const action = toggleActionFor(torrent);
            if (action === null) {
                if (document.activeElement === this.toggleButton)
                    this.removeButton.focus();
                this.toggleButton.hidden = true;
            }
            else {
                this.toggleButton.hidden = false;
                setText(this.toggleButton, action.label);
            }
            this.updateFacts(factsOf(torrent));
        },

        /** Update the facts in place, one item per label, so the reading cursor stays put. */
        updateFacts(facts) {
            const existing = new Map([...this.facts.children].map((li) => [li.dataset.label, li]));
            let cursor = this.facts.firstElementChild;
            for (const [label, value] of facts) {
                let li = existing.get(label);
                existing.delete(label);
                if (li === undefined) {
                    li = el("li");
                    li.dataset.label = label;
                }
                setText(li, `${label}: ${value}`);
                if (li === cursor)
                    cursor = cursor.nextElementSibling;
                else
                    this.facts.insertBefore(li, cursor);
            }
            for (const stale of existing.values())
                stale.remove();
        },

        showGone() {
            if (!this.gone.hidden)
                return;
            const focusWasHidden = this.actions.contains(document.activeElement) || this.confirm.contains(document.activeElement);
            this.gone.hidden = false;
            this.actions.hidden = true;
            this.confirm.hidden = true;
            this.status.hidden = true;
            if (this.heading.textContent === "")
                setText(this.heading, "Torrent");
            if (store.loaded && (this.heading.textContent !== "Torrent"))
                announcer.say(`${this.heading.textContent} is no longer in qBittorrent`);
            if (focusWasHidden)
                this.gone.focus();
        },

        async toggle() {
            const torrent = this.torrent();
            if ((torrent === undefined) || this.pending)
                return;
            const action = toggleActionFor(torrent);
            if (action === null)
                return;
            // the outcome is still announced if the user moves on; the page
            // isn't touched unless it is still this torrent's
            const hash = torrent.hash;
            const generation = router.generation;
            const name = String(torrent.name);
            this.pending = true;
            this.toggleButton.setAttribute("aria-disabled", "true");
            try {
                await apiPost(action.endpoint, hashParams(hash));
                const outcome = await confirmAction(hash, action.done);
                if (outcome === CONFIRMED)
                    announcer.say(`${action.success} ${name}`);
                else if (outcome === NOT_CONFIRMED)
                    announcer.say(`${name} ${action.failure}`);
                else if (!poller.signedOut)
                    announcer.say(`Couldn't check whether ${name} ${action.checked}: can't reach qBittorrent`);
            }
            catch (error) {
                if (error instanceof SignedOutError)
                    showSignedOut();
                else
                    announcer.say(`Couldn't ${action.label.toLowerCase()} ${name}. ${error.message}`);
            }
            finally {
                if (stillOn(generation)) {
                    this.pending = false;
                    this.toggleButton.removeAttribute("aria-disabled");
                    this.update();
                }
            }
        },

        openConfirm() {
            const torrent = this.torrent();
            if (torrent === undefined)
                return;
            this.deleteFiles.checked = false;
            setText(this.warning, "");
            this.confirm.hidden = false;
            focusHeading(this.confirmHeading);
            this.checkPrivateTracker(torrent);
        },

        closeConfirm() {
            this.confirm.hidden = true;
            this.removeButton.focus();
        },

        /**
         * Advisory only: qBittorrent's seeding time is its own count since the
         * download finished, not what the tracker has credited.
         */
        async checkPrivateTracker(torrent) {
            if (!isFinished(torrent))
                return;
            const hours = Math.floor((torrent.seeding_time ?? 0) / SECONDS_PER_HOUR);
            if (hours >= MAM_REQUIRED_SEEDING_HOURS)
                return;
            const generation = router.generation;
            try {
                const trackers = await apiJson(`api/v2/torrents/trackers?hash=${encodeURIComponent(torrent.hash)}`);
                if (!stillOn(generation))
                    return;
                if (trackers.some((tracker) => MAM_TRACKER.test(String(tracker.url))) && !this.confirm.hidden) {
                    const warning = `qBittorrent reports this has seeded for ${plural(hours, "hour")} since it finished. `
                        + `MyAnonamouse asks for ${MAM_REQUIRED_SEEDING_HOURS} hours within 30 days of finishing, so check before removing it.`;
                    setText(this.warning, warning);
                    announcer.say(warning);
                }
            }
            catch (error) {
                if (error instanceof SignedOutError) {
                    showSignedOut();
                    return;
                }
                if (stillOn(generation) && !this.confirm.hidden) {
                    const warning = "Couldn't check this torrent's trackers. If it came from a private tracker like MyAnonamouse, make sure it has seeded long enough first.";
                    setText(this.warning, warning);
                    announcer.say(warning);
                }
            }
        },

        async remove() {
            const torrent = this.torrent();
            if ((torrent === undefined) || this.pending)
                return;
            const hash = torrent.hash;
            const generation = router.generation;
            const name = String(torrent.name);
            const deleteFiles = this.deleteFiles.checked;
            const groupId = groupOf(torrent);
            this.pending = true;
            try {
                // deleteFiles is required; an unchecked box must still be sent
                await apiPost("api/v2/torrents/delete", hashParams(hash, { deleteFiles: deleteFiles ? "true" : "false" }));
                const outcome = await confirmAction(hash, (info) => info === null);
                if (outcome !== CONFIRMED) {
                    if (outcome === NOT_CONFIRMED)
                        announcer.say(`${name} is still in qBittorrent`);
                    else if (!poller.signedOut)
                        announcer.say(`Couldn't check whether ${name} was removed: can't reach qBittorrent`);
                    return;
                }
                announcer.say(deleteFiles ? `Removed ${name} and its files` : `Removed ${name}`);
                // only take the user back to the list from this torrent's page
                if (stillOn(generation)) {
                    listView.returnHash = null;
                    listView.returnSlot = { groupId, index: this.slotIndex(groupId, name) };
                    window.location.hash = "#/";
                }
            }
            catch (error) {
                if (error instanceof SignedOutError)
                    showSignedOut();
                else
                    announcer.say(`Couldn't remove ${name}. ${error.message}`);
            }
            finally {
                if (stillOn(generation))
                    this.pending = false;
            }
        },

        /** Where a torrent named `name` sits (or would sit) in its group's list. */
        slotIndex(groupId, name) {
            const names = [...store.torrents.values()]
                .filter((torrent) => groupOf(torrent) === groupId)
                .map((torrent) => String(torrent.name))
                .sort((a, b) => collator.compare(a, b));
            const index = names.findIndex((other) => collator.compare(other, name) >= 0);
            return (index === -1) ? names.length : index;
        },

        makeDisclosure(title, load) {
            const summary = el("summary", { text: title });
            const body = el("div", {}, el("p", { text: "Loading…" }));
            const details = el("details", {}, summary, body);
            const disclosure = { title, details, summary, body, timer: -1 };
            details.addEventListener("toggle", () => {
                window.clearInterval(disclosure.timer);
                if (!details.open)
                    return;
                load();
                disclosure.timer = window.setInterval(() => {
                    if (!poller.paused && !document.hidden)
                        load();
                }, DISCLOSURE_REFRESH_MS);
            });
            return disclosure;
        },

        /** Fill a disclosure, changing list items in place so the reading cursor stays put. */
        fillDisclosure(index, count, lines, emptyText) {
            const disclosure = this.disclosures[index];
            if (disclosure === undefined)
                return;
            setText(disclosure.summary, `${disclosure.title} (${count})`);
            if (lines.length === 0) {
                if (disclosure.body.textContent !== emptyText)
                    disclosure.body.replaceChildren(el("p", { text: emptyText }));
                return;
            }
            let list = disclosure.body.querySelector(":scope > ul");
            if (list === null) {
                list = el("ul");
                disclosure.body.replaceChildren(list);
            }
            lines.forEach((line, i) => {
                const li = list.children[i] ?? list.appendChild(el("li"));
                setText(li, line);
            });
            while (list.children.length > lines.length)
                list.lastElementChild.remove();
        },

        failDisclosure(index, error) {
            if (error instanceof SignedOutError) {
                showSignedOut();
                return;
            }
            const disclosure = this.disclosures[index];
            if (disclosure !== undefined)
                disclosure.body.replaceChildren(el("p", { text: `Couldn't load this. ${error.message}` }));
        },

        async loadFiles() {
            const generation = router.generation;
            try {
                const files = await apiJson(`api/v2/torrents/files?hash=${encodeURIComponent(this.hash)}`);
                if (!stillOn(generation))
                    return;
                const lines = files.map((file) => {
                    const parts = [String(file.name), formatSize(file.size)];
                    if (file.progress < 1)
                        parts.push(`${Math.floor(file.progress * 100)}% done`);
                    if (file.priority === 0)
                        parts.push("not downloading");
                    return parts.join(", ");
                });
                this.fillDisclosure(0, files.length, lines, "No files yet.");
            }
            catch (error) {
                if (stillOn(generation))
                    this.failDisclosure(0, error);
            }
        },

        async loadTrackers() {
            const generation = router.generation;
            try {
                const trackers = (await apiJson(`api/v2/torrents/trackers?hash=${encodeURIComponent(this.hash)}`))
                    .filter((tracker) => !String(tracker.url).startsWith("** ["));
                if (!stillOn(generation))
                    return;
                // a host listed twice (udp and http, say) gets its protocol
                const hosts = trackers.map((tracker) => hostOf(String(tracker.url)));
                const lines = trackers.map((tracker, i) => {
                    let name = hosts[i];
                    if (hosts.indexOf(name) !== hosts.lastIndexOf(name)) {
                        try {
                            name += ` (${new URL(String(tracker.url)).protocol.replace(":", "")})`;
                        }
                        catch {
                            // unparseable URL: the host alone will do
                        }
                    }
                    const parts = [name, TRACKER_STATUS_WORDS[tracker.status] ?? "unknown"];
                    if (tracker.msg)
                        parts.push(String(tracker.msg));
                    return parts.join(", ");
                });
                this.fillDisclosure(1, trackers.length, lines, "No trackers.");
            }
            catch (error) {
                if (stillOn(generation))
                    this.failDisclosure(1, error);
            }
        },

        async loadPeers() {
            const generation = router.generation;
            try {
                const json = await apiJson(`api/v2/sync/torrentPeers?hash=${encodeURIComponent(this.hash)}&rid=0`);
                if (!stillOn(generation))
                    return;
                const peers = Object.values(json.peers ?? {});
                const lines = peers.map((peer) => {
                    const parts = [String(peer.client || "Unknown client"), String(peer.ip)];
                    if (peer.dl_speed > 0)
                        parts.push(`${formatSpeed(peer.dl_speed)} down`);
                    if (peer.up_speed > 0)
                        parts.push(`${formatSpeed(peer.up_speed)} up`);
                    return parts.join(", ");
                });
                this.fillDisclosure(2, peers.length, lines, "No peers connected.");
            }
            catch (error) {
                if (stillOn(generation))
                    this.failDisclosure(2, error);
            }
        },
    };

    /* ---------- adding torrents (#/add) ---------- */

    const addView = {
        // a magnet link handed over through the browser's magnet handler
        prefill: "",
        preferences: null,

        enter() {
            document.title = "qBittorrent, add torrent";
            const heading = el("h1", { tabindex: "-1", text: "Add torrent" });
            this.urls = el("textarea", { id: "addUrls", rows: "4" });
            this.urls.value = this.prefill;
            this.prefill = "";
            this.files = el("input", { type: "file", id: "addFiles", multiple: true, accept: ".torrent,application/x-bittorrent" });
            this.category = el("select", { id: "addCategory" });
            this.fillCategories();
            this.start = el("input", { type: "checkbox", id: "addStart", checked: true });
            // once the user has set it, qBittorrent's default no longer applies
            this.startTouched = false;
            this.start.addEventListener("change", () => {
                this.startTouched = true;
            });
            this.submitButton = el("button", { type: "submit", text: "Add" });
            this.result = el("p", { id: "addResult" });

            const form = el("form", { onsubmit: (event) => this.submit(event) },
                el("p", {}, el("label", { for: "addUrls", text: "Magnet links or web addresses, one per line" }), el("br"), this.urls),
                el("p", {}, el("label", { for: "addFiles", text: "Torrent files" }), el("br"), this.files),
                el("p", {}, el("label", { for: "addCategory", text: "Category " }), this.category),
                el("p", {}, el("label", {}, this.start, " Start right away")),
                el("p", {}, this.submitButton),
                this.result);

            main.replaceChildren(el("p", {}, el("a", { href: "#/", text: "All torrents" })), heading, form);
            this.applyPreferences();
            focusHeading(heading);
        },

        leave() {},

        update() {
            this.fillCategories();
        },

        /**
         * Categories come with the first update, which a page opened straight
         * from a magnet link hasn't had yet; refill and keep the choice.
         */
        fillCategories() {
            const names = ["", ...[...store.categories.keys()].sort((a, b) => collator.compare(a, b))];
            const current = [...this.category.options].map((option) => option.value);
            if (current.join("\n") === names.join("\n"))
                return;
            const chosen = this.category.value;
            this.category.replaceChildren(...names.map((name) => el("option", { value: name, text: (name === "") ? "None" : name })));
            this.category.value = names.includes(chosen) ? chosen : "";
        },

        /** Start the checkbox where qBittorrent's own "add stopped" setting would. */
        async applyPreferences() {
            const generation = router.generation;
            try {
                this.preferences ??= await apiJson("api/v2/app/preferences");
                if (stillOn(generation) && !this.startTouched)
                    this.start.checked = !this.preferences.add_stopped_enabled;
            }
            catch (error) {
                if (error instanceof SignedOutError)
                    showSignedOut();
                // otherwise the checkbox stays checked
            }
        },

        async submit(event) {
            event.preventDefault();
            if (this.submitButton.getAttribute("aria-disabled") === "true")
                return;
            const generation = router.generation;
            const urls = this.urls.value.trim();
            const files = [...this.files.files];
            // the result is always spoken; the form is only touched if it is
            // still on screen
            const say = (message) => {
                if (stillOn(generation))
                    setText(this.result, message);
                announcer.say(message);
            };
            if ((urls === "") && (files.length === 0)) {
                say("Paste a magnet link or choose a torrent file first.");
                this.urls.focus();
                return;
            }

            const form = new FormData();
            if (urls !== "")
                form.append("urls", urls);
            for (const file of files)
                form.append("torrents", file, file.name);
            if (this.category.value !== "")
                form.append("category", this.category.value);
            form.append("stopped", this.start.checked ? "false" : "true");
            const attempted = (urls === "" ? 0 : urls.split(/\s*\n\s*/).filter(Boolean).length) + files.length;

            this.submitButton.setAttribute("aria-disabled", "true");
            setText(this.result, "Adding…");
            try {
                const response = await apiFetch("api/v2/torrents/add", { method: "POST", body: form });
                const text = (await response.text()).trim();
                let json = null;
                try {
                    json = JSON.parse(text);
                }
                catch {
                    // older daemons answer "Ok." or "Fails."
                }
                let added = 0;
                let pending = 0;
                let failed = 0;
                if ((json !== null) && (typeof json.success_count === "number")) {
                    added = json.success_count;
                    pending = json.pending_count ?? 0;
                    failed = json.failure_count ?? 0;
                }
                else if (response.ok && /^ok\.?$/i.test(text)) {
                    added = attempted;
                }
                else if ((response.status === 409) || /^fails\.?$/i.test(text)) {
                    failed = attempted;
                }
                else {
                    throw new ApiError(response.status, text);
                }

                const parts = [];
                if (added > 0)
                    parts.push(`Added ${plural(added, "torrent")}`);
                if (pending > 0)
                    parts.push(`${plural(pending, "torrent")} still being fetched by qBittorrent`);
                if ((failed > 0) && (added === 0) && (pending === 0))
                    parts.push(`Couldn't add ${(failed === 1) ? "it" : "any of them"}. It may already be in qBittorrent, or the link or file may be invalid`);
                else if (failed > 0)
                    parts.push(`Couldn't add ${plural(failed, "torrent")}; it may already be in qBittorrent, or the link or file may be invalid`);
                if (parts.length === 0)
                    parts.push("Nothing was added");

                if ((failed === 0) && ((added + pending) > 0)) {
                    announcer.say(parts.join(". "));
                    if (stillOn(generation)) {
                        this.urls.value = "";
                        this.files.value = "";
                        window.location.hash = "#/";
                    }
                }
                else {
                    // keep what was entered so it can be fixed and sent again
                    say(`${parts.join(". ")}. Check the links or files and try again.`);
                }
            }
            catch (error) {
                if (error instanceof SignedOutError)
                    showSignedOut();
                else
                    say(`Couldn't add: ${error.message}`);
            }
            finally {
                if (stillOn(generation))
                    this.submitButton.removeAttribute("aria-disabled");
            }
        },
    };

    /* ---------- routing ---------- */

    const router = {
        current: null,
        // bumped on every page change; async work started on one page checks
        // it before touching the DOM or navigating, since the views are reused
        generation: 0,

        resolve() {
            const hash = window.location.hash;
            // the full interface registers magnet links as <page>#download=<url>
            const decode = (text) => {
                try {
                    return decodeURIComponent(text);
                }
                catch {
                    return text;
                }
            };
            if (hash.startsWith("#download=")) {
                addView.prefill = decode(hash.slice("#download=".length));
                window.history.replaceState(null, "", "#/add");
                return [addView, {}];
            }
            if (hash === "#/add")
                return [addView, {}];
            const match = /^#\/t\/(.+)$/.exec(hash);
            if (match !== null)
                return [torrentView, { hash: decode(match[1]) }];
            return [listView, {}];
        },

        go() {
            const [view, params] = this.resolve();
            this.current?.leave();
            this.current = view;
            ++this.generation;
            view.enter(params);
        },

        update() {
            this.current?.update();
        },
    };

    /* ---------- start ---------- */

    const pauseButton = document.getElementById("pauseUpdates");
    pauseButton.addEventListener("click", () => {
        const paused = !poller.paused;
        pauseButton.setAttribute("aria-pressed", paused ? "true" : "false");
        poller.setPaused(paused);
        announcer.say(paused ? "Live updates paused" : "Live updates on");
    });

    window.addEventListener("hashchange", () => router.go());
    router.go();
    poller.poll();
})();
