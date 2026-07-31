(async function () {
    const params = new URLSearchParams(location.search);
    const tabId = parseInt(params.get("tabId") || "0", 10);
    /** @type {Array<any>} */
    let items = [];
    const selected = new Set();
    /**
     * 预览音频：首次进入页面默认静音（保证自动播放）；
     * 用户在控件上取消静音后，后续预览可带声音。
     */
    let wantSound = false;

    /** Matched A/V pairs for merge (page items and/or server library ids) */
    const PAIR_COLORS = [
        "#60a5fa",
        "#f472b6",
        "#34d399",
        "#fbbf24",
        "#a78bfa",
        "#fb7185",
        "#22d3ee",
        "#c084fc",
    ];
    /** @type {{source:'page'|'library', video_key?:string, audio_key?:string, video_id?:number, audio_id?:number, pair_index:number, score?:number, delta_sec?:number}[]} */
    let avPairs = [];
    /** key or id -> { pair_index, role } */
    const avPairByKey = new Map();

    function setStatus(msg) {
        $("#status").text(msg || "");
    }

    function wireVideoSound(el) {
        if (!el || el.dataset.soundBound === "1") return;
        el.dataset.soundBound = "1";
        el.muted = !wantSound;
        el.volume = 1;
        const syncWant = () => {
            // 用户通过原生控件取消静音 / 调音量
            if (!el.muted && el.volume > 0) wantSound = true;
            else if (el.muted) wantSound = false;
        };
        el.addEventListener("volumechange", syncWant);
    }

    function mediaTypeOf(it) {
        return LMW.normalizeMediaType(it);
    }

    /** 写入宽高（用于筛选/角标） */
    function setItemDims(it, w, h) {
        w = Math.round(Number(w) || 0);
        h = Math.round(Number(h) || 0);
        if (!it || w < 2 || h < 2) return false;
        const changed = it._w !== w || it._h !== h;
        it._w = w;
        it._h = h;
        it._short = Math.min(w, h);
        it._long = Math.max(w, h);
        // 视频常用「高度」作 720p/1080p 口径；图片用短边近似
        const type = mediaTypeOf(it);
        it._resMetric =
            type === "video" || type === "m3u8" || type === "dash" || type === "gif" ? h : it._short;
        return changed;
    }

    function itemHasCookie(it) {
        return !!(it && it._headers && (it._headers.Cookie || it._headers.cookie));
    }

    function matchResFilter(it, resVal) {
        if (!resVal) return true;
        const m = it._resMetric || 0;
        if (resVal === "unknown") return !m;
        if (!m) return false; // 有分辨率要求时，未知不通过
        if (resVal === "min720") return m >= 720;
        if (resVal === "min1080") return m >= 1080;
        if (resVal === "min1440") return m >= 1440;
        if (resVal === "min2160") return m >= 2160;
        if (resVal === "lt720") return m > 0 && m < 720;
        return true;
    }

    function matchLongFilter(it, longVal) {
        if (!longVal) return true;
        const L = it._long || 0;
        if (!L) return false;
        if (longVal === "min800") return L >= 800;
        if (longVal === "min1200") return L >= 1200;
        if (longVal === "min1600") return L >= 1600;
        if (longVal === "min2400") return L >= 2400;
        if (longVal === "lt800") return L > 0 && L < 800;
        return true;
    }

    function matchCookieFilter(it, cookieVal) {
        if (!cookieVal) return true;
        const has = itemHasCookie(it);
        if (cookieVal === "yes") return has;
        if (cookieVal === "no") return !has;
        return true;
    }

    function getFilteredItems() {
        const type = $("#typeFilter").val();
        const res = $("#resFilter").val();
        const long = $("#longFilter").val();
        const cookie = $("#cookieFilter").val();
        return items.filter((it) => {
            if (type) {
                const mt = mediaTypeOf(it);
                // 「视频」同时覆盖 progressive + 流媒体，便于一键筛掉图
                if (type === "video") {
                    if (!(mt === "video" || mt === "m3u8" || mt === "dash")) return false;
                } else if (mt !== type) {
                    return false;
                }
            }
            if (!matchResFilter(it, res)) return false;
            if (!matchLongFilter(it, long)) return false;
            if (!matchCookieFilter(it, cookie)) return false;
            return true;
        });
    }

    function updateCardDimBadge($card, it) {
        if (!$card || !it) return;
        $card.find(".dim-badge").remove();
        if (it._w && it._h) {
            $card.append(
                $("<span class='dim-badge'/>").text(it._w + "×" + it._h).attr("title", "分辨率")
            );
        }
    }

    /** 分辨率探测到后刷新角标；若当前筛选项会排除该项则整表重绘 */
    function onDimsReady(it) {
        if (!it || !it._key) return;
        const $card = $('#grid .lm-card[data-key="' + String(it._key).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"]');
        if ($card.length) updateCardDimBadge($card, it);
        const res = $("#resFilter").val();
        const long = $("#longFilter").val();
        if ((res || long) && !getFilteredItems().some((x) => x._key === it._key)) {
            // 当前筛选下该项已不可见
            if ($card.length) render();
        } else if ((res || long) && !$card.length) {
            // 探测后变为可见
            render();
        }
    }

    /** 预览/悬停播放用的 HLS 实例 */
    let previewHls = null;
    let hoverHls = null;

    function destroyHls(inst) {
        if (!inst) return;
        try {
            inst.destroy();
        } catch (_) {}
    }

    /** 从条目取 Referer/Cookie 等，供 declarativeNetRequest 注入 */
    function playHeaderMap(it) {
        const out = {};
        const src = it && it._headers ? it._headers : {};
        for (const [k, v] of Object.entries(src)) {
            if (v == null || v === "") continue;
            if (/^(referer|cookie|user-agent|origin|authorization)$/i.test(k)) {
                out[k] = String(v);
            }
        }
        if (!out.Referer && !out.referer) {
            const ref = (it && (it.referer || it._pageUrl)) || "";
            if (ref) out.Referer = ref;
        }
        return out;
    }

    function applyPlayHeaders(it, done) {
        const headers = playHeaderMap(it);
        if (typeof setRequestHeaders === "function" && Object.keys(headers).length) {
            try {
                setRequestHeaders(headers, () => done && done());
                return;
            } catch (_) {}
        }
        done && done();
    }

    function isStreamUrl(url, type) {
        if (type === "m3u8" || type === "dash") return true;
        return /\.(m3u8|mpd)(\?|#|$)/i.test(url || "");
    }

    /**
     * 浏览器可播候选：Steam extras 的 mp4 多为 HEVC(hvc1)，Chrome/Edge 常解不出；
     * 同 hash 的 .webm 一般是 VP9，优先用于预览。
     */
    function playUrlCandidates(url) {
        if (!url) return [];
        const list = [];
        const push = (u) => {
            if (u && !list.includes(u)) list.push(u);
        };
        try {
            const u = new URL(url);
            const path = u.pathname || "";
            const isSteamExtra = /\/extras\/[a-f0-9]{16,}\.(mp4|webm)$/i.test(path);
            const isSteamAsset = /steamstatic|steamcontent|steamvideo/i.test(u.hostname);
            if (/\.mp4$/i.test(path) && (isSteamExtra || isSteamAsset)) {
                const webm = new URL(url);
                webm.pathname = path.replace(/\.mp4$/i, ".webm");
                push(webm.href);
                push(url);
            } else if (/\.webm$/i.test(path)) {
                push(url);
                const mp4 = new URL(url);
                mp4.pathname = path.replace(/\.webm$/i, ".mp4");
                push(mp4.href);
            } else if (/\.mp4$/i.test(path)) {
                // 其它站：先原链，失败再试 webm
                push(url);
                const webm = new URL(url);
                webm.pathname = path.replace(/\.mp4$/i, ".webm");
                push(webm.href);
            } else {
                push(url);
            }
        } catch (_) {
            push(url);
        }
        return list;
    }

    function mediaErrorMessage(el, triedUrls) {
        const err = el && el.error;
        const code = err ? err.code : 0;
        const map = {
            1: "加载中止",
            2: "网络错误",
            3: "解码失败（编码不支持或文件损坏）",
            4: "格式/编码不支持",
        };
        let msg = map[code] || "视频加载失败";
        const joined = (triedUrls || []).join(" ");
        if (
            code === 3 ||
            code === 4 ||
            /hevc|hvc1|h265|hev1/i.test(joined)
        ) {
            msg +=
                "。Steam 循环预览 mp4 常为 HEVC(H.265)，浏览器无法硬解；已尝试同路径 webm(VP9)。可入库后由 LocalMediaWeb/ffmpeg 转码播放";
        } else {
            msg += "：检查网络 / Referer / Cookie，或入库后播放";
        }
        if (triedUrls && triedUrls.length > 1) {
            msg += `（已试 ${triedUrls.length} 个地址）`;
        }
        return msg;
    }

    function attachHlsToVideo(videoEl, url, { autoplay = true, onError } = {}) {
        destroyHls(previewHls);
        if (typeof Hls === "undefined") {
            onError && onError("页面未加载 hls.js");
            return null;
        }
        if (videoEl.canPlayType("application/vnd.apple.mpegurl")) {
            videoEl.src = url;
            if (autoplay) videoEl.play().catch(() => {});
            return null;
        }
        if (!Hls.isSupported()) {
            onError && onError("当前浏览器不支持 HLS 播放");
            return null;
        }
        const hls = new Hls({
            enableWorker: false,
            xhrSetup: (xhr) => {
                try {
                    xhr.withCredentials = false;
                } catch (_) {}
            },
        });
        hls.loadSource(url);
        hls.attachMedia(videoEl);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (autoplay) videoEl.play().catch(() => {});
        });
        hls.on(Hls.Events.ERROR, (_e, data) => {
            if (data && data.fatal) {
                try {
                    hls.destroy();
                } catch (_) {}
                onError &&
                    onError(
                        "HLS 加载失败" +
                            (data.type ? ` (${data.type})` : "") +
                            "：可能需登录 Cookie，或 CDN 拒绝扩展页来源"
                    );
            }
        });
        return hls;
    }

    /**
     * 顺序尝试多个 URL 挂到 video；任一成功则 resolve 实际 URL。
     * 用 once error 链，避免「首帧失败」就刷错误文案。
     */
    function bindVideoSrcWithFallback(el, urls, { autoplay = true, muted = false } = {}) {
        return new Promise((resolve, reject) => {
            const list = (urls || []).filter(Boolean);
            if (!list.length) {
                reject(new Error("无播放地址"));
                return;
            }
            let idx = 0;
            const tried = [];
            const tryNext = () => {
                if (idx >= list.length) {
                    reject(Object.assign(new Error("all failed"), { tried, el }));
                    return;
                }
                const u = list[idx++];
                tried.push(u);
                const onError = () => {
                    cleanup();
                    tryNext();
                };
                const onReady = () => {
                    cleanup();
                    resolve({ url: u, tried });
                };
                const cleanup = () => {
                    el.removeEventListener("error", onError);
                    el.removeEventListener("loadeddata", onReady);
                    el.removeEventListener("canplay", onReady);
                };
                el.addEventListener("error", onError);
                el.addEventListener("loadeddata", onReady);
                el.addEventListener("canplay", onReady);
                try {
                    el.pause();
                } catch (_) {}
                el.src = u;
                el.load();
                if (autoplay) {
                    el.muted = muted || el.muted;
                    const p = el.play();
                    if (p && p.catch) p.catch(() => {});
                }
            };
            tryNext();
        });
    }

    function closePreview() {
        const $pv = $("#lmPreview");
        if ($pv.hasClass("hide")) return;
        destroyHls(previewHls);
        previewHls = null;
        $pv.find("video, audio").each(function () {
            try {
                this.pause();
                this.removeAttribute("src");
                this.load();
            } catch (_) {}
        });
        $("#lmPreviewStage").empty();
        $("#lmPreviewMeta").empty();
        $pv.addClass("hide").attr("aria-hidden", "true");
        $("body").css("overflow", "");
    }

    function openPreview(it) {
        if (!it || !it.url) return;
        const type = mediaTypeOf(it);
        const $stage = $("#lmPreviewStage").empty();
        const title = it.title || it.downFileName || it.name || "";
        const $meta = $("#lmPreviewMeta").empty();
        let activePlayUrl = it.url;

        const showMeta = (extraErr) => {
            $meta.empty();
            const $lines = $("<div/>");
            $lines.append(
                $("<div/>").text([type, it.source || "", title].filter(Boolean).join(" · "))
            );
            $lines.append(
                $("<div style='margin-top:4px'/>").append(
                    $("<a/>")
                        .attr({ href: activePlayUrl || it.url, target: "_blank", rel: "noopener" })
                        .text(activePlayUrl || it.url)
                )
            );
            if (activePlayUrl && activePlayUrl !== it.url) {
                $lines.append(
                    $("<div style='margin-top:4px;color:#889;font-size:11px'/>").text(
                        "原始: " + it.url
                    )
                );
            }
            if (extraErr) {
                $lines.append($("<div class='lm-preview-err'/>").text(extraErr));
            }
            const $acts = $("<div class='lm-preview-actions'/>");
            $acts.append(
                $("<button type='button'/>")
                    .text("复制链接")
                    .on("click", async (e) => {
                        e.stopPropagation();
                        const copy = activePlayUrl || it.url;
                        try {
                            await navigator.clipboard.writeText(copy);
                            setStatus("已复制链接");
                        } catch (_) {
                            setStatus(copy);
                        }
                    })
            );
            if ((type === "m3u8" || isStreamUrl(it.url, type)) && !/\.mpd(\?|#|$)/i.test(it.url || "") && type !== "dash") {
                const q = new URLSearchParams();
                q.set("url", it.url);
                if (tabId) q.set("tabid", String(tabId));
                const rh = playHeaderMap(it);
                const ref = rh.Referer || rh.referer;
                if (ref) q.set("initiator", ref);
                if (Object.keys(rh).length) q.set("requestHeaders", JSON.stringify(rh));
                $acts.append(
                    $("<a class='button2'/>")
                        .attr({ href: "m3u8.html?" + q.toString(), target: "_blank" })
                        .text("用 m3u8 解析器打开")
                );
            }
            $lines.append($acts);
            $meta.append($lines);
        };

        const mountVideo = (stream) => {
            const $v = $("<video/>").attr({
                controls: true,
                playsinline: true,
                preload: "auto",
            });
            // 勿设 crossOrigin：多数 CDN 无 CORS 时会导致整段无法解码播放
            // 首次默认静音以便 autoplay；用户取消静音后 wantSound=true 可出声
            const startMuted = !wantSound;
            $v.prop({ controls: true, muted: startMuted });
            $stage.append($v);
            const el = $v[0];
            wireVideoSound(el);
            applyPlayHeaders(it, () => {
                if (stream) {
                    el.muted = startMuted;
                    previewHls = attachHlsToVideo(el, it.url, {
                        autoplay: true,
                        onError: (msg) => showMeta(msg),
                    });
                    // HLS 挂载后仍尊重出声偏好
                    if (wantSound) {
                        el.muted = false;
                        el.play().catch(() => {
                            /* 浏览器可能仍要求手势，用户可点控件取消静音 */
                        });
                    }
                    return;
                }
                const candidates = playUrlCandidates(it.url);
                bindVideoSrcWithFallback(el, candidates, { autoplay: true, muted: startMuted })
                    .then(({ url }) => {
                        activePlayUrl = url;
                        it._playUrl = url;
                        wireVideoSound(el);
                        if (wantSound) {
                            el.muted = false;
                            el.play().catch(() => {});
                        }
                        showMeta();
                    })
                    .catch((e) => {
                        const tried = (e && e.tried) || candidates;
                        showMeta(mediaErrorMessage(el, tried));
                    });
            });
        };

        if (type === "image" || type === "gif") {
            $stage.append(
                $("<img/>").attr({
                    src: it.url,
                    alt: title || "preview",
                    referrerpolicy: "no-referrer",
                    draggable: "false",
                })
            );
            showMeta();
        } else if (type === "audio") {
            const $a = $("<audio/>").attr({ controls: true, preload: "auto" });
            $a.css({ width: "min(92vw, 480px)", margin: "24px auto", display: "block" });
            const el = $a[0];
            el.muted = !wantSound;
            wireVideoSound(el);
            $stage.append($a);
            applyPlayHeaders(it, () => {
                el.src = it.url;
                el.play().catch(() => {});
            });
            showMeta();
        } else if (type === "video" || isStreamUrl(it.url, type)) {
            showMeta();
            mountVideo(isStreamUrl(it.url, type));
        } else {
            $stage.append(
                $("<div class='lm-preview-fallback'/>").append(
                    $("<a/>").attr({ href: it.url, target: "_blank", rel: "noopener" }).text(it.url)
                )
            );
            showMeta();
        }

        $("#lmPreview").removeClass("hide").attr("aria-hidden", "false");
        $("body").css("overflow", "hidden");
    }

    function updateStatusCount(listLen) {
        const n = listLen != null ? listLen : $("#grid .lm-card").length;
        const total = items.length;
        const filterHint = n !== total && total ? `（筛后 ${n}/${total}）` : "";
        const pairHint = avPairs.length ? ` · 可合并 ${avPairs.length} 对` : "";
        setStatus(
            `共 ${n} 项${filterHint}，已选 ${selected.size}${pairHint} · 服务器 ${LMW.baseUrl()} · 单击选择 / 双击预览`
        );
        updateMergeBtn();
    }

    function updateMergeBtn() {
        const btn = document.getElementById("btnMergeAvSelected");
        if (!btn) return;
        const n = collectMergePairs().length;
        btn.disabled = n === 0;
        btn.textContent = n > 0 ? `合并选中音视频 (${n})` : "合并选中音视频";
    }

    function clearAvPairs() {
        avPairs = [];
        avPairByKey.clear();
        applyPairMarks();
        updateMergeBtn();
    }

    function setAvPairs(pairs) {
        avPairs = pairs || [];
        avPairByKey.clear();
        for (const p of avPairs) {
            const idx = Number(p.pair_index) || 0;
            if (p.source === "page") {
                if (p.video_key) avPairByKey.set(p.video_key, { pair_index: idx, role: "video", pair: p });
                if (p.audio_key) avPairByKey.set(p.audio_key, { pair_index: idx, role: "audio", pair: p });
                if (p.video_key) selected.add(p.video_key);
                if (p.audio_key) selected.add(p.audio_key);
            } else {
                // library ids stored as "lib:123"
                if (p.video_id) avPairByKey.set("lib:" + p.video_id, { pair_index: idx, role: "video", pair: p });
                if (p.audio_id) avPairByKey.set("lib:" + p.audio_id, { pair_index: idx, role: "audio", pair: p });
            }
        }
        applyPairMarks();
        // refresh selected styles
        $("#grid .lm-card").each(function () {
            applyCardSelected($(this), $(this).attr("data-key"));
        });
        updateMergeBtn();
    }

    function applyPairMarks() {
        $("#grid .lm-card").each(function () {
            const $card = $(this);
            const key = $card.attr("data-key");
            const info = avPairByKey.get(key);
            $card.removeClass("lm-av-pair lm-av-pair-role-video lm-av-pair-role-audio");
            $card.css("--lm-pair-c", "");
            $card.find(".lm-pair-badge").remove();
            if (!info) return;
            const color = PAIR_COLORS[info.pair_index % PAIR_COLORS.length];
            $card.addClass("lm-av-pair lm-av-pair-role-" + info.role);
            $card.css("--lm-pair-c", color);
            const prefix = info.role === "video" ? "V·" : "A·";
            $card.append(
                $("<span class='lm-pair-badge'/>")
                    .text(prefix + "对" + (info.pair_index + 1))
                    .attr("title", "时长匹配对 #" + (info.pair_index + 1))
            );
        });
    }

    function collectMergePairs() {
        const out = [];
        const seen = new Set();
        for (const p of avPairs) {
            if (p.source === "page") {
                const both =
                    selected.size === 0 ||
                    (selected.has(p.video_key) && selected.has(p.audio_key));
                if (!both) continue;
                const k = "p:" + p.video_key + "|" + p.audio_key;
                if (seen.has(k)) continue;
                seen.add(k);
                out.push(p);
            } else {
                const k = "l:" + p.video_id + "|" + p.audio_id;
                if (seen.has(k)) continue;
                seen.add(k);
                out.push(p);
            }
        }
        return out;
    }

    function durationMatchScore(d1, d2, absTol = 0.45, relTol = 0.02) {
        if (!(d1 > 0.05) || !(d2 > 0.05)) return null;
        const delta = Math.abs(d1 - d2);
        const base = Math.max(d1, d2);
        if (delta > absTol && delta / base > relTol) return null;
        return 1 - Math.min(1, delta / base);
    }

    /**
     * Content-based type + duration for progressive files.
     * Prefers server download→ffprobe (handles audio disguised as .mp4).
     * Falls back to HTMLMediaElement (videoWidth===0 ⇒ audio).
     */
    async function classifyItemContent(it) {
        if (!it || !it.url) return null;
        const t0 = mediaTypeOf(it);
        if (t0 === "m3u8" || t0 === "dash" || t0 === "image" || t0 === "gif") {
            return { media_type: t0, duration_sec: null, method: "skip" };
        }
        // Server: download to temp + ffprobe (authoritative)
        try {
            const headers = {};
            const src = it._headers || {};
            for (const [k, v] of Object.entries(src)) {
                if (v == null || v === "") continue;
                if (/^(referer|cookie|user-agent|origin|authorization)$/i.test(k)) {
                    headers[k] = String(v);
                }
            }
            const r = await LMW.probeUrl({ url: it.url, headers });
            if (r && r.media_type) {
                it.media_type = r.media_type;
                it._contentRole = r.role || "";
                it._durationSec =
                    r.duration_sec != null && Number(r.duration_sec) > 0
                        ? Number(r.duration_sec)
                        : it._durationSec;
                it._classifyMethod = r.method || "server";
                return {
                    media_type: r.media_type,
                    duration_sec: it._durationSec,
                    role: r.role,
                    method: r.method,
                };
            }
        } catch (e) {
            console.warn("probe-url failed, fallback element", it.url, e);
        }
        // Client fallback: <video> with no picture plane ≈ audio-only container
        return probeItemWithElement(it);
    }

    function probeItemWithElement(it, timeoutMs = 12000) {
        return new Promise((resolve) => {
            // Always use <video> so we can read videoWidth (audio-only mp4 still loads)
            const el = document.createElement("video");
            el.preload = "metadata";
            el.muted = true;
            el.playsInline = true;
            let done = false;
            const finish = (info) => {
                if (done) return;
                done = true;
                try {
                    el.removeAttribute("src");
                    el.load();
                } catch (_) {}
                resolve(info);
            };
            const timer = setTimeout(() => finish(null), timeoutMs);
            el.addEventListener("loadedmetadata", () => {
                clearTimeout(timer);
                const d = el.duration;
                const hasVideo = (el.videoWidth || 0) > 0 && (el.videoHeight || 0) > 0;
                const duration_sec = Number.isFinite(d) && d > 0 ? d : null;
                const media_type = hasVideo ? "video" : duration_sec ? "audio" : mediaTypeOf(it);
                it.media_type = media_type;
                it._durationSec = duration_sec;
                it._contentRole = hasVideo ? "has_video" : "audio_only_guess";
                it._classifyMethod = "element";
                finish({ media_type, duration_sec, role: it._contentRole, method: "element" });
            });
            el.addEventListener("error", () => {
                clearTimeout(timer);
                finish(null);
            });
            applyPlayHeaders(it, () => {
                try {
                    el.src = it.url;
                } catch (_) {
                    clearTimeout(timer);
                    finish(null);
                }
            });
        });
    }

    async function detectPageAvPairs(pool) {
        // Reclassify progressive items by content (not extension)
        const progressive = pool.filter((it) => {
            const t = mediaTypeOf(it);
            return t === "video" || t === "audio" || t === "m3u8" || t === "dash"
                ? t === "video" || t === "audio"
                : !isStreamUrl(it.url, t) && t !== "image" && t !== "gif";
        });
        setStatus(`内容识别中… ${progressive.length} 个 progressive 文件（服务端临时下载 + ffprobe）`);
        let classified = 0;
        // Limit concurrency to avoid hammering server/CDN
        const queue = progressive.slice();
        const workers = Array.from({ length: Math.min(3, queue.length || 1) }, async () => {
            while (queue.length) {
                const it = queue.shift();
                if (!it) break;
                if (it._classifyMethod === "server" || it._classifyMethod === "element") {
                    classified++;
                    continue;
                }
                await classifyItemContent(it);
                classified++;
                if (classified % 3 === 0) {
                    setStatus(`内容识别中… ${classified}/${progressive.length}`);
                }
            }
        });
        await Promise.all(workers);

        const videos = [];
        const audios = [];
        for (const it of pool) {
            const t = mediaTypeOf(it);
            // 仅完整单文件 progressive，不含 m3u8/dash
            if (t === "video") videos.push(it);
            else if (t === "audio") audios.push(it);
        }
        if (!videos.length || !audios.length) {
            return {
                pairs: [],
                videos: videos.length,
                audios: audios.length,
                probed: classified,
            };
        }
        setStatus(`比对时长… 视频 ${videos.length} · 音频 ${audios.length}`);
        for (const it of [...videos, ...audios]) {
            if (it._durationSec == null || !(it._durationSec > 0)) {
                const r = await classifyItemContent(it);
                if (r && r.duration_sec) it._durationSec = r.duration_sec;
            }
        }
        // Re-bucket after reclassify may have flipped types
        videos.length = 0;
        audios.length = 0;
        for (const it of pool) {
            const t = mediaTypeOf(it);
            if (t === "video") videos.push(it);
            else if (t === "audio") audios.push(it);
        }
        const vOk = videos.filter((v) => v._durationSec > 0.05);
        const aOk = audios.filter((a) => a._durationSec > 0.05);
        const candidates = [];
        for (const v of vOk) {
            for (const a of aOk) {
                const sc = durationMatchScore(v._durationSec, a._durationSec);
                if (sc == null || sc < 0.97) continue;
                candidates.push({
                    score: sc,
                    delta: v._durationSec - a._durationSec,
                    v,
                    a,
                });
            }
        }
        candidates.sort((x, y) => y.score - x.score || Math.abs(x.delta) - Math.abs(y.delta));
        const usedV = new Set();
        const usedA = new Set();
        const pairs = [];
        for (const c of candidates) {
            if (usedV.has(c.v._key) || usedA.has(c.a._key)) continue;
            usedV.add(c.v._key);
            usedA.add(c.a._key);
            pairs.push({
                source: "page",
                video_key: c.v._key,
                audio_key: c.a._key,
                video_item: c.v,
                audio_item: c.a,
                pair_index: pairs.length,
                score: +c.score.toFixed(5),
                delta_sec: c.delta,
                video_duration: c.v._durationSec,
                audio_duration: c.a._durationSec,
            });
        }
        return { pairs, videos: videos.length, audios: audios.length, probed: classified, vOk: vOk.length, aOk: aOk.length };
    }

    async function detectAvMergePairs() {
        const btn = document.getElementById("btnDetectAvMerge");
        if (btn) btn.disabled = true;
        try {
            // 仅在已勾选项中检测可合并的音/视频对
            const pool = getSelectedItems();
            if (!pool.length) {
                setStatus("请先勾选要检测的媒体项");
                clearAvPairs();
                return;
            }
            if (pool.length < 2) {
                setStatus("请至少勾选 2 项（需同时有视频与音频，或伪装成视频的纯音频）");
                clearAvPairs();
                return;
            }

            // Even video-only selection may contain disguised audio — reclassify first
            const r = await detectPageAvPairs(pool);
            render(); // refresh badges after content type flips
            if (r.pairs.length) {
                setAvPairs(r.pairs);
                setStatus(
                    `选中项中找到 ${r.pairs.length} 对可合并（已着色勾选）` +
                        ` · 内容识别后 视频 ${r.videos} · 音频 ${r.audios}` +
                        (r.vOk != null ? ` · 有效时长 V${r.vOk}/A${r.aOk}` : "")
                );
                return;
            }
            setStatus(
                `选中项中未找到高度匹配对（视频 ${r.videos} · 音频 ${r.audios}` +
                    (r.vOk != null ? ` · 可读时长 V${r.vOk}/A${r.aOk}` : "") +
                    `）。请确认已同时勾选 progressive 视频与音频。`
            );
            clearAvPairs();
        } catch (e) {
            setStatus("检测失败：" + ((e && e.message) || e));
            clearAvPairs();
        } finally {
            if (btn) btn.disabled = false;
            updateMergeBtn();
        }
    }

    async function fetchItemBlob(it) {
        const headers = {};
        const src = (it && it._headers) || {};
        for (const [k, v] of Object.entries(src)) {
            if (v == null || v === "") continue;
            if (/^(referer|cookie|user-agent|origin|authorization)$/i.test(k)) {
                headers[k] = String(v);
            }
        }
        return new Promise((resolve, reject) => {
            const doFetch = async () => {
                try {
                    const res = await fetch(it.url, {
                        credentials: "include",
                        headers,
                        redirect: "follow",
                    });
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const blob = await res.blob();
                    if (!blob || blob.size < 32) throw new Error("empty blob");
                    resolve(blob);
                } catch (e) {
                    reject(e);
                }
            };
            applyPlayHeaders(it, () => {
                doFetch();
            });
        });
    }

    async function mergeSelectedAv() {
        const pairs = collectMergePairs();
        if (!pairs.length) {
            setStatus("请先「检测选中中的可合并项」");
            return;
        }
        const pageN = pairs.filter((p) => p.source === "page").length;
        const libN = pairs.filter((p) => p.source === "library").length;
        if (
            !confirm(
                `合并 ${pairs.length} 对音视频并写入媒体库？\n` +
                    (pageN
                        ? `· 当前列表 ${pageN} 对：下载后合并，仅保留合并成品（临时文件自动清理）\n`
                        : "") +
                    (libN
                        ? `· 服务器库 ${libN} 对：库内合并后删除原来的分离音/视频\n`
                        : "")
            )
        ) {
            return;
        }
        const btn = document.getElementById("btnMergeAvSelected");
        const detectBtn = document.getElementById("btnDetectAvMerge");
        if (btn) btn.disabled = true;
        if (detectBtn) detectBtn.disabled = true;
        let ok = 0;
        let fail = 0;
        const restricted = !!(document.getElementById("lmRestricted") && document.getElementById("lmRestricted").checked);
        const useJasna = !!(document.getElementById("lmUseJasna") && document.getElementById("lmUseJasna").checked);
        try {
            // library pairs batch
            const libPairs = pairs.filter((p) => p.source === "library");
            if (libPairs.length) {
                setStatus(`库内合并 0/${libPairs.length}…`);
                const r = await LMW.mergeAvLibrary({
                    pairs: libPairs.map((p) => ({ video_id: p.video_id, audio_id: p.audio_id })),
                    // 合并成功后删除库内原来的分离音/视频，只留成品
                    delete_sources: true,
                });
                ok += r.merged || 0;
                fail += r.failed || 0;
            }
            // page pairs one by one
            const pagePairs = pairs.filter((p) => p.source === "page");
            for (let i = 0; i < pagePairs.length; i++) {
                const p = pagePairs[i];
                setStatus(`下载合并 ${i + 1}/${pagePairs.length}…`);
                try {
                    const vItem = p.video_item || items.find((x) => x._key === p.video_key);
                    const aItem = p.audio_item || items.find((x) => x._key === p.audio_key);
                    if (!vItem || !aItem) throw new Error("item missing");
                    const [vBlob, aBlob] = await Promise.all([fetchItemBlob(vItem), fetchItemBlob(aItem)]);
                    const title =
                        (vItem.title || vItem.name || "merged").replace(/\.[^.]+$/, "") +
                        "+" +
                        (aItem.title || aItem.name || "audio").replace(/\.[^.]+$/, "");
                    await LMW.uploadAvBlobs(vBlob, aBlob, {
                        title,
                        source_url: vItem.url || "",
                        filename: title,
                        restricted,
                        use_jasna: useJasna,
                    });
                    ok++;
                } catch (e) {
                    fail++;
                    console.warn("merge page pair", e);
                }
            }
            setStatus(`合并完成：成功 ${ok}` + (fail ? ` · 失败 ${fail}` : "") + " · 已写入媒体库");
            clearAvPairs();
        } catch (e) {
            setStatus("合并失败：" + ((e && e.message) || e));
        } finally {
            if (btn) btn.disabled = false;
            if (detectBtn) detectBtn.disabled = false;
            updateMergeBtn();
        }
    }

    /** 只改选中样式，不要整表重绘（否则会打断 dblclick） */
    function applyCardSelected($card, key) {
        const on = selected.has(key);
        $card.toggleClass("selected", on);
        $card.find("input.ck").prop("checked", on);
        const it = items.find((x) => x._key === key);
        updateRangeBadge($card, it);
        updateMergeBtn();
    }

    function parseTimeToSeconds(time) {
        if (time == null || time === "") return null;
        if (typeof time === "number" && isFinite(time)) return Math.max(0, time);
        const s = String(time).trim();
        if (!s) return null;
        if (/^\d+(\.\d+)?$/.test(s)) return Math.max(0, parseFloat(s));
        // HH:MM:SS or MM:SS
        return s.split(":").reduce((acc, t) => 60 * acc + (+t || 0), 0);
    }

    function formatOneRange(r) {
        if (!r) return "";
        const a = r.startSec;
        const b = r.endSec;
        if ((a == null || a === 0) && (b == null || b === "" || !(b > 0))) {
            // full clip still shown when explicitly in list
            if (r.full) return "完整片";
        }
        const left =
            r.startStr ||
            (typeof secToTime === "function" ? secToTime(a || 0) : String(a || 0));
        const right =
            b != null && b > 0
                ? r.endStr ||
                  (typeof secToTime === "function" ? secToTime(b) : String(b))
                : "末尾";
        return left + " → " + right;
    }

    function getItemRanges(it) {
        if (!it) return [];
        if (Array.isArray(it._ranges) && it._ranges.length) return it._ranges.slice();
        // legacy single range
        if (it._startSec != null || (it._endSec != null && it._endSec > 0)) {
            return [
                {
                    startSec: it._startSec || 0,
                    endSec: it._endSec != null && it._endSec > 0 ? it._endSec : null,
                    startStr: it._startTimeStr || "",
                    endStr: it._endTimeStr || "",
                },
            ];
        }
        return [];
    }

    function syncLegacyRangeFields(it) {
        const ranges = getItemRanges(it);
        if (!ranges.length) {
            it._startSec = null;
            it._endSec = null;
            it._startTimeStr = "";
            it._endTimeStr = "";
            return;
        }
        const first = ranges[0];
        it._startSec = first.startSec != null ? first.startSec : 0;
        it._endSec = first.endSec != null && first.endSec > 0 ? first.endSec : null;
        it._startTimeStr = first.startStr || "";
        it._endTimeStr = first.endStr || "";
    }

    function formatRangeLabel(it) {
        if (!it) return "";
        const ranges = getItemRanges(it);
        if (!ranges.length) return "";
        if (ranges.length === 1) return formatOneRange(ranges[0]);
        const parts = ranges.map(formatOneRange).filter(Boolean);
        if (parts.length <= 2) return parts.join(" · ");
        return parts[0] + " 等" + parts.length + "段";
    }

    function updateRangeBadge($card, it) {
        if (!$card || !$card.length) return;
        $card.find(".lm-range-badge").remove();
        const label = formatRangeLabel(it);
        if (label) {
            const full = getItemRanges(it).map(formatOneRange).join("\n");
            $card.append(
                $("<span class='lm-range-badge'/>")
                    .text(label)
                    .attr("title", "m3u8 下载范围\n" + full)
            );
        }
    }

    /**
     * 选中 m3u8 时弹出多组起止时间对话框。
     * 填写一组 → 添加 → 候选列表；确定后写入 it._ranges（及兼容 _startSec/_endSec）。
     * 候选为空 = 完整片。取消则不选中。
     */
    function promptM3u8Range(it) {
        return new Promise((resolve) => {
            const $m = $("#lmRangeModal");
            const $start = $("#lmRangeStart");
            const $end = $("#lmRangeEnd");
            const $list = $("#lmRangeList");
            const $empty = $("#lmRangeListEmpty");
            const $count = $("#lmRangeCount");
            $("#lmRangeUrl").text(it.url || "");

            /** @type {{startSec:number,endSec:number|null,startStr:string,endStr:string}[]} */
            let draft = getItemRanges(it).map((r) => ({
                startSec: r.startSec != null ? r.startSec : 0,
                endSec: r.endSec != null && r.endSec > 0 ? r.endSec : null,
                startStr: r.startStr || "",
                endStr: r.endStr || "",
            }));

            const rangeKey = (r) => {
                const a = r.startSec != null ? +r.startSec : 0;
                const b = r.endSec != null && r.endSec > 0 ? +r.endSec : -1;
                return a + "|" + b;
            };

            const renderList = () => {
                $list.empty();
                draft.forEach((r, idx) => {
                    const $li = $("<li class='lm-range-item'/>");
                    $li.append($("<span class='lm-range-item-idx'/>").text(idx + 1 + "."));
                    $li.append($("<span class='lm-range-item-label'/>").text(formatOneRange(r)));
                    $li.append(
                        $("<button type='button' class='lm-range-item-x' title='删除此段'/>")
                            .text("×")
                            .on("click", (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                draft.splice(idx, 1);
                                renderList();
                            })
                    );
                    $list.append($li);
                });
                $count.text(String(draft.length));
                $empty.toggleClass("show", draft.length === 0);
            };

            const readInputRange = () => {
                const startStr = String($start.val() || "").trim() || "00:00:00";
                const endStr = String($end.val() || "").trim();
                const startSec = parseTimeToSeconds(startStr) || 0;
                let endSec = parseTimeToSeconds(endStr);
                if (endSec != null && endSec > 0 && endSec <= startSec) {
                    setStatus("结束时间须大于开始时间");
                    return null;
                }
                if (endSec != null && !(endSec > 0)) endSec = null;
                return {
                    startSec,
                    endSec,
                    startStr,
                    endStr,
                };
            };

            // 添加成功后保留输入框内容，便于在相近时间段上微调再加
            const tryAddFromInputs = () => {
                const r = readInputRange();
                if (!r) return false;
                // 若输入全是默认开头且结束为空，且已有候选，则不重复加「完整片」
                const isDefaultFull =
                    (r.startSec === 0 || !r.startSec) &&
                    (r.endSec == null || !(r.endSec > 0));
                if (isDefaultFull && draft.length > 0) {
                    // 用户可能只想点确定，不强制加
                    return true;
                }
                const key = rangeKey(r);
                if (draft.some((x) => rangeKey(x) === key)) {
                    setStatus("该时间段已在候选中");
                    return false;
                }
                draft.push(r);
                renderList();
                setStatus("已添加候选 " + formatOneRange(r));
                return true;
            };

            // 打开弹框时默认开始/结束均为 00:00:00（结束 00:00:00 视为「到末尾」）
            $start.val("00:00:00");
            $end.val("00:00:00");
            renderList();
            $m.removeClass("hide").attr("aria-hidden", "false");
            setTimeout(() => $start.trigger("focus").select(), 30);

            const cleanup = () => {
                $m.addClass("hide").attr("aria-hidden", "true");
                $("#lmRangeOk").off("click.range");
                $("#lmRangeCancel").off("click.range");
                $("#lmRangeAdd").off("click.range");
                $m.off("click.range");
                $(document).off("keydown.range");
            };
            const finish = (ok) => {
                if (ok) {
                    // 若输入框里还有有效一段且不在列表中，自动并入
                    const pending = readInputRange();
                    if (pending) {
                        const isDefaultFull =
                            (pending.startSec === 0 || !pending.startSec) &&
                            (pending.endSec == null || !(pending.endSec > 0));
                        if (!isDefaultFull || draft.length === 0) {
                            const key = rangeKey(pending);
                            if (!draft.some((x) => rangeKey(x) === key)) {
                                if (!isDefaultFull) draft.push(pending);
                            }
                        }
                    }
                    // draft 空 = 完整片（不写 clip）
                    it._ranges = draft.map((r) => ({
                        startSec: r.startSec,
                        endSec: r.endSec,
                        startStr: r.startStr,
                        endStr: r.endStr,
                    }));
                    syncLegacyRangeFields(it);
                    if (!it._ranges.length) {
                        it._startSec = null;
                        it._endSec = null;
                        it._startTimeStr = "";
                        it._endTimeStr = "";
                    }
                }
                cleanup();
                resolve(!!ok);
            };
            $("#lmRangeAdd").on("click.range", () => {
                tryAddFromInputs();
            });
            $("#lmRangeOk").on("click.range", () => finish(true));
            $("#lmRangeCancel").on("click.range", () => finish(false));
            $m.on("click.range", (e) => {
                if (e.target === $m[0]) finish(false);
            });
            $(document).on("keydown.range", (e) => {
                if (e.key === "Escape") finish(false);
                if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    // Enter：有有效截取段时优先「添加」，默认 00:00:00~00:00:00 则确定
                    const endFilled = String($end.val() || "").trim();
                    const startRaw = String($start.val() || "").trim();
                    const endIsDefault =
                        !endFilled || endFilled === "00:00:00" || endFilled === "0";
                    const startIsDefault =
                        !startRaw || startRaw === "00:00:00" || startRaw === "0";
                    const wantsAdd = !startIsDefault || !endIsDefault;
                    if (wantsAdd) {
                        tryAddFromInputs();
                    } else {
                        finish(true);
                    }
                }
            });
        });
    }

    async function toggle(key, $card) {
        if (selected.has(key)) {
            selected.delete(key);
            if ($card && $card.length) {
                applyCardSelected($card, key);
                updateStatusCount();
            } else {
                render();
            }
            return;
        }
        const it = items.find((x) => x._key === key);
        const type = it ? mediaTypeOf(it) : "";
        if (it && type === "m3u8") {
            const ok = await promptM3u8Range(it);
            if (!ok) {
                // 取消：保持未选中
                if ($card && $card.length) applyCardSelected($card, key);
                return;
            }
        }
        selected.add(key);
        if ($card && $card.length) {
            applyCardSelected($card, key);
            updateStatusCount();
        } else {
            render();
        }
    }

    // 单击延迟选择，避免与双击冲突；双击只预览
    let clickTimer = null;
    const CLICK_DELAY = 280;
    /** 网格动图/视频：悬停片刻才加载播放，同时只保留一个 */
    const HOVER_PLAY_MS = 380;
    let hoverPlayTimer = null;
    let hoverPlayCard = null;
    /** url -> 静态首帧 blob:/data: ，避免重绘时重复解码 */
    const posterCache = new Map();
    let posterIo = null;
    let posterInflight = 0;
    const POSTER_MAX_PARALLEL = 5;
    const posterQueue = [];

    function stopHoverPlay($card) {
        if (!$card || !$card.length) return;
        $card.removeClass("is-hover-playing");
        if (hoverHls && hoverPlayCard && hoverPlayCard[0] === $card[0]) {
            destroyHls(hoverHls);
            hoverHls = null;
        }
        const el = $card.find(".lm-card-motion")[0];
        if (el) {
            if (el.tagName === "VIDEO") {
                try {
                    el.pause();
                    el.removeAttribute("src");
                    el.load();
                } catch (_) {}
            }
            el.remove();
        }
        if (hoverPlayCard && hoverPlayCard[0] === $card[0]) hoverPlayCard = null;
    }

    function stopAllHoverPlay() {
        if (hoverPlayTimer) {
            clearTimeout(hoverPlayTimer);
            hoverPlayTimer = null;
        }
        destroyHls(hoverHls);
        hoverHls = null;
        $("#grid .lm-card.is-hover-playing").each(function () {
            stopHoverPlay($(this));
        });
        hoverPlayCard = null;
    }

    function fitSize(w, h, max) {
        w = w || 1;
        h = h || 1;
        const scale = Math.min(1, max / Math.max(w, h));
        return {
            w: Math.max(1, Math.round(w * scale)),
            h: Math.max(1, Math.round(h * scale)),
        };
    }

    function canvasToPosterUrl(canvas) {
        try {
            return canvas.toDataURL("image/jpeg", 0.72);
        } catch (_) {
            return null;
        }
    }

    /** 动图：解码后只取首帧；能导出则缓存 dataURL，跨域污染则返回 canvas 节点 */
    function captureImagePoster(url, it) {
        return new Promise((resolve) => {
            const img = new Image();
            img.decoding = "async";
            img.referrerPolicy = "no-referrer";
            let settled = false;
            const finish = (u) => {
                if (settled) return;
                settled = true;
                img.onload = null;
                img.onerror = null;
                try {
                    img.src = "";
                } catch (_) {}
                resolve(u);
            };
            img.onload = () => {
                try {
                    if (it && img.naturalWidth && img.naturalHeight) {
                        setItemDims(it, img.naturalWidth, img.naturalHeight);
                        onDimsReady(it);
                    }
                    const { w, h } = fitSize(img.naturalWidth, img.naturalHeight, 360);
                    const canvas = document.createElement("canvas");
                    canvas.width = w;
                    canvas.height = h;
                    canvas.getContext("2d").drawImage(img, 0, 0, w, h);
                    // 跨域图 toDataURL 会抛/污染：仍可用 canvas 直接显示首帧
                    const data = canvasToPosterUrl(canvas);
                    finish(data || canvas);
                } catch (_) {
                    finish(null);
                }
            };
            img.onerror = () => finish(null);
            img.src = url;
            setTimeout(() => finish(null), 20000);
        });
    }

    /** 视频：seek 到开头附近截一帧（不强制 crossOrigin，优先能播再截） */
    function captureVideoPoster(url, headersIt) {
        return new Promise((resolve) => {
            const v = document.createElement("video");
            v.muted = true;
            v.preload = "auto";
            v.playsInline = true;
            v.setAttribute("webkit-playsinline", "");
            let settled = false;
            let localHls = null;
            const finish = (u) => {
                if (settled) return;
                settled = true;
                destroyHls(localHls);
                localHls = null;
                try {
                    v.pause();
                    v.removeAttribute("src");
                    v.load();
                } catch (_) {}
                resolve(u);
            };
            const paint = () => {
                try {
                    if (!v.videoWidth) {
                        finish(null);
                        return;
                    }
                    if (headersIt) {
                        setItemDims(headersIt, v.videoWidth, v.videoHeight);
                        onDimsReady(headersIt);
                    }
                    const { w, h } = fitSize(v.videoWidth, v.videoHeight, 360);
                    const canvas = document.createElement("canvas");
                    canvas.width = w;
                    canvas.height = h;
                    canvas.getContext("2d").drawImage(v, 0, 0, w, h);
                    // 污染时 toDataURL 失败：仍返回 canvas 节点供直接展示
                    finish(canvasToPosterUrl(canvas) || canvas);
                } catch (_) {
                    finish(null);
                }
            };
            v.addEventListener("loadeddata", () => {
                try {
                    const t = Math.min(0.12, Math.max(0.04, (v.duration || 1) * 0.02));
                    if (typeof v.fastSeek === "function") v.fastSeek(t);
                    else v.currentTime = t;
                } catch (_) {
                    paint();
                }
            });
            v.addEventListener("seeked", paint);
            v.addEventListener("error", () => finish(null));
            const start = () => {
                if (/\.(m3u8|mpd)(\?|#|$)/i.test(url)) {
                    if (typeof Hls !== "undefined" && Hls.isSupported()) {
                        localHls = new Hls({ enableWorker: false });
                        localHls.loadSource(url);
                        localHls.attachMedia(v);
                        localHls.on(Hls.Events.ERROR, () => finish(null));
                    } else {
                        finish(null);
                    }
                } else {
                    v.src = url;
                }
            };
            applyPlayHeaders(headersIt || { url }, start);
            setTimeout(() => finish(null), 25000);
        });
    }

    async function getPosterUrl(it, type) {
        const url = it.url;
        if (!url) return null;
        // canvas 节点不跨次复用（可能已挂到别的卡片），只缓存字符串
        if (typeof it._posterUrl === "string" && it._posterUrl) return it._posterUrl;
        const cached = posterCache.get(url);
        if (typeof cached === "string" && cached) return cached;

        // 解析结果自带封面（Steam trailer poster 等）
        const thumb = it.thumb || it.poster || it.thumbnail || "";
        if (thumb && thumb !== url && /\.(jpe?g|png|webp|avif|gif)(\?|#|$)/i.test(thumb)) {
            const fromThumb = await captureImagePoster(thumb, it);
            if (fromThumb) {
                if (typeof fromThumb === "string") {
                    posterCache.set(url, fromThumb);
                    it._posterUrl = fromThumb;
                }
                return fromThumb;
            }
            // 封面图跨域失败时直接当 img 用
            posterCache.set(url, thumb);
            it._posterUrl = thumb;
            return thumb;
        }

        let poster = null;
        if (type === "gif") poster = await captureImagePoster(url, it);
        else poster = await captureVideoPoster(url, it);

        if (typeof poster === "string" && poster) {
            posterCache.set(url, poster);
            it._posterUrl = poster;
        }
        return poster;
    }

    function pumpPosterQueue() {
        while (posterInflight < POSTER_MAX_PARALLEL && posterQueue.length) {
            const job = posterQueue.shift();
            posterInflight++;
            Promise.resolve()
                .then(job)
                .finally(() => {
                    posterInflight--;
                    pumpPosterQueue();
                });
        }
    }

    function enqueuePoster(fn) {
        posterQueue.push(fn);
        pumpPosterQueue();
    }

    function applyPosterToCard($card, poster) {
        if (!$card || !poster) return;
        $card.find(".lm-card-poster").addClass("has-frame");
        if (typeof poster === "string") {
            const $img = $card.find("img.lm-card-poster-img");
            if ($img.length) $img.attr("src", poster).addClass("is-ready");
            return;
        }
        // HTMLCanvasElement：跨域无法导出时直接展示 canvas 首帧
        if (poster && poster.tagName === "CANVAS") {
            poster.className = "lm-card-poster-canvas is-ready";
            $card.find("img.lm-card-poster-img").remove();
            $card.find("canvas.lm-card-poster-canvas").remove();
            $card.find(".lm-card-poster").after(poster);
        }
    }

    function schedulePosterLoad($card, it, type) {
        const url = it.url;
        if (!url) return;
        if (it._posterUrl || posterCache.has(url)) {
            applyPosterToCard($card, it._posterUrl || posterCache.get(url));
            return;
        }
        enqueuePoster(async () => {
            // 卡片可能已重绘
            if (!$card.closest("body").length) return;
            const poster = await getPosterUrl(it, type);
            if (poster && $card.closest("body").length) applyPosterToCard($card, poster);
        });
    }

    function bindPosterLazy($card, it, type) {
        if (!posterIo) {
            posterIo = new IntersectionObserver(
                (entries) => {
                    for (const en of entries) {
                        if (!en.isIntersecting) continue;
                        const el = en.target;
                        posterIo.unobserve(el);
                        const $c = $(el);
                        const raw = $c.data("posterItem");
                        const t = $c.data("posterType");
                        if (raw) schedulePosterLoad($c, raw, t);
                    }
                },
                { root: null, rootMargin: "180px 0px", threshold: 0.01 }
            );
        }
        $card.data("posterItem", it);
        $card.data("posterType", type);
        posterIo.observe($card[0]);
    }

    function startHoverPlay($card, it, type) {
        if (!$card || !it || !it.url) return;
        if (hoverPlayCard && hoverPlayCard[0] !== $card[0]) stopHoverPlay(hoverPlayCard);
        hoverPlayCard = $card;
        if ($card.find(".lm-card-motion").length) {
            $card.addClass("is-hover-playing");
            return;
        }
        $card.addClass("is-hover-playing");
        // 动图：悬停才挂完整动图，离开卸掉
        if (type === "gif") {
            const $img = $("<img class='lm-card-motion'/>").attr({
                alt: "",
                referrerpolicy: "no-referrer",
                draggable: "false",
                src: it.url,
            });
            $card.prepend($img);
            return;
        }
        // 悬停预览带声音；若浏览器拦截有声 autoplay，回退静音再尝试
        const $v = $("<video class='lm-card-motion' loop playsinline preload='auto'/>");
        $card.prepend($v);
        const v = $v[0];
        v.muted = false;
        v.volume = 1;
        const playHoverWithSound = () => {
            v.muted = false;
            return v.play().catch(() => {
                v.muted = true;
                return v.play().then(() => {
                    // 部分浏览器要求先以 muted 启动，再在同一用户手势链外尝试取消静音
                    v.muted = false;
                }).catch(() => {});
            });
        };
        applyPlayHeaders(it, () => {
            // 卡片可能已离开
            if (!hoverPlayCard || hoverPlayCard[0] !== $card[0]) return;
            if (isStreamUrl(it.url, type)) {
                destroyHls(hoverHls);
                if (typeof Hls !== "undefined" && Hls.isSupported()) {
                    hoverHls = new Hls({ enableWorker: false });
                    hoverHls.loadSource(it.url);
                    hoverHls.attachMedia(v);
                    hoverHls.on(Hls.Events.MANIFEST_PARSED, () => {
                        playHoverWithSound();
                    });
                    hoverHls.on(Hls.Events.ERROR, (_e, data) => {
                        if (data && data.fatal) {
                            destroyHls(hoverHls);
                            hoverHls = null;
                        }
                    });
                }
            } else {
                // Steam extras mp4=HEVC 不可播 → 优先 webm
                const candidates = it._playUrl
                    ? [it._playUrl, ...playUrlCandidates(it.url)]
                    : playUrlCandidates(it.url);
                bindVideoSrcWithFallback(v, candidates, { autoplay: false, muted: false })
                    .then(({ url }) => {
                        it._playUrl = url;
                        if (!hoverPlayCard || hoverPlayCard[0] !== $card[0]) return;
                        playHoverWithSound();
                    })
                    .catch(() => {
                        // 悬停失败静默：保留首帧海报
                    });
            }
        });
    }

    // ---------- 卡片悬停详情（真实链接） ----------
    let tipHideTimer = null;
    let tipActiveCard = null;

    function hideCardTip() {
        if (tipHideTimer) {
            clearTimeout(tipHideTimer);
            tipHideTimer = null;
        }
        $("#lmCardTip").addClass("hide").attr("aria-hidden", "true").empty();
        if (tipActiveCard) {
            tipActiveCard.removeClass("has-tip");
            tipActiveCard = null;
        }
    }

    function positionCardTip($card) {
        const $tip = $("#lmCardTip");
        if (!$tip.length || $tip.hasClass("hide") || !$card || !$card.length) return;
        const rect = $card[0].getBoundingClientRect();
        const tipEl = $tip[0];
        const tw = tipEl.offsetWidth || 320;
        const th = tipEl.offsetHeight || 120;
        let left = rect.left;
        let top = rect.bottom + 6;
        if (left + tw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - tw - 8);
        if (left < 8) left = 8;
        if (top + th > window.innerHeight - 8) top = Math.max(8, rect.top - th - 6);
        $tip.css({ left: left + "px", top: top + "px" });
    }

    function showCardTip($card, it) {
        if (!it || !it.url) return;
        if (tipHideTimer) {
            clearTimeout(tipHideTimer);
            tipHideTimer = null;
        }
        const type = mediaTypeOf(it);
        const title = it.title || it.downFileName || it.name || "";
        const hasCookie = !!(it._headers && (it._headers.Cookie || it._headers.cookie));
        const ref =
            (it._headers && (it._headers.Referer || it._headers.referer)) ||
            it.referer ||
            it._pageUrl ||
            "";
        const $tip = $("#lmCardTip").empty().removeClass("hide").attr("aria-hidden", "false");
        if (tipActiveCard) tipActiveCard.removeClass("has-tip");
        tipActiveCard = $card;
        $card.addClass("has-tip");

        const row = (k, v, isUrl) => {
            const $r = $("<div class='tip-row'/>");
            $r.append($("<span class='tip-k'/>").text(k));
            if (isUrl) $r.append($("<span class='tip-url'/>").text(v || "—"));
            else $r.append(document.createTextNode(v || "—"));
            return $r;
        };
        $tip.append(row("类型", type + (it.source ? " · " + it.source : "")));
        if (title) $tip.append(row("标题", title));
        if (it._w && it._h) {
            $tip.append(
                row(
                    "分辨率",
                    it._w + "×" + it._h + (it._resMetric ? " · 指标 " + it._resMetric + "p" : "")
                )
            );
        }
        $tip.append(row("链接", it.url, true));
        if (it.thumb && it.thumb !== it.url) $tip.append(row("封面", it.thumb, true));
        if (ref) $tip.append(row("Referer", ref, true));
        $tip.append(row("Cookie", hasCookie ? "有" : "无"));
        const ranges = getItemRanges(it);
        if (ranges.length) {
            $tip.append(
                row(
                    "下载范围",
                    ranges.length === 1
                        ? formatOneRange(ranges[0])
                        : ranges.map((r, i) => i + 1 + ". " + formatOneRange(r)).join(" | ")
                )
            );
        }
        const $acts = $("<div class='tip-actions'/>");
        if (type === "m3u8") {
            $acts.append(
                $("<button type='button'/>")
                    .text("设置范围")
                    .on("click", async (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const ok = await promptM3u8Range(it);
                        if (ok) {
                            updateRangeBadge($card, it);
                            const n = getItemRanges(it).length;
                            setStatus(
                                n
                                    ? "已保存 " + n + " 个时间段 · " + (formatRangeLabel(it) || "")
                                    : "已设为完整片"
                            );
                        }
                    })
            );
        }
        $acts.append(
            $("<button type='button'/>")
                .text("复制链接")
                .on("click", async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    try {
                        await navigator.clipboard.writeText(it.url);
                        setStatus("已复制链接");
                    } catch (_) {
                        setStatus(it.url);
                    }
                })
        );
        $acts.append(
            $("<button type='button'/>")
                .text("新标签打开")
                .on("click", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    window.open(it.url, "_blank", "noopener");
                })
        );
        $acts.append(
            $("<button type='button'/>")
                .text("大图预览")
                .on("click", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    hideCardTip();
                    stopAllHoverPlay();
                    openPreview(it);
                })
        );
        $tip.append($acts);

        // 鼠标移入 tip 不关掉；离开 tip 再关
        $tip.off(".lmtip").on("pointerenter.lmtip", () => {
            if (tipHideTimer) {
                clearTimeout(tipHideTimer);
                tipHideTimer = null;
            }
        });
        $tip.on("pointerleave.lmtip", () => {
            tipHideTimer = setTimeout(hideCardTip, 120);
        });

        positionCardTip($card);
        // 布局后再算一次高度
        requestAnimationFrame(() => positionCardTip($card));
    }

    function bindCardEvents($card, it, key) {
        const type = mediaTypeOf(it);
        const isMotion = type === "gif" || type === "video" || type === "m3u8" || type === "dash";

        $card.on("click", (e) => {
            if ($(e.target).is("input.ck")) return;
            e.preventDefault();
            if (clickTimer) clearTimeout(clickTimer);
            clickTimer = setTimeout(() => {
                clickTimer = null;
                toggle(key, $card); // async; fire-and-forget
            }, CLICK_DELAY);
        });
        $card.on("dblclick", (e) => {
            if ($(e.target).is("input.ck")) return;
            e.preventDefault();
            e.stopPropagation();
            if (clickTimer) {
                clearTimeout(clickTimer);
                clickTimer = null;
            }
            hideCardTip();
            stopAllHoverPlay();
            openPreview(it);
        });
        $card.find("input.ck").on("click", async (e) => {
            e.stopPropagation();
            if (clickTimer) {
                clearTimeout(clickTimer);
                clickTimer = null;
            }
            await toggle(key, $card);
        });

        $card.on("pointerenter", (e) => {
            if (e.originalEvent && e.originalEvent.pointerType === "touch") return;
            showCardTip($card, it);
            if (isMotion) {
                if (hoverPlayTimer) clearTimeout(hoverPlayTimer);
                hoverPlayTimer = setTimeout(() => {
                    hoverPlayTimer = null;
                    startHoverPlay($card, it, type);
                }, HOVER_PLAY_MS);
            }
        });
        $card.on("pointerleave", () => {
            if (hoverPlayTimer) {
                clearTimeout(hoverPlayTimer);
                hoverPlayTimer = null;
            }
            stopHoverPlay($card);
            // 稍延时，便于移入 tip 浮层
            tipHideTimer = setTimeout(hideCardTip, 160);
        });
    }

    function render() {
        if (clickTimer) {
            clearTimeout(clickTimer);
            clickTimer = null;
        }
        hideCardTip();
        stopAllHoverPlay();
        if (posterIo) {
            posterIo.disconnect();
            posterIo = null;
        }
        posterQueue.length = 0;
        const list = getFilteredItems();
        const $grid = $("#grid").empty();
        list.forEach((it) => {
            const key = it._key;
            const type = mediaTypeOf(it);
            const checked = selected.has(key);
            const isMotion = type === "gif" || type === "video" || type === "m3u8" || type === "dash";
            const $card = $("<div class='lm-card'/>")
                .toggleClass("selected", checked)
                .toggleClass("lm-card-motion-ready", isMotion)
                .attr("data-key", key)
                .attr("data-type", type);
            if (type === "image") {
                const $img = $("<img class='lm-card-static'/>").attr({
                    src: it.url,
                    alt: "",
                    loading: "lazy",
                    referrerpolicy: "no-referrer",
                    draggable: "false",
                });
                $img.on("load", function () {
                    if (this.naturalWidth && this.naturalHeight) {
                        setItemDims(it, this.naturalWidth, this.naturalHeight);
                        onDimsReady(it);
                    }
                });
                $card.append($img);
            } else if (type === "audio") {
                $card.append($("<div class='lm-card-poster'/>"));
                $card.append($("<div class='lm-card-play'/>").text("♪"));
            } else if (isMotion) {
                // 默认静态首帧（懒加载截取）；悬停才播完整动图/视频
                $card.append($("<div class='lm-card-poster'/>"));
                $card.append(
                    $("<img class='lm-card-poster-img' alt='' draggable='false'/>").attr({
                        referrerpolicy: "no-referrer",
                    })
                );
                $card.append($("<div class='lm-card-play'/>").text(type === "gif" ? "GIF" : "▶"));
                bindPosterLazy($card, it, type);
            } else {
                $card.append($("<div class='lm-card-play'/>").text("▶"));
            }
            $card.append($("<span class='badge'/>").text(type));
            $card.append($("<input type='checkbox' class='ck'/>").prop("checked", checked));
            const hasCookie = itemHasCookie(it);
            $card.append(
                $("<span/>")
                    .addClass("cookie-flag" + (hasCookie ? "" : " no"))
                    .text(hasCookie ? "Cookie" : "无Cookie")
            );
            updateCardDimBadge($card, it);
            updateRangeBadge($card, it);
            bindCardEvents($card, it, key);
            $grid.append($card);
        });
        applyPairMarks();
        updateStatusCount(list.length);
    }

    function getSelectedItems() {
        return items.filter((it) => selected.has(it._key));
    }

    async function enrichHeaders(list, pageUrl) {
        for (const it of list) {
            if (pageUrl) {
                it._pageUrl = pageUrl;
                if (!it.referer) it.referer = pageUrl;
            }
            it._headers = await LMW.buildHeadersForItem(it, pageUrl);
        }
    }

    async function getPageUrl() {
        if (!tabId) return "";
        try {
            const tab = await chrome.tabs.get(tabId);
            return tab.url || "";
        } catch {
            return "";
        }
    }

    /**
     * 同一媒体的去重键：跨 CDN / 不同 query / 缩略尺寸变体视为同一项。
     * （PAGE_IMAGE_FN 内有同名逻辑，需两边保持一致）
     */
    function mediaDedupeKey(raw) {
        if (!raw || typeof raw !== "string") return "";
        try {
            const u = new URL(raw, "https://local.invalid");
            let path = decodeURIComponent(u.pathname || "").toLowerCase().replace(/\/{2,}/g, "/");
            path = path.replace(/[-_]\d{2,4}x\d{2,4}(?=\.[a-z0-9]+$)/i, "");
            path = path.replace(/[._-](?:thumb|thumbnail|small|mini|preview|tiny)(?=\.[a-z0-9]+$)/i, "");
            const file = path.split("/").filter(Boolean).pop() || "";
            const num = file.match(/^(\d{5,})\./);
            if (num && /\/(images?|media|pin|gif|video|upload|content|pinporn)\//i.test(path)) {
                return "id:" + num[1];
            }
            const steamHash = path.match(/\/extras\/([a-f0-9]{16,})\.(?:mp4|webm)$/i);
            if (steamHash) return "steam-extra:" + steamHash[1].toLowerCase();
            const trailer = path.match(/\/store_trailers\/(\d+)\/(\d+)\//i);
            if (trailer && /\.(m3u8|mpd)$/i.test(path)) {
                return "steam-trailer:" + trailer[1] + ":" + trailer[2];
            }
            if (/\.(mp4|webm|mov|m4v)$/i.test(path)) {
                const stemPath = path.replace(/\.(mp4|webm|mov|m4v)$/i, "");
                if (/\/(video|videos|media|extras|trailers?|movies?)\//i.test(stemPath) || stemPath.length > 24) {
                    return "vstem:" + stemPath;
                }
            }
            // 图床路径：忽略 host，只认 path（sex.com 多 CDN 同源文件）
            if (/\/(images?|media|uploads?|pinporn|static\/media|store_item_assets)\//i.test(path) && MEDIA_PATH_HAS_EXT(path)) {
                return "path:" + path.replace(/\.(mp4|webm)$/i, ".video");
            }
            const drop = new Set([
                "w", "h", "width", "height", "size", "quality", "q", "fit", "crop",
                "format", "fm", "auto", "dpr", "v", "_", "t", "timestamp", "cache",
                "download", "name", "filename",
            ]);
            const keys = [...u.searchParams.keys()];
            for (const k of keys) {
                if (drop.has(k.toLowerCase()) || /^utm_/i.test(k) || /^fbclid$/i.test(k)) {
                    u.searchParams.delete(k);
                }
            }
            u.hash = "";
            const host = (u.hostname || "").replace(/^www\./, "").toLowerCase();
            const proto = (u.protocol || "https:").toLowerCase();
            let q = u.searchParams.toString();
            if (q) q = "?" + q;
            return ("url:" + proto + "//" + host + path + q).toLowerCase();
        } catch (_) {
            return "raw:" + String(raw).toLowerCase().replace(/#.*$/, "").split("?")[0];
        }
    }

    function MEDIA_PATH_HAS_EXT(path) {
        return /\.(jpe?g|png|gif|webp|avif|bmp|mp4|webm|mov|m4v|m3u8|mpd)(\?|#|$)/i.test(path);
    }

    /** 同键时更倾向「更像原图 / 浏览器可播」的 URL */
    function preferMediaUrl(a, b) {
        if (!a) return b;
        if (!b) return a;
        const score = (u) => {
            let s = 0;
            try {
                const x = new URL(u);
                if (!x.search) s += 3;
                if (!/thumb|small|preview|\d+x\d+/i.test(x.pathname)) s += 2;
                if (/imagex|cdn\.live|original|full|large/i.test(x.hostname + x.pathname)) s += 2;
                // Steam extras：webm(VP9) 可直接预览，mp4 多为 HEVC
                if (/\/extras\/[a-f0-9]{16,}\.webm$/i.test(x.pathname)) s += 8;
                if (/\/extras\/[a-f0-9]{16,}\.mp4$/i.test(x.pathname)) s -= 4;
                s += Math.min(x.href.length, 200) / 200;
            } catch (_) {}
            return s;
        };
        return score(a) >= score(b) ? a : b;
    }

    function mergeMediaItem(map, it) {
        if (!it || !it.url) return;
        const key = mediaDedupeKey(it.url);
        if (!key) return;
        const prev = map.get(key);
        if (!prev) {
            map.set(key, it);
            return;
        }
        const sc = it.score || 0;
        const psc = prev.score || 0;
        if (sc > psc) {
            map.set(key, {
                ...it,
                title: it.title || prev.title,
                thumb: it.thumb || prev.thumb,
            });
        } else if (sc === psc) {
            const better = preferMediaUrl(it.url, prev.url);
            if (better === it.url) {
                map.set(key, {
                    ...it,
                    title: it.title || prev.title,
                    thumb: prev.thumb || it.thumb,
                });
            } else {
                prev.title = prev.title || it.title;
            }
        } else {
            prev.title = prev.title || it.title;
            if (!prev.thumb && it.thumb) prev.thumb = it.thumb;
        }
    }

    /**
     * 在页面上下文中解析图片/动图，尽量取「大图」而非缩略图。
     * 策略：DOM img/video → 网络资源(Performance) → 页内 JSON/RSC（initialData 等）→
     * data-* / srcset / 父级 a[href]；并收集同站详情页供再探。
     *
     * 典型坑（如 sex.com/gifs）：列表 CSR，真实动图多为 animated webp / 静音循环 video，
     * 路径在嵌入 JSON 的 uri 字段，需拼 staticPinImageDomain 才是可下载地址。
     */
    const PAGE_IMAGE_FN = () => {
        const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|jfif)(\?|#|$)/i;
        const VIDEO_EXT = /\.(mp4|webm|mov|m4v|mkv)(\?|#|$)/i;
        const AUDIO_EXT = /\.(mp3|m4a|aac|flac|wav|ogg|opus|wma|oga)(\?|#|$)/i;
        const STREAM_EXT = /\.(m3u8|mpd)(\?|#|$)/i;
        const MEDIA_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|jfif|mp4|webm|mov|m4v|m3u8|mpd)(\?|#|$)/i;
        const SKIP_URL =
            /sprite|favicon|emoji|1x1|pixel\.|\/icons?\/|logo[^/]*\.(png|svg|webp)|avatar.*\d{1,2}x\d{1,2}|_next\/static|\/static\/media\/|recaptcha|doubleclick|googlesyndication|adsystem|adservice|twinrd|kinkly|facebook\.com|twitter\.com|\/ads?[\/._-]|analytics|gtm\.js|webpack|chunk/i;
        const AD_HOST =
            /doubleclick|googlesyndication|adservice|adnxs|adsystem|twinrd|taboola|outbrain|exoclick|trafficjunky|ad\.|ads\./i;
        const DATA_KEYS = [
            "data-src",
            "data-original",
            "data-origin",
            "data-original-src",
            "data-url",
            "data-lazy-src",
            "data-lazy",
            "data-full",
            "data-fullsrc",
            "data-full-src",
            "data-full-url",
            "data-large",
            "data-large-src",
            "data-big",
            "data-zoom",
            "data-zoom-image",
            "data-zoom-src",
            "data-hi-res",
            "data-hires",
            "data-highres",
            "data-high-res",
            "data-image",
            "data-img",
            "data-bg",
            "data-background",
            "data-raw-src",
            "data-actualsrc",
            "data-actual-src",
            "data-main",
            "data-main-src",
            "data-super-src",
            "data-download",
            "data-download-url",
            "data-video",
            "data-video-src",
            "data-mp4",
            "data-webm",
            "data-poster",
            "data-thumb",
            "data-thumbnail",
        ];
        const SRCSET_KEYS = ["data-srcset", "data-lazy-srcset", "data-original-srcset"];
        const pageIsGifSection = /\/gifs?(?:\/|$|\?)/i.test(location.pathname + location.search);
        const pageHost = location.hostname.replace(/^www\./, "");

        function abs(u, base) {
            if (!u || typeof u !== "string") return null;
            u = u.trim().replace(/^url\(["']?|["']?\)$/gi, "");
            if (!u || u.startsWith("data:") || u.startsWith("blob:") || u.startsWith("about:")) return null;
            try {
                return new URL(u, base || location.href).href;
            } catch (_) {
                return null;
            }
        }

        function isSkip(u) {
            if (!u) return true;
            if (SKIP_URL.test(u)) return true;
            try {
                if (AD_HOST.test(new URL(u).hostname)) return true;
            } catch (_) {}
            return false;
        }

        function isImageUrl(u) {
            if (!u) return false;
            if (IMAGE_EXT.test(u)) return true;
            if (/\/(image|img|photo|media|cdn|upload|pinporn)\//i.test(u) && !/\.html?(?:\?|#|$)/i.test(u)) {
                return true;
            }
            return false;
        }

        function isMediaUrl(u) {
            return (
                isImageUrl(u) ||
                VIDEO_EXT.test(u || "") ||
                AUDIO_EXT.test(u || "") ||
                STREAM_EXT.test(u || "")
            );
        }

        function guessMediaType(u, forceGif) {
            if (!u) return "image";
            if (/\.m3u8(\?|#|$)/i.test(u) || /hls[^/]*\.m3u8|\/hls_/i.test(u)) return "m3u8";
            if (/\.mpd(\?|#|$)/i.test(u) || /dash[^/]*\.mpd|\/dash_/i.test(u)) return "dash";
            if (/\.gif(\?|#|$)/i.test(u)) return "gif";
            if (AUDIO_EXT.test(u)) return "audio";
            if (VIDEO_EXT.test(u)) return forceGif ? "gif" : "video";
            if (/\.webp(\?|#|$)/i.test(u) && (pageIsGifSection || forceGif || /\/gif|pinporn|animated/i.test(u))) {
                return "gif";
            }
            if (forceGif) return "gif";
            return "image";
        }

        function parseSrcset(srcset) {
            if (!srcset) return [];
            return srcset
                .split(",")
                .map((part) => {
                    const bits = part.trim().split(/\s+/);
                    const url = abs(bits[0]);
                    if (!url) return null;
                    let score = 1;
                    const d = bits[1] || "";
                    if (d.endsWith("w")) score = parseInt(d, 10) || 1;
                    else if (d.endsWith("x")) score = Math.round((parseFloat(d) || 1) * 2000);
                    return { url, score };
                })
                .filter(Boolean);
        }

        function bestSrcset(srcset) {
            const list = parseSrcset(srcset);
            if (!list.length) return null;
            list.sort((a, b) => b.score - a.score);
            return list[0];
        }

        function upgradeUrl(u) {
            if (!u) return u;
            let s = u;
            s = s.replace(/-\d{2,4}x\d{2,4}(\.[a-zA-Z]+)(\?|#|$)/, "$1$2");
            s = s.replace(/[._-](?:thumb|thumbnail|small|mini|tiny|preview|sq)(?=\.[a-zA-Z]+(?:\?|#|$))/i, "");
            s = s.replace(/\/(?:thumbs?|thumbnails?|small|preview)\//i, "/");
            s = s.replace(/([/_-])s(\.[a-zA-Z]+)(\?|#|$)/, "$1b$2$3");
            s = s.replace(/([/_-])m(\.[a-zA-Z]+)(\?|#|$)/, "$1l$2$3");
            try {
                const url = new URL(s);
                ["w", "h", "width", "height"].forEach((k) => {
                    if (!url.searchParams.has(k)) return;
                    const n = parseInt(url.searchParams.get(k), 10);
                    if (!isNaN(n) && n > 0 && n < 900) url.searchParams.delete(k);
                });
                if (/^(small|thumb|thumbnail|preview)$/i.test(url.searchParams.get("size") || "")) {
                    url.searchParams.set("size", "large");
                }
                return url.href;
            } catch (_) {
                return s;
            }
        }

        const mediaBases = [];
        function noteBaseFromUrl(u) {
            if (!u || isSkip(u)) return;
            try {
                const url = new URL(u, location.href);
                if (AD_HOST.test(url.hostname)) return;
                if (/_next|staticp\./i.test(url.hostname + url.pathname)) return;
                if (
                    /\/images\//i.test(url.pathname) ||
                    MEDIA_EXT.test(url.pathname) ||
                    /cdn|media|img|image|pin|video/i.test(url.hostname)
                ) {
                    if (!mediaBases.includes(url.origin)) mediaBases.push(url.origin);
                }
            } catch (_) {}
        }

        function resolveMediaPath(path) {
            if (!path || typeof path !== "string") return null;
            path = path.trim();
            if (/^https?:\/\//i.test(path)) return abs(path);
            if (path.startsWith("//")) return abs(path);
            if (path.startsWith("/")) {
                for (const base of mediaBases) {
                    const full = abs(path, base);
                    if (full) return full;
                }
                return abs(path);
            }
            return abs(path);
        }

        const map = new Map();
        const probePages = new Set();

        function addCandidate(rawUrl, score, thumb, title, opts) {
            opts = opts || {};
            let u = opts.resolved ? rawUrl : resolveMediaPath(rawUrl) || abs(rawUrl);
            if (!u || isSkip(u)) return;
            try {
                const h = new URL(u).hostname.replace(/^www\./, "");
                if (h !== pageHost && AD_HOST.test(h)) return;
            } catch (_) {
                return;
            }
            noteBaseFromUrl(u);
            const upgraded = upgradeUrl(u);
            // 优先升级后的大图 URL，但去重键忽略 CDN/query/尺寸后缀
            // 视频同 stem 的 mp4 优先于 webm
            let final = upgraded && upgraded !== u ? upgraded : u;
            if (VIDEO_EXT.test(final) && /\.webm(\?|#|$)/i.test(final)) {
                // 若之后有 mp4 会再覆盖；此处先记
            }
            const sc = score + (upgraded && upgraded !== u ? 5 : 0);
            const key = mediaDedupeKeyInPage(final);
            if (!key) return;
            const mt = opts.media_type || guessMediaType(final, opts.forceGif);
            const prev = map.get(key);
            const preferVideoUrl = (a, b) => {
                // 同资源：m3u8 > mpd；Steam extras 优先 webm(VP9，浏览器可播) > mp4(多为 HEVC)
                const rank = (x) => {
                    if (/\.m3u8(\?|#|$)/i.test(x)) return 40;
                    if (/\.mpd(\?|#|$)/i.test(x)) return 30;
                    const steamExtra = /\/extras\/[a-f0-9]{16,}\.(mp4|webm)(\?|#|$)/i.test(x);
                    if (steamExtra && /\.webm(\?|#|$)/i.test(x)) return 25;
                    if (steamExtra && /\.mp4(\?|#|$)/i.test(x)) return 15;
                    if (/\.webm(\?|#|$)/i.test(x)) return 18;
                    if (/\.mp4(\?|#|$)/i.test(x)) return 16;
                    return 0;
                };
                if (rank(a) !== rank(b)) return rank(a) > rank(b) ? a : b;
                try {
                    const ua = new URL(a);
                    const ub = new URL(b);
                    let sa = 0;
                    let sb = 0;
                    if (!ua.search) sa += 2;
                    if (!ub.search) sb += 2;
                    if (/imagex|cdn\.live|original|full|steamstatic|akamai/i.test(ua.hostname)) sa += 1;
                    if (/imagex|cdn\.live|original|full|steamstatic|akamai/i.test(ub.hostname)) sb += 1;
                    return sa >= sb ? a : b;
                } catch (_) {
                    return a.length >= b.length ? a : b;
                }
            };
            if (!prev || sc > prev.score) {
                map.set(key, {
                    url: final,
                    thumb: thumb || prev?.thumb || final,
                    score: sc,
                    title: title || prev?.title || "",
                    media_type: mt,
                    type:
                        mt === "m3u8"
                            ? "application/vnd.apple.mpegurl"
                            : mt === "dash"
                              ? "application/dash+xml"
                              : mt === "video"
                                ? "video/*"
                                : mt === "gif"
                                  ? "image/gif"
                                  : "image/*",
                    source: opts.source || "dom",
                });
            } else if (sc === prev.score) {
                const better = preferVideoUrl(final, prev.url);
                if (better === final) {
                    prev.url = final;
                    prev.media_type = mt || prev.media_type;
                }
                if (title && !prev.title) prev.title = title;
                if (thumb && !prev.thumb) prev.thumb = thumb;
            } else {
                if (title && !prev.title) prev.title = title;
                if (thumb && !prev.thumb) prev.thumb = thumb;
                // 低分但格式更好（如已有 webm、新来 mp4）也升级 URL
                if (preferVideoUrl(final, prev.url) === final && mediaDedupeKeyInPage(final) === key) {
                    prev.url = final;
                    if (mt) prev.media_type = mt;
                }
            }
        }

        /** 页内去重键：同文件跨 CDN / query / 尺寸 / 容器格式变体合并 */
        function mediaDedupeKeyInPage(raw) {
            if (!raw || typeof raw !== "string") return "";
            try {
                const u = new URL(raw, location.href);
                let path = decodeURIComponent(u.pathname || "").toLowerCase().replace(/\/{2,}/g, "/");
                path = path.replace(/[-_]\d{2,4}x\d{2,4}(?=\.[a-z0-9]+$)/i, "");
                path = path.replace(/[._-](?:thumb|thumbnail|small|mini|preview|tiny)(?=\.[a-z0-9]+$)/i, "");
                const file = path.split("/").filter(Boolean).pop() || "";
                const num = file.match(/^(\d{5,})\./);
                if (num && /\/(images?|media|pin|gif|video|upload|content|pinporn)\//i.test(path)) {
                    return "id:" + num[1];
                }
                // Steam extras: 同 hash 的 mp4/webm 合并
                const steamHash = path.match(/\/extras\/([a-f0-9]{16,})\.(?:mp4|webm)$/i);
                if (steamHash) return "steam-extra:" + steamHash[1].toLowerCase();
                // trailer 目录：同一 trailer id 的 hls/dash 合并，优先保留 hls（由 prefer 处理）
                const trailer = path.match(/\/store_trailers\/(\d+)\/(\d+)\//i);
                if (trailer && STREAM_EXT.test(path)) {
                    return "steam-trailer:" + trailer[1] + ":" + trailer[2];
                }
                // 同路径去扩展名（mp4/webm 成对）
                if (/\.(mp4|webm|mov|m4v)$/i.test(path)) {
                    const stemPath = path.replace(/\.(mp4|webm|mov|m4v)$/i, "");
                    if (/\/(video|videos|media|extras|trailers?|movies?)\//i.test(stemPath) || stemPath.length > 24) {
                        return "vstem:" + stemPath;
                    }
                }
                if (
                    /\/(images?|media|uploads?|pinporn|store_item_assets)\//i.test(path) &&
                    /\.(jpe?g|png|gif|webp|avif|bmp|mp4|webm|mov|m4v|m3u8|mpd)(\?|#|$)/i.test(path)
                ) {
                    return "path:" + path.replace(/\.(mp4|webm)$/i, ".video");
                }
                const drop = new Set([
                    "w", "h", "width", "height", "size", "quality", "q", "fit", "crop",
                    "format", "fm", "auto", "dpr", "v", "_", "t", "timestamp", "cache",
                ]);
                for (const k of [...u.searchParams.keys()]) {
                    if (drop.has(k.toLowerCase()) || /^utm_/i.test(k)) u.searchParams.delete(k);
                }
                u.hash = "";
                const host = u.hostname.replace(/^www\./, "").toLowerCase();
                let q = u.searchParams.toString();
                if (q) q = "?" + q;
                // 流媒体去掉无关 query 后按 path 去重
                if (STREAM_EXT.test(path)) {
                    return "stream:" + host + path.replace(/\/(dash_[^/]+|hls_[^/]+)$/i, "/stream");
                }
                return ("url:" + u.protocol + "//" + host + path + q).toLowerCase();
            } catch (_) {
                return "raw:" + String(raw).toLowerCase().replace(/#.*$/, "").split("?")[0];
            }
        }

        function collectFromEl(el, baseScore) {
            if (!el || !el.getAttribute) return;
            for (const k of DATA_KEYS) {
                const v = el.getAttribute(k);
                if (v) addCandidate(v, baseScore + 20, null, "", { source: "data-attr" });
            }
            for (const k of SRCSET_KEYS) {
                const v = el.getAttribute(k);
                const b = bestSrcset(v);
                if (b) addCandidate(b.url, baseScore + 25 + Math.min(b.score / 20, 40), null, "", { source: "srcset" });
            }
        }

        function maybeProbe(href) {
            if (!href || href.startsWith("javascript:")) return;
            try {
                const u = new URL(href, location.href);
                if (u.hostname.replace(/^www\./, "") !== pageHost) return;
                if (u.pathname === location.pathname) return;
                // 导航/列表页不探；带数字 id 的内容页可以
                if (
                    /\/(login|signup|premium|categories|channels|pornstars|search|terms|privacy|cookie)(\/|$)/i.test(
                        u.pathname
                    ) &&
                    !/\/\d{4,}/.test(u.pathname)
                ) {
                    return;
                }
                probePages.add(u.href);
            } catch (_) {}
        }

        try {
            for (const e of performance.getEntriesByType("resource")) {
                noteBaseFromUrl(e.name);
            }
        } catch (_) {}

        // 页内 JSON / RSC
        (function harvestEmbedded() {
            const blobs = [];
            try {
                document.querySelectorAll("script").forEach((s) => {
                    const t = s.textContent || "";
                    if (t.length > 40 && t.length < 2500000 && /uri|Domain|pinporn|webp|gif|image|cdn/i.test(t)) {
                        blobs.push(t);
                    }
                });
                const html = document.documentElement ? document.documentElement.innerHTML : "";
                if (html && html.length) {
                    const markers = ["staticPinImageDomain", "initialData", "pinporn", '"uri":', "pinType"];
                    for (const mk of markers) {
                        let from = 0;
                        let hits = 0;
                        while (hits < 8) {
                            const i = html.indexOf(mk, from);
                            if (i < 0) break;
                            blobs.push(html.slice(Math.max(0, i - 200), Math.min(html.length, i + 120000)));
                            from = i + mk.length;
                            hits++;
                        }
                    }
                }
            } catch (_) {}

            // RSC / 双重转义 JSON：先把 \" \/ 还原，再跑统一正则
            let text = blobs.join("\n");
            if (!text) return;
            for (let i = 0; i < 3; i++) {
                if (!/\\["\/]/.test(text)) break;
                text = text.replace(/\\"/g, '"').replace(/\\\//g, "/");
            }

            const domainKeys = [
                "staticPinImageDomain",
                "staticImageDomain",
                "staticVideoDomainCf",
                "staticVideoDomain",
                "imageDomain",
                "cdnDomain",
                "mediaDomain",
            ];
            for (const k of domainKeys) {
                const re = new RegExp('"' + k + '"\\s*:\\s*"(https?:[^"]+)"', "gi");
                let m;
                while ((m = re.exec(text))) {
                    const d = m[1].replace(/\/$/, "");
                    try {
                        const origin = new URL(d).origin;
                        if (!mediaBases.includes(origin)) mediaBases.unshift(origin);
                    } catch (_) {}
                }
            }

            const forceGif = pageIsGifSection || /"pinType"\s*:\s*"gif"/i.test(text);

            const uriRe = /"uri"\s*:\s*"(\/[^"]+\.(?:webp|gif|jpe?g|png|mp4|webm)[^"]*)"/gi;
            let um;
            while ((um = uriRe.exec(text))) {
                const pth = um[1];
                const full = resolveMediaPath(pth);
                if (full) addCandidate(full, 88, null, "", { forceGif, source: "embedded-uri", resolved: true });
            }

            // 无 CDN 时仍收集相对路径，用第一个 mediaBase 或稍后 performance 补齐
            if (!mediaBases.length) {
                const loose = /\/images\/[a-z0-9/_.-]+\.(?:webp|gif|jpe?g|png|mp4|webm)/gi;
                let lm;
                const paths = new Set();
                while ((lm = loose.exec(text))) paths.add(lm[0]);
                // 常见 pin 图 CDN 兜底（仅当页内已出现该域名字符串时）
                const hint = text.match(/https?:\/\/[a-z0-9.-]*cdn[a-z0-9.-]*/i);
                if (hint) {
                    try {
                        mediaBases.unshift(new URL(hint[0]).origin);
                    } catch (_) {}
                }
                for (const pth of paths) {
                    const full = resolveMediaPath(pth);
                    if (full) addCandidate(full, 86, null, "", { forceGif, source: "embedded-path", resolved: true });
                }
            }

            const absRe =
                /https?:\/\/[a-z0-9.-]+(?:\/[a-zA-Z0-9_./%-]+)+\.(?:webp|gif|jpe?g|png|mp4|webm)(?:\?[^"'\s]*)?/gi;
            let am;
            const seenAbs = new Set();
            while ((am = absRe.exec(text))) {
                const u = am[0];
                if (seenAbs.has(u) || isSkip(u)) continue;
                seenAbs.add(u);
                if (/_next\/static|static\/media|favicon|logo/i.test(u)) continue;
                addCandidate(u, 70, null, "", { forceGif, source: "embedded-abs", resolved: true });
            }

            const titled2 =
                /"uri"\s*:\s*"(\/[^"]+\.(?:webp|gif|jpe?g|png)[^"]*)"\s*,\s*"title"\s*:\s*"([^"]{0,120})"/gi;
            let tm;
            while ((tm = titled2.exec(text))) {
                const full = resolveMediaPath(tm[1]);
                if (full) {
                    addCandidate(full, 92, null, tm[2], { forceGif, source: "embedded-title", resolved: true });
                }
            }
        })();

        // Performance：含已加载的 mp4/webm/m3u8
        try {
            for (const e of performance.getEntriesByType("resource")) {
                const n = e.name;
                if (!n || isSkip(n)) continue;
                if (!MEDIA_EXT.test(n) && !/\/images\/|\/video\/|\/media\/|\/trailers?\/|\/extras\//i.test(n)) {
                    continue;
                }
                if (/_next\/static|static\/media/i.test(n)) continue;
                let sc = 55;
                if (/\.gif(\?|#|$)/i.test(n)) sc = 80;
                if (pageIsGifSection && /\.webp(\?|#|$)/i.test(n)) sc = 78;
                if (VIDEO_EXT.test(n)) sc = 84;
                if (AUDIO_EXT.test(n)) sc = 86;
                if (STREAM_EXT.test(n) || /m3u8|\.mpd/i.test(n)) sc = 92;
                if (e.transferSize > 50000) sc += 8;
                addCandidate(n, sc, null, "", {
                    forceGif:
                        pageIsGifSection &&
                        !VIDEO_EXT.test(n) &&
                        !STREAM_EXT.test(n) &&
                        !AUDIO_EXT.test(n),
                    media_type: AUDIO_EXT.test(n) ? "audio" : undefined,
                    source: "performance",
                    resolved: true,
                });
            }
        } catch (_) {}

        // Steam / 通用：data-props 等 JSON 里的 trailers（HLS/DASH + 封面）
        (function harvestDataPropsAndJson() {
            function walkJson(node, depth) {
                if (!node || depth > 12) return;
                if (typeof node === "string") {
                    const u = abs(node);
                    if (!u || isSkip(u)) return;
                    if (STREAM_EXT.test(u) || /hls_.*\.m3u8|dash_.*\.mpd/i.test(u)) {
                        addCandidate(u, 96, null, "", {
                            media_type: /\.mpd(\?|#|$)/i.test(u) || /dash_.*\.mpd/i.test(u) ? "dash" : "m3u8",
                            source: "json-stream",
                            resolved: true,
                        });
                    } else if (AUDIO_EXT.test(u)) {
                        addCandidate(u, 90, null, "", { media_type: "audio", source: "json-audio", resolved: true });
                    } else if (VIDEO_EXT.test(u)) {
                        addCandidate(u, 88, null, "", { media_type: "video", source: "json-video", resolved: true });
                    } else if (IMAGE_EXT.test(u) && /movie_|trailer|poster|screenshot|ss_/i.test(u)) {
                        addCandidate(u, 50, null, "", { source: "json-thumb", resolved: true });
                    }
                    return;
                }
                if (Array.isArray(node)) {
                    node.forEach((x) => walkJson(x, depth + 1));
                    return;
                }
                if (typeof node !== "object") return;

                // Steam trailers 结构
                if (node.hlsManifest || node.hls_manifest) {
                    const hls = abs(node.hlsManifest || node.hls_manifest);
                    const poster = abs(node.poster || node.thumbnail || "");
                    const title = (node.title || node.name || "").toString().slice(0, 120);
                    if (hls) {
                        addCandidate(hls, 98, poster, title, {
                            media_type: "m3u8",
                            source: "steam-hls",
                            resolved: true,
                        });
                    }
                }
                if (Array.isArray(node.dashManifests) || Array.isArray(node.dash_manifests)) {
                    const arr = node.dashManifests || node.dash_manifests;
                    const poster = abs(node.poster || node.thumbnail || "");
                    const title = (node.title || "").toString().slice(0, 120);
                    // 已有 HLS 时 DASH 降权，避免重复；仍收录 h264 备选
                    for (const d of arr) {
                        const u = abs(d);
                        if (!u) continue;
                        const sc = /h264|avc/i.test(u) ? 70 : 55;
                        addCandidate(u, sc, poster, title, {
                            media_type: "dash",
                            source: "steam-dash",
                            resolved: true,
                        });
                    }
                }
                // 常见字段
                for (const k of [
                    "mp4",
                    "webm",
                    "video",
                    "videoUrl",
                    "video_url",
                    "src",
                    "url",
                    "file",
                    "filename_mp4",
                    "filename_webm",
                    "microtrailer",
                ]) {
                    if (typeof node[k] === "string") walkJson(node[k], depth + 1);
                }
                for (const v of Object.values(node)) {
                    if (v && (typeof v === "object" || typeof v === "string")) walkJson(v, depth + 1);
                }
            }

            document.querySelectorAll("[data-props], [data-film], [data-video-props], [data-trailer]").forEach((el) => {
                for (const attr of el.getAttributeNames()) {
                    if (!/^data-/i.test(attr)) continue;
                    const raw = el.getAttribute(attr);
                    if (!raw || raw.length < 8 || raw.length > 500000) continue;
                    if (!/trailer|hls|dash|mp4|webm|m3u8|video|movie/i.test(raw)) continue;
                    try {
                        const text = raw
                            .replace(/&quot;/g, '"')
                            .replace(/&#34;/g, '"')
                            .replace(/&amp;/g, "&")
                            .replace(/\\\//g, "/");
                        if (text.trim().startsWith("{") || text.trim().startsWith("[")) {
                            walkJson(JSON.parse(text), 0);
                        }
                    } catch (_) {
                        // 非 JSON：抽 URL
                        const re =
                            /https?:\\?\/\\?\/[^\s"'<>]+?\.(?:mp4|webm|m3u8|mpd)(?:\?[^\s"'<>]*)?/gi;
                        let m;
                        while ((m = re.exec(raw))) {
                            const u = abs(m[0].replace(/\\\//g, "/"));
                            if (u) {
                                addCandidate(u, 90, null, "", {
                                    media_type: guessMediaType(u, false),
                                    source: "data-attr-url",
                                    resolved: true,
                                });
                            }
                        }
                    }
                }
            });

            // 页内脚本里的 hlsManifest / store_trailers
            try {
                const html = document.documentElement ? document.documentElement.innerHTML : "";
                if (html && html.length) {
                    let slice = "";
                    for (const mk of ["hlsManifest", "dashManifests", "store_trailers", "filename_mp4", "trailers"]) {
                        let from = 0;
                        let hits = 0;
                        while (hits < 4) {
                            const i = html.indexOf(mk, from);
                            if (i < 0) break;
                            slice += "\n" + html.slice(Math.max(0, i - 100), Math.min(html.length, i + 80000));
                            from = i + mk.length;
                            hits++;
                        }
                    }
                    for (let i = 0; i < 3; i++) {
                        if (!/\\["\/]/.test(slice)) break;
                        slice = slice.replace(/\\"/g, '"').replace(/\\\//g, "/");
                    }
                    const streamRe =
                        /https?:\/\/[a-z0-9.-]+(?:\/[a-zA-Z0-9_./%-]+)+\.(?:m3u8|mpd|mp4|webm)(?:\?[^"'\s]*)?/gi;
                    let sm;
                    const seen = new Set();
                    while ((sm = streamRe.exec(slice))) {
                        const u = sm[0];
                        if (seen.has(u) || isSkip(u)) continue;
                        seen.add(u);
                        addCandidate(u, STREAM_EXT.test(u) ? 94 : 86, null, "", {
                            media_type: guessMediaType(u, false),
                            source: "embedded-stream",
                            resolved: true,
                        });
                    }
                }
            } catch (_) {}
        })();

        // audio elements
        document.querySelectorAll("audio").forEach((a) => {
            const sources = [];
            if (a.currentSrc) sources.push(a.currentSrc);
            if (a.src) sources.push(a.src);
            a.querySelectorAll("source[src]").forEach((s) => {
                if (s.src) sources.push(s.src);
            });
            for (const s of sources) {
                const u = abs(s);
                if (!u || isSkip(u)) continue;
                addCandidate(u, 90, null, "", { media_type: "audio", source: "audio-tag" });
            }
            collectFromEl(a, 70);
        });

        // video + source
        document.querySelectorAll("video").forEach((v) => {
            const poster = abs(v.getAttribute("poster") || "");
            const sources = [];
            if (v.currentSrc) sources.push(v.currentSrc);
            if (v.src) sources.push(v.src);
            v.querySelectorAll("source[src]").forEach((s) => {
                if (s.src) sources.push(s.src);
                const ds = s.getAttribute("src");
                if (ds) sources.push(ds);
            });
            for (const k of ["data-src", "data-video", "data-mp4", "data-webm", "data-hls", "data-src-mp4", "data-src-webm"]) {
                const val = v.getAttribute(k);
                if (val) sources.push(val);
            }
            // 仅动图频道才把 loop 短视频当 gif；Steam 等站的 loop 预览仍是 video
            const asGif = pageIsGifSection;
            let score = 88;
            if (pageIsGifSection) score += 5;
            let added = false;
            for (const s of sources) {
                const u = abs(s);
                if (!u || isSkip(u)) continue;
                // Steam extras 优先 webm（可播）；其它站 mp4 略优先
                const steamEx = /\/extras\/[a-f0-9]{16,}\.(mp4|webm)(\?|#|$)/i.test(u);
                const sc = steamEx
                    ? /\.webm(\?|#|$)/i.test(u)
                        ? score + 5
                        : score
                    : /\.mp4(\?|#|$)/i.test(u)
                      ? score + 3
                      : score;
                addCandidate(u, sc, poster || u, "", {
                    forceGif: asGif,
                    media_type: asGif ? "gif" : "video",
                    source: "video",
                });
                added = true;
            }
            if (!added && poster) addCandidate(poster, 40, poster, "", { source: "video-poster" });
            const a = v.closest("a[href]");
            if (a) maybeProbe(a.href);
            collectFromEl(v, 70);
        });

        // 游离的 <source> / 直链 a[href=mp4]
        document.querySelectorAll("source[src]").forEach((s) => {
            const u = abs(s.src || s.getAttribute("src"));
            if (!u || isSkip(u)) return;
            if (!VIDEO_EXT.test(u) && !STREAM_EXT.test(u) && !AUDIO_EXT.test(u)) return;
            addCandidate(u, 80, null, "", {
                media_type: guessMediaType(u, false),
                source: "source-tag",
            });
        });
        document
            .querySelectorAll(
                'a[href*=".mp4"], a[href*=".webm"], a[href*=".m3u8"], a[href*=".mp3"], a[href*=".m4a"], a[href*=".aac"], a[href*=".flac"], a[href*=".ogg"], a[href*=".opus"]'
            )
            .forEach((a) => {
                const u = abs(a.href);
                if (!u || isSkip(u) || !isMediaUrl(u)) return;
                addCandidate(u, 75, null, (a.textContent || "").trim().slice(0, 80), {
                    media_type: guessMediaType(u, false),
                    source: "anchor-media",
                });
            });

        // img
        document.querySelectorAll("img").forEach((img) => {
            const nw = img.naturalWidth || 0;
            const nh = img.naturalHeight || 0;
            if (nw && nh && nw < 32 && nh < 32) return;

            const thumb = abs(img.currentSrc || img.src || img.getAttribute("src"));
            if (thumb) noteBaseFromUrl(thumb);
            let best = null;
            let score = 10;
            const alt = (img.getAttribute("alt") || img.getAttribute("title") || "").slice(0, 80);

            for (const k of DATA_KEYS) {
                const v = img.getAttribute(k);
                if (!v) continue;
                best = v;
                score = Math.max(score, 75);
            }
            for (const k of SRCSET_KEYS) {
                const b = bestSrcset(img.getAttribute(k));
                if (b) {
                    best = b.url;
                    score = Math.max(score, 70 + Math.min(b.score / 50, 30));
                }
            }

            const ss = bestSrcset(img.getAttribute("srcset") || img.srcset);
            if (ss) {
                best = ss.url;
                score = Math.max(score, 55 + Math.min(ss.score / 50, 35));
            }

            const pic = img.closest("picture");
            if (pic) {
                pic.querySelectorAll("source").forEach((s) => {
                    const b = bestSrcset(s.getAttribute("srcset") || s.srcset);
                    if (b) {
                        best = b.url;
                        score = Math.max(score, 65 + Math.min(b.score / 50, 30));
                    }
                    if (s.src) {
                        best = s.src;
                        score = Math.max(score, 60);
                    }
                });
            }

            let node = img;
            for (let depth = 0; depth < 5 && node; depth++) {
                collectFromEl(node, 70 - depth * 5);
                if (node.tagName === "A" && node.href) {
                    const href = abs(node.href);
                    if (href) {
                        if (isImageUrl(href) || isMediaUrl(href)) {
                            best = href;
                            score = Math.max(score, 95 - depth);
                        } else {
                            maybeProbe(href);
                        }
                    }
                }
                const a = node.closest && node.closest("a[href]");
                if (a && a.href) {
                    const href = abs(a.href);
                    if (href) {
                        if (isImageUrl(href) || isMediaUrl(href)) {
                            best = href;
                            score = Math.max(score, 92);
                        } else {
                            maybeProbe(href);
                        }
                    }
                    collectFromEl(a, 80);
                }
                const wrap = node.closest(
                    "[data-fancybox],[data-lightbox],[data-gallery],[data-src],[data-original],.gallery-item,.photo,figure,a"
                );
                if (wrap && wrap !== node) {
                    collectFromEl(wrap, 78);
                    const wa = wrap.tagName === "A" ? wrap : wrap.querySelector("a[href]");
                    if (wa && wa.href) {
                        const href = abs(wa.href);
                        if (href && (isImageUrl(href) || isMediaUrl(href))) {
                            best = href;
                            score = Math.max(score, 90);
                        } else if (href) {
                            maybeProbe(href);
                        }
                    }
                }
                node = node.parentElement;
            }

            if (nw >= 120 && nh >= 120) score += 15;
            if (nw >= 300 || nh >= 300) score += 10;

            if (best) addCandidate(best, score, thumb, alt, { forceGif: pageIsGifSection, source: "img" });
            else if (thumb) addCandidate(thumb, score, thumb, alt, { forceGif: pageIsGifSection, source: "img" });
        });

        document.querySelectorAll("a[href]").forEach((a) => {
            const href = abs(a.href);
            if (href && isMediaUrl(href)) {
                addCandidate(href, 45, null, (a.textContent || "").trim().slice(0, 80), {
                    forceGif: pageIsGifSection,
                    source: "anchor",
                });
            }
            collectFromEl(a, 40);
        });

        const bgNodes = document.querySelectorAll(
            "[style*='background'], .cover, .thumb, .thumbnail, .photo, .card, [class*='bg-']"
        );
        let bgCount = 0;
        bgNodes.forEach((el) => {
            if (bgCount > 80) return;
            try {
                const bg = getComputedStyle(el).backgroundImage;
                if (!bg || bg === "none") return;
                const re = /url\(["']?([^"')]+)["']?\)/g;
                let m;
                while ((m = re.exec(bg))) {
                    addCandidate(m[1], 25, null, "", { forceGif: pageIsGifSection, source: "bg" });
                    bgCount++;
                }
            } catch (_) {}
            collectFromEl(el, 30);
        });

        const images = [...map.values()]
            .sort((a, b) => b.score - a.score)
            .map((x) => ({
                url: x.url,
                thumb: x.thumb,
                media_type: x.media_type,
                title: x.title || document.title,
                type:
                    x.media_type === "m3u8"
                        ? "application/vnd.apple.mpegurl"
                        : x.media_type === "dash"
                          ? "application/dash+xml"
                          : x.media_type === "gif"
                            ? "image/gif"
                            : x.media_type === "video"
                              ? "video/*"
                              : x.media_type === "audio"
                                ? "audio/*"
                                : "image/*",
                score: x.score,
                source: x.source || "dom",
            }));

        return {
            images,
            probePages: [...probePages].slice(0, 20),
            pageTitle: document.title || "",
            pageUrl: location.href,
            isTop: window === window.top,
            mediaBases: mediaBases.slice(0, 8),
        };
    };


    /** 对相册详情页再探一层：拉 HTML 取 og:image / 最大图 */
    async function probeLinkedPages(pageUrls, pageTitle) {
        const found = [];
        const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp)(\?|#|$)/i;
        const limit = Math.min(pageUrls.length, 16);
        const jobs = pageUrls.slice(0, limit).map(async (pageUrl) => {
            try {
                const res = await fetch(pageUrl, {
                    credentials: "include",
                    redirect: "follow",
                });
                if (!res.ok) return;
                const ct = (res.headers.get("content-type") || "").toLowerCase();
                if (ct.startsWith("image/")) {
                    found.push({
                        url: res.url || pageUrl,
                        media_type: ct.includes("gif") ? "gif" : "image",
                        title: pageTitle,
                        type: ct || "image/*",
                        source: "probe-direct",
                        score: 100,
                    });
                    return;
                }
                if (!ct.includes("html") && !ct.includes("xml") && ct) return;
                const html = await res.text();
                // 体积过大只扫前段；反转义 RSC 双重 JSON
                let slice = html.length > 800000 ? html.slice(0, 800000) : html;
                for (let i = 0; i < 3; i++) {
                    if (!/\\["\/]/.test(slice)) break;
                    slice = slice.replace(/\\"/g, '"').replace(/\\\//g, "/");
                }
                const doc = new DOMParser().parseFromString(slice, "text/html");
                const pick = [];
                const pageIsGif = /\/gifs?(?:\/|$|\?)/i.test(pageUrl);
                // 从详情页 HTML 抽 CDN + uri（与主解析同思路）
                let pinDomain = "";
                const dm = slice.match(/"staticPinImageDomain"\s*:\s*"(https?:[^"]+)"/i);
                if (dm) pinDomain = dm[1].replace(/\/$/, "");
                const uriRe = /"uri"\s*:\s*"(\/[^"]+\.(?:webp|gif|jpe?g|png|mp4|webm)[^"]*)"/gi;
                let um;
                while ((um = uriRe.exec(slice))) {
                    const path = um[1];
                    const full = pinDomain ? pinDomain + path : new URL(path, pageUrl).href;
                    pick.push({ u: full, s: 96 });
                }
                const og =
                    doc.querySelector('meta[property="og:image"]')?.getAttribute("content") ||
                    doc.querySelector('meta[name="og:image"]')?.getAttribute("content") ||
                    doc.querySelector('meta[property="og:image:url"]')?.getAttribute("content");
                if (og) pick.push({ u: og, s: 100 });
                const tw = doc.querySelector('meta[name="twitter:image"]')?.getAttribute("content");
                if (tw) pick.push({ u: tw, s: 95 });
                const linkImg = doc.querySelector('link[rel="image_src"]')?.getAttribute("href");
                if (linkImg) pick.push({ u: linkImg, s: 90 });
                doc.querySelectorAll("img[src], img[data-src], img[data-original], video[src], source[src]").forEach(
                    (el) => {
                        const u =
                            el.getAttribute("data-original") ||
                            el.getAttribute("data-src") ||
                            el.getAttribute("src");
                        if (!u || u.startsWith("data:")) return;
                        let sc = 40;
                        const w = parseInt(el.getAttribute("width") || "0", 10);
                        if (w >= 400) sc += 20;
                        if (IMAGE_EXT.test(u) || /\.(mp4|webm)(\?|#|$)/i.test(u)) sc += 10;
                        pick.push({ u, s: sc });
                    }
                );
                const best = new Map();
                for (const p of pick) {
                    try {
                        const abs = new URL(p.u, pageUrl).href;
                        if (/_next\/static|staticp\.|favicon|logo/i.test(abs)) continue;
                        const prev = best.get(abs);
                        if (!prev || p.s > prev.s) best.set(abs, { url: abs, s: p.s });
                    } catch (_) {}
                }
                const ranked = [...best.values()].sort((a, b) => b.s - a.s).slice(0, 4);
                for (const r of ranked) {
                    const isGif =
                        /\.gif(\?|#|$)/i.test(r.url) ||
                        (pageIsGif && /\.webp(\?|#|$)/i.test(r.url)) ||
                        (pageIsGif && /\.(mp4|webm)(\?|#|$)/i.test(r.url));
                    found.push({
                        url: r.url,
                        media_type: isGif ? "gif" : /\.(mp4|webm)(\?|#|$)/i.test(r.url) ? "video" : "image",
                        title: pageTitle,
                        type: isGif ? "image/gif" : "image/*",
                        source: "probe-page",
                        score: r.s,
                        referer: pageUrl,
                    });
                }
            } catch (_) {
                /* 跨域/登录页失败则跳过 */
            }
        });
        await Promise.all(jobs);
        return found;
    }

    async function parsePageImages() {
        if (!tabId) {
            setStatus("缺少 tabId");
            return;
        }
        setStatus("正在解析页面媒体（图片/动图/视频/m3u8）…");
        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId, allFrames: true },
                func: PAGE_IMAGE_FN,
            });
            const map = new Map();
            const probeSet = new Set();
            let pageTitle = "";
            let pageUrlHint = "";

            // 主框架优先；广告 iframe 结果降权/丢弃
            const frames = (results || [])
                .map((frame) => frame && frame.result)
                .filter(Boolean);
            frames.sort((a, b) => {
                const at = a.isTop ? 1 : 0;
                const bt = b.isTop ? 1 : 0;
                return bt - at;
            });
            const top = frames.find((r) => r && r.isTop) || frames[0];
            if (top) {
                pageTitle = top.pageTitle || pageTitle;
                pageUrlHint = top.pageUrl || pageUrlHint;
            }

            for (const r of frames) {
                if (Array.isArray(r)) {
                    for (const it of r) mergeMediaItem(map, it);
                    continue;
                }
                const isTop = !!r.isTop;
                // 非顶层：只接受高分媒体，避免广告 GIF 污染
                for (const raw of r.images || []) {
                    if (!raw || !raw.url) continue;
                    let sc = raw.score || 0;
                    let it = raw;
                    if (!isTop) {
                        if (sc < 70) continue;
                        sc = Math.min(sc, 50);
                        it = { ...raw, score: sc, source: (raw.source || "iframe") + "-frame" };
                    }
                    mergeMediaItem(map, it);
                }
                // 只收集顶层同站 probe
                if (isTop) {
                    for (const p of r.probePages || []) probeSet.add(p);
                    pageTitle = r.pageTitle || pageTitle;
                }
            }

            // 顶层已解析到足够多时，跳过再探（再探容易带进无关 og:image）
            let probeExtra = [];
            const needProbe = map.size < 12 && probeSet.size > 0;
            if (needProbe) {
                setStatus(`主文档 ${map.size} 条，再探 ${Math.min(probeSet.size, 12)} 个同站链接…`);
                probeExtra = await probeLinkedPages([...probeSet].slice(0, 12), pageTitle);
                for (const it of probeExtra) {
                    if (!it.url) continue;
                    // 再探结果略降权
                    it.score = Math.min(it.score || 40, 60);
                    mergeMediaItem(map, it);
                }
            }

            items = [...map.values()];
            // 过滤站点壳资源 / 过小分
            items = items.filter((it) => {
                const u = it.url || "";
                if (/_next\/static|staticp\.|\/static\/media\/|favicon|logo-light|logo-dark/i.test(u)) {
                    return false;
                }
                return (it.score || 0) >= 30 || items.length < 10;
            });
            // 再跑一遍去重（过滤后保险）
            {
                const m2 = new Map();
                for (const it of items) mergeMediaItem(m2, it);
                items = [...m2.values()];
            }
            items.sort((a, b) => (b.score || 0) - (a.score || 0));

            selected.clear();
            items.forEach((it, i) => {
                // 用去重键做稳定 id，避免同 url 不同 index 重复选中态
                it._key = (mediaDedupeKey(it.url) || it.url) + "#" + i;
            });
            const pageUrl = (await getPageUrl()) || pageUrlHint;
            await enrichHeaders(items, pageUrl);
            render();
            const srcStat = {};
            for (const it of items) {
                const s = it.source || "?";
                srcStat[s] = (srcStat[s] || 0) + 1;
            }
            const srcHint = Object.entries(srcStat)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 4)
                .map(([k, v]) => `${k}:${v}`)
                .join(" ");
            setStatus(
                `解析到 ${items.length} 项` +
                    (probeExtra.length ? `（再探+${probeExtra.length}）` : "") +
                    (srcHint ? ` · ${srcHint}` : "") +
                    " · 含页内 JSON / video / 网络资源"
            );
        } catch (e) {
            setStatus("解析失败: " + e.message);
        }
    }

    async function loadCaught() {
        setStatus("载入嗅探资源…");
        try {
            let list = (await chrome.runtime.sendMessage({ Message: "getData", tabId })) || [];
            if (!Array.isArray(list)) list = [];
            if (!list.length) {
                const all = await chrome.runtime.sendMessage({ Message: "getAllData" });
                if (all && typeof all === "object") {
                    for (const arr of Object.values(all)) {
                        if (Array.isArray(arr)) list.push(...arr);
                    }
                }
            }
            const pageUrl = await getPageUrl();
            const map = new Map();
            for (const it of list) {
                if (!it || !it.url) continue;
                map.set(it.url, it);
            }
            items = [...map.values()];
            items.forEach((it, i) => {
                it._key = it.url + "#" + i;
                // Prefer network Content-Type so disguised audio is not forced to video by .mp4 URL
                if (!it.media_type) {
                    it.media_type = LMW.normalizeMediaType(it);
                }
            });
            selected.clear();
            clearAvPairs();
            await enrichHeaders(items, pageUrl);
            render();
            const audioN = items.filter((x) => mediaTypeOf(x) === "audio").length;
            setStatus(
                `载入 ${items.length} 条嗅探资源` + (audioN ? `（含音频 ${audioN}）` : "")
            );
        } catch (e) {
            setStatus("载入失败: " + e.message);
        }
    }

    async function doIngest() {
        const chosen = getSelectedItems();
        if (!chosen.length) {
            setStatus("请先选择媒体");
            return;
        }
        const pageUrl = await getPageUrl();
        const first = chosen[0];
        const dlg = await LMW.openIngestDialog({
            title: first.title || first.name || document.title || "media",
            url: first.url || "",
            media_type: LMW.normalizeMediaType(first),
            source_page: pageUrl,
            count: chosen.length,
        });
        if (!dlg || !dlg.ok || dlg.cancelled) {
            setStatus("已取消入库");
            return;
        }
        const tags = dlg.tags || [];
        const useJasna =
            dlg.use_jasna === true ||
            !!(document.getElementById("lmUseJasna") && document.getElementById("lmUseJasna").checked) ||
            (typeof G !== "undefined" && G.lmwUseJasna === true);
        const restricted =
            dlg.restricted === true ||
            !!(document.getElementById("lmRestricted") && document.getElementById("lmRestricted").checked) ||
            (typeof G !== "undefined" && G.lmwRestricted === true);
        try {
            const payload = [];
            let clipCount = 0;
            for (const it of chosen) {
                const ranges = getItemRanges(it);
                // 无候选 = 完整片 1 条；多段 = 每段各 1 条入库任务
                const clips =
                    ranges.length > 0
                        ? ranges
                        : [{ startSec: null, endSec: null, startStr: "", endStr: "" }];
                for (const r of clips) {
                    const row = await LMW.itemToIngest(it, pageUrl, tags);
                    if (it._headers) row.headers = Object.assign({}, row.headers, it._headers);
                    const hasStart = r.startSec != null && !Number.isNaN(+r.startSec);
                    const hasEnd = r.endSec != null && +r.endSec > 0;
                    if (hasStart || hasEnd) {
                        row.start_sec = hasStart ? Math.max(0, +r.startSec) : 0;
                        if (hasEnd) row.end_sec = +r.endSec;
                        clipCount++;
                    }
                    if (useJasna) row.use_jasna = true;
                    if (restricted) row.restricted = true;
                    payload.push(row);
                }
            }
            setStatus(
                `提交 ${payload.length} 项…` +
                    (clipCount ? `（含 ${clipCount} 个时间段）` : "") +
                    (tags.length ? " 标签 " + tags.join(",") : "") +
                    (restricted ? " · 限制级" : "") +
                    (useJasna ? " · jasna 去码" : "")
            );
            const result = await LMW.pushItems(payload, "default", {
                tags,
                use_jasna: useJasna,
                restricted: restricted,
            });
            const rangeHints = chosen
                .map((it) => formatRangeLabel(it))
                .filter(Boolean)
                .join("；");
            let msg =
                `完成: 成功 ${result.success || 0}, 链接重复 ${result.duplicates || 0}` +
                (result.contentDuplicates
                    ? `, 内容重复 ${result.contentDuplicates}`
                    : "") +
                `, 回退上传 ${result.fallbackOk || 0}, 失败 ${result.failed || 0}` +
                `（任务 ${payload.length}）`;
            if (result.duplicates > 0) {
                msg +=
                    "（「链接重复」= 同一 URL+相同起止时间已入库；要截另一段请改时间后重选）";
            }
            if (result.contentDuplicates > 0) {
                msg += "（「内容重复」= 文件字节与库内已有完全相同，未再建条目）";
            }
            if (rangeHints) msg += " · 本次范围 " + rangeHints;
            if (tags.length) msg += " · 标签 " + tags.join(",");
            if (useJasna) {
                const mediaIds = [];
                for (const j of result.jobs || []) {
                    if (j && j.media_id && j.status === "success") mediaIds.push(j.media_id);
                }
                if (mediaIds.length) {
                    msg += ` · jasna 排队（媒体 ${mediaIds.join(",")})`;
                    setStatus(msg);
                    LMW.waitJasnaForMediaIds(mediaIds, {
                        onUpdate: (t) => setStatus(msg + " · " + t),
                    })
                        .then((jjobs) => {
                            const ok = (jjobs || []).filter((j) => j.status === "success").length;
                            const fail = (jjobs || []).filter((j) => j.status === "failed").length;
                            setStatus(
                                msg +
                                    ` · jasna 结束：成功 ${ok}` +
                                    (fail ? ` · 失败 ${fail}` : "") +
                                    ((jjobs || [])
                                        .filter((j) => j.status === "failed" && j.error_message)
                                        .map((j) => ` #${j.id}:${String(j.error_message).slice(0, 80)}`)
                                        .join("") || "")
                            );
                        })
                        .catch((e) => setStatus(msg + " · jasna 轮询失败: " + (e.message || e)));
                } else {
                    msg += " · jasna：无成功媒体可去码（下载失败或重复跳过）";
                    setStatus(msg);
                }
            } else {
                setStatus(msg);
            }
        } catch (e) {
            setStatus("入库失败: " + e.message);
        }
    }

    await new Promise((resolve) => {
        const t = setInterval(() => {
            if (G.initSyncComplete) {
                clearInterval(t);
                resolve();
            }
        }, 50);
        setTimeout(resolve, 2000);
    });

    // 预览层：空白处 / 关闭按钮 / Esc
    $("#lmPreviewClose").on("click", (e) => {
        e.stopPropagation();
        closePreview();
    });
    $("#lmPreview").on("click", function (e) {
        // 点遮罩空白关闭；点图片/视频本身不关
        if (
            e.target === this ||
            $(e.target).is("#lmPreviewStage") ||
            $(e.target).closest("#lmPreviewMeta").length
        ) {
            // meta 里的按钮/链接不关
            if ($(e.target).closest("a,button").length) return;
            if (e.target === this || $(e.target).is("#lmPreviewStage")) closePreview();
        }
    });
    $(document).on("keydown", (e) => {
        if (e.key === "Escape") {
            if (!$("#lmPreview").hasClass("hide")) closePreview();
            else hideCardTip();
        }
    });
    $(window).on("scroll resize", () => {
        if (tipActiveCard) positionCardTip(tipActiveCard);
    });

    $("#btnParseImages").on("click", parsePageImages);
    $("#btnLoadCaught").on("click", loadCaught);
    $("#btnDetectAvMerge").on("click", () => detectAvMergePairs());
    $("#btnMergeAvSelected").on("click", () => mergeSelectedAv());
    $("#btnOpenManage").on("click", () => {
        chrome.tabs.create({ url: chrome.runtime.getURL("lmw-media-manage.html") });
    });
    $("#btnSelectAll").on("click", () => {
        const list = getFilteredItems();
        list.forEach((it) => selected.add(it._key));
        // 批量：就地更新卡片，避免不必要闪烁；若未渲染则 render
        const $cards = $("#grid .lm-card");
        if (!$cards.length) {
            render();
            return;
        }
        $cards.each(function () {
            applyCardSelected($(this), $(this).attr("data-key"));
        });
        updateStatusCount();
    });
    $("#btnInvert").on("click", () => {
        const list = getFilteredItems();
        list.forEach((it) => {
            if (selected.has(it._key)) selected.delete(it._key);
            else selected.add(it._key);
        });
        $("#grid .lm-card").each(function () {
            applyCardSelected($(this), $(this).attr("data-key"));
        });
        updateStatusCount();
    });
    $("#typeFilter, #resFilter, #longFilter, #cookieFilter").on("change", render);
    $("#btnIngest").on("click", doIngest);

    const $restricted = $("#lmRestricted");
    if ($restricted.length) {
        $restricted.prop("checked", !!(typeof G !== "undefined" && G.lmwRestricted));
        $restricted.on("change", function () {
            const on = !!this.checked;
            if (typeof G !== "undefined") G.lmwRestricted = on;
            try {
                chrome.storage.sync.set({ lmwRestricted: on });
                chrome.storage.local.set({ lmwRestricted: on });
            } catch (e) { /* ignore */ }
        });
    }
    const $jasna = $("#lmUseJasna");
    if ($jasna.length) {
        $jasna.prop("checked", !!(typeof G !== "undefined" && G.lmwUseJasna));
        $jasna.on("change", function () {
            const on = !!this.checked;
            if (typeof G !== "undefined") G.lmwUseJasna = on;
            try {
                chrome.storage.sync.set({ lmwUseJasna: on });
                chrome.storage.local.set({ lmwUseJasna: on });
            } catch (e) { /* ignore */ }
        });
    }

    try {
        const h = await LMW.health();
        if (h && h.jasna === false && $jasna.length) {
            $jasna.attr(
                "title",
                "服务器未检测到 jasna（检查 settings.yaml 的 jasna_path 并 restart）"
            );
        }
    } catch (e) {
        setStatus("无法连接 LocalMediaWeb: " + ((e && e.message) || e) + "（请先 start.bat）");
    }
    const auto = params.get("auto");
    if (auto === "images" && tabId) {
        await parsePageImages();
    } else if (tabId) {
        await loadCaught();
        if (auto === "images") await parsePageImages();
    } else {
        setStatus("未指定标签页");
    }
})();
