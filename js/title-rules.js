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
        let source = "";
        let title = "";
        if (selector) {
            try {
                title = textOf(document.querySelector(selector));
                if (title) source = "selector";
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
        const selHit = list.find((f) => f.source === "selector" && f.title);
        const best = selHit || top || list[0];
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

    async function resolveForTab(tabId, webInfo, extraUrls) {
        let pageUrl = (webInfo && webInfo.url) || "";
        if (!pageUrl && tabId) {
            try {
                const tab = await chrome.tabs.get(tabId);
                pageUrl = (tab && tab.url) || "";
                webInfo = webInfo || tab;
            } catch (_) {}
        }
        const cached = cache.get(tabId);
        if (cached && cached.pageUrl === pageUrl && cached.title) return cached;
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
        cache.set(tabId, picked);
        return picked;
    }

    function invalidate(tabId) {
        if (tabId == null) cache.clear();
        else cache.delete(tabId);
    }

    function applyToItems(list, resolved) {
        if (!list || !list.length || !resolved || !resolved.title) return 0;
        const incoming = sourceRank(resolved.source);
        let n = 0;
        for (let i = 0; i < list.length; i++) {
            const it = list[i];
            const cur = String(it.title || it.name || "");
            const weak = isWeak(cur, resolved.docTitle);
            const have = sourceRank(it._titleSource);
            if (!weak && incoming <= have) continue;
            if (!weak && incoming <= 10) continue;
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
        invalidate: invalidate,
        applyToItems: applyToItems,
    };
})();
