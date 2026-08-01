/**
 * Shared AV classify / pair-detect / merge / ingest helpers for
 * local-media and convention scraper. Depends on LMW (local-media-web.js)
 * and optional setRequestHeaders (function.js).
 */
(function (global) {
    "use strict";

    function mediaTypeOf(it) {
        return LMW.normalizeMediaType(it);
    }

    function isStreamUrl(url, type) {
        if (type === "m3u8" || type === "dash") return true;
        return /\.(m3u8|mpd)(\?|#|$)/i.test(url || "");
    }

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

    function durationMatchScore(d1, d2, absTol = 0.45, relTol = 0.02) {
        if (!(d1 > 0.05) || !(d2 > 0.05)) return null;
        const delta = Math.abs(d1 - d2);
        const base = Math.max(d1, d2);
        if (delta > absTol && delta / base > relTol) return null;
        return 1 - Math.min(1, delta / base);
    }

    function probeItemWithElement(it, timeoutMs = 12000) {
        return new Promise((resolve) => {
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
                it._hasVideo = hasVideo;
                it._hasAudio = !hasVideo && !!duration_sec ? true : it._hasAudio;
                finish({
                    media_type,
                    duration_sec,
                    role: it._contentRole,
                    method: "element",
                    has_video: hasVideo,
                });
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

    /**
     * Content-based type + duration for progressive files.
     * Fast path: browser metadata; slow path: LMW.probeUrl (~4MiB head).
     */
    async function classifyItemContent(it) {
        if (!it || !it.url) return null;
        const t0 = mediaTypeOf(it);
        if (t0 === "m3u8" || t0 === "dash" || t0 === "image" || t0 === "gif") {
            return { media_type: t0, duration_sec: null, method: "skip" };
        }

        const elInfo = await probeItemWithElement(it, 8000);
        // Pure audio from element is enough (no video plane). Video needs server role for has_audio.
        if (elInfo && elInfo.media_type === "audio") {
            it._hasAudio = true;
            it._hasVideo = false;
            it._contentRole = "audio_only";
            return elInfo;
        }

        try {
            const headers = playHeaderMap(it);
            const r = await LMW.probeUrl({
                url: it.url,
                headers,
                max_bytes: 4 * 1024 * 1024,
            });
            if (r && r.media_type) {
                it.media_type = r.media_type;
                it._contentRole = r.role || "";
                it._hasAudio = !!r.has_audio;
                it._hasVideo = !!r.has_video || r.role === "av" || r.role === "video_only";
                it._durationSec =
                    r.duration_sec != null && Number(r.duration_sec) > 0
                        ? Number(r.duration_sec)
                        : it._durationSec || (elInfo && elInfo.duration_sec) || null;
                it._classifyMethod = r.method || "server_partial";
                if (!(it._durationSec > 0) && elInfo && elInfo.duration_sec > 0) {
                    it._durationSec = elInfo.duration_sec;
                }
                return {
                    media_type: r.media_type,
                    duration_sec: it._durationSec,
                    role: r.role,
                    method: r.method,
                    has_audio: r.has_audio,
                    has_video: r.has_video,
                    truncated: !!r.truncated,
                };
            }
        } catch (e) {
            console.warn("LMWAv probe-url failed", it.url, e);
        }
        // Fall back to element video typing (unknown audio)
        if (elInfo && elInfo.media_type === "video") {
            it._contentRole = it._contentRole || "video_only";
            return elInfo;
        }
        return elInfo || null;
    }

    /** True if progressive file is video with audio track (complete AV). */
    function isCompleteAv(it) {
        if (!it) return false;
        const role = it._contentRole || "";
        if (role === "av") return true;
        if (it._hasVideo && it._hasAudio) return true;
        // server probe uses role av; element alone cannot prove audio on video
        return false;
    }

    function isVideoLike(it) {
        const t = mediaTypeOf(it);
        return t === "video" || t === "m3u8" || t === "dash";
    }

    async function classifyPool(pool, { onStatus, concurrency = 3 } = {}) {
        const progressive = (pool || []).filter((it) => {
            const t = mediaTypeOf(it);
            if (t === "m3u8" || t === "dash" || t === "image" || t === "gif") return false;
            return t === "video" || t === "audio" || !isStreamUrl(it.url, t);
        });
        let classified = 0;
        const queue = progressive.slice();
        const workers = Array.from({ length: Math.min(concurrency, queue.length || 1) }, async () => {
            while (queue.length) {
                const it = queue.shift();
                if (!it) break;
                if (it._classifyMethod === "server" || it._classifyMethod === "server_partial" || it._classifyMethod === "element") {
                    classified++;
                    continue;
                }
                await classifyItemContent(it);
                classified++;
                if (onStatus && classified % 3 === 0) {
                    onStatus(`内容识别中… ${classified}/${progressive.length}`);
                }
            }
        });
        if (queue.length) await Promise.all(workers);
        return { classified, total: progressive.length };
    }

    /**
     * Detect duration-matched video+audio pairs in a pool (same algorithm as local-media).
     */
    async function detectPageAvPairs(pool, { onStatus } = {}) {
        if (onStatus) onStatus("内容识别中…");
        const { classified } = await classifyPool(pool, { onStatus });

        let videos = [];
        let audios = [];
        for (const it of pool) {
            const t = mediaTypeOf(it);
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
        if (onStatus) onStatus(`比对时长… 视频 ${videos.length} · 音频 ${audios.length}`);
        for (const it of [...videos, ...audios]) {
            if (it._durationSec == null || !(it._durationSec > 0)) {
                const r = await classifyItemContent(it);
                if (r && r.duration_sec) it._durationSec = r.duration_sec;
            }
        }
        videos = [];
        audios = [];
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
        return {
            pairs,
            videos: videos.length,
            audios: audios.length,
            probed: classified,
            vOk: vOk.length,
            aOk: aOk.length,
        };
    }

    async function fetchItemBlob(it) {
        const headers = playHeaderMap(it);
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

    async function enrichHeaders(list, pageUrl) {
        for (const it of list || []) {
            if (pageUrl) {
                it._pageUrl = pageUrl;
                if (!it.referer) it.referer = pageUrl;
            }
            it._headers = await LMW.buildHeadersForItem(it, pageUrl);
        }
    }

    function normalizeCaughtList(list, pageUrl) {
        const map = new Map();
        for (const it of list || []) {
            if (!it || !it.url) continue;
            map.set(it.url, it);
        }
        const items = [...map.values()];
        items.forEach((it, i) => {
            it._key = it.url + "#" + i;
            if (!it.media_type) it.media_type = LMW.normalizeMediaType(it);
            if (pageUrl) {
                it._pageUrl = pageUrl;
                if (!it.referer) it.referer = pageUrl;
            }
        });
        return items;
    }

    /**
     * Push items to LMW without ingest dialog.
     */
    async function ingestItems(items, pageUrl, { tags = [], restricted = false, useJasna = false, onStatus } = {}) {
        if (!items || !items.length) {
            return { success: 0, failed: 0, duplicates: 0, contentDuplicates: 0, fallbackOk: 0 };
        }
        const payload = [];
        for (const it of items) {
            const row = await LMW.itemToIngest(it, pageUrl, tags);
            if (it._headers) row.headers = Object.assign({}, row.headers || {}, it._headers);
            if (useJasna) row.use_jasna = true;
            if (restricted) row.restricted = true;
            payload.push(row);
        }
        if (onStatus) onStatus(`提交入库 ${payload.length} 项…`);
        return LMW.pushItems(payload, "default", {
            tags,
            use_jasna: useJasna,
            restricted,
        });
    }

    /**
     * Download and merge page AV pairs via upload-av.
     */
    async function mergePagePairs(pairs, { restricted = false, useJasna = false, onStatus } = {}) {
        let ok = 0;
        let fail = 0;
        const pagePairs = (pairs || []).filter((p) => p.source === "page" || p.video_item);
        for (let i = 0; i < pagePairs.length; i++) {
            const p = pagePairs[i];
            if (onStatus) onStatus(`下载合并 ${i + 1}/${pagePairs.length}…`);
            try {
                const vItem = p.video_item;
                const aItem = p.audio_item;
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
                console.warn("LMWAv merge page pair", e);
            }
        }
        return { ok, fail };
    }

    /**
     * Convention-scraper analyze + ingest pipeline.
     * avSeparated true  → complete AV direct; rest pair-merge
     * avSeparated false → all video-like direct
     */
    async function analyzeAndIngest(items, pageUrl, opts = {}) {
        const {
            avSeparated = false,
            restricted = false,
            useJasna = false,
            tags = [],
            onStatus = () => {},
        } = opts;

        const list = normalizeCaughtList(items, pageUrl);
        await enrichHeaders(list, pageUrl);
        onStatus(`分析 ${list.length} 条嗅探资源…`);

        if (!avSeparated) {
            const videos = list.filter(isVideoLike);
            const skipped = list.length - videos.length;
            onStatus(`分离关：直接入库视频 ${videos.length}` + (skipped ? `（跳过非视频 ${skipped}）` : ""));
            const r = await ingestItems(videos, pageUrl, { tags, restricted, useJasna, onStatus });
            return {
                mode: "direct_all_video",
                total: list.length,
                direct: videos.length,
                merged: 0,
                unpaired: 0,
                result: r,
            };
        }

        // avSeparated: classify then split (server probe for video has_audio)
        await classifyPool(list, { onStatus });

        const direct = [];
        const remainder = [];
        for (const it of list) {
            const t = mediaTypeOf(it);
            if (t === "image" || t === "gif") continue;
            if (isCompleteAv(it)) {
                direct.push(it);
            } else if (t === "video" || t === "audio" || t === "m3u8" || t === "dash") {
                remainder.push(it);
            }
        }

        onStatus(`分离开：完整 AV 直入 ${direct.length} · 待配对 ${remainder.length}`);
        let ingestResult = { success: 0, failed: 0, duplicates: 0 };
        if (direct.length) {
            ingestResult = await ingestItems(direct, pageUrl, { tags, restricted, useJasna, onStatus });
        }

        let mergeResult = { ok: 0, fail: 0 };
        let unpaired = remainder.length;
        if (remainder.length >= 2) {
            onStatus("检测可合并项…");
            const det = await detectPageAvPairs(remainder, { onStatus });
            onStatus(
                `可合并 ${det.pairs.length} 对（视频 ${det.videos} · 音频 ${det.audios}）`
            );
            if (det.pairs.length) {
                mergeResult = await mergePagePairs(det.pairs, { restricted, useJasna, onStatus });
                const used = new Set();
                for (const p of det.pairs) {
                    if (p.video_key) used.add(p.video_key);
                    if (p.audio_key) used.add(p.audio_key);
                }
                unpaired = remainder.filter((it) => !used.has(it._key)).length;
            }
        } else if (remainder.length === 1) {
            onStatus("待配对仅 1 项，无法合并");
        }

        if (unpaired) onStatus(`未合并残片 ${unpaired} 项（默认不入库）`);

        return {
            mode: "av_separated",
            total: list.length,
            direct: direct.length,
            merged: mergeResult.ok,
            mergeFail: mergeResult.fail,
            unpaired,
            result: ingestResult,
            mergeResult,
        };
    }

    const LMWAv = {
        mediaTypeOf,
        isStreamUrl,
        durationMatchScore,
        classifyItemContent,
        classifyPool,
        detectPageAvPairs,
        fetchItemBlob,
        enrichHeaders,
        normalizeCaughtList,
        ingestItems,
        mergePagePairs,
        analyzeAndIngest,
        isCompleteAv,
        isVideoLike,
        applyPlayHeaders,
        playHeaderMap,
    };

    global.LMWAv = LMWAv;
})(typeof window !== "undefined" ? window : globalThis);
