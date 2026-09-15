/**
 * Page title for sniffed media: site rule (host+path + CSS selector)
 * then og:title / JSON-LD / video / h1 / document.title.
 * Works in service worker (importScripts) and popup / local-media pages.
 */
var TitleRules = (function () {
    const cache = new Map();

    function hostFromUrl(raw) {
        try {
            let s = String(raw || "").trim();
            if (!s) return "";
            if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = "https://" + s;
            return new URL(s).hostname.replace(/^www\./i, "").toLowerCase();
        } catch (_) {
            return String(raw || "")
                .replace(/^www\./i, "")
                .split("/")[0]
                .toLowerCase();
        }
    }

    function pathFromUrl(raw) {
        try {
            let s = String(raw || "").trim();
            if (!s) return "";
            if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) {
                if (s.startsWith("/")) return normalizePath(s);
                s = "https://" + s;
            }
            return normalizePath(new URL(s).pathname || "/");
        } catch (_) {
            const m = String(raw || "").match(/\/[^?#]*/);
            return m ? normalizePath(m[0]) : "";
        }
    }

    function normalizePath(p) {
        let s = String(p || "/");
        if (!s.startsWith("/")) s = "/" + s;
        s = s.replace(/\/{2,}/g, "/");
        if (s.length > 1) s = s.replace(/\/+$/, "");
        return s;
    }

    /** First path segment as default constraint: /watch/id → /watch */
    function defaultPathPrefix(raw) {
        const full = pathFromUrl(raw);
        if (!full || full === "/") return "";
        const segs = full.split("/").filter(Boolean);
        if (!segs.length) return "";
        const first = segs[0];
        if (/^[\da-f]{8,}$/i.test(first) || /^\d{6,}$/.test(first)) return "";
        return "/" + first;
    }

    function cleanRule(r) {
        if (!r) return null;
        const host = hostFromUrl(r.host);
        const selector = String(r.selector || "").trim();
        if (!host || !selector) return null;
        let path = String(r.path || "").trim();
        if (path && !path.startsWith("/") && !path.includes("*")) {
            path = pathFromUrl(path) || normalizePath("/" + path);
        } else if (path) {
            path = normalizePath(path.split("?")[0]);
        }
        return {
            host,
            path: path === "/" ? "" : path,
            selector,
            regex: String(r.regex || "").trim(),
        };
    }

    function getRules() {
        const raw = (typeof G !== "undefined" && Array.isArray(G.lmwTitleRules) && G.lmwTitleRules) || [];
        return raw.map(cleanRule).filter(Boolean);
    }

    function persist(rules) {
        const clean = (rules || []).map(cleanRule).filter(Boolean);
        if (typeof G !== "undefined") G.lmwTitleRules = clean;
        try {
            chrome.storage.sync.set({ lmwTitleRules: clean });
            chrome.storage.local.set({ lmwTitleRules: clean });
        } catch (_) {}
        cache.clear();
        return clean;
    }

    function hostMatches(pageHost, ruleHost) {
        return pageHost === ruleHost || pageHost.endsWith("." + ruleHost);
    }

    function pathMatches(pagePath, rulePath) {
        if (!rulePath) return true;
        const p = normalizePath(pagePath || "/");
        const r = normalizePath(rulePath);
        if (r.indexOf("*") >= 0) {
            let re = "^";
            for (let i = 0; i < r.length; i++) {
                const ch = r[i];
                if (ch === "*") re += ".*";
                else if ("\\^$+?.()|[]{}".indexOf(ch) >= 0) re += "\\" + ch;
                else re += ch;
            }
            re += "(?:/.*)?$";
            try {
                return new RegExp(re, "i").test(p);
            } catch (_) {
                return p === r || p.startsWith(r + "/");
            }
        }
        return p === r || p.startsWith(r + "/");
    }

    function ruleScore(rule) {
        return (rule.host || "").length * 10 + (rule.path || "").length;
    }

    function matchOne(url) {
        const h = hostFromUrl(url);
        const p = pathFromUrl(url);
        if (!h) return null;
        let best = null;
        for (const r of getRules()) {
            if (!hostMatches(h, r.host)) continue;
            if (!pathMatches(p, r.path)) continue;
            if (!best || ruleScore(r) > ruleScore(best)) best = r;
        }
        return best;
    }

    function matchRule(pageUrl, extraUrls) {
        let best = matchOne(pageUrl);
        if (extraUrls) {
            for (const u of extraUrls) {
                const r = matchOne(u);
                if (r && (!best || ruleScore(r) > ruleScore(best))) best = r;
            }
        }
        return best;
    }

    function isWeak(t, docTitle) {
        const s = String(t || "").replace(/\s+/g, " ").trim();
        if (!s || s === "NULL") return true;
        if (docTitle && s === String(docTitle).replace(/\s+/g, " ").trim()) return true;
        if (/^https?:\/\//i.test(s)) return true;
        if (/\.(mp4|m3u8|mpd|webm|m4a|ts)(\?|#|$)/i.test(s)) return true;
        return false;
    }

    /** selector beats generic og/jsonld/h1/document */
    function sourceRank(s) {
        if (s === "selector") return 50;
        if (s === "og" || s === "jsonld") return 30;
        if (s === "video" || s === "h1") return 20;
        if (s === "document" || s === "page") return 10;
        return 0;
    }

    /** Must stay self-contained: injected via chrome.scripting.executeScript. */
    function PAGE_TITLE_FN(opts) {
        const selector = (opts && opts.selector) || "";
        const regexStr = (opts && opts.regex) || "";
        const textOf = (el) => {
            if (!el) return "";
            const c = el.getAttribute && (el.getAttribute("content") || el.getAttribute("title"));
            if (c && String(c).trim()) return String(c).replace(/\s+/g, " ").trim();
            return String(el.textContent || el.innerText || "").replace(/\s+/g, " ").trim();
        };
        const fromJsonLd = () => {
            try {
                const nodes = document.querySelectorAll('script[type="application/ld+json"]');
                for (const s of nodes) {
                    let j;
                    try {
                        j = JSON.parse(s.textContent || "null");
                    } catch (_) {
                        continue;
                    }
                    const stack = Array.isArray(j) ? j.slice() : [j];
                    while (stack.length) {
                        const n = stack.pop();
                        if (!n || typeof n !== "object") continue;
                        const typ = String(n["@type"] || "");
                        if (/VideoObject|Movie|TVEpisode|TVSeries|CreativeWork/i.test(typ) && n.name) {
                            return String(n.name).replace(/\s+/g, " ").trim();
                        }
                        if (n.headline) return String(n.headline).replace(/\s+/g, " ").trim();
                        if (n["@graph"]) {
                            const g = Array.isArray(n["@graph"]) ? n["@graph"] : [n["@graph"]];
                            for (let i = 0; i < g.length; i++) stack.push(g[i]);
                        }
                    }
                }
            } catch (_) {}
            return "";
        };
        const collectSel = (root, sel, out) => {
            try {
                const nodes = root.querySelectorAll(sel);
                for (let i = 0; i < nodes.length; i++) out.push(nodes[i]);
            } catch (_) {}
        };
        const pageItemId = (() => {
            try {
                const u = new URL(location.href);
                return (
                    u.searchParams.get("modal_id") ||
                    u.searchParams.get("aweme_id") ||
                    u.searchParams.get("item_id") ||
                    ""
                );
            } catch (_) {
                return "";
            }
        })();
        const ancestorHasId = (el, id) => {
            if (!el || !id) return false;
            let n = el;
            let depth = 0;
            while (n && n !== document && depth < 28) {
                if (n.getAttribute) {
                    const attrs = n.attributes;
                    if (attrs) {
                        for (let i = 0; i < attrs.length; i++) {
                            if (String(attrs[i].value || "").indexOf(id) >= 0) return true;
                        }
                    }
                    if (String(n.id || "").indexOf(id) >= 0) return true;
                }
                n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
                depth++;
            }
            return false;
        };
        const isShown = (el) => {
            const r = el.getBoundingClientRect && el.getBoundingClientRect();
            if (!r || r.width < 2 || r.height < 2) return false;
            const vw = window.innerWidth || 1;
            const vh = window.innerHeight || 1;
            if (r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) return false;
            const st = window.getComputedStyle ? window.getComputedStyle(el) : null;
            if (st && (st.display === "none" || st.visibility === "hidden" || st.opacity === "0")) return false;
            return true;
        };
        const stackZ = (el) => {
            let z = 0;
            let n = el;
            let depth = 0;
            while (n && n !== document && depth < 20) {
                const st = window.getComputedStyle ? window.getComputedStyle(n) : null;
                const zi = st ? parseInt(st.zIndex, 10) : NaN;
                if (!isNaN(zi)) z = Math.max(z, zi);
                n = n.parentElement;
                depth++;
            }
            return z;
        };
        const queryDeep = (sel) => {
            sel = String(sel || "").replace(/#([A-Za-z_][\w-]*)/g, '[id="$1"]');
            const found = [];
            collectSel(document, sel, found);
            const all = document.querySelectorAll("*");
            for (let i = 0; i < all.length; i++) {
                if (all[i].shadowRoot) collectSel(all[i].shadowRoot, sel, found);
            }
            if (!found.length) return null;
            if (pageItemId) {
                for (let i = found.length - 1; i >= 0; i--) {
                    if (ancestorHasId(found[i], pageItemId) && textOf(found[i])) return found[i];
                }
            }
            let best = null;
            let bestZ = -1;
            let bestI = -1;
            for (let i = 0; i < found.length; i++) {
                if (!isShown(found[i])) continue;
                const z = stackZ(found[i]);
                if (z > bestZ || (z === bestZ && i >= bestI)) {
                    bestZ = z;
                    bestI = i;
                    best = found[i];
                }
            }
            if (best) return best;
            return found[found.length - 1];
        };
        const selectorCandidates = (sel) => {
            const s = String(sel || "").trim();
            if (!s) return [];
            const out = [];
            const push = (x) => {
                const t = String(x || "")
                    .replace(/\s+/g, " ")
                    .replace(/\s*>\s*/g, " > ")
                    .replace(/>\s*>/g, ">")
                    .trim();
                if (t && out.indexOf(t) < 0) out.push(t);
                const alt = t.replace(/#([A-Za-z_][\w-]*)/g, '[id="$1"]');
                if (alt && alt !== t && out.indexOf(alt) < 0) out.push(alt);
            };
            push(s);
            push(s.replace(/:nth-(?:child|of-type)\(\d+\)/gi, ""));
            push(
                s.replace(/:nth-(?:child|of-type)\(\d+\)/gi, "").replace(/\.[A-Z][A-Za-z0-9_-]{4,}\b/g, "")
            );
            const parts = s.split(/\s*>\s*/);
            if (parts.length > 1) {
                for (let n = parts.length - 1; n >= 1; n--) {
                    push(parts.slice(0, n).join(" > "));
                    const head = parts[n - 1] || "";
                    if (/#/.test(head) || /\.title\b/i.test(head) || /video-info|data-e2e/i.test(head)) break;
                }
            }
            return out;
        };
        let source = "";
        let title = "";
        if (selector) {
            try {
                const cands = selectorCandidates(selector);
                for (let i = 0; i < cands.length; i++) {
                    title = textOf(queryDeep(cands[i]));
                    if (title) {
                        source = "selector";
                        break;
                    }
                }
            } catch (_) {
                source = "selector-error";
            }
        }
        if (!title) {
            title =
                (document.querySelector('meta[property="og:title"]') &&
                    document.querySelector('meta[property="og:title"]').getAttribute("content")) ||
                (document.querySelector('meta[name="twitter:title"]') &&
                    document.querySelector('meta[name="twitter:title"]').getAttribute("content")) ||
                (document.querySelector('meta[name="og:title"]') &&
                    document.querySelector('meta[name="og:title"]').getAttribute("content")) ||
                "";
            title = String(title).replace(/\s+/g, " ").trim();
            if (title) source = "og";
        }
        if (!title) {
            title = fromJsonLd();
            if (title) source = "jsonld";
        }
        if (!title) {
            title = textOf(document.querySelector("video[title], video[aria-label]"));
            if (title) source = "video";
        }
        if (!title) {
            title = textOf(document.querySelector("h1"));
            if (title) source = "h1";
        }
        if (!title) {
            title = String(document.title || "").replace(/\s+/g, " ").trim();
            source = "document";
        }
        if (regexStr && title) {
            try {
                const m = title.match(new RegExp(regexStr));
                if (m) title = String(m[1] || m[0] || title).replace(/\s+/g, " ").trim();
            } catch (_) {}
        }
        return {
            title: String(title || "").slice(0, 240),
            source: source,
            pageUrl: location.href,
            docTitle: String(document.title || "").slice(0, 240),
            isTop: window === window.top,
        };
    }

    function pickExtract(frames, pageUrl) {
        const list = (frames || []).filter(Boolean);
        const top = list.find((f) => f.isTop) || list[0];
        const selHits = list.filter((f) => f.source === "selector" && f.title);
        const topSel = selHits.find((f) => f.isTop);
        const best = topSel || selHits[selHits.length - 1] || top || list[0];
        if (!best) return { title: "", source: "", docTitle: "", pageUrl: pageUrl || "" };
        return {
            title: best.title || "",
            source: best.source || "",
            docTitle: (top && top.docTitle) || best.docTitle || "",
            pageUrl: (top && top.pageUrl) || best.pageUrl || pageUrl || "",
        };
    }

    async function extractOnTab(tabId, opts) {
        if (!tabId) return { title: "", source: "", docTitle: "", pageUrl: "" };
        const results = await chrome.scripting.executeScript({
            target: { tabId: tabId, allFrames: true },
            func: PAGE_TITLE_FN,
            args: [{ selector: (opts && opts.selector) || "", regex: (opts && opts.regex) || "" }],
        });
        return pickExtract(
            (results || []).map((r) => r && r.result),
            opts && opts.pageUrl
        );
    }

    async function hydrateRules() {
        if (getRules().length) return;
        try {
            const st = await chrome.storage.sync.get("lmwTitleRules");
            if (st && Array.isArray(st.lmwTitleRules) && typeof G !== "undefined") {
                G.lmwTitleRules = st.lmwTitleRules;
            }
        } catch (_) {}
    }

    async function resolveForTab(tabId, webInfo, extraUrls) {
        await hydrateRules();
        let pageUrl = (webInfo && webInfo.url) || "";
        if (tabId) {
            try {
                const tab = await chrome.tabs.get(tabId);
                if (tab && tab.url) {
                    if (!pageUrl || /modal_id=|aweme_id=/.test(tab.url)) pageUrl = tab.url;
                    webInfo = webInfo || tab;
                }
            } catch (_) {}
        }
        const cached = cache.get(tabId);
        const rulePeek = matchRule(pageUrl, extraUrls);
        if (
            cached &&
            cached.pageUrl === pageUrl &&
            cached.title &&
            (!rulePeek || cached.source === "selector")
        ) {
            return cached;
        }
        const extra = [];
        if (webInfo && webInfo.pendingUrl) extra.push(webInfo.pendingUrl);
        if (extraUrls && extraUrls.length) {
            for (let i = 0; i < extraUrls.length; i++) extra.push(extraUrls[i]);
        }
        const rule = matchRule(pageUrl, extra);
        let picked = { title: "", source: "", docTitle: (webInfo && webInfo.title) || "", pageUrl: pageUrl };
        try {
            picked = await extractOnTab(tabId, {
                selector: (rule && rule.selector) || "",
                regex: (rule && rule.regex) || "",
                pageUrl: pageUrl,
            });
        } catch (e) {
            picked.title = (webInfo && webInfo.title) || "";
            picked.source = "document";
        }
        if (rule) picked.ruleHost = rule.host;
        if (rule) picked.rulePath = rule.path;
        if (!rule || picked.source === "selector") cache.set(tabId, picked);
        else cache.delete(tabId);
        return picked;
    }

    function invalidate(tabId) {
        if (tabId == null) cache.clear();
        else cache.delete(tabId);
    }

    function applyToItems(list, resolved) {
        if (!list || !list.length || !resolved || !resolved.title) return 0;
        let n = 0;
        for (let i = 0; i < list.length; i++) {
            const it = list[i];
            const cur = String(it.title || it._title || it.name || "");
            if (!isWeak(cur, resolved.docTitle)) continue;
            it.title = resolved.title;
            if (it._title !== undefined) it._title = resolved.title;
            it._titleSource = resolved.source || "page";
            n++;
        }
        return n;
    }

    return {
        hostFromUrl: hostFromUrl,
        pathFromUrl: pathFromUrl,
        defaultPathPrefix: defaultPathPrefix,
        getRules: getRules,
        persist: persist,
        cleanRule: cleanRule,
        matchRule: matchRule,
        isWeak: isWeak,
        sourceRank: sourceRank,
        PAGE_TITLE_FN: PAGE_TITLE_FN,
        extractOnTab: extractOnTab,
        resolveForTab: resolveForTab,
        hydrateRules: hydrateRules,
        invalidate: invalidate,
        applyToItems: applyToItems,
    };
})();
