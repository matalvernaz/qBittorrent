/*
 * Accessibility retrofit layer for the qBittorrent WebUI.
 *
 * Everything that can be applied to existing markup at runtime lives here:
 * landmarks, menubar/toolbar/tab keyboard support, dialog focus management,
 * decorative-image cleanup and a polite live region for action feedback.
 * Structural changes that must happen while elements are created (torrent
 * table row semantics, context menu roles) live in dynamicTable.js and
 * contextmenu.js.
 */

"use strict";

window.qBittorrent ??= {};
window.qBittorrent.Accessibility ??= (() => {
    const exports = () => {
        return {
            setup: setup,
            announce: announce,
            announceSelectionAction: announceSelectionAction,
        };
    };

    const PANEL_POLL_INTERVAL_MS = 250;
    const PANEL_POLL_MAX_TRIES = 60;
    const DIALOG_FOCUS_RETRY_MS = [100, 400, 900];

    let liveRegion = null;

    /* ---------- live region ---------- */

    const createLiveRegion = () => {
        liveRegion = document.createElement("div");
        liveRegion.id = "a11yLiveRegion";
        liveRegion.className = "a11y-sr-only";
        liveRegion.setAttribute("aria-live", "polite");
        document.body.append(liveRegion);
    };

    const announce = (message) => {
        if ((liveRegion === null) || !message)
            return;
        // clear first so an identical consecutive message is re-announced
        liveRegion.textContent = "";
        window.setTimeout(() => {
            liveRegion.textContent = message;
        }, 50);
    };

    const announceSelectionAction = (verb) => {
        const count = window.torrentsTable?.selectedRowsIds().length ?? 0;
        if (count === 0)
            announce(verb);
        else
            announce(`${verb} — ${count} ${(count === 1) ? "torrent" : "torrents"}`);
    };

    /* ---------- landmarks & static roles ---------- */

    const applyWhenPresent = (id, apply) => {
        let tries = 0;
        const timer = window.setInterval(() => {
            const element = document.getElementById(id);
            if (element !== null) {
                window.clearInterval(timer);
                apply(element);
            }
            else if (++tries >= PANEL_POLL_MAX_TRIES) {
                window.clearInterval(timer);
            }
        }, PANEL_POLL_INTERVAL_MS);
    };

    const applyLandmarks = () => {
        const navbar = document.getElementById("desktopNavbar");
        navbar.setAttribute("role", "navigation");
        navbar.setAttribute("aria-label", "Application menu");

        const toolbar = document.getElementById("mochaToolbar");
        toolbar.setAttribute("role", "toolbar");
        toolbar.setAttribute("aria-label", "Torrent actions");

        const footer = document.getElementById("desktopFooter");
        footer.setAttribute("role", "contentinfo");
        footer.setAttribute("aria-label", "Status bar");

        document.getElementById("error_div").setAttribute("role", "alert");

        // MochaUI panels are created after load
        applyWhenPresent("Filters", (el) => {
            el.setAttribute("role", "complementary");
            el.setAttribute("aria-label", "Filter sidebar");
        });
        applyWhenPresent("transferList", (el) => {
            el.setAttribute("role", "main");
            el.setAttribute("aria-label", "Torrent list");
        });
        applyWhenPresent("propertiesPanel", (el) => {
            el.setAttribute("role", "region");
            el.setAttribute("aria-label", "Torrent details");
        });
    };

    /* ---------- toolbar ---------- */

    const labelToolbarButtons = () => {
        const toolbar = document.getElementById("mochaToolbar");

        for (const button of toolbar.querySelectorAll("a")) {
            const img = button.querySelector("img");
            if (img === null)
                continue;
            button.setAttribute("role", "button");
            button.tabIndex = 0;
            button.setAttribute("aria-label", img.title || img.alt);
            img.alt = "";
        }

        // "Add Torrent File" is a <label> wrapping a hidden file input
        const uploadLabel = document.querySelector("#uploadButton label");
        if (uploadLabel !== null) {
            const img = uploadLabel.querySelector("img");
            uploadLabel.setAttribute("role", "button");
            uploadLabel.tabIndex = 0;
            uploadLabel.setAttribute("aria-label", img?.title || img?.alt || "");
            if (img !== null)
                img.alt = "";
        }

        toolbar.addEventListener("keydown", (e) => {
            if ((e.key !== "Enter") && (e.key !== " "))
                return;
            const button = e.target.closest("[role=\"button\"]");
            if (button === null)
                return;
            e.preventDefault();
            button.click();
        });
    };

    /* ---------- decorative images ---------- */

    const stripDecorativeAltText = () => {
        // parents carry the visible text or an aria-label; the icons are noise
        for (const img of document.querySelectorAll("#desktopNavbar img, ul.contextMenu img"))
            img.alt = "";
    };

    /* ---------- menubar ---------- */

    const setupMenubar = () => {
        const menubar = document.querySelector("#desktopNavbar > ul");
        if (menubar === null)
            return;

        menubar.setAttribute("role", "menubar");
        const topItems = [...menubar.querySelectorAll(":scope > li")];
        const triggers = [];

        const menuItemsOf = (li) =>
            [...li.querySelectorAll(":scope > ul > li")]
                .map((item) => item.querySelector(":scope > a, :scope > div.anchor > label"))
                .filter((item) => item !== null);

        const isOpen = (li) => (li !== null) && li.classList.contains("a11y-open");

        const closeAll = () => {
            for (const li of topItems) {
                li.classList.remove("a11y-open");
                li.querySelector(":scope > a")?.setAttribute("aria-expanded", "false");
            }
        };

        const openMenu = (li, focusFirst) => {
            closeAll();
            li.classList.add("a11y-open");
            li.querySelector(":scope > a").setAttribute("aria-expanded", "true");
            if (focusFirst)
                menuItemsOf(li)[0]?.focus();
        };

        for (const li of topItems) {
            li.setAttribute("role", "none");
            const trigger = li.querySelector(":scope > a");
            trigger.setAttribute("role", "menuitem");
            trigger.setAttribute("aria-haspopup", "true");
            trigger.setAttribute("aria-expanded", "false");
            trigger.tabIndex = (triggers.length === 0) ? 0 : -1;
            triggers.push(trigger);

            const submenu = li.querySelector(":scope > ul");
            submenu.setAttribute("role", "menu");
            submenu.setAttribute("aria-label", trigger.textContent.trim());
            for (const subLi of submenu.querySelectorAll(":scope > li")) {
                subLi.setAttribute("role", "none");
                const item = subLi.querySelector(":scope > a, :scope > div.anchor > label");
                if (item !== null) {
                    item.setAttribute("role", "menuitem");
                    item.tabIndex = -1;
                }
            }

            trigger.addEventListener("click", () => {
                if (isOpen(li))
                    closeAll();
                else
                    openMenu(li, false);
            });
        }

        const focusTrigger = (index) => {
            const wrapped = (index + triggers.length) % triggers.length;
            for (const t of triggers)
                t.tabIndex = -1;
            triggers[wrapped].tabIndex = 0;
            triggers[wrapped].focus();
            return triggers[wrapped];
        };

        document.getElementById("desktopNavbar").addEventListener("keydown", (e) => {
            const target = e.target;
            const li = target.closest("#desktopNavbar > ul > li");
            if (li === null)
                return;
            const triggerIndex = triggers.indexOf(target);
            const onTrigger = (triggerIndex !== -1);
            const anyOpen = topItems.some(isOpen);

            switch (e.key) {
                case "ArrowRight":
                case "ArrowLeft": {
                    e.preventDefault();
                    const currentIndex = onTrigger ? triggerIndex : topItems.indexOf(li);
                    const next = focusTrigger(currentIndex + ((e.key === "ArrowRight") ? 1 : -1));
                    if (anyOpen)
                        openMenu(next.closest("li"), true);
                    else
                        closeAll();
                    break;
                }
                case "ArrowDown":
                    e.preventDefault();
                    if (onTrigger) {
                        openMenu(li, true);
                    }
                    else {
                        const items = menuItemsOf(li);
                        const index = items.indexOf(target);
                        items[(index + 1) % items.length]?.focus();
                    }
                    break;
                case "ArrowUp":
                    e.preventDefault();
                    if (!onTrigger) {
                        const items = menuItemsOf(li);
                        const index = items.indexOf(target);
                        items[(index - 1 + items.length) % items.length]?.focus();
                    }
                    break;
                case "Enter":
                case " ":
                    e.preventDefault();
                    if (onTrigger) {
                        openMenu(li, true);
                    }
                    else {
                        target.click();
                        closeAll();
                        focusTrigger(topItems.indexOf(li));
                    }
                    break;
                case "Escape":
                    e.preventDefault();
                    closeAll();
                    focusTrigger(Math.max(topItems.indexOf(li), 0));
                    break;
                case "Tab":
                    closeAll();
                    break;
            }
        });

        document.getElementById("desktopNavbar").addEventListener("focusout", (e) => {
            if (!document.getElementById("desktopNavbar").contains(e.relatedTarget))
                closeAll();
        });
    };

    /* ---------- main window tabs ---------- */

    const setupTabs = () => {
        const list = document.getElementById("mainWindowTabsList");
        if (list === null)
            return;
        list.setAttribute("role", "tablist");
        list.setAttribute("aria-label", "Main window tabs");

        const tabAnchors = () => [...list.querySelectorAll("li > a")]
            .filter((a) => a.closest("li").offsetParent !== null);

        const sync = () => {
            for (const a of list.querySelectorAll("li > a")) {
                const selected = a.closest("li").classList.contains("selected");
                a.setAttribute("role", "tab");
                a.setAttribute("aria-selected", selected ? "true" : "false");
                a.tabIndex = selected ? 0 : -1;
            }
        };
        sync();
        new MutationObserver(sync).observe(list, { attributes: true, attributeFilter: ["class"], subtree: true });

        list.addEventListener("keydown", (e) => {
            if ((e.key !== "ArrowRight") && (e.key !== "ArrowLeft"))
                return;
            const anchors = tabAnchors();
            const index = anchors.indexOf(e.target);
            if (index === -1)
                return;
            e.preventDefault();
            const next = anchors[(index + ((e.key === "ArrowRight") ? 1 : -1) + anchors.length) % anchors.length];
            next.focus();
            next.click();
        });
    };

    /* ---------- MochaUI window (dialog) management ---------- */

    const setupDialogManager = () => {
        const openers = new WeakMap();

        const firstFocusable = (root) =>
            root.querySelector("[autofocus], input:not([type=\"hidden\"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex=\"0\"]");

        const focusContent = (win, attempt = 0) => {
            if (!win.isConnected)
                return;
            if (win.contains(document.activeElement))
                return;
            const target = firstFocusable(win.querySelector(".mochaContent") ?? win) ?? win;
            target.focus();
            if (!win.contains(document.activeElement) && (attempt < DIALOG_FOCUS_RETRY_MS.length))
                window.setTimeout(() => focusContent(win, attempt + 1), DIALOG_FOCUS_RETRY_MS[attempt]);
        };

        const prepareIframe = (win, iframe) => {
            const prepare = () => {
                const idoc = iframe.contentDocument;
                if (idoc === null)
                    return;
                idoc.addEventListener("keydown", (e) => {
                    if (e.key === "Escape")
                        MochaUI.closeWindow(win);
                });
                const target = firstFocusable(idoc.body ?? idoc) ?? iframe;
                target.focus();
            };
            iframe.addEventListener("load", prepare);
            if (iframe.contentDocument?.readyState === "complete")
                prepare();
        };

        const prepareDialog = (win) => {
            openers.set(win, document.activeElement);
            win.setAttribute("role", "dialog");
            win.setAttribute("aria-modal", "true");
            win.tabIndex = -1;
            const title = win.querySelector(".mochaTitle")?.textContent?.trim();
            if (title)
                win.setAttribute("aria-label", title);

            const closeButton = win.querySelector(".mochaClose");
            if (closeButton !== null) {
                closeButton.setAttribute("role", "button");
                closeButton.setAttribute("aria-label", "Close window");
                closeButton.tabIndex = 0;
            }

            win.addEventListener("keydown", (e) => {
                if (e.key === "Escape")
                    MochaUI.closeWindow(win);
            });

            const iframe = win.querySelector("iframe");
            if (iframe !== null)
                prepareIframe(win, iframe);
            else
                window.setTimeout(() => focusContent(win), DIALOG_FOCUS_RETRY_MS[0]);
        };

        const restoreFocus = (win) => {
            const opener = openers.get(win);
            if (opener?.isConnected)
                opener.focus();
        };

        new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if ((node.nodeType === Node.ELEMENT_NODE) && node.classList.contains("mocha"))
                        prepareDialog(node);
                }
                for (const node of mutation.removedNodes) {
                    if ((node.nodeType === Node.ELEMENT_NODE) && node.classList.contains("mocha"))
                        restoreFocus(node);
                }
            }
        }).observe(document.body, { childList: true, subtree: true });
    };

    /* ---------- action feedback ---------- */

    // actions that complete without opening a dialog; dialogs announce themselves
    const TOOLBAR_ANNOUNCEMENTS = {
        startButton: "Start",
        stopButton: "Stop",
        topPrioButton: "Move to top of queue",
        increasePrioButton: "Move up in queue",
        decreasePrioButton: "Move down in queue",
        bottomPrioButton: "Move to bottom of queue",
    };

    const CONTEXT_ANNOUNCEMENTS = new Set([
        "start", "stop", "forceStart",
        "queueTop", "queueUp", "queueDown", "queueBottom",
        "forceReannounce", "sequentialDownload", "firstLastPiecePrio", "superSeeding",
    ]);

    const setupActionAnnouncements = () => {
        document.getElementById("mochaToolbar").addEventListener("click", (e) => {
            const button = e.target.closest("[role=\"button\"]");
            if ((button !== null) && (button.id in TOOLBAR_ANNOUNCEMENTS))
                announceSelectionAction(TOOLBAR_ANNOUNCEMENTS[button.id]);
        });

        document.addEventListener("click", (e) => {
            const anchor = e.target.closest("ul.contextMenu li > a");
            if (anchor === null)
                return;
            if (anchor.classList.contains("copyToClipboard")) {
                announce("Copied to clipboard");
                return;
            }
            const action = anchor.getAttribute("href")?.split("#")[1];
            if (action && CONTEXT_ANNOUNCEMENTS.has(action))
                announceSelectionAction(anchor.textContent.trim());
        });
    };

    /* ---------- skip link ---------- */

    const setupSkipLink = () => {
        const link = document.getElementById("a11ySkipToTorrents");
        if (link === null)
            return;
        link.addEventListener("click", (e) => {
            e.preventDefault();
            const row = document.querySelector("#torrentsTableDiv tbody tr.selected")
                ?? document.querySelector("#torrentsTableDiv tbody tr");
            row?.focus();
        });
    };

    /* ---------- entry point ---------- */

    const setup = () => {
        createLiveRegion();
        applyLandmarks();
        labelToolbarButtons();
        stripDecorativeAltText();
        setupMenubar();
        setupTabs();
        setupDialogManager();
        setupActionAnnouncements();
        setupSkipLink();
    };

    return exports();
})();
Object.freeze(window.qBittorrent.Accessibility);

document.addEventListener("DOMContentLoaded", () => {
    window.qBittorrent.Accessibility.setup();
});
