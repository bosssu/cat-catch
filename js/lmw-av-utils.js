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

    /**
     * Layered duration match (short clips: tight abs; long: tight rel + abs cap).
     * Optional absTol/relTol override the layered defaults (for callers/tests).
     * @returns {number|null} score in (0,1], higher = closer; null = no match
     */
    function durationMatchScore(d1, d2, absTol, relTol) {
        if (!(d1 > 0.05) || !(d2 > 0.05)) return null;
        const delta = Math.abs(d1 - d2);
        const base = Math.max(d1, d2);
        let aTol = absTol;
        let rTol = relTol;
        if (aTol == null || rTol == null) {
            if (base < 60) {
                aTol = aTol != null ? aTol : 0.3;
                rTol = rTol != null ? rTol : 0.008;
            } else if (base < 300) {
                aTol = aTol != null ? aTol : 0.4;
                rTol = rTol != null ? rTol : 0.01;
            } else {
                aTol = aTol != null ? aTol : 0.75;
                rTol = rTol != null ? rTol : 0.008;
            }
        }
        if (delta > aTol && delta / base > rTol) return null;
        return 1 - Math.min(1, delta / base);
    }

    function itemByteSizeHint(it) {
        if (!it) return 0;
        const n = Number(it._size != null ? it._size : typeof it.size === "number" ? it.size : 0);
        return Number.isFinite(n) && n > 0 ? n : 0;
    }

    /**
     * Soft URL relatedness for same-CDN split A/V (0..1).
     */
    function urlAffinityScore(urlA, urlB) {
        if (!urlA || !urlB) return 0;
        try {
            const a = new URL(urlA);
            const b = new URL(urlB);
            let s = 0;
            if (a.hostname === b.hostname) s += 0.35;
            else if (
                a.hostname.replace(/^www\./, "") === b.hostname.replace(/^www\./, "")
            ) {
                s += 0.25;
            } else {
                // Different hosts: only weak path-token overlap counts later
                s += 0;
            }

            const pa = a.pathname.split("/").filter(Boolean);
            const pb = b.pathname.split("/").filter(Boolean);
            let prefix = 0;
            const n = Math.min(pa.length, pb.length);
            for (let i = 0; i < n; i++) {
                if (pa[i] === pb[i]) prefix++;
                else break;
            }
            if (prefix > 0) s += Math.min(0.3, prefix * 0.08);

            const stripExt = (seg) => String(seg || "").replace(/\.[a-z0-9]{1,5}$/i, "");
            const ta = new Set(pa.map(stripExt).filter((x) => x.length >= 4));
            const tb = new Set(pb.map(stripExt).filter((x) => x.length >= 4));
            let sharedTok = 0;
            for (const t of ta) {
                if (tb.has(t)) sharedTok++;
            }
            if (sharedTok > 0) s += Math.min(0.25, sharedTok * 0.12);

            const interesting = /^(id|vid|aid|mid|media|period|group|cid|fid|file|item|content|asset|track|stream)$/i;
            const qa = [...a.searchParams.entries()];
            const qb = [...b.searchParams.entries()];
            let sharedQ = 0;
            for (const [k, va] of qa) {
                if (!interesting.test(k) || !va) continue;
                for (const [k2, vb] of qb) {
                    if (k2.toLowerCase() === k.toLowerCase() && vb === va) {
                        sharedQ++;
                        break;
                    }
                }
            }
            if (sharedQ > 0) s += Math.min(0.35, sharedQ * 0.15);

            return Math.max(0, Math.min(1, s));
        } catch (_) {
            return 0;
        }
    }

    /** Capture order / requestId proximity (0..1). */
    function requestAffinityScore(v, a) {
        const rv = v && v.requestId != null ? parseInt(v.requestId, 10) : NaN;
        const ra = a && a.requestId != null ? parseInt(a.requestId, 10) : NaN;
        if (Number.isFinite(rv) && Number.isFinite(ra)) {
            const d = Math.abs(rv - ra);
            if (d === 0) return 0.5;
            if (d <= 3) return 0.4;
            if (d <= 10) return 0.28;
            if (d <= 30) return 0.15;
            if (d <= 80) return 0.06;
        }
        // _key often ends with "#index"
        const idxOf = (it) => {
            const k = String((it && it._key) || "");
            const m = k.match(/#(\d+)$/);
            return m ? parseInt(m[1], 10) : NaN;
        };
        const iv = idxOf(v);
        const ia = idxOf(a);
        if (Number.isFinite(iv) && Number.isFinite(ia)) {
            const d = Math.abs(iv - ia);
            if (d <= 1) return 0.2;
            if (d <= 3) return 0.1;
        }
        return 0;
    }

    function sizeAffinityScore(v, a) {
        const sv = itemByteSizeHint(v);
        const sa = itemByteSizeHint(a);
        if (!(sv > 0 && sa > 0)) return 0;
        // Same-duration split: video track usually larger
        if (sv >= sa * 1.15) return 0.2;
        if (sa > sv * 2.5) return -0.25;
        if (sa > sv * 1.5) return -0.1;
        return 0.05;
    }

    /**
     * Composite edge score for one video+audio pair.
     * @returns {{ score: number, durationScore: number, soft: number, delta: number }|null}
     */
    function scoreAvEdge(v, a) {
        const d1 = Number(v && v._durationSec);
        const d2 = Number(a && a._durationSec);
        const durationScore = durationMatchScore(d1, d2);
        if (durationScore == null) return null;

        const urlA = urlAffinityScore(v.url, a.url);
        const reqA = requestAffinityScore(v, a);
        const szA = sizeAffinityScore(v, a);
        // Soft is only a tiny tie-break; URL/request must not override duration
        const soft = Math.max(
            0,
            Math.min(1, urlA * 0.28 + reqA * 0.12 + Math.max(0, szA) * 0.6 + Math.min(0, szA))
        );

        // Auto gate: duration-first. Soft may only rescue a very near miss.
        const AUTO_STRICT = 0.99;
        const AUTO_SOFT = 0.985;
        if (durationScore < AUTO_STRICT && !(durationScore >= AUTO_SOFT && soft >= 0.35)) {
            return null;
        }

        const score = durationScore * 0.96 + soft * 0.04;
        return {
            score,
            durationScore,
            soft,
            delta: d1 - d2,
        };
    }

    function libOrderOf(it, fallback) {
        const n = Number(it && it._libOrder);
        return Number.isFinite(n) ? n : fallback;
    }

    /**
     * Match by original duration+affinity score, but claim in library/grid order:
     * seed = first unused video/audio (top-left), pick its best remaining counterpart.
     * @param {object[]} videos items with _durationSec and _key
     * @param {object[]} audios
     * @returns {{ pairs: object[], ambiguous: number, candidateCount: number, blockedVideos: number, blockedAudios: number }}
     */
    function matchVideoAudioPairs(videos, audios) {
        const vOk = (videos || []).filter((v) => v && v._key && Number(v._durationSec) > 0.05);
        const aOk = (audios || []).filter((a) => a && a._key && Number(a._durationSec) > 0.05);
        const AMBIG_MARGIN = 0.0045;

        vOk.forEach((v, i) => {
            if (v._libOrder == null) v._libOrder = i;
        });
        aOk.forEach((a, i) => {
            if (a._libOrder == null) a._libOrder = i;
        });

        /** @type {{ v: object, a: object, score: number, durationScore: number, soft: number, delta: number }[]} */
        const candidates = [];
        for (const v of vOk) {
            for (const a of aOk) {
                const sc = scoreAvEdge(v, a);
                if (!sc) continue;
                candidates.push({
                    v,
                    a,
                    score: sc.score,
                    durationScore: sc.durationScore,
                    soft: sc.soft,
                    delta: sc.delta,
                });
            }
        }

        /** @type {Map<string, typeof candidates>} */
        const byV = new Map();
        /** @type {Map<string, typeof candidates>} */
        const byA = new Map();
        for (const c of candidates) {
            if (!byV.has(c.v._key)) byV.set(c.v._key, []);
            if (!byA.has(c.a._key)) byA.set(c.a._key, []);
            byV.get(c.v._key).push(c);
            byA.get(c.a._key).push(c);
        }
        const sortDesc = (list) =>
            list.sort(
                (x, y) =>
                    y.score - x.score ||
                    y.durationScore - x.durationScore ||
                    Math.abs(x.delta) - Math.abs(y.delta)
            );
        for (const list of byV.values()) sortDesc(list);
        for (const list of byA.values()) sortDesc(list);

        const vKeys = new Set(vOk.map((v) => v._key));
        const usedV = new Set();
        const usedA = new Set();
        const pairs = [];
        let ambiguous = 0;

        const seeds = [...vOk, ...aOk].sort(
            (x, y) => libOrderOf(x, 0) - libOrderOf(y, 0)
        );

        for (const seed of seeds) {
            if (usedV.has(seed._key) || usedA.has(seed._key)) continue;
            const seedIsV = vKeys.has(seed._key);
            const raw = seedIsV ? byV.get(seed._key) || [] : byA.get(seed._key) || [];
            const list = raw.filter((c) =>
                seedIsV ? !usedA.has(c.a._key) : !usedV.has(c.v._key)
            );
            if (!list.length) continue;
            if (list.length >= 2 && list[0].score - list[1].score < AMBIG_MARGIN) {
                ambiguous++;
                continue;
            }
            const c = list[0];
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
                duration_score: +c.durationScore.toFixed(5),
                soft_score: +c.soft.toFixed(5),
                delta_sec: c.delta,
                video_duration: c.v._durationSec,
                audio_duration: c.a._durationSec,
            });
        }

        return {
            pairs,
            ambiguous,
            candidateCount: candidates.length,
            blockedVideos: 0,
            blockedAudios: 0,
        };
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
        (pool || []).forEach((it, i) => {
            if (it) it._libOrder = i;
        });
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
        const matched = matchVideoAudioPairs(vOk, aOk);
        return {
            pairs: matched.pairs,
            videos: videos.length,
            audios: audios.length,
            probed: classified,
            vOk: vOk.length,
            aOk: aOk.length,
            ambiguous: matched.ambiguous,
            candidateCount: matched.candidateCount,
            blockedVideos: matched.blockedVideos,
            blockedAudios: matched.blockedAudios,
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

    /** Bytes from cat-catch item (Content-Length / size). 0 if unknown. */
    function itemSizeBytes(it) {
        if (!it) return 0;
        const candidates = [
            it.size,
            it.fileSize,
            it.contentLength,
            it.content_length,
            it._size,
            it.header && it.header.size,
        ];
        for (const c of candidates) {
            const n = Number(c);
            if (Number.isFinite(n) && n > 0) return n;
        }
        const h = it._headers || it.requestHeaders || {};
        for (const [k, v] of Object.entries(h)) {
            if (/^content-length$/i.test(k) && v != null && v !== "") {
                const n = parseInt(String(v), 10);
                if (Number.isFinite(n) && n > 0) return n;
            }
        }
        return 0;
    }

    function itemDurationSec(it) {
        if (!it) return 0;
        const d = Number(it._durationSec ?? it.duration_sec ?? it.duration);
        return Number.isFinite(d) && d > 0 ? d : 0;
    }

    /**
     * Reject when size/duration is known and over limit. Unknown → keep.
     */
    function filterBySizeDuration(items, { maxSizeBytes = 0, maxDurationSec = 0 } = {}) {
        const kept = [];
        const skipped = [];
        let skipSize = 0;
        let skipDur = 0;
        for (const it of items || []) {
            const sz = itemSizeBytes(it);
            const dur = itemDurationSec(it);
            if (maxSizeBytes > 0 && sz > 0 && sz > maxSizeBytes) {
                skipSize++;
                skipped.push({
                    it,
                    reason:
                        `过大 ${(sz / (1024 * 1024)).toFixed(1)}MB > ` +
                        `${(maxSizeBytes / (1024 * 1024)).toFixed(0)}MB`,
                });
                continue;
            }
            if (maxDurationSec > 0 && dur > 0 && dur > maxDurationSec) {
                skipDur++;
                skipped.push({
                    it,
                    reason:
                        `过长 ${(dur / 60).toFixed(1)}分钟 > ` +
                        `${(maxDurationSec / 60).toFixed(0)}分钟`,
                });
                continue;
            }
            kept.push(it);
        }
        return {
            kept,
            skipped,
            stats: {
                in: (items || []).length,
                kept: kept.length,
                skipSize,
                skipDur,
                skipped: skipped.length,
            },
        };
    }

    function itemOverLimit(it, maxSizeBytes, maxDurationSec) {
        if (!it) return false;
        const sz = itemSizeBytes(it);
        const dur = itemDurationSec(it);
        if (maxSizeBytes > 0 && sz > 0 && sz > maxSizeBytes) return true;
        if (maxDurationSec > 0 && dur > 0 && dur > maxDurationSec) return true;
        return false;
    }

    /**
     * Convention-scraper analyze + ingest pipeline.
     * avSeparated true  → complete AV direct; rest pair-merge
     * avSeparated false → all video-like direct
     * opts.maxSizeBytes / maxDurationSec: skip when known and over limit
     */
    async function analyzeAndIngest(items, pageUrl, opts = {}) {
        const {
            avSeparated = false,
            restricted = false,
            useJasna = false,
            tags = [],
            onStatus = () => {},
            maxSizeBytes = 0,
            maxDurationSec = 0,
        } = opts;

        const rawTotal = Array.isArray(items) ? items.length : 0;
        let list = normalizeCaughtList(items, pageUrl);
        await enrichHeaders(list, pageUrl);
        onStatus(`分析 ${list.length} 条嗅探资源…`);

        const limitsOn = maxSizeBytes > 0 || maxDurationSec > 0;
        if (limitsOn) {
            // Duration often needs content probe
            if (maxDurationSec > 0) {
                onStatus("识别时长以便过滤过长视频…");
                await classifyPool(list, { onStatus });
            }
            const fr = filterBySizeDuration(list, { maxSizeBytes, maxDurationSec });
            if (fr.skipped.length) {
                onStatus(
                    `过滤：保留 ${fr.stats.kept}/${fr.stats.in}` +
                        (fr.stats.skipSize ? ` · 过大 ${fr.stats.skipSize}` : "") +
                        (fr.stats.skipDur ? ` · 过长 ${fr.stats.skipDur}` : "")
                );
                fr.skipped.slice(0, 5).forEach((s) => {
                    const u = (s.it && s.it.url) || "";
                    onStatus(`  跳过 ${s.reason} · ${String(u).slice(0, 60)}`);
                });
            }
            list = fr.kept;
            if (!list.length) {
                return {
                    mode: avSeparated ? "av_separated" : "direct_all_video",
                    total: rawTotal,
                    direct: 0,
                    merged: 0,
                    unpaired: 0,
                    filtered: fr.stats.skipped,
                    filterStats: fr.stats,
                    result: { success: 0, failed: 0, duplicates: 0 },
                };
            }
        }

        if (!avSeparated) {
            const videos = list.filter(isVideoLike);
            const skipped = list.length - videos.length;
            onStatus(
                `分离关：直接入库视频 ${videos.length}` +
                    (skipped ? `（跳过非视频 ${skipped}）` : "")
            );
            const r = await ingestItems(videos, pageUrl, { tags, restricted, useJasna, onStatus });
            return {
                mode: "direct_all_video",
                total: rawTotal,
                direct: videos.length,
                merged: 0,
                unpaired: 0,
                result: r,
            };
        }

        // avSeparated: classify then split
        await classifyPool(list, { onStatus });
        if (limitsOn) {
            const fr2 = filterBySizeDuration(list, { maxSizeBytes, maxDurationSec });
            if (fr2.stats.skipped) {
                onStatus(
                    `二次过滤：保留 ${fr2.stats.kept}` +
                        (fr2.stats.skipDur ? ` · 过长 ${fr2.stats.skipDur}` : "") +
                        (fr2.stats.skipSize ? ` · 过大 ${fr2.stats.skipSize}` : "")
                );
            }
            list = fr2.kept;
        }

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
            let pairs = det.pairs || [];
            if (limitsOn) {
                const before = pairs.length;
                pairs = pairs.filter(
                    (p) =>
                        !itemOverLimit(p.video_item, maxSizeBytes, maxDurationSec) &&
                        !itemOverLimit(p.audio_item, maxSizeBytes, maxDurationSec)
                );
                if (pairs.length < before) {
                    onStatus(`可合并对过滤：${before} → ${pairs.length}（剔除超限）`);
                }
            }
            onStatus(
                `可合并 ${pairs.length} 对（视频 ${det.videos} · 音频 ${det.audios}）`
            );
            if (pairs.length) {
                mergeResult = await mergePagePairs(pairs, { restricted, useJasna, onStatus });
                const used = new Set();
                for (const p of pairs) {
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
            total: rawTotal,
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
        urlAffinityScore,
        requestAffinityScore,
        sizeAffinityScore,
        scoreAvEdge,
        matchVideoAudioPairs,
        classifyItemContent,
        classifyPool,
        detectPageAvPairs,
        fetchItemBlob,
        enrichHeaders,
        normalizeCaughtList,
        ingestItems,
        mergePagePairs,
        analyzeAndIngest,
        filterBySizeDuration,
        itemSizeBytes,
        itemDurationSec,
        isCompleteAv,
        isVideoLike,
        applyPlayHeaders,
        playHeaderMap,
    };

    global.LMWAv = LMWAv;
})(typeof window !== "undefined" ? window : globalThis);
