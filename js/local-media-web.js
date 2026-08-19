/**
 * LocalMediaWeb API client for cat-catch extension.
 */
const LMW = {
    defaults: {
        lmwEnable: true,
        lmwURL: "http://192.168.10.84:8790",
        lmwToken: "",
        lmwDefaultCategory: "default",
        lmwAutoFallback: true,
        lmwUseJasna: false,
        /** 本机 JasnaBridge（去码中间件，默认 8791） */
        jasnaBridgeURL: "http://127.0.0.1:8791",
    },
    /** No hard cap on tags per item (server normalize also unlimited). */
    MAX_TAGS: 0,
    /** Mirror of server TAG_ALIASES for client-side normalize. */
    TAG_ALIASES: {
        yt: "youtube",
        youtu: "youtube",
        bili: "bilibili",
        "bilibili.com": "bilibili",
        x: "twitter",
        二次元: "anime",
        动漫: "anime",
        动画: "anime",
        漫画: "manga",
        插画: "illustration",
        美图: "photo",
        照片: "photo",
        图片: "image",
        影片: "video",
        视频: "video",
    },
    /** In-memory tag library cache: { tags: [{name,count}], ts, total } */
    _tagLibCache: null,
    TAG_LIB_TTL_MS: 3 * 60 * 1000,

    baseUrl() {
        const u = (G.lmwURL || this.defaults.lmwURL || "").replace(/\/+$/, "");
        return u || this.defaults.lmwURL;
    },

    jasnaBridgeBaseUrl() {
        const g =
            typeof G !== "undefined" && G.jasnaBridgeURL
                ? G.jasnaBridgeURL
                : this.defaults.jasnaBridgeURL;
        const u = (g || "").replace(/\/+$/, "");
        return u || this.defaults.jasnaBridgeURL;
    },

    headers(json = true) {
        const h = {};
        if (json) h["Content-Type"] = "application/json;charset=utf-8";
        const token = (G.lmwToken || "").trim();
        if (token) h["X-LMW-Token"] = token;
        return h;
    },

    async request(path, options = {}) {
        const url = this.baseUrl() + path;
        const res = await fetch(url, options);
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`${res.status} ${text || res.statusText}`);
        }
        const ct = res.headers.get("content-type") || "";
        if (ct.includes("application/json")) return res.json();
        return res;
    },

    health() {
        return this.request("/api/health");
    },

    categories() {
        return this.request("/api/categories", { headers: this.headers(false) });
    },

    createCategory(name) {
        return this.request("/api/categories", {
            method: "POST",
            headers: this.headers(true),
            body: JSON.stringify({ name }),
        });
    },

    RESTRICTED_TAG: "限制级",

    applyRestrictedTag(tags, restricted) {
        const out = this.normalizeTags(tags);
        if (restricted && !out.includes(this.RESTRICTED_TAG)) {
            out.push(this.RESTRICTED_TAG);
        }
        return out;
    },

    isRestrictedTags(tags) {
        return this.normalizeTags(tags).includes(this.RESTRICTED_TAG);
    },

    ingest(category, items, tags = [], opts = {}) {
        const restricted = !!(opts && opts.restricted);
        const body = {
            category: category || "default",
            items,
            tags: this.applyRestrictedTag(tags, restricted),
        };
        // use_jasna no longer sent to LMW — demosaic via local JasnaBridge / FFmpegBridge
        if (restricted) body.restricted = true;
        return this.request("/api/ingest", {
            method: "POST",
            headers: this.headers(true),
            body: JSON.stringify(body),
        });
    },

    canonicalTag(name) {
        let n = String(name || "")
            .trim()
            .toLowerCase()
            .replace(/^#/, "")
            .replace(/\s+/g, "-");
        n = n.replace(/[^\w\u4e00-\u9fff\-+.#]/gi, "").slice(0, 32);
        if (!n) return "";
        return this.TAG_ALIASES[n] || n;
    },

    normalizeTags(raw) {
        if (!raw) return [];
        let list = raw;
        if (typeof raw === "string") {
            try {
                const j = JSON.parse(raw);
                list = Array.isArray(j) ? j : String(raw).split(/[,，;；\s]+/);
            } catch (e) {
                list = String(raw).split(/[,，;；\s]+/);
            }
        }
        if (!Array.isArray(list)) return [];
        const out = [];
        const seen = new Set();
        for (const t of list) {
            const name = this.canonicalTag(t);
            if (!name || seen.has(name)) continue;
            seen.add(name);
            out.push(name);
        }
        return out;
    },

    /** Levenshtein distance for short tags. */
    _editDistance(a, b) {
        a = String(a || "");
        b = String(b || "");
        if (a === b) return 0;
        if (!a) return b.length;
        if (!b) return a.length;
        if (Math.abs(a.length - b.length) > 3) return 99;
        let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
        for (let i = 0; i < a.length; i++) {
            const cur = [i + 1];
            for (let j = 0; j < b.length; j++) {
                const cost = a[i] === b[j] ? 0 : 1;
                cur.push(Math.min(cur[j] + 1, prev[j + 1] + 1, prev[j] + cost));
            }
            prev = cur;
        }
        return prev[b.length];
    },

    /**
     * Fetch / cache server tag library (aggregated from all media).
     * @returns {Promise<{tags: {name:string,count:number}[], total:number}>}
     */
    async getTagLibrary({ force = false } = {}) {
        const now = Date.now();
        if (
            !force &&
            this._tagLibCache &&
            now - this._tagLibCache.ts < this.TAG_LIB_TTL_MS
        ) {
            return this._tagLibCache;
        }
        try {
            const res = await this.listTags();
            const tags = (res.tags || [])
                .map((t) =>
                    typeof t === "string"
                        ? { name: this.canonicalTag(t), count: 1 }
                        : {
                              name: this.canonicalTag(t.name || t.tag || ""),
                              count: Number(t.count) || 0,
                          }
                )
                .filter((t) => t.name);
            const pack = {
                tags,
                total: res.total != null ? res.total : tags.length,
                ts: now,
            };
            this._tagLibCache = pack;
            return pack;
        } catch (e) {
            if (this._tagLibCache) return this._tagLibCache;
            return { tags: [], total: 0, ts: now };
        }
    },

    invalidateTagLibrary() {
        this._tagLibCache = null;
    },

    /**
     * Autocomplete match against tag library.
     * @returns {{name:string,count:number,score:number}[]}
     */
    matchTags(query, libraryTags, { limit = 8, exclude = [] } = {}) {
        const q = this.canonicalTag(query);
        if (!q) return [];
        const ex = new Set((exclude || []).map((t) => this.canonicalTag(t)));
        const scored = [];
        for (const row of libraryTags || []) {
            const n = this.canonicalTag(row.name || row);
            if (!n || ex.has(n)) continue;
            const cnt = Number(row.count) || 0;
            let sc = 0;
            if (n === q) sc = 1000;
            else if (n.startsWith(q)) sc = 500 - n.length * 0.1;
            else if (n.includes(q)) sc = 300 - n.indexOf(q) * 2;
            else if (q.includes(n) && n.length >= 2) sc = 200;
            else {
                const d = this._editDistance(n, q);
                const maxD = q.length < 5 ? 1 : 2;
                if (d <= maxD) sc = 150 - d * 40;
                else continue;
            }
            sc += Math.min(40, Math.log1p(cnt) * 6);
            scored.push({ name: n, count: cnt, score: sc });
        }
        scored.sort((a, b) => b.score - a.score || b.count - a.count || a.name.localeCompare(b.name));
        const out = [];
        const seen = new Set();
        for (const s of scored) {
            if (seen.has(s.name)) continue;
            seen.add(s.name);
            out.push(s);
            if (out.length >= limit) break;
        }
        return out;
    },

    /**
     * Soft-correct a typed tag to a frequent library near-duplicate.
     * @returns {string|null} library tag name, or null
     */
    nearDuplicateTag(name, libraryTags, { minCount = 2 } = {}) {
        const t = this.canonicalTag(name);
        if (!t || !libraryTags || !libraryTags.length) return null;
        const byName = new Map();
        for (const row of libraryTags) {
            const n = this.canonicalTag(row.name || row);
            if (n) byName.set(n, Number(row.count) || 0);
        }
        if (byName.has(t)) return null;
        let best = null;
        for (const [n, cnt] of byName) {
            if (cnt < minCount) continue;
            const d = this._editDistance(t, n);
            const maxD = Math.max(t.length, n.length) < 6 ? 1 : 2;
            if (d === 0 || d > maxD) continue;
            const rank = cnt / (1 + d);
            if (!best || rank > best.rank) best = { rank, name: n };
        }
        return best ? best.name : null;
    },

    /**
     * Merge rule suggestions + library hits for a media context.
     */
    mergeTagSuggestions({
        title = "",
        url = "",
        media_type = "",
        source_page = "",
        local = [],
        remote = [],
        libraryTags = [],
        limit = 14,
    } = {}) {
        const blob = `${title} ${url} ${source_page}`.toLowerCase();
        const titleToks =
            String(title || "").match(/[\u4e00-\u9fff]{2,6}|[A-Za-z][A-Za-z0-9_-]{2,20}/g) ||
            [];
        const toks = titleToks.map((t) => this.canonicalTag(t)).filter(Boolean);
        const scored = new Map(); // name -> score

        const bump = (name, sc) => {
            const n = this.canonicalTag(name);
            if (!n) return;
            scored.set(n, Math.max(scored.get(n) || 0, sc));
        };

        for (const t of local || []) bump(t, 80);
        for (const t of remote || []) bump(t, 90);

        for (const row of libraryTags || []) {
            const n = this.canonicalTag(row.name || row);
            if (!n) continue;
            const cnt = Number(row.count) || 0;
            let sc = 0;
            if (blob.includes(n)) sc = 120;
            for (const tok of toks) {
                if (n === tok) sc = Math.max(sc, 110);
                else if (n.includes(tok) || tok.includes(n)) sc = Math.max(sc, 60);
                else if (n.startsWith(tok) || tok.startsWith(n)) sc = Math.max(sc, 40);
                else if (tok.length >= 3 && this._editDistance(n, tok) <= 1) sc = Math.max(sc, 35);
            }
            if (sc > 0) {
                sc += Math.min(25, Math.log1p(cnt) * 4);
                bump(n, sc);
            }
        }

        // Hot library tags (count≥5) that share a char prefix with title tokens
        for (const row of libraryTags || []) {
            const n = this.canonicalTag(row.name || row);
            const cnt = Number(row.count) || 0;
            if (!n || cnt < 5 || scored.has(n)) continue;
            for (const tok of toks) {
                if (tok.length >= 2 && (n.startsWith(tok.slice(0, 2)) || tok.startsWith(n.slice(0, 2)))) {
                    bump(n, 20 + Math.min(15, cnt));
                    break;
                }
            }
        }

        return [...scored.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([n]) => n)
            .slice(0, limit);
    },

    /** Rule-based tag suggestions (offline). */
    suggestTags({ title = "", url = "", media_type = "", source_page = "" } = {}) {
        const candidates = [];
        const mt = (media_type || "").toLowerCase();
        if (["video", "image", "gif", "m3u8", "dash"].includes(mt)) {
            candidates.push(mt === "dash" ? "dash" : mt);
        }
        const pickExt = (u) => {
            const path = (u || "").split("?")[0].split("#")[0];
            const m = path.match(/\.([a-z0-9]{2,5})$/i);
            return m ? m[1].toLowerCase() : "";
        };
        const extMap = {
            mp4: "mp4",
            webm: "webm",
            mkv: "mkv",
            m3u8: "m3u8",
            mpd: "dash",
            gif: "gif",
            png: "png",
            jpg: "jpg",
            jpeg: "jpg",
            webp: "webp",
        };
        const e = pickExt(url) || pickExt(source_page);
        if (extMap[e]) candidates.push(extMap[e]);
        const hostTag = (u) => {
            try {
                let host = new URL(u).hostname.toLowerCase().replace(/^www\./, "");
                const known = [
                    ["bilibili.com", "bilibili"],
                    ["youtube.com", "youtube"],
                    ["youtu.be", "youtube"],
                    ["twitter.com", "twitter"],
                    ["x.com", "twitter"],
                    ["instagram.com", "instagram"],
                    ["tiktok.com", "tiktok"],
                    ["douyin.com", "douyin"],
                ];
                for (const [suf, tag] of known) {
                    if (host === suf || host.endsWith("." + suf)) return tag;
                }
                const parts = host.split(".");
                if (parts.length >= 2) {
                    const label = parts[parts.length - 2];
                    if (label && label.length >= 2 && label.length <= 16) return label;
                }
            } catch (err) { /* ignore */ }
            return "";
        };
        for (const u of [url, source_page]) {
            const ht = hostTag(u);
            if (ht) {
                candidates.push(ht);
                break;
            }
        }
        const titleToks = String(title || "").match(/[\u4e00-\u9fff]{2,6}|[A-Za-z][A-Za-z0-9_-]{2,20}/g) || [];
        for (const t of titleToks.slice(0, 3)) candidates.push(t.toLowerCase());
        return this.normalizeTags(candidates);
    },

    getJob(id) {
        return this.request(`/api/jobs/${id}`, { headers: this.headers(false) });
    },

    async uploadBlob(blob, meta = {}) {
        const fd = new FormData();
        fd.append("category", meta.category || "default");
        fd.append("title", meta.title || "");
        fd.append("source_url", meta.source_url || meta.url || "");
        fd.append("media_type", meta.media_type || "");
        const restricted = !!(
            meta.restricted === true ||
            meta.restricted === 1 ||
            meta.restricted === "1"
        );
        const tags = this.applyRestrictedTag(meta.tags || [], restricted);
        if (tags.length) fd.append("tags", JSON.stringify(tags));
        if (restricted) fd.append("restricted", "1");
        const name = meta.filename || "upload.bin";
        fd.append("file", blob, name);
        const headers = this.headers(false);
        delete headers["Content-Type"];
        const res = await fetch(this.baseUrl() + "/api/upload", {
            method: "POST",
            headers,
            body: fd,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`${text || res.statusText}`);
        }
        return res.json();
    },

    /**
     * Health-check local JasnaBridge middleware (not LMW server jasna).
     * @returns {Promise<{ok:boolean, jasna?:boolean, lmw_reachable?:boolean, message?:string, raw?:object}>}
     */
    async jasnaBridgeHealth() {
        const base = this.jasnaBridgeBaseUrl();
        try {
            const res = await fetch(base + "/api/health", { method: "GET" });
            const text = await res.text().catch(() => "");
            let raw = null;
            try {
                raw = text ? JSON.parse(text) : null;
            } catch (e) {
                raw = null;
            }
            if (!res.ok) {
                return {
                    ok: false,
                    message: `JasnaBridge HTTP ${res.status}: ${(text || res.statusText).slice(0, 160)}`,
                    raw,
                };
            }
            if (raw && raw.jasna === false) {
                return {
                    ok: false,
                    jasna: false,
                    lmw_reachable: !!raw.lmw_reachable,
                    message: "JasnaBridge 已启动但未找到 jasna.exe（检查中间件 config.yaml）",
                    raw,
                };
            }
            return {
                ok: true,
                jasna: raw ? raw.jasna !== false : true,
                lmw_reachable: !!(raw && raw.lmw_reachable),
                raw,
            };
        } catch (e) {
            return {
                ok: false,
                message: `无法连接 JasnaBridge（${base}）：${(e && e.message) || e}`,
            };
        }
    },

    /**
     * Enqueue demosaic on local JasnaBridge via multipart file upload.
     * Bridge runs jasna then POSTs finished video to LMW.
     * meta.source_media_id: LMW item already saved (m3u8 clip); kept if jasna fails,
     * deleted by bridge after demosaic succeeds.
     */
    async enqueueJasnaBridgeBlob(blob, meta = {}) {
        if (!blob || !(blob.size > 0)) throw new Error("empty blob for JasnaBridge");
        const fd = new FormData();
        const restricted = !!(
            meta.restricted === true ||
            meta.restricted === 1 ||
            meta.restricted === "1"
        );
        const tags = this.applyRestrictedTag(meta.tags || [], restricted);
        fd.append("title", meta.title || "");
        fd.append("category", meta.category || "default");
        if (tags.length) fd.append("tags", JSON.stringify(tags));
        if (restricted) fd.append("restricted", "1");
        const srcMid = meta.source_media_id != null ? parseInt(meta.source_media_id, 10) : 0;
        if (srcMid > 0) fd.append("source_media_id", String(srcMid));
        const name = meta.filename || `${(meta.title || "video").slice(0, 40)}.mp4`;
        fd.append("file", blob, name);
        const res = await fetch(this.jasnaBridgeBaseUrl() + "/api/jobs", {
            method: "POST",
            body: fd,
        });
        const text = await res.text().catch(() => "");
        let data = null;
        try {
            data = text ? JSON.parse(text) : null;
        } catch (e) {
            data = null;
        }
        if (!res.ok) {
            throw new Error(
                (data && (data.detail || data.message)) ||
                    text ||
                    res.statusText ||
                    "JasnaBridge enqueue failed"
            );
        }
        return data || {};
    },

    async getJasnaBridgeJob(jobId) {
        const res = await fetch(this.jasnaBridgeBaseUrl() + `/api/jobs/${jobId}`);
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`${res.status} ${text || res.statusText}`);
        }
        return res.json();
    },

    /**
     * Poll JasnaBridge jobs until terminal status.
     */
    async waitJasnaBridgeJobs(jobIds, { timeoutMs = 3600000, intervalMs = 2000, onUpdate } = {}) {
        const ids = [...new Set((jobIds || []).map(Number).filter((n) => n > 0))];
        if (!ids.length) return [];
        const start = Date.now();
        const done = new Map();
        while (Date.now() - start < timeoutMs) {
            for (const id of ids) {
                if (done.has(id)) continue;
                try {
                    const j = await this.getJasnaBridgeJob(id);
                    if (
                        j &&
                        ["done", "failed", "cancelled", "done_no_jasna"].includes(j.status)
                    ) {
                        done.set(id, j);
                    } else if (j && onUpdate) {
                        onUpdate(
                            `jasna#${id} ${j.status || "?"} ${Math.round(j.progress || 0)}%`,
                            j
                        );
                    }
                } catch (e) {
                    done.set(id, {
                        id,
                        status: "failed",
                        message: String((e && e.message) || e),
                    });
                }
            }
            if (done.size >= ids.length) break;
            if (onUpdate) {
                const pending = ids.filter((id) => !done.has(id));
                onUpdate(
                    `JasnaBridge 排队中 ${done.size}/${ids.length}` +
                        (pending.length ? ` · 待 #${pending.join(",")}` : ""),
                    [...done.values()]
                );
            }
            await new Promise((r) => setTimeout(r, intervalMs));
        }
        for (const id of ids) {
            if (!done.has(id)) {
                done.set(id, { id, status: "failed", message: "timeout waiting JasnaBridge" });
            }
        }
        return ids.map((id) => done.get(id));
    },

    /**
     * Download media file bytes from LMW (after server m3u8 job etc.).
     */
    async fetchMediaFileBlob(mediaId) {
        const res = await fetch(this.baseUrl() + `/api/media/${mediaId}/file`, {
            headers: this.headers(false),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`download media ${mediaId}: ${text || res.statusText}`);
        }
        return res.blob();
    },

    /**
     * Fetch remote item to Blob (client-side).
     */
    async clientFetchBlob(item) {
        const headers = item.headers || {};
        const res = await fetch(item.url, { headers, credentials: "omit" });
        if (!res.ok) throw new Error(`client fetch HTTP ${res.status}`);
        const blob = await res.blob();
        let ext = "bin";
        const ct = res.headers.get("content-type") || "";
        if (ct.includes("png")) ext = "png";
        else if (ct.includes("jpeg") || ct.includes("jpg")) ext = "jpg";
        else if (ct.includes("gif")) ext = "gif";
        else if (ct.includes("webp")) ext = "webp";
        else if (ct.includes("mp4")) ext = "mp4";
        else if (ct.includes("webm")) ext = "webm";
        else {
            const m = String(item.url || "").match(/\.([a-z0-9]{2,5})(?:\?|$)/i);
            if (m) ext = m[1].toLowerCase();
        }
        return {
            blob,
            filename: `${String(item.title || "media").slice(0, 40)}.${ext}`,
            ext,
        };
    },

    /** True if item has a meaningful time-range clip. */
    itemHasClip(it) {
        if (!it) return false;
        const s = it.start_sec;
        const e = it.end_sec;
        const hasStart = s != null && s !== "" && !Number.isNaN(+s) && +s > 0;
        const hasEnd = e != null && e !== "" && !Number.isNaN(+e) && +e > 0;
        // start=0 + end set is still a clip
        const startZero = s != null && s !== "" && !Number.isNaN(+s) && +s === 0 && hasEnd;
        return hasStart || hasEnd || startZero;
    },

    /** Human suffix for titles, e.g. [t=240-360] */
    clipTitleSuffix(it) {
        if (!this.itemHasClip(it)) return "";
        const s = Math.max(0, Math.floor(+(it.start_sec || 0)));
        const e =
            it.end_sec != null && it.end_sec !== "" && +it.end_sec > 0
                ? Math.floor(+it.end_sec)
                : null;
        return e == null ? ` [t=${s}-end]` : ` [t=${s}-${e}]`;
    },

    /**
     * LMW download/clip → fetch file → JasnaBridge.
     * Intermediate stays in the library until demosaic succeeds (bridge deletes it).
     * If jasna fails, uncoded item remains — that is intentional.
     * Used for m3u8/dash and for any video with start_sec/end_sec.
     */
    async _lmwPrepareThenJasnaBridge(it, cat, sharedTags, useRestricted, report) {
        const baseTitle = it.title || "media";
        const title = baseTitle + this.clipTitleSuffix(it);
        // Ingest fully (tags/restricted): this IS the library item if jasna fails
        const one = await this.pushItems([{ ...it, title }], cat, {
            tags: sharedTags,
            restricted: useRestricted,
            wait: true,
        });
        const jobs = one.jobs || [];
        const okJob = jobs.find(
            (j) =>
                j &&
                j.status === "success" &&
                j.media_id &&
                !String(j.error_message || "").includes("content_duplicate")
        );
        if (!okJob || !okJob.media_id) {
            const why =
                (jobs[0] && (jobs[0].error_message || jobs[0].status)) ||
                "download/clip failed";
            throw new Error(String(why).slice(0, 200));
        }
        const mid = okJob.media_id;
        if (report) report(`已入库 media#${mid}（未去码）→ JasnaBridge…`);
        const blob = await this.fetchMediaFileBlob(mid);
        const enq = await this.enqueueJasnaBridgeBlob(blob, {
            title,
            tags: sharedTags,
            restricted: useRestricted,
            category: cat,
            filename: `${String(title).slice(0, 60)}.mp4`,
            source_media_id: mid,
        });
        // Do NOT delete intermediate here. JasnaBridge deletes it only after demosaic OK.
        return { enq, mid, title, one };
    },

    /**
     * Ingest with demosaic: queue finished files on local JasnaBridge (not LMW server jasna).
     * - image/gif/audio: normal LMW upload/ingest (no jasna)
     * - m3u8/dash OR any item with time-range clip: LMW download/clip first → JasnaBridge
     * - direct full video (no clip): client fetch → JasnaBridge multipart
     */
    async pushItemsViaJasnaBridge(
        items,
        category,
        { tags, restricted, onProgress, waitBridge = false } = {}
    ) {
        const cat = category || (typeof G !== "undefined" && G.lmwDefaultCategory) || "default";
        const useRestricted =
            restricted === true ||
            (typeof G !== "undefined" && G.lmwRestricted === true);
        const sharedTags = this.applyRestrictedTag(tags || [], useRestricted);

        const hb = await this.jasnaBridgeHealth();
        if (!hb.ok) {
            throw new Error(hb.message || "JasnaBridge unavailable");
        }

        let success = 0;
        let failed = 0;
        let duplicates = 0;
        let contentDuplicates = 0;
        let fallbackOk = 0;
        const bridgeJobIds = [];
        const errors = [];

        const report = (msg) => {
            if (onProgress) onProgress({ message: msg });
        };

        for (let i = 0; i < items.length; i++) {
            const it = { ...(items[i] || {}) };
            if (sharedTags.length && (!it.tags || !it.tags.length)) it.tags = sharedTags;
            if (useRestricted) it.restricted = true;
            const mtype = String(it.media_type || "").toLowerCase();
            const title = (it.title || "media") + this.clipTitleSuffix(it);
            report(`JasnaBridge ${i + 1}/${items.length} · ${title.slice(0, 48)}`);

            try {
                // Non-video: normal path
                if (mtype === "image" || mtype === "gif" || mtype === "audio") {
                    const one = await this.pushItems([it], cat, {
                        tags: sharedTags,
                        restricted: useRestricted,
                        wait: true,
                    });
                    success += one.success || 0;
                    failed += one.failed || 0;
                    duplicates += one.duplicates || 0;
                    contentDuplicates += one.contentDuplicates || 0;
                    fallbackOk += one.fallbackOk || 0;
                    continue;
                }

                // Streams OR time-range clips: must use LMW first (clip/HLS), never full-file×N
                const needLmwFirst =
                    mtype === "m3u8" ||
                    mtype === "dash" ||
                    this.itemHasClip(it);

                if (needLmwFirst) {
                    try {
                        const { enq, one } = await this._lmwPrepareThenJasnaBridge(
                            it,
                            cat,
                            sharedTags,
                            useRestricted,
                            report
                        );
                        duplicates += one.duplicates || 0;
                        contentDuplicates += one.contentDuplicates || 0;
                        if (enq && enq.job_id) bridgeJobIds.push(enq.job_id);
                        success++;
                    } catch (e) {
                        failed++;
                        errors.push(`${title}: ${e.message || e}`);
                    }
                    continue;
                }

                // Direct full video URL/blob (no clip): fetch then JasnaBridge
                let blob;
                let filename;
                if (it.blob instanceof Blob) {
                    blob = it.blob;
                    filename = it.filename || `${String(title).slice(0, 40)}.mp4`;
                } else {
                    const fetched = await this.clientFetchBlob(it);
                    blob = fetched.blob;
                    filename = fetched.filename;
                }
                const enq = await this.enqueueJasnaBridgeBlob(blob, {
                    title,
                    tags: sharedTags,
                    restricted: useRestricted,
                    category: cat,
                    filename,
                });
                if (enq.job_id) bridgeJobIds.push(enq.job_id);
                success++;
            } catch (e) {
                failed++;
                errors.push(`${title}: ${e.message || e}`);
                console.warn("pushItemsViaJasnaBridge item failed", e);
            }
        }

        let bridgeJobs = [];
        if (waitBridge && bridgeJobIds.length) {
            bridgeJobs = await this.waitJasnaBridgeJobs(bridgeJobIds, {
                onUpdate: (t) => report(t),
            });
        }

        return {
            success,
            failed,
            duplicates,
            contentDuplicates,
            fallbackOk,
            bridgeJobIds,
            bridgeJobs,
            errors,
            jobs: [],
        };
    },

    getJasnaJob(id) {
        return this.request(`/api/jasna/jobs/${id}`, { headers: this.headers(false) });
    },

    listJasnaJobs(params = {}) {
        const q = new URLSearchParams();
        if (params.status) q.set("status", params.status);
        if (params.media_id != null) q.set("media_id", String(params.media_id));
        if (params.limit != null) q.set("limit", String(params.limit));
        const qs = q.toString();
        return this.request(`/api/jasna/jobs${qs ? "?" + qs : ""}`, {
            headers: this.headers(false),
        });
    },

    /**
     * Poll LMW-server jasna jobs (legacy; prefer JasnaBridge).
     * Resolves when all related jobs finished or timeout.
     */
    async waitJasnaForMediaIds(mediaIds, { timeoutMs = 3600000, intervalMs = 2000, onUpdate } = {}) {
        const ids = [...new Set((mediaIds || []).map(Number).filter((n) => n > 0))];
        if (!ids.length) return [];
        const start = Date.now();
        const seen = new Map(); // media_id -> latest job snapshot
        while (Date.now() - start < timeoutMs) {
            for (const mid of ids) {
                try {
                    const res = await this.listJasnaJobs({ media_id: mid, limit: 1 });
                    const j = (res.items || [])[0];
                    if (j) seen.set(mid, j);
                } catch (e) {
                    /* keep last */
                }
            }
            const jobs = ids.map((mid) => seen.get(mid)).filter(Boolean);
            if (typeof onUpdate === "function") {
                const parts = jobs.map((j) => {
                    const pct = Math.round(Number(j.progress) || 0);
                    return `#${j.id} m${j.media_id} ${j.status} ${pct}%`;
                });
                onUpdate(
                    jobs.length
                        ? `jasna: ${parts.join(" · ")}`
                        : `jasna: 等待入队（媒体 ${ids.join(",")})…`,
                    jobs
                );
            }
            if (
                jobs.length >= ids.length &&
                jobs.every((j) => ["success", "failed", "cancelled"].includes(j.status))
            ) {
                return jobs;
            }
            // if some media never got a job after 15s, stop waiting on those
            if (Date.now() - start > 15000) {
                const pending = ids.filter((mid) => !seen.has(mid));
                if (pending.length && jobs.length) {
                    const rest = jobs.filter(
                        (j) => !["success", "failed", "cancelled"].includes(j.status)
                    );
                    if (!rest.length) return jobs;
                }
            }
            await new Promise((r) => setTimeout(r, intervalMs));
        }
        return ids.map((mid) => seen.get(mid)).filter(Boolean);
    },

    /** Absolute API URL for relative paths like /api/media/1/thumb */
    absUrl(path) {
        if (!path) return "";
        if (/^https?:\/\//i.test(path)) return path;
        return this.baseUrl() + (path.startsWith("/") ? path : "/" + path);
    },

    /**
     * Media/thumb URL with ?token= for <video>/<img>/<audio> (cannot set X-LMW-Token).
     * Prefer this over full-file fetch+blob for preview — Range streaming, avoids ERR_FAILED on large files.
     */
    mediaUrlWithToken(pathOrUrl) {
        const url = this.absUrl(pathOrUrl);
        if (!url) return "";
        const token = (typeof G !== "undefined" && G.lmwToken ? String(G.lmwToken) : "").trim();
        if (!token) return url;
        try {
            const u = new URL(url);
            if (!u.searchParams.get("token")) u.searchParams.set("token", token);
            return u.href;
        } catch (e) {
            const sep = url.includes("?") ? "&" : "?";
            return url + sep + "token=" + encodeURIComponent(token);
        }
    },

    listMedia(params = {}, options = {}) {
        const q = new URLSearchParams();
        if (params.q) q.set("q", params.q);
        if (params.type) q.set("type", params.type);
        if (params.tag) q.set("tag", params.tag);
        if (params.sort) q.set("sort", params.sort);
        if (params.liked === true || params.liked === false) q.set("liked", String(params.liked));
        q.set("offset", String(params.offset ?? 0));
        q.set("limit", String(params.limit ?? 48));
        const qs = q.toString();
        return this.request(`/api/media?${qs}`, {
            headers: this.headers(false),
            signal: options.signal,
        });
    },

    /**
     * Duration-match silent video + pure audio in the library (server ffprobe).
     * @param {{ ids?: number[], abs_tol_sec?: number, min_score?: number, include_av_videos?: boolean }} body
     */
    matchAvPairs(body = {}) {
        return this.request("/api/media/av-match", {
            method: "POST",
            headers: this.headers(true),
            body: JSON.stringify({
                ids: body.ids || [],
                abs_tol_sec: body.abs_tol_sec ?? 0.45,
                rel_tol: body.rel_tol ?? 0.02,
                min_score: body.min_score ?? 0.97,
                include_av_videos: !!body.include_av_videos,
            }),
        });
    },

    /**
     * Lightweight remote classify: server downloads only a small head (default ~4MiB)
     * + optional tail, ffprobe/magic, discards temp. Not a full-file cache for merge.
     * @param {{ url: string, headers?: object, max_bytes?: number, tail_bytes?: number }} body
     */
    probeUrl(body = {}) {
        const payload = {
            url: body.url || "",
            headers: body.headers || {},
        };
        // 0 → server default (~4MiB). Pass explicit max_bytes only when needed.
        if (body.max_bytes != null && body.max_bytes > 0) {
            payload.max_bytes = body.max_bytes;
        }
        if (body.tail_bytes != null) {
            payload.tail_bytes = body.tail_bytes;
        }
        return this.request("/api/media/probe-url", {
            method: "POST",
            headers: this.headers(true),
            body: JSON.stringify(payload),
        });
    },

    /**
     * Re-probe library files on disk and fix media_type (audio-in-.mp4 etc.).
     * @param {{ ids?: number[], include_images?: boolean }} body
     */
    reclassifyMedia(body = {}) {
        return this.request("/api/media/reclassify", {
            method: "POST",
            headers: this.headers(true),
            body: JSON.stringify({
                ids: body.ids || [],
                include_images: !!body.include_images,
            }),
        });
    },

    /**
     * Merge library video_id + audio_id pairs into new video media items.
     * @param {{ pairs: {video_id:number,audio_id:number}[], tags?: string[], title?: string, delete_sources?: boolean }} body
     */
    mergeAvLibrary(body = {}) {
        return this.request("/api/media/merge-av", {
            method: "POST",
            headers: this.headers(true),
            body: JSON.stringify({
                pairs: body.pairs || [],
                tags: body.tags || [],
                title: body.title || "",
                delete_sources: !!body.delete_sources,
            }),
        });
    },

    /**
     * Concatenate library media ids in order (server ffmpeg) into one video.
     * @param {{ ids: number[], title?: string, tags?: string[], delete_sources?: boolean, use_jasna?: boolean, restricted?: boolean }} body
     */
    concatMediaLibrary(body = {}) {
        return this.request("/api/media/concat", {
            method: "POST",
            headers: this.headers(true),
            body: JSON.stringify({
                ids: body.ids || [],
                title: body.title || "",
                tags: body.tags || [],
                delete_sources: !!body.delete_sources,
                use_jasna: !!body.use_jasna,
                restricted: !!body.restricted,
            }),
        });
    },

    /**
     * Upload multiple progressive video blobs; server ffmpeg-concats into one library item.
     * @param {Blob[]} blobs ordered parts
     * @param {{ title?: string, source_url?: string, tags?: string[], restricted?: boolean, use_jasna?: boolean, filenames?: string[] }} [meta]
     */
    async uploadConcatBlobs(blobs, meta = {}) {
        const list = (blobs || []).filter((b) => b && b.size > 32);
        if (!list.length) throw new Error("no blobs for concat");
        const fd = new FormData();
        fd.append("category", meta.category || "default");
        fd.append("title", meta.title || "");
        fd.append("source_url", meta.source_url || meta.url || "");
        const restricted = !!(
            meta.restricted === true ||
            meta.restricted === 1 ||
            meta.restricted === "1"
        );
        const tags = this.applyRestrictedTag(meta.tags || [], restricted);
        if (tags.length) fd.append("tags", JSON.stringify(tags));
        if (restricted) fd.append("restricted", "1");
        if (meta.use_jasna) fd.append("use_jasna", "1");
        list.forEach((blob, i) => {
            const name =
                (meta.filenames && meta.filenames[i]) ||
                `part_${String(i + 1).padStart(2, "0")}.mp4`;
            fd.append("files", blob, name);
        });
        const headers = this.headers(false);
        delete headers["Content-Type"];
        const res = await fetch(this.baseUrl() + "/api/upload-concat", {
            method: "POST",
            headers,
            body: fd,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`${text || res.statusText}`);
        }
        return res.json();
    },

    listTags(params = {}) {
        const q = new URLSearchParams();
        if (params.q) q.set("q", params.q);
        if (params.limit) q.set("limit", String(params.limit));
        const qs = q.toString();
        return this.request(`/api/tags${qs ? "?" + qs : ""}`, {
            headers: this.headers(false),
        });
    },

    deleteMedia(id) {
        return this.request(`/api/media/${id}`, {
            method: "DELETE",
            headers: this.headers(false),
        });
    },

    batchDelete(ids) {
        return this.request("/api/media/delete-batch", {
            method: "POST",
            headers: this.headers(true),
            body: JSON.stringify({ ids: (ids || []).slice(0, 200) }),
        });
    },

    /**
     * One-click dedupe: remove MediaItems whose files are byte-identical.
     * @param {{ dry_run?: boolean }} [opts]
     */
    dedupeMedia(opts = {}) {
        return this.request("/api/media/dedupe", {
            method: "POST",
            headers: this.headers(true),
            body: JSON.stringify({ dry_run: !!opts.dry_run }),
        });
    },

    /**
     * Force H.264/AAC re-encode on server and replace library file in place.
     * Long-running for large videos (no client timeout set; browser may still limit).
     */
    reencodeMedia(mediaId) {
        return this.request(`/api/media/${Number(mediaId)}/reencode`, {
            method: "POST",
            headers: this.headers(false),
        });
    },

    /** Enqueue jasna demosaic for one media item. */
    enqueueJasna(mediaId, { force = false } = {}) {
        const q = force ? "?force=1" : "";
        return this.request(`/api/media/${mediaId}/jasna${q}`, {
            method: "POST",
            headers: this.headers(false),
        });
    },

    /** Batch enqueue jasna for selected media ids (video/m3u8 only). */
    batchEnqueueJasna(ids, { force = false } = {}) {
        return this.request("/api/media/jasna-batch", {
            method: "POST",
            headers: this.headers(true),
            body: JSON.stringify({
                ids: (ids || []).slice(0, 200).map(Number).filter((n) => n > 0),
                force: !!force,
            }),
        });
    },

    batchTags(ids, tags, mode = "merge") {
        return this.request("/api/media/tags/batch", {
            method: "POST",
            headers: this.headers(true),
            body: JSON.stringify({
                ids: (ids || []).slice(0, 200),
                tags: this.normalizeTags(tags),
                mode: mode === "replace" ? "replace" : "merge",
            }),
        });
    },

    setMediaTags(id, tags) {
        return this.request(`/api/media/${id}/tags`, {
            method: "POST",
            headers: this.headers(true),
            body: JSON.stringify({ tags: this.normalizeTags(tags) }),
        });
    },

    patchMedia(id, body = {}) {
        const payload = {};
        if (body.title != null) payload.title = body.title;
        if (body.tags != null) payload.tags = this.normalizeTags(body.tags);
        if (body.restricted != null) payload.restricted = !!body.restricted;
        return this.request(`/api/media/${id}`, {
            method: "PATCH",
            headers: this.headers(true),
            body: JSON.stringify(payload),
        });
    },

    toggleLike(id) {
        return this.request(`/api/media/${id}/like`, {
            method: "POST",
            headers: this.headers(false),
        });
    },

    suggestTagsRemote(body = {}) {
        return this.request("/api/tags/suggest", {
            method: "POST",
            headers: this.headers(true),
            body: JSON.stringify({
                title: body.title || "",
                url: body.url || "",
                media_type: body.media_type || "",
                source_page: body.source_page || "",
                query: body.query || "",
                limit: body.limit || 12,
            }),
        });
    },

    /**
     * Fetch media/thumb/file with auth headers as blob URL.
     * Cache key is the absolute URL (include ?v= from API after jasna replace).
     * Use force:true or invalidateBlobCacheForMedia after re-encode.
     */
    _blobCache: new Map(),
    async fetchAuthedBlobUrl(pathOrUrl, options = {}) {
        const url = this.absUrl(pathOrUrl);
        if (!url) return "";
        if (!options.force && this._blobCache.has(url)) {
            return this._blobCache.get(url);
        }
        let res;
        try {
            res = await fetch(url, {
                headers: this.headers(false),
                signal: options.signal,
                cache: "no-store",
            });
        } catch (netErr) {
            // Fallback: token query URL (same as native media) then fetch without custom headers
            const tokUrl = this.mediaUrlWithToken(pathOrUrl);
            try {
                res = await fetch(tokUrl, {
                    signal: options.signal,
                    cache: "no-store",
                    credentials: "omit",
                });
            } catch (e2) {
                throw new Error(
                    `fetch failed ${url}: ${(netErr && netErr.message) || netErr}` +
                        (e2 && e2.message ? ` | token-url: ${e2.message}` : "")
                );
            }
        }
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(
                `${res.status} ${text || res.statusText || ""}`.trim().slice(0, 200)
            );
        }
        const blob = await res.blob();
        if (!blob || blob.size < 1) throw new Error("empty media body");
        const obj = URL.createObjectURL(blob);
        const prev = this._blobCache.get(url);
        if (prev) URL.revokeObjectURL(prev);
        this._blobCache.set(url, obj);
        return obj;
    },

    /** Drop cached blobs for one media id (file + thumb, any ?v=). */
    invalidateBlobCacheForMedia(mediaId) {
        const id = String(mediaId);
        const keys = [];
        for (const k of this._blobCache.keys()) {
            if (
                k.includes(`/api/media/${id}/file`) ||
                k.includes(`/api/media/${id}/thumb`)
            ) {
                keys.push(k);
            }
        }
        for (const k of keys) {
            try {
                URL.revokeObjectURL(this._blobCache.get(k));
            } catch (e) { /* ignore */ }
            this._blobCache.delete(k);
        }
    },

    revokeAllBlobUrls() {
        for (const u of this._blobCache.values()) {
            try {
                URL.revokeObjectURL(u);
            } catch (e) { /* ignore */ }
        }
        this._blobCache.clear();
    },

    /**
     * Modal: media detail + tags (unlimited count).
     * - 标签库（服务端聚合）+ 规则/远程建议
     * - 输入时前缀/包含/编辑距离联想；近重复软纠正
     * opts: { title, url, media_type, source_page, count, tags, suggest, prefillSuggest }
     */
    openIngestDialog(opts = {}) {
        const self = this;
        return new Promise((resolve) => {
            const title = opts.title || "媒体";
            const url = opts.url || "";
            const mtype = opts.media_type || "";
            const sourcePage = opts.source_page || "";
            const count = opts.count || 1;
            let libraryTags = [];
            let librarySize = 0;
            let suggestions = self.normalizeTags([
                ...self.suggestTags({
                    title,
                    url,
                    media_type: mtype,
                    source_page: sourcePage,
                }),
                ...(opts.suggest || []),
            ]);
            let tags = self.normalizeTags(opts.tags || []);
            if (!tags.length && opts.prefillSuggest) {
                tags = suggestions.slice(0, 2);
            }
            /** autocomplete state */
            let acItems = [];
            let acIndex = -1;

            function escapeHtml(s) {
                return String(s)
                    .replace(/&/g, "&amp;")
                    .replace(/</g, "&lt;")
                    .replace(/>/g, "&gt;")
                    .replace(/"/g, "&quot;");
            }

            const old = document.getElementById("lmw-ingest-dlg-root");
            if (old) old.remove();

            const root = document.createElement("div");
            root.id = "lmw-ingest-dlg-root";
            root.innerHTML = `
<style>
#lmw-ingest-dlg-root{position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);font-family:"Segoe UI","Microsoft YaHei",sans-serif;pointer-events:auto}
#lmw-ingest-dlg-root *{pointer-events:auto;box-sizing:border-box}
#lmw-ingest-dlg-root .card{background:#1e1e28;color:#f0f0f5;border-radius:14px;padding:16px 18px;width:min(440px,94vw);max-height:90vh;overflow:auto;box-shadow:0 12px 40px rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.08)}
#lmw-ingest-dlg-root h3{margin:0 0 8px;font-size:16px}
#lmw-ingest-dlg-root .meta{font-size:12px;opacity:.8;word-break:break-all;line-height:1.4;margin-bottom:10px}
#lmw-ingest-dlg-root .row{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}
#lmw-ingest-dlg-root .chip{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:999px;background:rgba(90,130,255,.35);font-size:12px;cursor:default;border:1px solid rgba(120,160,255,.35);user-select:none}
#lmw-ingest-dlg-root .chip .rm{border:0;background:transparent;color:inherit;cursor:pointer;font-size:14px;line-height:1;padding:0 0 0 4px}
#lmw-ingest-dlg-root .sug{appearance:none;display:inline-flex;align-items:center;padding:5px 12px;border-radius:999px;background:rgba(255,255,255,.1);color:#e8eefc;font-size:12px;cursor:pointer;border:1px solid rgba(255,255,255,.18);user-select:none}
#lmw-ingest-dlg-root .sug:hover{border-color:rgba(120,160,255,.7);background:rgba(90,130,255,.28)}
#lmw-ingest-dlg-root .sug.on{background:rgba(90,130,255,.4);border-color:rgba(120,160,255,.8)}
#lmw-ingest-dlg-root .sug .cnt{opacity:.55;font-size:10px;margin-left:4px}
#lmw-ingest-dlg-root .input-wrap{position:relative;margin-top:6px}
#lmw-ingest-dlg-root input[type=text]{width:100%;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.15);background:#12121a;color:#fff}
#lmw-ingest-dlg-root .ac{position:absolute;left:0;right:0;top:100%;margin:2px 0 0;padding:4px 0;max-height:180px;overflow:auto;background:#16161f;border:1px solid rgba(255,255,255,.14);border-radius:8px;z-index:5;box-shadow:0 8px 24px rgba(0,0,0,.4);display:none}
#lmw-ingest-dlg-root .ac.show{display:block}
#lmw-ingest-dlg-root .ac-item{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 12px;font-size:13px;cursor:pointer;color:#e8eefc}
#lmw-ingest-dlg-root .ac-item:hover,#lmw-ingest-dlg-root .ac-item.active{background:rgba(90,130,255,.28)}
#lmw-ingest-dlg-root .ac-item .ac-cnt{font-size:11px;opacity:.55}
#lmw-ingest-dlg-root .actions{display:flex;gap:8px;justify-content:flex-end;margin-top:14px;flex-wrap:wrap}
#lmw-ingest-dlg-root .actions button{border:0;border-radius:8px;padding:8px 14px;cursor:pointer;font-weight:600}
#lmw-ingest-dlg-root .btn-ok{background:#3b82f6;color:#fff}
#lmw-ingest-dlg-root .btn-skip{background:rgba(255,255,255,.12);color:#fff}
#lmw-ingest-dlg-root .btn-cancel{background:transparent;color:#aaa}
#lmw-ingest-dlg-root .hint{font-size:11px;opacity:.75;margin-top:6px}
#lmw-ingest-dlg-root .lib-hint{font-size:11px;opacity:.65;margin-top:2px}
#lmw-ingest-dlg-root .err{font-size:11px;color:#f88;min-height:16px;margin-top:4px}
#lmw-ingest-dlg-root .soft{font-size:11px;color:#9cf;min-height:0;margin-top:4px}
#lmw-ingest-dlg-root .jasna-row{display:flex;align-items:flex-start;gap:8px;margin:10px 0 0;padding:10px 12px;border-radius:10px;background:rgba(90,130,255,.12);border:1px solid rgba(120,160,255,.25);font-size:13px;line-height:1.35;cursor:pointer;user-select:none}
#lmw-ingest-dlg-root .jasna-row.restricted{background:rgba(244,114,182,.1);border-color:rgba(244,114,182,.35)}
#lmw-ingest-dlg-root .jasna-row input{margin-top:2px;flex-shrink:0;accent-color:#3b82f6}
#lmw-ingest-dlg-root .jasna-row.restricted input{accent-color:#ec4899}
#lmw-ingest-dlg-root .jasna-row .sub{display:block;font-size:11px;opacity:.7;margin-top:2px}
#lmw-ingest-dlg-root .opt-stack{display:flex;flex-direction:column;gap:6px;margin:12px 0 4px}
</style>
<div class="card" role="dialog" aria-modal="true">
  <h3>${count > 1 ? `入库 ${count} 项媒体` : "入库详情"}</h3>
  <div class="meta">
    <div><b>标题</b> ${escapeHtml(String(title).slice(0, 120))}</div>
    <div><b>类型</b> ${escapeHtml(mtype || "—")}${count > 1 ? " · 将共用标签" : ""}</div>
    <div><b>地址</b> ${escapeHtml(String(url).slice(0, 160))}</div>
  </div>
  <div class="opt-stack">
  <label class="jasna-row restricted" title="入库后打上「限制级」标签；Feed 默认不展示，需在前端设置开启">
    <input type="checkbox" id="lmwDlgRestricted" />
    <span>限制级
      <span class="sub">打上「限制级」标签；浏览端默认隐藏，可在设置中开启</span>
    </span>
  </label>
  <label class="jasna-row" title="提交本机 JasnaBridge 去码后再入库（需中间件 8791 运行）">
    <input type="checkbox" id="lmwDlgUseJasna" />
    <span>使用 jasna 去马赛克
      <span class="sub">本机 JasnaBridge 串行去码，不占用 LMW 服务端</span>
    </span>
  </label>
  </div>
  <div><b>已选标签</b>（点 × 移除）</div>
  <div class="row" id="lmwTagChips"></div>
  <div class="hint">建议标签（规则 + 标签库匹配 · 点击添加）</div>
  <div class="row" id="lmwTagSug"></div>
  <div class="lib-hint" id="lmwLibHint">标签库加载中…</div>
  <div class="hint">输入时自动联想库内标签 · ↑↓ 选择 · Enter/Tab 确认 · 逗号分隔多项</div>
  <div class="input-wrap">
    <input type="text" id="lmwTagInput" placeholder="例如: anime, 1080p" maxlength="64" autocomplete="off" spellcheck="false" />
    <div class="ac" id="lmwTagAc" role="listbox"></div>
  </div>
  <div class="soft" id="lmwTagSoft"></div>
  <div class="err" id="lmwTagErr"></div>
  <div class="actions">
    <button type="button" class="btn-cancel" id="lmwDlgCancel">取消</button>
    <button type="button" class="btn-skip" id="lmwDlgSkip">不打标签入库</button>
    <button type="button" class="btn-ok" id="lmwDlgOk">确认入库</button>
  </div>
</div>`;
            document.documentElement.appendChild(root);

            const card = root.querySelector(".card");
            const chipsEl = root.querySelector("#lmwTagChips");
            const sugEl = root.querySelector("#lmwTagSug");
            const input = root.querySelector("#lmwTagInput");
            const acEl = root.querySelector("#lmwTagAc");
            const errEl = root.querySelector("#lmwTagErr");
            const softEl = root.querySelector("#lmwTagSoft");
            const libHint = root.querySelector("#lmwLibHint");
            const countMap = () => {
                const m = new Map();
                for (const row of libraryTags) {
                    m.set(self.canonicalTag(row.name), Number(row.count) || 0);
                }
                return m;
            };

            function setErr(msg) {
                errEl.textContent = msg || "";
            }
            function setSoft(msg) {
                softEl.textContent = msg || "";
            }

            function hideAc() {
                acItems = [];
                acIndex = -1;
                acEl.classList.remove("show");
                acEl.innerHTML = "";
            }

            function renderAc() {
                if (!acItems.length) {
                    hideAc();
                    return;
                }
                acEl.innerHTML = acItems
                    .map((it, i) => {
                        const active = i === acIndex ? " active" : "";
                        const cnt =
                            it.count > 0
                                ? `<span class="ac-cnt">×${it.count}</span>`
                                : "";
                        return `<div class="ac-item${active}" data-ac="${i}" role="option">#${escapeHtml(it.name)}${cnt}</div>`;
                    })
                    .join("");
                acEl.classList.add("show");
            }

            function updateAcFromInput() {
                const raw = input.value.trim();
                // only last segment when comma-typing
                const parts = raw.split(/[,，;；]/);
                const q = (parts[parts.length - 1] || "").trim().replace(/^#/, "");
                if (!q || q.length < 1) {
                    hideAc();
                    setSoft("");
                    return;
                }
                acItems = self.matchTags(q, libraryTags, {
                    limit: 8,
                    exclude: tags,
                });
                acIndex = acItems.length ? 0 : -1;
                renderAc();
                // soft hint for near-duplicate of current query
                const nd = self.nearDuplicateTag(q, libraryTags, { minCount: 2 });
                if (nd && nd !== self.canonicalTag(q) && !tags.includes(nd)) {
                    const c = countMap().get(nd) || 0;
                    setSoft(`库中相似：#${nd}${c ? `（${c} 次）` : ""} · Tab/↑↓ 选用`);
                } else {
                    setSoft("");
                }
            }

            function applyAcSelection(idx) {
                if (idx < 0 || idx >= acItems.length) return false;
                const name = acItems[idx].name;
                const raw = input.value;
                const seps = /[,，;；]/;
                if (seps.test(raw)) {
                    const parts = raw.split(seps);
                    parts[parts.length - 1] = "";
                    const head = parts
                        .map((s) => s.trim())
                        .filter(Boolean);
                    for (const p of head) addTag(p, { softCorrect: true });
                    addTag(name, { softCorrect: false });
                } else {
                    addTag(name, { softCorrect: false });
                }
                input.value = "";
                hideAc();
                setSoft("");
                render();
                return true;
            }

            function render() {
                const cmap = countMap();
                chipsEl.innerHTML = tags.length
                    ? tags
                          .map((t, i) => {
                              const c = cmap.get(t);
                              const badge =
                                  c > 0
                                      ? `<span style="opacity:.55;font-size:10px">×${c}</span>`
                                      : "";
                              return `<span class="chip">#${escapeHtml(t)}${badge}<button type="button" class="rm" data-rm="${i}" aria-label="移除">×</button></span>`;
                          })
                          .join("")
                    : `<span style="opacity:.5;font-size:12px">暂无，请点击下方建议或输入</span>`;

                sugEl.innerHTML = suggestions.length
                    ? suggestions
                          .map((s) => {
                              const on = tags.includes(s);
                              const c = cmap.get(s);
                              const cnt =
                                  c > 0 ? `<span class="cnt">×${c}</span>` : "";
                              return `<button type="button" class="sug${on ? " on" : ""}" data-tag="${escapeHtml(s)}">${on ? "✓ " : "+ "}#${escapeHtml(s)}${cnt}</button>`;
                          })
                          .join("")
                    : `<span style="opacity:.5;font-size:12px">无自动建议</span>`;

                input.placeholder = tags.length
                    ? `已选 ${tags.length} 个 · 继续输入联想`
                    : "输入标签，从库中联想…";
            }

            /**
             * @param {string} raw
             * @param {{softCorrect?: boolean}} options
             */
            function addTag(raw, options = {}) {
                const softCorrect = options.softCorrect !== false;
                let next = self.normalizeTags([raw]);
                if (!next.length) {
                    setErr("无效标签");
                    return false;
                }
                let t = next[0];
                if (softCorrect) {
                    const nd = self.nearDuplicateTag(t, libraryTags, {
                        minCount: 2,
                    });
                    if (nd && nd !== t) {
                        setSoft(`已将 #${t} 规范为库内 #${nd}`);
                        t = nd;
                    }
                }
                if (tags.includes(t)) {
                    setErr(`已包含 #${t}`);
                    return false;
                }
                tags = self.normalizeTags([...tags, t]);
                setErr("");
                render();
                return true;
            }

            function removeTag(index) {
                if (index < 0 || index >= tags.length) return;
                tags.splice(index, 1);
                setErr("");
                render();
            }

            function toggleTag(t) {
                const name = self.canonicalTag(t);
                const i = tags.indexOf(name);
                if (i >= 0) {
                    removeTag(i);
                    return;
                }
                addTag(name, { softCorrect: false });
            }

            card.addEventListener("click", (e) => {
                e.stopPropagation();
                const acHit = e.target.closest("[data-ac]");
                if (acHit) {
                    e.preventDefault();
                    applyAcSelection(Number(acHit.getAttribute("data-ac")));
                    return;
                }
                const rm = e.target.closest("[data-rm]");
                if (rm) {
                    e.preventDefault();
                    removeTag(Number(rm.getAttribute("data-rm")));
                    return;
                }
                const sug = e.target.closest("[data-tag]");
                if (sug && !sug.disabled) {
                    e.preventDefault();
                    toggleTag(sug.getAttribute("data-tag") || "");
                }
            });

            input.addEventListener("input", () => updateAcFromInput());
            input.addEventListener("keydown", (e) => {
                if (acItems.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                    e.preventDefault();
                    if (e.key === "ArrowDown") {
                        acIndex = (acIndex + 1) % acItems.length;
                    } else {
                        acIndex =
                            acIndex <= 0 ? acItems.length - 1 : acIndex - 1;
                    }
                    renderAc();
                    return;
                }
                if (e.key === "Tab" && acItems.length && acIndex >= 0) {
                    e.preventDefault();
                    applyAcSelection(acIndex);
                    return;
                }
                if (e.key === "Escape" && acItems.length) {
                    e.preventDefault();
                    hideAc();
                    return;
                }
                if (e.key === "Enter") {
                    e.preventDefault();
                    e.stopPropagation();
                    if (acItems.length && acIndex >= 0) {
                        applyAcSelection(acIndex);
                        return;
                    }
                    const v = input.value.trim();
                    if (!v) return;
                    const parts = v
                        .split(/[,，;；]+/)
                        .map((s) => s.trim())
                        .filter(Boolean);
                    for (const p of parts) {
                        if (!addTag(p, { softCorrect: true })) break;
                    }
                    input.value = "";
                    hideAc();
                    render();
                }
            });

            const restrictedCb = root.querySelector("#lmwDlgRestricted");
            const jasnaCb = root.querySelector("#lmwDlgUseJasna");
            if (restrictedCb) {
                try {
                    restrictedCb.checked = !!(
                        typeof G !== "undefined" && G.lmwRestricted === true
                    );
                } catch (e) {
                    restrictedCb.checked = false;
                }
            }
            if (jasnaCb) {
                try {
                    jasnaCb.checked = !!(
                        typeof G !== "undefined" && G.lmwUseJasna === true
                    );
                } catch (e) {
                    jasnaCb.checked = false;
                }
            }
            function readRestricted() {
                return !!(restrictedCb && restrictedCb.checked);
            }
            function readUseJasna() {
                return !!(jasnaCb && jasnaCb.checked);
            }
            function persistRestricted(on) {
                try {
                    if (typeof G !== "undefined") G.lmwRestricted = on;
                    chrome.storage.sync.set({ lmwRestricted: on });
                    chrome.storage.local.set({ lmwRestricted: on });
                } catch (e) { /* ignore */ }
            }
            function persistUseJasna(on) {
                try {
                    if (typeof G !== "undefined") G.lmwUseJasna = on;
                    chrome.storage.sync.set({ lmwUseJasna: on });
                    chrome.storage.local.set({ lmwUseJasna: on });
                } catch (e) { /* ignore */ }
            }
            if (restrictedCb) {
                restrictedCb.addEventListener("change", () => {
                    persistRestricted(!!restrictedCb.checked);
                });
            }
            if (jasnaCb) {
                jasnaCb.addEventListener("change", () => {
                    persistUseJasna(!!jasnaCb.checked);
                });
            }

            function finish(result) {
                root.remove();
                // 入库后标签库可能变化，下次强制刷新
                if (result && result.ok) self.invalidateTagLibrary();
                resolve(result);
            }
            root.querySelector("#lmwDlgCancel").onclick = (e) => {
                e.stopPropagation();
                finish({
                    ok: false,
                    cancelled: true,
                    tags: [],
                    use_jasna: false,
                    restricted: false,
                });
            };
            root.querySelector("#lmwDlgSkip").onclick = (e) => {
                e.stopPropagation();
                const rs = readRestricted();
                const uj = readUseJasna();
                persistRestricted(rs);
                persistUseJasna(uj);
                finish({ ok: true, tags: [], use_jasna: uj, restricted: rs });
            };
            root.querySelector("#lmwDlgOk").onclick = (e) => {
                e.stopPropagation();
                const leftover = input.value.trim();
                if (leftover) {
                    leftover.split(/[,，;；]+/).forEach((p) => {
                        if (p.trim()) addTag(p.trim(), { softCorrect: true });
                    });
                    input.value = "";
                }
                // final soft-correct pass for any remaining near-dupes
                tags = tags.map((t) => {
                    const nd = self.nearDuplicateTag(t, libraryTags, {
                        minCount: 2,
                    });
                    return nd || t;
                });
                tags = self.normalizeTags(tags);
                const rs = readRestricted();
                const uj = readUseJasna();
                persistRestricted(rs);
                persistUseJasna(uj);
                finish({ ok: true, tags, use_jasna: uj, restricted: rs });
            };
            root.addEventListener("click", (e) => {
                if (e.target === root)
                    finish({
                        ok: false,
                        cancelled: true,
                        tags: [],
                        use_jasna: false,
                        restricted: false,
                    });
            });
            render();
            setTimeout(() => input.focus(), 50);

            // Async: load tag library + remote suggest, then re-merge
            (async () => {
                try {
                    const [lib, remoteRes] = await Promise.all([
                        self.getTagLibrary().catch(() => ({ tags: [], total: 0 })),
                        self
                            .suggestTagsRemote({
                                title,
                                url,
                                media_type: mtype,
                                source_page: sourcePage,
                                limit: 14,
                            })
                            .catch(() => null),
                    ]);
                    libraryTags = lib.tags || [];
                    librarySize = lib.total || libraryTags.length;
                    const remoteTags = remoteRes && remoteRes.tags ? remoteRes.tags : [];
                    suggestions = self.mergeTagSuggestions({
                        title,
                        url,
                        media_type: mtype,
                        source_page: sourcePage,
                        local: self.suggestTags({
                            title,
                            url,
                            media_type: mtype,
                            source_page: sourcePage,
                        }),
                        remote: remoteTags,
                        libraryTags,
                        limit: 14,
                    });
                    if (opts.suggest && opts.suggest.length) {
                        suggestions = self.normalizeTags([
                            ...opts.suggest,
                            ...suggestions,
                        ]).slice(0, 16);
                    }
                    if (libHint) {
                        libHint.textContent = librarySize
                            ? `标签库 ${librarySize} 个（按媒体频次聚合）· 输入时自动匹配`
                            : "标签库为空或服务端不可达 · 仍可手动输入 / 使用离线建议";
                    }
                    render();
                    if (input.value.trim()) updateAcFromInput();
                } catch (err) {
                    if (libHint) {
                        libHint.textContent =
                            "标签库加载失败 · 使用离线建议";
                    }
                }
            })();
        });
    },

    /**
     * Normalize raw tag text and soft-correct near-duplicates against library.
     * @returns {Promise<string[]>}
     */
    async softNormalizeTags(raw, { minCount = 2, libraryTags = null } = {}) {
        const lib =
            libraryTags ||
            (await this.getTagLibrary().catch(() => ({ tags: [] }))).tags ||
            [];
        const tags = this.normalizeTags(raw);
        return this.normalizeTags(
            tags.map((t) => this.nearDuplicateTag(t, lib, { minCount }) || t)
        );
    },

    /**
     * Attach tag-library autocomplete to a plain text input (comma-separated).
     * Shared by ingest dialog patterns, manage page batch/upload/edit fields.
     *
     * @param {HTMLInputElement|string} inputEl
     * @param {{ onHint?: (msg:string)=>void, softCorrectEnter?: boolean }} [options]
     * @returns {{ destroy:()=>void, refresh:()=>Promise<void>, commit:()=>Promise<string[]> }}
     */
    attachTagAutocomplete(inputEl, options = {}) {
        const self = this;
        const input =
            typeof inputEl === "string" ? document.getElementById(inputEl) : inputEl;
        if (!input || input.nodeType !== 1) {
            return {
                destroy() {},
                async refresh() {},
                async commit() {
                    return self.normalizeTags(
                        typeof inputEl === "string" ? "" : ""
                    );
                },
            };
        }

        // Inject shared styles once
        if (!document.getElementById("lmw-tag-ac-styles")) {
            const st = document.createElement("style");
            st.id = "lmw-tag-ac-styles";
            st.textContent = `
.lmw-tag-ac-wrap{position:relative;display:inline-block;vertical-align:middle}
.lmw-tag-ac-wrap.lmw-tag-ac-block{display:block;width:100%}
.lmw-tag-ac-wrap .lmw-tag-ac-input{width:100%}
.lmw-tag-ac{position:absolute;left:0;right:0;top:100%;margin:2px 0 0;padding:4px 0;max-height:200px;overflow:auto;background:#16161f;border:1px solid rgba(255,255,255,.16);border-radius:8px;z-index:10050;box-shadow:0 8px 24px rgba(0,0,0,.45);display:none;font-family:"Segoe UI","Microsoft YaHei",sans-serif}
.lmw-tag-ac.show{display:block}
.lmw-tag-ac-item{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 12px;font-size:13px;cursor:pointer;color:#e8eefc}
.lmw-tag-ac-item:hover,.lmw-tag-ac-item.active{background:rgba(90,130,255,.28)}
.lmw-tag-ac-item .lmw-tag-ac-cnt{font-size:11px;opacity:.55}
.lmw-tag-ac-hint{font-size:11px;color:#9cf;margin-top:2px;min-height:0;line-height:1.3}
`;
            document.documentElement.appendChild(st);
        }

        // Wrap input if needed
        let wrap = input.closest(".lmw-tag-ac-wrap");
        if (!wrap) {
            wrap = document.createElement("span");
            wrap.className = "lmw-tag-ac-wrap";
            // block layout if input is full-width field
            if (
                input.classList.contains("mm-input") &&
                input.parentElement &&
                input.parentElement.classList.contains("mm-field")
            ) {
                wrap.classList.add("lmw-tag-ac-block");
            }
            input.parentNode.insertBefore(wrap, input);
            wrap.appendChild(input);
            input.classList.add("lmw-tag-ac-input");
        }

        let acEl = wrap.querySelector(".lmw-tag-ac");
        if (!acEl) {
            acEl = document.createElement("div");
            acEl.className = "lmw-tag-ac";
            acEl.setAttribute("role", "listbox");
            wrap.appendChild(acEl);
        }

        let hintEl = wrap.querySelector(".lmw-tag-ac-hint");
        if (!hintEl && options.showHint !== false) {
            hintEl = document.createElement("div");
            hintEl.className = "lmw-tag-ac-hint";
            wrap.appendChild(hintEl);
        }

        let libraryTags = [];
        let acItems = [];
        let acIndex = -1;
        let destroyed = false;

        const escapeHtml = (s) =>
            String(s)
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;");

        const setHint = (msg) => {
            if (hintEl) hintEl.textContent = msg || "";
            if (typeof options.onHint === "function") options.onHint(msg || "");
        };

        const hideAc = () => {
            acItems = [];
            acIndex = -1;
            acEl.classList.remove("show");
            acEl.innerHTML = "";
        };

        const currentExclude = () => {
            const raw = input.value || "";
            const parts = raw.split(/[,，;；]/).map((s) => s.trim()).filter(Boolean);
            // exclude all but last segment (being typed)
            return self.normalizeTags(parts.slice(0, -1));
        };

        const lastSegment = () => {
            const raw = input.value || "";
            const parts = raw.split(/[,，;；]/);
            return (parts[parts.length - 1] || "").trim().replace(/^#/, "");
        };

        const renderAc = () => {
            if (!acItems.length) {
                hideAc();
                return;
            }
            acEl.innerHTML = acItems
                .map((it, i) => {
                    const active = i === acIndex ? " active" : "";
                    const cnt =
                        it.count > 0
                            ? `<span class="lmw-tag-ac-cnt">×${it.count}</span>`
                            : "";
                    return `<div class="lmw-tag-ac-item${active}" data-lmw-ac="${i}" role="option">#${escapeHtml(it.name)}${cnt}</div>`;
                })
                .join("");
            acEl.classList.add("show");
        };

        const updateAc = () => {
            if (destroyed) return;
            const q = lastSegment();
            if (!q) {
                hideAc();
                setHint("");
                return;
            }
            acItems = self.matchTags(q, libraryTags, {
                limit: 8,
                exclude: currentExclude(),
            });
            acIndex = acItems.length ? 0 : -1;
            renderAc();
            const nd = self.nearDuplicateTag(q, libraryTags, { minCount: 2 });
            const cq = self.canonicalTag(q);
            if (nd && nd !== cq) {
                setHint(`库中相似 #${nd} · Tab/↑↓ 选用`);
            } else if (acItems.length) {
                setHint("↑↓ 选择 · Enter/Tab 填入 · 逗号继续");
            } else {
                setHint("");
            }
        };

        const replaceLastSegment = (name) => {
            const raw = input.value || "";
            const seps = /[,，;；]/;
            if (!seps.test(raw)) {
                input.value = name;
                return;
            }
            const parts = raw.split(seps);
            parts[parts.length - 1] = " " + name;
            // normalize: keep previous segments, last becomes selected tag + trailing ", "
            const head = parts
                .slice(0, -1)
                .map((s) => s.trim())
                .filter(Boolean);
            input.value = head.length ? head.join(", ") + ", " + name : name;
        };

        const applyAc = (idx) => {
            if (idx < 0 || idx >= acItems.length) return false;
            replaceLastSegment(acItems[idx].name);
            // leave trailing comma for multi-entry convenience
            if (!input.value.endsWith(", ") && !input.value.endsWith(",")) {
                input.value = input.value + ", ";
            }
            hideAc();
            setHint("");
            // move caret to end
            try {
                const len = input.value.length;
                input.setSelectionRange(len, len);
            } catch (_) { /* ignore */ }
            return true;
        };

        const onInput = () => updateAc();
        const onKeydown = (e) => {
            if (acItems.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                e.preventDefault();
                if (e.key === "ArrowDown") {
                    acIndex = (acIndex + 1) % acItems.length;
                } else {
                    acIndex = acIndex <= 0 ? acItems.length - 1 : acIndex - 1;
                }
                renderAc();
                return;
            }
            if ((e.key === "Tab" || e.key === "Enter") && acItems.length && acIndex >= 0) {
                // Enter: if ac open, pick; else let form handlers work unless softCorrect
                if (e.key === "Tab" || options.captureEnter !== false) {
                    e.preventDefault();
                    applyAc(acIndex);
                    return;
                }
            }
            if (e.key === "Escape" && acItems.length) {
                e.preventDefault();
                hideAc();
            }
        };
        const onAcClick = (e) => {
            const hit = e.target.closest("[data-lmw-ac]");
            if (!hit) return;
            e.preventDefault();
            e.stopPropagation();
            applyAc(Number(hit.getAttribute("data-lmw-ac")));
            input.focus();
        };
        const onBlur = () => {
            // delay so click on ac item can fire
            setTimeout(() => {
                if (destroyed) return;
                if (!wrap.contains(document.activeElement)) hideAc();
            }, 150);
        };

        input.addEventListener("input", onInput);
        input.addEventListener("keydown", onKeydown);
        input.addEventListener("focus", onInput);
        input.addEventListener("blur", onBlur);
        acEl.addEventListener("mousedown", onAcClick);

        const refresh = async () => {
            const lib = await self.getTagLibrary().catch(() => ({ tags: [] }));
            libraryTags = lib.tags || [];
            if (document.activeElement === input) updateAc();
        };
        refresh();

        return {
            destroy() {
                destroyed = true;
                input.removeEventListener("input", onInput);
                input.removeEventListener("keydown", onKeydown);
                input.removeEventListener("focus", onInput);
                input.removeEventListener("blur", onBlur);
                acEl.removeEventListener("mousedown", onAcClick);
                hideAc();
            },
            refresh,
            async commit() {
                return self.softNormalizeTags(input.value, {
                    libraryTags,
                });
            },
            getLibrary() {
                return libraryTags;
            },
        };
    },

    /**
     * Build request headers for server-side download from cat-catch resource data.
     */
    async buildHeadersForItem(data, pageUrl) {
        const headers = {};
        const src = data.requestHeaders || data.allRequestHeaders || data.header || {};
        if (src && typeof src === "object") {
            for (const [k, v] of Object.entries(src)) {
                if (v == null || v === "") continue;
                // requestHeaders may be array of {name,value} in some paths
                if (typeof v === "object" && v.value != null) {
                    headers[v.name || k] = String(v.value);
                } else {
                    headers[k] = String(v);
                }
            }
        }
        // Normalize common keys
        const referer = data.referer || headers.Referer || headers.referer || pageUrl || "";
        if (referer && !headers.Referer && !headers.referer) headers.Referer = referer;
        if (!headers["User-Agent"] && !headers["user-agent"] && typeof navigator !== "undefined") {
            headers["User-Agent"] = navigator.userAgent;
        }
        // Cookie fill via extension API
        const url = data.url || data.uri;
        if (url && typeof chrome !== "undefined" && chrome.cookies && chrome.cookies.getAll) {
            try {
                const cookies = await chrome.cookies.getAll({ url });
                if (cookies && cookies.length) {
                    const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
                    if (!headers.Cookie && !headers.cookie) headers.Cookie = cookieStr;
                }
            } catch (e) {
                console.debug("LMW cookie get failed", e);
            }
        }
        return headers;
    },

    normalizeMediaType(data) {
        const url = (data.url || "").toLowerCase();
        const type = (data.type || data.mime || data.contentType || "").toLowerCase();
        const declared = (data.media_type || "").toLowerCase();
        // Steam 预告片等 DASH — 不可走 HLS 解析
        if (
            /\.mpd(\?|#|$)/i.test(url) ||
            type.includes("dash+xml") ||
            declared === "dash" ||
            /\/dash_[^/?#]+\.mpd/i.test(url)
        ) {
            return "dash";
        }
        if (
            url.includes(".m3u8") ||
            type.includes("mpegurl") ||
            data.parsing === "m3u8" ||
            declared === "m3u8"
        ) {
            return "m3u8";
        }
        // 解析器已标明 gif（含 animated webp / 循环短视频当动图）
        if (declared === "gif" || type.includes("gif") || /\.gif(\?|#|$)/i.test(url)) return "gif";
        if (declared === "image" || type.startsWith("image/") || /\.(png|jpe?g|webp|avif|bmp)(\?|$)/i.test(url)) {
            return "image";
        }
        // Prefer Content-Type / declared type over extension (audio may use .mp4/.bin disguise)
        if (declared === "audio" || type.startsWith("audio/")) {
            return "audio";
        }
        // Extension hints for common audio containers (not sole truth when CT present)
        if (
            /\.(mp3|m4a|aac|flac|wav|ogg|opus|wma|oga)(\?|#|$)/i.test(url) &&
            !type.startsWith("video/")
        ) {
            return "audio";
        }
        if (declared === "video" || type.startsWith("video/") || /\.(mp4|webm|mkv|mov|m4v)(\?|$)/i.test(url)) {
            return "video";
        }
        if (data.isPlay) return "video";
        return "video";
    },

    /**
     * Merge separate progressive video + audio blobs into one library video.
     */
    async uploadAvBlobs(videoBlob, audioBlob, meta = {}) {
        const fd = new FormData();
        fd.append("category", meta.category || "default");
        fd.append("title", meta.title || "");
        fd.append("source_url", meta.source_url || meta.url || "");
        const restricted = !!(
            meta.restricted === true ||
            meta.restricted === 1 ||
            meta.restricted === "1"
        );
        const tags = this.applyRestrictedTag(meta.tags || [], restricted);
        if (tags.length) fd.append("tags", JSON.stringify(tags));
        if (restricted) fd.append("restricted", "1");
        const base = (meta.filename || meta.title || "merge").replace(/\.[^.]+$/, "");
        fd.append("video", videoBlob, `${base}_video.mp4`);
        if (audioBlob && audioBlob.size > 32) {
            fd.append("audio", audioBlob, `${base}_audio.m4a`);
        }
        const headers = this.headers(false);
        delete headers["Content-Type"];
        const res = await fetch(this.baseUrl() + "/api/upload-av", {
            method: "POST",
            headers,
            body: fd,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`${text || res.statusText}`);
        }
        return res.json();
    },

    async itemToIngest(data, pageUrl, tags) {
        const headers = await this.buildHeadersForItem(data, pageUrl);
        const row = {
            url: data.url,
            media_type: this.normalizeMediaType(data),
            title: data.title || data.downFileName || data.name || "",
            referer: headers.Referer || pageUrl || "",
            source_page: pageUrl || "",
            headers,
            tags: this.normalizeTags(tags || data.tags || []),
        };
        // m3u8 clip range (seconds); from range dialog on select
        if (data._startSec != null && data._startSec !== "" && !Number.isNaN(+data._startSec)) {
            row.start_sec = Math.max(0, +data._startSec);
        }
        if (data._endSec != null && data._endSec !== "" && !Number.isNaN(+data._endSec) && +data._endSec > 0) {
            row.end_sec = +data._endSec;
        }
        return row;
    },

    /**
     * Poll job ids until terminal. onProgress(job, meta) — job is last polled job;
     * meta: { phase, total, done, pending, active, finished }.
     * Callers that only use the first arg stay compatible.
     */
    async waitJobs(jobIds, { timeoutMs = 600000, onProgress } = {}) {
        const ids = (jobIds || []).filter((id) => id != null);
        const pending = new Set(ids);
        const results = [];
        const lastById = new Map();
        const start = Date.now();
        const total = ids.length;

        const emit = (job, phase) => {
            if (!onProgress) return;
            const active = [...pending]
                .map((id) => lastById.get(id))
                .filter(Boolean);
            try {
                onProgress(job, {
                    phase: phase || "wait",
                    total,
                    done: results.length,
                    pending: pending.size,
                    active,
                    finished: results.slice(),
                });
            } catch (e) {
                console.warn("LMW waitJobs onProgress", e);
            }
        };

        while (pending.size && Date.now() - start < timeoutMs) {
            for (const id of [...pending]) {
                try {
                    const job = await this.getJob(id);
                    if (job && job.id == null) job.id = id;
                    lastById.set(id, job);
                    emit(job, "wait");
                    if (["queued", "running"].includes(job.status)) continue;
                    pending.delete(id);
                    results.push(job);
                    emit(job, "job_done");
                } catch (e) {
                    pending.delete(id);
                    const failed = {
                        id,
                        status: "failed_network",
                        error_message: String(e && e.message ? e.message : e),
                    };
                    lastById.set(id, failed);
                    results.push(failed);
                    emit(failed, "job_done");
                }
            }
            if (pending.size) await new Promise((r) => setTimeout(r, 800));
        }
        for (const id of pending) {
            const failed = {
                id,
                status: "failed_network",
                error_message: "timeout waiting job",
            };
            results.push(failed);
            emit(failed, "timeout");
        }
        return results;
    },

    async clientFetchAndUpload(item, category) {
        const headers = item.headers || {};
        const res = await fetch(item.url, { headers, credentials: "omit" });
        if (!res.ok) throw new Error(`client fetch HTTP ${res.status}`);
        const blob = await res.blob();
        let ext = "bin";
        const ct = res.headers.get("content-type") || "";
        if (ct.includes("png")) ext = "png";
        else if (ct.includes("jpeg")) ext = "jpg";
        else if (ct.includes("gif")) ext = "gif";
        else if (ct.includes("webp")) ext = "webp";
        else if (ct.includes("mp4")) ext = "mp4";
        else if (ct.includes("webm")) ext = "webm";
        const restricted =
            item.restricted === true ||
            (typeof G !== "undefined" && G.lmwRestricted === true);
        return this.uploadBlob(blob, {
            category,
            title: item.title || "",
            source_url: item.url,
            media_type: item.media_type || "",
            filename: `${(item.title || "media").slice(0, 40)}.${ext}`,
            tags: item.tags || [],
            restricted: !!restricted,
        });
    },

    /** Short label for progress lines (title + host). */
    _itemProgressLabel(it, index, total) {
        const n = total > 1 ? `${(index != null ? index : 0) + 1}/${total} ` : "";
        const title = String((it && (it.title || it.name)) || "media")
            .replace(/\s+/g, " ")
            .slice(0, 40);
        let host = "";
        try {
            host = it && it.url ? new URL(String(it.url)).host : "";
        } catch (_) {
            host = "";
        }
        const mt = String((it && it.media_type) || "").toLowerCase();
        const typeBit = mt ? ` · ${mt}` : "";
        const hostBit = host ? ` @${host}` : "";
        return `${n}«${title}»${typeBit}${hostBit}`;
    },

    _jobProgressLabel(job, items) {
        const title = String((job && (job.title || job.name)) || "").replace(/\s+/g, " ").slice(0, 40);
        let host = "";
        const url = (job && job.url) || "";
        try {
            if (url) host = new URL(String(url)).host;
        } catch (_) {}
        if (!title && items && items.length) {
            const hit =
                (url && items.find((it) => it && it.url === url)) ||
                null;
            if (hit) return this._itemProgressLabel(hit, items.indexOf(hit), items.length);
        }
        const idBit = job && job.id != null ? `#${job.id}` : "";
        const hostBit = host ? ` @${host}` : "";
        const titleBit = title ? ` «${title}»` : "";
        return `${idBit}${titleBit}${hostBit}`.trim() || "job";
    },

    /**
     * Ingest items; optionally fallback upload on auth/network failure.
     * onProgress(jobOrNull, meta) — meta.message is preferred for UI status bars.
     */
    async pushItems(items, category, { autoFallback, wait = true, onProgress, tags, use_jasna, restricted } = {}) {
        const cat = category || (typeof G !== "undefined" && G.lmwDefaultCategory) || "default";
        const fallback = autoFallback ?? (typeof G !== "undefined" ? G.lmwAutoFallback : true) ?? true;
        const useRestricted =
            restricted === true ||
            (typeof G !== "undefined" && G.lmwRestricted === true);
        const sharedTags = this.applyRestrictedTag(tags || [], useRestricted);
        const list = items || [];
        const total = list.length;
        if (sharedTags.length) {
            for (const it of list) {
                if (!it.tags || !it.tags.length) it.tags = sharedTags;
                else if (useRestricted) it.tags = this.applyRestrictedTag(it.tags, true);
            }
        }
        if (useRestricted) {
            for (const it of list) {
                it.restricted = true;
            }
        }

        const report = (message, extra = {}) => {
            if (!onProgress) return;
            try {
                onProgress(extra.job || null, {
                    phase: extra.phase || "info",
                    total: extra.total != null ? extra.total : total,
                    done: extra.done != null ? extra.done : 0,
                    pending: extra.pending != null ? extra.pending : 0,
                    message,
                    ...extra,
                });
            } catch (e) {
                console.warn("LMW pushItems onProgress", e);
            }
        };

        report(`提交入库 ${total} 项…`, { phase: "submit" });

        const ingestRes = await this.ingest(cat, list, sharedTags, {
            restricted: !!useRestricted,
        });
        const jobIds = ingestRes.job_ids || [];
        const dupN = (ingestRes.duplicate_media_ids || []).length;
        const accepted = ingestRes.accepted != null ? ingestRes.accepted : jobIds.length;

        if (!wait) {
            report(
                `已提交 ${jobIds.length} 个任务` +
                    (dupN ? ` · 链接重复 ${dupN}` : "") +
                    `（共 ${total} 项，后台下载）`,
                { phase: "submitted", pending: jobIds.length, job_ids: jobIds }
            );
            return {
                ...ingestRes,
                jobs: [],
                fallbackOk: 0,
                failed: 0,
                success: 0,
                pending: jobIds.length,
            };
        }

        report(
            `已提交任务 ${jobIds.length}/${total}` +
                (accepted != null && accepted !== jobIds.length ? ` · accepted ${accepted}` : "") +
                (dupN ? ` · 链接重复 ${dupN}` : "") +
                (jobIds.length ? " · 等待服务端下载…" : " · 无新任务"),
            { phase: "submitted", pending: jobIds.length }
        );

        const jobs = jobIds.length
            ? await this.waitJobs(jobIds, {
                  onProgress: (job, meta) => {
                      if (!onProgress) return;
                      const m = meta || {};
                      const st = (job && job.status) || "?";
                      const pct =
                          job && job.progress != null && job.progress !== ""
                              ? ` ${Math.round(+job.progress)}%`
                              : "";
                      const label = this._jobProgressLabel(job, list);
                      const done = m.done != null ? m.done : 0;
                      const tot = m.total != null ? m.total : jobIds.length;
                      const pend = m.pending != null ? m.pending : 0;
                      const activeN = (m.active || []).filter((j) =>
                          ["queued", "running"].includes(j && j.status)
                      ).length;
                      let message;
                      if (m.phase === "job_done") {
                          const em = String((job && job.error_message) || "").slice(0, 80);
                          message =
                              `入库任务 ${done}/${tot} 完成 · ${st}${pct} · ${label}` +
                              (em ? ` · ${em}` : "") +
                              (pend ? ` · 剩余 ${pend}` : "");
                      } else {
                          message =
                              `入库中 ${done}/${tot} 已结束` +
                              (activeN ? ` · 进行中 ${activeN}` : "") +
                              ` · ${st}${pct} · ${label}` +
                              (pend > 1 ? ` · 队列 ${pend}` : "");
                      }
                      try {
                          onProgress(job, { ...m, message, phase: m.phase || "wait" });
                      } catch (e) {
                          console.warn("LMW pushItems job onProgress", e);
                      }
                  },
              })
            : [];

        let fallbackOk = 0;
        let failed = 0;
        let contentDuplicates = 0;
        const needFallback = [];
        for (const job of jobs) {
            if (job.status === "success") {
                const em = String(job.error_message || "");
                if (em.includes("content_duplicate")) contentDuplicates++;
                continue;
            }
            const can =
                fallback &&
                job.client_fallback_allowed !== false &&
                ["failed_auth", "need_client_fetch", "failed_network", "failed_partial"].includes(
                    job.status
                );
            if (!can) {
                failed++;
                continue;
            }
            const item = list.find((it) => it.url === job.url) || list[0];
            if (!item || item.media_type === "m3u8" || item.media_type === "dash") {
                // stream client merge is heavy; server should handle HLS/DASH
                failed++;
                continue;
            }
            needFallback.push({ job, item });
        }

        for (let i = 0; i < needFallback.length; i++) {
            const { item } = needFallback[i];
            const label = this._itemProgressLabel(item, i, needFallback.length);
            report(`客户端回退上传 ${i + 1}/${needFallback.length} · ${label}`, {
                phase: "fallback",
                index: i,
                total: needFallback.length,
                done: i,
            });
            try {
                const up = await this.clientFetchAndUpload(item, cat);
                if (up && up.duplicate) contentDuplicates++;
                else fallbackOk++;
                report(
                    `客户端回退 ${i + 1}/${needFallback.length} 完成` +
                        (up && up.duplicate ? " · 内容重复" : " · 已上传") +
                        ` · ${label}`,
                    {
                        phase: "fallback_done",
                        index: i,
                        total: needFallback.length,
                        done: i + 1,
                    }
                );
            } catch (e) {
                console.warn("LMW fallback failed", e);
                failed++;
                report(
                    `客户端回退 ${i + 1}/${needFallback.length} 失败 · ${label} · ${
                        (e && e.message) || e
                    }`.slice(0, 200),
                    {
                        phase: "fallback_fail",
                        index: i,
                        total: needFallback.length,
                        done: i + 1,
                    }
                );
            }
        }

        const pureSuccess = jobs.filter(
            (j) =>
                j.status === "success" &&
                !String(j.error_message || "").includes("content_duplicate")
        ).length;
        return {
            ...ingestRes,
            jobs,
            fallbackOk,
            failed,
            contentDuplicates,
            success: pureSuccess + fallbackOk,
        };
    },

    /** Load LMW settings when G is unavailable (content-script). */
    async loadSettingsFromStorage() {
        const defaults = { ...this.defaults };
        try {
            const data = await chrome.storage.local.get(Object.keys(defaults));
            return { ...defaults, ...data };
        } catch (e) {
            return defaults;
        }
    },

    /**
     * Upload a Blob/File without relying on global G (content-script safe).
     */
    async uploadBlobWithSettings(blob, meta = {}, settings = null) {
        const s = settings || (typeof G !== "undefined"
            ? {
                lmwURL: G.lmwURL,
                lmwToken: G.lmwToken,
                lmwDefaultCategory: G.lmwDefaultCategory,
            }
            : await this.loadSettingsFromStorage());
        const base = (s.lmwURL || this.defaults.lmwURL || "").replace(/\/+$/, "") || this.defaults.lmwURL;
        const fd = new FormData();
        fd.append("category", meta.category || s.lmwDefaultCategory || "default");
        fd.append("title", meta.title || "");
        fd.append("source_url", meta.source_url || meta.url || "");
        fd.append("media_type", meta.media_type || "");
        const restricted = !!(
            meta.restricted === true ||
            meta.restricted === 1 ||
            meta.restricted === "1" ||
            s.lmwRestricted === true
        );
        const tags = this.applyRestrictedTag(meta.tags || [], restricted);
        if (tags.length) fd.append("tags", JSON.stringify(tags));
        if (restricted) fd.append("restricted", "1");
        const name = meta.filename || "upload.bin";
        fd.append("file", blob, name);
        const headers = {};
        const token = (s.lmwToken || "").trim();
        if (token) headers["X-LMW-Token"] = token;
        const res = await fetch(base + "/api/upload", { method: "POST", headers, body: fd });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`${res.status} ${text || res.statusText}`);
        }
        return res.json();
    },

    /** Short human summary for popup Tips. */
    summarizePushResult(res) {
        if (!res) return "入库失败";
        const ok = res.success ?? 0;
        const failed = res.failed ?? 0;
        const pending = res.pending ?? 0;
        const jobs = res.job_ids?.length || 0;
        if (pending) return `已提交 ${pending} 个任务，后台下载中`;
        if (ok && !failed) return `入库成功 ${ok} 项` + (jobs ? `（任务 ${jobs}）` : "");
        if (ok && failed) return `入库成功 ${ok}，失败 ${failed}`;
        if (failed) return `入库失败 ${failed} 项`;
        if (jobs) return `已提交 ${jobs} 个任务`;
        return "已提交入库";
    },
};

// Export for pages that load this script
if (typeof globalThis !== "undefined") {
    globalThis.LMW = LMW;
}
