importScripts("/js/function.js", "/js/templates.js", "/js/init.js");

// Service Worker 5分钟后会强制终止扩展
// https://bugs.chromium.org/p/chromium/issues/detail?id=1271154
// https://stackoverflow.com/questions/66618136/persistent-service-worker-in-chrome-extension/70003493#70003493
chrome.webNavigation.onBeforeNavigate.addListener(function () { return; });
chrome.webNavigation.onHistoryStateUpdated.addListener(function () { return; });
chrome.runtime.onConnect.addListener(function (Port) {
    if (chrome.runtime.lastError || Port.name !== "HeartBeat") return;
    Port.postMessage("HeartBeat");
    Port.onMessage.addListener(function (message, Port) { return; });
    const interval = setInterval(function () {
        clearInterval(interval);
        Port.disconnect();
    }, 250000);
    Port.onDisconnect.addListener(function () {
        interval && clearInterval(interval);
        if (chrome.runtime.lastError) { return; }
    });
});

/**
 *  定时任务
 *  nowClear clear 清理冗余数据
 *  save 保存数据
 */
chrome.alarms.onAlarm.addListener(function (alarm) {
    if (alarm.name === "nowClear" || alarm.name === "clear") {
        clearRedundant();
        return;
    }
    if (alarm.name === "save") {
        (chrome.storage.session ?? chrome.storage.local).set({ MediaData: cacheData });
        return;
    }
});

// onBeforeRequest 浏览器发送请求之前使用正则匹配发送请求的URL
// chrome.webRequest.onBeforeRequest.addListener(
//     function (data) {
//         try { findMedia(data, true); } catch (e) { console.log(e); }
//     }, { urls: ["<all_urls>"] }, ["requestBody"]
// );
// 保存requestHeaders
chrome.webRequest.onSendHeaders.addListener(
    function (data) {
        if (G && G.initSyncComplete && !G.enable) { return; }
        if (data.requestHeaders) {
            G.requestHeaders.set(data.requestId, data.requestHeaders);
            data.allRequestHeaders = data.requestHeaders;
        }
        try { findMedia(data, true); } catch (e) { console.log(e); }
    }, { urls: ["<all_urls>"] }, ['requestHeaders',
        chrome.webRequest.OnBeforeSendHeadersOptions.EXTRA_HEADERS].filter(Boolean)
);
// onResponseStarted 浏览器接收到第一个字节触发，保证有更多信息判断资源类型
chrome.webRequest.onResponseStarted.addListener(
    function (data) {
        try {
            data.allRequestHeaders = G.requestHeaders.get(data.requestId);
            if (data.allRequestHeaders) {
                G.requestHeaders.delete(data.requestId);
            }
            findMedia(data);
        } catch (e) { console.log(e, data); }
    }, { urls: ["<all_urls>"] }, ["responseHeaders"]
);
// 删除失败的requestHeadersData
chrome.webRequest.onErrorOccurred.addListener(
    function (data) {
        G.requestHeaders.delete(data.requestId);
        G.blackList.delete(data.requestId);
    }, { urls: ["<all_urls>"] }
);

function findMedia(data, isRegex = false, filter = false, timer = false) {
    // Service Worker被强行杀死之后重新自我唤醒，等待全局变量初始化完成。
    if (!G || !G.initSyncComplete || !G.initLocalComplete || G.tabId == undefined || cacheData.init) {
        if (timer) { return; }
        setTimeout(() => {
            findMedia(data, isRegex, filter, true);
        }, 500);
        return;
    }

    if (G.damn && G.damnUrlSet.has(data.tabId)) {
        return;
    }

    // 检查 是否启用 是否在当前标签是否在屏蔽列表中
    const blockUrlFlag = data.tabId && data.tabId > 0 && G.blockUrlSet.has(data.tabId);
    if (!G.enable || (G.blockUrlWhite ? !blockUrlFlag : blockUrlFlag)) {
        return;
    }

    data.getTime = Date.now();

    if (!isRegex && G.blackList.has(data.requestId)) {
        G.blackList.delete(data.requestId);
        return;
    }
    // 屏蔽特殊页面发起的资源
    if (data.initiator != "null" &&
        data.initiator != undefined &&
        isSpecialPage(data.initiator)) { return; }
    if (G.isFirefox &&
        data.originUrl &&
        isSpecialPage(data.originUrl)) { return; }
    // 屏蔽特殊页面的资源
    if (isSpecialPage(data.url)) { return; }
    const urlParsing = new URL(data.url);
    let [name, ext] = fileNameParse(urlParsing.pathname);

    //正则匹配
    if (isRegex && !filter) {
        for (let key in G.Regex) {
            if (!G.Regex[key].state) { continue; }
            G.Regex[key].regex.lastIndex = 0;
            let result = G.Regex[key].regex.exec(data.url);
            if (result == null) { continue; }
            if (G.Regex[key].blackList) {
                G.blackList.add(data.requestId);
                return;
            }
            data.extraExt = G.Regex[key].ext ? G.Regex[key].ext : undefined;
            if (result.length == 1) {
                findMedia(data, true, true);
                return;
            }
            result.shift();
            result = result.map(str => decodeURIComponent(str));
            if (!result[0].startsWith('https://') && !result[0].startsWith('http://')) {
                result[0] = urlParsing.protocol + "//" + data.url;
            }
            data.url = result.join("");
            findMedia(data, true, true);
            return;
        }
        return;
    }

    // 非正则匹配
    if (!isRegex) {
        // 获取头部信息
        data.header = getResponseHeadersValue(data);
        //检查后缀
        if (!filter && ext != undefined) {
            filter = CheckExtension(ext, data.header?.size);
            if (filter == "break") { return; }
        }
        //检查类型
        if (!filter && data.header?.type != undefined) {
            filter = CheckType(data.header.type, data.header?.size);
            if (filter == "break") { return; }
        }
        //查找附件
        if (!filter && data.header?.attachment != undefined) {
            const res = data.header.attachment.match(reFilename);
            if (res && res[1]) {
                [name, ext] = fileNameParse(decodeURIComponent(res[1]));
                filter = CheckExtension(ext, 0);
                if (filter == "break") { return; }
            }
        }
        //放过类型为media的资源
        if (data.type == "media") {
            filter = true;
        }
    }

    if (!filter) { return; }

    // 谜之原因 获取得资源 tabId可能为 -1 firefox中则正常
    // 检查是 -1 使用当前激活标签得tabID
    data.tabId = data.tabId == -1 ? G.tabId : data.tabId;

    cacheData[data.tabId] ??= [];
    cacheData[G.tabId] ??= [];

    // 缓存数据大于9999条 清空缓存 避免内存占用过多
    if (cacheData[data.tabId].length > G.maxLength) {
        cacheData[data.tabId] = [];
        (chrome.storage.session ?? chrome.storage.local).set({ MediaData: cacheData });
        return;
    }

    // 查重 避免CPU占用 大于500 强制关闭查重
    // if (G.checkDuplicates && cacheData[data.tabId].length <= 500) {
    //     for (let item of cacheData[data.tabId]) {
    //         if (item.url.length == data.url.length &&
    //             item.cacheURL.pathname == urlParsing.pathname &&
    //             item.cacheURL.host == urlParsing.host &&
    //             item.cacheURL.search == urlParsing.search) { return; }
    //     }
    // }

    if (G.checkDuplicates && cacheData[data.tabId].length <= 500) {
        const tabFingerprints = G.urlMap.get(data.tabId) || new Set();
        if (tabFingerprints.has(data.url)) {
            return; // 找到重复，直接返回
        }
        tabFingerprints.add(data.url);
        G.urlMap.set(data.tabId, tabFingerprints);
        if (tabFingerprints.size >= 500) {
            tabFingerprints.clear();
        }
    }

    chrome.tabs.get(data.tabId, async function (webInfo) {
        if (chrome.runtime.lastError) { return; }
        data.requestHeaders = getRequestHeaders(data);
        // requestHeaders 中cookie 单独列出来
        if (data.requestHeaders?.cookie) {
            data.cookie = data.requestHeaders.cookie;
            data.requestHeaders.cookie = undefined;
        }
        const info = {
            name: name,
            url: data.url,
            size: data.header?.size,
            ext: ext,
            type: data.mime ?? data.header?.type,
            tabId: data.tabId,
            isRegex: isRegex,
            requestId: data.requestId ?? Date.now().toString(),
            initiator: data.initiator,
            requestHeaders: data.requestHeaders,
            cookie: data.cookie,
            // cacheURL: { host: urlParsing.host, search: urlParsing.search, pathname: urlParsing.pathname },
            getTime: data.getTime
        };
        // 不存在扩展使用类型
        if (info.ext === undefined && info.type !== undefined) {
            info.ext = info.type.split("/")[1];
        }
        // 正则匹配的备注扩展
        if (data.extraExt) {
            info.ext = data.extraExt;
        }
        // 不存在 initiator 和 referer 使用web url代替initiator
        if (info.initiator == undefined || info.initiator == "null") {
            info.initiator = info.requestHeaders?.referer ?? webInfo?.url;
        }
        // 装载页面信息
        info.title = webInfo?.title ?? "NULL";
        info.favIconUrl = webInfo?.favIconUrl;
        info.webUrl = webInfo?.url;
        // 屏蔽资源
        if (!isRegex && G.blackList.has(data.requestId)) {
            G.blackList.delete(data.requestId);
            return;
        }
        // 发送到popup 并检查自动下载
        chrome.runtime.sendMessage({ Message: "popupAddData", data: info }, function () {
            if (G.featAutoDownTabId.size > 0 && G.featAutoDownTabId.has(info.tabId) && chrome.downloads?.State) {
                try {
                    const downDir = info.title == "NULL" ? "CatCatch/" : stringModify(info.title) + "/";
                    let fileName = isEmpty(info.name) ? stringModify(info.title) + '.' + info.ext : decodeURIComponent(stringModify(info.name));
                    if (G.TitleName) {
                        fileName = filterFileName(templates(G.downFileName, info));
                    } else {
                        fileName = downDir + fileName;
                    }
                    chrome.downloads.download({
                        url: info.url,
                        filename: fileName
                    });
                } catch (e) { return; }
            }
            if (chrome.runtime.lastError) { return; }
        });

        // 数据发送
        if (G.send2local) {
            try { send2local("catch", { ...info, requestHeaders: data.allRequestHeaders }, info.tabId); } catch (e) { console.log(e); }
        }

        // 储存数据
        cacheData[info.tabId] ??= [];
        cacheData[info.tabId].push(info);

        // 当前标签媒体数量大于100 开启防抖 等待5秒储存 或 积累10个资源储存一次。
        if (cacheData[info.tabId].length >= 100 && debounceCount <= 10) {
            debounceCount++;
            clearTimeout(debounce);
            debounce = setTimeout(function () { save(info.tabId); }, 5000);
            return;
        }
        // 时间间隔小于500毫秒 等待2秒储存
        if (Date.now() - debounceTime <= 500) {
            clearTimeout(debounce);
            debounceTime = Date.now();
            debounce = setTimeout(function () { save(info.tabId); }, 2000);
            return;
        }
        save(info.tabId);
    });
}
// cacheData数据 储存到 chrome.storage.local
function save(tabId) {
    clearTimeout(debounce);
    debounceTime = Date.now();
    debounceCount = 0;
    if (cacheData[tabId]) {
        // 单个标签数据超过99条 不再保存到storage
        if (cacheData[tabId]?.length <= 99) {
            (chrome.storage.session ?? chrome.storage.local).set({ MediaData: cacheData }, function () {
                chrome.runtime.lastError && console.log(chrome.runtime.lastError);
            });
        }
        SetIcon({ number: cacheData[tabId].length, tabId: tabId });
    }
}

/** LocalMediaWeb helpers for page float-ingest (service worker). */
async function lmwGetSettings() {
    const defaults = {
        lmwURL: "http://192.168.10.84:8790",
        lmwToken: "",
        lmwDefaultCategory: "default",
        lmwAutoFallback: true,
        lmwUseJasna: false,
        lmwRestricted: false,
    };
    try {
        const keys = Object.keys(defaults);
        // 选项页写 sync；部分入口写 local。合并：默认 → sync → local
        const [syncData, localData] = await Promise.all([
            chrome.storage.sync.get(keys),
            chrome.storage.local.get(keys),
        ]);
        return { ...defaults, ...syncData, ...localData };
    } catch (e) {
        return { ...defaults };
    }
}

function lmwBaseUrl(s) {
    return (s.lmwURL || "http://192.168.10.84:8790").replace(/\/+$/, "");
}

function lmwAuthHeaders(s, json) {
    const h = {};
    if (json) h["Content-Type"] = "application/json;charset=utf-8";
    const token = (s.lmwToken || "").trim();
    if (token) h["X-LMW-Token"] = token;
    return h;
}

async function lmwFetchJson(url, options) {
    let res;
    try {
        res = await fetch(url, options);
    } catch (e) {
        throw new Error(
            "无法连接 LocalMediaWeb（" +
                ((e && e.message) || "network") +
                "）。请确认服务已启动且地址正确。"
        );
    }
    const text = await res.text().catch(() => "");
    let body = null;
    try {
        body = text ? JSON.parse(text) : null;
    } catch (e) {
        body = text;
    }
    if (!res.ok) {
        const detail =
            (body && (body.detail || body.message)) ||
            (typeof body === "string" ? body : text) ||
            res.statusText;
        throw new Error(`${res.status} ${String(detail).slice(0, 180)}`);
    }
    return body;
}

async function lmwBuildCookieHeader(url) {
    if (!url || !chrome.cookies?.getAll) return "";
    try {
        const cookies = await chrome.cookies.getAll({ url });
        if (cookies && cookies.length) {
            return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
        }
    } catch (e) { /* ignore */ }
    return "";
}

/**
 * Collect cookies for media URL + page/referer + known site domains (e.g. douyin.com).
 * CDN hosts like douyinvod.com rarely carry first-party cookies; page-domain cookies still help some edges.
 */
async function lmwBuildCookieHeaderRich(mediaUrl, pageUrl) {
    const map = new Map();
    const addList = (cookies) => {
        for (const c of cookies || []) {
            if (c && c.name) map.set(c.name, c.value);
        }
    };
    const tryUrl = async (u) => {
        if (!u || !/^https?:/i.test(String(u))) return;
        try {
            addList(await chrome.cookies.getAll({ url: String(u) }));
        } catch (e) { /* ignore */ }
    };
    const tryDomain = async (domain) => {
        if (!domain || !chrome.cookies?.getAll) return;
        try {
            addList(await chrome.cookies.getAll({ domain }));
        } catch (e) { /* ignore */ }
    };
    await tryUrl(mediaUrl);
    await tryUrl(pageUrl);
    const blob = `${mediaUrl || ""}\n${pageUrl || ""}`;
    if (/douyin|douyinvod|byteicdn|bytedance|ixigua|toutiao/i.test(blob)) {
        await tryUrl("https://www.douyin.com/");
        await tryUrl("https://www.douyin.com");
        await tryDomain("douyin.com");
        await tryDomain(".douyin.com");
    }
    if (/bilibili|bilivideo/i.test(blob)) {
        await tryUrl("https://www.bilibili.com/");
        await tryDomain("bilibili.com");
    }
    if (!map.size) return "";
    return [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

/**
 * Extension-page fetch to CDN often fails with net::ERR_FAILED (Origin/credentials).
 * Service worker fetch with host_permissions + explicit Referer/Cookie is more reliable
 * (same path as lmwPageIngest float button).
 * @returns {Promise<Blob>}
 */
async function lmwFetchMediaBlob(url, headersIn, pageUrl) {
    if (!url || !/^https?:/i.test(String(url))) {
        throw new Error("invalid media url");
    }
    const src = headersIn && typeof headersIn === "object" ? headersIn : {};
    const pick = (names) => {
        for (const n of names) {
            if (src[n] != null && src[n] !== "") return String(src[n]);
        }
        return "";
    };
    let referer =
        pick(["Referer", "referer"]) ||
        (pageUrl && String(pageUrl)) ||
        "";
    // Prefer site origin as Referer when only a deep page URL is known
    if (!referer && /douyinvod|douyin\.com/i.test(url)) {
        referer = "https://www.douyin.com/";
    }
    const ua =
        pick(["User-Agent", "user-agent"]) ||
        (typeof navigator !== "undefined"
            ? navigator.userAgent
            : "Mozilla/5.0 Chrome");
    let cookie =
        pick(["Cookie", "cookie"]) ||
        (await lmwBuildCookieHeaderRich(url, referer || pageUrl));

    const buildHeaders = (withCookie) => {
        const h = {
            Referer: referer || "https://www.douyin.com/",
            "User-Agent": ua,
        };
        if (withCookie && cookie) h.Cookie = cookie;
        return h;
    };

    const attempts = [];
    // 1) force-cache + cookie (hits disk cache after page play)
    attempts.push({ cache: "force-cache", cookie: true, label: "cache+cookie" });
    // 2) network + cookie
    attempts.push({ cache: "no-store", cookie: true, label: "net+cookie" });
    // 3) network without cookie (signed CDN often enough)
    attempts.push({ cache: "no-store", cookie: false, label: "net-nocookie" });

    let lastErr = null;
    for (const a of attempts) {
        try {
            const res = await fetch(url, {
                headers: buildHeaders(a.cookie),
                credentials: "omit",
                cache: a.cache,
                redirect: "follow",
            });
            if (!res.ok) {
                lastErr = new Error(`HTTP ${res.status} (${a.label})`);
                continue;
            }
            const blob = await res.blob();
            if (!blob || blob.size < 32) {
                lastErr = new Error(`empty body size=${blob ? blob.size : 0} (${a.label})`);
                continue;
            }
            return blob;
        } catch (e) {
            lastErr = e;
        }
    }
    const host = (() => {
        try {
            return new URL(url).host;
        } catch (e) {
            return "?";
        }
    })();
    throw new Error(
        `bg fetch failed @${host}: ${(lastErr && lastErr.message) || lastErr || "unknown"}`
    );
}

/** Message helper: fetch URL → ArrayBuffer for extension pages (merge / upload). */
async function lmwClientFetchBlobFromBackground(Message) {
    const url = (Message.url || "").trim();
    if (!url) throw new Error("缺少 url");
    const blob = await lmwFetchMediaBlob(
        url,
        Message.headers || {},
        Message.referer || Message.page_url || ""
    );
    const buf = await blob.arrayBuffer();
    return {
        ok: true,
        size: buf.byteLength,
        type: blob.type || Message.mime || "application/octet-stream",
        buffer: buf,
        role: Message.role || "",
    };
}

/**
 * Fetch video+audio in SW, POST /api/upload-av (avoids shipping large blobs via page fetch).
 */
async function lmwMergeAvFromUrlsBackground(Message) {
    const s = await lmwGetSettings();
    const vUrl = (Message.video_url || "").trim();
    const aUrl = (Message.audio_url || "").trim();
    if (!vUrl || !aUrl) throw new Error("需要 video_url 与 audio_url");
    const pageUrl = Message.referer || Message.page_url || Message.source_url || "";
    const vBlob = await lmwFetchMediaBlob(vUrl, Message.video_headers || {}, pageUrl);
    const aBlob = await lmwFetchMediaBlob(aUrl, Message.audio_headers || {}, pageUrl);

    const restricted =
        Message.restricted === true ||
        Message.restricted === 1 ||
        Message.restricted === "1" ||
        s.lmwRestricted === true;
    let tags = lmwNormalizeTags(Message.tags || []);
    if (restricted && !tags.includes("限制级")) tags = tags.concat(["限制级"]);

    const title = Message.title || "merged";
    const base = String(title).replace(/\.[^.]+$/, "").slice(0, 80) || "merge";
    const fd = new FormData();
    fd.append("category", Message.category || "default");
    fd.append("title", title);
    fd.append("source_url", Message.source_url || vUrl);
    if (tags.length) fd.append("tags", JSON.stringify(tags));
    if (restricted) fd.append("restricted", "1");
    fd.append("video", vBlob, `${base}_video.mp4`);
    if (aBlob && aBlob.size > 32) {
        fd.append("audio", aBlob, `${base}_audio.m4a`);
    }
    const headers = lmwAuthHeaders(s, false);
    const data = await lmwFetchJson(lmwBaseUrl(s) + "/api/upload-av", {
        method: "POST",
        headers,
        body: fd,
    });
    return {
        ok: true,
        media_id: data.media_id ?? data.item?.id,
        item: data.item,
        note: data.note || "merged",
        video_size: vBlob.size,
        audio_size: aBlob.size,
        duplicate: !!data.duplicate,
    };
}

function lmwGuessExt(url, mime, mediaType) {
    const m = (mime || "").toLowerCase();
    if (m.includes("png")) return "png";
    if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
    if (m.includes("gif")) return "gif";
    if (m.includes("webp")) return "webp";
    if (m.includes("avif")) return "avif";
    if (m.includes("mp4")) return "mp4";
    if (m.includes("webm")) return "webm";
    if (m.includes("mpegurl") || mediaType === "m3u8") return "m3u8";
    const path = (url || "").split("?")[0].split("#")[0];
    const ext = path.includes(".") ? path.split(".").pop().toLowerCase() : "";
    if (ext && ext.length <= 5) return ext.replace(/[^a-z0-9]/g, "") || "bin";
    if (mediaType === "image") return "jpg";
    if (mediaType === "gif") return "gif";
    return "mp4";
}

function lmwNormalizeTags(raw) {
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

async function lmwUploadBlob(s, blob, meta) {
    const fd = new FormData();
    fd.append("category", meta.category || s.lmwDefaultCategory || "default");
    fd.append("title", meta.title || "");
    fd.append("source_url", meta.source_url || meta.url || "");
    fd.append("media_type", meta.media_type || "video");
    const name = meta.filename || "upload.bin";
    const remuxOff = /\.(mp4|m4v|m4a|mov)(\?|$)/i.test(name) || /mp4/i.test(blob.type || meta.media_type || "");
    fd.append("remux", meta.remux != null ? String(meta.remux) : (remuxOff ? "0" : "1"));
    const restricted =
        meta.restricted === true ||
        meta.restricted === 1 ||
        meta.restricted === "1" ||
        s.lmwRestricted === true;
    let tags = lmwNormalizeTags(meta.tags || []);
    if (restricted && !tags.includes("限制级")) tags = tags.concat(["限制级"]);
    if (tags.length) fd.append("tags", JSON.stringify(tags));
    // jasna demosaic: local JasnaBridge / FFmpegBridge only — do not send use_jasna to LMW
    if (restricted) fd.append("restricted", "1");
    fd.append("file", blob, name);
    const headers = lmwAuthHeaders(s, false);
    const data = await lmwFetchJson(lmwBaseUrl(s) + "/api/upload", {
        method: "POST",
        headers,
        body: fd,
    });
    return {
        ok: true,
        media_id: data.media_id ?? data.item?.id,
        note: data.note || "upload",
        item: data.item,
        jasna_job_id: data.jasna_job_id ?? null,
    };
}

async function lmwWaitJob(s, jobId, { timeoutMs = 12000, intervalMs = 700 } = {}) {
    const start = Date.now();
    let last = null;
    while (Date.now() - start < timeoutMs) {
        last = await lmwFetchJson(lmwBaseUrl(s) + `/api/jobs/${jobId}`, {
            headers: lmwAuthHeaders(s, false),
        });
        if (last && !["queued", "running"].includes(last.status)) return last;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    return last;
}

/**
 * Page float-ingest: prefer direct fetch+upload for file media; server job for streams.
 */
async function lmwPageIngestFromBackground(Message) {
    const s = await lmwGetSettings();
    const url = (Message.url || "").trim();
    if (!url) throw new Error("缺少资源 URL");
    if (url.startsWith("blob:")) throw new Error("blob 请走 lmwPageUpload");

    const mediaType = Message.media_type || "video";
    const title = Message.title || "";
    const page = Message.source_page || Message.page_url || Message.referer || "";
    const category = "default";
    const restricted =
        Message.restricted === true ||
        Message.restricted === 1 ||
        Message.restricted === "1" ||
        s.lmwRestricted === true;
    let tags = lmwNormalizeTags(Message.tags || []);
    if (restricted && !tags.includes("限制级")) tags = tags.concat(["限制级"]);
    const isStream =
        mediaType === "m3u8" ||
        mediaType === "dash" ||
        /\.m3u8(\?|#|$)/i.test(url) ||
        /\.mpd(\?|#|$)/i.test(url);

    const headers = {
        Referer: Message.referer || page || "",
        "User-Agent":
            typeof navigator !== "undefined"
                ? navigator.userAgent
                : "Mozilla/5.0 Chrome",
    };
    const cookie = await lmwBuildCookieHeader(url);
    if (cookie) headers.Cookie = cookie;

    // Non-stream: extension fetch + upload is more reliable than server-side download
    if (!isStream) {
        try {
            const res = await fetch(url, { headers, credentials: "omit", cache: "force-cache" });
            if (!res.ok) throw new Error(`拉取资源 HTTP ${res.status}`);
            const blob = await res.blob();
            if (!blob.size) throw new Error("资源内容为空");
            const mime = res.headers.get("content-type") || blob.type || "";
            const ext = lmwGuessExt(url, mime, mediaType);
            const up = await lmwUploadBlob(s, blob, {
                category,
                title,
                source_url: url,
                media_type: mediaType === "m3u8" || mediaType === "dash" ? "video" : mediaType,
                filename: `${String(title || "media").slice(0, 40)}.${ext}`,
                tags,
                restricted: !!restricted,
            });
            return up;
        } catch (e) {
            // fall through to server ingest
            console.warn("lmw client fetch failed, try server ingest", e);
        }
    }

    // Server ingest (m3u8/dash or client fetch failed)
    const item = {
        url,
        media_type: isStream
            ? /\.mpd/i.test(url) || mediaType === "dash"
                ? "dash"
                : "m3u8"
            : mediaType,
        title: String(title).slice(0, 512),
        referer: page,
        source_page: page,
        headers,
        tags,
        restricted: !!restricted,
    };
    const ingestRes = await lmwFetchJson(lmwBaseUrl(s) + "/api/ingest", {
        method: "POST",
        headers: lmwAuthHeaders(s, true),
        body: JSON.stringify({
            category,
            items: [item],
            tags,
            restricted: !!restricted,
        }),
    });

    const dupIds = ingestRes.duplicate_media_ids || [];
    if (dupIds.length && !(ingestRes.job_ids || []).length) {
        return { ok: true, duplicate: true, media_id: dupIds[0], message: "已在库中" };
    }

    const jobId = (ingestRes.job_ids || [])[0];
    if (jobId == null) {
        if (dupIds.length) {
            return { ok: true, duplicate: true, media_id: dupIds[0] };
        }
        return {
            ok: true,
            message: `已提交（accepted=${ingestRes.accepted ?? 0}）`,
            accepted: ingestRes.accepted,
        };
    }

    // Wait briefly so UI can show real success/failure
    let job = null;
    try {
        job = await lmwWaitJob(s, jobId, { timeoutMs: 15000 });
    } catch (e) {
        return { ok: true, job_id: jobId, job_status: "queued", message: "已提交任务，后台下载中" };
    }

    if (!job) {
        return { ok: true, job_id: jobId, job_status: "queued" };
    }

    if (job.status === "success") {
        return {
            ok: true,
            job_id: jobId,
            job_status: "success",
            media_id: job.media_id ?? job.result_media_id,
            message: "入库成功",
        };
    }

    // Client fallback for failed non-stream
    const canFallback =
        s.lmwAutoFallback !== false &&
        !isStream &&
        ["failed_auth", "need_client_fetch", "failed_network", "failed_partial", "failed"].includes(
            job.status
        );
    if (canFallback) {
        try {
            const res = await fetch(url, { headers, credentials: "omit" });
            if (!res.ok) throw new Error(`fallback HTTP ${res.status}`);
            const blob = await res.blob();
            const mime = res.headers.get("content-type") || blob.type || "";
            const ext = lmwGuessExt(url, mime, mediaType);
            const up = await lmwUploadBlob(s, blob, {
                category,
                title,
                source_url: url,
                media_type: mediaType,
                filename: `${String(title || "media").slice(0, 40)}.${ext}`,
                tags,
                restricted: !!restricted,
            });
            return { ...up, note: "fallback_upload", job_id: jobId };
        } catch (e2) {
            throw new Error(
                `任务 #${jobId} ${job.status}: ${job.error_message || ""}；回退上传失败: ${
                    (e2 && e2.message) || e2
                }`.slice(0, 220)
            );
        }
    }

    if (["queued", "running"].includes(job.status)) {
        return {
            ok: true,
            job_id: jobId,
            job_status: job.status,
            message: "已提交，服务端仍在下载…",
        };
    }

    throw new Error(
        `任务 #${jobId} ${job.status}: ${(job.error_message || job.message || "").slice(0, 160)}`
    );
}

async function lmwPageUploadFromBackground(Message) {
    const s = await lmwGetSettings();
    const buf = Message.buffer;
    if (!buf) throw new Error("缺少文件数据");
    const blob = new Blob([buf], { type: Message.mime || "application/octet-stream" });
    if (!blob.size) throw new Error("文件为空");
    return lmwUploadBlob(s, blob, {
        category: "default",
        title: Message.title || "",
        source_url: Message.source_url || "",
        media_type: Message.media_type || "video",
        filename: Message.filename || "upload.bin",
        tags: Message.tags || [],
    });
}

/**
 * 页面浮动入库：标签对话框用扩展独立窗口，避免 grok.com 等站点抢焦点。
 * requestId → { sendResponse, windowId, timer }
 */
const lmwTagDialogWaiters = new Map();

function lmwSuggestTagsLocal({ title = "", url = "", media_type = "", source_page = "" } = {}) {
    const c = [];
    const mt = (media_type || "").toLowerCase();
    if (["video", "image", "gif", "m3u8", "dash"].includes(mt)) c.push(mt);
    try {
        const host = new URL(url || source_page || "https://local.invalid").hostname
            .replace(/^www\./, "");
        const parts = host.split(".");
        if (parts.length >= 2) c.push(parts[parts.length - 2]);
    } catch (e) { /* ignore */ }
    const toks = String(title || "").match(/[\u4e00-\u9fff]{2,6}|[A-Za-z][A-Za-z0-9_-]{2,16}/g) || [];
    for (const t of toks.slice(0, 2)) c.push(t.toLowerCase());
    return lmwNormalizeTags(c);
}

function lmwOpenTagDialogWindow(payload) {
    return new Promise((resolve) => {
        const requestId =
            "tag_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
        const data = {
            title: payload.title || "",
            url: payload.url || "",
            media_type: payload.media_type || "",
            source_page: payload.source_page || "",
            count: payload.count || 1,
            tags: lmwNormalizeTags(payload.tags || []),
            suggestions: lmwSuggestTagsLocal(payload),
        };
        const key = "lmwTagAsk_" + requestId;
        const store = chrome.storage.session || chrome.storage.local;
        store.set({ [key]: data }, () => {
            const url = chrome.runtime.getURL("lmw-tag-dialog.html") + "?rid=" + encodeURIComponent(requestId);
            chrome.windows.create(
                {
                    url,
                    type: "popup",
                    width: 460,
                    height: 580,
                    focused: true,
                },
                (win) => {
                    if (chrome.runtime.lastError || !win) {
                        store.remove(key);
                        // 无法开窗时：返回空标签继续入库，避免卡死
                        resolve({ ok: true, tags: data.suggestions.slice(0, 2), fallback: true });
                        return;
                    }
                    const windowId = win.id;
                    const timer = setTimeout(() => {
                        const w = lmwTagDialogWaiters.get(requestId);
                        if (!w) return;
                        lmwTagDialogWaiters.delete(requestId);
                        store.remove(key);
                        try {
                            chrome.windows.remove(windowId);
                        } catch (e) { /* ignore */ }
                        resolve({ ok: false, cancelled: true, tags: [], timeout: true });
                    }, 10 * 60 * 1000);
                    lmwTagDialogWaiters.set(requestId, {
                        resolve,
                        windowId,
                        timer,
                        storageKey: key,
                    });
                }
            );
        });
    });
}

chrome.windows?.onRemoved?.addListener((windowId) => {
    // 延迟：确认入库时先发 result 再关窗，避免误判为取消
    setTimeout(() => {
        for (const [rid, w] of lmwTagDialogWaiters.entries()) {
            if (w.windowId !== windowId) continue;
            clearTimeout(w.timer);
            lmwTagDialogWaiters.delete(rid);
            try {
                (chrome.storage.session || chrome.storage.local).remove(w.storageKey);
            } catch (e) { /* ignore */ }
            try {
                w.resolve({ ok: false, cancelled: true, tags: [] });
            } catch (e) { /* ignore */ }
        }
    }, 200);
});

/**
 * 监听 扩展 message 事件
 */
chrome.runtime.onMessage.addListener(function (Message, sender, sendResponse) {
    if (chrome.runtime.lastError) { return; }
    // 页面浮动入库不依赖媒体嗅探 init，优先处理
    if (Message.Message == "lmwAskTags") {
        lmwOpenTagDialogWindow(Message)
            .then((r) => sendResponse(r))
            .catch((e) => sendResponse({ ok: false, cancelled: true, tags: [], error: String(e) }));
        return true;
    }
    if (Message.Message == "lmwTagDialogGet") {
        const rid = Message.requestId || "";
        const key = "lmwTagAsk_" + rid;
        const store = chrome.storage.session || chrome.storage.local;
        store.get(key, (items) => {
            const data = items && items[key];
            if (!data) {
                sendResponse({ ok: false, error: "expired" });
                return;
            }
            sendResponse({ ok: true, data });
        });
        return true;
    }
    if (Message.Message == "lmwTagDialogResult") {
        const rid = Message.requestId || "";
        const w = lmwTagDialogWaiters.get(rid);
        if (w) {
            clearTimeout(w.timer);
            lmwTagDialogWaiters.delete(rid);
            try {
                (chrome.storage.session || chrome.storage.local).remove(w.storageKey);
            } catch (e) { /* ignore */ }
            const result = Message.result || { ok: false, cancelled: true, tags: [] };
            try {
                w.resolve(result);
            } catch (e) { /* ignore */ }
            // 关闭弹窗（若仍打开）
            if (w.windowId != null) {
                try {
                    chrome.windows.remove(w.windowId, () => void chrome.runtime.lastError);
                } catch (e) { /* ignore */ }
            }
        }
        sendResponse({ ok: true });
        return true;
    }
    if (Message.Message == "lmwPageIngest") {
        lmwPageIngestFromBackground(Message)
            .then((r) => sendResponse(r))
            .catch((e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
        return true;
    }
    if (Message.Message == "lmwPageUpload") {
        lmwPageUploadFromBackground(Message)
            .then((r) => sendResponse(r))
            .catch((e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
        return true;
    }
    // local-media merge / client blob: SW fetch (page fetch often ERR_FAILED on CDN)
    if (Message.Message == "lmwClientFetchBlob") {
        lmwClientFetchBlobFromBackground(Message)
            .then((r) => sendResponse(r))
            .catch((e) =>
                sendResponse({
                    ok: false,
                    error: (e && e.message) || String(e),
                })
            );
        return true;
    }
    if (Message.Message == "lmwMergeAvClient") {
        lmwMergeAvFromUrlsBackground(Message)
            .then((r) => sendResponse(r))
            .catch((e) =>
                sendResponse({
                    ok: false,
                    error: (e && e.message) || String(e),
                })
            );
        return true;
    }
    if (!G.initLocalComplete || !G.initSyncComplete) {
        sendResponse("error");
        return true;
    }
    // 以下检查是否有 tabId 不存在使用当前标签
    Message.tabId = Message.tabId ?? G.tabId;

    // 从缓存中保存数据到本地
    if (Message.Message == "pushData") {
        (chrome.storage.session ?? chrome.storage.local).set({ MediaData: cacheData });
        sendResponse("ok");
        return true;
    }
    // 获取所有数据
    if (Message.Message == "getAllData") {
        sendResponse(cacheData);
        return true;
    }
    /**
     * 设置扩展图标数字
     * 提供 type 删除标签为 tabId 的数字
     * 不提供type 删除所有标签的数字
     */
    if (Message.Message == "ClearIcon") {
        Message.type ? SetIcon({ tabId: Message.tabId }) : SetIcon();
        sendResponse("ok");
        return true;
    }
    // 启用/禁用扩展
    if (Message.Message == "enable") {
        G.enable = !G.enable;
        chrome.storage.sync.set({ enable: G.enable });
        chrome.action.setIcon({ path: G.enable ? "/img/icon.png" : "/img/icon-disable.png" });
        sendResponse(G.enable);
        return true;
    }
    /**
     * 提供requestId数组 获取指定的数据
     */
    if (Message.Message == "getData" && Message.requestId) {
        // 判断Message.requestId是否数组
        if (!Array.isArray(Message.requestId)) {
            Message.requestId = [Message.requestId];
        }
        const response = [];
        if (Message.requestId.length) {
            for (let item in cacheData) {
                for (let data of cacheData[item]) {
                    if (Message.requestId.includes(data.requestId)) {
                        response.push(data);
                    }
                }
            }
        }
        sendResponse(response.length ? response : "error");
        return true;
    }
    /**
     * 提供 tabId 获取该标签数据
     */
    if (Message.Message == "getData") {
        sendResponse(cacheData[Message.tabId]);
        return true;
    }
    /**
     * 获取各按钮状态
     * 模拟手机 自动下载 启用 以及各种脚本状态
     */
    if (Message.Message == "getButtonState") {
        let state = {
            MobileUserAgent: G.featMobileTabId.has(Message.tabId),
            AutoDown: G.featAutoDownTabId.has(Message.tabId),
            enable: G.enable,
        }
        G.scriptList.forEach(function (item, key) {
            state[item.key] = item.tabId.has(Message.tabId);
        });
        sendResponse(state);
        return true;
    }
    // 对tabId的标签 进行模拟手机操作
    if (Message.Message == "mobileUserAgent") {
        mobileUserAgent(Message.tabId, !G.featMobileTabId.has(Message.tabId));
        chrome.tabs.reload(Message.tabId, { bypassCache: true });
        sendResponse("ok");
        return true;
    }
    // 对tabId的标签 开启 关闭 自动下载
    if (Message.Message == "autoDown") {
        if (G.featAutoDownTabId.has(Message.tabId)) {
            G.featAutoDownTabId.delete(Message.tabId);
        } else {
            G.featAutoDownTabId.add(Message.tabId);
        }
        (chrome.storage.session ?? chrome.storage.local).set({ featAutoDownTabId: Array.from(G.featAutoDownTabId) });
        sendResponse("ok");
        return true;
    }
    // 对tabId的标签 脚本注入或删除
    if (Message.Message == "script") {
        if (G.damn && G.damnUrlSet.has(Message.tabId)) {
            return;
        }
        if (!G.scriptList.has(Message.script)) {
            sendResponse("error no exists");
            return false;
        }
        const script = G.scriptList.get(Message.script);
        const scriptTabid = script.tabId;
        const refresh = Message.refresh ?? script.refresh;
        if (scriptTabid.has(Message.tabId)) {
            scriptTabid.delete(Message.tabId);
            if (Message.script == "search.js") {
                G.deepSearchTemporarilyClose = Message.tabId;
            }
            refresh && chrome.tabs.reload(Message.tabId, { bypassCache: true });
            sendResponse("ok");
            return true;
        }
        scriptTabid.add(Message.tabId);
        if (refresh) {
            chrome.tabs.reload(Message.tabId, { bypassCache: true });
        } else {
            const files = [`catch-script/${Message.script}`];
            script.i18n && files.unshift("catch-script/i18n.js");
            chrome.scripting.executeScript({
                target: { tabId: Message.tabId, allFrames: script.allFrames },
                files: files,
                injectImmediately: true,
                world: script.world
            });
        }
        sendResponse("ok");
        return true;
    }
    // 脚本注入 脚本申请多语言文件
    if (Message.Message == "scriptI18n") {
        chrome.scripting.executeScript({
            target: { tabId: Message.tabId, allFrames: true },
            files: ["catch-script/i18n.js"],
            injectImmediately: true,
            world: "MAIN"
        });
        sendResponse("ok");
        return true;
    }
    // Heart Beat
    if (Message.Message == "HeartBeat") {
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
            if (tabs[0] && tabs[0].id) {
                G.tabId = tabs[0].id;
            }
        });
        sendResponse("HeartBeat OK");
        return true;
    }
    // 清理数据
    if (Message.Message == "clearData") {
        // 当前标签
        if (Message.type) {
            delete cacheData[Message.tabId];
            (chrome.storage.session ?? chrome.storage.local).set({ MediaData: cacheData });
            clearRedundant();
            sendResponse("OK");
            return true;
        }
        // 其他标签
        for (let item in cacheData) {
            if (item == Message.tabId) { continue; }
            delete cacheData[item];
        }
        (chrome.storage.session ?? chrome.storage.local).set({ MediaData: cacheData });
        clearRedundant();
        sendResponse("OK");
        return true;
    }
    // 清理冗余数据
    if (Message.Message == "clearRedundant") {
        clearRedundant();
        sendResponse("OK");
        return true;
    }
    // 从 content-script 或 catch-script 传来的媒体url
    if (Message.Message == "addMedia") {
        chrome.tabs.query({}, function (tabs) {
            for (let item of tabs) {
                if (item.url == Message.href) {
                    findMedia({ url: Message.url, tabId: item.id, extraExt: Message.extraExt, mime: Message.mime, requestId: Message.requestId, requestHeaders: Message.requestHeaders }, true, true);
                    return true;
                }
            }
            findMedia({ url: Message.url, tabId: -1, extraExt: Message.extraExt, mime: Message.mime, requestId: Message.requestId, initiator: Message.href, requestHeaders: Message.requestHeaders }, true, true);
        });
        sendResponse("ok");
        return true;
    }
    // ffmpeg网页通信
    if (Message.Message == "catCatchFFmpeg") {
        const data = { ...Message, Message: "ffmpeg", tabId: Message.tabId ?? sender.tab.id, version: G.ffmpegConfig.version };
        chrome.tabs.query({ url: G.ffmpegConfig.url + "*" }, function (tabs) {
            if (chrome.runtime.lastError || !tabs.length) {
                chrome.tabs.create({ url: G.ffmpegConfig.url, active: Message.active ?? true }, function (tab) {
                    if (chrome.runtime.lastError) { return; }
                    G.ffmpegConfig.tab = tab.id;
                    G.ffmpegConfig.cacheData.push(data);
                });
                return true;
            }
            if (tabs[0].status == "complete") {
                chrome.tabs.sendMessage(tabs[0].id, data);
            } else {
                G.ffmpegConfig.tab = tabs[0].id;
                G.ffmpegConfig.cacheData.push(data);
            }
        });
        sendResponse("ok");
        return true;
    }
    // 发送数据到本地
    if (Message.Message == "send2local" && G.send2local) {
        try { send2local(Message.action, Message.data, Message.tabId); } catch (e) { console.log(e); }
        sendResponse("ok");
        return true;
    }
    if (Message.Message == "damnUrlHas") {
        sendResponse(G.damnUrlSet.has(Message.tabId));
        return true;
    }
    if (Message.Message == "closeScript") {
        if (!Message.script || !G.scriptList.has(Message.script)) {
            sendResponse("error");
            return false;
        }
        const script = G.scriptList.get(Message.script);
        const scriptTabid = script.tabId;
        if (scriptTabid.has(Message.tabId)) {
            scriptTabid.delete(Message.tabId);
        }
        sendResponse("ok");
        return true;
    }
    // 打开页面到侧边栏（从popup委托background执行，避免popup生命周期问题）
    if (Message.Message == "openSidePanel") {
        chrome.sidePanel.setOptions({
            tabId: Message.tabId,
            path: Message.path,
            enabled: true
        }, () => {
            if (chrome.runtime.lastError) {
                console.error('openSidePanel setOptions:', chrome.runtime.lastError.message);
                sendResponse("error");
                return;
            }
            chrome.sidePanel.open({ tabId: Message.tabId }, () => {
                if (chrome.runtime.lastError) {
                    console.error('openSidePanel open:', chrome.runtime.lastError.message);
                }
                sendResponse("ok");
            });
        });
        return true;
    }
});

// 选定标签 更新G.tabId
// chrome.tabs.onHighlighted.addListener(function (activeInfo) {
//     if (activeInfo.windowId == -1 || !activeInfo.tabIds || !activeInfo.tabIds.length) { return; }
//     G.tabId = activeInfo.tabIds[0];
// });

/**
 * 监听 切换标签
 * 更新全局变量 G.tabId 为当前标签
 */
chrome.tabs.onActivated.addListener(function (activeInfo) {
    G.tabId = activeInfo.tabId;
    if (cacheData[G.tabId] !== undefined) {
        SetIcon({ number: cacheData[G.tabId].length, tabId: G.tabId });
        return;
    }
    SetIcon({ tabId: G.tabId });
});

// 切换窗口，更新全局变量G.tabId
chrome.windows.onFocusChanged.addListener(function (activeInfo) {
    if (activeInfo == -1) { return; }
    chrome.tabs.query({ active: true, windowId: activeInfo }, function (tabs) {
        if (tabs[0] && tabs[0].id) {
            G.tabId = tabs[0].id;
        } else {
            G.tabId = -1;
        }
    });
}, { filters: ["normal"] });

/**
 * 监听 标签页面更新
 * 检查 清理数据
 * 检查 是否在屏蔽列表中
 */
chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
    if (isSpecialPage(tab.url) || tabId <= 0 || !G.initSyncComplete) { return; }
    // console.log('onUpdated', tabId, changeInfo, tab);
    if (changeInfo.status && changeInfo.status == "loading" && G.autoClearMode == 2) {
        G.urlMap.delete(tabId);
        chrome.alarms.get("save", function (alarm) {
            if (!alarm) {
                delete cacheData[tabId];
                SetIcon({ tabId: tabId });
                chrome.alarms.create("save", { when: Date.now() + 1000 });
            }
        });
    }
    // 检查当前标签是否在屏蔽列表中
    if (changeInfo.url && tabId > 0) {
        if (G.blockUrl.length) {
            G.blockUrlSet.delete(tabId);
            if (isLockUrl(changeInfo.url)) {
                G.blockUrlSet.add(tabId);
            }
        }

        G.damnUrlSet.delete(tabId);
        if (isDamnUrl(changeInfo.url)) {
            G.damnUrlSet.add(tabId);
        }
    }
    // 仅在页面URL真正改变时（导航到新页面）才重置侧边栏
    // 切标签不会触发 URL 变化，因此不会覆盖用户正在查看的解析页面
    if (changeInfo.url) {
        chrome.sidePanel.setOptions({
            tabId,
            path: "popup.html?tabId=" + tabId
        });
    }
});

/**
 * 监听 frame 正在载入
 * 检查 是否在屏蔽列表中 (frameId == 0 为主框架)
 * 检查 自动清理 (frameId == 0 为主框架)
 * 检查 注入脚本
 */
chrome.webNavigation.onCommitted.addListener(function (details) {
    if (isSpecialPage(details.url) || details.tabId <= 0 || !G.initSyncComplete) { return; }
    // console.log('onCommitted', details);

    // 刷新页面 检查是否在屏蔽列表中
    if (details.frameId == 0) {
        G.blockUrlSet.delete(details.tabId);
        if (isLockUrl(details.url)) {
            G.blockUrlSet.add(details.tabId);
        }

        G.damnUrlSet.delete(details.tabId);
        if (isDamnUrl(details.url)) {
            G.damnUrlSet.add(details.tabId);
        }
    }

    // 刷新清理角标数
    if (details.frameId == 0 && (!['auto_subframe', 'manual_subframe', 'form_submit'].includes(details.transitionType)) && G.autoClearMode == 1) {
        delete cacheData[details.tabId];
        G.urlMap.delete(details.tabId);
        (chrome.storage.session ?? chrome.storage.local).set({ MediaData: cacheData });
        SetIcon({ tabId: details.tabId });
    }

    // chrome内核版本 102 以下不支持 chrome.scripting.executeScript API
    if (G.version < 102) { return; }

    if (G.deepSearch && G.deepSearchTemporarilyClose != details.tabId) {
        G.scriptList.get("search.js").tabId.add(details.tabId);
        G.deepSearchTemporarilyClose = null;
    }

    // catch-script 脚本
    G.scriptList.forEach(function (item, script) {
        if (!item.tabId.has(details.tabId) || !item.allFrames) { return true; }

        const files = [`catch-script/${script}`];
        item.i18n && files.unshift("catch-script/i18n.js");
        chrome.scripting.executeScript({
            target: { tabId: details.tabId, frameIds: [details.frameId] },
            files: files,
            injectImmediately: true,
            world: item.world
        });
    });

    // 模拟手机
    if (G.initLocalComplete && G.featMobileTabId.size > 0 && G.featMobileTabId.has(details.tabId)) {
        chrome.scripting.executeScript({
            args: [G.MobileUserAgent.toString()],
            target: { tabId: details.tabId, frameIds: [details.frameId] },
            func: function () {
                Object.defineProperty(navigator, 'userAgent', { value: arguments[0], writable: false });
            },
            injectImmediately: true,
            world: "MAIN"
        });
    }
});

/**
 * 监听 标签关闭 清理数据
 */
chrome.tabs.onRemoved.addListener(function (tabId) {
    // 清理缓存数据
    chrome.alarms.get("nowClear", function (alarm) {
        !alarm && chrome.alarms.create("nowClear", { when: Date.now() + 1000 });
    });
    if (G.initSyncComplete) {
        G.blockUrlSet.has(tabId) && G.blockUrlSet.delete(tabId);
        G.damnUrlSet.has(tabId) && G.damnUrlSet.delete(tabId);
    }
});

// 右键菜单 和 快捷键 复用函数
const runCommands = (command, data) => {
    if (command == "auto_down") {
        if (G.featAutoDownTabId.has(G.tabId)) {
            G.featAutoDownTabId.delete(G.tabId);
        } else {
            G.featAutoDownTabId.add(G.tabId);
        }
        (chrome.storage.session ?? chrome.storage.local).set({ featAutoDownTabId: Array.from(G.featAutoDownTabId) });
    } else if (command == "catch") {
        const scriptTabid = G.scriptList.get("catch.js").tabId;
        scriptTabid.has(G.tabId) ? scriptTabid.delete(G.tabId) : scriptTabid.add(G.tabId);
        chrome.tabs.reload(G.tabId, { bypassCache: true });
    } else if (command == "m3u8") {
        chrome.tabs.create({ url: "m3u8.html" });
    } else if (command == "clear") {
        delete cacheData[G.tabId];
        (chrome.storage.session ?? chrome.storage.local).set({ MediaData: cacheData });
        clearRedundant();
        SetIcon({ tabId: G.tabId });
    } else if (command == "enable") {
        G.enable = !G.enable;
        chrome.storage.sync.set({ enable: G.enable });
        chrome.action.setIcon({ path: G.enable ? "/img/icon.png" : "/img/icon-disable.png" });
    } else if (command == "reboot") {
        chrome.runtime.reload();
    } else if (command == "deepSearch") {
        const script = G.scriptList.get("search.js");
        const scriptTabid = script.tabId;
        if (scriptTabid.has(G.tabId)) {
            scriptTabid.delete(G.tabId);
            G.deepSearchTemporarilyClose = G.tabId;
            chrome.tabs.reload(G.tabId, { bypassCache: true });
            return;
        }
        scriptTabid.add(G.tabId);
        chrome.tabs.reload(G.tabId, { bypassCache: true });
    } else if (command == "preview") {
        chrome.tabs.create({ url: `preview.html?tabId=${G.tabId}` });
    } else if (command == "image-save") {
        chrome.downloads.download({
            url: data.srcUrl,
            saveAs: G.saveAs
        }, () => {
            chrome.runtime.lastError && console.error(chrome.runtime.lastError);
            G.downDataImageSave = data;
        });
    }
}
chrome.downloads.onChanged.addListener(function (item) {
    if (G.catDownload) { delete G.downDataImageSave; return; }
    const errorList = ["SERVER_BAD_CONTENT", "SERVER_UNAUTHORIZED", "SERVER_FORBIDDEN", "SERVER_UNREACHABLE", "SERVER_CROSS_ORIGIN_REDIRECT", "SERVER_FAILED", "NETWORK_FAILED"];
    if (item.error && errorList.includes(item.error.current) && G.downDataImageSave) {
        const data = { requestHeaders: { referer: G.downDataImageSave.pageUrl }, requestId: G.tabId, url: G.downDataImageSave.srcUrl };
        chrome.tabs.create({ url: `downloader.html?JSON=${JSON.stringify(data)}&autoClose=true`, active: false });
        delete G.downDataImageSave;
    }
});

/**
 * 浏览器 扩展快捷键
 */
chrome.commands.onCommand.addListener(function (command) {
    runCommands(command);
});

/**
 * 监听 右键菜单事件
 */
chrome.contextMenus.onClicked.addListener((info, tab) => {
    runCommands(info.menuItemId, info);
});

/**
 * 监听 页面完全加载完成 判断是否在线ffmpeg页面
 * 如果是在线ffmpeg 则发送数据
 */
chrome.webNavigation.onCompleted.addListener(function (details) {
    if (G.ffmpegConfig.tab && details.tabId == G.ffmpegConfig.tab) {
        setTimeout(() => {
            G.ffmpegConfig.cacheData.forEach(data => {
                chrome.tabs.sendMessage(details.tabId, data);
            });
            G.ffmpegConfig.cacheData = [];
            G.ffmpegConfig.tab = 0;
        }, 500);
    }
});

// 操作符检查
function operatorCheck(size, Obj) {
    const unitNumber = {
        "B": 1,
        "BYTE": 1,
        "KB": 1024,
        "MB": 1048576,
        "GB": 1073741824
    };
    const unit = (Obj.unit || "B");
    const targetSize = Obj.size * (unitNumber[unit] || 1);
    switch (Obj.operator) {
        case "=":
            return size == targetSize;
        case "<":
            return size < targetSize;
        case ">":
            return size > targetSize;
        case "<=":
            return size <= targetSize;
        case ">=":
            return size >= targetSize;
        case "!=":
            return size != targetSize;
        case "~":
            return (Obj.min ? size >= Obj.min * (unitNumber[unit] || 1) : true) && (Obj.max ? size <= Obj.max * (unitNumber[unit] || 1) : true);
        default:
            return size <= targetSize;
    }
}

/**
 * 检查扩展名和大小
 * @param {String} ext 
 * @param {Number} size 
 * @returns {Boolean|String}
 */
function CheckExtension(ext, size) {
    const Ext = G.Ext.get(ext);
    if (!Ext) { return false; }
    if (!Ext.state) { return "break"; }
    if (Ext.size != 0 && size != undefined && !operatorCheck(size, Ext)) {
        return "break";
    }
    return true;
}

/**
 * 检查类型和大小
 * @param {String} dataType 
 * @param {Number} dataSize 
 * @returns {Boolean|String}
 */
function CheckType(dataType, dataSize) {
    const typeInfo = G.Type.get(dataType.split("/")[0] + "/*") || G.Type.get(dataType);
    if (!typeInfo) { return false; }
    if (!typeInfo.state) { return "break"; }
    if (typeInfo.size != 0 && dataSize != undefined && !operatorCheck(dataSize, typeInfo)) {
        return "break";
    }
    return true;
}

/**
 * 获取文件名及扩展名
 * @param {String} pathname 
 * @returns {Array}
 */
function fileNameParse(pathname) {
    let fileName = decodeURI(pathname.split("/").pop());
    let ext = fileName.split(".");
    ext = ext.length == 1 ? undefined : ext.pop().toLowerCase();
    return [fileName, ext ? ext : undefined];
}

/**
 * 获取响应头信息
 * @param {Object} data 
 * @returns {Object}
 */
function getResponseHeadersValue(data) {
    const header = {};
    if (data.responseHeaders == undefined || data.responseHeaders.length == 0) { return header; }
    for (let item of data.responseHeaders) {
        item.name = item.name.toLowerCase();
        if (item.name == "content-length") {
            header.size ??= parseInt(item.value);
        } else if (item.name == "content-type") {
            header.type = item.value.split(";")[0].toLowerCase();
        } else if (item.name == "content-disposition") {
            header.attachment = item.value;
        } else if (item.name == "content-range") {
            let size = item.value.split('/')[1];
            if (size !== '*') {
                header.size = parseInt(size);
            }
        }
    }
    return header;
}

/**
 * 获取请求头
 * @param {Object} data 
 * @returns {Object|Boolean}
 */
function getRequestHeaders(data) {
    if (data.allRequestHeaders == undefined || data.allRequestHeaders.length == 0) { return false; }
    const header = {};
    for (let item of data.allRequestHeaders) {
        item.name = item.name.toLowerCase();
        if (item.name == "referer") {
            header.referer = item.value;
        } else if (item.name == "origin") {
            header.origin = item.value;
        } else if (item.name == "cookie") {
            header.cookie = item.value;
        } else if (item.name == "authorization") {
            header.authorization = item.value;
        }
    }
    if (Object.keys(header).length) {
        return header;
    }
    return false;
}
//设置扩展图标
function SetIcon(obj) {
    if (obj?.number == 0 || obj?.number == undefined) {
        chrome.action.setBadgeText({ text: "", tabId: obj?.tabId ?? G.tabId }, function () { if (chrome.runtime.lastError) { return; } });
        // chrome.action.setTitle({ title: "还没闻到味儿~", tabId: obj.tabId }, function () { if (chrome.runtime.lastError) { return; } });
    } else if (G.badgeNumber) {
        obj.number = obj.number > 999 ? "999+" : obj.number.toString();
        chrome.action.setBadgeText({ text: obj.number, tabId: obj.tabId }, function () { if (chrome.runtime.lastError) { return; } });
        // chrome.action.setTitle({ title: "抓到 " + obj.number + " 条鱼", tabId: obj.tabId }, function () { if (chrome.runtime.lastError) { return; } });
    }
}

// 模拟手机端
function mobileUserAgent(tabId, change = false) {
    if (change) {
        G.featMobileTabId.add(tabId);
        (chrome.storage.session ?? chrome.storage.local).set({ featMobileTabId: Array.from(G.featMobileTabId) });
        chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [tabId],
            addRules: [{
                "id": tabId,
                "action": {
                    "type": "modifyHeaders",
                    "requestHeaders": [{
                        "header": "User-Agent",
                        "operation": "set",
                        "value": G.MobileUserAgent
                    }]
                },
                "condition": {
                    "tabIds": [tabId],
                    "resourceTypes": Object.values(chrome.declarativeNetRequest.ResourceType)
                }
            }]
        });
        return true;
    }
    G.featMobileTabId.delete(tabId) && (chrome.storage.session ?? chrome.storage.local).set({ featMobileTabId: Array.from(G.featMobileTabId) });
    chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [tabId]
    });
}

// 判断特殊页面
function isSpecialPage(url) {
    if (!url || url == "null") { return true; }
    return !(url.startsWith("http://") || url.startsWith("https://") || url.startsWith("blob:"));
}

// 测试
// chrome.storage.local.get(function (data) { console.log(data.MediaData) });
// chrome.declarativeNetRequest.getSessionRules(function (rules) { console.log(rules); });
// chrome.tabs.query({}, function (tabs) { for (let item of tabs) { console.log(item.id); } });