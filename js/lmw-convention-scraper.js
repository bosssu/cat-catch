/**
 * Convention scraper: multi-URL browse automation + cat-catch media ingest.
 * Depends: init.js (G), function.js, local-media-web.js (LMW),
 * lmw-av-utils.js (LMWAv), lmw-scraper-drivers.js (LMWScraperDrivers).
 */
(function () {
    "use strict";

    /**
     * 必须用 sync：扩展 update / 开发者工具「重新加载」时
     * init.js 会 chrome.storage.local.clear()，local 里的配置会丢。
     * sync 与其它插件选项一致，可跨重载保留。
     */
    const STORAGE_KEY = "lmwConventionScraper";

    /** @type {{ links: any[], defaults: any }} */
    let config = {
        links: [],
        defaults: {
            targetCount: 8,
            intervalMs: 2000,
            maxWaitMs: 180000,
            /** 入库过滤：最大体积 MB（0=不限），默认 500 */
            maxSizeMb: 500,
            /** 入库过滤：最大时长分钟（0=不限），默认 10 */
            maxDurationMin: 10,
            restricted: false,
            useJasna: false,
            closeTab: true,
        },
    };

    let running = false;
    let abort = false;
    /** @type {string|null} */
    let activeLinkId = null;
    let saveTimer = null;
    let saveSeq = 0;

    const $ = (id) => document.getElementById(id);

    function uid() {
        return "l" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    /** 进入标签：空 / 无 / none 视为不进入侧栏 */
    function normalizeNavTab(raw) {
        const s = String(raw == null ? "" : raw).trim();
        if (!s || s === "无" || /^none$/i.test(s) || s === "-" || s === "—") return "";
        return s;
    }

    function displayNavTab(raw) {
        const s = normalizeNavTab(raw);
        return s || "无";
    }

    const NAV_TAB_OPTIONS = ["无", "推荐", "精选", "关注", "朋友", "直播", "我的", "放映厅"];

    function fillNavTabSelect(sel, current) {
        if (!sel) return;
        const cur = displayNavTab(current);
        sel.innerHTML = "";
        // 保证当前自定义值也在列表里
        const opts = NAV_TAB_OPTIONS.slice();
        if (cur && !opts.includes(cur)) opts.push(cur);
        for (const o of opts) {
            const opt = document.createElement("option");
            opt.value = o;
            opt.textContent = o;
            if (o === cur) opt.selected = true;
            sel.appendChild(opt);
        }
    }

    function log(msg, cls = "info") {
        const el = $("log");
        if (!el) return;
        const t = new Date().toLocaleTimeString();
        const line = document.createElement("div");
        line.className = cls;
        line.textContent = `[${t}] ${msg}`;
        el.appendChild(line);
        el.scrollTop = el.scrollHeight;
    }

    function sleep(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }

    function storageGet(area, defaults) {
        return new Promise((resolve) => {
            try {
                area.get(defaults, (items) => {
                    if (chrome.runtime.lastError) {
                        resolve(defaults);
                        return;
                    }
                    resolve(items || defaults);
                });
            } catch (_) {
                resolve(defaults);
            }
        });
    }

    function storageSet(area, obj) {
        return new Promise((resolve, reject) => {
            try {
                area.set(obj, () => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                        return;
                    }
                    resolve();
                });
            } catch (e) {
                reject(e);
            }
        });
    }

    function applyRawConfig(raw) {
        if (!raw || typeof raw !== "object") return false;
        if (Array.isArray(raw.links)) {
            config.links = raw.links
                .filter((x) => x && typeof x === "object")
                .map((x) => ({
                    id: x.id || uid(),
                    url: String(x.url || "").trim(),
                    /** 进入页后要点的侧栏；空/"无"=不点 */
                    navTab: normalizeNavTab(x.navTab),
                    avSeparated: !!x.avSeparated,
                    targetCount: Math.max(1, parseInt(x.targetCount, 10) || 8),
                }));
        }
        if (raw.defaults && typeof raw.defaults === "object") {
            config.defaults = Object.assign({}, config.defaults, raw.defaults);
        }
        return true;
    }

    async function loadConfig() {
        // 1) sync（主存储，抗 local.clear）
        const syncItems = await storageGet(chrome.storage.sync, { [STORAGE_KEY]: null });
        let raw = syncItems[STORAGE_KEY];
        let from = "sync";

        // 2) 兼容旧版 local（升级后迁移到 sync）
        if (!raw || typeof raw !== "object" || !Array.isArray(raw.links) || !raw.links.length) {
            const localItems = await storageGet(chrome.storage.local, { [STORAGE_KEY]: null });
            const localRaw = localItems[STORAGE_KEY];
            if (localRaw && typeof localRaw === "object" && Array.isArray(localRaw.links) && localRaw.links.length) {
                raw = localRaw;
                from = "local";
            } else if (raw && typeof raw === "object") {
                from = "sync";
            } else {
                raw = localRaw || raw;
                from = localRaw ? "local" : "none";
            }
        }

        applyRawConfig(raw);

        // 从 local 迁过来或仅有 local：立刻写入 sync
        if (from === "local" && config.links.length) {
            try {
                await persistConfigNow();
            } catch (e) {
                console.warn("migrate convention scraper to sync failed", e);
            }
        }
        return config;
    }

    function readGlobalsFromForm() {
        const defCount = $("defCount");
        const intervalMs = $("intervalMs");
        const maxWaitMs = $("maxWaitMs");
        const maxSizeMb = $("maxSizeMb");
        const maxDurationMin = $("maxDurationMin");
        const optRestricted = $("optRestricted");
        const optJasna = $("optJasna");
        const optCloseTab = $("optCloseTab");
        if (!defCount) return;
        config.defaults.targetCount = Math.max(1, parseInt(defCount.value, 10) || 8);
        config.defaults.intervalMs = Math.max(300, parseInt(intervalMs.value, 10) || 2000);
        config.defaults.maxWaitMs = Math.max(10000, parseInt(maxWaitMs.value, 10) || 180000);
        if (maxSizeMb) {
            const v = parseFloat(maxSizeMb.value);
            config.defaults.maxSizeMb = Number.isFinite(v) && v >= 0 ? v : 500;
        }
        if (maxDurationMin) {
            const v = parseFloat(maxDurationMin.value);
            config.defaults.maxDurationMin = Number.isFinite(v) && v >= 0 ? v : 10;
        }
        config.defaults.restricted = !!(optRestricted && optRestricted.checked);
        config.defaults.useJasna = !!(optJasna && optJasna.checked);
        config.defaults.closeTab = !!(optCloseTab && optCloseTab.checked);
    }

    /** 可序列化快照（避免把运行时字段写进 storage） */
    function snapshotConfig() {
        const maxSizeMb = Number(config.defaults.maxSizeMb);
        const maxDurationMin = Number(config.defaults.maxDurationMin);
        return {
            links: (config.links || []).map((x) => ({
                id: x.id,
                url: x.url || "",
                navTab: normalizeNavTab(x.navTab),
                avSeparated: !!x.avSeparated,
                targetCount: Math.max(1, parseInt(x.targetCount, 10) || 8),
            })),
            defaults: {
                targetCount: Math.max(1, parseInt(config.defaults.targetCount, 10) || 8),
                intervalMs: Math.max(300, parseInt(config.defaults.intervalMs, 10) || 2000),
                maxWaitMs: Math.max(10000, parseInt(config.defaults.maxWaitMs, 10) || 180000),
                maxSizeMb: Number.isFinite(maxSizeMb) && maxSizeMb >= 0 ? maxSizeMb : 500,
                maxDurationMin:
                    Number.isFinite(maxDurationMin) && maxDurationMin >= 0 ? maxDurationMin : 10,
                restricted: !!config.defaults.restricted,
                useJasna: !!config.defaults.useJasna,
                closeTab: config.defaults.closeTab !== false,
            },
        };
    }

    /**
     * 串行写入，避免并行 set 时旧快照覆盖新值（如目标条数 30 被 3 盖掉）。
     * 切勿在成功后用 payload.links 整体替换 config.links：
     * 列表 UI 闭包持有旧对象引用，替换后界面改的是孤儿对象，storage 仍是旧数。
     */
    let saveChain = Promise.resolve();

    async function persistConfigNow() {
        const seq = ++saveSeq;
        readGlobalsFromForm();
        const payload = snapshotConfig();
        // 若期间又有更新，等链上最新一次再写
        await Promise.resolve();
        if (seq !== saveSeq) return null;

        await storageSet(chrome.storage.sync, { [STORAGE_KEY]: payload });
        try {
            await storageSet(chrome.storage.local, { [STORAGE_KEY]: payload });
        } catch (_) {}

        if (seq !== saveSeq) return payload;
        // 只同步 defaults 字段，不要替换 links 数组引用
        Object.assign(config.defaults, payload.defaults);
        return payload;
    }

    /** 立即保存（增删改后调用）；失败打日志；串行排队 */
    function saveConfig() {
        saveChain = saveChain
            .then(() => persistConfigNow())
            .catch((e) => {
                console.warn("convention scraper save failed", e);
                log("配置保存失败：" + (e.message || e), "err");
            });
        return saveChain;
    }

    /** 输入时防抖保存（数字/URL 编辑中用较长间隔，减少中间态 3→30 写脏） */
    function saveConfigDebounced(ms = 400) {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = null;
            saveConfig();
        }, ms);
    }

    function flushSaveSoon() {
        if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
        }
        return saveConfig();
    }

    function applyGlobalsToForm() {
        $("defCount").value = String(config.defaults.targetCount || 8);
        $("intervalMs").value = String(config.defaults.intervalMs || 2000);
        $("maxWaitMs").value = String(config.defaults.maxWaitMs || 180000);
        if ($("maxSizeMb")) {
            const v = config.defaults.maxSizeMb;
            $("maxSizeMb").value = String(v != null && v !== "" ? v : 500);
        }
        if ($("maxDurationMin")) {
            const v = config.defaults.maxDurationMin;
            $("maxDurationMin").value = String(v != null && v !== "" ? v : 10);
        }
        $("optRestricted").checked = !!config.defaults.restricted;
        $("optJasna").checked = !!config.defaults.useJasna;
        $("optCloseTab").checked = config.defaults.closeTab !== false;
        $("newCount").value = String(config.defaults.targetCount || 8);
    }

    function renderLinks() {
        const box = $("linkList");
        if (!box) return;
        try {
            box.innerHTML = "";
            if (!config.links.length) {
                const empty = document.createElement("div");
                empty.className = "cs-empty";
                empty.textContent =
                    "暂无链接。在下方填写 URL（如 https://www.douyin.com/）后点「添加」。";
                box.appendChild(empty);
                return;
            }
            config.links.forEach((link, i) => {
                const row = document.createElement("div");
                row.className = "cs-link-item" + (activeLinkId === link.id ? " running" : "");
                row.dataset.id = link.id;

                const idx = document.createElement("span");
                idx.className = "cs-idx";
                idx.textContent = String(i + 1);

                const urlIn = document.createElement("input");
                urlIn.type = "text"; // text 比 url 更宽松，避免浏览器拦截粘贴
                urlIn.className = "cs-input url";
                urlIn.placeholder = "https://www.douyin.com/";
                urlIn.spellcheck = false;
                urlIn.autocomplete = "off";
                urlIn.value = link.url || "";
                urlIn.disabled = running;
                urlIn.addEventListener("input", () => {
                    link.url = urlIn.value.trim();
                    saveConfigDebounced(500);
                });
                urlIn.addEventListener("change", () => {
                    link.url = urlIn.value.trim();
                    flushSaveSoon();
                });
                urlIn.addEventListener("blur", () => {
                    link.url = urlIn.value.trim();
                    flushSaveSoon();
                });

                const tabLab = document.createElement("label");
                tabLab.className = "cs-check";
                tabLab.title = "打开主页后自动进入的侧栏；「无」= 不点侧栏";
                tabLab.appendChild(document.createTextNode("进入标签 "));
                const tabIn = document.createElement("select");
                tabIn.className = "cs-input";
                tabIn.style.width = "96px";
                tabIn.disabled = running;
                fillNavTabSelect(tabIn, link.navTab);
                tabIn.addEventListener("change", () => {
                    link.navTab = normalizeNavTab(tabIn.value);
                    saveConfig();
                });
                tabLab.appendChild(tabIn);

                const avLab = document.createElement("label");
                avLab.className = "cs-check";
                avLab.title = "打开：完整 AV 直入，其余检测可合并后合并入库";
                const avCb = document.createElement("input");
                avCb.type = "checkbox";
                avCb.checked = !!link.avSeparated;
                avCb.disabled = running;
                avCb.addEventListener("change", () => {
                    link.avSeparated = avCb.checked;
                    saveConfig();
                });
                avLab.appendChild(avCb);
                avLab.appendChild(document.createTextNode(" 存在音视频分离"));

                const cntLab = document.createElement("label");
                cntLab.className = "cs-check";
                cntLab.appendChild(document.createTextNode("目标条数 "));
                const cntIn = document.createElement("input");
                cntIn.type = "number";
                cntIn.className = "cs-input num";
                cntIn.min = "1";
                cntIn.max = "500";
                cntIn.step = "1";
                cntIn.style.width = "64px";
                cntIn.value = String(
                    Math.max(1, parseInt(link.targetCount, 10) || config.defaults.targetCount || 8)
                );
                cntIn.disabled = running;
                /** 仅在合法完整数字时写回；编辑中途空串不要落成 1 */
                const applyCount = (persist) => {
                    const raw = String(cntIn.value || "").trim();
                    if (raw === "") {
                        if (persist) {
                            // blur 时空值：恢复显示为当前已存值
                            cntIn.value = String(link.targetCount || 8);
                        }
                        return;
                    }
                    const n = parseInt(raw, 10);
                    if (!Number.isFinite(n) || n < 1) return;
                    link.targetCount = Math.min(500, n);
                    if (persist) flushSaveSoon();
                };
                // input：只更新内存，防抖保存最终值（避免 3 被先写入覆盖 30）
                cntIn.addEventListener("input", () => {
                    const raw = String(cntIn.value || "").trim();
                    const n = parseInt(raw, 10);
                    if (Number.isFinite(n) && n >= 1) {
                        link.targetCount = Math.min(500, n);
                        saveConfigDebounced(500);
                    }
                });
                cntIn.addEventListener("change", () => applyCount(true));
                cntIn.addEventListener("blur", () => applyCount(true));
                cntLab.appendChild(cntIn);

                const del = document.createElement("button");
                del.type = "button";
                del.className = "button2 danger";
                del.textContent = "删除";
                del.disabled = running;
                del.addEventListener("click", () => {
                    config.links = config.links.filter((x) => x.id !== link.id);
                    saveConfig();
                    renderLinks();
                });

                row.appendChild(idx);
                row.appendChild(urlIn);
                row.appendChild(tabLab);
                row.appendChild(avLab);
                row.appendChild(cntLab);
                row.appendChild(del);
                box.appendChild(row);
            });
        } catch (e) {
            console.error("renderLinks failed", e);
            box.innerHTML = "";
            const err = document.createElement("div");
            err.className = "cs-empty";
            err.style.color = "#f87171";
            err.textContent =
                "列表渲染失败：" + ((e && e.message) || e) + "（请看控制台）· 内存中仍有 " +
                (config.links && config.links.length) +
                " 条";
            box.appendChild(err);
        }
    }

    function setRunningUi(on) {
        running = on;
        $("btnStart").disabled = on;
        $("btnStop").disabled = !on;
        $("btnAdd").disabled = on;
        $("newUrl").disabled = on;
        if ($("newNavTab")) $("newNavTab").disabled = on;
        $("newAvSep").disabled = on;
        $("newCount").disabled = on;
        [
            "defCount",
            "intervalMs",
            "maxWaitMs",
            "maxSizeMb",
            "maxDurationMin",
            "optRestricted",
            "optJasna",
            "optCloseTab",
        ].forEach((id) => {
            if ($(id)) $(id).disabled = on;
        });
        renderLinks();
    }

    async function getTabMediaList(tabId) {
        let list = (await chrome.runtime.sendMessage({ Message: "getData", tabId })) || [];
        if (!Array.isArray(list)) list = [];
        return list;
    }

    function uniqueUrlCount(list) {
        const s = new Set();
        for (const it of list || []) {
            if (it && it.url) s.add(it.url);
        }
        return s.size;
    }

    async function clearTabMedia(tabId) {
        try {
            await chrome.runtime.sendMessage({ Message: "clearData", type: true, tabId });
        } catch (e) {
            console.warn("clearData", e);
        }
    }

    function waitTabComplete(tabId, timeoutMs = 60000) {
        return new Promise((resolve) => {
            let done = false;
            const finish = (ok) => {
                if (done) return;
                done = true;
                chrome.tabs.onUpdated.removeListener(onUpd);
                resolve(ok);
            };
            const onUpd = (id, info) => {
                if (id === tabId && info.status === "complete") finish(true);
            };
            chrome.tabs.onUpdated.addListener(onUpd);
            chrome.tabs.get(tabId).then((t) => {
                if (t && t.status === "complete") finish(true);
            }).catch(() => finish(false));
            setTimeout(() => finish(false), timeoutMs);
        });
    }

    async function runOneLink(link, index, total) {
        const url = (link.url || "").trim();
        if (!url) {
            log(`#${index + 1}/${total} 跳过空 URL`, "warn");
            return;
        }
        const targetCount = Math.max(1, parseInt(link.targetCount, 10) || config.defaults.targetCount || 8);
        const intervalMs = config.defaults.intervalMs || 2000;
        const maxWaitMs = config.defaults.maxWaitMs || 180000;
        const avSeparated = !!link.avSeparated;
        const navTab = normalizeNavTab(link.navTab);

        activeLinkId = link.id;
        renderLinks();

        const driver = LMWScraperDrivers.matchDriver(url);
        log(
            `#${index + 1}/${total} 打开 ${url} · 驱动 ${driver.id} · 目标 ${targetCount}` +
                ` · 进入标签「${displayNavTab(link.navTab)}」` +
                ` · 分离${avSeparated ? "开" : "关"}`,
            "info"
        );

        let tab;
        try {
            tab = await chrome.tabs.create({ url, active: true });
        } catch (e) {
            log(`打开标签失败：${e.message || e}`, "err");
            return;
        }
        const tabId = tab.id;
        log(`标签 tabId=${tabId}，等待加载…`, "info");
        await waitTabComplete(tabId, 90000);
        if (abort) return;

        await clearTabMedia(tabId);
        await sleep(400);

        try {
            if (driver.prepare) {
                const pr = await driver.prepare(tabId, {
                    navTab,
                    waitComplete: (tid, ms) => waitTabComplete(tid, ms || 60000),
                });
                if (pr && pr.ok === false) {
                    log(`prepare 失败：${pr.error || JSON.stringify(pr)}`, "err");
                } else if (pr) {
                    if (navTab) {
                        const nr = pr.navResult;
                        const st = nr && nr.status;
                        if (nr && nr.ok) {
                            log(
                                `已进入标签「${navTab}」· method=${nr.method || nr.action}` +
                                    (nr.href ? ` · ${String(nr.href).slice(0, 70)}` : "") +
                                    (st ? ` · urlMatch=${st.urlMatch}` : ""),
                                "ok"
                            );
                            if (nr.leftLabels && nr.leftLabels.length) {
                                log(`侧栏可见文案: ${nr.leftLabels.slice(0, 12).join(" / ")}`, "info");
                            }
                        } else {
                            log(
                                `未能确认标签「${navTab}」：${(nr && (nr.error || nr.action)) || "unknown"}` +
                                    (nr && nr.leftLabels
                                        ? ` · 侧栏=${nr.leftLabels.slice(0, 10).join("/")}`
                                        : "") +
                                    " — 已尝试强制打开 /?recommend=1 等路由",
                                "warn"
                            );
                        }
                    }
                    log(
                        `prepare ok · mode=${pr.mode || "?"} videos=${pr.videos ?? "?"} ` +
                            `links=${pr.videoLinks ?? "?"} played=${pr.played ?? "?"} ` +
                            `title=${(pr.title || "").slice(0, 40)}`,
                        "info"
                    );
                    if (pr.dataE2eSample && pr.dataE2eSample.length) {
                        log(`data-e2e: ${pr.dataE2eSample.slice(0, 12).join(", ")}`, "info");
                    }
                    if ((pr.videos || 0) === 0 && (pr.videoLinks || 0) === 0) {
                        log(
                            "页面尚无 video / 视频链接：可能未登录、验证码拦截或 Feed 未渲染。",
                            "warn"
                        );
                    }
                } else {
                    log("prepare 无返回值", "warn");
                }
            }
        } catch (e) {
            log(`prepare 异常：${e.message || e}`, "warn");
        }

        // Prefer full browse loop: harvest → open each /video/id → swipe next
        if (typeof driver.runBrowse === "function") {
            log("开始浏览：收集视频链接 → 逐个进入播放页 → 上下滑切换", "info");
            try {
                const browseResult = await driver.runBrowse({
                    tabId,
                    listUrl: url,
                    targetCount,
                    intervalMs,
                    maxWaitMs,
                    navTab,
                    abortFn: () => abort,
                    onLog: (m, cls) => log(m, cls || "info"),
                    getCount: async (tid) => uniqueUrlCount(await getTabMediaList(tid)),
                    waitComplete: (tid, ms) => waitTabComplete(tid, ms || 60000),
                });
                log(
                    `浏览结束 · 访问视频 ${browseResult.visited || 0} 个 · 嗅探 ${browseResult.count || 0}`,
                    "ok"
                );
            } catch (e) {
                log(`浏览循环异常：${e.message || e}`, "err");
            }
        } else {
            // legacy step loop
            const t0 = Date.now();
            let lastCount = 0;
            let steps = 0;
            while (!abort) {
                if (Date.now() - t0 > maxWaitMs) {
                    log(`达到最长等待 ${maxWaitMs}ms，停止模拟`, "warn");
                    break;
                }
                try {
                    const stepRes = await driver.step(tabId, { intervalMs });
                    steps++;
                    if (stepRes && stepRes.action) {
                        if (steps <= 5 || steps % 5 === 0) {
                            log(`step#${steps} ${stepRes.action}`, "info");
                        }
                    } else if (stepRes && stepRes.ok === false) {
                        log(`step#${steps} 失败：${stepRes.error}`, "err");
                    }
                } catch (e) {
                    log(`step 失败：${e.message || e}`, "warn");
                }
                await sleep(Math.max(200, intervalMs));
                const n = uniqueUrlCount(await getTabMediaList(tabId));
                if (n !== lastCount) {
                    log(`嗅探条数 ${n} / ${targetCount}`, n >= targetCount ? "ok" : "info");
                    lastCount = n;
                }
                if (n >= targetCount) break;
            }
        }

        if (abort) {
            log(`#${index + 1} 已中止（用户停止）`, "warn");
        } else {
            const list = await getTabMediaList(tabId);
            const items = Array.isArray(list) ? list : [];
            const maxSizeMb = Number(config.defaults.maxSizeMb);
            const maxDurationMin = Number(config.defaults.maxDurationMin);
            const maxSizeBytes =
                Number.isFinite(maxSizeMb) && maxSizeMb > 0 ? maxSizeMb * 1024 * 1024 : 0;
            const maxDurationSec =
                Number.isFinite(maxDurationMin) && maxDurationMin > 0 ? maxDurationMin * 60 : 0;
            log(
                `开始分析入库 · ${uniqueUrlCount(items)} 条 URL · 分离${avSeparated ? "开" : "关"}` +
                    ` · 上限 ${maxSizeMb > 0 ? maxSizeMb + "MB" : "体积不限"}` +
                    ` / ${maxDurationMin > 0 ? maxDurationMin + "分钟" : "时长不限"}`,
                "info"
            );
            try {
                const summary = await LMWAv.analyzeAndIngest(items, url, {
                    avSeparated,
                    restricted: !!config.defaults.restricted,
                    useJasna: !!config.defaults.useJasna,
                    tags: [],
                    maxSizeBytes,
                    maxDurationSec,
                    onStatus: (m) => log(m, "info"),
                });
                log(
                    `完成：mode=${summary.mode} 直入=${summary.direct} 合并=${summary.merged || 0}` +
                        (summary.unpaired ? ` 残片=${summary.unpaired}` : "") +
                        (summary.filtered != null ? ` · 过滤${summary.filtered}` : "") +
                        (summary.result
                            ? ` · 入库成功${summary.result.success || 0}/重复${summary.result.duplicates || 0}/失败${summary.result.failed || 0}`
                            : ""),
                    "ok"
                );
            } catch (e) {
                log(`分析入库失败：${e.message || e}`, "err");
            }
        }

        if (config.defaults.closeTab !== false && tabId != null) {
            try {
                await chrome.tabs.remove(tabId);
            } catch (_) {}
        }

        activeLinkId = null;
        renderLinks();
    }

    async function startRun() {
        if (running) return;
        saveConfig();
        if (!config.links.length) {
            log("请先添加至少一条链接", "warn");
            return;
        }
        abort = false;
        setRunningUi(true);
        $("log").innerHTML = "";
        log(`开始 · 共 ${config.links.length} 条链接`, "ok");

        // wait G / LMW ready briefly
        await new Promise((resolve) => {
            const t = setInterval(() => {
                if (typeof G !== "undefined" && (G.initSyncComplete || G.lmwURL)) {
                    clearInterval(t);
                    resolve();
                }
            }, 50);
            setTimeout(resolve, 2000);
        });

        for (let i = 0; i < config.links.length; i++) {
            if (abort) break;
            try {
                await runOneLink(config.links[i], i, config.links.length);
            } catch (e) {
                log(`链接 #${i + 1} 异常：${e.message || e}`, "err");
            }
        }

        setRunningUi(false);
        activeLinkId = null;
        renderLinks();
        log(abort ? "已停止" : "全部链接处理结束", abort ? "warn" : "ok");
    }

    function stopRun() {
        if (!running) return;
        abort = true;
        log("正在停止…", "warn");
        $("btnStop").disabled = true;
    }

    function normalizeUrlInput(raw) {
        let url = String(raw || "").trim();
        if (!url) return "";
        // 允许省略协议
        if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) {
            url = "https://" + url;
        }
        return url;
    }

    function addLink() {
        try {
            const url = normalizeUrlInput($("newUrl") && $("newUrl").value);
            if (!url) {
                log("请输入 URL（例如 https://www.douyin.com/）", "warn");
                return;
            }
            try {
                // eslint-disable-next-line no-new
                new URL(url);
            } catch {
                log("URL 格式无效：" + url, "warn");
                return;
            }
            const avSeparated = !!( $("newAvSep") && $("newAvSep").checked );
            const targetCount = Math.max(
                1,
                parseInt($("newCount") && $("newCount").value, 10) || config.defaults.targetCount || 8
            );
            const navEl = $("newNavTab");
            const navTab = normalizeNavTab(navEl ? navEl.value : "无");
            if (!Array.isArray(config.links)) config.links = [];
            config.links.push({ id: uid(), url, navTab, avSeparated, targetCount });
            if ($("newUrl")) $("newUrl").value = "";
            // 进入标签恢复默认「无」
            if (navEl) {
                fillNavTabSelect(navEl, "无");
            }
            if ($("newAvSep")) $("newAvSep").checked = false;
            renderLinks();
            persistConfigNow()
                .then(() =>
                    log(
                        `已添加并保存：${url}` +
                            ` · 进入标签「${displayNavTab(navTab)}」` +
                            `（共 ${config.links.length} 条，显示在上方列表）`,
                        "ok"
                    )
                )
                .catch((e) => log(`已添加但保存失败：${e.message || e}`, "err"));
        } catch (e) {
            console.error("addLink failed", e);
            log("添加失败：" + ((e && e.message) || e), "err");
        }
    }

    function bind() {
        $("btnAdd").onclick = addLink;
        $("newUrl").addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                addLink();
            }
        });
        $("btnStart").onclick = () => startRun();
        $("btnStop").onclick = () => stopRun();
        $("btnBackManage").onclick = () => {
            chrome.tabs.create({ url: chrome.runtime.getURL("lmw-media-manage.html") });
        };
        [
            "defCount",
            "intervalMs",
            "maxWaitMs",
            "maxSizeMb",
            "maxDurationMin",
            "optRestricted",
            "optJasna",
            "optCloseTab",
        ].forEach((id) => {
            const el = $(id);
            if (!el) return;
            el.addEventListener("change", () => flushSaveSoon());
        });
        // 关页/切走前冲掉防抖，避免 30 只停在内存、磁盘仍是 3
        window.addEventListener("pagehide", () => {
            flushSaveSoon();
        });
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "hidden") flushSaveSoon();
        });
    }

    async function main() {
        await loadConfig();
        applyGlobalsToForm();
        if ($("newNavTab")) fillNavTabSelect($("newNavTab"), "无");
        bind();
        renderLinks();
        const n = config.links.length;
        log(
            n
                ? `就绪。已自动加载 ${n} 条链接（chrome.storage.sync，重载插件后仍保留）。`
                : "就绪。进入标签默认「无」。添加链接后会自动保存。",
            "info"
        );
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", main);
    } else {
        main();
    }
})();
