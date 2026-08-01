/**
 * Extensible site drivers for convention scraper.
 *
 * IMPORTANT: chrome.scripting.executeScript only serializes the single `func`
 * argument — every injected entry must be fully self-contained.
 *
 * Douyin strategy (not “scroll a bit”):
 *  1) On list/feed pages: harvest /video/ IDs from DOM + HTML
 *  2) chrome.tabs.update into each video URL (real navigation → media requests)
 *  3) On player page: swipe/wheel/key “next” to switch vertical feed
 *  4) When queue empty: return to list URL, scroll to load more cards, re-harvest
 */
(function (global) {
    "use strict";

    async function execInTab(tabId, func, args = []) {
        const run = async (world) => {
            const opts = {
                target: { tabId, allFrames: false },
                func,
                args,
            };
            if (world) opts.world = world;
            const results = await chrome.scripting.executeScript(opts);
            const r = results && results[0] ? results[0].result : null;
            if (r == null && results && results[0] && results[0].error) {
                return { ok: false, error: String(results[0].error) };
            }
            return r;
        };
        try {
            return await run("MAIN");
        } catch (e1) {
            try {
                return await run("ISOLATED");
            } catch (e2) {
                try {
                    return await run(undefined);
                } catch (e3) {
                    return {
                        ok: false,
                        error: String(
                            (e1 && e1.message) ||
                                (e2 && e2.message) ||
                                (e3 && e3.message) ||
                                e3
                        ),
                    };
                }
            }
        }
    }

    function sleep(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }

    /**
     * Douyin left-nav → real route (from live UI: 推荐 → /?recommend=1).
     * Prefer chrome.tabs.update to these URLs; synthetic click on React often no-ops.
     */
    function resolveDouyinNavUrl(label, origin) {
        const raw = String(label || "").trim();
        if (!raw) return null;
        const key = raw.replace(/\s+/g, "").replace(/\d+/g, "");
        const base = (origin || "https://www.douyin.com").replace(/\/$/, "");
        const map = {
            推荐: base + "/?recommend=1",
            精选: base + "/jingxuan",
            关注: base + "/follow",
            朋友: base + "/friend",
            好友: base + "/friend",
            直播: base + "/live",
            我的: base + "/user/self",
            放映厅: base + "/vs",
            热点: base + "/hot",
            AI抖音: base + "/ai",
            搜索: base + "/search/",
        };
        if (map[raw] || map[key]) return map[raw] || map[key];
        // already a path/url
        if (/^https?:\/\//i.test(raw)) return raw;
        if (raw.startsWith("/")) return base + raw;
        return null;
    }

    function isOnNavTarget(href, label) {
        const h = String(href || "");
        const key = String(label || "").replace(/\s+/g, "").replace(/\d+/g, "");
        // Douyin may keep or drop query; accept several forms
        if (key === "推荐") {
            return (
                /recommend=1/i.test(h) ||
                /[?&#]recommend\b/i.test(h) ||
                /\/recommend\b/i.test(h)
            );
        }
        if (key === "精选") return /\/jingxuan/i.test(h) || /精选/.test(h);
        if (key === "关注") return /\/follow/i.test(h);
        if (key === "朋友" || key === "好友") return /\/friend/i.test(h);
        if (key === "直播") return /\/live/i.test(h);
        if (key === "我的") return /\/user\//i.test(h);
        return false;
    }

    /**
     * Probe left rail labels (debug) + try click / XPath / href.
     * Self-contained (no outer free vars — executeScript serializes only this fn).
     * arg: { label, forceUrl }
     */
    function pageClickNavTab(opts) {
        const label = String((opts && opts.label) || "").trim();
        const forceUrl = opts && opts.forceUrl;
        if (!label && !forceUrl) {
            return { ok: false, action: "nav_tab", error: "empty_label" };
        }

        const onTarget = (href, lab) => {
            const h = String(href || "");
            const key = String(lab || "").replace(/\s+/g, "").replace(/\d+/g, "");
            if (key === "推荐") {
                return /recommend=1/i.test(h) || /[?&#]recommend\b/i.test(h) || /\/recommend\b/i.test(h);
            }
            if (key === "精选") return /\/jingxuan/i.test(h);
            if (key === "关注") return /\/follow/i.test(h);
            if (key === "朋友" || key === "好友") return /\/friend/i.test(h);
            if (key === "直播") return /\/live/i.test(h);
            if (key === "我的") return /\/user\//i.test(h);
            return false;
        };

        /**
         * Find tightest left-rail node whose own/near text is exactly the label.
         * Douyin React 必须点到这个节点，光改 URL 侧栏高亮/Feed 不一定切换。
         */
        const findExactLeftLabel = () => {
            let best = null;
            let bestScore = -1e9;
            const nodes = document.querySelectorAll("a, button, div, span, li, p, label");
            for (const el of nodes) {
                const r = el.getBoundingClientRect();
                if (r.left > 220 || r.width < 6 || r.height < 6) continue;
                if (r.top < 40 || r.top > (window.innerHeight || 900) - 20) continue;
                if (r.width > 200 || r.height > 64) continue;
                // prefer direct text ≈ label (not whole menu block)
                let own = "";
                try {
                    own = Array.from(el.childNodes)
                        .filter((n) => n.nodeType === 3)
                        .map((n) => n.textContent)
                        .join("");
                } catch (_) {}
                const full = (el.textContent || "").trim();
                const nOwn = norm(own);
                const nFull = norm(full);
                if (nOwn !== want && nFull !== want) {
                    // allow "推荐" inside short container
                    if (!(nFull.includes(want) && nFull.length <= want.length + 4)) continue;
                }
                let score = 0;
                if (nOwn === want) score += 100;
                if (nFull === want) score += 80;
                score += Math.max(0, 50 - r.left); // more left better
                score -= r.width * r.height * 0.001; // smaller better
                // avoid giant parents
                if (r.height > 48) score -= 20;
                if (score > bestScore) {
                    bestScore = score;
                    best = el;
                }
            }
            return best;
        };

        const norm = (s) =>
            String(s || "")
                .replace(/\s+/g, "")
                .replace(/[0-9]+/g, "")
                .trim();
        const want = norm(label);

        // --- dump left-rail short texts for logs ---
        const leftLabels = [];
        try {
            const all = document.querySelectorAll("a, button, div, span, li, p");
            for (const el of all) {
                const r = el.getBoundingClientRect();
                if (r.left > 260 || r.width < 8 || r.height < 8) continue;
                if (r.top < 0 || r.top > (window.innerHeight || 900)) continue;
                if (r.width > 240 || r.height > 72) continue;
                const t = norm(el.textContent);
                if (!t || t.length > 12) continue;
                if (!leftLabels.includes(t) && leftLabels.length < 30) leftLabels.push(t);
            }
        } catch (_) {}

        // --- 1) ALWAYS try real click on left-rail exact label first ---
        // Log shows leftLabels includes 推荐 even when urlMatch fails; SPA needs the click.
        const exact = findExactLeftLabel();
        if (exact) {
            let el = exact;
            const a = exact.closest && exact.closest("a[href]");
            if (a) el = a;
            else {
                let p = exact.parentElement;
                for (let i = 0; i < 3 && p; i++) {
                    const pr = p.getBoundingClientRect();
                    if (pr.left < 220 && pr.width < 220 && pr.height < 72) el = p;
                    p = p.parentElement;
                }
            }
            try {
                el.scrollIntoView({ block: "center", behavior: "auto" });
            } catch (_) {}
            const r = el.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            const baseEv = {
                bubbles: true,
                cancelable: true,
                view: window,
                clientX: cx,
                clientY: cy,
                button: 0,
                buttons: 1,
            };
            try {
                el.dispatchEvent(
                    new PointerEvent("pointerdown", Object.assign({}, baseEv, { pointerId: 1, pointerType: "mouse", isPrimary: true }))
                );
            } catch (_) {}
            try {
                el.dispatchEvent(new MouseEvent("mousedown", baseEv));
            } catch (_) {}
            try {
                el.dispatchEvent(
                    new PointerEvent("pointerup", Object.assign({}, baseEv, { buttons: 0, pointerId: 1, pointerType: "mouse", isPrimary: true }))
                );
            } catch (_) {}
            try {
                el.dispatchEvent(new MouseEvent("mouseup", Object.assign({}, baseEv, { buttons: 0 })));
            } catch (_) {}
            try {
                el.dispatchEvent(new MouseEvent("click", Object.assign({}, baseEv, { buttons: 0 })));
            } catch (_) {}
            try {
                el.click();
            } catch (_) {}
            // hard href if present
            if (el.tagName === "A" && el.href && !/javascript:/i.test(el.href)) {
                try {
                    const u = new URL(el.href, location.origin);
                    if (/recommend|jingxuan|follow|friend|live/i.test(u.pathname + u.search)) {
                        location.assign(u.href);
                    }
                } catch (_) {}
            }
            // also force known route after click (SPA often needs both)
            const localMap0 = {
                推荐: "/?recommend=1",
                精选: "/jingxuan",
                关注: "/follow",
                朋友: "/friend",
                直播: "/live",
                我的: "/user/self",
            };
            const p0 = localMap0[label] || localMap0[want];
            if (p0 && !onTarget(location.href, label)) {
                try {
                    location.assign(location.origin + p0);
                } catch (_) {}
            }
            return {
                ok: true,
                action: "nav_tab_exact_click",
                label,
                matched: want,
                tag: el.tagName,
                href: location.href,
                leftLabels,
                method: "exact_left_click",
            };
        }

        // --- 2) URL navigation fallback ---
        if (forceUrl) {
            try {
                if (!onTarget(location.href, label)) {
                    location.assign(forceUrl);
                }
                return {
                    ok: true,
                    action: "nav_tab_url",
                    label,
                    href: forceUrl,
                    leftLabels,
                    method: "forceUrl",
                    note: "no_exact_dom_match",
                };
            } catch (e) {
                /* fall through */
            }
        }

        const localMap = {
            推荐: "/?recommend=1",
            精选: "/jingxuan",
            关注: "/follow",
            朋友: "/friend",
            直播: "/live",
            我的: "/user/self",
        };
        const path = localMap[label] || localMap[want];
        if (path && !onTarget(location.href, label)) {
            try {
                const dest = location.origin + path;
                location.assign(dest);
                return {
                    ok: true,
                    action: "nav_tab_url",
                    label,
                    href: dest,
                    leftLabels,
                    method: "location.assign",
                };
            } catch (_) {}
        }

        // --- 2) XPath exact / contains text (text nodes) ---
        const xpathHits = [];
        try {
            const xp = `//*[not(self::script) and not(self::style)][contains(normalize-space(.), '${label.replace(/'/g, "")}')]`;
            const snap = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            for (let i = 0; i < snap.snapshotLength && i < 40; i++) {
                const el = snap.snapshotItem(i);
                if (!el) continue;
                const t = norm(el.textContent);
                if (t !== want && !(t.length <= want.length + 4 && t.includes(want))) continue;
                // prefer shallow nodes
                const r = el.getBoundingClientRect();
                if (r.width < 4 || r.height < 4) continue;
                const depth = (function d(n) {
                    let c = 0;
                    while (n && n.parentElement) {
                        c++;
                        n = n.parentElement;
                    }
                    return c;
                })(el);
                xpathHits.push({ el, t, left: r.left, area: r.width * r.height, depth });
            }
        } catch (_) {}
        xpathHits.sort((a, b) => {
            // left rail + smaller text node + exact match
            const sa = (a.left < 280 ? 50 : 0) + (a.t === want ? 40 : 0) - a.depth * 0.5 - Math.min(a.area, 5000) * 0.001;
            const sb = (b.left < 280 ? 50 : 0) + (b.t === want ? 40 : 0) - b.depth * 0.5 - Math.min(b.area, 5000) * 0.001;
            return sb - sa;
        });

        const candidates = xpathHits.map((x) => ({
            el: x.el,
            score: (x.left < 280 ? 100 : 0) + (x.t === want ? 50 : 20),
            text: x.t,
            left: x.left,
        }));

        // --- 3) CSS walk fallback ---
        if (!candidates.length) {
            const seen = new Set();
            document.querySelectorAll("a, button, [role='tab'], [role='link'], [role='menuitem'], div, span, li, p").forEach((el) => {
                if (seen.has(el)) return;
                seen.add(el);
                const r = el.getBoundingClientRect();
                if (r.width < 8 || r.height < 8) return;
                if (r.bottom < 0 || r.top > (window.innerHeight || 900)) return;
                const n = norm(el.textContent);
                if (!n || n.length > 16) return;
                if (n !== want && !n.includes(want)) return;
                let score = n === want ? 80 : 40;
                if (r.left < 280) score += 30;
                candidates.push({ el, score, text: n, left: r.left });
            });
            candidates.sort((a, b) => b.score - a.score || a.left - b.left);
        }

        if (!candidates.length) {
            // last resort URL again
            if (path) {
                try {
                    location.href = location.origin + path;
                    return {
                        ok: true,
                        action: "nav_tab_url",
                        label,
                        href: location.origin + path,
                        leftLabels,
                        method: "location.href_fallback",
                    };
                } catch (_) {}
            }
            return {
                ok: false,
                action: "nav_tab",
                error: "no_match",
                label,
                leftLabels,
                href: location.href,
            };
        }

        // Click the tightest left-rail match; climb to <a> if any
        const best = candidates[0];
        let el = best.el;
        const a = el.closest && el.closest("a[href]");
        if (a) el = a;
        else {
            // climb a few parents for clickable wrapper
            let p = el.parentElement;
            for (let i = 0; i < 4 && p; i++) {
                const pr = p.getBoundingClientRect();
                if (pr.width < 280 && pr.height < 100 && pr.left < 300) {
                    el = p;
                }
                p = p.parentElement;
            }
        }

        try {
            el.scrollIntoView({ block: "center", behavior: "auto" });
        } catch (_) {}

        // If <a href> points to recommend/jingxuan etc, navigate hard
        if (el.tagName === "A" && el.href && !/javascript:/i.test(el.href)) {
            try {
                const u = new URL(el.href, location.origin);
                if (
                    /recommend|jingxuan|follow|friend|live/i.test(u.href) ||
                    onTarget(u.href, label) ||
                    /recommend|jingxuan|follow/.test(u.search + u.pathname)
                ) {
                    location.assign(u.href);
                    return {
                        ok: true,
                        action: "nav_tab_href",
                        label,
                        matched: best.text,
                        href: u.href,
                        leftLabels,
                        method: "a.href",
                    };
                }
            } catch (_) {}
        }

        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const fire = (type, Ctor, extra) => {
            try {
                el.dispatchEvent(
                    new Ctor(
                        type,
                        Object.assign(
                            {
                                bubbles: true,
                                cancelable: true,
                                view: window,
                                clientX: cx,
                                clientY: cy,
                                button: 0,
                                buttons: type.includes("up") ? 0 : 1,
                            },
                            extra || {}
                        )
                    )
                );
            } catch (_) {}
        };
        fire("pointerdown", PointerEvent, { pointerId: 1, pointerType: "mouse", isPrimary: true });
        fire("mousedown", MouseEvent);
        fire("pointerup", PointerEvent, { pointerId: 1, pointerType: "mouse", isPrimary: true });
        fire("mouseup", MouseEvent);
        fire("click", MouseEvent);
        try {
            el.click();
        } catch (_) {}

        // After click, if still not on target — force URL
        if (path && !onTarget(location.href, label)) {
            try {
                location.assign(location.origin + path);
                return {
                    ok: true,
                    action: "nav_tab_url_after_click",
                    label,
                    matched: best.text,
                    href: location.origin + path,
                    leftLabels,
                    method: "click+assign",
                };
            } catch (_) {}
        }

        return {
            ok: true,
            action: "nav_tab_click",
            label,
            matched: best.text,
            score: best.score,
            tag: el.tagName,
            href: location.href,
            leftLabels,
            method: "click",
        };
    }

    /** Report whether current page looks like target nav (self-contained) */
    function pageNavStatus(opts) {
        const label = String((opts && opts.label) || "").trim();
        const href = location.href;
        const key = label.replace(/\s+/g, "").replace(/\d+/g, "");
        let urlMatch = false;
        if (key === "推荐") {
            urlMatch = /recommend=1/i.test(href) || /[?&#]recommend\b/i.test(href) || /\/recommend\b/i.test(href);
        } else if (key === "精选") urlMatch = /\/jingxuan/i.test(href);
        else if (key === "关注") urlMatch = /\/follow/i.test(href);
        else if (key === "朋友" || key === "好友") urlMatch = /\/friend/i.test(href);
        else if (key === "直播") urlMatch = /\/live/i.test(href);
        else if (key === "我的") urlMatch = /\/user\//i.test(href);

        let activeHit = false;
        let labelVisible = false;
        try {
            document.querySelectorAll("a, div, span, li, p").forEach((el) => {
                const r = el.getBoundingClientRect();
                if (r.left > 220) return;
                if (r.width > 200 || r.height > 64) return;
                const t = (el.textContent || "").replace(/\s+/g, "").replace(/\d+/g, "");
                if (t !== key && !(t.includes(key) && t.length <= key.length + 4)) return;
                labelVisible = true;
                const cls = String(el.className || el.parentElement && el.parentElement.className || "");
                // style-based active (background pill)
                const bg = getComputedStyle(el).backgroundColor || "";
                const pbg = el.parentElement ? getComputedStyle(el.parentElement).backgroundColor : "";
                const solid = (c) => c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent" && !/^rgba?\(\s*0,\s*0,\s*0,\s*0\s*\)$/.test(c);
                if (/active|selected|current|is-active|isActive/i.test(cls) || solid(bg) || solid(pbg)) {
                    activeHit = true;
                }
            });
        } catch (_) {}

        // 推荐流：有大尺寸 video 即认为已在可滑 Feed（比 URL 更准）
        let feedVideo = false;
        try {
            document.querySelectorAll("video").forEach((v) => {
                const r = v.getBoundingClientRect();
                if (r.width > 200 && r.height > 200) feedVideo = true;
            });
        } catch (_) {}

        const ok =
            urlMatch ||
            activeHit ||
            (key === "推荐" && feedVideo && labelVisible) ||
            (key === "推荐" && urlMatch);

        return {
            ok: !!(urlMatch || activeHit || (key === "推荐" && feedVideo)),
            action: "nav_status",
            label,
            href,
            urlMatch,
            activeHit,
            labelVisible,
            feedVideo,
            title: (document.title || "").slice(0, 60),
        };
    }

    // ─────────────────────── page: probe ───────────────────────

    function pagePrepareAndProbe() {
        const st = (window.__lmwScraper = window.__lmwScraper || {
            phase: "list",
            harvestRound: 0,
        });
        st.phase = /\/video\//.test(location.pathname) ? "player" : "list";
        st.harvestRound = 0;

        try {
            const dismissRe = /关闭|跳过|知道了|我知道了|同意|允许|暂不|以后再说|取消|轻触跳过/;
            document.querySelectorAll("button, [role='button'], a, div").forEach((b) => {
                const t = (b.textContent || b.getAttribute("aria-label") || "").trim();
                if (t && t.length < 16 && dismissRe.test(t)) {
                    try {
                        b.click();
                    } catch (_) {}
                }
            });
        } catch (_) {}

        // try unmute/play any visible video so stream starts
        let played = 0;
        try {
            document.querySelectorAll("video").forEach((v) => {
                const r = v.getBoundingClientRect();
                if (r.width < 40 || r.height < 40) return;
                try {
                    v.muted = true;
                    const p = v.play();
                    if (p && p.catch) p.catch(() => {});
                    played++;
                } catch (_) {}
            });
        } catch (_) {}

        const videos = document.querySelectorAll("video").length;
        const videoLinks = document.querySelectorAll('a[href*="/video/"]').length;
        const dataE2e = [];
        try {
            document.querySelectorAll("[data-e2e]").forEach((el) => {
                const v = el.getAttribute("data-e2e");
                if (v && dataE2e.length < 40 && !dataE2e.includes(v)) dataE2e.push(v);
            });
        } catch (_) {}

        return {
            ok: true,
            action: "prepare",
            href: location.href,
            path: location.pathname,
            title: (document.title || "").slice(0, 80),
            mode: st.phase,
            videos,
            videoLinks,
            played,
            dataE2eSample: dataE2e.slice(0, 20),
            bodyKids: document.body ? document.body.children.length : 0,
        };
    }

    // ─────────────────────── page: harvest video URLs ───────────────────────

    function pageHarvestVideoUrls() {
        const found = new Set();
        const abs = (href) => {
            if (!href) return null;
            try {
                const u = new URL(href, location.origin);
                // normalize to www.douyin.com/video/<id>
                const m = u.pathname.match(/\/video\/(\d+)/);
                if (m) {
                    return `https://www.douyin.com/video/${m[1]}`;
                }
                // note/modal style sometimes embed aweme id
                const m2 = u.pathname.match(/\/note\/(\d+)/);
                if (m2) return `https://www.douyin.com/video/${m2[1]}`;
                return null;
            } catch {
                return null;
            }
        };

        document.querySelectorAll('a[href*="/video/"], a[href*="/note/"]').forEach((a) => {
            const u = abs(a.getAttribute("href") || a.href);
            if (u) found.add(u);
        });

        // cards with data attributes
        document.querySelectorAll("[href], [data-id], [data-aweme-id], [data-e2e]").forEach((el) => {
            try {
                const href = el.getAttribute("href");
                const u = abs(href);
                if (u) found.add(u);
                for (const attr of ["data-id", "data-aweme-id", "data-group-id", "data-vid"]) {
                    const id = el.getAttribute(attr);
                    if (id && /^\d{6,}$/.test(id)) {
                        found.add(`https://www.douyin.com/video/${id}`);
                    }
                }
            } catch (_) {}
        });

        // scan raw HTML / scripts for aweme ids (list JSON often embeds them)
        try {
            const html = document.documentElement ? document.documentElement.innerHTML : "";
            const re = /\/video\/(\d{6,})/g;
            let m;
            while ((m = re.exec(html)) && found.size < 200) {
                found.add(`https://www.douyin.com/video/${m[1]}`);
            }
            const re2 = /"aweme_id"\s*:\s*"?(\d{6,})"?/g;
            while ((m = re2.exec(html)) && found.size < 200) {
                found.add(`https://www.douyin.com/video/${m[1]}`);
            }
            const re3 = /"groupId"\s*:\s*"?(\d{6,})"?/g;
            while ((m = re3.exec(html)) && found.size < 200) {
                found.add(`https://www.douyin.com/video/${m[1]}`);
            }
        } catch (_) {}

        // current page if already a video
        const self = abs(location.href);
        if (self) found.add(self);

        const mode = /\/video\//.test(location.pathname)
            ? "player"
            : /jingxuan|recommend|follow|channel|search/i.test(location.pathname + location.search)
              ? "feed"
              : "list";

        return {
            ok: true,
            action: "harvest",
            mode,
            href: location.href,
            urls: Array.from(found),
            count: found.size,
            videos: document.querySelectorAll("video").length,
        };
    }

    // ─────────────────────── page: scroll list to load more cards ───────────────────────

    function pageScrollListLoadMore() {
        const h = window.innerHeight || 800;
        const w = window.innerWidth || 1200;

        // find best scroll host (center column / feed)
        let host = document.scrollingElement || document.documentElement;
        let bestScore = 0;
        document.querySelectorAll("div, main, section, ul").forEach((el) => {
            try {
                const s = getComputedStyle(el);
                const oy = s.overflowY;
                if (!(oy === "auto" || oy === "scroll" || oy === "overlay")) return;
                const overflow = el.scrollHeight - el.clientHeight;
                if (overflow < 80) return;
                const r = el.getBoundingClientRect();
                if (r.height < 160) return;
                const score = overflow + r.width * 0.5 + (r.left > 80 && r.left < w * 0.5 ? 400 : 0);
                if (score > bestScore) {
                    bestScore = score;
                    host = el;
                }
            } catch (_) {}
        });

        const dy = Math.floor(h * 0.9);
        try {
            if (host.scrollBy) host.scrollBy({ top: dy, behavior: "auto" });
            else host.scrollTop = (host.scrollTop || 0) + dy;
        } catch (_) {}
        try {
            window.scrollBy(0, dy);
        } catch (_) {}

        // wheel on host + document (virtual lists listen wheel)
        const wheelTarget = host || document.body;
        for (let i = 0; i < 3; i++) {
            try {
                wheelTarget.dispatchEvent(
                    new WheelEvent("wheel", {
                        bubbles: true,
                        cancelable: true,
                        deltaY: dy / 3,
                        clientX: Math.floor(w * 0.55),
                        clientY: Math.floor(h * 0.5),
                    })
                );
            } catch (_) {}
        }

        // click a few visible cards' centers to help lazy render (not navigate if prevented)
        let cardClicks = 0;
        try {
            const cards = [];
            document.querySelectorAll('a[href*="/video/"], [data-e2e*="feed"], [data-e2e*="scroll"] li, video').forEach((el) => {
                const r = el.getBoundingClientRect();
                if (r.width > 60 && r.height > 60 && r.top > 0 && r.top < h - 40) cards.push(el);
            });
            for (let i = 0; i < Math.min(2, cards.length); i++) {
                const el = cards[i];
                // only hover/mouseover to trigger preview streams without leaving page when possible
                try {
                    el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, view: window }));
                    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, view: window }));
                    cardClicks++;
                } catch (_) {}
            }
        } catch (_) {}

        return {
            ok: true,
            action: "scroll_list",
            scrollTop: host.scrollTop || window.scrollY || 0,
            cardHovers: cardClicks,
            videos: document.querySelectorAll("video").length,
        };
    }

    // ─────────────────────── page: enter first visible card (click) ───────────────────────

    function pageClickFirstVideoCard() {
        const h = window.innerHeight || 800;
        const candidates = [];

        const push = (el, score) => {
            if (!el) return;
            const r = el.getBoundingClientRect();
            if (r.width < 40 || r.height < 40) return;
            if (r.bottom < 0 || r.top > h) return;
            candidates.push({ el, score: score + r.width * r.height * 0.0001 - Math.abs(r.top - h * 0.3) });
        };

        document.querySelectorAll('a[href*="/video/"]').forEach((a) => push(a, 1000));
        document.querySelectorAll('[data-e2e="scroll-list"] li, [data-e2e="feed-item"], li').forEach((li) => {
            if (li.querySelector("video, a[href*='/video/'], img")) push(li, 500);
        });
        document.querySelectorAll("video").forEach((v) => push(v.closest("a, li, div") || v, 300));

        candidates.sort((a, b) => b.score - a.score);
        if (!candidates.length) {
            return { ok: false, action: "click_card", error: "no_card" };
        }

        const target = candidates[0].el;
        const href =
            (target.getAttribute && target.getAttribute("href")) ||
            (target.closest && target.closest("a") && target.closest("a").getAttribute("href")) ||
            "";

        // Prefer real navigation via location if we have href
        if (href && /\/video\//.test(href)) {
            try {
                const u = new URL(href, location.origin);
                location.assign(u.href);
                return { ok: true, action: "navigate_href", href: u.href };
            } catch (_) {}
        }

        // Hard click sequence
        const el = target;
        try {
            el.scrollIntoView({ block: "center", behavior: "auto" });
        } catch (_) {}
        const cx = (() => {
            const r = el.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        })();
        const opts = {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: cx.x,
            clientY: cx.y,
            button: 0,
            buttons: 1,
        };
        try {
            el.dispatchEvent(new PointerEvent("pointerdown", opts));
        } catch (_) {}
        try {
            el.dispatchEvent(new MouseEvent("mousedown", opts));
        } catch (_) {}
        try {
            el.dispatchEvent(new PointerEvent("pointerup", opts));
        } catch (_) {}
        try {
            el.dispatchEvent(new MouseEvent("mouseup", opts));
        } catch (_) {}
        try {
            el.dispatchEvent(new MouseEvent("click", opts));
        } catch (_) {}
        try {
            el.click();
        } catch (_) {}
        // nested <a>
        const a = el.tagName === "A" ? el : el.querySelector && el.querySelector("a[href*='/video/']");
        if (a && a.href) {
            try {
                a.click();
            } catch (_) {}
        }

        return {
            ok: true,
            action: "click_card",
            href: href || "",
            tag: el.tagName,
        };
    }

    // ─────────────────────── page: swipe / next video in player ───────────────────────

    function pageSwipeNextVideo() {
        const h = window.innerHeight || 800;
        const w = window.innerWidth || 1200;
        const detail = { tried: [] };

        // 1) Ensure video plays (triggers network)
        let video = null;
        let bestArea = 0;
        document.querySelectorAll("video").forEach((v) => {
            const r = v.getBoundingClientRect();
            const area = Math.max(0, r.width) * Math.max(0, r.height);
            if (area > bestArea) {
                bestArea = area;
                video = v;
            }
        });
        if (video) {
            try {
                video.muted = true;
                video.play().catch(() => {});
                detail.tried.push("play");
            } catch (_) {}
        }

        // Interaction root: video or full-screen container near center
        let root = video;
        if (video) {
            let p = video.parentElement;
            for (let i = 0; i < 6 && p; i++) {
                const r = p.getBoundingClientRect();
                if (r.height > h * 0.5 && r.width > 200) {
                    root = p;
                    break;
                }
                p = p.parentElement;
            }
        }
        if (!root) root = document.elementFromPoint(w * 0.55, h * 0.5) || document.body;

        const cx = w * 0.55;
        const cy = h * 0.5;

        // 2) Touch swipe UP (finger moves up → next video in vertical feeds)
        const swipeTouch = (target, fromY, toY) => {
            const mk = (type, y) => {
                const t = new Touch({
                    identifier: 1,
                    target: target,
                    clientX: cx,
                    clientY: y,
                    pageX: cx,
                    pageY: y,
                    screenX: cx,
                    screenY: y,
                    radiusX: 2.5,
                    radiusY: 2.5,
                    rotationAngle: 0,
                    force: 0.5,
                });
                return new TouchEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    touches: type === "touchend" ? [] : [t],
                    targetTouches: type === "touchend" ? [] : [t],
                    changedTouches: [t],
                });
            };
            try {
                target.dispatchEvent(mk("touchstart", fromY));
                const steps = 6;
                for (let i = 1; i <= steps; i++) {
                    const y = fromY + ((toY - fromY) * i) / steps;
                    target.dispatchEvent(mk("touchmove", y));
                }
                target.dispatchEvent(mk("touchend", toY));
                return true;
            } catch (e) {
                return false;
            }
        };

        if (root && typeof Touch !== "undefined" && typeof TouchEvent !== "undefined") {
            if (swipeTouch(root, cy + h * 0.25, cy - h * 0.35)) {
                detail.tried.push("touch_swipe_up");
            }
            // also on document
            try {
                swipeTouch(document.body, cy + h * 0.25, cy - h * 0.35);
                detail.tried.push("touch_body");
            } catch (_) {}
        }

        // 3) Pointer drag (mouse swipe up)
        const pointerDrag = (target, fromY, toY) => {
            const fire = (type, y, buttons) => {
                const o = {
                    bubbles: true,
                    cancelable: true,
                    view: window,
                    clientX: cx,
                    clientY: y,
                    button: 0,
                    buttons,
                    pointerId: 1,
                    pointerType: "touch",
                    isPrimary: true,
                };
                try {
                    target.dispatchEvent(new PointerEvent(type, o));
                } catch (_) {}
                try {
                    target.dispatchEvent(
                        new MouseEvent(type.replace("pointer", "mouse"), {
                            bubbles: true,
                            cancelable: true,
                            view: window,
                            clientX: cx,
                            clientY: y,
                            button: 0,
                            buttons,
                        })
                    );
                } catch (_) {}
            };
            fire("pointerdown", fromY, 1);
            fire("mousedown", fromY, 1);
            const steps = 8;
            for (let i = 1; i <= steps; i++) {
                const y = fromY + ((toY - fromY) * i) / steps;
                fire("pointermove", y, 1);
                fire("mousemove", y, 1);
            }
            fire("pointerup", toY, 0);
            fire("mouseup", toY, 0);
        };
        try {
            pointerDrag(root, cy + h * 0.28, cy - h * 0.35);
            detail.tried.push("pointer_drag");
        } catch (_) {}

        // 4) Strong wheel down (next) on player + parents
        const wheelBurst = (target, delta) => {
            for (let i = 0; i < 4; i++) {
                try {
                    target.dispatchEvent(
                        new WheelEvent("wheel", {
                            bubbles: true,
                            cancelable: true,
                            deltaY: delta,
                            deltaMode: 0,
                            clientX: cx,
                            clientY: cy,
                        })
                    );
                } catch (_) {}
            }
        };
        let p = root;
        for (let i = 0; i < 5 && p; i++) {
            wheelBurst(p, Math.floor(h * 0.9));
            p = p.parentElement;
        }
        wheelBurst(document.body, Math.floor(h * 0.9));
        try {
            window.scrollBy(0, Math.floor(h * 0.95));
        } catch (_) {}
        detail.tried.push("wheel");

        // 5) Keyboard
        const keys = ["ArrowDown", "PageDown", "j", "J"];
        for (const key of keys) {
            const init = {
                key,
                code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
                keyCode: key === "ArrowDown" ? 40 : key === "PageDown" ? 34 : 74,
                which: key === "ArrowDown" ? 40 : key === "PageDown" ? 34 : 74,
                bubbles: true,
                cancelable: true,
                view: window,
            };
            for (const t of [document.activeElement, video, root, document.body, document].filter(Boolean)) {
                try {
                    t.dispatchEvent(new KeyboardEvent("keydown", init));
                    t.dispatchEvent(new KeyboardEvent("keyup", init));
                } catch (_) {}
            }
        }
        detail.tried.push("keys");

        // 6) Explicit next buttons
        const nextSels = [
            '[data-e2e="video-switch-next"]',
            '[data-e2e="feed-active-video"] [class*="arrow"]',
            '[class*="xgplayer-playswitch-next"]',
            '[class*="switch-next"]',
            '[class*="arrow-down"]',
            '[aria-label*="下一个"]',
            '[aria-label*="下一条"]',
            '[title*="下一个"]',
            'button[class*="arrow"]',
            'div[class*="arrow-container"]',
        ];
        for (const sel of nextSels) {
            let el;
            try {
                el = document.querySelector(sel);
            } catch (_) {
                continue;
            }
            if (!el) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 4 || r.height < 4) continue;
            try {
                el.click();
                detail.tried.push("btn:" + sel);
                break;
            } catch (_) {}
        }

        // 7) If SPA exposes next via sibling video link in related list
        let related = null;
        document.querySelectorAll('a[href*="/video/"]').forEach((a) => {
            if (related) return;
            try {
                const u = new URL(a.href, location.origin);
                if (u.pathname !== location.pathname && /\/video\/\d+/.test(u.pathname)) {
                    const r = a.getBoundingClientRect();
                    if (r.width > 20) related = u.href;
                }
            } catch (_) {}
        });

        return {
            ok: true,
            action: "swipe_next",
            mode: /\/video\//.test(location.pathname) ? "player" : "other",
            href: location.href,
            hasVideo: !!video,
            videoArea: Math.round(bestArea),
            related,
            detail,
        };
    }

    // ─────────────────────── driver objects ───────────────────────

    /**
     * Enter configured nav tab, then probe.
     * Douyin「推荐」：优先 chrome.tabs.update → /?recommend=1（真实路由），
     * 再点侧栏兜底；合成 click  alone 在 React 上经常无效。
     */
    async function prepareWithNavTab(tabId, navTab, waitComplete) {
        await sleep(1800);
        let navResult = null;
        let label = String(navTab || "").trim();
        if (!label || label === "无" || /^none$/i.test(label)) label = "";

        if (label) {
            let origin = "https://www.douyin.com";
            try {
                const tab = await chrome.tabs.get(tabId);
                if (tab && tab.url) origin = new URL(tab.url).origin || origin;
            } catch (_) {}

            const dest = resolveDouyinNavUrl(label, origin);
            // 1) Extension-level navigation (most reliable)
            if (dest) {
                try {
                    const tab = await chrome.tabs.get(tabId);
                    if (!isOnNavTarget(tab.url || "", label)) {
                        await chrome.tabs.update(tabId, { url: dest, active: true });
                        if (typeof waitComplete === "function") {
                            await waitComplete(tabId, 60000);
                        } else {
                            await sleep(3500);
                        }
                        navResult = {
                            ok: true,
                            action: "nav_tab_tabs_update",
                            label,
                            href: dest,
                            method: "chrome.tabs.update",
                        };
                    } else {
                        navResult = {
                            ok: true,
                            action: "nav_tab_already",
                            label,
                            href: tab.url,
                            method: "already_on_target",
                        };
                    }
                } catch (e) {
                    navResult = {
                        ok: false,
                        action: "nav_tab_tabs_update",
                        error: String(e && e.message ? e.message : e),
                        label,
                    };
                }
            }

            // 2) 始终尝试点侧栏精确文案（日志已证明 leftLabels 有「推荐」）
            await sleep(600);
            let status = await execInTab(tabId, pageNavStatus, [{ label }]);
            // 即使 URL 已是 recommend=1，也要点一次侧栏，确保 SPA Feed 切到推荐
            {
                const pageNav = await execInTab(tabId, pageClickNavTab, [
                    { label, forceUrl: dest || undefined },
                ]);
                navResult = Object.assign({}, navResult || {}, pageNav || {}, {
                    previous: navResult,
                });
                if (typeof waitComplete === "function") {
                    await sleep(800);
                    await waitComplete(tabId, 30000).catch(() => {});
                } else {
                    await sleep(2200);
                }
                status = await execInTab(tabId, pageNavStatus, [{ label }]);
            }

            // 3) Retry tabs.update once more
            if ((!status || !status.ok) && dest) {
                try {
                    await chrome.tabs.update(tabId, { url: dest, active: true });
                    if (typeof waitComplete === "function") await waitComplete(tabId, 60000);
                    else await sleep(3000);
                    status = await execInTab(tabId, pageNavStatus, [{ label }]);
                    navResult = Object.assign({}, navResult || {}, {
                        ok: !!(status && status.ok),
                        method: "tabs_update_retry",
                        href: dest,
                        status,
                    });
                } catch (_) {}
            }

            if (navResult && status) {
                navResult.status = status;
                navResult.ok = !!(status.ok || navResult.ok);
            }
        }

        let probe = await execInTab(tabId, pagePrepareAndProbe);
        if (probe && probe.ok && (probe.videos || 0) === 0 && (probe.videoLinks || 0) === 0) {
            await sleep(2000);
            probe = await execInTab(tabId, pagePrepareAndProbe);
        }
        if (probe && typeof probe === "object") {
            probe.navTab = label || "";
            probe.navResult = navResult;
        }
        return probe;
    }

    const genericDriver = {
        id: "generic",
        match() {
            return true;
        },
        async prepare(tabId, opts) {
            return prepareWithNavTab(tabId, opts && opts.navTab, opts && opts.waitComplete);
        },
        async clickNavTab(tabId, label) {
            const dest = resolveDouyinNavUrl(label, "https://www.douyin.com");
            // Prefer real navigation from extension
            if (dest) {
                try {
                    await chrome.tabs.update(tabId, { url: dest, active: true });
                    await sleep(2500);
                    const st = await execInTab(tabId, pageNavStatus, [{ label: label || "" }]);
                    if (st && st.ok) {
                        return {
                            ok: true,
                            action: "nav_tab_tabs_update",
                            label,
                            href: dest,
                            method: "chrome.tabs.update",
                            status: st,
                        };
                    }
                } catch (_) {}
            }
            return execInTab(tabId, pageClickNavTab, [
                { label: label || "", forceUrl: dest || undefined },
            ]);
        },
        async harvest(tabId) {
            return execInTab(tabId, pageHarvestVideoUrls);
        },
        async step(tabId) {
            const click = await execInTab(tabId, pageClickFirstVideoCard);
            if (click && click.ok) return click;
            return execInTab(tabId, pageScrollListLoadMore);
        },
        async swipeNext(tabId) {
            return execInTab(tabId, pageSwipeNextVideo);
        },
        async scrollList(tabId) {
            return execInTab(tabId, pageScrollListLoadMore);
        },
        async clickCard(tabId) {
            return execInTab(tabId, pageClickFirstVideoCard);
        },
        async runBrowse(ctx) {
            return runBrowseLoop(this, ctx);
        },
    };

    const douyinDriver = {
        id: "douyin",
        match(url) {
            try {
                const u = new URL(url);
                return /douyin\.com$/i.test(u.hostname) || /\.douyin\.com$/i.test(u.hostname);
            } catch {
                return /douyin\.com/i.test(url || "");
            }
        },
        async prepare(tabId, opts) {
            return prepareWithNavTab(tabId, opts && opts.navTab, opts && opts.waitComplete);
        },
        async clickNavTab(tabId, label) {
            const dest = resolveDouyinNavUrl(label, "https://www.douyin.com");
            if (dest) {
                try {
                    await chrome.tabs.update(tabId, { url: dest, active: true });
                    await sleep(2500);
                    const st = await execInTab(tabId, pageNavStatus, [{ label: label || "" }]);
                    if (st && st.ok) {
                        return {
                            ok: true,
                            action: "nav_tab_tabs_update",
                            label,
                            href: dest,
                            method: "chrome.tabs.update",
                            status: st,
                        };
                    }
                } catch (_) {}
            }
            return execInTab(tabId, pageClickNavTab, [
                { label: label || "", forceUrl: dest || undefined },
            ]);
        },
        async harvest(tabId) {
            return execInTab(tabId, pageHarvestVideoUrls);
        },
        async step(tabId) {
            const mode = await execInTab(tabId, () =>
                /\/video\//.test(location.pathname) ? "player" : "list"
            );
            if (mode === "player") {
                return execInTab(tabId, pageSwipeNextVideo);
            }
            const click = await execInTab(tabId, pageClickFirstVideoCard);
            if (click && click.ok) return click;
            return execInTab(tabId, pageScrollListLoadMore);
        },
        async swipeNext(tabId) {
            return execInTab(tabId, pageSwipeNextVideo);
        },
        async scrollList(tabId) {
            return execInTab(tabId, pageScrollListLoadMore);
        },
        async clickCard(tabId) {
            return execInTab(tabId, pageClickFirstVideoCard);
        },
        async runBrowse(ctx) {
            return runBrowseLoop(this, ctx);
        },
    };

    /**
     * Core browse:
     *  A) 推荐/Feed 页：先在当前页上下滑切视频（触发流媒体请求）
     *  B) 再按需打开 /video/id 详情补抓
     */
    async function runBrowseLoop(driver, ctx) {
        const {
            tabId,
            listUrl,
            targetCount,
            intervalMs = 2000,
            maxWaitMs = 180000,
            navTab = "",
            abortFn = () => false,
            onLog = () => {},
            getCount = async () => 0,
            waitComplete = async () => {},
        } = ctx;

        const visited = new Set();
        /** @type {string[]} */
        const queue = [];
        const t0 = Date.now();
        let lastCount = 0;
        let idleHarvest = 0;

        const timedOut = () => Date.now() - t0 > maxWaitMs;
        const pushUrls = (urls) => {
            let added = 0;
            for (const u of urls || []) {
                if (!u || visited.has(u)) continue;
                if (queue.includes(u)) continue;
                queue.push(u);
                added++;
            }
            return added;
        };

        const harvest = async () => {
            const r = await driver.harvest(tabId);
            if (r && r.ok === false) {
                onLog(`harvest 失败：${r.error}`, "err");
                return r;
            }
            const n = pushUrls(r && r.urls);
            onLog(
                `harvest · mode=${(r && r.mode) || "?"} 发现 ${r && r.count != null ? r.count : 0} 链 · 新入队 ${n} · 队列 ${queue.length}` +
                    (r && r.videos != null ? ` · pageVideos=${r.videos}` : ""),
                n ? "ok" : "info"
            );
            return r;
        };

        // ——— Phase A: Feed 内滑动（推荐页有 video 时优先）———
        let hr = await harvest();
        const preferFeedSwipe =
            (hr && (hr.mode === "feed" || hr.mode === "list") && (hr.videos || 0) > 0) ||
            (/推荐/.test(navTab || "") && navTab !== "无") ||
            /recommend=1/i.test(listUrl || "");

        if (preferFeedSwipe && !abortFn()) {
            const maxFeedSteps = Math.max(targetCount * 3, 12);
            onLog(
                `Feed 滑动阶段：目标嗅探 ${targetCount}，最多 ${maxFeedSteps} 次上下滑（不先跳详情）`,
                "info"
            );
            for (let s = 0; s < maxFeedSteps && !abortFn() && !timedOut(); s++) {
                const count = await getCount(tabId);
                if (count !== lastCount) {
                    onLog(`嗅探条数 ${count} / ${targetCount}`, count >= targetCount ? "ok" : "info");
                    lastCount = count;
                }
                if (count >= targetCount) {
                    onLog(`Feed 阶段已达目标 ${count} ≥ ${targetCount}`, "ok");
                    break;
                }
                const sw = await driver.swipeNext(tabId);
                const tried = ((sw && sw.detail && sw.detail.tried) || []).join(",") || "?";
                onLog(
                    `Feed 滑动 #${s + 1} · area=${(sw && sw.videoArea) || 0} · ${tried}`,
                    "info"
                );
                await sleep(Math.max(1500, intervalMs));
                // 每 3 次补 harvest（更新队列备用）
                if (s % 3 === 2) await harvest();
            }
        }

        // 若 Feed 阶段已达标，直接结束浏览
        {
            const count = await getCount(tabId);
            if (count >= targetCount) {
                return {
                    ok: true,
                    visited: visited.size,
                    queuedLeft: queue.length,
                    count,
                    phase: "feed_only",
                };
            }
        }

        // ——— Phase B: 打开 /video/ 详情补抓 ———
        onLog("详情阶段：逐个打开 /video/ 链接补嗅探", "info");
        if (queue.length < 2) {
            for (let i = 0; i < 4 && queue.length < 2 && !abortFn() && !timedOut(); i++) {
                await driver.scrollList(tabId);
                await sleep(Math.max(600, intervalMs * 0.6));
                await harvest();
            }
        }
        if (!queue.length && !abortFn()) {
            onLog("队列为空，尝试点击首个视频卡片进入…", "warn");
            const ck = await driver.clickCard(tabId);
            onLog(`click_card: ${JSON.stringify(ck).slice(0, 180)}`, ck && ck.ok ? "ok" : "warn");
            await sleep(intervalMs);
            await waitComplete(tabId);
            await harvest();
        }

        while (!abortFn() && !timedOut()) {
            const count = await getCount(tabId);
            if (count !== lastCount) {
                onLog(`嗅探条数 ${count} / ${targetCount}`, count >= targetCount ? "ok" : "info");
                lastCount = count;
            }
            if (count >= targetCount) {
                onLog(`已达目标 ${count} ≥ ${targetCount}`, "ok");
                break;
            }

            if (queue.length) {
                const nextUrl = queue.shift();
                visited.add(nextUrl);
                onLog(`进入视频 ${visited.size}: ${nextUrl}`, "info");
                try {
                    await chrome.tabs.update(tabId, { url: nextUrl, active: true });
                } catch (e) {
                    onLog(`打开视频失败：${e.message || e}`, "err");
                    continue;
                }
                await waitComplete(tabId, 60000);
                await sleep(Math.max(1500, intervalMs));

                // 详情页内多滑几次
                for (let s = 0; s < 5 && !abortFn() && !timedOut(); s++) {
                    const c0 = await getCount(tabId);
                    if (c0 >= targetCount) break;
                    const sw = await driver.swipeNext(tabId);
                    onLog(
                        `播放器切换 #${s + 1} · tried=${((sw && sw.detail && sw.detail.tried) || []).join(",") || "?"}` +
                            (sw && sw.related ? ` · related` : ""),
                        "info"
                    );
                    if (sw && sw.related) pushUrls([sw.related]);
                    await sleep(Math.max(1200, intervalMs));
                    if (s === 1) await harvest();
                }
                idleHarvest = 0;
            } else {
                // empty queue: back to list, load more
                idleHarvest++;
                onLog(`队列空，返回列表加载更多（第 ${idleHarvest} 次）…`, "warn");
                try {
                    const tab = await chrome.tabs.get(tabId);
                    const baseList = String(listUrl || "").split("?")[0];
                    if (!tab.url || (baseList && !String(tab.url).startsWith(baseList) && !/douyin\.com\/?(\?|$)/i.test(tab.url))) {
                        await chrome.tabs.update(tabId, { url: listUrl, active: true });
                        await waitComplete(tabId, 60000);
                        await sleep(1500);
                    }
                    // re-enter configured sidebar tab (e.g. 推荐)
                    const navLabel =
                        navTab && navTab !== "无" && !/^none$/i.test(String(navTab))
                            ? String(navTab).trim()
                            : "";
                    if (navLabel && driver.clickNavTab) {
                        const nr = await driver.clickNavTab(tabId, navLabel);
                        onLog(
                            `回列表后点标签「${navLabel}」: ${nr && nr.ok ? nr.matched || nr.action : nr && nr.error}`,
                            nr && nr.ok ? "ok" : "warn"
                        );
                        await sleep(1500);
                    }
                } catch (e) {
                    onLog(`回列表失败：${e.message || e}`, "err");
                }
                for (let i = 0; i < 4 && !abortFn(); i++) {
                    await driver.scrollList(tabId);
                    await sleep(Math.max(500, intervalMs * 0.5));
                }
                const before = queue.length;
                await harvest();
                if (queue.length === before) {
                    // try click into any card again
                    await driver.clickCard(tabId);
                    await sleep(intervalMs);
                    await waitComplete(tabId);
                    await harvest();
                }
                if (idleHarvest >= 8 && queue.length === 0) {
                    onLog("多次无法收获新视频链接，结束本链浏览", "err");
                    break;
                }
            }
        }

        if (timedOut() && !abortFn()) {
            onLog(`达到最长等待 ${maxWaitMs}ms`, "warn");
        }

        return {
            ok: true,
            visited: visited.size,
            queuedLeft: queue.length,
            count: await getCount(tabId),
        };
    }

    const DRIVERS = [douyinDriver, genericDriver];

    function matchDriver(url) {
        for (const d of DRIVERS) {
            if (d.id === "generic") continue;
            if (d.match(url)) return d;
        }
        return genericDriver;
    }

    global.LMWScraperDrivers = {
        DRIVERS,
        matchDriver,
        genericDriver,
        douyinDriver,
        execInTab,
        runBrowseLoop,
    };
})(typeof window !== "undefined" ? window : globalThis);
