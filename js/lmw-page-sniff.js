/**
 * LocalMediaWeb page sniff: floating "入库" only while hovering media.
 * Toggle: options lmwFloatIngest (and lmwEnable).
 * Ingest goes through the extension service worker (avoids page→localhost blocks).
 */
(function () {
    if (window.__LMW_PAGE_SNIFF__) return;
    window.__LMW_PAGE_SNIFF__ = true;

    const DEFAULTS = {
        lmwEnable: true,
        lmwFloatIngest: true,
        lmwURL: "http://127.0.0.1:8790",
        lmwToken: "",
        lmwDefaultCategory: "default",
        lmwFloatMinPx: 72,
    };

    let settings = { ...DEFAULTS };
    let enabled = false;
    let host = null;
    let shadow = null;
    let layer = null;
    /** @type {HTMLButtonElement|null} */
    let badge = null;
    /** @type {Element|null} */
    let hoverEl = null;
    let hideTimer = 0;
    let posTimer = 0;
    let busy = false;
    /** 入库标签弹窗打开时为 true：暂停悬停逻辑，并锁住页面焦点 */
    let dialogOpen = false;

    const SKIP_RE = /^(data:image\/svg|chrome-extension:|moz-extension:|about:|javascript:)/i;
    const MEDIA_EXT = /\.(mp4|webm|mkv|mov|m4v|m3u8|mpd|gif|jpe?g|png|webp|avif|bmp)(\?|#|$)/i;

    /** Options 写 sync；弹窗开关可能写 local。合并：默认 → sync → local。 */
    async function loadSettings() {
        const keys = Object.keys(DEFAULTS);
        try {
            const [syncData, localData] = await Promise.all([
                chrome.storage.sync.get(keys),
                chrome.storage.local.get(keys),
            ]);
            settings = { ...DEFAULTS, ...syncData, ...localData };
        } catch (e) {
            settings = { ...DEFAULTS };
        }
        enabled = settings.lmwEnable !== false && settings.lmwFloatIngest !== false;
    }

    function minPx() {
        let n = Number(settings.lmwFloatMinPx);
        if (!Number.isFinite(n) || n < 1) n = DEFAULTS.lmwFloatMinPx;
        return n;
    }

    function resolveUrl(u) {
        if (!u || typeof u !== "string") return "";
        u = u.trim();
        if (!u || SKIP_RE.test(u)) return "";
        try {
            return new URL(u, location.href).href;
        } catch (e) {
            return "";
        }
    }

    function pickFromSrcset(srcset) {
        if (!srcset) return "";
        const parts = srcset.split(",").map((s) => s.trim()).filter(Boolean);
        if (!parts.length) return "";
        const last = parts[parts.length - 1].split(/\s+/)[0];
        return resolveUrl(last);
    }

    function mediaUrlFromEl(el) {
        if (!el || el.nodeType !== 1) return "";
        const tag = el.tagName;
        if (tag === "VIDEO" || tag === "AUDIO") {
            const u = el.currentSrc || el.src || "";
            if (u) return resolveUrl(u);
            const s = el.querySelector("source[src]");
            if (s) return resolveUrl(s.getAttribute("src") || "");
            return "";
        }
        if (tag === "IMG" || tag === "IMAGE") {
            const u =
                el.currentSrc ||
                el.src ||
                el.getAttribute("data-src") ||
                el.getAttribute("data-original") ||
                el.getAttribute("data-lazy-src") ||
                pickFromSrcset(el.getAttribute("srcset") || el.getAttribute("data-srcset") || "");
            return resolveUrl(u);
        }
        if (tag === "SOURCE") {
            return resolveUrl(el.src || el.getAttribute("src") || "");
        }
        if (tag === "A") {
            const href = resolveUrl(el.href || el.getAttribute("href") || "");
            if (href && MEDIA_EXT.test(href)) return href;
        }
        try {
            const bg = getComputedStyle(el).backgroundImage || "";
            const m = bg.match(/url\(["']?([^"')]+)["']?\)/i);
            if (m) return resolveUrl(m[1]);
        } catch (e) { /* ignore */ }
        return "";
    }

    function mediaTypeOf(url, el) {
        const u = (url || "").toLowerCase();
        if (el && el.tagName === "VIDEO") return "video";
        if (el && el.tagName === "AUDIO") return "video";
        if (/\.m3u8(\?|#|$)/i.test(u) || u.includes("mpegurl")) return "m3u8";
        if (/\.mpd(\?|#|$)/i.test(u)) return "dash";
        if (/\.gif(\?|#|$)/i.test(u)) return "gif";
        if (/\.(png|jpe?g|webp|avif|bmp)(\?|#|$)/i.test(u)) return "image";
        if (/\.(mp4|webm|mkv|mov|m4v)(\?|#|$)/i.test(u)) return "video";
        if (el && el.tagName === "IMG") return "image";
        return "video";
    }

    /**
     * 尺寸门槛：显示宽、高都必须 ≥ 设定值（旧逻辑用 && 只拦「两边都小于」，小图标仍会漏）。
     * 图片另参考 intrinsic / 属性尺寸，避免被 CSS 拉大的图标误触发。
     */
    function elRectOk(el) {
        if (!el || el.nodeType !== 1) return null;
        const min = minPx();
        const r = el.getBoundingClientRect();
        if (r.width < min || r.height < min) return null;
        if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return null;

        const tag = el.tagName;
        if (tag === "IMG" || tag === "IMAGE") {
            const nw = el.naturalWidth | 0;
            const nh = el.naturalHeight | 0;
            // 固有尺寸明确偏小 → 视为图标（即使被 CSS 略放大）
            if (nw > 0 && nh > 0 && (nw < min || nh < min)) {
                // 仅当显示尺寸也没有明显超过门槛时拦截（避免误伤大图 lazy 未解码）
                if (r.width < min * 1.5 || r.height < min * 1.5) return null;
            }
            const aw = parseInt(el.getAttribute("width"), 10);
            const ah = parseInt(el.getAttribute("height"), 10);
            if (aw > 0 && ah > 0 && (aw < min || ah < min) && (r.width < min || r.height < min)) {
                return null;
            }
        }
        return r;
    }

    /** 从节点向上找可入库媒体；须通过尺寸门槛。 */
    function isMediaTarget(el) {
        if (!el || el.nodeType !== 1) return null;
        if (el.id === "lmw-page-sniff-host") return null;
        let cur = el;
        for (let i = 0; i < 8 && cur; i++, cur = cur.parentElement) {
            if (!cur.tagName) continue;
            if (cur.id === "lmw-page-sniff-host") return null;
            const tag = cur.tagName;
            let candidate = null;
            if (tag === "SOURCE") {
                const p = cur.parentElement;
                if (p && (p.tagName === "VIDEO" || p.tagName === "AUDIO") && mediaUrlFromEl(p)) {
                    candidate = p;
                }
            } else if (tag === "VIDEO" || tag === "AUDIO" || tag === "IMG" || tag === "IMAGE") {
                if (mediaUrlFromEl(cur)) candidate = cur;
            } else if (tag === "A") {
                if (mediaUrlFromEl(cur)) candidate = cur;
            }
            if (candidate && elRectOk(candidate)) return candidate;
        }
        return null;
    }

    function ensureHost() {
        if (host && document.documentElement.contains(host)) return;
        host = document.createElement("div");
        host.id = "lmw-page-sniff-host";
        host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483646;";
        shadow = host.attachShadow({ mode: "closed" });
        const style = document.createElement("style");
        style.textContent = `
            .layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; }
            .badge {
                position: fixed;
                pointer-events: auto;
                z-index: 2147483647;
                min-width: 48px;
                height: 28px;
                padding: 0 10px;
                border: none;
                border-radius: 14px;
                background: rgba(26, 115, 232, 0.95);
                color: #fff;
                font: 600 12px/28px "Segoe UI", "Microsoft YaHei", sans-serif;
                box-shadow: 0 2px 10px rgba(0,0,0,.32);
                cursor: pointer;
                opacity: 0.95;
                transition: opacity .12s, transform .12s, background .15s;
                user-select: none;
                -webkit-user-select: none;
                display: none;
            }
            .badge.show { display: block; }
            .badge:hover { opacity: 1; transform: scale(1.06); background: rgba(21, 95, 200, 0.98); }
            .badge.busy { background: rgba(100,100,100,.92); cursor: wait; }
            .badge.ok { background: rgba(30, 150, 80, .96); }
            .badge.err { background: rgba(200, 60, 50, .96); }
            .toast {
                position: fixed;
                left: 50%;
                bottom: 16%;
                transform: translateX(-50%);
                background: rgba(20,20,20,.88);
                color: #fff;
                padding: 10px 16px;
                border-radius: 10px;
                font: 13px/1.45 "Segoe UI", "Microsoft YaHei", sans-serif;
                pointer-events: none;
                z-index: 2147483647;
                max-width: min(92vw, 420px);
                text-align: center;
                box-shadow: 0 4px 20px rgba(0,0,0,.35);
                white-space: pre-wrap;
                word-break: break-word;
            }
            .toast.ok { background: rgba(22, 120, 70, .92); }
            .toast.err { background: rgba(160, 40, 35, .92); }
        `;
        layer = document.createElement("div");
        layer.className = "layer";
        shadow.appendChild(style);
        shadow.appendChild(layer);
        (document.documentElement || document.body).appendChild(host);
        makeBadge();
    }

    function toast(msg, ms = 2800, kind = "") {
        ensureHost();
        const old = shadow.querySelector(".toast");
        if (old) old.remove();
        const t = document.createElement("div");
        t.className = "toast" + (kind ? " " + kind : "");
        t.textContent = msg;
        shadow.appendChild(t);
        setTimeout(() => t.remove(), ms);
    }

    function makeBadge() {
        if (badge) return badge;
        ensureHost();
        badge = document.createElement("button");
        badge.type = "button";
        badge.className = "badge";
        badge.textContent = "入库";
        badge.title = "加入本地媒体库";
        badge.addEventListener("pointerenter", () => {
            clearTimeout(hideTimer);
        });
        badge.addEventListener("pointerleave", (e) => {
            // leave badge → schedule hide unless re-entering media
            scheduleHide();
        });
        badge.addEventListener("click", onIngestClick);
        ["mousedown", "mouseup", "pointerdown", "touchstart"].forEach((ev) => {
            badge.addEventListener(ev, (e) => {
                e.stopPropagation();
            });
        });
        layer.appendChild(badge);
        return badge;
    }

    function positionBadge(el) {
        if (!badge || !el) return;
        const r = elRectOk(el);
        if (!r) {
            badge.classList.remove("show");
            return;
        }
        const top = Math.max(4, r.top + 6);
        const left = Math.min(innerWidth - 64, Math.max(4, r.right - 58));
        badge.style.top = `${top}px`;
        badge.style.left = `${left}px`;
        badge.classList.add("show");
    }

    function showFor(el) {
        if (!enabled || !el) return;
        ensureHost();
        hoverEl = el;
        clearTimeout(hideTimer);
        if (!busy) {
            badge.classList.remove("ok", "err", "busy");
            badge.textContent = "入库";
        }
        positionBadge(el);
    }

    function scheduleHide() {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
            if (busy) return;
            hoverEl = null;
            if (badge) badge.classList.remove("show");
        }, 220);
    }

    function onPointerMove(e) {
        if (!enabled || busy || dialogOpen) return;
        // When over our host/badge (pointer-events on badge only), keep
        try {
            if (e.composedPath && e.composedPath().includes(host)) return;
        } catch (err) { /* ignore */ }

        const stack = document.elementsFromPoint(e.clientX, e.clientY);
        let found = null;
        // 优先栈中第一个「够大」的媒体；小图标跳过，继续找下层大图/视频
        for (const node of stack) {
            if (node === host) continue;
            found = isMediaTarget(node);
            if (found) break;
        }
        if (found) {
            if (found !== hoverEl) showFor(found);
            else positionBadge(found);
        } else if (hoverEl) {
            scheduleHide();
        }
    }

    function onScrollOrResize() {
        clearTimeout(posTimer);
        posTimer = setTimeout(() => {
            if (hoverEl && badge && badge.classList.contains("show")) {
                positionBadge(hoverEl);
            }
        }, 40);
    }

    /**
     * 标签对话框：扩展独立窗口（chrome.windows popup）。
     * 不在 grok.com 等页面内输入，彻底避免站点抢焦点。
     */
    function openTagDialog({ title, url, media_type }) {
        dialogOpen = true;
        toast("请在弹出的扩展窗口中确认标签…", 4000);
        return new Promise((resolve) => {
            try {
                chrome.runtime.sendMessage(
                    {
                        Message: "lmwAskTags",
                        title: String(title || "").slice(0, 512),
                        url: url || "",
                        media_type: media_type || "",
                        source_page: location.href,
                        count: 1,
                    },
                    (resp) => {
                        dialogOpen = false;
                        if (chrome.runtime.lastError) {
                            toast("无法打开标签窗口: " + chrome.runtime.lastError.message, 3500, "err");
                            resolve({ ok: false, cancelled: true, tags: [] });
                            return;
                        }
                        resolve(resp || { ok: false, cancelled: true, tags: [] });
                    }
                );
            } catch (e) {
                dialogOpen = false;
                resolve({ ok: false, cancelled: true, tags: [], error: String(e) });
            }
        });
    }

    async function onIngestClick(e) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (busy || !hoverEl) return;
        const el = hoverEl;
        let url = mediaUrlFromEl(el);
        if (!url) {
            toast("无法获取资源地址", 3000, "err");
            return;
        }
        // blob: fetch in page context then upload via background as base64 chunks only for small; for blob use CS path
        const mtype = mediaTypeOf(url, el);
        const title =
            (el.getAttribute && (el.getAttribute("alt") || el.getAttribute("title") || el.getAttribute("aria-label"))) ||
            document.title ||
            "media";

        const dlg = await openTagDialog({ title, url, media_type: mtype });
        if (!dlg || !dlg.ok || dlg.cancelled) {
            toast("已取消", 1200);
            return;
        }
        const tags = dlg.tags || [];
        const restricted = dlg.restricted === true;

        busy = true;
        badge.classList.add("busy");
        badge.classList.remove("ok", "err");
        badge.textContent = "…";
        toast("正在入库…", 6000);

        try {
            let result;
            if (url.startsWith("blob:")) {
                result = await ingestBlobViaBackground(url, {
                    media_type: mtype,
                    title: String(title).slice(0, 200),
                    source_page: location.href,
                    tags,
                    restricted,
                });
            } else {
                result = await new Promise((resolve, reject) => {
                    chrome.runtime.sendMessage(
                        {
                            Message: "lmwPageIngest",
                            url,
                            media_type: mtype,
                            title: String(title).slice(0, 512),
                            referer: location.href,
                            source_page: location.href,
                            page_url: location.href,
                            tags,
                            restricted,
                        },
                        (resp) => {
                            if (chrome.runtime.lastError) {
                                reject(new Error(chrome.runtime.lastError.message));
                                return;
                            }
                            if (!resp || !resp.ok) {
                                reject(new Error((resp && resp.error) || "入库失败"));
                                return;
                            }
                            resolve(resp);
                        }
                    );
                });
            }

            busy = false;
            badge.classList.remove("busy");
            badge.classList.add("ok");
            badge.textContent = "✓";
            const msg = formatSuccess(result);
            toast(msg, 4000, "ok");
            setTimeout(() => {
                if (!busy && badge) {
                    badge.textContent = "入库";
                    badge.classList.remove("ok");
                }
            }, 1800);
        } catch (err) {
            busy = false;
            badge.classList.remove("busy");
            badge.classList.add("err");
            badge.textContent = "!";
            const msg = ((err && err.message) || String(err)).slice(0, 200);
            toast("入库失败\n" + msg, 5000, "err");
            setTimeout(() => {
                if (!busy && badge) {
                    badge.textContent = "入库";
                    badge.classList.remove("err");
                }
            }, 2200);
        }
    }

    function formatSuccess(r) {
        if (!r) return "入库完成";
        if (r.duplicate || r.status === "duplicate") {
            return r.media_id != null
                ? `已在库中 #${r.media_id}`
                : "资源已在媒体库中";
        }
        if (r.media_id != null) {
            const note = r.note ? `（${r.note}）` : "";
            return `入库成功 #${r.media_id}${note}`;
        }
        if (r.job_id != null) {
            if (r.job_status === "success" && r.media_id != null) {
                return `入库成功 #${r.media_id}`;
            }
            if (r.job_status === "running" || r.job_status === "queued") {
                return `已提交任务 #${r.job_id}，服务端下载中…`;
            }
            if (r.job_status === "failed" || r.job_status === "failed_network" || r.job_status === "failed_auth") {
                return `任务 #${r.job_id} ${r.job_status}: ${(r.error_message || "").slice(0, 80)}`;
            }
            return `已提交入库任务 #${r.job_id}`;
        }
        if (r.message) return r.message;
        return "入库完成";
    }

    /**
     * blob: must be read in page/CS world, then uploaded from SW via ArrayBuffer message.
     */
    async function ingestBlobViaBackground(blobUrl, meta) {
        const resBlob = await fetch(blobUrl);
        if (!resBlob.ok) throw new Error("读取 blob 失败 " + resBlob.status);
        const blob = await resBlob.blob();
        if (!blob.size) throw new Error("blob 为空");
        // Cap ~80MB for message path
        if (blob.size > 80 * 1024 * 1024) {
            throw new Error("文件过大，请用弹窗「入库」或录屏停止并入库");
        }
        const buf = await blob.arrayBuffer();
        const mtype = meta.media_type || "video";
        const ext =
            mtype === "image" ? "jpg" : mtype === "gif" ? "gif" : (blob.type || "").includes("webm") ? "webm" : "mp4";
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(
                {
                    Message: "lmwPageUpload",
                    buffer: buf,
                    mime: blob.type || "application/octet-stream",
                    filename: `${String(meta.title || "media").slice(0, 40)}.${ext}`,
                    title: meta.title || "",
                    media_type: mtype === "m3u8" || mtype === "dash" ? "video" : mtype,
                    source_url: meta.source_page || location.href,
                    category: "default",
                    tags: meta.tags || [],
                },
                (resp) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                        return;
                    }
                    if (!resp || !resp.ok) {
                        reject(new Error((resp && resp.error) || "上传失败"));
                        return;
                    }
                    resolve(resp);
                }
            );
        });
    }

    function start() {
        ensureHost();
        document.addEventListener("pointermove", onPointerMove, true);
        window.addEventListener("scroll", onScrollOrResize, true);
        window.addEventListener("resize", onScrollOrResize, true);
    }

    function stop() {
        document.removeEventListener("pointermove", onPointerMove, true);
        window.removeEventListener("scroll", onScrollOrResize, true);
        window.removeEventListener("resize", onScrollOrResize, true);
        clearTimeout(hideTimer);
        clearTimeout(posTimer);
        hoverEl = null;
        busy = false;
        if (host) {
            host.remove();
            host = null;
            shadow = null;
            layer = null;
            badge = null;
        }
    }

    async function applyEnabled() {
        await loadSettings();
        if (enabled) start();
        else stop();
    }

    chrome.storage?.onChanged?.addListener((changes, area) => {
        if (area !== "local" && area !== "sync") return;
        if (
            changes.lmwEnable ||
            changes.lmwFloatIngest ||
            changes.lmwURL ||
            changes.lmwToken ||
            changes.lmwDefaultCategory ||
            changes.lmwFloatMinPx
        ) {
            // 仅改最小尺寸时也立即生效
            applyEnabled();
        }
    });

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => applyEnabled());
    } else {
        applyEnabled();
    }
})();
