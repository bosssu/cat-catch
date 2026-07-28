(() => {
  const tokenKey = "lmw_token";
  const feedModeKey = "lmw_feed_mode";
  /** session: once user unmutes, keep sound on for later videos in this tab */
  const soundKey = "lmw_want_sound";
  const state = {
    view: "feed",
    mode: localStorage.getItem(feedModeKey) || "recommend",
    similarTo: null,
    items: [],
    feedIndex: 0,
    dwellStart: 0,
    viewedIds: new Set(),
    /** library fingerprint: total:newestId — used for auto-refresh after server downloads */
    libFp: "",
    libPollTimer: null,
    libRefreshing: false,
    /** first load muted; becomes true after user unmutes */
    wantSound: sessionStorage.getItem(soundKey) === "1",
  };

  const ICO = {
    heart: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`,
    skip: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>`,
    trash: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`,
    eye: `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8a3 3 0 100 6 3 3 0 000-6z"/></svg>`,
    x: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.3 5.71L12 12l6.3 6.29-1.41 1.42L10.59 13.4 4.3 19.71 2.89 18.3 9.17 12 2.89 5.71 4.3 4.29l6.29 6.3 6.29-6.3z"/></svg>`,
    volOn: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>`,
    volOff: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 003.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>`,
  };

  function setWantSound(on) {
    state.wantSound = !!on;
    try {
      sessionStorage.setItem(soundKey, state.wantSound ? "1" : "0");
    } catch (_) {}
    applySoundToAllVideos();
    document.querySelectorAll("[data-act='mute']").forEach(syncMuteBtn);
  }

  function applySoundToVideo(v) {
    if (!v || v.tagName !== "VIDEO") return;
    const wantMute = !state.wantSound;
    if (v.muted !== wantMute) {
      v.dataset.progSound = "1";
      v.muted = wantMute;
      // clear flag after event flush
      queueMicrotask(() => {
        delete v.dataset.progSound;
      });
    }
    if (state.wantSound && v.volume === 0) v.volume = 1;
    if (v.dataset.soundBound !== "1") {
      v.dataset.soundBound = "1";
      v.addEventListener("volumechange", () => {
        if (v.dataset.progSound === "1") return;
        // native controls / gesture unmuted
        if (!v.muted && v.volume > 0 && !state.wantSound) setWantSound(true);
        if (v.muted && state.wantSound) setWantSound(false);
      });
    }
  }

  function applySoundToAllVideos() {
    document.querySelectorAll("video").forEach(applySoundToVideo);
    document.querySelectorAll("[data-act='mute']").forEach(syncMuteBtn);
  }

  function syncMuteBtn(btn) {
    if (!btn) return;
    const on = state.wantSound;
    btn.classList.toggle("on", on);
    btn.innerHTML = on ? ICO.volOn : ICO.volOff;
    btn.title = on ? "静音" : "取消静音（播放声音）";
  }

  const $ = (sel) => document.querySelector(sel);
  const token = () => localStorage.getItem(tokenKey) || "";

  async function api(path, opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    const t = token();
    if (t) headers["X-LMW-Token"] = t;
    const res = await fetch(path, { ...opts, headers });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status} ${text}`);
    }
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) return res.json();
    return res;
  }

  /** Append token for native media elements (cannot set X-LMW-Token header). */
  function withAuthQuery(url) {
    if (!url) return url;
    const t = token();
    if (!t) return url;
    if (url.includes("token=")) return url;
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}token=${encodeURIComponent(t)}`;
  }

  function fileUrl(item) {
    return withAuthQuery(item.file_url);
  }
  function thumbUrl(item) {
    return withAuthQuery(item.thumb_url);
  }

  /** Immersive: hide topnav / HUD / progress (double-tap). Not zoom. */
  function isChromeHidden() {
    return document.body.classList.contains("is-chrome-hidden");
  }

  function setChromeHidden(on) {
    document.body.classList.toggle("is-chrome-hidden", !!on);
    // drop visible progress when entering immersive
    if (on) {
      document.querySelectorAll(".feed-progress.is-visible").forEach((el) => {
        el.classList.remove("is-visible");
      });
    }
  }

  function clearChromeHidden() {
    setChromeHidden(false);
  }

  /**
   * 双击 / 双触：隐藏 UI ↔ 恢复（顶栏、HUD、进度条）
   * iOS/Edge 会在 touch 双击后再合成 dblclick，必须防抖，否则会连跳两次。
   */
  function bindImmersiveToggle(stage) {
    if (!stage || stage.dataset.immersiveBound === "1") return;
    stage.dataset.immersiveBound = "1";

    let lastTapAt = 0;
    let lastTapX = 0;
    let lastTapY = 0;
    let moved = false;
    let touchStartX = 0;
    let touchStartY = 0;
    let armDoubleTap = false;
    let cooldownUntil = 0;

    function toggleChrome() {
      const now = Date.now();
      if (now < cooldownUntil) return;
      cooldownUntil = now + 520;
      stage._uiCooldownUntil = cooldownUntil;
      setChromeHidden(!isChromeHidden());
    }

    stage.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (Date.now() < cooldownUntil) return;
      toggleChrome();
    });

    stage.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length !== 1) {
          moved = true;
          armDoubleTap = false;
          return;
        }
        const t = e.touches[0];
        touchStartX = t.clientX;
        touchStartY = t.clientY;
        moved = false;
        const now = Date.now();
        const dt = now - lastTapAt;
        const dist = Math.hypot(t.clientX - lastTapX, t.clientY - lastTapY);
        if (lastTapAt && dt > 30 && dt < 420 && dist < 48) {
          armDoubleTap = true;
          e.preventDefault();
        } else {
          armDoubleTap = false;
        }
      },
      { passive: false }
    );
    stage.addEventListener(
      "touchmove",
      (e) => {
        if (e.touches.length !== 1) {
          moved = true;
          armDoubleTap = false;
          return;
        }
        const t = e.touches[0];
        if (Math.hypot(t.clientX - touchStartX, t.clientY - touchStartY) > 14) {
          moved = true;
          armDoubleTap = false;
        }
      },
      { passive: true }
    );
    stage.addEventListener(
      "touchend",
      (e) => {
        if (moved || e.changedTouches.length !== 1) {
          armDoubleTap = false;
          return;
        }
        const t = e.changedTouches[0];
        if (armDoubleTap) {
          e.preventDefault();
          e.stopPropagation();
          toggleChrome();
          lastTapAt = 0;
          armDoubleTap = false;
          return;
        }
        lastTapAt = Date.now();
        lastTapX = t.clientX;
        lastTapY = t.clientY;
      },
      { passive: false }
    );

    stage.addEventListener(
      "click",
      (e) => {
        if (Date.now() < cooldownUntil) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      true
    );
  }

  async function loadFeed(opts = {}) {
    const keepId = opts.keepCurrentId;
    const quiet = !!opts.quiet;
    if (!quiet) clearChromeHidden();
    const q = new URLSearchParams({
      mode: state.mode || "recommend",
      limit: "80",
    });
    if (state.mode === "similar" && state.similarTo) {
      q.set("similar_to", String(state.similarTo));
    }
    const data = await api(`/api/feed?${q}`);
    state.items = data.items || [];
    state.viewedIds = new Set();
    renderFeed();
    renderGrid();
    // Soft refresh: try stay on the same item after library grows
    if (keepId != null) {
      const idx = state.items.findIndex((x) => x.id === keepId);
      if (idx >= 0) {
        state.feedIndex = idx;
        requestAnimationFrame(() => {
          const slide = document.querySelector(`.snap-slide[data-id="${keepId}"]`);
          if (slide) slide.scrollIntoView({ block: "nearest", behavior: "auto" });
        });
      }
    }
  }

  function ensureFeedModeOption(value, label) {
    const modeSel = $("#feedMode");
    if (!modeSel) return;
    if (![...modeSel.options].some((o) => o.value === value)) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      modeSel.appendChild(opt);
    }
    modeSel.value = value;
  }

  function syncSimilarBtn() {
    const btn = $("#btnSimilar");
    if (!btn) return;
    if (state.mode === "similar") {
      btn.textContent = "推荐随机";
      btn.title = "退出相似推荐，切换为随机 Feed";
      btn.classList.add("is-active");
    } else {
      btn.textContent = "推荐相似";
      btn.title = "根据当前 Feed 媒体的标签推荐相似内容";
      btn.classList.remove("is-active");
    }
  }

  async function loadRandomFeed() {
    state.mode = "random";
    state.similarTo = null;
    localStorage.setItem(feedModeKey, "random");
    ensureFeedModeOption("random", "随机");
    syncSimilarBtn();
    showToast("随机推荐");
    await loadFeed();
    setView("feed");
  }

  async function loadSimilarFromCurrent() {
    const it = currentItem();
    if (!it) {
      showToast("暂无当前媒体");
      return;
    }
    const tags = it.tags || [];
    if (!tags.length) {
      showToast("当前媒体无标签，已按推荐模式刷新");
      state.mode = "recommend";
      state.similarTo = null;
      localStorage.setItem(feedModeKey, state.mode);
      ensureFeedModeOption(state.mode, "推荐");
      syncSimilarBtn();
      await loadFeed();
      return;
    }
    state.mode = "similar";
    state.similarTo = it.id;
    localStorage.setItem(feedModeKey, "similar");
    ensureFeedModeOption("similar", "相似");
    syncSimilarBtn();
    showToast(`相似推荐 · 基于 #${it.id} · ${tags.slice(0, 5).join(", ")}`);
    await loadFeed();
    setView("feed");
  }

  async function toggleSimilarOrRandom() {
    if (state.mode === "similar") {
      await loadRandomFeed();
      return;
    }
    await loadSimilarFromCurrent();
  }

  /**
   * Poll media total + newest id. When a batch finishes on the server,
   * fingerprint changes → reload feed/grid (and admin list if open).
   */
  async function pollLibraryChange() {
    if (document.hidden || state.libRefreshing) return;
    // Don't yank the UI while user is in immersive (chrome hidden)
    if (isChromeHidden()) return;
    try {
      const data = await api("/api/media?limit=1&sort=new");
      const newestId = (data.items && data.items[0] && data.items[0].id) || 0;
      const total = data.total || 0;
      const fp = `${total}:${newestId}`;
      if (!state.libFp) {
        state.libFp = fp;
        return;
      }
      if (state.libFp === fp) return;
      state.libFp = fp;
      state.libRefreshing = true;
      const keepId = currentItem()?.id;
      try {
        await loadFeed({ keepCurrentId: keepId, quiet: true });
        if (state.view === "admin") {
          await refreshAdmin().catch(() => {});
        }
        showToast(`库已更新 · ${total} 项`);
      } finally {
        state.libRefreshing = false;
      }
    } catch (e) {
      // offline / auth — silent
      console.debug("lib poll", e);
    }
  }

  function showToast(msg) {
    let el = document.getElementById("lmwToast");
    if (!el) {
      el = document.createElement("div");
      el.id = "lmwToast";
      el.className = "lmw-toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(el._hideT);
    el._hideT = setTimeout(() => el.classList.remove("show"), 2200);
  }

  function startLibraryPoll() {
    if (state.libPollTimer) clearInterval(state.libPollTimer);
    // ~2.5s while page visible — catches finished ingest jobs quickly
    state.libPollTimer = setInterval(pollLibraryChange, 2500);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) pollLibraryChange();
    });
    // initial baseline after first feed load
    setTimeout(pollLibraryChange, 800);
  }

  function currentItem() {
    return state.items[state.feedIndex] || null;
  }

  async function postInteract(id, event, dwell_ms = 0) {
    try {
      return await api(`/api/media/${id}/interact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event, dwell_ms }),
      });
    } catch (e) {
      console.warn("interact failed", e);
      return null;
    }
  }

  async function flushDwell(prevIndex) {
    const item = state.items[prevIndex];
    if (!item) return;
    const ms = state.dwellStart ? Date.now() - state.dwellStart : 0;
    state.dwellStart = Date.now();
    if (ms >= 800) await postInteract(item.id, "dwell", ms);
  }

  async function onSlideActive(index) {
    const prev = state.feedIndex;
    if (prev !== index) {
      await flushDwell(prev);
      // 滑走时保持沉浸态（用户再双击可恢复）；不自动打断
    }
    state.feedIndex = index;
    state.dwellStart = Date.now();
    const item = state.items[index];
    if (!item) return;
    if (!state.viewedIds.has(item.id)) {
      state.viewedIds.add(item.id);
      postInteract(item.id, "view");
    }
  }

  function typeChip(item) {
    const partial = item.partial ? `<span class="chip warn">不完整</span>` : "";
    const tags = (item.tags || [])
      .slice(0, 5)
      .map((t) => `<span class="chip tag">#${escapeHtml(t)}</span>`)
      .join("");
    return `<span class="chip">${escapeHtml(item.media_type)}</span>
      <span class="chip">#${item.id}</span>${tags}${partial}`;
  }

  function renderFeed() {
    const scroller = $("#feedScroller");
    const empty = $("#feedEmpty");
    if (!state.items.length) {
      scroller.innerHTML = "";
      empty.classList.remove("hide");
      return;
    }
    empty.classList.add("hide");
    scroller.innerHTML = state.items
      .map((item, i) => {
        const liked = item.liked ? "on" : "";
        const isImg = item.media_type === "image" || item.media_type === "gif";
        // 首次默认静音（autoplay 策略）；用户取消静音后 state.wantSound 生效
        const muteAttr = state.wantSound ? "" : " muted";
        const media = isImg
          ? `<img data-src="${fileUrl(item)}" alt="" draggable="false" />`
          : `<video data-src="${fileUrl(item)}" playsinline webkit-playsinline${muteAttr} loop preload="metadata"></video>
          <div class="feed-progress" aria-hidden="true">
            <div class="feed-progress-track">
              <div class="feed-progress-fill"></div>
              <div class="feed-progress-knob"></div>
            </div>
            <div class="feed-progress-time"><span class="cur">0:00</span><span class="sep">/</span><span class="dur">0:00</span></div>
          </div>`;
        return `<section class="snap-slide" data-index="${i}" data-id="${item.id}">
          <div class="media-stage" title="点在画面上暂停/播放 · 双击隐藏/恢复界面">${media}</div>
          <div class="hud">
            <div class="meta">
              <div class="type">${typeChip(item)}</div>
              <div class="title">${escapeHtml(item.title || item.source_url || "未命名")}</div>
              <div class="stats">
                <span>${ICO.heart} ${item.like_count || 0}</span>
                <span>${ICO.eye} ${item.view_count || 0}</span>
              </div>
            </div>
            <div class="actions">
              <button type="button" class="round mute-btn" data-act="mute" data-id="${item.id}" title="取消静音（播放声音）">${state.wantSound ? ICO.volOn : ICO.volOff}</button>
              <button type="button" class="round like ${liked}" data-act="like" data-id="${item.id}" title="喜欢 (L)">${ICO.heart}</button>
              <button type="button" class="round danger" data-act="del" data-id="${item.id}" title="删除">${ICO.trash}</button>
            </div>
          </div>
        </section>`;
      })
      .join("");

    scroller.querySelectorAll("[data-act]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        handleAction(btn.dataset.act, Number(btn.dataset.id), btn);
      });
    });
    scroller.querySelectorAll(".media-stage").forEach((stage) => {
      bindImmersiveToggle(stage);
      bindFeedProgress(stage);
    });
    scroller.querySelectorAll("video").forEach(applySoundToVideo);
    scroller.querySelectorAll("[data-act='mute']").forEach(syncMuteBtn);
    observeFeedMedia();
    state.dwellStart = Date.now();
  }

  function formatMediaTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
    const ss = String(s).padStart(2, "0");
    return h > 0 ? `${h}:${mm.padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  }

  /**
   * Short-video style progress: hidden by default, show on tap/click,
   * auto-hide after idle; drag/seek on the bar.
   */
  function bindFeedProgress(stage) {
    if (!stage || stage.dataset.progressBound === "1") return;
    const video = stage.querySelector("video");
    const bar = stage.querySelector(".feed-progress");
    if (!video || !bar) return;
    stage.dataset.progressBound = "1";

    const fill = bar.querySelector(".feed-progress-fill");
    const knob = bar.querySelector(".feed-progress-knob");
    const curEl = bar.querySelector(".cur");
    const durEl = bar.querySelector(".dur");
    const track = bar.querySelector(".feed-progress-track");
    let hideTimer = null;
    let seeking = false;
    const HIDE_MS = 2800;

    const showBar = () => {
      bar.classList.add("is-visible");
      clearTimeout(hideTimer);
      if (!seeking) {
        hideTimer = setTimeout(() => {
          if (!seeking) bar.classList.remove("is-visible");
        }, HIDE_MS);
      }
    };
    const hideBarSoon = () => {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (!seeking) bar.classList.remove("is-visible");
      }, HIDE_MS);
    };

    const paint = () => {
      const d = video.duration;
      const t = video.currentTime || 0;
      const ratio = d && isFinite(d) && d > 0 ? Math.min(1, Math.max(0, t / d)) : 0;
      if (fill) fill.style.width = `${ratio * 100}%`;
      if (knob) knob.style.left = `${ratio * 100}%`;
      if (curEl) curEl.textContent = formatMediaTime(t);
      if (durEl) durEl.textContent = formatMediaTime(isFinite(d) ? d : 0);
    };

    video.addEventListener("timeupdate", paint);
    video.addEventListener("loadedmetadata", paint);
    video.addEventListener("durationchange", paint);
    video.addEventListener("seeked", paint);
    video.addEventListener("play", () => {
      // keep hidden while playing unless user opened it
    });

    // Only clicks that hit the video's drawn box (not letterbox / empty stage) toggle play
    // dblclick immersive handled separately; delay click so double-tap still works
    const pointHitsVideo = (clientX, clientY) => {
      const r = video.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      return (
        clientX >= r.left &&
        clientX <= r.right &&
        clientY >= r.top &&
        clientY <= r.bottom
      );
    };

    let tapTimer = null;
    stage.addEventListener("click", (e) => {
      if (e.target.closest(".feed-progress")) return;
      if (e.target.closest(".hud")) return;
      if (Date.now() < (stage._uiCooldownUntil || 0)) return;
      if (!pointHitsVideo(e.clientX, e.clientY)) return;
      if (tapTimer) clearTimeout(tapTimer);
      tapTimer = setTimeout(() => {
        tapTimer = null;
        if (video.paused) {
          video.dataset.userPaused = "0";
          video.play().catch(() => {});
        } else {
          video.dataset.userPaused = "1";
          video.pause();
        }
        // immersive: don't pop chrome/progress back when UI is hidden
        if (!isChromeHidden()) showBar();
      }, 260);
    });
    stage.addEventListener("dblclick", () => {
      if (tapTimer) {
        clearTimeout(tapTimer);
        tapTimer = null;
      }
    });

    const seekFromEvent = (clientX) => {
      const rect = track.getBoundingClientRect();
      const d = video.duration;
      if (!rect.width || !d || !isFinite(d)) return;
      const r = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      video.currentTime = r * d;
      paint();
    };

    const onPointerDown = (e) => {
      if (!e.isPrimary && e.pointerType === "touch") return;
      seeking = true;
      showBar();
      bar.classList.add("is-seeking");
      track.setPointerCapture?.(e.pointerId);
      seekFromEvent(e.clientX);
      e.preventDefault();
      e.stopPropagation();
    };
    const onPointerMove = (e) => {
      if (!seeking) return;
      seekFromEvent(e.clientX);
      e.preventDefault();
    };
    const onPointerUp = (e) => {
      if (!seeking) return;
      seeking = false;
      bar.classList.remove("is-seeking");
      try {
        track.releasePointerCapture?.(e.pointerId);
      } catch (_) {}
      hideBarSoon();
    };

    track.addEventListener("pointerdown", onPointerDown);
    track.addEventListener("pointermove", onPointerMove);
    track.addEventListener("pointerup", onPointerUp);
    track.addEventListener("pointercancel", onPointerUp);
    // prevent stage immersive handlers from eating bar interactions
    bar.addEventListener("click", (e) => e.stopPropagation());
    bar.addEventListener("dblclick", (e) => e.stopPropagation());

    paint();
  }

  async function handleAction(act, id, btn) {
    const idx = state.items.findIndex((x) => x.id === id);
    if (act === "mute") {
      setWantSound(!state.wantSound);
      // 取消静音后尝试继续播放当前视频（用户手势内，浏览器允许出声）
      const slide = document.querySelector(`.snap-slide[data-id="${id}"] video`)
        || document.querySelector(`.snap-slide[data-index="${state.feedIndex}"] video`);
      if (slide) {
        applySoundToVideo(slide);
        slide.play().catch(() => {});
      }
      return;
    }
    if (act === "like") {
      try {
        const m = await api(`/api/media/${id}/like`, { method: "POST" });
        if (idx >= 0) state.items[idx] = m;
        if (btn) btn.classList.toggle("on", m.liked);
        const slide = document.querySelector(`.snap-slide[data-id="${id}"] .stats`);
        if (slide) {
          slide.innerHTML = `<span>${ICO.heart} ${m.like_count || 0}</span><span>${ICO.eye} ${m.view_count || 0}</span>`;
        }
      } catch (e) {
        alert("喜欢失败: " + e.message);
      }
      return;
    }
    if (act === "del") {
      if (!confirm(`确定删除 #${id}？将删除磁盘文件。`)) return;
      try {
        await api(`/api/media/${id}`, { method: "DELETE" });
        state.items = state.items.filter((x) => x.id !== id);
        renderFeed();
        renderGrid();
      } catch (e) {
        alert("删除失败: " + e.message);
      }
    }
  }

  function tryAutoplayVideo(media) {
    if (!media || media.tagName !== "VIDEO") return;
    if (media.dataset.userPaused === "1") return;
    applySoundToVideo(media);
    const p = media.play();
    if (p && typeof p.catch === "function") {
      p.catch(() => {
        // autoplay blocked or not ready — retry once after canplay
        const once = () => {
          media.removeEventListener("canplay", once);
          if (media.dataset.userPaused === "1") return;
          applySoundToVideo(media);
          media.play().catch(() => {});
        };
        media.addEventListener("canplay", once);
      });
    }
  }

  function observeFeedMedia() {
    const slides = [...document.querySelectorAll(".snap-slide")];
    if (state._feedIo) {
      try {
        state._feedIo.disconnect();
      } catch (_) {}
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          const el = en.target;
          const media = el.querySelector(".media-stage img, .media-stage video");
          if (!media) continue;
          if (en.isIntersecting && en.intersectionRatio > 0.5) {
            const src = media.getAttribute("data-src");
            // 必须等 src 加载完成再 play，否则会出现「刷到暂停、要点一下才播」
            if (src && media.getAttribute("src") !== src) {
              loadMediaEl(media, src).then(() => {
                tryAutoplayVideo(media);
              });
            } else {
              tryAutoplayVideo(media);
            }
            onSlideActive(Number(el.dataset.index || 0));
          } else if (media.tagName === "VIDEO") {
            media.pause();
            // 滑走后清除 userPaused，回来可自动播
            media.dataset.userPaused = "0";
          }
        }
      },
      { root: $("#feedScroller"), threshold: [0.5, 0.75] }
    );
    state._feedIo = io;
    slides.forEach((s) => io.observe(s));
  }

  async function loadMediaEl(el, url) {
    if (!url) return false;
    const authed = withAuthQuery(url);

    // VIDEO: never fetch-as-blob (breaks Range / OOM on mobile). Use native src + Range.
    if (el.tagName === "VIDEO") {
      try {
        if (el.src && el.src.startsWith("blob:")) {
          try {
            URL.revokeObjectURL(el.src);
          } catch (_) {}
        }
        el.src = authed;
        el.setAttribute("playsinline", "");
        el.setAttribute("webkit-playsinline", "");
        el.playsInline = true;
        if (typeof el.load === "function") el.load();
        return true;
      } catch (_) {
        return false;
      }
    }

    // Images: prefer direct URL with token (also works with Range-less GET)
    const t = token();
    if (!t) {
      el.src = url;
      return true;
    }
    try {
      el.src = authed;
      return true;
    } catch {
      try {
        const res = await fetch(url, { headers: { "X-LMW-Token": t } });
        if (!res.ok) return false;
        const blob = await res.blob();
        el.src = URL.createObjectURL(blob);
        return true;
      } catch (_) {
        return false;
      }
    }
  }

  function fitPosterSize(w, h, max) {
    w = w || 1;
    h = h || 1;
    const scale = Math.min(1, max / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
  }

  /** 从同站文件截静态首帧，写入 img（网格用，避免直接播动图） */
  async function freezeFileToImg(img, fileUrl, type) {
    const t = token();
    let blobUrl = fileUrl;
    let revoke = null;
    try {
      if (t) {
        const res = await fetch(fileUrl, { headers: { "X-LMW-Token": t } });
        if (!res.ok) return false;
        const blob = await res.blob();
        blobUrl = URL.createObjectURL(blob);
        revoke = blobUrl;
      }
      if (type === "gif") {
        await new Promise((resolve, reject) => {
          const im = new Image();
          im.onload = () => {
            try {
              const { w, h } = fitPosterSize(im.naturalWidth, im.naturalHeight, 400);
              const c = document.createElement("canvas");
              c.width = w;
              c.height = h;
              c.getContext("2d").drawImage(im, 0, 0, w, h);
              c.toBlob(
                (b) => {
                  if (!b) return reject(new Error("toBlob"));
                  img.src = URL.createObjectURL(b);
                  resolve();
                },
                "image/jpeg",
                0.82
              );
            } catch (e) {
              reject(e);
            }
          };
          im.onerror = () => reject(new Error("img"));
          im.src = blobUrl;
        });
        return true;
      }
      // video / m3u8
      await new Promise((resolve, reject) => {
        const v = document.createElement("video");
        v.muted = true;
        v.preload = "auto";
        v.playsInline = true;
        let done = false;
        const fin = (ok) => {
          if (done) return;
          done = true;
          try {
            v.pause();
            v.removeAttribute("src");
            v.load();
          } catch (_) {}
          ok ? resolve() : reject(new Error("video frame"));
        };
        const paint = () => {
          try {
            if (!v.videoWidth) return fin(false);
            const { w, h } = fitPosterSize(v.videoWidth, v.videoHeight, 400);
            const c = document.createElement("canvas");
            c.width = w;
            c.height = h;
            c.getContext("2d").drawImage(v, 0, 0, w, h);
            c.toBlob(
              (b) => {
                if (!b) return fin(false);
                img.src = URL.createObjectURL(b);
                fin(true);
              },
              "image/jpeg",
              0.82
            );
          } catch (_) {
            fin(false);
          }
        };
        v.addEventListener("loadeddata", () => {
          try {
            v.currentTime = Math.min(0.15, Math.max(0.05, (v.duration || 1) * 0.02));
          } catch (_) {
            paint();
          }
        });
        v.addEventListener("seeked", paint);
        v.addEventListener("error", () => fin(false));
        v.src = blobUrl;
        setTimeout(() => fin(false), 20000);
      });
      return true;
    } catch (_) {
      return false;
    } finally {
      if (revoke) {
        try {
          URL.revokeObjectURL(revoke);
        } catch (_) {}
      }
    }
  }

  async function loadGridStaticThumb(img) {
    const thumb = img.dataset.thumb || "";
    const file = img.dataset.file || "";
    const type = img.dataset.type || "";
    // 1) 服务端静态 jpg 缩略图
    if (thumb) {
      const ok = await loadMediaEl(img, thumb);
      if (ok) {
        // 等一下解码，确认有像素
        await new Promise((r) => {
          if (img.complete && img.naturalWidth) return r();
          img.onload = () => r();
          img.onerror = () => r();
          setTimeout(r, 4000);
        });
        if (img.naturalWidth > 0) return;
      }
    }
    // 2) 无缩略图时从原文件截首帧（动图/视频）
    if (file && isGridMotionType(type)) {
      const frozen = await freezeFileToImg(img, file, type);
      if (frozen) return;
    }
    // 3) 静态图：直接文件
    if (file && type === "image") await loadMediaEl(img, file);
  }

  /** 网格：动图/视频默认只显示静态缩略图，悬停片刻后再预览，且同时只播一个 */
  const GRID_HOVER_MS = 380;
  let gridHoverTimer = null;
  let gridActiveCell = null;

  function isGridMotionType(t) {
    return t === "gif" || t === "video" || t === "m3u8" || t === "dash";
  }

  function stopGridPreview(cell) {
    if (!cell) return;
    cell.classList.remove("is-previewing");
    cell.querySelectorAll(".cell-motion").forEach((el) => {
      if (el.tagName === "VIDEO") {
        try {
          el.pause();
          el.removeAttribute("src");
          el.load();
        } catch (_) {}
      }
      if (el.src && String(el.src).startsWith("blob:")) {
        try {
          URL.revokeObjectURL(el.src);
        } catch (_) {}
      }
      el.remove();
    });
    if (gridActiveCell === cell) gridActiveCell = null;
  }

  function stopAllGridPreviews() {
    if (gridHoverTimer) {
      clearTimeout(gridHoverTimer);
      gridHoverTimer = null;
    }
    document.querySelectorAll(".grid .cell.is-previewing").forEach(stopGridPreview);
    gridActiveCell = null;
  }

  async function startGridPreview(cell) {
    const thumb = cell.querySelector("img.cell-thumb");
    if (!thumb) return;
    const type = thumb.dataset.type || "";
    const file = thumb.dataset.file || "";
    if (!file || !isGridMotionType(type)) return;

    if (gridActiveCell && gridActiveCell !== cell) stopGridPreview(gridActiveCell);
    gridActiveCell = cell;
    // 已在播则跳过
    if (cell.querySelector(".cell-motion")) {
      cell.classList.add("is-previewing");
      return;
    }

    cell.classList.add("is-previewing");
    if (type === "gif") {
      const anim = document.createElement("img");
      anim.className = "cell-motion";
      anim.alt = "";
      anim.draggable = false;
      cell.insertBefore(anim, thumb.nextSibling);
      await loadMediaEl(anim, file);
      return;
    }

    const v = document.createElement("video");
    v.className = "cell-motion";
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.setAttribute("webkit-playsinline", "");
    v.preload = "metadata";
    cell.insertBefore(v, thumb.nextSibling);
    await loadMediaEl(v, file);
    try {
      await v.play();
    } catch (_) {}
  }

  function bindGridHoverPreview(cell) {
    const thumb = cell.querySelector("img.cell-thumb");
    if (!thumb || !isGridMotionType(thumb.dataset.type || "")) return;
    cell.classList.add("cell-motion-ready");

    cell.addEventListener("pointerenter", (e) => {
      // 触屏不悬停预览，避免误触；点开灯箱再看
      if (e.pointerType === "touch") return;
      if (gridHoverTimer) clearTimeout(gridHoverTimer);
      gridHoverTimer = setTimeout(() => {
        gridHoverTimer = null;
        startGridPreview(cell);
      }, GRID_HOVER_MS);
    });
    cell.addEventListener("pointerleave", () => {
      if (gridHoverTimer) {
        clearTimeout(gridHoverTimer);
        gridHoverTimer = null;
      }
      stopGridPreview(cell);
    });
  }

  function renderGrid() {
    const grid = $("#grid");
    if (!grid) return;
    stopAllGridPreviews();
    grid.innerHTML = state.items
      .map((item) => {
        const motion = isGridMotionType(item.media_type) ? " cell-has-motion" : "";
        const tip = isGridMotionType(item.media_type) ? "悬停预览 · 单击打开" : "单击打开";
        return `<div class="cell${motion}" data-id="${item.id}" title="${tip}">
          <img class="cell-thumb" alt="" data-thumb="${thumbUrl(item)}" data-file="${fileUrl(item)}" data-type="${item.media_type}" />
          ${isGridMotionType(item.media_type) ? `<span class="cell-play-hint" aria-hidden="true">▶</span>` : ""}
          <span class="tag">${escapeHtml(item.media_type)}${item.liked ? " · ♥" : ""}${item.partial ? " · partial" : ""}</span>
          <button type="button" class="cell-del" data-del="${item.id}" title="删除">${ICO.x}</button>
        </div>`;
      })
      .join("");
    grid.querySelectorAll("img.cell-thumb").forEach((img) => {
      // 静态首帧：优先服务端 thumb；否则截取原文件首帧（不直接播动图）
      loadGridStaticThumb(img);
    });
    grid.querySelectorAll(".cell").forEach((cell) => {
      bindGridHoverPreview(cell);
      cell.addEventListener("click", (e) => {
        if (e.target.closest("[data-del]")) return;
        const img = cell.querySelector("img.cell-thumb");
        if (!img) return;
        stopAllGridPreviews();
        openLightbox(img.dataset.type, img.dataset.file);
      });
    });
    grid.querySelectorAll("[data-del]").forEach((b) => {
      b.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = Number(b.dataset.del);
        if (!confirm(`删除 #${id}？`)) return;
        await api(`/api/media/${id}`, { method: "DELETE" });
        state.items = state.items.filter((x) => x.id !== id);
        renderFeed();
        renderGrid();
      });
    });
  }

  function openLightbox(type, url) {
    const lb = $("#lightbox");
    const body = $("#lbBody");
    body.innerHTML = "";
    const el =
      type === "image" || type === "gif"
        ? document.createElement("img")
        : document.createElement("video");
    if (el.tagName === "VIDEO") {
      el.controls = true;
      el.autoplay = true;
      el.playsInline = true;
      // 灯箱：跟随全局出声偏好；默认仍静音，用户可点控件或 Feed 喇叭开声
      applySoundToVideo(el);
      el.addEventListener(
        "play",
        () => {
          applySoundToVideo(el);
        },
        { once: true }
      );
    }
    el.draggable = false;
    loadMediaEl(el, url).then(() => {
      if (el.tagName === "VIDEO") {
        applySoundToVideo(el);
        el.play().catch(() => {});
      }
    });
    body.appendChild(el);
    lb.classList.remove("hide");
    lb.setAttribute("aria-hidden", "false");
  }

  function closeLightbox() {
    const lb = $("#lightbox");
    const body = $("#lbBody");
    const video = body.querySelector("video");
    if (video) {
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch (_) {}
    }
    body.innerHTML = "";
    lb.classList.add("hide");
    lb.setAttribute("aria-hidden", "true");
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function setView(name) {
    clearChromeHidden();
    stopAllGridPreviews();
    state.view = name;
    document.querySelectorAll(".topnav .nav").forEach((b) => {
      b.classList.toggle("active", b.dataset.view === name);
    });
    ["feed", "grid", "admin"].forEach((v) => {
      $(`#view-${v}`).classList.toggle("hide", v !== name);
    });
    if (name === "admin") refreshAdmin();
  }

  async function refreshAdminMedia() {
    try {
      const data = await api("/api/media?limit=100&sort=new");
      const items = data.items || [];
      $("#adminMedia").innerHTML =
        items
          .map(
            (m) => `<div class="admin-media-row">
            <label class="admin-check"><input type="checkbox" data-mid="${m.id}" /></label>
            <img class="admin-thumb" data-src="${m.thumb_url}" alt="" />
            <div class="admin-media-meta">
              <div><strong>#${m.id}</strong> · ${escapeHtml(m.media_type)}${m.liked ? " · ♥" : ""}</div>
              <div class="muted">${escapeHtml(m.title || m.source_url || "")}</div>
              <div class="muted">${(m.tags || []).map((t) => "#" + escapeHtml(t)).join(" ") || "无标签"} · ${ICO.eye} ${m.view_count || 0}</div>
            </div>
            <button type="button" class="danger" data-adel="${m.id}">${ICO.trash} 删除</button>
          </div>`
          )
          .join("") || "<div class='muted'>暂无媒体</div>";
      $("#adminMedia").querySelectorAll(".admin-thumb").forEach((img) => {
        loadMediaEl(img, img.dataset.src);
      });
      $("#adminMedia").querySelectorAll("[data-adel]").forEach((b) => {
        b.onclick = async () => {
          const id = Number(b.dataset.adel);
          if (!confirm(`确定删除媒体 #${id}？不可恢复。`)) return;
          await api(`/api/media/${id}`, { method: "DELETE" });
          await refreshAdminMedia();
          await loadFeed();
        };
      });
    } catch (e) {
      $("#adminMedia").textContent = String(e);
    }
  }

  async function refreshAdmin() {
    try {
      const h = await fetch("/api/health").then((r) => r.json());
      $("#healthBox").textContent = JSON.stringify(h, null, 2);
    } catch (e) {
      $("#healthBox").textContent = String(e);
    }
    $("#tokenInput").value = token();
    await refreshAdminMedia();
    try {
      const jobs = await api("/api/jobs?limit=40");
      $("#jobs").innerHTML =
        (jobs.items || [])
          .map((j) => {
            const st = j.status;
            return `<div class="job">
            <div><span class="st ${st}">${st}</span> #${j.id} · ${escapeHtml(j.media_type)}${(j.tags || []).length ? " · " + j.tags.map((t) => "#" + escapeHtml(t)).join(" ") : ""}</div>
            <div class="muted">${escapeHtml(j.title || j.url)}</div>
            <div>${j.segments_total ? `分片 ${j.segments_done}/${j.segments_total} · ` : ""}${j.progress?.toFixed?.(0) || 0}%</div>
            <div style="color:var(--danger)">${escapeHtml(j.error_message || "")}</div>
            <div class="row">
              <button type="button" class="btn ghost" data-retry="${j.id}">重试</button>
              <button type="button" class="btn ghost" data-cancel="${j.id}">取消</button>
            </div>
          </div>`;
          })
          .join("") || "<div class='muted'>暂无任务</div>";
      $("#jobs").querySelectorAll("[data-retry]").forEach((b) => {
        b.onclick = async () => {
          await api(`/api/jobs/${b.dataset.retry}/retry`, { method: "POST" });
          refreshAdmin();
        };
      });
      $("#jobs").querySelectorAll("[data-cancel]").forEach((b) => {
        b.onclick = async () => {
          await api(`/api/jobs/${b.dataset.cancel}/cancel`, { method: "POST" });
          refreshAdmin();
        };
      });
    } catch (e) {
      $("#jobs").textContent = String(e);
    }
  }

  function bind() {
    document.querySelectorAll(".topnav .nav").forEach((b) => {
      b.addEventListener("click", () => setView(b.dataset.view));
    });
    const btnSimilar = $("#btnSimilar");
    if (btnSimilar) {
      btnSimilar.addEventListener("click", () => toggleSimilarOrRandom());
    }
    syncSimilarBtn();
    const modeSel = $("#feedMode");
    if (modeSel) {
      if (![...modeSel.options].some((o) => o.value === "similar")) {
        const opt = document.createElement("option");
        opt.value = "similar";
        opt.textContent = "相似";
        modeSel.appendChild(opt);
      }
      modeSel.value = state.mode === "similar" ? "similar" : state.mode;
      modeSel.addEventListener("change", async (e) => {
        state.mode = e.target.value;
        if (state.mode !== "similar") state.similarTo = null;
        localStorage.setItem(feedModeKey, state.mode);
        syncSimilarBtn();
        if (state.mode === "similar" && !state.similarTo) {
          await loadSimilarFromCurrent();
          return;
        }
        await loadFeed();
      });
    }
    $("#btnSaveToken").onclick = () => {
      localStorage.setItem(tokenKey, $("#tokenInput").value.trim());
      alert("已保存");
    };
    $("#btnRescan").onclick = async () => {
      const r = await api("/api/rescan", { method: "POST" });
      alert(`扫描完成\n新增 ${r.added ?? 0} · 跳过 ${r.skipped ?? 0}`);
      await loadFeed();
      await refreshAdminMedia();
    };
    const btnRefreshLib = $("#btnRefreshLibrary");
    if (btnRefreshLib) {
      btnRefreshLib.onclick = async () => {
        if (!confirm("强制刷新媒体库？\n将剔除磁盘已删除的无效索引，并重新扫描 Medias。")) return;
        try {
          btnRefreshLib.disabled = true;
          const r = await api("/api/refresh-library", { method: "POST" });
          alert(
            `强制刷新完成\n` +
              `清理无效 ${r.purged ?? 0} · 修正大小 ${r.fixed_size ?? 0} · 孤儿缩略图 ${r.orphan_thumbs ?? 0}\n` +
              `新扫描入库 ${r.added ?? 0} · 跳过 ${r.skipped ?? 0}`
          );
          await loadFeed();
          await refreshAdminMedia();
        } catch (e) {
          alert("强制刷新失败: " + e.message);
        } finally {
          btnRefreshLib.disabled = false;
        }
      };
    }
    $("#btnRefreshJobs").onclick = () => refreshAdmin();
    $("#btnRefreshMedia").onclick = () => refreshAdminMedia();
    const btnBatchTags = $("#btnBatchTags");
    if (btnBatchTags) {
      btnBatchTags.onclick = async () => {
        const ids = [...document.querySelectorAll("#adminMedia input[data-mid]:checked")].map((el) =>
          Number(el.dataset.mid)
        );
        if (!ids.length) {
          alert("请先勾选媒体");
          return;
        }
        const raw = ($("#batchTagsInput") && $("#batchTagsInput").value) || "";
        const tags = raw
          .split(/[,，;；\s]+/)
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 5);
        if (!tags.length) {
          alert("请输入至少一个标签");
          return;
        }
        try {
          const r = await api("/api/media/tags/batch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids, tags, mode: "merge" }),
          });
          showToast(`已更新 ${r.updated || 0} 项标签`);
          await refreshAdminMedia();
          await loadFeed({ quiet: true });
        } catch (e) {
          alert("打标签失败: " + e.message);
        }
      };
    }
    $("#lbClose").onclick = (e) => {
      e.stopPropagation();
      closeLightbox();
    };
    $("#lightbox").addEventListener("click", (e) => {
      // 点遮罩空白或提示关闭
      if (e.target.id === "lightbox" || e.target.classList.contains("lb-hint")) {
        closeLightbox();
      }
    });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (!$("#lightbox").classList.contains("hide")) {
          closeLightbox();
          return;
        }
        // Esc 退出沉浸（恢复顶栏/HUD）
        if (isChromeHidden()) {
          clearChromeHidden();
          return;
        }
      }
      if (state.view !== "feed") return;
      const sc = $("#feedScroller");
      if (e.key === "ArrowDown") sc.scrollBy({ top: window.innerHeight, behavior: "smooth" });
      if (e.key === "ArrowUp") sc.scrollBy({ top: -window.innerHeight, behavior: "smooth" });
      if (e.key === "l" || e.key === "L") {
        const it = currentItem();
        if (it) handleAction("like", it.id, document.querySelector(`.snap-slide[data-id="${it.id}"] .like`));
      }
      if (e.key === "m" || e.key === "M") {
        const it = currentItem();
        if (it) handleAction("mute", it.id, document.querySelector(`.snap-slide[data-id="${it.id}"] [data-act='mute']`));
      }
      if (e.key === "h" || e.key === "H") {
        // 快捷键：隐藏/恢复界面
        setChromeHidden(!isChromeHidden());
      }
    });
  }

  bind();
  loadFeed()
    .then(() => startLibraryPoll())
    .catch((e) => {
      const empty = $("#feedEmpty");
      empty.classList.remove("hide");
      empty.innerHTML = `<div class="empty-card"><p>加载失败</p><p class="muted">${escapeHtml(e.message)}</p></div>`;
    });
})();
