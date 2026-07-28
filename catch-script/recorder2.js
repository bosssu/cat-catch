(function () {
    console.log("recorder2.js Start");
    if (document.getElementById("catCatchRecorder2")) {
        return;
    }
    if (!navigator.mediaDevices) {
        alert("当前网页不支持屏幕分享");
        return;
    }

    let language = navigator.language.replace("-", "_");
    if (window.CatCatchI18n) {
        if (!window.CatCatchI18n.languages.includes(language)) {
            language = language.split("_")[0];
            if (!window.CatCatchI18n.languages.includes(language)) {
                language = "en";
            }
        }
    }

    // 添加style
    const style = document.createElement("style");
    style.innerHTML = `
        @keyframes color-change{
            0% { outline: 4px solid rgb(26, 115, 232); }
            50% { outline: 4px solid red; }
            100% { outline: 4px solid rgb(26, 115, 232); }
        }
        #catCatchRecorder2 {
            font-weight: bold;
            position: absolute;
            cursor: move;
            z-index: 999999999;
            outline: 4px solid rgb(26, 115, 232);
            resize: both;
            overflow: hidden;
            height: 720px;
            width: 1024px;
            top: 30%;
            left: 30%;
            pointer-events: none;
            font-size: 10px;
        }
        #catCatchRecorderHeader {
            background: rgb(26, 115, 232);
            color: white;
            text-align: center;
            height: 20px;
            cursor: pointer;
            display: flex;
            justify-content: space-evenly;
            align-items: center;
            pointer-events: auto;
        }
        #catCatchRecorderTitle {
            cursor: move;
            user-select: none;
            width: 45%;
        }
        #catCatchRecorderinnerCropArea {
            height: calc(100% - 20px);
            width: 100%;
        }
        .animation {
            animation: color-change 5s infinite;
        }
        .input-group {
            display: flex;
            align-items: center;
        }
        .input-group label {
            margin-right: 5px;
        }
        #videoBitrate, #audioBitrate {
            width: 4rem;
        }
        .input-group label{
            width: 5rem;
        }`;

    // 添加div
    let cat = document.createElement("div");
    cat.setAttribute("id", "catCatchRecorder2");
    cat.innerHTML = `<div id="catCatchRecorderinnerCropArea"></div>
        <div id="catCatchRecorderHeader">
            <div class="input-group">
                <select id="videoBits">
                    <option value="2500000" data-i18n="videoBits">视频码率</option>
                    <option value="2500000">2.5 Mbps</option>
                    <option value="5000000">5 Mbps</option>
                    <option value="8000000">8 Mbps</option>
                    <option value="16000000">16 Mbps</option>
                </select>
            </div>
            <div class="input-group">
                <select id="audioBits">
                    <option value="128000" data-i18n="audioBits">视频码率</option>
                    <option value="128000">128 kbps</option>
                    <option value="256000">256 kbps</option>
                </select>
            </div>
            <div id="catCatchRecorderStart" data-i18n="startRecording">开始录制</div>
            <label style="color:#fff;font-size:12px;display:flex;align-items:center;gap:4px;white-space:nowrap;">
                <input type="checkbox" id="ingestLmw" checked style="-webkit-appearance:auto;">入库
            </label>
            <label style="color:#fff;font-size:12px;display:flex;align-items:center;gap:4px;white-space:nowrap;">
                <input type="checkbox" id="alsoDownload" style="-webkit-appearance:auto;">下载
            </label>
            <div id="catCatchRecorderTitle" data-i18n="dragWindow">拖动窗口</div>
            <div id="catCatchRecorderClose" data-i18n="close">关闭</div>
        </div>`;

    // 创建 Shadow DOM 放入CatCatch
    const divShadow = document.createElement('div');
    const shadowRoot = divShadow.attachShadow({ mode: 'closed' });
    shadowRoot.appendChild(cat);
    shadowRoot.appendChild(style);
    document.getElementsByTagName('html')[0].appendChild(divShadow);

    // 事件绑定
    const catCatchRecorderStart = cat.querySelector("#catCatchRecorderStart");
    catCatchRecorderStart.onclick = function () {
        if (recorder) {
            recorder.stop();
            return;
        }
        try { startRecording(); } catch (e) { console.log(e); return; }
    }
    cat.querySelector("#catCatchRecorderClose").onclick = function () {
        recorder && recorder.stop();
        cat.remove();
        window.postMessage({ action: "catCatchCloseScript", script: "recorder2.js" });
    }

    // 拖动div
    const catCatchRecorderinnerCropArea = cat.querySelector("#catCatchRecorderinnerCropArea");
    cat.querySelector("#catCatchRecorderTitle").onpointerdown = (e) => {
        let pos1, pos2, pos3, pos4;
        pos3 = e.clientX;
        pos4 = e.clientY;
        if (pos3 - cat.offsetWidth - cat.offsetLeft > - 20 &&
            pos4 - cat.offsetHeight - cat.offsetTop > - 20) {
            return;
        }
        document.onpointermove = (e) => {
            pos1 = pos3 - e.clientX;
            pos2 = pos4 - e.clientY;
            pos3 = e.clientX;
            pos4 = e.clientY;
            cat.style.top = cat.offsetTop - pos2 + "px";
            cat.style.left = cat.offsetLeft - pos1 + "px";
        }
        document.onpointerup = () => {
            document.onpointerup = null;
            document.onpointermove = null;
        }
    }
    // document.getElementsByTagName('html')[0].appendChild(cat);

    // 初始化位置
    const video = document.querySelector("video");
    if (video) {
        // 调整和video一样大小
        if (video.clientHeight >= 0 && video.clientWidth >= 0) {
            cat.style.height = video.clientHeight + 20 + "px";
            cat.style.width = video.clientWidth + "px";
        }
        // 调整到video的位置
        const videoOffset = getElementOffset(video);
        if (videoOffset.top >= 0 && videoOffset.left >= 0) {
            cat.style.top = videoOffset.top + "px";
            cat.style.left = videoOffset.left + "px";
        }
        // 防止遮挡菜单
        let catAttr = cat.getBoundingClientRect();
        if (document.documentElement.scrollTop + catAttr.bottom > document.documentElement.scrollTop + window.innerHeight) {
            cat.style.top = document.documentElement.scrollTop + window.innerHeight - catAttr.height + "px";
        }
    }

    // 录制
    var recorder;
    async function startRecording() {
        const buffer = [];
        let option = {
            mimeType: 'video/webm;codecs=vp8,opus',
            videoBitsPerSecond: +cat.querySelector("#videoBits").value,
            audioBitsPerSecond: +cat.querySelector("#audioBits").value
        };

        if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')) {
            option.mimeType = 'video/webm;codecs=vp9,opus';
        } else if (MediaRecorder.isTypeSupported('video/webm;codecs=h264')) {
            option.mimeType = 'video/webm;codecs=h264';
        }
        const cropTarget = await CropTarget.fromElement(catCatchRecorderinnerCropArea);
        const stream = await navigator.mediaDevices
            .getDisplayMedia({
                preferCurrentTab: true,
                video: {
                    cursor: "never"
                },
                audio: {
                    sampleRate: 48000,
                    sampleSize: 16,
                    channelCount: 2
                }
            });
        const [track] = stream.getVideoTracks();
        await track.cropTo(cropTarget);
        recorder = new MediaRecorder(stream, option);
        recorder.start();
        recorder.onstart = function (e) {
            buffer.slice(0);
            catCatchRecorderStart.innerHTML = i18n("stopRecording", "停止录制");
            cat.classList.add("animation");
        }
        recorder.ondataavailable = function (e) {
            buffer.push(e.data);
        }
        recorder.onstop = function () {
            const fileBlob = new Blob(buffer, { type: option.mimeType || "video/webm" });
            const title = (document.title || "screen").trim() || "screen";
            const doIngest = cat.querySelector("#ingestLmw")?.checked;
            const doDownload = cat.querySelector("#alsoDownload")?.checked || !doIngest;
            if (doDownload) {
                const a = document.createElement('a');
                a.href = URL.createObjectURL(fileBlob);
                a.download = `${title}.webm`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(a.href), 2000);
                a.remove();
            }
            if (doIngest) {
                const sizeMb = (fileBlob.size / 1024 / 1024).toFixed(1);
                if (!window.confirm(`确认将录屏入库到媒体库？\n约 ${sizeMb} MB · webm`)) {
                    catCatchRecorderStart.innerHTML = i18n("startRecording", "开始录制");
                } else {
                    const tagRaw = window.prompt("标签（逗号分隔；取消=中止）", "video, screen");
                    if (tagRaw === null) {
                        catCatchRecorderStart.innerHTML = i18n("startRecording", "开始录制");
                    } else {
                    const tags = String(tagRaw).split(/[,，;；\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
                    catCatchRecorderStart.innerHTML = "入库中…";
                    catCatchIngestBlob(fileBlob, {
                        filename: `${title}.webm`,
                        title,
                        media_type: "video",
                        tags,
                    }).then((res) => {
                        const id = res?.media_id || res?.item?.id || "";
                        alert(id ? `录屏入库成功 #${id}` : "录屏入库成功");
                        catCatchRecorderStart.innerHTML = i18n("startRecording", "开始录制");
                    }).catch((e) => {
                        console.error(e);
                        alert("入库失败: " + (e?.message || e));
                        catCatchRecorderStart.innerHTML = i18n("startRecording", "开始录制");
                    });
                    }
                }
            } else {
                catCatchRecorderStart.innerHTML = i18n("startRecording", "开始录制");
            }
            buffer.slice(0);
            stream.getTracks().forEach(track => track.stop());
            recorder = undefined;
            cat.classList.remove("animation");
        }
    }

    function catCatchIngestBlob(blob, meta = {}) {
        return new Promise((resolve, reject) => {
            const requestId = "lmw_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
            const blobUrl = URL.createObjectURL(blob);
            let settled = false;
            const finish = (fn) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                window.removeEventListener("message", onMsg);
                setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
                fn();
            };
            const onMsg = (event) => {
                if (!event.data || event.data.action !== "catCatchIngestBlobResult") return;
                if (event.data.requestId !== requestId) return;
                if (event.data.ok) finish(() => resolve(event.data.result));
                else finish(() => reject(new Error(event.data.error || "ingest failed")));
            };
            window.addEventListener("message", onMsg);
            window.postMessage({
                action: "catCatchIngestBlob",
                requestId,
                blobUrl,
                filename: meta.filename || "screen.webm",
                title: meta.title || document.title || "screen",
                media_type: meta.media_type || "video",
                source_url: location.href,
                tags: meta.tags || [],
            }, location.origin);
            const timer = setTimeout(() => {
                finish(() => reject(new Error("入库超时")));
            }, 600000);
        });
    }
    function getElementOffset(el) {
        const rect = el.getBoundingClientRect();
        const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
        const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
        return {
            top: rect.top + scrollTop,
            left: rect.left + scrollLeft
        };
    }

    // i18n
    if (window.CatCatchI18n && CatCatch) {
        CatCatch.querySelectorAll('[data-i18n]').forEach(function (element) {
            const translation = window.CatCatchI18n[element.dataset.i18n]?.[language];
            if (translation) {
                element.innerHTML = translation;
            }
        });
        CatCatch.querySelectorAll('[data-i18n-outer]').forEach(function (element) {
            const outerTranslation = window.CatCatchI18n[element.dataset.i18nOuter]?.[language];
            if (outerTranslation) {
                element.outerHTML = outerTranslation;
            }
        });
    }
    function i18n(key, original = "") {
        if (!window.CatCatchI18n || !CatCatch) { return original };
        return window.CatCatchI18n[key][language];
    }
})();