/**
 * Extension-owned tag dialog (isolated from host page focus steal).
 * Opened by background via chrome.windows.create.
 */
(function () {
    const MAX = 5;
    const params = new URLSearchParams(location.search);
    const rid = params.get("rid") || "";

    let tags = [];
    let suggestions = [];
    let payload = null;
    let finished = false;

    const $ = (id) => document.getElementById(id);
    const chipsEl = $("chips");
    const sugEl = $("sug");
    const input = $("input");
    const errEl = $("err");
    const metaEl = $("meta");
    const heading = $("heading");

    function normalizeTags(raw) {
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
            if (out.length >= MAX) break;
        }
        return out;
    }

    function setErr(msg) {
        errEl.textContent = msg || "";
    }

    function render() {
        chipsEl.innerHTML = tags.length
            ? tags
                  .map(
                      (t, i) =>
                          `<span class="chip">#${escapeHtml(t)}<button type="button" data-rm="${i}" aria-label="移除">×</button></span>`
                  )
                  .join("")
            : `<span class="empty">暂无，请点建议或输入</span>`;

        sugEl.innerHTML = suggestions.length
            ? suggestions
                  .map((s) => {
                      const on = tags.includes(s);
                      const dis = !on && tags.length >= MAX;
                      return `<button type="button" class="sug${on ? " on" : ""}" data-tag="${escapeHtml(s)}" ${dis ? "disabled" : ""}>${on ? "✓ " : "+ "}#${escapeHtml(s)}</button>`;
                  })
                  .join("")
            : `<span class="empty">无自动建议</span>`;
    }

    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function addTag(raw) {
        const next = normalizeTags([raw]);
        if (!next.length) {
            setErr("无效标签");
            return false;
        }
        const t = next[0];
        if (tags.includes(t)) {
            setErr(`已包含 #${t}`);
            return false;
        }
        if (tags.length >= MAX) {
            setErr(`最多 ${MAX} 个标签`);
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
        const i = tags.indexOf(t);
        if (i >= 0) removeTag(i);
        else addTag(t);
    }

    function finish(result) {
        if (finished) return;
        finished = true;
        // 只回报结果；由 background 关窗，避免 onRemoved 与结果竞态成「已取消」
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
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            const v = input.value.trim();
            if (!v) return;
            v.split(/[,，;；]+/)
                .map((s) => s.trim())
                .filter(Boolean)
                .forEach((p) => addTag(p));
            input.value = "";
            render();
        }
    });
    $("btnCancel").onclick = () => finish({ ok: false, cancelled: true, tags: [] });
    $("btnSkip").onclick = () => finish({ ok: true, tags: [] });
    $("btnOk").onclick = () => {
        const leftover = input.value.trim();
        if (leftover) {
            leftover
                .split(/[,，;；]+/)
                .map((s) => s.trim())
                .filter(Boolean)
                .forEach((p) => addTag(p));
            input.value = "";
        }
        finish({ ok: true, tags: normalizeTags(tags) });
    };

    // Load payload from background/session
    if (!rid) {
        metaEl.textContent = "缺少会话 id";
        return;
    }
    chrome.runtime.sendMessage({ Message: "lmwTagDialogGet", requestId: rid }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
            metaEl.textContent = "无法加载媒体信息（窗口可能已过期）";
            return;
        }
        payload = resp.data || {};
        const title = payload.title || "media";
        const url = payload.url || "";
        const mtype = payload.media_type || "";
        const count = payload.count || 1;
        heading.textContent = count > 1 ? `入库 ${count} 项媒体` : "入库详情";
        metaEl.innerHTML = `<div><b>标题</b> ${escapeHtml(String(title).slice(0, 160))}</div>
      <div><b>类型</b> ${escapeHtml(mtype || "—")}${count > 1 ? " · 共用标签" : ""}</div>
      <div><b>地址</b> ${escapeHtml(String(url).slice(0, 200))}</div>`;
        suggestions = normalizeTags(payload.suggestions || payload.suggest || []);
        tags = normalizeTags(payload.tags || []);
        render();
        setTimeout(() => {
            input.focus();
        }, 40);
    });
})();
