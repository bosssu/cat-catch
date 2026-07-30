(function () {
    var _videoObj = [];
    var _videoSrc = [];
    var _key = new Set();
    var m3u8Text = new Map();
    chrome.runtime.onMessage.addListener(function (Message, sender, sendResponse) {
        if (chrome.runtime.lastError) { return; }
        // 获取页面视频对象
        if (Message.Message == "getVideoState") {
            let videoObj = [];
            let videoSrc = [];
            document.querySelectorAll("video, audio").forEach(function (video) {
                if (video.currentSrc != "" && video.currentSrc != undefined) {
                    videoObj.push(video);
                    videoSrc.push(video.currentSrc);
                }
            });
            const iframe = document.querySelectorAll("iframe");
            if (iframe.length > 0) {
                iframe.forEach(function (iframe) {
                    if (iframe.contentDocument == null) { return true; }
                    iframe.contentDocument.querySelectorAll("video, audio").forEach(function (video) {
                        if (video.currentSrc != "" && video.currentSrc != undefined) {
                            videoObj.push(video);
                            videoSrc.push(video.currentSrc);
                        }
                    });
                });
            }
            if (videoObj.length > 0) {
                if (videoObj.length !== _videoObj.length || videoSrc.toString() !== _videoSrc.toString()) {
                    _videoSrc = videoSrc;
                    _videoObj = videoObj;
                }
                Message.index = Message.index == -1 ? 0 : Message.index;
                const video = videoObj[Message.index];
                const timePCT = video.currentTime / video.duration * 100;
                sendResponse({
                    time: timePCT,
                    currentTime: video.currentTime,
                    duration: video.duration,
                    volume: video.volume,
                    count: _videoObj.length,
                    src: _videoSrc,
                    paused: video.paused,
                    loop: video.loop,
                    speed: video.playbackRate,
                    muted: video.muted,
                    type: video.tagName.toLowerCase(),
                    videoStatus: videoObj.map(v => v.paused ? 1 : 0)
                });
                return true;
            }
            sendResponse({ count: 0 });
            return true;
        }
        // 速度控制
        if (Message.Message == "speed") {
            if (_videoObj[Message.index]?.playbackRate !== undefined) {
                _videoObj[Message.index].playbackRate = Message.speed;
            }
            return true;
        }
        // 画中画
        if (Message.Message == "pip") {
            if (document.pictureInPictureElement) {
                try { document.exitPictureInPicture(); } catch (e) { return true; }
                sendResponse({ state: false });
                return true;
            }
            try { _videoObj[Message.index].requestPictureInPicture(); } catch (e) { return true; }
            sendResponse({ state: true });
            return true;
        }
        // 全屏
        if (Message.Message == "fullScreen") {
            if (document.fullscreenElement) {
                try { document.exitFullscreen(); } catch (e) { return true; }
                sendResponse({ state: false });
                return true;
            }
            setTimeout(function () {
                try { _videoObj[Message.index].requestFullscreen(); } catch (e) { return true; }
            }, 500);
            sendResponse({ state: true });
            return true;
        }
        // 播放
        if (Message.Message == "play") {
            _videoObj[Message.index]?.play();
            return true;
        }
        // 暂停
        if (Message.Message == "pause") {
            _videoObj[Message.index]?.pause();
            return true;
        }
        // 循环播放
        if (Message.Message == "loop") {
            if (_videoObj[Message.index]?.loop !== undefined) {
                _videoObj[Message.index].loop = Message.action;
            }
            return true;
        }
        // 设置音量
        if (Message.Message == "setVolume") {
            if (_videoObj[Message.index]?.volume !== undefined) {
                _videoObj[Message.index].volume = Message.volume;
            }
            sendResponse("ok");
            return true;
        }
        // 静音
        if (Message.Message == "muted") {
            if (_videoObj[Message.index]?.muted !== undefined) {
                _videoObj[Message.index].muted = Message.action;
            }
            return true;
        }
        // 设置视频进度
        if (Message.Message == "setTime") {
            if (_videoObj[Message.index]?.currentTime !== undefined && _videoObj[Message.index]?.duration !== undefined) {
                _videoObj[Message.index].currentTime = Message.time * _videoObj[Message.index].duration / 100;
            }
            sendResponse("ok");
            return true;
        }
        // 截图视频图片
        if (Message.Message == "screenshot") {
            try {
                let video = _videoObj[Message.index];
                let canvas = document.createElement("canvas");
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
                let link = document.createElement("a");
                link.href = canvas.toDataURL("image/jpeg");
                link.download = `${location.hostname}-${secToTime(video.currentTime)}.jpg`;
                link.click();
                canvas = null;
                link = null;
                sendResponse("ok");
                return true;
            } catch (e) { console.log(e); return true; }
        }
        if (Message.Message == "getKey") {
            sendResponse(Array.from(_key));
            return true;
        }
        if (Message.Message == "ffmpeg") {
            if (!Message.files) {
                window.postMessage(Message);
                sendResponse("ok");
                return true;
            }
            Message.quantity ??= Message.files.length;
            for (let item of Message.files) {
                const data = { ...Message, ...item };
                data.type = item.type ?? "video";
                if (data.data instanceof Blob) {
                    window.postMessage(data);
                } else {
                    fetch(data.data)
                        .then(response => response.blob())
                        .then(blob => {
                            data.data = blob;
                            window.postMessage(data);
                        });
                }
            }
            sendResponse("ok");
            return true;
        }
        if (Message.Message == "getPage") {
            if (Message.find) {
                const DOM = document.querySelector(Message.find);
                DOM ? sendResponse(DOM.innerHTML) : sendResponse("");
                return true;
            }
            sendResponse(document.documentElement.outerHTML);
            return true;
        }
        if (Message.Message == "getM3u8Text") {
            if (Message.url && m3u8Text.has(Message.url)) {
                sendResponse(m3u8Text.get(Message.url));
                return true;
            }
            sendResponse("");
            return true;
        }
        if (Message.Message == "getM3u8Cache") {
            fetch(Message.url, { method: "GET", cache: "force-cache" })
                .then(response => response.text())
                .then(text => sendResponse({ success: true, data: text }))
                .catch(() => sendResponse({ success: false, error: "Failed to fetch" }));
            return true;
        }
    });

    // Heart Beat
    var Port;
    function connect() {
        Port = chrome.runtime.connect(chrome.runtime.id, { name: "HeartBeat" });
        Port.postMessage("HeartBeat");
        Port.onMessage.addListener(function (message, Port) { return true; });
        Port.onDisconnect.addListener(connect);
    }
    connect();

    function secToTime(sec) {
        let time = "";
        let hour = Math.floor(sec / 3600);
        let min = Math.floor((sec % 3600) / 60);
        sec = Math.floor(sec % 60);
        if (hour > 0) { time = hour + "'"; }
        if (min < 10) { time += "0"; }
        time += min + "'";
        if (sec < 10) { time += "0"; }
        time += sec;
        return time;
    }
    const isFirefox = navigator.userAgent.includes('Firefox');
    const sendAddMedia = (data) => {
        chrome.runtime.sendMessage({
            Message: "addMedia",
            url: data.url,
            href: data.href ?? location.href,
            extraExt: data.ext,
            mime: data.mime,
            requestHeaders: { referer: data.referer },
            requestId: data.requestId
        });
    };
    /** LocalMediaWeb settings cache for blob upload from page scripts */
    const LMW_DEFAULTS = {
        lmwURL: "http://127.0.0.1:8790",
        lmwToken: "",
        lmwDefaultCategory: "default",
        lmwUseJasna: false,
        lmwRestricted: false,
    };
    let _lmwSettings = null;
    async function getLmwSettings() {
        if (_lmwSettings) return _lmwSettings;
        try {
            const keys = Object.keys(LMW_DEFAULTS);
            const [syncData, localData] = await Promise.all([
                chrome.storage.sync.get(keys),
                chrome.storage.local.get(keys),
            ]);
            _lmwSettings = { ...LMW_DEFAULTS, ...syncData, ...localData };
        } catch (e) {
            _lmwSettings = { ...LMW_DEFAULTS };
        }
        return _lmwSettings;
    }
    chrome.storage?.onChanged?.addListener((changes, area) => {
        if (area !== "local" && area !== "sync") return;
        if (changes.lmwURL || changes.lmwToken || changes.lmwDefaultCategory) {
            _lmwSettings = null;
        }
    });

    /**
     * Upload blob URL created in page MAIN world to LocalMediaWeb.
     * Page scripts cannot call extension APIs; content-script bridges them.
     */
    async function uploadBlobUrlToLmw(payload) {
        const { blobUrl, filename, title, media_type, source_url, category } = payload;
        if (!blobUrl) throw new Error("missing blobUrl");
        const s = await getLmwSettings();
        const base = (s.lmwURL || LMW_DEFAULTS.lmwURL).replace(/\/+$/, "");
        const resBlob = await fetch(blobUrl);
        if (!resBlob.ok) throw new Error("fetch blob failed " + resBlob.status);
        const blob = await resBlob.blob();
        const fd = new FormData();
        fd.append("category", category || s.lmwDefaultCategory || "default");
        fd.append("title", title || document.title || "");
        fd.append("source_url", source_url || location.href || "");
        fd.append("media_type", media_type || "video");
        fd.append("remux", "1");
        const restricted =
            payload.restricted === true ||
            payload.restricted === 1 ||
            payload.restricted === "1" ||
            s.lmwRestricted === true;
        let cleaned = [];
        if (payload.tags) {
            const tags = Array.isArray(payload.tags) ? payload.tags : String(payload.tags).split(/[,，\s]+/);
            cleaned = tags.map((t) => String(t).trim()).filter(Boolean);
        }
        if (restricted && !cleaned.includes("限制级")) cleaned = cleaned.concat(["限制级"]);
        if (cleaned.length) fd.append("tags", JSON.stringify(cleaned));
        const useJasna =
            payload.use_jasna === true ||
            payload.use_jasna === 1 ||
            payload.use_jasna === "1" ||
            s.lmwUseJasna === true;
        if (useJasna) fd.append("use_jasna", "1");
        if (restricted) fd.append("restricted", "1");
        const name = filename || `${(title || document.title || "capture").slice(0, 40)}.bin`;
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
    }

    /** Merge separate video + audio capture tracks into one media item. */
    async function uploadAvBlobUrlsToLmw(payload) {
        const { videoBlobUrl, audioBlobUrl, filename, title, source_url, category } = payload;
        if (!videoBlobUrl) throw new Error("missing videoBlobUrl");
        const s = await getLmwSettings();
        const base = (s.lmwURL || LMW_DEFAULTS.lmwURL).replace(/\/+$/, "");
        const vRes = await fetch(videoBlobUrl);
        if (!vRes.ok) throw new Error("fetch video blob failed");
        const vBlob = await vRes.blob();
        const fd = new FormData();
        fd.append("category", category || s.lmwDefaultCategory || "default");
        fd.append("title", title || document.title || "");
        fd.append("source_url", source_url || location.href || "");
        const restricted =
            payload.restricted === true ||
            payload.restricted === 1 ||
            payload.restricted === "1" ||
            s.lmwRestricted === true;
        let cleaned = [];
        if (payload.tags) {
            const tags = Array.isArray(payload.tags) ? payload.tags : String(payload.tags).split(/[,，\s]+/);
            cleaned = tags.map((t) => String(t).trim()).filter(Boolean);
        }
        if (restricted && !cleaned.includes("限制级")) cleaned = cleaned.concat(["限制级"]);
        if (cleaned.length) fd.append("tags", JSON.stringify(cleaned));
        const useJasna =
            payload.use_jasna === true ||
            payload.use_jasna === 1 ||
            payload.use_jasna === "1" ||
            s.lmwUseJasna === true;
        if (useJasna) fd.append("use_jasna", "1");
        if (restricted) fd.append("restricted", "1");
        const baseName = (filename || title || document.title || "capture").replace(/\.[^.]+$/, "");
        fd.append("video", vBlob, `${baseName}_video.mp4`);
        if (audioBlobUrl) {
            const aRes = await fetch(audioBlobUrl);
            if (aRes.ok) {
                const aBlob = await aRes.blob();
                if (aBlob.size > 32) fd.append("audio", aBlob, `${baseName}_audio.mp4`);
            }
        }
        const headers = {};
        const token = (s.lmwToken || "").trim();
        if (token) headers["X-LMW-Token"] = token;
        const res = await fetch(base + "/api/upload-av", { method: "POST", headers, body: fd });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`${res.status} ${text || res.statusText}`);
        }
        return res.json();
    }

    function replyIngest(requestId, ok, data) {
        try {
            window.postMessage({
                action: "catCatchIngestBlobResult",
                requestId,
                ok,
                ...(ok ? { result: data } : { error: data }),
            }, window.location.origin);
        } catch (e) { /* ignore */ }
    }

    window.addEventListener("message", (event) => {
        const action = ["catCatchAddMedia", "catCatchAddKey", "catCatchFFmpeg", "catCatchFFmpegResult", "catCatchCloseScript", "catCatchIngestBlob", "catCatchIngestAV"];
        if (!event.data || !event.data.action || event.origin !== window.location.origin || !action.includes(event.data.action)) { return; }
        event.stopPropagation();
        event.stopImmediatePropagation();

        if (event.data.action == "catCatchIngestBlob") {
            const requestId = event.data.requestId || String(Date.now());
            uploadBlobUrlToLmw(event.data)
                .then((result) => replyIngest(requestId, true, result))
                .catch((err) => replyIngest(requestId, false, (err && err.message) || String(err)));
            return;
        }
        if (event.data.action == "catCatchIngestAV") {
            const requestId = event.data.requestId || String(Date.now());
            uploadAvBlobUrlsToLmw(event.data)
                .then((result) => replyIngest(requestId, true, result))
                .catch((err) => replyIngest(requestId, false, (err && err.message) || String(err)));
            return;
        }

        if (event.data.action == "catCatchAddMedia") {
            if (!event.data.url) { return; }

            /*
             * firefox 不允许直接下载跨域blob内容
             * fetch获取文本内容并缓存到m3u8Text中，供 m3u8.html调用获取。
             */
            if (event.data.url.startsWith("blob:") && isFirefox) {
                fetch(event.data.url)
                    .then(response => response.text())
                    .then(text => {
                        m3u8Text.set(event.data.url, text);
                        sendAddMedia(event.data);
                    });
                return;
            }
            sendAddMedia(event.data);
        }
        if (event.data.action == "catCatchAddKey") {
            let key = event.data.key;
            if (key instanceof ArrayBuffer || key instanceof Array) {
                key = ArrayToBase64(key);
            }
            if (_key.has(key)) { return; }
            _key.add(key);
            chrome.runtime.sendMessage({
                Message: "send2local",
                action: "addKey",
                data: key,
            });
            chrome.runtime.sendMessage({
                Message: "popupAddKey",
                data: key,
                url: event.data.url,
            });
        }
        if (event.data.action == "catCatchFFmpeg") {
            if (!event.data.use ||
                !event.data.files ||
                !event.data.files instanceof Array ||
                event.data.files.length == 0
            ) { return; }
            event.data.title = event.data.title ?? document.title ?? new Date().getTime().toString();
            event.data.title = event.data.title.replaceAll('"', "").replaceAll("'", "").replaceAll(" ", "");
            let data = {
                Message: event.data.action,
                action: event.data.use,
                files: event.data.files,
                url: event.data.href ?? event.source.location.href,
            };
            data = { ...event.data, ...data };
            chrome.runtime.sendMessage(data);
        }
        if (event.data.action == "catCatchFFmpegResult") {
            if (!event.data.state || !event.data.tabId) { return; }
            chrome.runtime.sendMessage({ Message: "catCatchFFmpegResult", ...event.data });
        }
        if (event.data.action == "catCatchCloseScript") {
            if (!event.data.script || !event.isTrusted) { return; }
            chrome.runtime.sendMessage({ Message: "closeScript", ...event.data });
        }

    }, { capture: true });

    function ArrayToBase64(data) {
        try {
            let bytes = new Uint8Array(data);
            let binary = "";
            for (let i = 0; i < bytes.byteLength; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            if (typeof _btoa == "function") {
                return _btoa(binary);
            }
            return btoa(binary);
        } catch (e) {
            return false;
        }
    }
})();