/**
 * Extension-owned tag dialog for page float-ingest (isolated from host page).
 * Uses LMW tag library: suggestions + autocomplete + soft near-duplicate fix.
 * Opened by background via chrome.windows.create.
 */
(function () {
    const params = new URLSearchParams(location.search);
    const rid = params.get("rid") || "";

    let tags = [];
    let suggestions = [];
    let libraryTags = [];
    let librarySize = 0;
    let payload = null;
    let finished = false;
    let acItems = [];
    let acIndex = -1;

    const $ = (id) => document.getElementById(id);
    const chipsEl = $("chips");
    const sugEl = $("sug");
    const input = $("input");
    const acEl = $("ac");
    const errEl = $("err");
    const softEl = $("soft");
    const libHint = $("libHint");
    const metaEl = $("meta");
    const heading = $("heading");

    function L() {
        return typeof LMW !== "undefined" ? LMW : null;
    }

    function normalizeTags(raw) {
        const lmw = L();
        if (lmw && typeof lmw.normalizeTags === "function") {
            return lmw.normalizeTags(raw);
        }
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
                .replace(/\s+/g, "-")
                .replace(/[^\w\u4e00-\u9fff\-+.#]/gi, "")
                .slice(0, 32);
            if (!name || seen.has(name)) continue;
            seen.add(name);
            out.push(name);
        }
        return out;
    }

    function canonicalTag(name) {
        const lmw = L();
        if (lmw && typeof lmw.canonicalTag === "function") return lmw.canonicalTag(name);
        return normalizeTags([name])[0] || "";
    }

    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function countMap() {
        const m = new Map();
        for (const row of libraryTags) {
            const n = canonicalTag(row.name || row);
            if (n) m.set(n, Number(row.count) || 0);
        }
        return m;
    }

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
        const lmw = L();
        const q = (input.value || "").trim().replace(/^#/, "");
        // only last segment for multi-comma
        const parts = q.split(/[,，;；]/);
        const seg = (parts[parts.length - 1] || "").trim();
        if (!seg || !lmw || typeof lmw.matchTags !== "function") {
            hideAc();
            setSoft("");
            return;
        }
        const exclude = normalizeTags(parts.slice(0, -1).concat(tags));
        acItems = lmw.matchTags(seg, libraryTags, { limit: 8, exclude });
        acIndex = acItems.length ? 0 : -1;
        renderAc();
        const nd =
            typeof lmw.nearDuplicateTag === "function"
                ? lmw.nearDuplicateTag(seg, libraryTags, { minCount: 2 })
                : null;
        if (nd && nd !== canonicalTag(seg) && !tags.includes(nd)) {
            const c = countMap().get(nd) || 0;
            setSoft(`库中相似：#${nd}${c ? `（${c} 次）` : ""} · Tab/↑↓ 选用`);
        } else {
            setSoft(acItems.length ? "↑↓ 选择 · Enter/Tab 确认" : "");
        }
    }

    function applyAc(idx) {
        if (idx < 0 || idx >= acItems.length) return false;
        const name = acItems[idx].name;
        const raw = input.value || "";
        if (/[,，;；]/.test(raw)) {
            const parts = raw.split(/[,，;；]/);
            const head = parts
                .slice(0, -1)
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
                          c > 0 ? `<span class="cnt">×${c}</span>` : "";
                      return `<span class="chip">#${escapeHtml(t)}${badge}<button type="button" data-rm="${i}" aria-label="移除">×</button></span>`;
                  })
                  .join("")
            : `<span class="empty">暂无，请点建议或输入</span>`;

        sugEl.innerHTML = suggestions.length
            ? suggestions
                  .map((s) => {
                      const on = tags.includes(s);
                      const c = cmap.get(s);
                      const cnt = c > 0 ? `<span class="cnt">×${c}</span>` : "";
                      return `<button type="button" class="sug${on ? " on" : ""}" data-tag="${escapeHtml(s)}">${on ? "✓ " : "+ "}#${escapeHtml(s)}${cnt}</button>`;
                  })
                  .join("")
            : `<span class="empty">无自动建议</span>`;

        input.placeholder = tags.length
            ? `已选 ${tags.length} 个 · 继续输入联想`
            : "输入标签，从库中联想…";
    }

    function addTag(raw, options = {}) {
        const softCorrect = options.softCorrect !== false;
        const lmw = L();
        let next = normalizeTags([raw]);
        if (!next.length) {
            setErr("无效标签");
            return false;
        }
        let t = next[0];
        if (
            softCorrect &&
            lmw &&
            typeof lmw.nearDuplicateTag === "function"
        ) {
            const nd = lmw.nearDuplicateTag(t, libraryTags, { minCount: 2 });
            if (nd && nd !== t) {
                setSoft(`已将 #${t} 规范为库内 #${nd}`);
                t = nd;
            }
        }
        if (tags.includes(t)) {
            setErr(`已包含 #${t}`);
            return false;
        }
        tags = normalizeTags([...tags, t]);
        setErr("");
        render();
        return true;
    }

    function removeTag(i) {
        if (i < 0 || i >= tags.length) return;
        tags.splice(i, 1);
        setErr("");
        render();
    }

    function toggleTag(t) {
        const name = canonicalTag(t);
        const i = tags.indexOf(name);
        if (i >= 0) removeTag(i);
        else addTag(name, { softCorrect: false });
    }

    function finish(result) {
        if (finished) return;
        finished = true;
        const lmw = L();
        if (result && result.ok && lmw && typeof lmw.invalidateTagLibrary === "function") {
            lmw.invalidateTagLibrary();
        }
        chrome.runtime.sendMessage(
            {
                Message: "lmwTagDialogResult",
                requestId: rid,
                result,
            },
            () => {
                /* background closes window */
            }
        );
    }

    chipsEl.addEventListener("click", (e) => {
        const rm = e.target.closest("[data-rm]");
        if (rm) removeTag(Number(rm.getAttribute("data-rm")));
    });
    sugEl.addEventListener("click", (e) => {
        const b = e.target.closest("[data-tag]");
        if (b && !b.disabled) toggleTag(b.getAttribute("data-tag") || "");
    });
    acEl.addEventListener("mousedown", (e) => {
        const hit = e.target.closest("[data-ac]");
        if (!hit) return;
        e.preventDefault();
        applyAc(Number(hit.getAttribute("data-ac")));
    });
    input.addEventListener("input", () => updateAcFromInput());
    input.addEventListener("keydown", (e) => {
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
        if (e.key === "Tab" && acItems.length && acIndex >= 0) {
            e.preventDefault();
            applyAc(acIndex);
            return;
        }
        if (e.key === "Escape" && acItems.length) {
            e.preventDefault();
            hideAc();
            return;
        }
        if (e.key === "Enter") {
            e.preventDefault();
            if (acItems.length && acIndex >= 0) {
                applyAc(acIndex);
                return;
            }
            const v = input.value.trim();
            if (!v) return;
            v.split(/[,，;；]+/)
                .map((s) => s.trim())
                .filter(Boolean)
                .forEach((p) => addTag(p, { softCorrect: true }));
            input.value = "";
            hideAc();
            render();
        }
    });

    function readRestricted() {
        const cb = $("dlgRestricted");
        return !!(cb && cb.checked);
    }
    function persistRestricted(on) {
        try {
            if (typeof G !== "undefined") G.lmwRestricted = on;
            chrome.storage.sync.set({ lmwRestricted: on });
            chrome.storage.local.set({ lmwRestricted: on });
        } catch (e) { /* ignore */ }
    }

    $("btnCancel").onclick = () =>
        finish({ ok: false, cancelled: true, tags: [], restricted: false });
    $("btnSkip").onclick = () => {
        const rs = readRestricted();
        persistRestricted(rs);
        finish({ ok: true, tags: [], restricted: rs });
    };
    $("btnOk").onclick = () => {
        const leftover = input.value.trim();
        if (leftover) {
            leftover
                .split(/[,，;；]+/)
                .map((s) => s.trim())
                .filter(Boolean)
                .forEach((p) => addTag(p, { softCorrect: true }));
            input.value = "";
        }
        const lmw = L();
        if (lmw && typeof lmw.nearDuplicateTag === "function") {
            tags = tags.map(
                (t) =>
                    lmw.nearDuplicateTag(t, libraryTags, { minCount: 2 }) || t
            );
        }
        tags = normalizeTags(tags);
        const rs = readRestricted();
        persistRestricted(rs);
        finish({ ok: true, tags, restricted: rs });
    };

    function waitGReady() {
        return new Promise((resolve) => {
            let n = 0;
            const tick = () => {
                if (
                    typeof G !== "undefined" &&
                    (G.initSyncComplete || G.initLocalComplete || n > 40)
                ) {
                    resolve();
                    return;
                }
                n++;
                setTimeout(tick, 40);
            };
            tick();
        });
    }

    async function enrichFromLibrary(title, url, mtype, sourcePage, baseSuggest) {
        const lmw = L();
        if (!lmw) {
            if (libHint) libHint.textContent = "离线模式 · 无 LMW 客户端";
            return;
        }
        try {
            const [lib, remoteRes] = await Promise.all([
                lmw.getTagLibrary().catch(() => ({ tags: [], total: 0 })),
                lmw
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
            librarySize = lib.total != null ? lib.total : libraryTags.length;
            const remoteTags = remoteRes && remoteRes.tags ? remoteRes.tags : [];
            const local = lmw.suggestTags({
                title,
                url,
                media_type: mtype,
                source_page: sourcePage,
            });
            suggestions = lmw.mergeTagSuggestions({
                title,
                url,
                media_type: mtype,
                source_page: sourcePage,
                local: normalizeTags([...(baseSuggest || []), ...local]),
                remote: remoteTags,
                libraryTags,
                limit: 14,
            });
            if (libHint) {
                libHint.textContent = librarySize
                    ? `标签库 ${librarySize} 个 · 输入时自动匹配`
                    : "标签库为空或服务端不可达 · 仍可用离线建议";
            }
            render();
            if (input.value.trim()) updateAcFromInput();
        } catch (e) {
            if (libHint) libHint.textContent = "标签库加载失败 · 使用离线建议";
        }
    }

    if (!rid) {
        metaEl.textContent = "缺少会话 id";
        return;
    }

    chrome.runtime.sendMessage(
        { Message: "lmwTagDialogGet", requestId: rid },
        async (resp) => {
            if (chrome.runtime.lastError || !resp || !resp.ok) {
                metaEl.textContent = "无法加载媒体信息（窗口可能已过期）";
                return;
            }
            payload = resp.data || {};
            const title = payload.title || "media";
            const url = payload.url || "";
            const mtype = payload.media_type || "";
            const sourcePage = payload.source_page || "";
            const count = payload.count || 1;
            heading.textContent =
                count > 1 ? `入库 ${count} 项媒体` : "入库详情";
            metaEl.innerHTML = `<div><b>标题</b> ${escapeHtml(String(title).slice(0, 160))}</div>
      <div><b>类型</b> ${escapeHtml(mtype || "—")}${count > 1 ? " · 共用标签" : ""}</div>
      <div><b>地址</b> ${escapeHtml(String(url).slice(0, 200))}</div>`;

            const baseSuggest = normalizeTags(
                payload.suggestions || payload.suggest || []
            );
            suggestions = baseSuggest.slice();
            tags = normalizeTags(payload.tags || []);
            render();
            setTimeout(() => input.focus(), 40);

            await waitGReady();
            const rCb = $("dlgRestricted");
            if (rCb) {
                try {
                    rCb.checked = !!(
                        typeof G !== "undefined" && G.lmwRestricted === true
                    );
                } catch (e) {
                    rCb.checked = false;
                }
                rCb.addEventListener("change", () => {
                    persistRestricted(!!rCb.checked);
                });
            }
            // ensure G has lmw settings (init may already)
            await enrichFromLibrary(title, url, mtype, sourcePage, baseSuggest);
        }
    );
})();
