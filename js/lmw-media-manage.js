/**
 * Extension page: LocalMediaWeb server media management.
 * Depends on init.js (G), local-media-web.js (LMW).
 */
(function () {
    "use strict";

    const PAGE_SIZE = 48;
    const UPLOAD_CONCURRENCY = 2;

    const state = {
        items: [],
        total: 0,
        offset: 0,
        loading: false,
        listAbort: null,
        selected: new Set(),
        /** Last clicked card id; Shift+click selects the contiguous range to this anchor. */
        selAnchorId: null,
        pendingFiles: [],
        editId: null,
        filters: {
            q: "",
            type: "",
            tag: "",
            liked: "",
            sort: "new",
        },
    };

    const $ = (id) => document.getElementById(id);

    /** Tag autocomplete controllers (batch / upload / edit) */
    const tagAc = { batch: null, upload: null, edit: null };

    async function refreshAllTagAc() {
        LMW.invalidateTagLibrary();
        await Promise.all(
            [tagAc.batch, tagAc.upload, tagAc.edit]
                .filter(Boolean)
                .map((ac) => ac.refresh())
        );
    }

    async function pollJasnaJob(jobId, { timeoutMs = 3600000, intervalMs = 2000 } = {}) {
        if (!jobId || !LMW.getJasnaJob) return;
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            try {
                const j = await LMW.getJasnaJob(jobId);
                const st = j.status || "";
                const pct = Math.round(Number(j.progress) || 0);
                $("mmUploadProg").textContent = `jasna #${jobId} · ${st} ${pct}%`;
                if (["success", "failed", "cancelled"].includes(st)) {
                    if (st === "success") {
                        setStatus(`jasna #${jobId} 完成`);
                        if (j.media_id && typeof LMW.invalidateBlobCacheForMedia === "function") {
                            LMW.invalidateBlobCacheForMedia(j.media_id);
                        }
                        await loadList({ reset: true });
                    } else {
                        setStatus(`jasna #${jobId} ${st}${j.error_message ? ": " + j.error_message : ""}`);
                    }
                    return j;
                }
            } catch (e) {
                console.warn("jasna poll", e);
            }
            await new Promise((r) => setTimeout(r, intervalMs));
        }
        return null;
    }

    function waitGReady() {
        return new Promise((resolve) => {
            const tick = () => {
                if (G && (G.initSyncComplete || G.lmwURL != null || G.OptionLists)) {
                    // Prefer filled storage; fall back after short wait if still empty
                    if (G.initSyncComplete || G.initLocalComplete) {
                        resolve();
                        return;
                    }
                }
                if (waitGReady._n > 40) {
                    resolve();
                    return;
                }
                waitGReady._n = (waitGReady._n || 0) + 1;
                setTimeout(tick, 50);
            };
            tick();
        });
    }

    function escapeHtml(s) {
        return String(s ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function formatSize(n) {
        n = Number(n) || 0;
        if (n < 1024) return n + " B";
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
        if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
        return (n / (1024 * 1024 * 1024)).toFixed(2) + " GB";
    }

    function setStatus(msg) {
        const el = $("mmStatus");
        if (el) el.textContent = msg || "";
    }

    function updateSelUi() {
        $("mmSelCount").textContent = `已选 ${state.selected.size}`;
        $("mmGrid")
            .querySelectorAll(".mm-card")
            .forEach((card) => {
                const id = Number(card.dataset.id);
                const on = state.selected.has(id);
                card.classList.toggle("selected", on);
                const cb = card.querySelector(".mm-card-check");
                if (cb) cb.checked = on;
            });
    }

    function updateCountUi() {
        $("mmCount").textContent = `${state.items.length} / ${state.total}`;
        $("btnMore").disabled = state.loading || state.items.length >= state.total;
        $("btnMore").textContent =
            state.items.length >= state.total && state.total > 0 ? "已全部加载" : "加载更多";
    }

    function readFilters() {
        state.filters.q = ($("mmQ").value || "").trim();
        state.filters.type = $("mmType").value || "";
        state.filters.tag = $("mmTag").value || "";
        state.filters.liked = $("mmLiked").value || "";
        state.filters.sort = $("mmSort").value || "new";
    }

    function listParams(offset) {
        const p = {
            offset,
            limit: PAGE_SIZE,
            sort: state.filters.sort || "new",
        };
        if (state.filters.q) p.q = state.filters.q;
        if (state.filters.type) p.type = state.filters.type;
        if (state.filters.tag) p.tag = state.filters.tag;
        if (state.filters.liked === "1") p.liked = true;
        if (state.filters.liked === "0") p.liked = false;
        return p;
    }

    async function checkHealth() {
        $("mmBase").textContent = LMW.baseUrl();
        const el = $("mmHealth");
        try {
            const h = await LMW.health();
            el.textContent = "在线" + (h.version ? ` · v${h.version}` : "");
            el.className = "mm-health ok";
            return true;
        } catch (e) {
            el.textContent = "离线";
            el.className = "mm-health bad";
            setStatus("无法连接 LocalMediaWeb：" + (e.message || e));
            return false;
        }
    }

    async function loadTagOptions() {
        try {
            const data = await LMW.listTags();
            const sel = $("mmTag");
            const cur = sel.value;
            const tags = data.tags || [];
            sel.innerHTML =
                `<option value="">全部标签</option>` +
                tags
                    .map(
                        (t) =>
                            `<option value="${escapeHtml(t.name)}">#${escapeHtml(t.name)} (${t.count})</option>`
                    )
                    .join("");
            if (cur) sel.value = cur;
        } catch (e) {
            /* ignore */
        }
    }

    /**
     * Sample library items and rank multi-tag sets (exact co-occurrence).
     * Falls back to frequent pairs when full sets are sparse.
     */
    async function loadTagCombos() {
        const listEl = $("mmTagCombosList");
        if (!listEl) return;
        listEl.innerHTML = `<span class="muted mm-tag-combos-empty">统计中…</span>`;
        try {
            const setCounts = new Map(); // key -> { tags, count }
            const pairCounts = new Map();
            const pageLimit = 100;
            const maxScan = 800;
            let offset = 0;
            let total = Infinity;
            let scanned = 0;

            while (offset < maxScan && offset < total) {
                const data = await LMW.listMedia({
                    offset,
                    limit: pageLimit,
                    sort: "new",
                });
                total = Number(data.total) || 0;
                const items = data.items || [];
                if (!items.length) break;
                for (const m of items) {
                    const raw = Array.isArray(m.tags) ? m.tags : [];
                    const tags = [
                        ...new Set(
                            raw
                                .map((t) => String(t || "").trim())
                                .filter(Boolean)
                        ),
                    ].sort((a, b) => a.localeCompare(b, "zh"));
                    if (tags.length < 2) continue;
                    const key = tags.join("\0");
                    const prev = setCounts.get(key) || { tags, count: 0 };
                    prev.count += 1;
                    setCounts.set(key, prev);
                    for (let i = 0; i < tags.length; i++) {
                        for (let j = i + 1; j < tags.length; j++) {
                            const pk = tags[i] + "\0" + tags[j];
                            const p = pairCounts.get(pk) || {
                                tags: [tags[i], tags[j]],
                                count: 0,
                            };
                            p.count += 1;
                            pairCounts.set(pk, p);
                        }
                    }
                }
                scanned += items.length;
                offset += items.length;
                if (items.length < pageLimit) break;
            }

            let combos = [...setCounts.values()]
                .filter((c) => c.count >= 1 && c.tags.length >= 2)
                .sort((a, b) => b.count - a.count || b.tags.length - a.tags.length);

            // Pad with co-occurring pairs if full sets are few
            if (combos.length < 12) {
                const seen = new Set(combos.map((c) => c.tags.join("\0")));
                const pairs = [...pairCounts.values()]
                    .filter((c) => c.count >= 2)
                    .sort((a, b) => b.count - a.count);
                for (const p of pairs) {
                    const k = p.tags.join("\0");
                    if (seen.has(k)) continue;
                    seen.add(k);
                    combos.push(p);
                    if (combos.length >= 20) break;
                }
            }

            combos = combos.slice(0, 20);
            renderTagCombos(combos, scanned);
        } catch (e) {
            listEl.innerHTML = `<span class="muted mm-tag-combos-empty">标签组合加载失败</span>`;
            console.warn("loadTagCombos", e);
        }
    }

    function renderTagCombos(combos, scanned) {
        const listEl = $("mmTagCombosList");
        if (!listEl) return;
        if (!combos || !combos.length) {
            listEl.innerHTML = `<span class="muted mm-tag-combos-empty">暂无多标签组合（入库带标签后会出现）</span>`;
            return;
        }
        listEl.innerHTML = combos
            .map((c) => {
                const text = c.tags.join(", ");
                const display = c.tags.map((t) => "#" + t).join(" ");
                return `<button type="button" class="mm-tag-combo" data-tags="${escapeHtml(
                    text
                )}" title="点击复制：${escapeHtml(text)}${
                    scanned ? ` · 采样 ${scanned} 条` : ""
                }"><span class="mm-tag-combo-text">${escapeHtml(
                    display
                )}</span><span class="mm-tag-combo-count">×${c.count}</span></button>`;
            })
            .join("");
    }

    async function copyTagCombo(text, btn) {
        const value = String(text || "").trim();
        if (!value) return;
        try {
            await navigator.clipboard.writeText(value);
        } catch (_) {
            // fallback
            const ta = document.createElement("textarea");
            ta.value = value;
            ta.style.position = "fixed";
            ta.style.left = "-9999px";
            document.body.appendChild(ta);
            ta.select();
            try {
                document.execCommand("copy");
            } catch (e) { /* ignore */ }
            ta.remove();
        }
        const input = $("mmUploadTags");
        if (input) {
            input.value = value;
            input.dispatchEvent(new Event("input", { bubbles: true }));
        }
        setStatus("已复制标签组合：" + value);
        if (btn) {
            btn.classList.add("is-copied");
            setTimeout(() => btn.classList.remove("is-copied"), 900);
        }
    }

    const RESTRICTED_TAG = "限制级";

    function isRestricted(m) {
        return (m.tags || []).includes(RESTRICTED_TAG);
    }

    function typeLabel(t) {
        const map = { video: "视频", audio: "音频", image: "图片", gif: "动图", m3u8: "m3u8" };
        return map[t] || t || "media";
    }

    function cardHtml(m) {
        const tags = (m.tags || []).map((t) => "#" + t).join(" ");
        const liked = m.liked ? "♥ " : "";
        const restricted = isRestricted(m);
        const mtype = m.media_type || "";
        return `<article class="mm-card${restricted ? " is-restricted" : ""}" data-id="${m.id}" data-type="${escapeHtml(mtype)}">
  <input type="checkbox" class="mm-card-check" data-id="${m.id}" aria-label="选择 #${m.id}" title="点击选择；Shift+点击连续多选" />
  <div class="mm-thumb-wrap" data-preview="${m.id}" title="预览">
    <div class="mm-thumb-ph" data-thumb-ph="${m.id}">${escapeHtml(typeLabel(mtype))}</div>
    <img alt="" data-thumb="${m.id}" data-src="${escapeHtml(m.thumb_url || "")}" hidden />
    ${restricted ? `<span class="mm-badge-r" title="限制级">R</span>` : ""}
  </div>
  <div class="mm-card-body">
    <div class="mm-card-title" title="${escapeHtml(m.title || "")}">${escapeHtml(m.title || "(无标题)")}</div>
    <div class="mm-card-meta">${liked}#${m.id} · ${escapeHtml(typeLabel(mtype))} · ${formatSize(m.file_size)}</div>
    <div class="mm-card-tags">${escapeHtml(tags || "无标签")}</div>
    <label class="mm-card-restricted" title="切换「限制级」标签">
      <input type="checkbox" class="mm-restricted-toggle" data-id="${m.id}" ${restricted ? "checked" : ""} />
      限制级
    </label>
    <div class="mm-card-actions">
      <button type="button" data-act="edit" data-id="${m.id}">编辑</button>
      <button type="button" data-act="like" data-id="${m.id}">${m.liked ? "取消♥" : "喜欢"}</button>
      ${
          mtype === "video" || mtype === "m3u8"
              ? `<button type="button" data-act="fix" data-id="${m.id}" title="服务端 H.264/AAC 标准化转码并自动替换">修复</button>`
              : ""
      }
      <button type="button" data-act="del" data-id="${m.id}">删除</button>
    </div>
  </div>
</article>`;
    }

    function renderGrid(append) {
        const grid = $("mmGrid");
        if (!append) {
            grid.innerHTML = "";
            if (!state.items.length) {
                grid.innerHTML = `<div class="mm-empty">暂无媒体${state.filters.q || state.filters.tag || state.filters.type ? "（试试调整筛选）" : "，可上传本地文件"}</div>`;
                updateCountUi();
                updateSelUi();
                return;
            }
        }
        const start = append ? grid.querySelectorAll(".mm-card").length : 0;
        const slice = state.items.slice(start);
        if (!slice.length && !append) return;
        const frag = document.createDocumentFragment();
        const wrap = document.createElement("div");
        wrap.innerHTML = slice.map(cardHtml).join("");
        while (wrap.firstChild) frag.appendChild(wrap.firstChild);
        // remove empty placeholder
        const empty = grid.querySelector(".mm-empty");
        if (empty) empty.remove();
        grid.appendChild(frag);
        observeThumbs(grid);
        updateCountUi();
        updateSelUi();
    }

    let thumbObserver = null;
    function observeThumbs(root) {
        if (!thumbObserver) {
            thumbObserver = new IntersectionObserver(
                (entries) => {
                    for (const en of entries) {
                        if (!en.isIntersecting) continue;
                        const img = en.target;
                        thumbObserver.unobserve(img);
                        loadThumb(img);
                    }
                },
                { rootMargin: "120px", threshold: 0.01 }
            );
        }
        root.querySelectorAll("img[data-thumb][data-src]").forEach((img) => {
            if (img.dataset.loaded === "1") return;
            thumbObserver.observe(img);
        });
    }

    async function loadThumb(img) {
        const src = img.dataset.src;
        if (!src || img.dataset.loaded === "1") return;
        img.dataset.loaded = "1";
        const id = img.dataset.thumb;
        try {
            // Prefer ?token= direct URL (no full fetch into extension memory)
            if (typeof LMW.mediaUrlWithToken === "function") {
                img.src = LMW.mediaUrlWithToken(src);
            } else {
                img.src = await LMW.fetchAuthedBlobUrl(src);
            }
            img.hidden = false;
            const ph = img.parentElement && img.parentElement.querySelector(`[data-thumb-ph="${id}"]`);
            if (ph) ph.hidden = true;
            img.onerror = () => {
                // fallback: header-auth blob
                img.onerror = null;
                LMW.fetchAuthedBlobUrl(src)
                    .then((blobUrl) => {
                        img.src = blobUrl;
                        img.hidden = false;
                        if (ph) ph.hidden = true;
                    })
                    .catch(() => {
                        img.dataset.loaded = "0";
                    });
            };
        } catch (e) {
            img.dataset.loaded = "0";
            // leave placeholder
        }
    }

    async function loadList({ reset = false } = {}) {
        if (state.loading) return;
        readFilters();
        if (reset) {
            state.offset = 0;
            state.items = [];
            state.selected.clear();
            state.selAnchorId = null;
            if (state.listAbort) state.listAbort.abort();
            // Drop stale file/thumb blobs so jasna-replaced media re-fetches
            if (typeof LMW.revokeAllBlobUrls === "function") {
                LMW.revokeAllBlobUrls();
            }
        }
        state.listAbort = new AbortController();
        const offset = state.offset;
        state.loading = true;
        setStatus(reset ? "加载中…" : "加载更多…");
        $("btnMore").disabled = true;
        try {
            const data = await LMW.listMedia(listParams(offset), { signal: state.listAbort.signal });
            const items = data.items || [];
            state.total = data.total ?? items.length;
            if (reset) state.items = items;
            else state.items = state.items.concat(items);
            state.offset = state.items.length;
            renderGrid(!reset);
            setStatus("");
        } catch (e) {
            if (e && e.name === "AbortError") return;
            setStatus("加载失败：" + (e.message || e));
            if (reset) {
                state.items = [];
                state.total = 0;
                renderGrid(false);
            }
        } finally {
            state.loading = false;
            updateCountUi();
        }
    }

    function debounce(fn, ms) {
        let t = null;
        return (...args) => {
            clearTimeout(t);
            t = setTimeout(() => fn(...args), ms);
        };
    }

    /* ---------- selection / batch ---------- */

    function selectedIds() {
        return [...state.selected];
    }

    /** Visible card ids in DOM order (current grid order). */
    function visibleCardIds() {
        return [...$("mmGrid").querySelectorAll(".mm-card")].map((c) => Number(c.dataset.id));
    }

    /**
     * Select every card between fromId and toId (inclusive) in grid order.
     * Used by Shift+click range selection. Does not clear existing selection outside the range.
     */
    function selectRangeInclusive(fromId, toId) {
        const ids = visibleCardIds();
        let i0 = ids.indexOf(Number(fromId));
        let i1 = ids.indexOf(Number(toId));
        if (i1 < 0) return;
        if (i0 < 0) i0 = i1;
        const lo = Math.min(i0, i1);
        const hi = Math.max(i0, i1);
        for (let i = lo; i <= hi; i++) {
            state.selected.add(ids[i]);
        }
        updateSelUi();
    }

    /**
     * Toggle or range-select one card. Shift+click selects from selAnchorId → id.
     * @returns {boolean} true if handled as range select
     */
    function applyCardSelection(id, { shiftKey = false, checked = true } = {}) {
        id = Number(id);
        if (!id) return false;
        if (shiftKey) {
            const anchor = state.selAnchorId != null ? state.selAnchorId : id;
            selectRangeInclusive(anchor, id);
            // Keep original anchor (file-manager style) so further Shift+clicks extend from first point
            if (state.selAnchorId == null) state.selAnchorId = id;
            return true;
        }
        if (checked) state.selected.add(id);
        else state.selected.delete(id);
        state.selAnchorId = id;
        updateSelUi();
        return false;
    }

    async function batchTags(mode) {
        const ids = selectedIds();
        if (!ids.length) {
            setStatus("请先勾选媒体");
            return;
        }
        const tags = tagAc.batch
            ? await tagAc.batch.commit()
            : await LMW.softNormalizeTags($("mmBatchTags").value);
        if (!tags.length) {
            setStatus("请输入批量标签");
            return;
        }
        try {
            const r = await LMW.batchTags(ids, tags, mode);
            $("mmBatchTags").value = "";
            setStatus(`已更新 ${r.updated || 0} 项 · 标签 ${tags.map((t) => "#" + t).join(" ")}`);
            await refreshAllTagAc();
            await loadList({ reset: true });
            await loadTagOptions();
            loadTagCombos();
        } catch (e) {
            setStatus("打标签失败：" + (e.message || e));
        }
    }

    async function batchDelete() {
        const ids = selectedIds();
        if (!ids.length) {
            setStatus("请先勾选媒体");
            return;
        }
        if (!confirm(`确定删除选中的 ${ids.length} 项媒体？\n文件与索引将从服务器移除，不可恢复。`)) return;
        try {
            const r = await LMW.batchDelete(ids);
            setStatus(`已删除 ${r.deleted || 0} 项`);
            state.selected.clear();
            state.selAnchorId = null;
            await loadList({ reset: true });
            await loadTagOptions();
            loadTagCombos();
        } catch (e) {
            setStatus("批量删除失败：" + (e.message || e));
        }
    }

    /**
     * Server scans file content (size + SHA-256); removes items that
     * reference byte-identical media, keeping one preferred row per group.
     */
    async function oneClickDedupe() {
        const btn = $("btnDedupe");
        if (btn) btn.disabled = true;
        try {
            setStatus("正在扫描重复媒体…");
            const preview = await LMW.dedupeMedia({ dry_run: true });
            const nGroups = preview.duplicate_groups || 0;
            const nDrop = (preview.deleted_ids && preview.deleted_ids.length) || preview.would_delete || 0;
            if (!nGroups || !nDrop) {
                setStatus(
                    `去重完成：未发现内容完全相同的条目（扫描 ${preview.scanned || 0} 项）`
                );
                return;
            }
            const lines = (preview.groups || [])
                .slice(0, 8)
                .map(
                    (g) =>
                        `· 保留 #${g.keep_id}，删除 ${(g.remove_ids || []).join(",")}` +
                        (g.file_size ? `（${formatSize(g.file_size)}）` : "")
                );
            const more =
                (preview.groups || []).length > 8
                    ? `\n…另有 ${(preview.groups || []).length - 8} 组`
                    : "";
            const ok = confirm(
                `发现 ${nGroups} 组完全相同文件，将删除 ${nDrop} 条重复 item（每组保留 1 条）。\n` +
                    `优先保留：已喜欢 / 有点评 / 互动更高 / 更早入库。\n\n` +
                    lines.join("\n") +
                    more +
                    `\n\n确定执行？不可恢复。`
            );
            if (!ok) {
                setStatus("已取消去重");
                return;
            }
            setStatus(`正在删除 ${nDrop} 条重复…`);
            const r = await LMW.dedupeMedia({ dry_run: false });
            const deleted = r.deleted || (r.deleted_ids && r.deleted_ids.length) || 0;
            for (const id of r.deleted_ids || []) {
                state.selected.delete(Number(id));
            }
            setStatus(
                `去重完成：删除 ${deleted} 条 · 保留 ${
                    (r.kept_ids && r.kept_ids.length) || 0
                } 组代表 · 扫描 ${r.scanned || 0}`
            );
            updateSelUi();
            await loadList({ reset: true });
            await loadTagOptions();
            loadTagCombos();
        } catch (e) {
            setStatus("去重失败：" + (e.message || e));
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    async function batchJasna() {
        const ids = selectedIds();
        if (!ids.length) {
            setStatus("请先勾选媒体");
            return;
        }
        if (
            !confirm(
                `对选中的 ${ids.length} 项执行 jasna 去码？\n仅视频/m3u8 会入队；GPU 串行处理，成功后替换为 h264/mp4。`
            )
        ) {
            return;
        }
        const btn = $("btnBatchJasna");
        if (btn) btn.disabled = true;
        try {
            setStatus(`jasna 入队中…（${ids.length} 项）`);
            const r = await LMW.batchEnqueueJasna(ids);
            const queued = r.queued || 0;
            const skipped = r.skipped || 0;
            const jobIds = (r.items || [])
                .map((it) => it.jasna_job_id)
                .filter(Boolean);
            setStatus(
                `jasna 已排队 ${queued} 项` +
                    (skipped ? ` · 跳过 ${skipped}` : "") +
                    (jobIds.length ? ` · job ${jobIds.slice(0, 5).join(",")}${jobIds.length > 5 ? "…" : ""}` : "")
            );
            if (jobIds.length && typeof LMW.waitJasnaForMediaIds === "function") {
                const mediaIds = (r.items || []).map((it) => it.id).filter(Boolean);
                LMW.waitJasnaForMediaIds(mediaIds, {
                    onUpdate: (text) => setStatus(text),
                })
                    .then(async (jobs) => {
                        const ok = (jobs || []).filter((j) => j.status === "success").length;
                        const fail = (jobs || []).filter((j) =>
                            ["failed", "cancelled"].includes(j.status)
                        ).length;
                        for (const mid of mediaIds) {
                            if (typeof LMW.invalidateBlobCacheForMedia === "function") {
                                LMW.invalidateBlobCacheForMedia(mid);
                            }
                        }
                        setStatus(`jasna 结束：成功 ${ok}` + (fail ? ` · 失败/取消 ${fail}` : ""));
                        await loadList({ reset: true });
                    })
                    .catch((e) => setStatus("jasna 轮询失败：" + (e.message || e)));
            }
        } catch (e) {
            setStatus("jasna 入队失败：" + (e.message || e));
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    /* ---------- upload ---------- */

    function guessMediaType(file) {
        const n = (file.name || "").toLowerCase();
        const t = (file.type || "").toLowerCase();
        if (t.includes("gif") || n.endsWith(".gif")) return "gif";
        if (t.startsWith("image/") || /\.(png|jpe?g|webp|avif|bmp)$/i.test(n)) return "image";
        if (
            t.startsWith("audio/") ||
            /\.(mp3|m4a|aac|flac|wav|ogg|opus|wma|aiff?|oga)$/i.test(n)
        ) {
            return "audio";
        }
        return "video";
    }

    function fileKey(f) {
        return `${f.name || ""}|${f.size || 0}|${f.lastModified || 0}`;
    }

    function refreshPendingUi() {
        const files = state.pendingFiles;
        $("btnUpload").disabled = !files.length;
        const btnClear = $("btnClearPending");
        if (btnClear) btnClear.disabled = !files.length;
        if (!files.length) {
            $("mmUploadProg").textContent = "";
            return;
        }
        const total = formatSize(files.reduce((s, f) => s + (f.size || 0), 0));
        const names = files
            .slice(0, 8)
            .map((f) => f.name)
            .join(" · ");
        const more = files.length > 8 ? ` 等 ${files.length} 个` : "";
        $("mmUploadProg").textContent = `待上传 ${files.length} 个 · ${total}${names ? " — " + names + more : ""}`;
    }

    /** Append files (stack). Dedupe by name+size+lastModified. */
    function addPendingFiles(fileList, { replace = false } = {}) {
        const incoming = [...(fileList || [])].filter((f) => f && f.size > 0);
        if (replace) {
            state.pendingFiles = incoming;
        } else {
            const seen = new Set(state.pendingFiles.map(fileKey));
            for (const f of incoming) {
                const k = fileKey(f);
                if (seen.has(k)) continue;
                seen.add(k);
                state.pendingFiles.push(f);
            }
        }
        refreshPendingUi();
    }

    function clearPendingFiles() {
        state.pendingFiles = [];
        const input = $("mmFiles");
        if (input) input.value = "";
        refreshPendingUi();
        setStatus("已清除待上传列表");
    }

    async function runUploadQueue() {
        const files = state.pendingFiles.slice();
        if (!files.length) return;
        const tags = tagAc.upload
            ? await tagAc.upload.commit()
            : await LMW.softNormalizeTags($("mmUploadTags").value);
        $("btnUpload").disabled = true;
        let done = 0;
        let failed = 0;
        let dups = 0;
        const queue = files.slice();

        async function worker() {
            while (queue.length) {
                const file = queue.shift();
                if (!file) break;
                const title = (file.name || "upload").replace(/\.[^.]+$/, "");
                $("mmUploadProg").textContent = `上传中 ${done + failed + dups + 1}/${files.length} · ${file.name}`;
                try {
                    const restricted = !!(
                        $("mmRestricted") && $("mmRestricted").checked
                    );
                    const up = await LMW.uploadBlob(file, {
                        title,
                        filename: file.name,
                        media_type: guessMediaType(file),
                        tags,
                        restricted,
                    });
                    if (up && up.duplicate) {
                        dups++;
                    } else {
                        done++;
                    }
                } catch (e) {
                    failed++;
                    console.warn("upload fail", file.name, e);
                }
            }
        }

        const workers = [];
        for (let i = 0; i < Math.min(UPLOAD_CONCURRENCY, files.length); i++) {
            workers.push(worker());
        }
        await Promise.all(workers);
        state.pendingFiles = [];
        $("mmFiles").value = "";
        refreshPendingUi();
        $("mmUploadProg").textContent =
            `完成：成功 ${done}` +
            (dups ? ` · 内容重复跳过 ${dups}` : "") +
            (failed ? ` · 失败 ${failed}` : "");
        if (done || dups) await refreshAllTagAc();
        await loadList({ reset: true });
        await loadTagOptions();
        loadTagCombos();
        setStatus(
            (failed
                ? `上传完成（${failed} 失败）`
                : dups && !done
                  ? "上传完成（全部为库内已有内容）"
                  : "上传完成") +
                (dups ? ` · 重复 ${dups}` : "") +
                (tags.length ? " · 标签 " + tags.map((t) => "#" + t).join(" ") : "")
        );
    }

    /* ---------- preview / edit ---------- */

    function closePreview() {
        const box = $("mmPreview");
        box.classList.add("hide");
        box.setAttribute("aria-hidden", "true");
        const stage = $("mmPreviewStage");
        stage.querySelectorAll("video, audio").forEach((v) => {
            try {
                v.pause();
                v.removeAttribute("src");
                v.load();
            } catch (e) { /* ignore */ }
        });
        stage.innerHTML = "";
        $("mmPreviewMeta").textContent = "";
    }

    async function openPreview(id) {
        const m = state.items.find((x) => x.id === id);
        if (!m) return;
        const stage = $("mmPreviewStage");
        stage.innerHTML = `<div class="muted">加载中…</div>`;
        $("mmPreviewMeta").textContent = `#${m.id} · ${m.title || ""} · ${(m.tags || []).map((t) => "#" + t).join(" ")}`;
        $("mmPreview").classList.remove("hide");
        $("mmPreview").setAttribute("aria-hidden", "false");
        try {
            const mtype = (m.media_type || "").toLowerCase();
            // Video/audio: stream via ?token= (Range). Full fetch→blob often net::ERR_FAILED on large files.
            const useStream =
                mtype !== "image" &&
                mtype !== "gif" &&
                typeof LMW.mediaUrlWithToken === "function";
            let url = "";
            if (useStream) {
                url = LMW.mediaUrlWithToken(m.file_url);
            } else {
                url = await LMW.fetchAuthedBlobUrl(m.file_url);
            }
            if (!url) throw new Error("empty media url");
            stage.innerHTML = "";
            if (mtype === "image" || mtype === "gif") {
                const img = document.createElement("img");
                img.src = url;
                img.alt = m.title || "";
                img.onerror = () => {
                    stage.innerHTML = `<div class="muted">图片预览失败</div>`;
                };
                stage.appendChild(img);
            } else if (mtype === "audio") {
                const a = document.createElement("audio");
                a.controls = true;
                a.autoplay = true;
                a.preload = "metadata";
                a.style.width = "min(92vw, 480px)";
                a.src = url;
                a.addEventListener("error", () => {
                    // fallback: download full file with auth headers
                    LMW.fetchAuthedBlobUrl(m.file_url, { force: true })
                        .then((blobUrl) => {
                            a.src = blobUrl;
                            a.play().catch(() => {});
                        })
                        .catch((err) => {
                            stage.innerHTML = `<div class="muted">音频预览失败：${escapeHtml(
                                (err && err.message) || err
                            )}</div>`;
                        });
                });
                stage.appendChild(a);
            } else {
                const v = document.createElement("video");
                v.controls = true;
                v.autoplay = true;
                v.playsInline = true;
                v.preload = "metadata";
                v.src = url;
                v.addEventListener("error", () => {
                    stage.innerHTML = `<div class="muted">视频流式预览失败，尝试整文件加载…</div>`;
                    LMW.fetchAuthedBlobUrl(m.file_url, { force: true })
                        .then((blobUrl) => {
                            stage.innerHTML = "";
                            const v2 = document.createElement("video");
                            v2.controls = true;
                            v2.autoplay = true;
                            v2.playsInline = true;
                            v2.src = blobUrl;
                            stage.appendChild(v2);
                        })
                        .catch((err) => {
                            stage.innerHTML = `<div class="muted">预览失败：${escapeHtml(
                                (err && err.message) || err
                            )}<br/><span class="muted" style="font-size:12px">若已配置 Token，请确认 options 中 lmwToken 与服务端 access_token 一致；URL 需可从本机访问 ${escapeHtml(
                                LMW.baseUrl()
                            )}</span></div>`;
                        });
                });
                stage.appendChild(v);
            }
        } catch (e) {
            stage.innerHTML = `<div class="muted">预览失败：${escapeHtml(e.message || e)}</div>`;
        }
    }

    function openEdit(id) {
        const m = state.items.find((x) => x.id === id);
        if (!m) return;
        state.editId = id;
        $("mmEditTitleInput").value = m.title || "";
        $("mmEditTagsInput").value = (m.tags || []).join(", ");
        $("mmEdit").classList.remove("hide");
        $("mmEdit").setAttribute("aria-hidden", "false");
    }

    function closeEdit() {
        state.editId = null;
        $("mmEdit").classList.add("hide");
        $("mmEdit").setAttribute("aria-hidden", "true");
    }

    async function saveEdit() {
        const id = state.editId;
        if (!id) return;
        const title = ($("mmEditTitleInput").value || "").trim();
        const tags = tagAc.edit
            ? await tagAc.edit.commit()
            : await LMW.softNormalizeTags($("mmEditTagsInput").value);
        try {
            const item = await LMW.patchMedia(id, { title, tags });
            const idx = state.items.findIndex((x) => x.id === id);
            if (idx >= 0) state.items[idx] = { ...state.items[idx], ...item };
            closeEdit();
            // re-render only that card cheaply: full re-render of loaded pages
            const grid = $("mmGrid");
            grid.innerHTML = "";
            renderGrid(false);
            setStatus(
                `已保存 #${id}` +
                    (tags.length ? " · " + tags.map((t) => "#" + t).join(" ") : "")
            );
            await refreshAllTagAc();
            await loadTagOptions();
            loadTagCombos();
        } catch (e) {
            setStatus("保存失败：" + (e.message || e));
        }
    }

    async function onCardAction(act, id) {
        if (act === "edit") {
            openEdit(id);
            return;
        }
        if (act === "like") {
            try {
                const item = await LMW.toggleLike(id);
                const idx = state.items.findIndex((x) => x.id === id);
                if (idx >= 0) state.items[idx] = { ...state.items[idx], ...item };
                const grid = $("mmGrid");
                grid.innerHTML = "";
                renderGrid(false);
            } catch (e) {
                setStatus("喜欢失败：" + (e.message || e));
            }
            return;
        }
        if (act === "fix") {
            const m = state.items.find((x) => x.id === id);
            const mtype = (m && m.media_type) || "";
            if (mtype && mtype !== "video" && mtype !== "m3u8") {
                setStatus("仅视频可修复转码");
                return;
            }
            if (
                !confirm(
                    `对 #${id} 执行 H.264/AAC 标准化转码？\n` +
                        `服务端强制转码完成后会自动替换原文件（同一条目）。\n` +
                        `大文件可能需要较长时间，请勿关闭页面。`
                )
            ) {
                return;
            }
            const card = $("mmGrid").querySelector(`.mm-card[data-id="${id}"]`);
            const btn = card && card.querySelector('[data-act="fix"]');
            if (btn) {
                btn.disabled = true;
                btn.textContent = "转码中…";
            }
            setStatus(`#${id} H.264 转码中…（完成后自动替换）`);
            try {
                const r = await LMW.reencodeMedia(id);
                const item = r && r.item ? r.item : r;
                if (typeof LMW.invalidateBlobCacheForMedia === "function") {
                    LMW.invalidateBlobCacheForMedia(id);
                }
                const idx = state.items.findIndex((x) => x.id === id);
                if (idx >= 0 && item) {
                    state.items[idx] = { ...state.items[idx], ...item };
                }
                if (card && item) {
                    const wrap = document.createElement("div");
                    wrap.innerHTML = cardHtml(state.items[idx] || item);
                    const next = wrap.firstElementChild;
                    if (next) {
                        card.replaceWith(next);
                        observeThumbs($("mmGrid"));
                        updateSelUi();
                    }
                } else {
                    await loadList({ reset: true });
                }
                setStatus(
                    `已修复 #${id}` +
                        (item && item.file_size
                            ? ` · ${formatSize(item.file_size)} · H.264/mp4`
                            : " · H.264/mp4")
                );
            } catch (e) {
                setStatus(`修复 #${id} 失败：` + (e.message || e));
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = "修复";
                }
            }
            return;
        }
        if (act === "del") {
            if (!confirm(`确定删除媒体 #${id}？不可恢复。`)) return;
            try {
                await LMW.deleteMedia(id);
                state.selected.delete(id);
                state.items = state.items.filter((x) => x.id !== id);
                state.total = Math.max(0, state.total - 1);
                const card = $("mmGrid").querySelector(`.mm-card[data-id="${id}"]`);
                if (card) card.remove();
                if (!state.items.length) renderGrid(false);
                updateCountUi();
                updateSelUi();
                setStatus(`已删除 #${id}`);
                await loadTagOptions();
            } catch (e) {
                setStatus("删除失败：" + (e.message || e));
            }
        }
    }

    /* ---------- bind ---------- */

    function bind() {
        $("btnRefresh").onclick = () => {
            checkHealth();
            loadTagOptions();
            loadTagCombos();
            loadList({ reset: true });
        };
        $("btnOpenFeed").onclick = () => {
            chrome.tabs.create({ url: LMW.baseUrl() + "/" });
        };
        const btnCs = $("btnConventionScraper");
        if (btnCs) {
            btnCs.onclick = () => {
                chrome.tabs.create({
                    url: chrome.runtime.getURL("lmw-convention-scraper.html"),
                });
            };
        }
        $("btnMore").onclick = () => loadList({ reset: false });

        const combosList = $("mmTagCombosList");
        if (combosList) {
            combosList.addEventListener("click", (e) => {
                const btn = e.target.closest(".mm-tag-combo");
                if (!btn) return;
                e.preventDefault();
                e.stopPropagation();
                copyTagCombo(btn.getAttribute("data-tags") || "", btn);
            });
        }

        const reloadDebounced = debounce(() => loadList({ reset: true }), 300);
        $("mmQ").addEventListener("input", reloadDebounced);
        ["mmType", "mmTag", "mmLiked", "mmSort"].forEach((id) => {
            $(id).addEventListener("change", () => loadList({ reset: true }));
        });

        $("btnSelPage").onclick = () => {
            const ids = visibleCardIds();
            ids.forEach((id) => state.selected.add(id));
            if (ids.length) state.selAnchorId = ids[ids.length - 1];
            updateSelUi();
        };
        $("btnSelClear").onclick = () => {
            state.selected.clear();
            state.selAnchorId = null;
            updateSelUi();
        };
        $("btnBatchMerge").onclick = () => batchTags("merge");
        $("btnBatchReplace").onclick = () => batchTags("replace");
        $("btnBatchDel").onclick = () => batchDelete();
        const btnJasna = $("btnBatchJasna");
        if (btnJasna) btnJasna.onclick = () => batchJasna();
        const btnDedupe = $("btnDedupe");
        if (btnDedupe) btnDedupe.onclick = () => oneClickDedupe();

        // Tag library autocomplete: batch bar / upload / edit modal
        if (typeof LMW.attachTagAutocomplete === "function") {
            const hintToStatus = (msg) => {
                if (msg) setStatus(msg);
            };
            tagAc.batch = LMW.attachTagAutocomplete($("mmBatchTags"), {
                onHint: hintToStatus,
                captureEnter: true,
            });
            tagAc.upload = LMW.attachTagAutocomplete($("mmUploadTags"), {
                onHint: hintToStatus,
                captureEnter: true,
            });
            tagAc.edit = LMW.attachTagAutocomplete($("mmEditTagsInput"), {
                captureEnter: true,
                showHint: true,
            });
        }

        $("mmFiles").addEventListener("change", (e) => {
            addPendingFiles(e.target.files);
            // allow re-selecting the same path later
            e.target.value = "";
        });
        $("btnUpload").onclick = () => runUploadQueue();
        $("btnClearPending").onclick = () => clearPendingFiles();
        const restrictedCb = $("mmRestricted");
        if (restrictedCb) {
            restrictedCb.checked = !!(G && G.lmwRestricted);
            restrictedCb.addEventListener("change", () => {
                const on = !!restrictedCb.checked;
                if (typeof G !== "undefined") G.lmwRestricted = on;
                try {
                    chrome.storage.sync.set({ lmwRestricted: on });
                    chrome.storage.local.set({ lmwRestricted: on });
                } catch (e) { /* ignore */ }
            });
        }
        const drop = $("mmDrop");
        ["dragenter", "dragover"].forEach((ev) => {
            drop.addEventListener(ev, (e) => {
                e.preventDefault();
                e.stopPropagation();
                drop.classList.add("drag");
            });
        });
        drop.addEventListener("dragleave", (e) => {
            e.preventDefault();
            e.stopPropagation();
            // only clear when leaving the drop zone itself
            if (!drop.contains(e.relatedTarget)) drop.classList.remove("drag");
        });
        drop.addEventListener("drop", (e) => {
            e.preventDefault();
            e.stopPropagation();
            drop.classList.remove("drag");
            const files = e.dataTransfer && e.dataTransfer.files;
            if (files && files.length) addPendingFiles(files);
        });

        // Prevent checkbox default toggle on Shift+click so range-select isn't undone by native flip
        $("mmGrid").addEventListener("mousedown", (e) => {
            const t = e.target;
            if (e.shiftKey && t.classList && t.classList.contains("mm-card-check")) {
                e.preventDefault();
            }
        });

        $("mmGrid").addEventListener("click", (e) => {
            const t = e.target;
            // Checkbox: normal toggle, or Shift+click continuous range from last anchor
            if (t.classList.contains("mm-card-check")) {
                const id = Number(t.dataset.id);
                if (e.shiftKey) {
                    e.preventDefault();
                    applyCardSelection(id, { shiftKey: true });
                    return;
                }
                applyCardSelection(id, { shiftKey: false, checked: !!t.checked });
                return;
            }
            // Shift+click on card body (not action buttons / restricted toggle): range select
            if (e.shiftKey) {
                const card = t.closest(".mm-card");
                if (
                    card &&
                    !t.closest("[data-act]") &&
                    !t.classList.contains("mm-restricted-toggle") &&
                    !t.closest(".mm-card-restricted")
                ) {
                    e.preventDefault();
                    applyCardSelection(Number(card.dataset.id), { shiftKey: true });
                    return;
                }
            }
            const btn = t.closest("[data-act]");
            if (btn) {
                e.preventDefault();
                onCardAction(btn.dataset.act, Number(btn.dataset.id));
                return;
            }
            const prev = t.closest("[data-preview]");
            if (prev) {
                openPreview(Number(prev.dataset.preview));
            }
        });
        // Card checkboxes are handled only in click (change has no reliable shiftKey and would undo range select)
        $("mmGrid").addEventListener("change", async (e) => {
            const t = e.target;
            if (t.classList.contains("mm-restricted-toggle")) {
                const id = Number(t.dataset.id);
                const on = !!t.checked;
                t.disabled = true;
                try {
                    const item = await LMW.patchMedia(id, { restricted: on });
                    const idx = state.items.findIndex((x) => x.id === id);
                    if (idx >= 0) state.items[idx] = { ...state.items[idx], ...item };
                    const merged = idx >= 0 ? state.items[idx] : item;
                    const card = $("mmGrid").querySelector(`.mm-card[data-id="${id}"]`);
                    if (card && merged) {
                        const wrap = document.createElement("div");
                        wrap.innerHTML = cardHtml(merged);
                        const next = wrap.firstElementChild;
                        if (next) {
                            card.replaceWith(next);
                            observeThumbs($("mmGrid"));
                            updateSelUi();
                        }
                    }
                    setStatus(
                        on
                            ? `已标记 #${id} 为限制级`
                            : `已取消 #${id} 限制级`
                    );
                    await loadTagOptions();
                } catch (err) {
                    t.checked = !on;
                    setStatus("限制级切换失败：" + (err.message || err));
                } finally {
                    t.disabled = false;
                }
            }
        });

        $("mmPreviewClose").onclick = closePreview;
        $("mmPreview").addEventListener("click", (e) => {
            if (e.target.id === "mmPreview") closePreview();
        });
        $("mmEditCancel").onclick = closeEdit;
        $("mmEditSave").onclick = saveEdit;
        $("mmEdit").addEventListener("click", (e) => {
            if (e.target.id === "mmEdit") closeEdit();
        });

        window.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                if (!$("mmEdit").classList.contains("hide")) closeEdit();
                else if (!$("mmPreview").classList.contains("hide")) closePreview();
            }
        });

        // Infinite scroll near bottom
        window.addEventListener(
            "scroll",
            debounce(() => {
                if (state.loading || state.items.length >= state.total) return;
                const near =
                    window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 400;
                if (near) loadList({ reset: false });
            }, 150),
            { passive: true }
        );

        window.addEventListener("beforeunload", () => {
            if (typeof LMW.revokeAllBlobUrls === "function") LMW.revokeAllBlobUrls();
        });
    }

    async function main() {
        await waitGReady();
        bind();
        await checkHealth();
        await loadTagOptions();
        loadTagCombos();
        await loadList({ reset: true });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", main);
    } else {
        main();
    }
})();
