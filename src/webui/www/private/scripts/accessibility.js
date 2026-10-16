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
            openContextMenuAt: openContextMenuAt,
        };
    };

    const PANEL_POLL_INTERVAL_MS = 250;
    const PANEL_POLL_MAX_TRIES = 60;
    const DIALOG_FOCUS_RETRY_MS = [100, 400, 900];
    // the region is emptied first so a repeated message is re-announced
    const ANNOUNCE_DELAY_MS = 50;
    // stale messages would otherwise sit at the end of the page in browse mode
    const ANNOUNCEMENT_CLEAR_MS = 5000;
    const FILTER_LIST_IDS = ["statusFilterList", "categoryFilterList", "tagFilterList", "trackerFilterList"];
    const FILTER_PAGE_STEP = 10;
    const TYPEAHEAD_RESET_MS = 700;
    // an icon's alt only counts as a duplicate of short control text
    const REDUNDANT_ALT_MAX_TEXT = 80;

    let liveRegion = null;
    let announceTimer = -1;
    let clearTimer = -1;

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
        window.clearTimeout(announceTimer);
        window.clearTimeout(clearTimer);
        // clear first so an identical consecutive message is re-announced
        liveRegion.textContent = "";
        announceTimer = window.setTimeout(() => {
            liveRegion.textContent = message;
            clearTimer = window.setTimeout(() => {
                liveRegion.textContent = "";
            }, ANNOUNCEMENT_CLEAR_MS);
        }, ANNOUNCE_DELAY_MS);
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
            // the title keeps the image in the tree; the button already says it
            img.setAttribute("aria-hidden", "true");
        }

        // "Add Torrent File" is a <label> wrapping a hidden file input
        const uploadLabel = document.querySelector("#uploadButton label");
        if (uploadLabel !== null) {
            const img = uploadLabel.querySelector("img");
            uploadLabel.setAttribute("role", "button");
            uploadLabel.tabIndex = 0;
            uploadLabel.setAttribute("aria-label", img?.title || img?.alt || "");
            if (img !== null) {
                img.alt = "";
                img.setAttribute("aria-hidden", "true");
            }
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
                    // the item is about to become visibility:hidden; continue
                    // the Tab sequence from the trigger instead of from it
                    focusTrigger(Math.max(topItems.indexOf(li), 0));
                    break;
            }
        });

        document.getElementById("desktopNavbar").addEventListener("focusout", (e) => {
            if (!document.getElementById("desktopNavbar").contains(e.relatedTarget))
                closeAll();
        });
    };

    /* ---------- tab strips (main window, properties panel, log view) ---------- */

    const setupTablist = (listId, label) => {
        applyWhenPresent(listId, (list) => {
            list.setAttribute("role", "tablist");
            list.setAttribute("aria-label", label);

            const tabAnchors = () => [...list.querySelectorAll("li > a")]
                .filter((a) => a.closest("li").offsetParent !== null);

            const sync = () => {
                for (const a of list.querySelectorAll("li > a")) {
                    const selected = a.closest("li").classList.contains("selected");
                    a.closest("li").setAttribute("role", "none");
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
        });
    };

    /* ---------- pause auto-updates (WCAG 2.2.2) ---------- */

    const setupPauseToggle = () => {
        const button = document.createElement("button");
        button.id = "a11yPauseUpdatesButton";
        button.type = "button";
        button.setAttribute("aria-pressed", "false");
        button.setAttribute("aria-label", "Pause list updates");
        const img = document.createElement("img");
        img.src = "images/pause-session.svg";
        img.alt = "";
        img.width = 24;
        img.height = 24;
        button.append(img);
        button.addEventListener("click", () => {
            const paused = !window.qBittorrent.Client.isUIUpdatesPaused();
            window.qBittorrent.Client.setUIUpdatesPaused(paused);
            button.setAttribute("aria-pressed", paused ? "true" : "false");
            button.setAttribute("aria-label", paused ? "Resume list updates" : "Pause list updates");
            announce(paused ? "List updates paused" : "List updates resumed");
        });
        document.getElementById("preferencesButton")?.after(button);
    };

    /* ---------- toolbar roving focus ---------- */

    // The action buttons are one tab stop, moved between with the arrow keys
    // (ARIA toolbar pattern). The tabs, search box and selects that also sit
    // in #mochaToolbar keep their own stops.
    const setupToolbarRoving = () => {
        const toolbar = document.getElementById("mochaToolbar");
        const allButtons = () => [...toolbar.querySelectorAll("[role=\"button\"], #a11yPauseUpdatesButton")]
            .filter((button) => button.closest("#mainWindowTabs") === null);
        const buttons = () => allButtons().filter(isRendered);

        const setStop = (stop) => {
            for (const button of allButtons())
                button.tabIndex = (button === stop) ? 0 : -1;
        };
        setStop(buttons()[0]);

        // buttons can be hidden later (the queue buttons when queueing is off);
        // never leave the stop on one that can't be reached
        new MutationObserver(() => {
            const list = buttons();
            if (!list.some((button) => button.tabIndex === 0))
                setStop(list[0]);
        }).observe(toolbar, { subtree: true, attributes: true, attributeFilter: ["style", "class"] });

        toolbar.addEventListener("focusin", (e) => {
            if (buttons().includes(e.target))
                setStop(e.target);
        });
        toolbar.addEventListener("keydown", (e) => {
            const list = buttons();
            const index = list.indexOf(e.target);
            if (index === -1)
                return;
            let target = null;
            switch (e.key) {
                case "ArrowRight":
                    target = list[(index + 1) % list.length];
                    break;
                case "ArrowLeft":
                    target = list[(index - 1 + list.length) % list.length];
                    break;
                case "Home":
                    target = list[0];
                    break;
                case "End":
                    target = list.at(-1);
                    break;
                default:
                    return;
            }
            e.preventDefault();
            setStop(target);
            target.focus();
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
            const row = document.querySelector("#torrentsTableDiv tbody tr[tabindex=\"0\"]")
                ?? document.querySelector("#torrentsTableDiv tbody tr.selected")
                ?? document.querySelector("#torrentsTableDiv tbody tr");
            row?.focus();
        });
    };

    /* ---------- shared helpers ---------- */

    const setHidden = (element, hidden) => {
        if (element === null)
            return;
        if (hidden)
            element.setAttribute("aria-hidden", "true");
        else
            element.removeAttribute("aria-hidden");
    };

    const isRendered = (element) => element.getClientRects().length > 0;

    // context menus open on a "contextmenu" event at the pointer position;
    // synthesise one over the element for the ContextMenu key / Shift+F10
    const openContextMenuAt = (element) => {
        const rect = element.getBoundingClientRect();
        element.dispatchEvent(new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: rect.left + Math.min(40, (rect.width / 2)),
            clientY: rect.top + (rect.height / 2),
        }));
    };

    /* ---------- filter sidebar ---------- */

    // Each filter section becomes a toggle button plus a single-select
    // listbox. NVDA's browse mode renders a listbox as just its selected
    // option, so the four sections read as eight lines instead of a hundred,
    // and the filters become operable from the keyboard.

    const optionLabel = (li) => (li.getAttribute("aria-label") ?? li.textContent).trim();

    // what the option shows: a subcategory's leaf name, not its full path
    const optionVisibleText = (li) => (li.querySelector(":scope > .link")?.textContent ?? "").trim();

    const categoryOptionLabel = (li) => {
        const text = (li.querySelector(":scope > .link > span")?.textContent ?? li.textContent).trim();
        let label = text;
        // subcategories show only their last path segment; say the full path
        if (li.id.includes("/")) {
            const leaf = li.id.split("/").at(-1);
            if (text.startsWith(leaf))
                label = li.id + text.slice(leaf.length);
        }
        if (li.querySelector(":scope > ul") !== null) {
            const collapsed = li.classList.contains("collapsedCategory");
            label += collapsed ? ", collapsed" : ", expanded";
            if (collapsed && (li.querySelector(":scope > ul li.selectedFilter") !== null))
                label += ", contains the selected category";
        }
        return label;
    };

    const visibleFilterOptions = (list) => [...list.querySelectorAll("li[role=\"option\"]")].filter(isRendered);

    const syncFilterListbox = (list, title) => {
        title.setAttribute("aria-expanded", list.classList.contains("invisible") ? "false" : "true");

        let selected = null;
        for (const li of list.querySelectorAll("li")) {
            li.setAttribute("role", "option");
            const isSelected = li.classList.contains("selectedFilter");
            li.setAttribute("aria-selected", isSelected ? "true" : "false");
            if (isSelected)
                selected = li;
            // status icons repeat the text beside them
            for (const img of li.querySelectorAll(":scope > .link > img"))
                img.alt = "";
            // Left/Right expand and collapse instead of this pointer-only button
            const toggle = li.querySelector(":scope > .link > .categoryToggle");
            if (toggle !== null) {
                toggle.setAttribute("aria-hidden", "true");
                toggle.tabIndex = -1;
            }
            li.querySelector(":scope > ul")?.setAttribute("role", "none");
            if (list.id === "categoryFilterList")
                li.setAttribute("aria-label", categoryOptionLabel(li));
        }

        const visible = visibleFilterOptions(list);
        // a selected subcategory hidden by a collapsed parent hands the tab
        // stop to its nearest visible ancestor, which says what it contains
        let stop = selected;
        while ((stop !== null) && !isRendered(stop))
            stop = stop.parentElement?.closest("li[role=\"option\"]") ?? null;
        stop ??= visible[0] ?? null;
        for (const li of list.querySelectorAll("li"))
            li.tabIndex = (li === stop) ? 0 : -1;

        // nested category lists would otherwise number each level separately
        for (const [i, li] of visible.entries()) {
            li.setAttribute("aria-posinset", i + 1);
            li.setAttribute("aria-setsize", visible.length);
        }
    };

    const chooseFilterOption = (option) => {
        // reuse the sidebar's own click handling (Filters_pad listener)
        if (!option.classList.contains("selectedFilter"))
            option.querySelector(":scope > .link")?.click();
        option.focus();
        option.querySelector(":scope > .link")?.scrollIntoView({ block: "nearest" });
    };

    const makeFilterListbox = (list) => {
        const title = list.previousElementSibling;
        if ((title === null) || !title.classList.contains("filterTitle"))
            return;

        title.id = `a11y-${list.id}-title`;
        title.setAttribute("role", "button");
        title.tabIndex = 0;
        // the title is styled text-transform: uppercase, which Chromium copies
        // into the accessible name ("STATUS"); name it from the source text
        title.setAttribute("aria-label", title.textContent.trim());
        title.setAttribute("aria-controls", list.id);
        // the arrow only shows the expanded state, which aria-expanded carries
        const arrow = title.querySelector("img");
        if (arrow !== null)
            arrow.alt = "";
        title.addEventListener("keydown", (e) => {
            if ((e.key !== "Enter") && (e.key !== " "))
                return;
            e.preventDefault();
            title.click();
        });

        list.setAttribute("role", "listbox");
        list.setAttribute("aria-labelledby", title.id);

        // client.js rebuilds the category/tag/tracker lists wholesale when
        // their contents change; put focus back on the same entry if it was
        // lost with the old elements
        let listHasFocus = false;
        let lastFocusedId = null;
        list.addEventListener("focusin", (e) => {
            const li = e.target.closest("li[role=\"option\"]");
            if (li === null)
                return;
            listHasFocus = true;
            lastFocusedId = li.id;
        });
        list.addEventListener("focusout", (e) => {
            if ((e.relatedTarget !== null) && list.contains(e.relatedTarget))
                return;
            const target = e.target;
            // a focused option removed by a rebuild is not the user leaving
            queueMicrotask(() => {
                if (target.isConnected)
                    listHasFocus = false;
            });
        });

        const sync = () => syncFilterListbox(list, title);
        sync();
        new MutationObserver((mutations) => {
            sync();
            const rebuilt = mutations.some((mutation) => mutation.type === "childList");
            if (!rebuilt || !listHasFocus || list.contains(document.activeElement))
                return;
            const options = [...list.querySelectorAll("li[role=\"option\"]")];
            const replacement = options.find((li) => (li.id === lastFocusedId) && isRendered(li))
                ?? list.querySelector("li[tabindex=\"0\"]");
            replacement?.focus({ preventScroll: true });
        }).observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });

        let typeahead = "";
        let typeaheadTimer = -1;

        list.addEventListener("keydown", (e) => {
            const li = e.target.closest("li[role=\"option\"]");
            if ((li === null) || !list.contains(li))
                return;
            const visible = visibleFilterOptions(list);
            const index = visible.indexOf(li);
            const last = visible.length - 1;
            let target = null;

            switch (e.key) {
                case "ArrowDown":
                    target = visible[Math.min(index + 1, last)];
                    break;
                case "ArrowUp":
                    target = visible[Math.max(index - 1, 0)];
                    break;
                case "Home":
                    target = visible[0];
                    break;
                case "End":
                    target = visible[last];
                    break;
                case "PageDown":
                    target = visible[Math.min(index + FILTER_PAGE_STEP, last)];
                    break;
                case "PageUp":
                    target = visible[Math.max(index - FILTER_PAGE_STEP, 0)];
                    break;
                case "ArrowRight":
                case "ArrowLeft": {
                    const toggle = li.querySelector(":scope > .link > .categoryToggle");
                    const hasChildren = li.querySelector(":scope > ul") !== null;
                    const collapsed = li.classList.contains("collapsedCategory");
                    if ((toggle !== null) && hasChildren && (collapsed === (e.key === "ArrowRight"))) {
                        e.preventDefault();
                        toggle.click();
                    }
                    else if (e.key === "ArrowLeft") {
                        target = li.parentElement?.closest("li[role=\"option\"]") ?? null;
                    }
                    break;
                }
                case "Enter":
                case " ":
                    target = li;
                    break;
                case "ContextMenu":
                    e.preventDefault();
                    openContextMenuAt(li);
                    return;
                case "F10":
                    if (e.shiftKey) {
                        e.preventDefault();
                        openContextMenuAt(li);
                    }
                    return;
                default:
                    if ((e.key.length === 1) && !e.ctrlKey && !e.altKey && !e.metaKey && (e.key !== " ")) {
                        window.clearTimeout(typeaheadTimer);
                        typeahead += e.key.toLowerCase();
                        typeaheadTimer = window.setTimeout(() => {
                            typeahead = "";
                        }, TYPEAHEAD_RESET_MS);
                        // a repeated single letter cycles through its matches
                        const query = ((typeahead.length > 1) && [...typeahead].every((c) => c === typeahead[0])) ? typeahead[0] : typeahead;
                        const start = (query.length === 1) ? index + 1 : index;
                        const ordered = [...visible.slice(start), ...visible.slice(0, start)];
                        target = ordered.find((option) => optionLabel(option).toLowerCase().startsWith(query)
                            || optionVisibleText(option).toLowerCase().startsWith(query)) ?? null;
                    }
                    break;
            }

            if (target === undefined || target === null)
                return;
            e.preventDefault();
            chooseFilterOption(target);
        });
    };

    const setupFilterListboxes = () => {
        // the panel scrolls; Firefox would otherwise make the scroller itself a
        // tab stop in front of the filter controls
        applyWhenPresent("Filters", (panel) => {
            panel.tabIndex = -1;
        });
        // the last list in filters.html; all four exist once it does
        applyWhenPresent("trackerFilterList", () => {
            for (const id of FILTER_LIST_IDS) {
                const list = document.getElementById(id);
                if (list !== null)
                    makeFilterListbox(list);
            }
        });
    };

    /* ---------- torrent details panel ---------- */

    // The General tab is two layout tables of label/value cells that are all
    // empty until a torrent is selected. Read it as label/value lines and
    // leave out every label that has nothing next to it.
    const syncGeneralTab = (general) => {
        for (const label of general.querySelectorAll("td.generalLabel")) {
            const value = label.nextElementSibling;
            const empty = (value === null) || (value.textContent.trim() === "");
            setHidden(label, empty);
            setHidden(value, empty);
        }
        for (const fieldset of general.querySelectorAll("fieldset")) {
            const anyValue = [...fieldset.querySelectorAll("td.generalLabel")]
                .some((label) => label.getAttribute("aria-hidden") !== "true");
            setHidden(fieldset, !anyValue);
        }
        // the bars are canvases; the percentage next to them carries the value
        for (const [labelSelector, valueId] of [["#propBarsWrapper > .propBarLabel", "progressPercentage"], ["#propAvailabilityWrapper > .propBarLabel", "averageAvailability"]]) {
            const value = document.getElementById(valueId);
            setHidden(general.querySelector(labelSelector), (value === null) || (value.textContent.trim() === ""));
        }
    };

    const setupDetailsPanel = () => {
        applyWhenPresent("propGeneral", (general) => {
            for (const table of general.querySelectorAll("table"))
                table.setAttribute("role", "presentation");
            setHidden(general.querySelector("hr"), true);
            syncGeneralTab(general);
            new MutationObserver(() => syncGeneralTab(general))
                .observe(general, { childList: true, characterData: true, subtree: true });
        });

        // the panel's collapse arrow, so the whole details area can be put away
        // (MochaUI remembers the state)
        applyWhenPresent("propertiesPanel_collapseToggle", (toggle) => {
            toggle.setAttribute("role", "button");
            toggle.tabIndex = 0;
            toggle.setAttribute("aria-label", "Torrent details");
            const sync = () => toggle.setAttribute("aria-expanded", toggle.classList.contains("panel-expand") ? "false" : "true");
            sync();
            new MutationObserver(sync).observe(toggle, { attributes: true, attributeFilter: ["class"] });
            toggle.addEventListener("keydown", (e) => {
                if ((e.key !== "Enter") && (e.key !== " "))
                    return;
                e.preventDefault();
                toggle.click();
            });
        });
    };

    /* ---------- status bar ---------- */

    const setupStatusBar = () => {
        const footer = document.getElementById("desktopFooter");
        footer.querySelector("table")?.setAttribute("role", "presentation");
        for (const separator of footer.querySelectorAll(".statusBarSeparator"))
            setHidden(separator, true);

        // the speed icons' alt text was "Download speed icon"; say what the figure is
        for (const [infoId, label] of [["DlInfos", "Download speed:"], ["UpInfos", "Upload speed:"]]) {
            const info = document.getElementById(infoId);
            if (info === null)
                continue;
            const icon = info.previousElementSibling;
            if (icon?.tagName === "IMG")
                icon.alt = "";
            const prefix = document.createElement("span");
            prefix.className = "a11y-sr-only";
            prefix.textContent = `${label} `;
            info.before(prefix);
        }

        // alternative speed limits toggle: a clickable image (client.js keeps its alt current)
        const altSpeed = document.getElementById("alternativeSpeedLimits");
        if (altSpeed !== null) {
            altSpeed.setAttribute("role", "button");
            altSpeed.tabIndex = 0;
            altSpeed.addEventListener("keydown", (e) => {
                if ((e.key !== "Enter") && (e.key !== " "))
                    return;
                e.preventDefault();
                altSpeed.click();
            });
        }
    };

    /* ---------- torrent filter toolbar ---------- */

    const setupFilterToolbar = () => {
        // the regex checkbox is now focusable (accessibility.css); its label
        // is a drawn button, so name the checkbox and keep the label silent
        const regexBox = document.getElementById("torrentsFilterRegexBox");
        const regexLabel = document.querySelector("label[for=\"torrentsFilterRegexBox\"]");
        if ((regexBox !== null) && (regexLabel !== null)) {
            regexBox.setAttribute("aria-label", regexLabel.getAttribute("aria-label") ?? "Use regular expression");
            setHidden(regexLabel, true);
        }

        // "Filter by:" was read as text and again as the select's name
        const select = document.getElementById("torrentsFilterSelect");
        const selectLabel = document.querySelector("label[for=\"torrentsFilterSelect\"]");
        if ((select !== null) && (selectLabel !== null)) {
            select.setAttribute("aria-label", selectLabel.textContent.trim().replace(/:$/, ""));
            setHidden(selectLabel, true);
        }
    };

    /* ---------- redundant image text ---------- */

    // An icon whose alt repeats the text beside it is read twice ("General
    // General", "SearchSearch"). Empty such alts now and in panels that
    // MochaUI loads later.
    const REDUNDANT_ALT_PARENTS = new Set(["A", "BUTTON", "LABEL", "LI", "SPAN"]);

    const stripRedundantAlt = (root) => {
        const images = (root.tagName === "IMG") ? [root] : root.querySelectorAll("img[alt]");
        for (const img of images) {
            const alt = img.getAttribute("alt")?.trim().toLowerCase();
            const parent = img.parentElement;
            if (!alt || (parent === null) || !REDUNDANT_ALT_PARENTS.has(parent.tagName))
                continue;
            const text = parent.textContent.trim().toLowerCase();
            if ((text !== "") && (text.length <= REDUNDANT_ALT_MAX_TEXT) && text.includes(alt))
                img.alt = "";
        }
    };

    const setupRedundantAltCleanup = () => {
        stripRedundantAlt(document.body);
        new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    // table rows are named by their composed aria-label, and
                    // they are added often; leave them alone
                    if ((node.nodeType === Node.ELEMENT_NODE) && (node.closest(".dynamicTableDiv tbody") === null))
                        stripRedundantAlt(node);
                }
            }
        }).observe(document.body, { childList: true, subtree: true });
    };

    /* ---------- entry point ---------- */

    const setup = () => {
        createLiveRegion();
        applyLandmarks();
        labelToolbarButtons();
        stripDecorativeAltText();
        setupMenubar();
        setupTablist("mainWindowTabsList", "Main window tabs");
        setupTablist("propertiesTabs", "Torrent details tabs");
        setupTablist("panelTabs", "Log tabs");
        setupPauseToggle();
        setupToolbarRoving();
        setupDialogManager();
        setupActionAnnouncements();
        setupSkipLink();
        setupFilterListboxes();
        setupDetailsPanel();
        setupStatusBar();
        setupFilterToolbar();
        setupRedundantAltCleanup();
    };

    return exports();
})();
Object.freeze(window.qBittorrent.Accessibility);

document.addEventListener("DOMContentLoaded", () => {
    window.qBittorrent.Accessibility.setup();
});
