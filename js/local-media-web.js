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
    MAX_TAGS: 5,

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

    ingest(category, items, tags = []) {
        return this.request("/api/ingest", {
            method: "POST",
            headers: this.headers(true),
            body: JSON.stringify({
                category: category || "default",
                items,
                tags: this.normalizeTags(tags),
            }),
        });
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
            let name = String(t || "")
                .trim()
                .toLowerCase()
                .replace(/^#/, "")
                .replace(/\s+/g, "-");
            if (!name || seen.has(name)) continue;
            name = name.replace(/[^\w\u4e00-\u9fff\-+.#]/gi, "").slice(0, 32);
            if (!name || seen.has(name)) continue;
            seen.add(name);
            out.push(name);
            if (out.length >= this.MAX_TAGS) break;
        }
        return out;
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
        const tags = this.normalizeTags(meta.tags || []);
        if (tags.length) fd.append("tags", JSON.stringify(tags));
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
     * Modal: media detail + tags (max 5).
     * - 建议标签单独列出，点击即可加入（同步到输入框与已选 chips）
     * - 默认不把全部建议预填为已选，避免「没有待选」
     * opts: { title, url, media_type, source_page, count, tags, suggest, prefillSuggest }
     *   prefillSuggest: true 时预选前 2 个建议（默认 false，只展示待选）
     */
    openIngestDialog(opts = {}) {
        const self = this;
        return new Promise((resolve) => {
            const title = opts.title || "媒体";
            const url = opts.url || "";
            const mtype = opts.media_type || "";
            const count = opts.count || 1;
            const suggestions = self.normalizeTags([
                ...self.suggestTags({
                    title,
                    url,
                    media_type: mtype,
                    source_page: opts.source_page || "",
                }),
                ...(opts.suggest || []),
            ]);
            // 已选：仅显式传入的 tags；可选预填前 2 个建议
            let tags = self.normalizeTags(opts.tags || []);
            if (!tags.length && opts.prefillSuggest) {
                tags = suggestions.slice(0, 2);
            }

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
#lmw-ingest-dlg-root .card{background:#1e1e28;color:#f0f0f5;border-radius:14px;padding:16px 18px;width:min(420px,94vw);max-height:90vh;overflow:auto;box-shadow:0 12px 40px rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.08)}
#lmw-ingest-dlg-root h3{margin:0 0 8px;font-size:16px}
#lmw-ingest-dlg-root .meta{font-size:12px;opacity:.8;word-break:break-all;line-height:1.4;margin-bottom:10px}
#lmw-ingest-dlg-root .row{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}
#lmw-ingest-dlg-root .chip{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:999px;background:rgba(90,130,255,.35);font-size:12px;cursor:default;border:1px solid rgba(120,160,255,.35);user-select:none}
#lmw-ingest-dlg-root .chip .rm{border:0;background:transparent;color:inherit;cursor:pointer;font-size:14px;line-height:1;padding:0 0 0 4px}
#lmw-ingest-dlg-root .sug{appearance:none;display:inline-flex;align-items:center;padding:5px 12px;border-radius:999px;background:rgba(255,255,255,.1);color:#e8eefc;font-size:12px;cursor:pointer;border:1px solid rgba(255,255,255,.18);user-select:none}
#lmw-ingest-dlg-root .sug:hover{border-color:rgba(120,160,255,.7);background:rgba(90,130,255,.28)}
#lmw-ingest-dlg-root .sug.on{background:rgba(90,130,255,.4);border-color:rgba(120,160,255,.8)}
#lmw-ingest-dlg-root .sug:disabled{opacity:.45;cursor:not-allowed}
#lmw-ingest-dlg-root input[type=text]{width:100%;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.15);background:#12121a;color:#fff;margin-top:6px}
#lmw-ingest-dlg-root .actions{display:flex;gap:8px;justify-content:flex-end;margin-top:14px;flex-wrap:wrap}
#lmw-ingest-dlg-root .actions button{border:0;border-radius:8px;padding:8px 14px;cursor:pointer;font-weight:600}
#lmw-ingest-dlg-root .btn-ok{background:#3b82f6;color:#fff}
#lmw-ingest-dlg-root .btn-skip{background:rgba(255,255,255,.12);color:#fff}
#lmw-ingest-dlg-root .btn-cancel{background:transparent;color:#aaa}
#lmw-ingest-dlg-root .hint{font-size:11px;opacity:.75;margin-top:6px}
#lmw-ingest-dlg-root .err{font-size:11px;color:#f88;min-height:16px;margin-top:4px}
</style>
<div class="card" role="dialog" aria-modal="true">
  <h3>${count > 1 ? `入库 ${count} 项媒体` : "入库详情"}</h3>
  <div class="meta">
    <div><b>标题</b> ${escapeHtml(String(title).slice(0, 120))}</div>
    <div><b>类型</b> ${escapeHtml(mtype || "—")}${count > 1 ? " · 将共用标签" : ""}</div>
    <div><b>地址</b> ${escapeHtml(String(url).slice(0, 160))}</div>
  </div>
  <div><b>已选标签</b>（最多 ${self.MAX_TAGS} 个，点 × 移除）</div>
  <div class="row" id="lmwTagChips"></div>
  <div class="hint">建议标签（点击添加 / 再次点击取消）</div>
  <div class="row" id="lmwTagSug"></div>
  <div class="hint">或手动输入后回车添加</div>
  <input type="text" id="lmwTagInput" placeholder="例如: anime, 1080p" maxlength="32" autocomplete="off" />
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
            const errEl = root.querySelector("#lmwTagErr");

            function setErr(msg) {
                errEl.textContent = msg || "";
            }

            function syncInputFromTags() {
                // 输入框展示当前已选，方便看到/编辑
                input.placeholder = tags.length
                    ? `已选: ${tags.join(", ")}（回车继续添加）`
                    : "例如: anime, 1080p";
            }

            function render() {
                chipsEl.innerHTML = tags.length
                    ? tags
                          .map(
                              (t, i) =>
                                  `<span class="chip">#${escapeHtml(t)}<button type="button" class="rm" data-rm="${i}" aria-label="移除">×</button></span>`
                          )
                          .join("")
                    : `<span style="opacity:.5;font-size:12px">暂无，请点击下方建议或输入</span>`;

                sugEl.innerHTML = suggestions.length
                    ? suggestions
                          .map((s) => {
                              const on = tags.includes(s);
                              const dis = !on && tags.length >= self.MAX_TAGS;
                              return `<button type="button" class="sug${on ? " on" : ""}" data-tag="${escapeHtml(s)}" ${dis ? "disabled" : ""}>${on ? "✓ " : "+ "}#${escapeHtml(s)}</button>`;
                          })
                          .join("")
                    : `<span style="opacity:.5;font-size:12px">无自动建议</span>`;
                syncInputFromTags();
            }

            function addTag(raw) {
                const next = self.normalizeTags([raw]);
                if (!next.length) {
                    setErr("无效标签");
                    return false;
                }
                const t = next[0];
                if (tags.includes(t)) {
                    setErr(`已包含 #${t}`);
                    return false;
                }
                if (tags.length >= self.MAX_TAGS) {
                    setErr(`最多 ${self.MAX_TAGS} 个标签`);
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
                const i = tags.indexOf(t);
                if (i >= 0) {
                    removeTag(i);
                    return;
                }
                addTag(t);
            }

            // 事件委托：避免重绘后监听丢失，且不被页面其它样式影响
            card.addEventListener("click", (e) => {
                e.stopPropagation();
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

            input.addEventListener("keydown", (e) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    e.stopPropagation();
                    const v = input.value.trim();
                    if (!v) return;
                    // 支持一次输入多个，逗号分隔
                    const parts = v.split(/[,，;；]+/).map((s) => s.trim()).filter(Boolean);
                    for (const p of parts) {
                        if (!addTag(p)) break;
                    }
                    input.value = "";
                    render();
                }
            });

            function finish(result) {
                root.remove();
                resolve(result);
            }
            root.querySelector("#lmwDlgCancel").onclick = (e) => {
                e.stopPropagation();
                finish({ ok: false, cancelled: true, tags: [] });
            };
            root.querySelector("#lmwDlgSkip").onclick = (e) => {
                e.stopPropagation();
                finish({ ok: true, tags: [] });
            };
            root.querySelector("#lmwDlgOk").onclick = (e) => {
                e.stopPropagation();
                // 若输入框还有未提交内容，一并加入
                const leftover = input.value.trim();
                if (leftover) {
                    leftover.split(/[,，;；]+/).forEach((p) => addTag(p.trim()));
                    input.value = "";
                }
                finish({ ok: true, tags: self.normalizeTags(tags) });
            };
            root.addEventListener("click", (e) => {
                if (e.target === root) finish({ ok: false, cancelled: true, tags: [] });
            });
            render();
            setTimeout(() => input.focus(), 50);
        });
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
            tags: item.tags || [],
        });
    },

    /**
     * Ingest items; optionally fallback upload on auth/network failure.
     */
    async pushItems(items, category, { autoFallback, wait = true, onProgress, tags } = {}) {
        const cat = category || (typeof G !== "undefined" && G.lmwDefaultCategory) || "default";
        const fallback = autoFallback ?? (typeof G !== "undefined" ? G.lmwAutoFallback : true) ?? true;
        const sharedTags = this.normalizeTags(tags || []);
        if (sharedTags.length) {
            for (const it of items) {
                if (!it.tags || !it.tags.length) it.tags = sharedTags;
            }
        }
        const ingestRes = await this.ingest(cat, items, sharedTags);
        const jobIds = ingestRes.job_ids || [];
        if (!wait) {
            return { ...ingestRes, jobs: [], fallbackOk: 0, failed: 0, success: 0, pending: jobIds.length };
        }
        const jobs = jobIds.length ? await this.waitJobs(jobIds, { onProgress }) : [];
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
        const tags = this.normalizeTags(meta.tags || []);
        if (tags.length) fd.append("tags", JSON.stringify(tags));
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
