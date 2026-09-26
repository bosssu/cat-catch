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
    /** 本次列表是否已跑过「检测可合并项」（手动或下载前自动） */
    let avDetectAttempted = false;
    /** How the grid was filled: sniffed catch list vs DOM parse */
    let listSource = "caught";
    /** key or id -> { pair_index, role } */
    const avPairByKey = new Map();

    /** 多段合并：选序模式 + 按点击顺序的 key 列表 */
    let multiMergeMode = false;
    /** @type {string[]} */
    let multiMergeOrder = [];
    let multiMergeBusy = false;

    /** 手动视音频：先点画面轨再点音轨（无视后缀） */
    let manualAvMode = false;
    let manualAvVideoKey = "";
    let manualAvAudioKey = "";
    let manualAvBusy = false;

    function setStatus(msg, opts) {
        const $el = $("#status");
        $el.text(msg || "");
        $el.toggleClass("is-error", !!(opts && opts.error));
    }

    /** URL host for error lines (no query secrets). */
    function urlHost(url) {
        try {
            return new URL(String(url || "")).host || "?";
        } catch (_) {
            return String(url || "").slice(0, 48) || "?";
        }
    }

    /** Compact item label: role@host title */
    function itemBrief(it, role) {
        const host = urlHost(it && it.url);
        const title = String((it && (it.title || it.name)) || "")
            .replace(/\s+/g, " ")
            .slice(0, 36);
        return `${role || "item"}@${host}${title ? " «" + title + "»" : ""}`;
    }

    function errText(e) {
        if (e == null) return "unknown";
        if (typeof e === "string") return e;
        const stage = e.stage ? `[${e.stage}] ` : "";
        const msg = e.message != null ? String(e.message) : String(e);
        return (stage + msg).replace(/\s+/g, " ").trim().slice(0, 480);
    }

    /**
     * @param {string} stage e.g. fetch|upload|jasna|library
     * @param {string} message
     * @param {object} [extra]
     */
    function makeStageError(stage, message, extra) {
        const e = new Error(String(message || "error"));
        e.stage = stage || "";
        if (extra && typeof extra === "object") {
            Object.keys(extra).forEach((k) => {
                try {
                    e[k] = extra[k];
                } catch (_) {}
            });
        }
        return e;
    }

    /** Format fail list for status bar (multi-line). */
    function formatFailDetails(failDetails, maxLines) {
        const list = failDetails || [];
        if (!list.length) return "";
        const n = maxLines == null ? 10 : maxLines;
        const lines = list.slice(0, n).map((s, i) => `${i + 1}. ${s}`);
        let out = "\n失败详情：\n" + lines.join("\n");
        if (list.length > n) out += `\n…另有 ${list.length - n} 条，见控制台 [merge-av]`;
        return out;
    }

    function normalizePreviewMode(raw) {
        const v = String(raw || "").toLowerCase();
        if (v === "large" || v === "detail" || v === "normal") return v;
        return "";
    }

    function resolvePreviewMode() {
        const fromG = typeof G !== "undefined" ? normalizePreviewMode(G.lmwPreviewMode) : "";
        if (fromG) return fromG;
        if (typeof G !== "undefined" && G.lmwLargePreview) return "large";
        return "normal";
    }

    function getPreviewMode() {
        const el = document.getElementById("lmPreviewMode");
        return normalizePreviewMode(el && el.value) || "normal";
    }

    function applyPreviewMode(mode) {
        const m = normalizePreviewMode(mode) || getPreviewMode();
        const $grid = $("#grid");
        $grid.toggleClass("lm-grid-large", m === "large");
        $grid.toggleClass("lm-grid-detail", m === "detail");
        document.body.classList.toggle("lm-large-preview", m === "large");
        document.body.classList.toggle("lm-detail-preview", m === "detail");
        const el = document.getElementById("lmPreviewMode");
        if (el && el.value !== m) el.value = m;
    }

    function persistPreviewMode(mode) {
        const m = normalizePreviewMode(mode) || "normal";
        if (typeof G !== "undefined") {
            G.lmwPreviewMode = m;
            G.lmwLargePreview = m === "large";
        }
        try {
            chrome.storage.sync.set({ lmwPreviewMode: m, lmwLargePreview: m === "large" });
            chrome.storage.local.set({ lmwPreviewMode: m, lmwLargePreview: m === "large" });
        } catch (e) { /* ignore */ }
    }

    function itemDisplayName(it) {
        return String((it && (it.title || it.downFileName || it.name || it.url)) || "").trim();
    }

    function formatItemSize(it) {
        const n = Number((it && (it._size || it.fileSize || it.contentLength)) || 0);
        if (!n) return "";
        if (n < 1024) return n + " B";
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
        if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
        return (n / (1024 * 1024 * 1024)).toFixed(2) + " GB";
    }

    function itemDetailMetaText(it) {
        const type = mediaTypeOf(it);
        const bits = ["类型 " + type];
        const d = Number(it && it._durationSec);
        if (Number.isFinite(d) && d > 0.05) bits.push("时长 " + formatSecHms(d));
        else if (it && it._durationProbing) bits.push("时长 …");
        if (it && it._w && it._h) bits.push(it._w + "×" + it._h);
        const v = shortCodecName(it && it._vcodec);
        const a = shortCodecName(it && it._acodec);
        const codec = [v, a].filter(Boolean).join("+");
        if (codec) bits.push("编码 " + codec);
        else if (it && it._codecProbing) bits.push("编码 …");
        const sz = formatItemSize(it);
        if (sz) bits.push(sz);
        if (it && it._iosOk === false) bits.push("iOS 不兼容");
        if (type === "video" && !v && a) bits.push("可能是伪装音频");
        return bits.join(" · ");
    }

    function refreshCardDetail($card, it) {
        if (!$card || !$card.length || !it) return;
        let $d = $card.find(".lm-card-detail");
        if (!$d.length) {
            $d = $("<div class='lm-card-detail'/>");
            $card.append($d);
        }
        const name = itemDisplayName(it) || "(无标题)";
        let $name = $d.find(".lm-detail-name");
        if (!$name.length) $name = $("<div class='lm-detail-name'/>").appendTo($d);
        $name.text(name).attr("title", name);
        let $meta = $d.find(".lm-detail-meta");
        if (!$meta.length) $meta = $("<div class='lm-detail-meta'/>").appendTo($d);
        $meta.text(itemDetailMetaText(it));
        let $url = $d.find(".lm-detail-url");
        if (!$url.length) $url = $("<div class='lm-detail-url'/>").appendTo($d);
        $url.text(it.url || "");
    }

    function updateMultiMergeBtn() {
        const btn = document.getElementById("btnMultiMerge");
        if (!btn) return;
        if (multiMergeBusy) {
            btn.disabled = true;
            btn.textContent = "合并中…";
            return;
        }
        btn.disabled = false;
        if (!multiMergeMode) {
            btn.textContent = "多段合并";
            btn.classList.remove("lm-mm-active");
            return;
        }
        const n = multiMergeOrder.length;
        btn.textContent = n > 0 ? `开始合并 (${n})` : "开始合并";
        btn.classList.add("lm-mm-active");
    }

    function applyMmOrderMarks() {
        $("#grid .lm-card").each(function () {
            const $card = $(this);
            const key = $card.attr("data-key");
            const idx = multiMergeOrder.indexOf(key);
            $card.toggleClass("lm-mm-picked", idx >= 0);
            $card.find(".lm-mm-order").remove();
            if (idx >= 0) {
                $card.append($("<span class='lm-mm-order' aria-hidden='true'/>").text(String(idx + 1)));
            }
        });
    }

    function exitMultiMergeMode() {
        multiMergeMode = false;
        multiMergeOrder = [];
        document.body.classList.remove("lm-multi-merge-mode");
        applyMmOrderMarks();
        updateMultiMergeBtn();
    }

    function enterMultiMergeMode() {
        if (manualAvMode) exitManualAvMode();
        multiMergeMode = true;
        multiMergeOrder = [];
        document.body.classList.add("lm-multi-merge-mode");
        applyMmOrderMarks();
        updateMultiMergeBtn();
        setStatus("多段合并：请按拼接顺序依次点击卡片（再点取消）；选完后点「开始合并」。Esc 取消。");
    }

    function updateManualAvBtn() {
        const btn = document.getElementById("btnManualAvMerge");
        if (!btn) return;
        if (manualAvBusy) {
            btn.disabled = true;
            btn.textContent = "合并中…";
            return;
        }
        btn.disabled = false;
        if (!manualAvMode) {
            btn.textContent = "手动视音频合并";
            btn.classList.remove("lm-mm-active");
            return;
        }
        const n = (manualAvVideoKey ? 1 : 0) + (manualAvAudioKey ? 1 : 0);
        btn.textContent = n >= 2 ? "提交合并" : `选画面/音轨 (${n}/2)`;
        btn.classList.add("lm-mm-active");
    }

    function applyManualAvMarks() {
        $("#grid .lm-card").each(function () {
            const $card = $(this);
            const key = $card.attr("data-key");
            $card.removeClass("lm-mav-v lm-mav-a");
            $card.find(".lm-mav-badge").remove();
            if (key && key === manualAvVideoKey) {
                $card.addClass("lm-mav-v");
                $card.append($("<span class='lm-mav-badge' aria-hidden='true'/>").text("V"));
            } else if (key && key === manualAvAudioKey) {
                $card.addClass("lm-mav-a");
                $card.append($("<span class='lm-mav-badge' aria-hidden='true'/>").text("A"));
            }
        });
    }

    function exitManualAvMode() {
        manualAvMode = false;
        manualAvVideoKey = "";
        manualAvAudioKey = "";
        document.body.classList.remove("lm-manual-av-mode");
        applyManualAvMarks();
        updateManualAvBtn();
    }

    function enterManualAvMode() {
        if (multiMergeMode) exitMultiMergeMode();
        manualAvMode = true;
        manualAvVideoKey = "";
        manualAvAudioKey = "";
        document.body.classList.add("lm-manual-av-mode");
        applyManualAvMarks();
        updateManualAvBtn();
        setStatus("手动视音频：先点画面轨（V），再点音轨（A）。后缀不当视频也没关系。Esc 取消。");
    }

    function toggleManualAvPick(key) {
        if (!key) return;
        const it = items.find((x) => x._key === key);
        if (!it) return;
        const t = mediaTypeOf(it);
        if (t === "image" || t === "gif") {
            setStatus("手动合并只支持视频/音频（含伪装成视频后缀的音频）");
            return;
        }
        if (key === manualAvVideoKey) {
            manualAvVideoKey = "";
        } else if (key === manualAvAudioKey) {
            manualAvAudioKey = "";
        } else if (!manualAvVideoKey) {
            manualAvVideoKey = key;
        } else if (!manualAvAudioKey) {
            manualAvAudioKey = key;
        } else {
            manualAvAudioKey = key;
        }
        applyManualAvMarks();
        updateManualAvBtn();
        const v = manualAvVideoKey ? "已选 V" : "未选 V";
        const a = manualAvAudioKey ? "已选 A" : "未选 A";
        setStatus(
            "手动视音频：" +
                v +
                " · " +
                a +
                (manualAvVideoKey && manualAvAudioKey ? " · 点「提交合并」" : " · 再点另一条")
        );
    }

    async function onManualAvBtnClick() {
        if (manualAvBusy) return;
        if (!manualAvMode) {
            enterManualAvMode();
            return;
        }
        if (!manualAvVideoKey || !manualAvAudioKey) {
            setStatus("请先点画面轨再点音轨（共 2 条），或 Esc 取消");
            return;
        }
        const v = items.find((x) => x._key === manualAvVideoKey);
        const a = items.find((x) => x._key === manualAvAudioKey);
        if (!v || !a) {
            setStatus("所选条目已不在列表中");
            exitManualAvMode();
            return;
        }
        manualAvBusy = true;
        updateManualAvBtn();
        try {
            await mergeSelectedAv([
                {
                    source: "page",
                    video_key: v._key,
                    audio_key: a._key,
                    video_item: v,
                    audio_item: a,
                    pair_index: 0,
                    score: 1,
                    manual: true,
                },
            ]);
        } finally {
            manualAvBusy = false;
            exitManualAvMode();
            updateManualAvBtn();
        }
    }

    /**
     * 多段选序：点击卡片加入/移出顺序。
     */
    function toggleMultiMergePick(key, $card) {
        const i = multiMergeOrder.indexOf(key);
        if (i >= 0) {
            multiMergeOrder.splice(i, 1);
        } else {
            const it = items.find((x) => x._key === key);
            if (!it) return;
            const t = mediaTypeOf(it);
            if (t === "image" || t === "gif") {
                setStatus("多段合并仅支持视频/音频/m3u8，已跳过图片");
                return;
            }
            multiMergeOrder.push(key);
        }
        if ($card && $card.length) {
            // 全表重刷序号（中间项移除后需重编号）
            applyMmOrderMarks();
        } else {
            applyMmOrderMarks();
        }
        updateMultiMergeBtn();
        const n = multiMergeOrder.length;
        setStatus(
            n
                ? `多段合并：已选 ${n} 项（按序号拼接）· 再点卡片可取消 · 点「开始合并」执行`
                : "多段合并：请按顺序点击卡片"
        );
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

    function itemNeedsDurationBadge(it) {
        if (!it) return false;
        const t = mediaTypeOf(it);
        return t === "video" || t === "audio" || t === "m3u8" || t === "dash";
    }

    /** 底部时长角标（预估） */
    function updateCardDurationBadge($card, it) {
        if (!$card || !$card.length || !it) return;
        $card.find(".dur-badge").remove();
        if (!itemNeedsDurationBadge(it)) return;
        const d = Number(it._durationSec);
        if (Number.isFinite(d) && d > 0.05) {
            const label = formatSecHms(d);
            $card.append(
                $("<span class='dur-badge'/>")
                    .text(label)
                    .attr("title", "预估时长 " + label + "（" + d.toFixed(1) + "s）")
            );
            return;
        }
        if (it._durationProbing) {
            $card.append(
                $("<span class='dur-badge is-pending'/>").text("…").attr("title", "正在探测时长")
            );
        }
    }

    function shortCodecName(name) {
        const n = String(name || "").toLowerCase();
        if (!n) return "";
        if (/avc|h264/.test(n)) return "H.264";
        if (/hvc|hev|hevc/.test(n)) return "HEVC";
        if (/av01|\bav1\b/.test(n)) return "AV1";
        if (/vp09|vp9/.test(n)) return "VP9";
        if (/vp08|vp8/.test(n)) return "VP8";
        if (/mp4a|aac/.test(n)) return "AAC";
        if (/opus/.test(n)) return "Opus";
        if (/vorbis/.test(n)) return "Vorbis";
        if (n === "webm" || n === "mkv") return n;
        return n.split(".")[0].slice(0, 10);
    }

    function declaredCodecsIosOk(s) {
        const t = String(s || "").toLowerCase().replace(/\s+/g, "");
        if (!t) return null;
        if (/(?:^|[,/;])(?:av01|av1\.|vp09|vp08|vp9|vp8|theora|opus|vorbis)/.test("," + t)) {
            return false;
        }
        if (/avc1|avc3|hvc1|hev1|h264|hevc|dvh1|dvhe/.test(t)) return true;
        return null;
    }

    function applyCodecInfo(it, info) {
        if (!it || !info) return;
        if (info.vcodec) it._vcodec = String(info.vcodec);
        if (info.acodec) it._acodec = String(info.acodec);
        if (info.declared) it._codecDeclared = String(info.declared);
        if (info.ios_ok === false) {
            it._iosOk = false;
            it._iosReason = info.ios_reason || it._iosReason || "";
        } else if (info.ios_ok === true && it._iosOk !== false) {
            it._iosOk = true;
        }
        it._codecMethod = info.method || it._codecMethod || "";
        onCodecReady(it);
    }

    function inferCodecFromUrl(it) {
        const path = String((it && it.url) || "")
            .split("?")[0]
            .toLowerCase();
        if (!/\.(webm|mkv|avi|ogv|ogg)$/.test(path)) return false;
        applyCodecInfo(it, {
            vcodec: it._vcodec || (/\.webm$/.test(path) ? "webm" : path.replace(/^.*\./, "")),
            ios_ok: false,
            ios_reason: "iPhone cannot play this container (need mp4)",
            method: "ext",
        });
        return true;
    }

    function updateCardCodecBadge($card, it) {
        if (!$card || !$card.length || !it) return;
        $card.find(".codec-badge").remove();
        $card.removeClass("ios-bad");
        const t = mediaTypeOf(it);
        if (t === "image" || t === "gif") return;
        const v = shortCodecName(it._vcodec);
        const a = shortCodecName(it._acodec);
        const label = [v, a].filter(Boolean).join("+");
        const pending = !!it._codecProbing && !label;
        if (!label && it._iosOk !== false && !pending) return;
        const text =
            it._iosOk === false ? (label ? "iOS× " + label : "iOS×") : pending ? "…" : label;
        $card.append(
            $("<span class='codec-badge'/>")
                .toggleClass("is-bad", it._iosOk === false)
                .toggleClass("is-pending", pending)
                .text(text)
                .attr(
                    "title",
                    it._iosReason ||
                        (label
                            ? "编码 " + [it._vcodec, it._acodec].filter(Boolean).join(" + ")
                            : "正在探测编码")
                )
        );
        if (it._iosOk === false) $card.addClass("ios-bad");
    }

    function onCodecReady(it) {
        if (!it || !it._key) return;
        const $card = findCardByKey(it._key);
        if ($card.length) {
            updateCardCodecBadge($card, it);
            refreshCardDetail($card, it);
        }
    }

    function parseHlsDeclaredCodecs(text) {
        const found = [];
        const re = /CODECS=(?:"([^"]+)"|([^,\s]+))/gi;
        let m;
        while ((m = re.exec(String(text || "")))) {
            const s = (m[1] || m[2] || "").trim();
            if (s) found.push(s);
        }
        return found;
    }

    function parseDashDeclaredCodecs(xml) {
        const found = [];
        const re = /codecs\s*=\s*"([^"]+)"/gi;
        let m;
        while ((m = re.exec(String(xml || "")))) {
            if (m[1]) found.push(m[1]);
        }
        return found;
    }

    function pickDeclaredForIos(list) {
        const arr = Array.isArray(list) ? list : [];
        let any = "";
        let good = "";
        let bad = "";
        let allBad = arr.length > 0;
        for (const s of arr) {
            any = any || s;
            const ok = declaredCodecsIosOk(s);
            if (ok === true && !good) good = s;
            if (ok === false) bad = s;
            if (ok !== false) allBad = false;
        }
        const split = (s) => {
            const parts = String(s || "")
                .split(",")
                .map((x) => x.trim())
                .filter(Boolean);
            const v = parts.find((p) => !/^mp4a/i.test(p)) || parts[0] || "";
            const a = parts.find((p) => /^mp4a|opus|aac|vorbis/i.test(p)) || "";
            return { vcodec: v, acodec: a };
        };
        if (good) {
            return Object.assign({ declared: good, ios_ok: true, method: "playlist" }, split(good));
        }
        if (allBad && bad) {
            return Object.assign(
                {
                    declared: bad,
                    ios_ok: false,
                    ios_reason: "playlist CODECS=" + bad,
                    method: "playlist",
                },
                split(bad)
            );
        }
        if (any) {
            const ok = declaredCodecsIosOk(any);
            return Object.assign(
                {
                    declared: any,
                    ios_ok: ok,
                    method: "playlist",
                    ios_reason: ok === false ? "playlist CODECS=" + any : "",
                },
                split(any)
            );
        }
        return null;
    }

    function itemProbeHeaders(it) {
        const headers = {};
        const src = (it && it._headers) || {};
        for (const [k, v] of Object.entries(src)) {
            if (v == null || v === "") continue;
            if (/^(referer|cookie|user-agent|origin|authorization)$/i.test(k)) {
                headers[k] = String(v);
            }
        }
        return headers;
    }

    async function probePlaylistCodecs(it) {
        const url = it && it.url;
        if (!url || !/^https?:/i.test(String(url))) return null;
        const headers = itemProbeHeaders(it);
        const t = mediaTypeOf(it);
        try {
            const res = await fetch(url, {
                headers,
                credentials: "omit",
                cache: "no-store",
            });
            if (res.ok) {
                const text = await res.text();
                const list =
                    t === "dash" ? parseDashDeclaredCodecs(text) : parseHlsDeclaredCodecs(text);
                const picked = pickDeclaredForIos(list);
                if (picked) return picked;
            }
        } catch (_) {}
        return null;
    }

    async function probeCodecViaServer(it) {
        if (!it || !it.url || typeof LMW === "undefined" || !LMW.probeUrl) return null;
        try {
            const r = await LMW.probeUrl({
                url: it.url,
                headers: itemProbeHeaders(it),
                max_bytes: 4 * 1024 * 1024,
            });
            if (!r) return null;
            applyCodecInfo(it, {
                vcodec: r.vcodec,
                acodec: r.acodec,
                ios_ok: r.ios_ok,
                ios_reason: r.ios_reason,
                method: "server_partial",
            });
            if (r.media_type) {
                it.media_type = r.media_type;
                it._contentRole = r.role || it._contentRole;
            }
            if (r.duration_sec != null && Number(r.duration_sec) > 0.05 && !(it._durationSec > 0.05)) {
                it._durationSec = Number(r.duration_sec);
                onDurationReady(it);
            }
            return r;
        } catch (e) {
            console.warn("probe-url codec failed", it.url, e);
            return null;
        }
    }

    let codecProbeGen = 0;
    const CODEC_PROBE_PARALLEL = 2;

    async function ensureItemCodec(it) {
        if (!it || it._codecDone) return;
        const t = mediaTypeOf(it);
        if (t === "image" || t === "gif") {
            it._codecDone = true;
            return;
        }
        if (it._iosOk === false || it._vcodec) {
            it._codecDone = true;
            onCodecReady(it);
            return;
        }
        it._codecProbing = true;
        onCodecReady(it);
        try {
            if (inferCodecFromUrl(it)) {
                it._codecDone = true;
                return;
            }
            if (t === "m3u8" || t === "dash") {
                const info = await probePlaylistCodecs(it);
                if (info) applyCodecInfo(it, info);
                it._codecDone = true;
                return;
            }
            await probeCodecViaServer(it);
            it._codecDone = true;
        } catch (_) {
            it._codecDone = true;
        } finally {
            it._codecProbing = false;
            onCodecReady(it);
        }
    }

    function scheduleCodecProbes(list) {
        const gen = ++codecProbeGen;
        const queue = (list || []).filter((it) => {
            const t = mediaTypeOf(it);
            if (t === "image" || t === "gif") return false;
            return !it._codecDone && !it._vcodec && it._iosOk !== false;
        });
        if (!queue.length) return;
        let i = 0;
        const workers = Array.from(
            { length: Math.min(CODEC_PROBE_PARALLEL, queue.length) },
            async () => {
                while (i < queue.length && gen === codecProbeGen) {
                    const it = queue[i++];
                    if (!it) break;
                    await ensureItemCodec(it);
                }
            }
        );
        Promise.all(workers).catch(() => {});
    }

    function findCardByKey(key) {
        if (key == null) return $();
        return $(
            '#grid .lm-card[data-key="' +
                String(key).replace(/\\/g, "\\\\").replace(/"/g, '\\"') +
                '"]'
        );
    }

    function onDurationReady(it) {
        if (!it || !it._key) return;
        const $card = findCardByKey(it._key);
        if ($card.length) {
            updateCardDurationBadge($card, it);
            refreshCardDetail($card, it);
        }
    }

    /**
     * 为尚无时长的音/视频探测 metadata（限流）。
     * m3u8 优先解析 EXTINF 总和。
     */
    let durationProbeGen = 0;
    const DURATION_PROBE_PARALLEL = 3;

    async function ensureItemDuration(it) {
        if (!it || !itemNeedsDurationBadge(it)) return null;
        if (Number(it._durationSec) > 0.05) return Number(it._durationSec);
        if (it._durationProbeFailed) return null;
        const t = mediaTypeOf(it);
        it._durationProbing = true;
        onDurationReady(it);
        try {
            if (t === "m3u8") {
                const headers = it._headers || {};
                const d = await probeM3u8DurationSec(it.url, headers);
                if (d != null && d > 0.05) {
                    it._durationSec = d;
                    it._m3u8DurationSec = d;
                    return d;
                }
                // fallback: element/hls may not give full playlist duration
            }
            if (t === "audio") {
                // <audio> 对纯音频更稳；video 对伪装成 mp4 的音频也行
                const d = await probeAudioDurationElement(it, 10000);
                if (d != null && d > 0.05) {
                    it._durationSec = d;
                    return d;
                }
            }
            const r = await probeItemWithElement(it, 10000);
            if (r && r.duration_sec > 0.05) {
                it._durationSec = r.duration_sec;
                return r.duration_sec;
            }
            if (!(Number(it._durationSec) > 0.05)) it._durationProbeFailed = true;
            return Number(it._durationSec) > 0.05 ? Number(it._durationSec) : null;
        } catch (_) {
            it._durationProbeFailed = true;
            return null;
        } finally {
            it._durationProbing = false;
            onDurationReady(it);
        }
    }

    function probeAudioDurationElement(it, timeoutMs = 10000) {
        return new Promise((resolve) => {
            const el = document.createElement("audio");
            el.preload = "metadata";
            let done = false;
            const finish = (sec) => {
                if (done) return;
                done = true;
                try {
                    el.removeAttribute("src");
                    el.load();
                } catch (_) {}
                resolve(sec);
            };
            const timer = setTimeout(() => finish(null), timeoutMs);
            el.addEventListener("loadedmetadata", () => {
                clearTimeout(timer);
                const d = el.duration;
                finish(Number.isFinite(d) && d > 0 ? d : null);
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

    function scheduleDurationProbes(list) {
        const gen = ++durationProbeGen;
        const queue = (list || []).filter(
            (it) =>
                itemNeedsDurationBadge(it) &&
                !(Number(it._durationSec) > 0.05) &&
                !it._durationProbeFailed
        );
        if (!queue.length) return;
        let i = 0;
        const workers = Array.from(
            { length: Math.min(DURATION_PROBE_PARALLEL, queue.length) },
            async () => {
                while (i < queue.length && gen === durationProbeGen) {
                    const it = queue[i++];
                    if (!it) break;
                    await ensureItemDuration(it);
                }
            }
        );
        Promise.all(workers).catch(() => {});
    }

    /** 分辨率探测到后刷新角标；若当前筛选项会排除该项则整表重绘 */
    function onDimsReady(it) {
        if (!it || !it._key) return;
        const $card = findCardByKey(it._key);
        if ($card.length) {
            updateCardDimBadge($card, it);
            refreshCardDetail($card, it);
        }
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

    function isJasnaChecked() {
        return !!(document.getElementById("lmUseJasna") && document.getElementById("lmUseJasna").checked);
    }

    function isAutoRemoveChecked() {
        const el = document.getElementById("lmAutoRemove");
        // 默认开：控件缺失时也视为开启
        return !el || !!el.checked;
    }

    function iosBadLine(it) {
        const c = [shortCodecName(it._vcodec), shortCodecName(it._acodec)]
            .filter(Boolean)
            .join("+");
        return (c || it._iosReason || "codec") + " · " + urlHost(it.url);
    }

    /**
     * Probe codecs first, then confirm if any item is not iOS Safari-playable.
     * Confirm = continue ingest even when incompatible (server bypass).
     * @returns {Promise<{ok: boolean, allow: boolean}>}
     */
    async function confirmIosWebIfNeeded(list, opLabel) {
        const arr = (list || []).filter(Boolean);
        if (!arr.length) return { ok: true, allow: false };
        setStatus(opLabel + "：检测 iOS Web 兼容性…");
        await Promise.all(arr.map((it) => ensureItemCodec(it)));
        const iosBad = arr.filter((it) => it._iosOk === false);
        if (!iosBad.length) return { ok: true, allow: false };
        const names = iosBad.slice(0, 4).map(iosBadLine);
        if (
            !confirm(
                iosBad.length +
                    " 项 iPhone Safari 网页可能无法播放（AV1/VP9/WebM/Opus 等）。\n\n" +
                    names.join("\n") +
                    (iosBad.length > 4 ? "\n…" : "") +
                    "\n\n确认后仍会" +
                    opLabel +
                    "（即使不兼容也会写入媒体库）。\n是否继续？"
            )
        ) {
            setStatus("已取消" + opLabel + "（iOS Web 不兼容）");
            return { ok: false, allow: false };
        }
        return { ok: true, allow: true };
    }

    /** jasna 勾选时，入库/合并前二次确认 */
    function confirmJasnaIfNeeded(opLabel) {
        if (!isJasnaChecked()) return true;
        return confirm(
            `已勾选「使用 jasna 去马赛克」。\n` +
                `${opLabel}将提交到本机 JasnaBridge（默认 8791）串行去码，成功后再入库 LocalMediaWeb。\n` +
                `请确认中间件已启动（JasnaBridge\\start.bat）。\n\n是否继续？`
        );
    }

    function isAllFilteredSelected() {
        const list = getFilteredItems();
        return list.length > 0 && list.every((it) => selected.has(it._key));
    }

    function updateSelectAllBtn() {
        const btn = document.getElementById("btnSelectAll");
        if (!btn) return;
        btn.textContent = isAllFilteredSelected() ? "取消全选" : "全选";
    }

    /**
     * 从列表移除指定 key 的项（本地网格，不删服务器）。
     * @param {Iterable<string>} keys
     * @returns {number} 实际移除数量
     */
    function removeItemsByKeys(keys) {
        const drop = keys instanceof Set ? keys : new Set(keys);
        if (!drop.size) return 0;
        const before = items.length;
        items = items.filter((it) => !drop.has(it._key));
        for (const k of drop) selected.delete(k);
        // 清掉涉及已删项的配对
        if (avPairs.length) {
            avPairs = avPairs.filter((p) => {
                if (p.source === "page") {
                    return !(drop.has(p.video_key) || drop.has(p.audio_key));
                }
                return true;
            });
            avPairByKey.clear();
            for (const p of avPairs) {
                const idx = Number(p.pair_index) || 0;
                if (p.source === "page") {
                    if (p.video_key) avPairByKey.set(p.video_key, { pair_index: idx, role: "video", pair: p });
                    if (p.audio_key) avPairByKey.set(p.audio_key, { pair_index: idx, role: "audio", pair: p });
                } else {
                    if (p.video_id) avPairByKey.set("lib:" + p.video_id, { pair_index: idx, role: "video", pair: p });
                    if (p.audio_id) avPairByKey.set("lib:" + p.audio_id, { pair_index: idx, role: "audio", pair: p });
                }
            }
        }
        return before - items.length;
    }

    function deleteSelectedItems() {
        if (!selected.size) {
            setStatus("请先选择要删除的项");
            return;
        }
        const n = selected.size;
        removeItemsByKeys(new Set(selected));
        render();
        setStatus(`已从列表移除 ${n} 项`);
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
        updateSelectAllBtn();
    }

    function mergeableSelectedItems() {
        return getSelectedItems().filter((it) => {
            const t = mediaTypeOf(it);
            return t !== "image" && t !== "gif";
        });
    }

    /** 手动勾选恰好 2 项时，是否可作为「待合并对」启用按钮 */
    function canManualTwoItemMerge() {
        return mergeableSelectedItems().length === 2 && selected.size === 2;
    }

    function updateMergeBtn() {
        const btn = document.getElementById("btnMergeAvSelected");
        if (!btn) return;
        const n = collectMergePairs().length;
        const pool = mergeableSelectedItems();
        const manual = n === 0 && canManualTwoItemMerge();
        // 已勾 ≥2 个音/视频：可点合并（未检测过会先跑检测）
        const canRun = n > 0 || manual || pool.length >= 2;
        const count = n > 0 ? n : manual ? 1 : 0;
        btn.disabled = !canRun;
        btn.textContent = count > 0 ? `合并选中音视频 (${count})` : "合并选中音视频";
    }

    /**
     * 手动选中 2 项时，内容识别后组成 1 对 page pair。
     * @returns {Promise<object[]>}
     */
    async function buildManualMergePairsFromSelection() {
        const chosen = getSelectedItems();
        if (chosen.length !== 2) return [];
        setStatus("识别选中两项的音/视频角色…");
        for (const it of chosen) {
            const t = mediaTypeOf(it);
            if (t === "m3u8" || t === "dash" || t === "image" || t === "gif") continue;
            if (it._classifyMethod !== "server" && it._classifyMethod !== "element") {
                await classifyItemContent(it);
            }
        }
        let video = null;
        let audio = null;
        for (const it of chosen) {
            const t = mediaTypeOf(it);
            if (t === "video" && !video) video = it;
            else if (t === "audio" && !audio) audio = it;
        }
        // 若仍无法区分：按时长/类型兜底 — 一个有画面一个无画面已由 classify 处理
        if (!video || !audio) {
            // 再试一次：未归为 audio 的 progressive 可能还是 video 扩展名
            const rest = chosen.filter((it) => it !== video && it !== audio);
            for (const it of rest) {
                await classifyItemContent(it);
            }
            video = null;
            audio = null;
            for (const it of chosen) {
                const t = mediaTypeOf(it);
                if (t === "video" && !video) video = it;
                else if (t === "audio" && !audio) audio = it;
            }
        }
        if (!video || !audio) return [];
        return [
            {
                source: "page",
                video_key: video._key,
                audio_key: audio._key,
                video_item: video,
                audio_item: audio,
                pair_index: 0,
                score: 1,
                manual: true,
            },
        ];
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

    function durationMatchScore(d1, d2, absTol, relTol) {
        if (typeof LMWAv !== "undefined" && LMWAv.durationMatchScore) {
            return LMWAv.durationMatchScore(d1, d2, absTol, relTol);
        }
        // Fallback (should not run when lmw-av-utils.js is loaded)
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

    function matchVideoAudioPairs(videos, audios) {
        if (typeof LMWAv !== "undefined" && LMWAv.matchVideoAudioPairs) {
            return LMWAv.matchVideoAudioPairs(videos, audios);
        }
        // Fallback: same seed order + best duration match
        const vOk = (videos || []).filter((v) => v && v._key && Number(v._durationSec) > 0.05);
        const aOk = (audios || []).filter((a) => a && a._key && Number(a._durationSec) > 0.05);
        vOk.forEach((v, i) => {
            if (v._libOrder == null) v._libOrder = i;
        });
        aOk.forEach((a, i) => {
            if (a._libOrder == null) a._libOrder = i;
        });
        const usedV = new Set();
        const usedA = new Set();
        const pairs = [];
        let candidateCount = 0;
        const vKeys = new Set(vOk.map((v) => v._key));
        const seeds = [...vOk, ...aOk].sort(
            (x, y) => Number(x._libOrder || 0) - Number(y._libOrder || 0)
        );
        for (const seed of seeds) {
            if (usedV.has(seed._key) || usedA.has(seed._key)) continue;
            const seedIsV = vKeys.has(seed._key);
            let best = null;
            const others = seedIsV ? aOk : vOk;
            for (const other of others) {
                const ok = seedIsV ? !usedA.has(other._key) : !usedV.has(other._key);
                if (!ok) continue;
                const v = seedIsV ? seed : other;
                const a = seedIsV ? other : seed;
                const sc = durationMatchScore(v._durationSec, a._durationSec);
                if (sc == null || sc < 0.99) continue;
                candidateCount++;
                if (!best || sc > best.score) {
                    best = { v, a, score: sc, delta: v._durationSec - a._durationSec };
                }
            }
            if (!best) continue;
            usedV.add(best.v._key);
            usedA.add(best.a._key);
            pairs.push({
                source: "page",
                video_key: best.v._key,
                audio_key: best.a._key,
                video_item: best.v,
                audio_item: best.a,
                pair_index: pairs.length,
                score: +best.score.toFixed(5),
                delta_sec: best.delta,
                video_duration: best.v._durationSec,
                audio_duration: best.a._durationSec,
            });
        }
        return { pairs, ambiguous: 0, candidateCount, blockedVideos: 0, blockedAudios: 0 };
    }

    /**
     * Content-based type + duration for progressive files.
     * Fast path: browser metadata only (Range/partial — no full file).
     * Slow path: server probe of small head (~4MiB), never full-film download.
     * Merge still does its own full fetch; probe result is not reused as blob cache.
     */
    async function classifyItemContent(it) {
        if (!it || !it.url) return null;
        const t0 = mediaTypeOf(it);
        if (t0 === "m3u8" || t0 === "dash" || t0 === "image" || t0 === "gif") {
            return { media_type: t0, duration_sec: null, method: "skip" };
        }

        // 1) Client first: preload=metadata is usually much faster than server full GET
        const elInfo = await probeItemWithElement(it, 8000);
        if (elInfo && elInfo.media_type) {
            const hasDur = elInfo.duration_sec != null && elInfo.duration_sec > 0.05;
            // Enough for pair detect / manual role when we have type + duration,
            // or clear audio-only (no picture plane — common disguised .mp4 audio)
            if (
                (elInfo.media_type === "audio" || elInfo.media_type === "video") &&
                (hasDur || elInfo.media_type === "audio")
            ) {
                return elInfo;
            }
        }

        // 2) Server: only a few MiB head (+ optional tail), not whole file
        try {
            const headers = {};
            const src = it._headers || {};
            for (const [k, v] of Object.entries(src)) {
                if (v == null || v === "") continue;
                if (/^(referer|cookie|user-agent|origin|authorization)$/i.test(k)) {
                    headers[k] = String(v);
                }
            }
            const r = await LMW.probeUrl({
                url: it.url,
                headers,
                // explicit small cap (server default is also ~4MiB)
                max_bytes: 4 * 1024 * 1024,
            });
            if (r && r.media_type) {
                it.media_type = r.media_type;
                it._contentRole = r.role || "";
                it._durationSec =
                    r.duration_sec != null && Number(r.duration_sec) > 0
                        ? Number(r.duration_sec)
                        : it._durationSec || (elInfo && elInfo.duration_sec) || null;
                it._classifyMethod = r.method || "server_partial";
                applyCodecInfo(it, {
                    vcodec: r.vcodec,
                    acodec: r.acodec,
                    ios_ok: r.ios_ok,
                    ios_reason: r.ios_reason,
                    method: r.method || "server_partial",
                });
                if (r.vcodec || r.ios_ok === false) it._codecDone = true;
                // Prefer client duration if server partial lost moov
                if (!(it._durationSec > 0) && elInfo && elInfo.duration_sec > 0) {
                    it._durationSec = elInfo.duration_sec;
                }
                return {
                    media_type: r.media_type,
                    duration_sec: it._durationSec,
                    role: r.role,
                    method: r.method,
                    truncated: !!r.truncated,
                };
            }
        } catch (e) {
            console.warn("probe-url failed", it.url, e);
        }
        return elInfo || null;
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
        (pool || []).forEach((it, i) => {
            if (it) it._libOrder = i;
        });
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
        setStatus(`检测 iOS Web 兼容性… 视频 ${vOk.length} · 音频 ${aOk.length}`);
        await Promise.all([...vOk, ...aOk].map((it) => ensureItemCodec(it)));
        const matched = matchVideoAudioPairs(vOk, aOk);
        const kept = [];
        let skippedIos = 0;
        for (const p of matched.pairs || []) {
            const v = p.video_item || vOk.find((x) => x._key === p.video_key);
            const a = p.audio_item || aOk.find((x) => x._key === p.audio_key);
            if ((v && v._iosOk === false) || (a && a._iosOk === false)) {
                skippedIos++;
                continue;
            }
            kept.push(p);
        }
        return {
            pairs: kept,
            videos: videos.length,
            audios: audios.length,
            probed: classified,
            vOk: vOk.length,
            aOk: aOk.length,
            skippedIos,
            ambiguous: matched.ambiguous,
            candidateCount: matched.candidateCount,
            blockedVideos: matched.blockedVideos,
            blockedAudios: matched.blockedAudios,
        };
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
                avDetectAttempted = true;
                return;
            }
            if (pool.length < 2) {
                setStatus("请至少勾选 2 项（需同时有视频与音频，或伪装成视频的纯音频）");
                clearAvPairs();
                avDetectAttempted = true;
                return;
            }

            // Even video-only selection may contain disguised audio — reclassify first
            const r = await detectPageAvPairs(pool);
            render(); // refresh badges after content type flips
            const ambHint =
                r.ambiguous > 0
                    ? ` · 跳过歧义 ${r.ambiguous}（时长接近多候选，请手动勾选 1 视频+1 音频）`
                    : "";
            const iosHint =
                r.skippedIos > 0
                    ? ` · 已排除 iOS Web 不兼容 ${r.skippedIos} 对（含配套音频）`
                    : "";
            if (r.pairs.length) {
                setAvPairs(r.pairs);
                setStatus(
                    `选中项中找到 ${r.pairs.length} 对可合并（已着色勾选）` +
                        ` · 内容识别后 视频 ${r.videos} · 音频 ${r.audios}` +
                        (r.vOk != null ? ` · 有效时长 V${r.vOk}/A${r.aOk}` : "") +
                        iosHint +
                        ambHint
                );
                return;
            }
            setStatus(
                `选中项中未找到唯一高度匹配对（视频 ${r.videos} · 音频 ${r.audios}` +
                    (r.vOk != null ? ` · 可读时长 V${r.vOk}/A${r.aOk}` : "") +
                    iosHint +
                    ambHint +
                    `）。可手动勾选 1 视频 + 1 音频后合并。`
            );
            clearAvPairs();
        } catch (e) {
            setStatus("检测失败：" + ((e && e.message) || e));
            clearAvPairs();
        } finally {
            avDetectAttempted = true;
            if (btn) btn.disabled = false;
            updateMergeBtn();
        }
    }

    /** 嗅探项的字节大小（popup 会把 size 格式化成字符串，优先 _size） */
    function itemByteSize(it) {
        if (!it) return 0;
        const n = Number(it._size != null ? it._size : typeof it.size === "number" ? it.size : 0);
        return Number.isFinite(n) && n > 0 ? n : 0;
    }

    /**
     * 同组内优先保留：更大文件 / 更高分辨率 / 有 Cookie / 更干净的 URL。
     */
    function preferKeepListItem(a, b) {
        if (!a) return b;
        if (!b) return a;
        const score = (it) => {
            let s = 0;
            s += Math.min(itemByteSize(it) / (1024 * 1024), 500); // 至多 +500
            s += Math.min(Number(it._resMetric) || 0, 4000) / 100;
            if (itemHasCookie(it)) s += 5;
            if (it.score) s += Math.min(Number(it.score) || 0, 50) / 10;
            try {
                const u = new URL(it.url);
                if (!u.search) s += 2;
                if (!/thumb|small|preview|\d+x\d+/i.test(u.pathname)) s += 1;
            } catch (_) {}
            // 稳定：key 更短略优先（先载入的往往 index 更小）
            s -= String(it._key || "").length * 0.0001;
            return s;
        };
        return score(a) >= score(b) ? a : b;
    }

    /**
     * 列表一键去重（仅当前网格，不删服务器）。
     * 与「检测可合并项」相同：先对 progressive 做内容识别（区分视频/音频；
     * 二者可能后缀相同、时长也相同，绝不能跨类型合并为重复）。
     * 同类型内按 URL 去重键 / 大小+时长 指纹归并。
     */
    async function oneClickListDedupe() {
        const btn = document.getElementById("btnListDedupe");
        if (btn) btn.disabled = true;
        const detectBtn = document.getElementById("btnDetectAvMerge");
        if (detectBtn) detectBtn.disabled = true;
        try {
            const pool = selected.size ? getSelectedItems() : items.slice();
            const scopeHint = selected.size ? "已勾选" : "全部列表";
            if (pool.length < 2) {
                setStatus(`${scopeHint}不足 2 项，无需去重`);
                return;
            }

            // 1) 与可合并检测一致：progressive 内容识别（伪装成 .mp4 的纯音频会翻成 audio）
            const progressive = pool.filter((it) => {
                const t = mediaTypeOf(it);
                if (t === "m3u8" || t === "dash" || t === "image" || t === "gif") return false;
                return t === "video" || t === "audio" || !isStreamUrl(it.url, t);
            });
            setStatus(`去重·内容识别… ${progressive.length} 个 progressive（区分视频/音频）`);
            let classified = 0;
            const queue = progressive.slice();
            const workers = Array.from({ length: Math.min(3, queue.length || 1) }, async () => {
                while (queue.length) {
                    const it = queue.shift();
                    if (!it) break;
                    if (
                        it._classifyMethod === "server" ||
                        it._classifyMethod === "server_partial" ||
                        it._classifyMethod === "element"
                    ) {
                        classified++;
                        continue;
                    }
                    await classifyItemContent(it);
                    classified++;
                    if (classified % 3 === 0) {
                        setStatus(`去重·内容识别… ${classified}/${progressive.length}`);
                    }
                }
            });
            if (queue.length) await Promise.all(workers);
            // 刷新角标（类型可能已翻转）
            render();

            // 2) Union-Find：同类型指纹相连才算重复
            const n = pool.length;
            const parent = Array.from({ length: n }, (_, i) => i);
            const find = (i) => {
                while (parent[i] !== i) {
                    parent[i] = parent[parent[i]];
                    i = parent[i];
                }
                return i;
            };
            const unite = (a, b) => {
                const ra = find(a);
                const rb = find(b);
                if (ra !== rb) parent[rb] = ra;
            };
            /** @type {Map<string, number>} */
            const fpIndex = new Map();
            const addFp = (fp, idx) => {
                if (!fp) return;
                if (fpIndex.has(fp)) unite(fpIndex.get(fp), idx);
                else fpIndex.set(fp, idx);
            };

            for (let i = 0; i < n; i++) {
                const it = pool[i];
                const t = mediaTypeOf(it) || "unknown";
                // 关键：类型必须进指纹，防止同时长同后缀的视频/音频被当成同一份
                const urlKey = mediaDedupeKey(it.url) || "raw:" + String(it.url || "").split("?")[0];
                addFp(`u:${t}:${urlKey}`, i);

                // 精确 URL（含 query）同类型
                if (it.url) addFp(`exact:${t}:${String(it.url).toLowerCase()}`, i);

                const sz = itemByteSize(it);
                const dur = Number(it._durationSec) || 0;
                // 同类型 + 相同字节大小 +（有时长时）高度匹配时长 → 强重复信号
                if (sz >= 1024) {
                    if (dur > 0.05) {
                        const dBucket = Math.round(dur * 10); // 0.1s
                        addFp(`sd:${t}:${sz}:${dBucket}`, i);
                    } else if (sz >= 256 * 1024) {
                        // 无时长时仅对较大文件用纯 size（降低误伤）
                        addFp(`s:${t}:${sz}`, i);
                    }
                }
            }

            /** @type {Map<number, typeof pool>} */
            const groups = new Map();
            for (let i = 0; i < n; i++) {
                const r = find(i);
                if (!groups.has(r)) groups.set(r, []);
                groups.get(r).push(pool[i]);
            }

            const dropKeys = new Set();
            let groupCount = 0;
            const previewLines = [];
            for (const g of groups.values()) {
                if (g.length < 2) continue;
                groupCount++;
                let keep = g[0];
                for (let k = 1; k < g.length; k++) keep = preferKeepListItem(keep, g[k]);
                for (const it of g) {
                    if (it._key !== keep._key) dropKeys.add(it._key);
                }
                if (previewLines.length < 8) {
                    const t = mediaTypeOf(keep) || "?";
                    previewLines.push(
                        `· 保留 ${t} · 去掉 ${g.length - 1} 条` +
                            (itemByteSize(keep) ? `（${itemByteSize(keep)} B）` : "") +
                            (keep._durationSec > 0
                                ? ` · ${Number(keep._durationSec).toFixed(1)}s`
                                : "")
                    );
                }
            }

            if (!dropKeys.size) {
                const vN = pool.filter((x) => mediaTypeOf(x) === "video").length;
                const aN = pool.filter((x) => mediaTypeOf(x) === "audio").length;
                setStatus(
                    `去重完成：${scopeHint} ${pool.length} 项中未发现同类型重复` +
                        `（内容识别后 视频 ${vN} · 音频 ${aN}；可合并对不会被去重）`
                );
                return;
            }

            const more =
                groupCount > previewLines.length
                    ? `\n…另有 ${groupCount - previewLines.length} 组`
                    : "";
            const ok = confirm(
                `在${scopeHint}中发现 ${groupCount} 组同类型重复，将从列表移除 ${dropKeys.size} 项（每组保留 1 条）。\n` +
                    `已先按内容识别视频/音频（后缀与时长可能相同，跨类型不会互删）。\n` +
                    `仅影响当前「加入本地媒体库」列表，不删服务器文件。\n\n` +
                    previewLines.join("\n") +
                    more +
                    `\n\n确定执行？`
            );
            if (!ok) {
                setStatus("已取消去重");
                return;
            }
            const removed = removeItemsByKeys(dropKeys);
            render();
            setStatus(
                `去重完成：移除 ${removed} 项 · ${groupCount} 组 · 剩余 ${items.length}` +
                    (selected.size ? "（仅处理了勾选项）" : "")
            );
        } catch (e) {
            setStatus("去重失败：" + ((e && e.message) || e));
        } finally {
            if (btn) btn.disabled = false;
            if (detectBtn) detectBtn.disabled = false;
            updateMergeBtn();
        }
    }

    /**
     * Headers for media fetch (no Origin — extension Origin often triggers CDN ERR_FAILED).
     */
    async function headersForBlobFetch(it) {
        const pageUrl = (it && (it._pageUrl || it.referer)) || (await getPageUrl()) || "";
        let headers = {};
        if (typeof LMW !== "undefined" && LMW.buildHeadersForItem) {
            try {
                headers = await LMW.buildHeadersForItem(it, pageUrl);
            } catch (_) {
                headers = Object.assign({}, (it && it._headers) || {});
            }
        } else {
            headers = Object.assign({}, (it && it._headers) || {});
        }
        // also merge sniffed requestHeaders / cookie field (cat-catch capture shape)
        const sniffed = (it && (it.requestHeaders || it.allRequestHeaders)) || {};
        if (sniffed && typeof sniffed === "object") {
            for (const [k, v] of Object.entries(sniffed)) {
                if (v == null || v === "") continue;
                if (typeof v === "object" && v.value != null) {
                    headers[v.name || k] = String(v.value);
                } else if (headers[k] == null || headers[k] === "") {
                    headers[k] = String(v);
                }
            }
        }
        delete headers.Origin;
        delete headers.origin;
        if (!headers.Referer && !headers.referer) {
            const ref = pageUrl || (it && it.referer) || "";
            if (ref) headers.Referer = ref;
            else if (it && it.url && /douyin|douyinvod/i.test(it.url)) {
                headers.Referer = "https://www.douyin.com/";
            }
        }
        if (!headers["User-Agent"] && !headers["user-agent"] && typeof navigator !== "undefined") {
            headers["User-Agent"] = navigator.userAgent;
        }
        return { headers, pageUrl };
    }

    function getCurrentLmTabId() {
        return new Promise((resolve) => {
            try {
                if (!chrome.tabs || !chrome.tabs.getCurrent) {
                    resolve(0);
                    return;
                }
                chrome.tabs.getCurrent((tab) => {
                    if (chrome.runtime.lastError || !tab || !tab.id) {
                        resolve(0);
                        return;
                    }
                    resolve(tab.id);
                });
            } catch (_) {
                resolve(0);
            }
        });
    }

    /** DNR rule id: 1 .. 2^31-1 */
    function allocFetchRequestId(it) {
        const rid = it && it.requestId != null ? parseInt(it.requestId, 10) : NaN;
        if (Number.isFinite(rid) && rid >= 1 && rid < 0x7fffffff) {
            // salt so concurrent video/audio rules do not clobber each other
            return rid;
        }
        return 900000000 + Math.floor(Math.random() * 90000000);
    }

    /**
     * Build a fragment object compatible with cat-catch setHeaders() + Downloader.
     * Cookie goes on .cookie; other headers on .requestHeaders (DNR injects them).
     */
    async function buildCatFetchFragment(it, role) {
        const { headers, pageUrl } = await headersForBlobFetch(it);
        const requestHeaders = {};
        let cookie =
            (it && (it.cookie || it.Cookie)) ||
            headers.Cookie ||
            headers.cookie ||
            "";
        for (const [k, v] of Object.entries(headers)) {
            if (v == null || v === "") continue;
            if (/^origin$/i.test(k)) continue;
            if (/^cookie$/i.test(k)) {
                if (!cookie) cookie = String(v);
                continue;
            }
            requestHeaders[k] = String(v);
        }
        // cat-catch often uses lowercase "referer"
        if (!requestHeaders.referer && !requestHeaders.Referer) {
            const ref =
                pageUrl ||
                (it && (it.referer || it._pageUrl)) ||
                (it && it.url && /douyin|douyinvod/i.test(it.url)
                    ? "https://www.douyin.com/"
                    : "");
            if (ref) requestHeaders.referer = ref;
        }
        // Ensure at least one header so setHeaders does not skip the item
        if (!Object.keys(requestHeaders).length) {
            requestHeaders.referer = pageUrl || "https://www.douyin.com/";
        }
        let requestId = allocFetchRequestId(it);
        // video/audio pair: distinct rule ids
        if (role === "audio") {
            requestId = (requestId % 100000000) + 800000000;
        } else if (role === "video") {
            requestId = (requestId % 100000000) + 700000000;
        }
        return {
            url: it.url,
            requestId: String(requestId),
            requestHeaders,
            cookie: cookie || undefined,
            _pageUrl: pageUrl,
            _role: role || "media",
        };
    }

    function applyCatSetHeaders(fragments, tabId) {
        return new Promise((resolve, reject) => {
            if (typeof setHeaders !== "function") {
                reject(new Error("setHeaders unavailable (function.js)"));
                return;
            }
            if (!tabId) {
                reject(new Error("no local-media tabId for DNR"));
                return;
            }
            const list = Array.isArray(fragments) ? fragments : [fragments];
            try {
                setHeaders(list, () => resolve(), tabId);
            } catch (e) {
                reject(e);
            }
        });
    }

    /**
     * Clean fetch like Downloader.downloader — headers come from DNR setHeaders, not fetch().
     */
    async function catStyleFetchUrl(url, extraHeaders) {
        const options = {
            redirect: "follow",
            credentials: "omit",
            cache: "no-store",
        };
        if (extraHeaders && Object.keys(extraHeaders).length) {
            options.headers = extraHeaders;
        }
        const res = await fetch(url, options);
        if (!res.ok) {
            const err = new Error(`HTTP ${res.status}`);
            err.cause = "HTTPError";
            err.status = res.status;
            throw err;
        }
        const blob = await res.blob();
        if (!blob || blob.size < 32) {
            throw new Error(`empty body size=${blob ? blob.size : 0}`);
        }
        return blob;
    }

    /**
     * Cat-catch downloader path: setHeaders(urlFilter+tabId) → fetch → Range/Sec-Fetch retries.
     * Same idea as js/downloader.js + m3u8.downloader.js.
     * @param {object} it cat-catch item
     * @param {string} [role] "video"|"audio"|...
     */
    async function fetchItemBlob(it, role) {
        const r = role || "media";
        const brief = itemBrief(it, r);
        if (!it || !it.url) {
            throw makeStageError("fetch", `${r} 无 URL`, { role: r });
        }
        const tabId = await getCurrentLmTabId();
        const frag = await buildCatFetchFragment(it, r);
        const hasCookie = !!frag.cookie;
        const hasReferer = !!(
            frag.requestHeaders &&
            (frag.requestHeaders.referer || frag.requestHeaders.Referer)
        );
        const meta =
            `${brief}` +
            ` dnr=${Object.keys(frag.requestHeaders || {}).length}` +
            (hasCookie ? " cookie=y" : " cookie=n") +
            (hasReferer ? " ref=y" : " ref=n") +
            ` tab=${tabId || "?"}` +
            " via=cat-setHeaders";

        const attemptErrors = [];

        // --- attempt helpers (mirror downloader.js downloadError retries) ---
        const tryOnce = async (label, mutateFrag, fetchHdrs) => {
            const f = {
                url: frag.url,
                requestId: frag.requestId,
                requestHeaders: Object.assign({}, frag.requestHeaders),
                cookie: frag.cookie,
            };
            if (mutateFrag) mutateFrag(f);
            await applyCatSetHeaders(f, tabId);
            // small delay so session DNR rules are active before fetch
            await new Promise((r0) => setTimeout(r0, 30));
            const blob = await catStyleFetchUrl(f.url, fetchHdrs || null);
            return blob;
        };

        if (tabId && typeof setHeaders === "function") {
            // 1) plain (DNR only)
            try {
                const blob = await tryOnce("plain", null, null);
                console.info("[merge-av] cat fetch ok", r, blob.size, meta);
                return blob;
            } catch (e1) {
                attemptErrors.push(`plain: ${(e1 && e1.message) || e1}`);
                console.warn("[merge-av] cat fetch plain fail", e1);
            }
            // 2) Range: bytes=0-  (Downloader HTTPError retry)
            try {
                const blob = await tryOnce("range", null, { Range: "bytes=0-" });
                console.info("[merge-av] cat fetch ok range", r, blob.size);
                return blob;
            } catch (e2) {
                attemptErrors.push(`range: ${(e2 && e2.message) || e2}`);
                console.warn("[merge-av] cat fetch range fail", e2);
            }
            // 3) sec-fetch-* via DNR (Downloader second retry)
            try {
                const blob = await tryOnce(
                    "sec-fetch",
                    (f) => {
                        f.requestHeaders = Object.assign({}, f.requestHeaders, {
                            "sec-fetch-mode": "no-cors",
                            "sec-fetch-site": "same-site",
                        });
                    },
                    null
                );
                console.info("[merge-av] cat fetch ok sec-fetch", r, blob.size);
                return blob;
            } catch (e3) {
                attemptErrors.push(`sec-fetch: ${(e3 && e3.message) || e3}`);
                console.warn("[merge-av] cat fetch sec-fetch fail", e3);
            }
            // 4) range + sec-fetch
            try {
                const blob = await tryOnce(
                    "range+sec",
                    (f) => {
                        f.requestHeaders = Object.assign({}, f.requestHeaders, {
                            "sec-fetch-mode": "no-cors",
                            "sec-fetch-site": "same-site",
                        });
                    },
                    { Range: "bytes=0-" }
                );
                console.info("[merge-av] cat fetch ok range+sec", r, blob.size);
                return blob;
            } catch (e4) {
                attemptErrors.push(`range+sec: ${(e4 && e4.message) || e4}`);
            }
        } else {
            attemptErrors.push(
                !tabId ? "no tabId" : "setHeaders missing (load function.js)"
            );
        }

        // --- last resort: background SW (often fails on Douyin; keep for non-CDN) ---
        let bgErrMsg = "";
        try {
            const { headers, pageUrl } = await headersForBlobFetch(it);
            const res = await chrome.runtime.sendMessage({
                Message: "lmwClientFetchBlob",
                url: it.url,
                headers,
                referer: pageUrl || "",
                role: r,
            });
            if (res && res.ok && res.buffer) {
                const blob = new Blob([res.buffer], {
                    type: res.type || "application/octet-stream",
                });
                if (blob.size >= 32) {
                    console.info("[merge-av] bg fallback ok", r, blob.size);
                    return blob;
                }
                bgErrMsg = `bg empty size=${blob.size}`;
            } else {
                bgErrMsg = (res && res.error) || "bg no buffer";
            }
        } catch (bgEx) {
            bgErrMsg = (bgEx && bgEx.message) || String(bgEx);
        }

        throw makeStageError(
            "fetch",
            `${r} 猫抓路径失败 ${meta} | ${attemptErrors.join(" · ")}` +
                (bgErrMsg ? ` | bg: ${bgErrMsg}` : ""),
            {
                role: r,
                host: urlHost(it.url),
                url: it.url,
                via: "cat-setHeaders",
                attemptErrors,
            }
        );
    }

    /**
     * Server-side download one progressive URL via existing /api/ingest (no server code change).
     * autoFallback=false: merge path must not silently fall back to extension fetch.
     * @returns {Promise<number>} media_id
     */
    async function ingestOneUrlOnServer(it, role, pageUrl, onStatus, allowIosIncompatible) {
        const r = role || "media";
        if (!it || !it.url) {
            throw makeStageError("ingest", `${r} 无 URL`);
        }
        const mt = LMW.normalizeMediaType(it);
        if (mt === "m3u8" || mt === "dash") {
            throw makeStageError(
                "ingest",
                `${r} 为 ${mt}，「合并选中音视频」仅支持 progressive（完整文件 URL）`
            );
        }
        const row = await LMW.itemToIngest(it, pageUrl, []);
        if (it._headers) {
            row.headers = Object.assign({}, row.headers || {}, it._headers);
        }
        // Prefer explicit role for library typing (audio track may look like .mp4)
        if (r === "audio") row.media_type = "audio";
        else if (r === "video") row.media_type = mt === "audio" ? "video" : mt || "video";
        if (allowIosIncompatible) row.allow_ios_incompatible = true;
        const baseTitle = (it.title || it.name || r).replace(/\.[^.]+$/, "");
        row.title = `${baseTitle} [merge-${r}]`;

        if (onStatus) onStatus(`服务端拉取${r === "audio" ? "音频" : "视频"}… ${itemBrief(it, r)}`);
        const result = await LMW.pushItems([row], "default", {
            tags: [],
            restricted: false,
            autoFallback: false,
            wait: true,
            allow_ios_incompatible: !!allowIosIncompatible,
            onProgress: (job) => {
                if (!onStatus || !job) return;
                const pct =
                    job.progress != null && job.progress !== ""
                        ? ` ${Math.round(+job.progress)}%`
                        : "";
                onStatus(
                    `服务端拉取${r === "audio" ? "音频" : "视频"}… ${job.status || ""}${pct}`
                );
            },
        });

        const jobs = result.jobs || [];
        const okJob = jobs.find(
            (j) =>
                j &&
                j.status === "success" &&
                j.media_id &&
                !String(j.error_message || "").includes("content_duplicate")
        );
        if (okJob && okJob.media_id) return Number(okJob.media_id);

        // content duplicate still has a usable file in library
        const dupJob = jobs.find(
            (j) =>
                j &&
                j.status === "success" &&
                j.media_id &&
                String(j.error_message || "").includes("content_duplicate")
        );
        if (dupJob && dupJob.media_id) return Number(dupJob.media_id);

        const dups = result.duplicate_media_ids || [];
        if (dups.length) return Number(dups[0]);

        const j0 = jobs[0];
        const why = j0
            ? `${j0.status || "?"}: ${j0.error_message || j0.message || ""}`.trim()
            : result.failed
              ? "ingest failed"
              : "no job / no media_id";
        throw makeStageError(
            "ingest",
            `${r} 服务端拉取失败 @${urlHost(it.url)}: ${why}`.slice(0, 400),
            { role: r, job: j0, result }
        );
    }

    /**
     * Page A/V pair → server ingest both URLs → /api/media/merge-av (delete_sources).
     * Uses only existing LMW APIs.
     */
    async function mergePagePairViaServerIngest(vItem, aItem, { title, restricted, tags, onStatus, allowIosIncompatible } = {}) {
        const pageUrl =
            (await getPageUrl()) ||
            (vItem && (vItem._pageUrl || vItem.referer)) ||
            "";
        /** @type {number[]} */
        const tempIds = [];
        try {
            const vId = await ingestOneUrlOnServer(
                vItem,
                "video",
                pageUrl,
                onStatus,
                allowIosIncompatible
            );
            tempIds.push(vId);
            const aId = await ingestOneUrlOnServer(
                aItem,
                "audio",
                pageUrl,
                onStatus,
                allowIosIncompatible
            );
            tempIds.push(aId);

            if (onStatus) onStatus(`库内 ffmpeg 合并 v#${vId}+a#${aId}…`);
            const baseTags = Array.isArray(tags) ? tags.slice() : [];
            const tagList =
                restricted && typeof LMW.applyRestrictedTag === "function"
                    ? LMW.applyRestrictedTag(baseTags, true)
                    : restricted
                      ? LMW.normalizeTags
                          ? LMW.normalizeTags(baseTags.concat([LMW.RESTRICTED_TAG || "限制级"]))
                          : baseTags.concat([LMW.RESTRICTED_TAG || "限制级"])
                      : baseTags;
            const r = await LMW.mergeAvLibrary({
                pairs: [{ video_id: vId, audio_id: aId }],
                title: title || "",
                tags: tagList,
                delete_sources: true,
            });
            if (!(r && r.merged)) {
                const er = (r && r.errors && r.errors[0]) || {};
                throw makeStageError(
                    "library",
                    `库内合并失败 v#${vId}+a#${aId}: ${er.error || JSON.stringify(r || {}).slice(0, 200)}`,
                    { r, vId, aId }
                );
            }
            const item0 = (r.items && r.items[0]) || {};
            const mid = Number(item0.media_id || (item0.item && item0.item.id) || 0);
            if (!mid) {
                throw makeStageError("library", "merge-av 无 media_id", { r });
            }
            // sources deleted by delete_sources; do not double-delete
            tempIds.length = 0;
            return {
                media_id: mid,
                video_id: vId,
                audio_id: aId,
                note: item0.note || "merged",
            };
        } catch (e) {
            // best-effort cleanup of half-ingested tracks
            for (const id of tempIds) {
                try {
                    if (id) await LMW.deleteMedia(id);
                } catch (_) {}
            }
            throw e;
        }
    }

    async function mergeSelectedAv(forcedPairs) {
        let pairs = Array.isArray(forcedPairs) && forcedPairs.length ? forcedPairs : null;
        if (!pairs) {
            if (!avDetectAttempted) {
                setStatus("合并前检测可合并项…");
                await detectAvMergePairs();
            }
            pairs = collectMergePairs();
            // 无检测结果时：支持网格里手动勾选恰好 2 项直接合并
            if (!pairs.length && canManualTwoItemMerge()) {
                pairs = await buildManualMergePairsFromSelection();
                if (!pairs.length) {
                    setStatus("选中的两项无法识别为「1 视频 + 1 音频」，请改选或先去重");
                    updateMergeBtn();
                    return;
                }
            }
        }
        if (!pairs.length) {
            setStatus("没有可合并的音视频对。请勾选 1 视频 + 1 音频，或先去重后再试");
            return;
        }
        const iosItems = [];
        for (const p of pairs) {
            const v =
                p.video_item ||
                (p.video_key ? items.find((x) => x._key === p.video_key) : null);
            const a =
                p.audio_item ||
                (p.audio_key ? items.find((x) => x._key === p.audio_key) : null);
            if (v) iosItems.push(v);
            if (a) iosItems.push(a);
        }
        const iosGate = await confirmIosWebIfNeeded(iosItems, "合并选中音视频");
        if (!iosGate.ok) return;
        if (!confirmJasnaIfNeeded("合并选中音视频")) {
            setStatus("已取消合并（jasna 确认）");
            return;
        }
        const firstV =
            (pairs[0] &&
                (pairs[0].video_item ||
                    (pairs[0].video_key && items.find((x) => x._key === pairs[0].video_key)))) ||
            {};
        const dlg = await LMW.openIngestDialog({
            heading: `合并 ${pairs.length} 对音视频入库`,
            title: firstV.title || firstV.name || document.title || "merged",
            url: firstV.url || "",
            media_type: "video",
            source_page: await getPageUrl(),
            count: pairs.length,
            okLabel: "确认合并入库",
            skipLabel: "不打标签合并",
        });
        if (!dlg || !dlg.ok || dlg.cancelled) {
            setStatus("已取消合并");
            return;
        }
        const tags = dlg.tags || [];
        const useJasna =
            dlg.use_jasna === true ||
            isJasnaChecked() ||
            (typeof G !== "undefined" && G.lmwUseJasna === true);
        const restricted =
            dlg.restricted === true ||
            !!(document.getElementById("lmRestricted") && document.getElementById("lmRestricted").checked) ||
            (typeof G !== "undefined" && G.lmwRestricted === true);
        const btn = document.getElementById("btnMergeAvSelected");
        const detectBtn = document.getElementById("btnDetectAvMerge");
        if (btn) btn.disabled = true;
        if (detectBtn) detectBtn.disabled = true;
        let ok = 0;
        let fail = 0;
        /** @type {string[]} */
        const failDetails = [];
        /** @type {Set<string>} */
        const mergedPageKeys = new Set();
        const pushFail = (line, err) => {
            fail++;
            const s = String(line || errText(err) || "unknown").slice(0, 480);
            failDetails.push(s);
            console.error("[merge-av]", s, err || "");
        };
        try {
            // library pairs batch
            const libPairs = pairs.filter((p) => p.source === "library");
            if (libPairs.length) {
                setStatus(`库内合并 0/${libPairs.length}…`);
                try {
                    const libTags =
                        restricted && typeof LMW.applyRestrictedTag === "function"
                            ? LMW.applyRestrictedTag(tags, true)
                            : tags;
                    const r = await LMW.mergeAvLibrary({
                        pairs: libPairs.map((p) => ({
                            video_id: p.video_id,
                            audio_id: p.audio_id,
                        })),
                        tags: libTags,
                        // 合并成功后删除库内原来的分离音/视频，只留成品
                        delete_sources: true,
                    });
                    ok += r.merged || 0;
                    const libFailed = r.failed || 0;
                    fail += libFailed;
                    const errs = r.errors || [];
                    for (const er of errs) {
                        const line =
                            `库内 v#${er.video_id}+a#${er.audio_id}: ${er.error || "failed"}`;
                        failDetails.push(line);
                        console.error("[merge-av]", line, er);
                    }
                    if (libFailed && !errs.length) {
                        const line = `库内合并失败 ${libFailed} 对（服务端未返回 errors 明细）`;
                        failDetails.push(line);
                        console.error("[merge-av]", line, r);
                    }
                } catch (e) {
                    fail += libPairs.length;
                    const line = `库内合并请求失败: ${errText(e)}`;
                    failDetails.push(line);
                    console.error("[merge-av]", line, e);
                }
            }
            // page pairs one by one（分阶段，便于定位拉视频/音频/上传）
            const pagePairs = pairs.filter((p) => p.source === "page");
            for (let i = 0; i < pagePairs.length; i++) {
                const p = pagePairs[i];
                const pairNo = `${i + 1}/${pagePairs.length}`;
                try {
                    const vItem =
                        p.video_item || items.find((x) => x._key === p.video_key);
                    const aItem =
                        p.audio_item || items.find((x) => x._key === p.audio_key);
                    if (!vItem || !aItem) {
                        throw makeStageError(
                            "item",
                            `条目缺失 video=${!!vItem} audio=${!!aItem} keys=${p.video_key || "?"}|${p.audio_key || "?"}`,
                            { pair: pairNo }
                        );
                    }
                    const title =
                        (vItem.title || vItem.name || "merged").replace(/\.[^.]+$/, "") +
                        "+" +
                        (aItem.title || aItem.name || "audio").replace(/\.[^.]+$/, "");

                    // 服务端拉流（现有 ingest）+ 库内 merge-av，不改 LMW 代码、不扩展端 fetch CDN
                    setStatus(
                        `下载合并 ${pairNo} · 服务端拉流合并… ${itemBrief(vItem, "video")}`
                    );
                    const serverMerged = await mergePagePairViaServerIngest(vItem, aItem, {
                        title,
                        tags,
                        restricted: useJasna ? false : restricted,
                        allowIosIncompatible: iosGate.allow,
                        onStatus: (msg) => setStatus(`下载合并 ${pairNo} · ${msg}`),
                    });
                    const mid = serverMerged && serverMerged.media_id;
                    if (!mid) {
                        throw makeStageError(
                            "library",
                            `服务端合并成功但无 media_id note=${(serverMerged && serverMerged.note) || "?"}`,
                            { serverMerged }
                        );
                    }
                    setStatus(
                        `下载合并 ${pairNo} · 已入库 media#${mid}` +
                            `（服务端 v#${serverMerged.video_id}+a#${serverMerged.audio_id}）`
                    );

                    if (useJasna) {
                        setStatus(`下载合并 ${pairNo} · 拉取成品 media#${mid}…`);
                        let blob;
                        try {
                            blob = await LMW.fetchMediaFileBlob(mid);
                        } catch (pullErr) {
                            throw makeStageError(
                                "jasna",
                                `拉成品 media#${mid} 失败: ${errText(pullErr)}`,
                                { cause: pullErr, media_id: mid }
                            );
                        }
                        setStatus(`下载合并 ${pairNo} · JasnaBridge 入队…`);
                        try {
                            await LMW.enqueueJasnaBridgeBlob(blob, {
                                title,
                                tags,
                                restricted,
                                filename: `${String(title).slice(0, 40)}.mp4`,
                            });
                        } catch (jErr) {
                            throw makeStageError(
                                "jasna",
                                `JasnaBridge 入队失败: ${errText(jErr)}`,
                                { cause: jErr, media_id: mid }
                            );
                        }
                        try {
                            await LMW.deleteMedia(mid);
                        } catch (delErr) {
                            console.warn("delete intermediate merge", mid, delErr);
                        }
                    }
                    ok++;
                    if (p.video_key) mergedPageKeys.add(p.video_key);
                    if (p.audio_key) mergedPageKeys.add(p.audio_key);
                } catch (e) {
                    pushFail(`第${pairNo}对 ${errText(e)}`, e);
                    setStatus(
                        `下载合并 ${pairNo} 失败：${errText(e)}` +
                            formatFailDetails(failDetails, 3),
                        { error: true }
                    );
                }
            }
            let extra = "";
            if (isAutoRemoveChecked() && mergedPageKeys.size) {
                const removed = removeItemsByKeys(mergedPageKeys);
                if (removed) extra = ` · 已自动移除列表 ${removed} 项`;
            }
            clearAvPairs();
            if (extra) render();
            let summary = `合并完成：成功 ${ok}`;
            if (fail) summary += ` · 失败 ${fail}`;
            if (ok && !fail) summary += " · 已写入媒体库";
            else if (ok && fail) summary += " · 部分已写入媒体库";
            summary += extra + formatFailDetails(failDetails, 10);
            setStatus(summary, { error: fail > 0 });
            if (failDetails.length) {
                console.error("[merge-av] done", { ok, fail, failDetails });
            }
        } catch (e) {
            const line = errText(e);
            failDetails.push(line);
            console.error("[merge-av] fatal", e);
            setStatus("合并失败：" + line + formatFailDetails(failDetails, 10), {
                error: true,
            });
        } finally {
            if (btn) btn.disabled = false;
            if (detectBtn) detectBtn.disabled = false;
            updateMergeBtn();
            updateSelectAllBtn();
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
        updateSelectAllBtn();
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

    function formatSecHms(sec) {
        const s = Math.max(0, Math.floor(+sec || 0));
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const r = s % 60;
        if (h > 0) {
            return (
                String(h).padStart(2, "0") +
                ":" +
                String(m).padStart(2, "0") +
                ":" +
                String(r).padStart(2, "0")
            );
        }
        return String(m).padStart(2, "0") + ":" + String(r).padStart(2, "0");
    }

    /**
     * Sum #EXTINF durations of a media playlist (follows one master variant if needed).
     * Best-effort; CORS / 403 may fail — returns null then.
     */
    async function probeM3u8DurationSec(url, headers) {
        if (!url || !/^https?:/i.test(String(url))) return null;
        const fetchText = async (u) => {
            const res = await fetch(u, {
                headers: headers || {},
                credentials: "omit",
                cache: "no-store",
            });
            if (!res.ok) throw new Error("HTTP " + res.status);
            return res.text();
        };
        const sumExtinf = (text) => {
            let total = 0;
            let n = 0;
            const re = /#EXTINF\s*:\s*([0-9.]+)/gi;
            let m;
            while ((m = re.exec(text))) {
                total += parseFloat(m[1]) || 0;
                n++;
            }
            return n > 0 ? total : null;
        };
        try {
            let text = await fetchText(url);
            if (/#EXT-X-STREAM-INF/i.test(text)) {
                // pick highest BANDWIDTH variant (same idea as LMW hls.py)
                let bestBw = -1;
                let bestUri = null;
                const lines = text.split(/\r?\n/);
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    if (!/#EXT-X-STREAM-INF/i.test(line)) continue;
                    const bm = line.match(/BANDWIDTH=(\d+)/i);
                    const bw = bm ? parseInt(bm[1], 10) : 0;
                    let uri = "";
                    for (let j = i + 1; j < lines.length; j++) {
                        const u = String(lines[j] || "").trim();
                        if (!u || u.startsWith("#")) continue;
                        uri = u;
                        break;
                    }
                    if (uri && bw >= bestBw) {
                        bestBw = bw;
                        bestUri = uri;
                    }
                }
                if (bestUri) {
                    try {
                        text = await fetchText(new URL(bestUri, url).href);
                    } catch (e) {
                        return null;
                    }
                }
            }
            return sumExtinf(text);
        } catch (e) {
            return null;
        }
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
     *
     * 结束填 00:00:00 / 留空 = 该 m3u8 播放列表末尾（不是网页播放器总时长）。
     */
    function promptM3u8Range(it) {
        return new Promise((resolve) => {
            const $m = $("#lmRangeModal");
            const $start = $("#lmRangeStart");
            const $end = $("#lmRangeEnd");
            const $list = $("#lmRangeList");
            const $empty = $("#lmRangeListEmpty");
            const $count = $("#lmRangeCount");
            const $hint = $("#lmRangeHint");
            const $status = $("#lmRangeStatus");
            $("#lmRangeUrl").text(it.url || "");

            /** playlist duration seconds if probed; null if unknown */
            let playlistDur = it._m3u8DurationSec > 0 ? +it._m3u8DurationSec : null;

            const setModalStatus = (msg) => {
                if ($status.length) $status.text(msg || "");
                else if (msg) setStatus(msg);
            };

            const refreshDurationHint = () => {
                const base =
                    "填写一组起止时间后点「添加」加入候选；可添加多组，每组入库为独立条目。" +
                    "结束时间 00:00:00 或留空 = 本 m3u8 片尾（以播放列表总时长为准，可能短于网页播放器进度）。";
                if (playlistDur != null && playlistDur > 0) {
                    if ($hint.length) {
                        $hint.html(
                            base +
                                "<br/><strong>本列表约 " +
                                formatSecHms(playlistDur) +
                                "（" +
                                playlistDur.toFixed(1) +
                                "s）</strong> — 开始时间须小于该值。"
                        );
                    }
                } else if ($hint.length) {
                    $hint.text(base);
                }
            };
            refreshDurationHint();

            // best-effort probe (does not block UI)
            (async () => {
                if (playlistDur != null && playlistDur > 0) return;
                let headers = {};
                try {
                    if (typeof LMW !== "undefined" && LMW.buildHeadersForItem) {
                        const pageUrl =
                            (typeof getPageUrl === "function" && (await getPageUrl())) ||
                            document.referrer ||
                            "";
                        headers = await LMW.buildHeadersForItem(it, pageUrl);
                    } else if (it._headers) {
                        headers = it._headers;
                    }
                } catch (e) {
                    /* ignore */
                }
                const d = await probeM3u8DurationSec(it.url, headers);
                if (d != null && d > 0) {
                    playlistDur = d;
                    it._m3u8DurationSec = d;
                    refreshDurationHint();
                }
            })();

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

            const validateAgainstDuration = (startSec, endSec) => {
                if (playlistDur == null || !(playlistDur > 0)) return true;
                if (startSec >= playlistDur) {
                    setModalStatus(
                        "开始时间 " +
                            formatSecHms(startSec) +
                            " 已超过本 m3u8 时长 " +
                            formatSecHms(playlistDur) +
                            "（" +
                            playlistDur.toFixed(1) +
                            "s）。结束=末尾只会截到列表结尾，不能越过片长。"
                    );
                    return false;
                }
                if (endSec != null && endSec > 0 && endSec > playlistDur + 0.5) {
                    // soft note only: server will clamp via segment slice; still allow
                    setModalStatus(
                        "结束时间晚于列表时长 " +
                            formatSecHms(playlistDur) +
                            "，将按片尾处理"
                    );
                }
                return true;
            };

            const readInputRange = () => {
                const startStr = String($start.val() || "").trim() || "00:00:00";
                const endStr = String($end.val() || "").trim();
                const startSec = parseTimeToSeconds(startStr) || 0;
                let endSec = parseTimeToSeconds(endStr);
                // 00:00:00 / 0 / empty → to playlist end (null end_sec)
                if (endSec != null && !(endSec > 0)) endSec = null;
                if (endSec != null && endSec > 0 && endSec <= startSec) {
                    setModalStatus("结束时间须大于开始时间（00:00:00 表示到末尾，请留空或保持 00:00:00）");
                    return null;
                }
                if (!validateAgainstDuration(startSec, endSec)) return null;
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
                    setModalStatus("该时间段已在候选中");
                    return false;
                }
                draft.push(r);
                renderList();
                setModalStatus("已添加候选 " + formatOneRange(r));
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
                    if (pending === null && String($start.val() || "").trim()) {
                        // validation failed (e.g. start past duration) — stay open
                        return;
                    }
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
                    // final check all draft ranges
                    for (const r of draft) {
                        if (!validateAgainstDuration(r.startSec || 0, r.endSec)) {
                            return;
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
        if (manualAvMode) {
            toggleManualAvPick(key);
            return;
        }
        if (multiMergeMode) {
            toggleMultiMergePick(key, $card);
            return;
        }
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
            if (el.tagName === "VIDEO" || el.tagName === "AUDIO") {
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
                        const dd = v.duration;
                        if (Number.isFinite(dd) && dd > 0.05 && !(headersIt._durationSec > 0.05)) {
                            headersIt._durationSec = dd;
                            onDurationReady(headersIt);
                        }
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
        // 音频：悬停用 <audio> 试听（隐藏控件，保留 ♪ 视觉）
        if (type === "audio") {
            const $a = $("<audio class='lm-card-motion lm-card-hover-audio' loop preload='auto'/>");
            $card.prepend($a);
            const a = $a[0];
            a.volume = 1;
            a.muted = false;
            applyPlayHeaders(it, () => {
                if (!hoverPlayCard || hoverPlayCard[0] !== $card[0]) return;
                try {
                    a.src = it._playUrl || it.url;
                    a.play().catch(() => {
                        // 扩展页一般允许有声；失败则静默
                    });
                } catch (_) {}
            });
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
        // 悬停可试听/预览：含 audio（此前漏掉导致音频卡片不自动播）
        const isHoverPlayable =
            type === "gif" ||
            type === "video" ||
            type === "audio" ||
            type === "m3u8" ||
            type === "dash";

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
            if (isHoverPlayable) {
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
        applyPreviewMode(getPreviewMode());
        list.forEach((it) => {
            const key = it._key;
            const type = mediaTypeOf(it);
            const checked = selected.has(key);
            const isMotion = type === "gif" || type === "video" || type === "m3u8" || type === "dash";
            const isHoverPlayable = isMotion || type === "audio";
            const $card = $("<div class='lm-card'/>")
                .toggleClass("selected", checked)
                .toggleClass("lm-card-motion-ready", isHoverPlayable)
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
            updateCardDurationBadge($card, it);
            updateCardCodecBadge($card, it);
            updateRangeBadge($card, it);
            refreshCardDetail($card, it);
            bindCardEvents($card, it, key);
            $grid.append($card);
        });
        applyPairMarks();
        applyMmOrderMarks();
        applyManualAvMarks();
        updateStatusCount(list.length);
        // 后台懒探测音/视频时长，填角标
        scheduleDurationProbes(list);
        scheduleCodecProbes(list);
    }

    function getSelectedItems() {
        return items.filter((it) => selected.has(it._key));
    }

    function getMultiMergeItems() {
        return multiMergeOrder
            .map((k) => items.find((it) => it._key === k))
            .filter(Boolean);
    }

    /**
     * 多段合并主流程：
     * 1) 检测可合并 A/V → 服务端 upload-av
     * 2) 各 progressive 段上传为临时库条目
     * 3) 服务端 ffmpeg 按序拼接（/api/media/concat），删除临时段
     * 4) 可选再走本机 JasnaBridge
     */
    async function runMultiSegmentMerge() {
        if (multiMergeBusy) return;
        const ordered = getMultiMergeItems();
        if (ordered.length < 2) {
            setStatus("请至少按顺序选择 2 项后再开始合并");
            return;
        }
        if (!confirmJasnaIfNeeded("多段合并入库")) {
            setStatus("已取消多段合并（jasna 确认）");
            return;
        }
        const restricted = !!(
            document.getElementById("lmRestricted") &&
            document.getElementById("lmRestricted").checked
        );
        const useJasna = isJasnaChecked();
        const usedKeys = ordered.map((it) => it._key).filter(Boolean);

        multiMergeBusy = true;
        updateMultiMergeBtn();
        /** @type {number[]} 中间段 media_id（A/V 合并或临时上传），成功拼接后由 delete_sources 清理 */
        const segmentIds = [];
        /** 失败时需要手动清理的 id（含尚未进入 concat 的临时段） */
        const cleanupIds = new Set();

        try {
            setStatus(`多段合并·检测可合并… ${ordered.length} 项`);
            const r = await detectPageAvPairs(ordered);
            render();
            applyMmOrderMarks();
            const pairs = r.pairs || [];
            if (pairs.length) {
                setAvPairs(pairs);
                setStatus(`多段合并·检测到 ${pairs.length} 对可合并音视频，先合并…`);
            } else {
                clearAvPairs();
                setStatus("多段合并·未检测到可合并对，将按序上传后由服务端拼接…");
            }

            /** @type {Map<string, object>} */
            const keyToPair = new Map();
            for (const p of pairs) {
                if (p.video_key) keyToPair.set(p.video_key, p);
                if (p.audio_key) keyToPair.set(p.audio_key, p);
            }
            const pairDone = new Set();
            /** @type {string[]} */
            const segmentLabels = [];

            for (let i = 0; i < ordered.length; i++) {
                const it = ordered[i];
                const key = it._key;
                const pair = keyToPair.get(key);
                if (pair) {
                    const pk = pair.video_key || pair.audio_key;
                    if (pairDone.has(pk)) continue;
                    pairDone.add(pk);
                    const vItem =
                        pair.video_item || items.find((x) => x._key === pair.video_key);
                    const aItem =
                        pair.audio_item || items.find((x) => x._key === pair.audio_key);
                    if (!vItem || !aItem) {
                        throw new Error("可合并对缺少视频或音频项");
                    }
                    setStatus(
                        `多段合并·服务端合并音视频 ${pairDone.size}/${pairs.length}…`
                    );
                    const [vBlob, aBlob] = await Promise.all([
                        fetchItemBlob(vItem),
                        fetchItemBlob(aItem),
                    ]);
                    const title =
                        (vItem.title || vItem.name || "merged").replace(/\.[^.]+$/, "") +
                        "+" +
                        (aItem.title || aItem.name || "audio").replace(/\.[^.]+$/, "");
                    // 中间段：不打限制级；成品在 concat 时再处理
                    const merged = await LMW.uploadAvBlobs(vBlob, aBlob, {
                        title,
                        source_url: vItem.url || "",
                        filename: title,
                        restricted: false,
                    });
                    const mid = Number(merged && (merged.media_id || merged.item?.id));
                    if (!mid) throw new Error("音视频合并成功但无 media_id");
                    segmentIds.push(mid);
                    cleanupIds.add(mid);
                    segmentLabels.push(title);
                    continue;
                }

                const t = mediaTypeOf(it);
                if (t === "audio") {
                    setStatus(
                        `多段合并·跳过未配对音频「${(it.title || it.name || "").slice(0, 40)}」`
                    );
                    continue;
                }
                if (t === "m3u8" || t === "dash") {
                    throw new Error(
                        "多段合并暂不支持 m3u8/DASH（请先下载为 progressive 或仅选 mp4 等）"
                    );
                }
                if (t === "image" || t === "gif") continue;

                setStatus(`多段合并·上传片段 ${segmentIds.length + 1}…`);
                const blob = await fetchItemBlob(it);
                const partTitle = (
                    it.title ||
                    it.name ||
                    "part" + (segmentIds.length + 1)
                ).replace(/\.[^.]+$/, "");
                const up = await LMW.uploadBlob(blob, {
                    title: partTitle,
                    source_url: it.url || "",
                    media_type: "video",
                    filename:
                        String(partTitle).slice(0, 60).replace(/[\\/:*?"<>|]+/g, "_") +
                        ".mp4",
                    restricted: false,
                });
                const mid = Number(up && (up.media_id || up.item?.id || up.id));
                if (!mid) throw new Error("片段上传成功但无 media_id");
                segmentIds.push(mid);
                cleanupIds.add(mid);
                segmentLabels.push(partTitle);
            }

            if (!segmentIds.length) {
                throw new Error("没有可拼接的视频片段（可能只有未配对音频）");
            }

            const outTitle =
                (segmentLabels[0] || "multi") +
                (segmentLabels.length > 1 ? `+${segmentLabels.length - 1}段` : "");

            setStatus(
                `多段合并·服务端 ffmpeg 拼接 ${segmentIds.length} 段…` +
                    (restricted ? " · 限制级" : "") +
                    (useJasna ? " · 随后 JasnaBridge" : "")
            );

            // 服务端拼接并删除临时段；限制级打在成品上（Jasna 路径成品会再走 bridge，此处先不打服务端 jasna）
            const concatRes = await LMW.concatMediaLibrary({
                ids: segmentIds,
                title: outTitle,
                tags: [],
                delete_sources: true,
                restricted: useJasna ? false : restricted,
                use_jasna: false,
            });
            const finalId = Number(
                concatRes && (concatRes.media_id || concatRes.item?.id)
            );
            if (!finalId) throw new Error("服务端拼接成功但无 media_id");
            // 源段已 delete_sources；只保留成品 id
            cleanupIds.clear();
            cleanupIds.add(finalId);

            if (useJasna) {
                setStatus("多段合并·拉取成品交 JasnaBridge…");
                const blob = await LMW.fetchMediaFileBlob(finalId);
                await LMW.enqueueJasnaBridgeBlob(blob, {
                    title: outTitle,
                    tags: [],
                    restricted,
                    filename:
                        String(outTitle).slice(0, 80).replace(/[\\/:*?"<>|]+/g, "_") +
                        ".mp4",
                    source_media_id: finalId,
                });
                // 与音视频合并一致：中间 LMW 成品在 bridge 接管后删除
                try {
                    await LMW.deleteMedia(finalId);
                    cleanupIds.delete(finalId);
                } catch (delErr) {
                    console.warn("delete intermediate concat", finalId, delErr);
                }
            }

            let extra = "";
            if (isAutoRemoveChecked() && usedKeys.length) {
                const removed = removeItemsByKeys(new Set(usedKeys));
                if (removed) extra = ` · 已自动移除列表 ${removed} 项`;
            }

            clearAvPairs();
            exitMultiMergeMode();
            if (extra) render();
            setStatus(
                `多段合并完成：${segmentIds.length} 段 → 服务端拼接 1 条` +
                    (pairs.length ? `（含 ${pairs.length} 对音视频先合并）` : "") +
                    (useJasna ? " · 已交 JasnaBridge" : ` · 库 id #${finalId}`) +
                    extra
            );
        } catch (e) {
            for (const mid of cleanupIds) {
                try {
                    await LMW.deleteMedia(mid);
                } catch (_) {}
            }
            setStatus("多段合并失败：" + ((e && e.message) || e));
            updateMultiMergeBtn();
        } finally {
            multiMergeBusy = false;
            updateMultiMergeBtn();
            updateMergeBtn();
            updateSelectAllBtn();
        }
    }

    async function onMultiMergeBtnClick() {
        if (multiMergeBusy) return;
        if (!multiMergeMode) {
            enterMultiMergeMode();
            return;
        }
        // 已在选序模式 → 开始合并
        if (multiMergeOrder.length < 2) {
            setStatus("请至少选择 2 项，或按 Esc 取消多段合并");
            return;
        }
        await runMultiSegmentMerge();
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

    async function waitSyncOptions() {
        for (let i = 0; i < 80; i++) {
            if (G && G.initSyncComplete) return;
            await new Promise((r) => setTimeout(r, 50));
        }
    }

    async function resolvePageTitle() {
        if (typeof TitleRules === "undefined" || !tabId) {
            return { title: "", source: "", docTitle: "", pageUrl: await getPageUrl() };
        }
        await waitSyncOptions();
        return TitleRules.resolveForTab(tabId);
    }

    async function enrichItemTitles() {
        await waitSyncOptions();
        if (typeof TitleRules !== "undefined" && TitleRules.hydrateRules) {
            await TitleRules.hydrateRules();
        }
        const pageUrl = await getPageUrl();
        let resolved = null;
        if (typeof TitleRules !== "undefined") {
            const rule = TitleRules.matchRule(pageUrl);
            if (rule && rule.selector) {
                resolved = await TitleRules.extractOnTab(tabId, {
                    selector: rule.selector,
                    regex: rule.regex || "",
                    pageUrl: pageUrl,
                });
            } else {
                resolved = await resolvePageTitle();
            }
            TitleRules.applyToItems(items, resolved);
        }
        return resolved;
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

        let pageTitle = "";
        try {
            pageTitle =
                document.querySelector('meta[property="og:title"]')?.getAttribute("content") ||
                document.querySelector('meta[name="twitter:title"]')?.getAttribute("content") ||
                "";
            pageTitle = String(pageTitle || "").replace(/\s+/g, " ").trim();
            if (!pageTitle) {
                const h1 = document.querySelector("h1");
                pageTitle = String((h1 && h1.textContent) || "").replace(/\s+/g, " ").trim();
            }
        } catch (_) {}
        if (!pageTitle) pageTitle = document.title || "";

        return {
            images,
            probePages: [...probePages].slice(0, 20),
            pageTitle,
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
            listSource = "parse";

            selected.clear();
            clearAvPairs();
            avDetectAttempted = false;
            items.forEach((it, i) => {
                // 用去重键做稳定 id，避免同 url 不同 index 重复选中态
                it._key = (mediaDedupeKey(it.url) || it.url) + "#" + i;
            });
            const pageUrl = (await getPageUrl()) || pageUrlHint;
            await enrichHeaders(items, pageUrl);
            await enrichItemTitles();
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
            listSource = "caught";
            items.forEach((it, i) => {
                it._key = it.url + "#" + i;
                // Prefer network Content-Type so disguised audio is not forced to video by .mp4 URL
                if (!it.media_type) {
                    it.media_type = LMW.normalizeMediaType(it);
                }
            });
            selected.clear();
            clearAvPairs();
            avDetectAttempted = false;
            await enrichHeaders(items, pageUrl);
            await enrichItemTitles();
            render();
            const audioN = items.filter((x) => mediaTypeOf(x) === "audio").length;
            setStatus(
                `载入 ${items.length} 条嗅探资源` + (audioN ? `（含音频 ${audioN}）` : "")
            );
        } catch (e) {
            setStatus("载入失败: " + e.message);
        }
    }

    /**
     * 将列表项规范为猫抓下载器可用结构（requestId / requestHeaders / 文件名 / 大小）。
     */
    function toCatDownloadItem(it, idx) {
        if (!it || !it.url) return null;
        const data = Object.assign({}, it);
        // DNR rule id 需为 1..2^32-1 的整数
        let rid = data.requestId;
        const ridNum = rid != null ? parseInt(rid, 10) : NaN;
        if (!Number.isFinite(ridNum) || ridNum < 1 || ridNum >= 0xffffffff) {
            rid = String(900000000 + ((Date.now() + (idx || 0)) % 90000000));
            data.requestId = rid;
        } else {
            data.requestId = String(ridNum);
        }
        if (!data.requestHeaders || typeof data.requestHeaders !== "object") {
            data.requestHeaders = {};
        }
        if (it._headers && typeof it._headers === "object") {
            data.requestHeaders = Object.assign({}, data.requestHeaders, it._headers);
        }
        if (!data.requestHeaders.referer && !data.requestHeaders.Referer) {
            const ref = it.referer || it._pageUrl || "";
            if (ref) data.requestHeaders.referer = ref;
        }
        if (!data.downFileName) {
            const base =
                (it.title || it.name || "").replace(/[\\/:*?"<>|]+/g, "_").trim() ||
                (typeof getUrlFileName === "function" ? getUrlFileName(it.url) : "") ||
                (mediaTypeOf(it) === "audio" ? "audio" : "video");
            const ext =
                (it._sniffedExt && String(it._sniffedExt).replace(/^\./, "")) ||
                (it.ext && String(it.ext).replace(/^\./, "")) ||
                (it.url.match(/\.([a-z0-9]{2,5})(?:\?|#|$)/i) || [])[1] ||
                (mediaTypeOf(it) === "audio" ? "m4a" : "mp4");
            data.downFileName = /\.[a-z0-9]{2,5}$/i.test(base) ? base : base + "." + ext;
        }
        if (it._sniffedExt) {
            data.ext = String(it._sniffedExt).replace(/^\./, "");
            data.downFileName = replaceFileNameExt(data.downFileName, data.ext);
        }
        if (data._size == null) {
            const n = Number(typeof it.size === "number" ? it.size : 0);
            if (n > 0) data._size = n;
        }
        if (data.tabId == null && tabId) data.tabId = tabId;
        return data;
    }

    let catDownloadIsProcessing = false;
    /**
     * 打开猫抓分段下载器（带请求头 / 大文件分片 / StreamSaver）。
     * 与 popup / preview 的 catDownload 一致。
     */
    function catDownloadLocal(list, extra = {}) {
        if (!list || !list.length) return;
        if (catDownloadIsProcessing) {
            setTimeout(() => catDownloadLocal(list, extra), 233);
            return;
        }
        catDownloadIsProcessing = true;
        const data = list.map((it, i) => toCatDownloadItem(it, i)).filter(Boolean);
        if (!data.length) {
            catDownloadIsProcessing = false;
            return;
        }
        try {
            localStorage.setItem("downloadData", JSON.stringify(data));
        } catch (e) {
            console.warn("downloadData storage failed", e);
        }
        if (
            !extra.ffmpeg &&
            !(typeof G !== "undefined" && G.downStream) &&
            typeof G !== "undefined" &&
            G.chromeLimitSize &&
            Math.max(...data.map((item) => item._size || 0)) > G.chromeLimitSize &&
            typeof i18n === "function" &&
            confirm(i18n("fileTooLargeStream", ["2G"]))
        ) {
            extra.downStream = 1;
        }
        const openDownloader = () => {
            const qs = new URLSearchParams({
                requestId: data.map((item) => item.requestId).join(","),
                ...Object.fromEntries(
                    Object.entries(extra).map(([k, v]) => [
                        k,
                        typeof v === "boolean" ? (v ? 1 : 0) : v,
                    ])
                ),
            });
            chrome.tabs.create(
                {
                    url: `/downloader.html?${qs}`,
                    active: !(typeof G !== "undefined" && G.downActive),
                },
                (tab) => {
                    if (!tab || !tab.id) {
                        catDownloadIsProcessing = false;
                        return;
                    }
                    const listener = (tabIdDone, info) => {
                        if (tabIdDone === tab.id && info.status === "complete") {
                            chrome.tabs.onUpdated.removeListener(listener);
                            catDownloadIsProcessing = false;
                        }
                    };
                    chrome.tabs.onUpdated.addListener(listener);
                    setTimeout(() => {
                        chrome.tabs.onUpdated.removeListener(listener);
                        catDownloadIsProcessing = false;
                    }, 15000);
                }
            );
        };
        try {
            chrome.runtime.sendMessage(
                chrome.runtime.id,
                { Message: "catDownload", data: data },
                (message) => {
                    if (chrome.runtime.lastError || !message || message.message != "OK") {
                        openDownloader();
                        return;
                    }
                    catDownloadIsProcessing = false;
                }
            );
        } catch (_) {
            openDownloader();
        }
    }

    function isPairAudioRole(it) {
        if (!it || !it._key) return false;
        const info = avPairByKey.get(it._key);
        return !!(info && info.role === "audio");
    }

    function isVideoLikeItem(it) {
        if (isPairAudioRole(it)) return false;
        const t = mediaTypeOf(it);
        if (t === "audio" || t === "image" || t === "gif") return false;
        if (t === "video" || t === "m3u8" || t === "dash") return true;
        const u = (it && it.url) || "";
        if (/\.(m3u8|mpd)(\?|#|$)/i.test(u)) return true;
        if (/\.(mp4|webm|mkv|mov|m4v|ts|flv|avi)(\?|#|$)/i.test(u)) return true;
        if (it && it.parsing === "m3u8") return true;
        if (it && it.parsing === "mpd") return true;
        return false;
    }

    function isAudioLikeItem(it) {
        if (isPairAudioRole(it)) return true;
        const t = mediaTypeOf(it);
        if (t === "audio") return true;
        if (t === "video" || t === "m3u8" || t === "dash" || t === "image" || t === "gif") return false;
        const u = (it && it.url) || "";
        return /\.(mp3|m4a|aac|ogg|opus|flac|wav|weba|oga)(\?|#|$)/i.test(u);
    }

    function isDownloadableLocalItem(it) {
        return isVideoLikeItem(it) || isAudioLikeItem(it);
    }

    function replaceFileNameExt(name, ext) {
        const e = String(ext || "").replace(/^\./, "").toLowerCase();
        if (!name || !e) return name || "";
        const base = String(name).replace(/\.[a-z0-9]{1,5}$/i, "");
        return base + "." + e;
    }

    /**
     * Container from file magic (first ~16–32 bytes).
     * family:
     *   safe-audio  — never a video file (mp3/flac/ogg/wav/aac/weba)
     *   m4a-brand   — ftyp M4A/M4B/M4P, safe to save as .m4a
     *   mp4-family  — ftyp isom/mp42/…  video and disguised audio look the same
     */
    function parseMagicContainer(buf) {
        if (!buf || buf.byteLength < 4) return { family: "unknown", ext: "" };
        const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
        const ascii = (i, n) => {
            let s = "";
            for (let k = 0; k < n && i + k < b.length; k++) s += String.fromCharCode(b[i + k]);
            return s;
        };
        if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
            return { family: "safe-audio", ext: "mp3" };
        }
        if (ascii(0, 4) === "fLaC") return { family: "safe-audio", ext: "flac" };
        if (ascii(0, 4) === "OggS") return { family: "safe-audio", ext: "ogg" };
        if (ascii(0, 4) === "RIFF" && b.length >= 12 && ascii(8, 4) === "WAVE") {
            return { family: "safe-audio", ext: "wav" };
        }
        if (b.length >= 12 && ascii(4, 4) === "ftyp") {
            const brand = ascii(8, 4);
            if (/^(M4A |M4B |M4P )/i.test(brand)) {
                return { family: "m4a-brand", ext: "m4a" };
            }
            return { family: "mp4-family", ext: "mp4" };
        }
        if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
            // WebM video and weba share EBML; only rename when already audio-like
            return { family: "ebml", ext: "webm" };
        }
        if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) {
            return { family: "safe-audio", ext: "aac" };
        }
        if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) {
            const layer = (b[1] >> 1) & 0x03;
            return { family: "safe-audio", ext: layer === 0x02 ? "mp2" : "mp3" };
        }
        return { family: "unknown", ext: "" };
    }

    function extFromMagicBytes(buf) {
        const s = parseMagicContainer(buf);
        return s.ext || "";
    }

    /**
     * Only rename when it cannot clobber a real video:
     * - unambiguous audio magic
     * - ftyp M4A/M4B
     * - ftyp isom/mp42 AND (typed audio OR merge-pair audio role)
     */
    function audioExtFromSniff(it, sniff) {
        if (!sniff || !sniff.family) return "";
        if (sniff.family === "safe-audio" && sniff.ext) return sniff.ext;
        if (sniff.family === "m4a-brand") return "m4a";
        const audioHint = isAudioLikeItem(it) || isPairAudioRole(it);
        if (sniff.family === "mp4-family" && audioHint) return "m4a";
        if (sniff.family === "ebml" && audioHint) return "weba";
        return "";
    }

    function applyDownloadAudioExt(it, ext) {
        if (!it || !ext) return;
        it._sniffedExt = ext;
        it.ext = ext;
        if (it.downFileName) it.downFileName = replaceFileNameExt(it.downFileName, ext);
    }

    async function sniffDownloadExtForItem(it) {
        if (!it || !it.url) return "";
        if (it._sniffedExt) return it._sniffedExt;
        const headers = playHeaderMap(it);
        const reqHeaders = {};
        for (const [k, v] of Object.entries(headers)) {
            if (v != null && v !== "") reqHeaders[k] = String(v);
        }
        reqHeaders.Range = "bytes=0-63";
        const ac = typeof AbortController !== "undefined" ? new AbortController() : null;
        const timer = ac ? setTimeout(() => ac.abort(), 8000) : null;
        try {
            const resp = await fetch(it.url, {
                method: "GET",
                headers: reqHeaders,
                credentials: "omit",
                signal: ac ? ac.signal : undefined,
            });
            if (!resp.ok && resp.status !== 206) return "";
            const raw = await resp.arrayBuffer();
            const sniff = parseMagicContainer(raw);
            it._magicFamily = sniff.family;
            const ext = audioExtFromSniff(it, sniff);
            if (ext) applyDownloadAudioExt(it, ext);
            return ext || "";
        } catch (e) {
            console.warn("sniff download ext failed", it.url, e);
            return "";
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    function dedupeDownloadItems(list) {
        const seen = new Set();
        const out = [];
        for (const it of list || []) {
            if (!it || !it.url) continue;
            const role = isAudioLikeItem(it) ? "audio" : isStreamUrl(it.url, mediaTypeOf(it)) ? "stream" : "video";
            const uk =
                (typeof mediaDedupeKey === "function" ? mediaDedupeKey(it.url) : "") ||
                String(it.url).split("?")[0].toLowerCase();
            const k = role + ":" + uk;
            if (seen.has(k)) continue;
            seen.add(k);
            out.push(it);
        }
        return out;
    }

    function formatRangeTime(sec, fallbackStr) {
        if (fallbackStr) return String(fallbackStr);
        if (sec == null || Number.isNaN(+sec)) return "";
        if (typeof secToTime === "function") return secToTime(+sec);
        return String(Math.max(0, Math.floor(+sec)));
    }

    /**
     * 打开 m3u8/mpd 解析下载页（切片分段下载）。
     * 支持 rangeStart/rangeEnd（与选中时填写的时间段一致）。
     */
    function openStreamDownloader(it, options = {}) {
        const data = toCatDownloadItem(it, 0) || it;
        const parsing =
            data.parsing ||
            (/\.mpd(\?|#|$)/i.test(data.url || "") || mediaTypeOf(it) === "dash"
                ? "mpd"
                : "m3u8");
        const headers =
            data.requestHeaders && Object.keys(data.requestHeaders).length
                ? data.requestHeaders
                : playHeaderMap(it);
        const qs = new URLSearchParams({
            url: data.url,
            title: data.title || data.name || document.title || "media",
            filename: data.downFileName || "",
            tabid: String(data.tabId != null && data.tabId != -1 ? data.tabId : tabId || 0),
            initiator:
                data.initiator ||
                headers.referer ||
                headers.Referer ||
                data.referer ||
                data._pageUrl ||
                "",
            autoDown: options.autoDown === false ? "0" : "1",
            autoClose: options.autoClose === false ? "0" : "1",
        });
        if (headers && Object.keys(headers).length) {
            qs.set("requestHeaders", JSON.stringify(headers));
        }
        if (options.rangeStart != null && String(options.rangeStart) !== "") {
            qs.set("rangeStart", String(options.rangeStart));
        }
        if (options.rangeEnd != null && String(options.rangeEnd) !== "") {
            qs.set("rangeEnd", String(options.rangeEnd));
        }
        if (options.taskId) qs.set("taskId", String(options.taskId));
        chrome.tabs.create({
            url: `/${parsing}.html?${qs}`,
            active: options.active === true,
        });
    }

    /**
     * 下载选中音/视频到本机：
     * - 下载前若尚未检测过可合并项，自动跑一次（已手动检测则跳过）
     * - progressive 视频+音频 → 猫抓分段下载器（同 URL 去重）
     * - 音频按魔数改扩展名
     * - m3u8/dash → 切片下载；若已设多段时间范围则每段各开一个任务
     */
    async function doDownloadSelectedLocal() {
        const btn = document.getElementById("btnDownloadLocal");
        if (btn) btn.disabled = true;
        try {
            let chosen = getSelectedItems();
            if (!chosen.length) {
                setStatus("请先选择要下载的媒体");
                return;
            }
            if (!avDetectAttempted) {
                setStatus("下载前检测可合并项…");
                await detectAvMergePairs();
                chosen = getSelectedItems();
            }
            const media = dedupeDownloadItems(chosen.filter(isDownloadableLocalItem));
            if (!media.length) {
                setStatus("当前选中项中没有可下载的视频或音频");
                return;
            }

            const progressive = [];
            let streamJobs = 0;
            let rangeJobs = 0;
            let audioN = 0;
            let videoN = 0;

            for (const it of media) {
                const type = mediaTypeOf(it);
                const isStream =
                    type === "m3u8" ||
                    type === "dash" ||
                    isStreamUrl(it.url, type) ||
                    it.parsing === "m3u8" ||
                    it.parsing === "mpd";

                if (isStream) {
                    const ranges = getItemRanges(it);
                    const clips =
                        ranges.length > 0
                            ? ranges
                            : [{ startSec: null, endSec: null, startStr: "", endStr: "" }];
                    for (const r of clips) {
                        const hasStart = r.startSec != null && !Number.isNaN(+r.startSec);
                        const hasEnd = r.endSec != null && +r.endSec > 0;
                        const opts = { autoDown: true, autoClose: true, active: false };
                        if (hasStart || hasEnd) {
                            opts.rangeStart = formatRangeTime(
                                hasStart ? Math.max(0, +r.startSec) : 0,
                                r.startStr
                            );
                            if (hasEnd) {
                                opts.rangeEnd = formatRangeTime(+r.endSec, r.endStr);
                            }
                            rangeJobs++;
                        }
                        openStreamDownloader(it, opts);
                        streamJobs++;
                    }
                    continue;
                }

                await sniffDownloadExtForItem(it);
                if (isAudioLikeItem(it) || it._sniffedExt) {
                    audioN++;
                } else {
                    videoN++;
                }
                progressive.push(it);
            }

            if (progressive.length) {
                catDownloadLocal(progressive);
            }

            const parts = [];
            if (progressive.length) {
                parts.push(`分段下载 ${progressive.length}（视频 ${videoN} · 音频 ${audioN}）`);
            }
            if (streamJobs) {
                parts.push(
                    `流媒体任务 ${streamJobs}` + (rangeJobs ? `（含 ${rangeJobs} 个时间段）` : "")
                );
            }
            setStatus(
                parts.length
                    ? `已开始：${parts.join(" · ")} · 下载在新标签页进行`
                    : "没有可下载的媒体"
            );
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    async function doIngest() {
        const chosen = getSelectedItems();
        if (!chosen.length) {
            setStatus("请先选择媒体");
            return;
        }
        const iosGate = await confirmIosWebIfNeeded(chosen, "入库");
        if (!iosGate.ok) return;
        if (!confirmJasnaIfNeeded("入库选中媒体")) {
            setStatus("已取消入库（jasna 确认）");
            return;
        }
        const pageUrl = await getPageUrl();
        const first = chosen[0];
        const dlg = await LMW.openIngestDialog({
            title: first.title || first.name || (await resolvePageTitle()).title || document.title || "media",
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
            isJasnaChecked() ||
            (typeof G !== "undefined" && G.lmwUseJasna === true);
        const restricted =
            dlg.restricted === true ||
            !!(document.getElementById("lmRestricted") && document.getElementById("lmRestricted").checked) ||
            (typeof G !== "undefined" && G.lmwRestricted === true);
        const chosenKeys = chosen.map((it) => it._key).filter(Boolean);
        const btn = document.getElementById("btnIngest");
        if (btn) btn.disabled = true;
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
                    if (iosGate.allow) row.allow_ios_incompatible = true;
                    if (it._headers) row.headers = Object.assign({}, row.headers, it._headers);
                    const hasStart = r.startSec != null && !Number.isNaN(+r.startSec);
                    const hasEnd = r.endSec != null && +r.endSec > 0;
                    // itemToIngest copies first-range _startSec/_endSec; always replace
                    // per clip so "to end" (null end) does not keep the previous segment's end.
                    delete row.start_sec;
                    delete row.end_sec;
                    if (hasStart || hasEnd) {
                        row.start_sec = hasStart ? Math.max(0, +r.startSec) : 0;
                        if (hasEnd) row.end_sec = +r.endSec;
                        clipCount++;
                    }
                    if (restricted) row.restricted = true;
                    payload.push(row);
                }
            }
            const taskTotal = payload.length;
            const prefix =
                `入库 0/${taskTotal}` +
                (clipCount ? `（含 ${clipCount} 段）` : "") +
                (tags.length ? " · 标签 " + tags.join(",") : "") +
                (restricted ? " · 限制级" : "") +
                (useJasna ? " · JasnaBridge" : "");
            setStatus(prefix + " · 准备提交…");
            console.info("[ingest]", {
                selected: chosen.length,
                tasks: taskTotal,
                clipCount,
                useJasna,
                restricted,
                tags,
            });

            /** Status bar + console for multi-item ingest progress (no server change). */
            const onIngestProgress = (job, meta) => {
                // Jasna path: onProgress({ message })
                if (job && job.message && !meta) {
                    setStatus(String(job.message));
                    return;
                }
                if (meta && meta.message) {
                    setStatus(String(meta.message));
                    if (meta.phase === "job_done" || meta.phase === "fallback_done") {
                        console.info("[ingest]", meta.phase, meta.message, job || "");
                    }
                    return;
                }
                if (job && job.message) {
                    setStatus(String(job.message));
                }
            };

            let result;
            if (useJasna) {
                result = await LMW.pushItemsViaJasnaBridge(payload, "default", {
                    tags,
                    restricted: restricted,
                    waitBridge: false,
                    onProgress: (p) => {
                        if (p && p.message) {
                            setStatus(String(p.message));
                            console.info("[ingest-jasna]", p.message);
                        }
                    },
                });
            } else {
                result = await LMW.pushItems(payload, "default", {
                    tags,
                    restricted: restricted,
                    allow_ios_incompatible: iosGate.allow,
                    onProgress: onIngestProgress,
                });
            }
            const rangeHints = chosen
                .map((it) => formatRangeLabel(it))
                .filter(Boolean)
                .join("；");
            let msg =
                `完成 ${taskTotal} 项：成功 ${result.success || 0}, 链接重复 ${result.duplicates || 0}` +
                (result.contentDuplicates
                    ? `, 内容重复 ${result.contentDuplicates}`
                    : "") +
                `, 回退上传 ${result.fallbackOk || 0}, 失败 ${result.failed || 0}`;
            if (result.duplicates > 0) {
                msg +=
                    "（「链接重复」= 同一 URL+相同起止时间已入库；要截另一段请改时间后重选）";
            }
            if (result.contentDuplicates > 0) {
                msg += "（「内容重复」= 文件字节与库内已有完全相同，未再建条目）";
            }
            if (rangeHints) msg += " · 本次范围 " + rangeHints;
            if (tags.length) msg += " · 标签 " + tags.join(",");
            if (useJasna && (result.bridgeJobIds || []).length) {
                msg += ` · JasnaBridge 已入队 #${result.bridgeJobIds.join(",")}`;
            }
            if (useJasna && (result.errors || []).length) {
                msg += " · " + result.errors.slice(0, 2).join("; ");
            }
            // 失败任务摘要（状态栏 + 控制台）
            const failJobs = (result.jobs || []).filter(
                (j) => j && j.status && j.status !== "success"
            );
            if (failJobs.length) {
                const lines = failJobs.slice(0, 5).map((j, i) => {
                    const lab =
                        (typeof LMW._jobProgressLabel === "function"
                            ? LMW._jobProgressLabel(j, payload)
                            : j.url || `#${j.id}`) || "?";
                    return `${i + 1}. ${j.status}: ${String(j.error_message || "").slice(0, 100)} · ${lab}`;
                });
                console.error("[ingest] failed jobs", failJobs);
                msg += "\n失败详情：\n" + lines.join("\n");
                if (failJobs.length > 5) msg += `\n…另有 ${failJobs.length - 5} 条，见控制台 [ingest]`;
            }
            // 处理完后自动移除：提交成功即从列表去掉对应项（含成功/重复，排除整批失败）
            const processed =
                (result.success || 0) +
                    (result.duplicates || 0) +
                    (result.contentDuplicates || 0) +
                    (result.fallbackOk || 0) >
                0;
            if (isAutoRemoveChecked() && processed && chosenKeys.length) {
                const removed = removeItemsByKeys(chosenKeys);
                if (removed) {
                    msg += ` · 已自动移除列表 ${removed} 项`;
                    render();
                }
            }
            if (useJasna && (result.bridgeJobIds || []).length) {
                setStatus(msg + " · 中间件后台去码中…");
                LMW.waitJasnaBridgeJobs(result.bridgeJobIds, {
                    onUpdate: (t) => setStatus(msg + " · " + t),
                })
                    .then((jjobs) => {
                        const ok = (jjobs || []).filter((j) => j.status === "done").length;
                        const fail = (jjobs || []).filter((j) => j.status === "failed").length;
                        setStatus(
                            msg +
                                ` · 去码结束：成功 ${ok}` +
                                (fail ? ` · 失败 ${fail}` : "") +
                                ((jjobs || [])
                                    .filter((j) => j.status === "failed" && (j.message || j.error_message))
                                    .map(
                                        (j) =>
                                            ` #${j.id}:${String(j.message || j.error_message).slice(0, 80)}`
                                    )
                                    .join("") || "")
                        );
                    })
                    .catch((e) => setStatus(msg + " · JasnaBridge 轮询失败: " + (e.message || e)));
            } else {
                setStatus(msg, { error: (result.failed || 0) > 0 });
            }
            console.info("[ingest] done", result);
        } catch (e) {
            console.error("[ingest] fatal", e);
            setStatus("入库失败: " + ((e && e.message) || e), { error: true });
        } finally {
            if (btn) btn.disabled = false;
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
            else if (manualAvMode && !manualAvBusy) {
                exitManualAvMode();
                setStatus("已取消手动视音频合并");
            } else if (multiMergeMode && !multiMergeBusy) {
                exitMultiMergeMode();
                setStatus("已取消多段合并");
            } else hideCardTip();
        }
    });
    $(window).on("scroll resize", () => {
        if (tipActiveCard) positionCardTip(tipActiveCard);
    });

    $("#btnRefreshList").on("click", () => {
        if (listSource === "parse") return parsePageImages();
        return loadCaught();
    });
    $("#btnListDedupe").on("click", () => oneClickListDedupe());
    $("#btnDetectAvMerge").on("click", () => detectAvMergePairs());
    $("#btnMergeAvSelected").on("click", () => mergeSelectedAv());
    $("#btnManualAvMerge").on("click", () => onManualAvBtnClick());
    $("#btnMultiMerge").on("click", () => onMultiMergeBtnClick());
    $("#btnDeleteSelected").on("click", () => deleteSelectedItems());
    $("#btnOpenManage").on("click", () => {
        chrome.tabs.create({ url: chrome.runtime.getURL("lmw-media-manage.html") });
    });
    $("#btnSelectAll").on("click", () => {
        const list = getFilteredItems();
        if (!list.length) {
            updateSelectAllBtn();
            return;
        }
        const allOn = isAllFilteredSelected();
        if (allOn) {
            list.forEach((it) => selected.delete(it._key));
        } else {
            list.forEach((it) => selected.add(it._key));
        }
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
    $("#btnDownloadLocal").on("click", () => doDownloadSelectedLocal());
    $("#btnIngest").on("click", doIngest);

    // 默认开启；可持久化偏好
    const $autoRemove = $("#lmAutoRemove");
    if ($autoRemove.length) {
        let autoRm = true;
        if (typeof G !== "undefined" && G.lmwAutoRemoveAfterProcess != null) {
            autoRm = !!G.lmwAutoRemoveAfterProcess;
        }
        $autoRemove.prop("checked", autoRm);
        $autoRemove.on("change", function () {
            const on = !!this.checked;
            if (typeof G !== "undefined") G.lmwAutoRemoveAfterProcess = on;
            try {
                chrome.storage.sync.set({ lmwAutoRemoveAfterProcess: on });
                chrome.storage.local.set({ lmwAutoRemoveAfterProcess: on });
            } catch (e) { /* ignore */ }
        });
    }

    const $previewMode = $("#lmPreviewMode");
    if ($previewMode.length) {
        let mode = resolvePreviewMode();
        applyPreviewMode(mode);
        try {
            chrome.storage.local.get(["lmwPreviewMode", "lmwLargePreview"], (r) => {
                if (!r) return;
                const stored = normalizePreviewMode(r.lmwPreviewMode);
                if (stored) mode = stored;
                else if (r.lmwLargePreview) mode = "large";
                applyPreviewMode(mode);
            });
        } catch (_) {}
        $previewMode.on("change", function () {
            const m = normalizePreviewMode(this.value) || "normal";
            applyPreviewMode(m);
            persistPreviewMode(m);
        });
    }
    updateMultiMergeBtn();
    updateManualAvBtn();

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
        await LMW.health();
    } catch (e) {
        setStatus("无法连接 LocalMediaWeb: " + ((e && e.message) || e) + "（请先 start.bat）");
    }
    if ($jasna.length) {
        try {
            const jb = await LMW.jasnaBridgeHealth();
            if (!jb.ok) {
                $jasna.attr(
                    "title",
                    (jb.message || "JasnaBridge 不可用") +
                        " — 勾选去码前请启动 JasnaBridge\\start.bat"
                );
            } else {
                $jasna.attr(
                    "title",
                    "视频将提交本机 JasnaBridge 去码后再入库（不占用 LMW 服务端 GPU）"
                );
            }
        } catch (e2) {
            $jasna.attr("title", "无法探测 JasnaBridge（默认 http://127.0.0.1:8791）");
        }
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
