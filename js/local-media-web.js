/**
 * LocalMediaWeb API client for cat-catch extension.
 */
const LMW = {
    defaults: {
        lmwEnable: true,
        lmwURL: "http://127.0.0.1:8790",
        lmwToken: "",
        lmwDefaultCategory: "default",
        lmwAutoFallback: true,
    },

    baseUrl() {
        const u = (G.lmwURL || this.defaults.lmwURL || "").replace(/\/+$/, "");
        return u || this.defaults.lmwURL;
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

    ingest(category, items) {
        return this.request("/api/ingest", {
            method: "POST",
            headers: this.headers(true),
            body: JSON.stringify({ category: category || "default", items }),
        });
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
            throw new Error(`${res.status} ${text || res.statusText}`);
        }
        return res.json();
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
        if (declared === "video" || type.startsWith("video/") || /\.(mp4|webm|mkv|mov)(\?|$)/i.test(url)) {
            return "video";
        }
        if (data.isPlay) return "video";
        return "video";
    },

    async itemToIngest(data, pageUrl) {
        const headers = await this.buildHeadersForItem(data, pageUrl);
        const row = {
            url: data.url,
            media_type: this.normalizeMediaType(data),
            title: data.title || data.downFileName || data.name || "",
            referer: headers.Referer || pageUrl || "",
            source_page: pageUrl || "",
            headers,
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

    async waitJobs(jobIds, { timeoutMs = 600000, onProgress } = {}) {
        const pending = new Set(jobIds);
        const results = [];
        const start = Date.now();
        while (pending.size && Date.now() - start < timeoutMs) {
            for (const id of [...pending]) {
                try {
                    const job = await this.getJob(id);
                    if (onProgress) onProgress(job);
                    if (["queued", "running"].includes(job.status)) continue;
                    pending.delete(id);
                    results.push(job);
                } catch (e) {
                    pending.delete(id);
                    results.push({ id, status: "failed_network", error_message: String(e) });
                }
            }
            if (pending.size) await new Promise((r) => setTimeout(r, 800));
        }
        for (const id of pending) {
            results.push({ id, status: "failed_network", error_message: "timeout waiting job" });
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
        return this.uploadBlob(blob, {
            category,
            title: item.title || "",
            source_url: item.url,
            media_type: item.media_type || "",
            filename: `${(item.title || "media").slice(0, 40)}.${ext}`,
        });
    },

    /**
     * Ingest items; optionally fallback upload on auth/network failure.
     */
    async pushItems(items, category, { autoFallback } = {}) {
        const cat = category || G.lmwDefaultCategory || "default";
        const fallback = autoFallback ?? G.lmwAutoFallback ?? true;
        const ingestRes = await this.ingest(cat, items);
        const jobIds = ingestRes.job_ids || [];
        const jobs = jobIds.length ? await this.waitJobs(jobIds) : [];
        let fallbackOk = 0;
        let failed = 0;
        for (const job of jobs) {
            if (job.status === "success") continue;
            const can =
                fallback &&
                job.client_fallback_allowed !== false &&
                ["failed_auth", "need_client_fetch", "failed_network", "failed_partial"].includes(job.status);
            if (!can) {
                failed++;
                continue;
            }
            const item = items.find((it) => it.url === job.url) || items[0];
            if (!item || item.media_type === "m3u8" || item.media_type === "dash") {
                // stream client merge is heavy; server should handle HLS/DASH
                failed++;
                continue;
            }
            try {
                await this.clientFetchAndUpload(item, cat);
                fallbackOk++;
            } catch (e) {
                console.warn("LMW fallback failed", e);
                failed++;
            }
        }
        return {
            ...ingestRes,
            jobs,
            fallbackOk,
            failed,
            success: jobs.filter((j) => j.status === "success").length + fallbackOk,
        };
    },
};

// Export for pages that load this script
if (typeof globalThis !== "undefined") {
    globalThis.LMW = LMW;
}
