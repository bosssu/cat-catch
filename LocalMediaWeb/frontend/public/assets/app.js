(() => {
  const tokenKey = "lmw_token";
  const feedModeKey = "lmw_feed_mode";
  /** session: once user unmutes, keep sound on for later videos in this tab */
  const soundKey = "lmw_want_sound";
  const state = {
    view: "feed",
    mode: localStorage.getItem(feedModeKey) || "random",
    similarTo: null,
    /** when mode=similar and set, rank by this tag (not whole media) */
    similarTag: null,
    items: [],
    feedIndex: 0,
    dwellStart: 0,
    viewedIds: new Set(),
    /** library fingerprint: total:newestId — used for auto-refresh after server downloads */
    libFp: "",
    libPollTimer: null,
    libRefreshing: false,
    /** tail prefetch in flight */
    feedPrefetching: false,
    /** true when library grew; next prefetch will pull new items */
    libDirty: false,
    /** first load muted; becomes true after user unmutes */
    wantSound: sessionStorage.getItem(soundKey) === "1",
    /** currently active feed slide id (string); exclusivity for video audio */
    activeFeedId: null,
    /** monotinic token so stale play/load races abort */
    playEpoch: 0,
  };

  const ICO = {
    heart: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`,
    skip: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>`,
    trash: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`,
    eye: `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8a3 3 0 100 6 3 3 0 000-6z"/></svg>`,
    x: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.3 5.71L12 12l6.3 6.29-1.41 1.42L10.59 13.4 4.3 19.71 2.89 18.3 9.17 12 2.89 5.71 4.3 4.29l6.29 6.3 6.29-6.3z"/></svg>`,
    volOn: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>`,
    volOff: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 003.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>`,
    /** center overlay: pause while playing */
    pause: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 5h4v14H6V5zm8 0h4v14h-4V5z"/></svg>`,
    /** center overlay: play while paused */
    play: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 5v14l11-7L8 5z"/></svg>`,
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
    // drop visible progress / center play when entering immersive
    if (on) {
      document.querySelectorAll(".feed-progress.is-visible").forEach((el) => {
        el.classList.remove("is-visible");
      });
      document.querySelectorAll(".media-play-toggle.is-visible").forEach((el) => {
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

  function feedModeSelects() {
    return [$("#feedModeNav"), $("#feedMode")].filter(Boolean);
  }

  function syncFeedModeSelects() {
    const v = state.mode || "random";
    for (const sel of feedModeSelects()) {
      if ([...sel.options].some((o) => o.value === v)) {
        sel.value = v;
      }
    }
  }

  function playlistIds() {
    return state.items.map((x) => x.id).filter((id) => id != null);
  }

  /**
   * Fetch a ranked batch. exclude playlist so next-decision never repeats
   * what's already on screen (history + current + queued tail).
   */
  async function fetchFeedBatch({ limit = 24, exclude = null, includeSeed = true } = {}) {
    const q = new URLSearchParams({
      mode: state.mode || "random",
      limit: String(limit),
    });
    if (state.mode === "similar") {
      if (state.similarTag) {
        q.set("tag", String(state.similarTag));
      }
      if (state.similarTo && !state.similarTag) {
        q.set("similar_to", String(state.similarTo));
        q.set("include_seed", includeSeed ? "true" : "false");
      }
    }
    const ex = exclude != null ? exclude : playlistIds();
    if (ex.length) q.set("exclude_ids", ex.join(","));
    const data = await api(`/api/feed?${q}`);
    return data.items || [];
  }

  /**
   * Hard rebuild of the whole feed (first load / delete / admin rescan).
   * Prefer softModeSwitch + ensureFeedAhead for mode / library changes.
   */
  async function loadFeed(opts = {}) {
    const keepId = opts.keepCurrentId;
    const quiet = !!opts.quiet;
    if (!quiet) clearChromeHidden();
    const items = await fetchFeedBatch({
      limit: 40,
      exclude: keepId != null ? [keepId] : [],
      includeSeed: true,
    });
    // When keeping current, put it first then append ranked others
    if (keepId != null) {
      const cur =
        state.items.find((x) => x.id === keepId) ||
        items.find((x) => x.id === keepId);
      const rest = items.filter((x) => x.id !== keepId);
      if (cur) {
        state.items = [cur, ...rest];
      } else {
        state.items = items;
      }
    } else {
      state.items = items;
    }
    state.viewedIds = new Set();
    state.feedIndex = 0;
    if (keepId != null) {
      const idx = state.items.findIndex((x) => x.id === keepId);
      if (idx >= 0) state.feedIndex = idx;
    }
    renderFeed();
    renderGrid();
    if (keepId != null) {
      requestAnimationFrame(() => {
        const slide = document.querySelector(`.snap-slide[data-id="${keepId}"]`);
        if (slide) slide.scrollIntoView({ block: "nearest", behavior: "auto" });
      });
    }
    state.libDirty = false;
  }

  function _removeSlideEl(el) {
    if (!el) return;
    try {
      state._feedIo?.unobserve(el);
    } catch (_) {}
    const v = el.querySelector("video");
    if (v) silenceFeedVideo(v, { unload: true });
    el.remove();
  }

  /** Drop queued slides after the current one (DOM + state). Keeps playing item. */
  function trimFeedTail() {
    const keep = Math.max(0, (state.feedIndex | 0) + 1);
    if (state.items.length <= keep) return;
    state.items = state.items.slice(0, keep);
    const scroller = $("#feedScroller");
    if (!scroller) return;
    scroller.querySelectorAll(".snap-slide").forEach((el) => {
      const i = Number(el.dataset.index);
      if (i >= keep) _removeSlideEl(el);
    });
  }

  /**
   * For ordered modes (recent / liked): drop history above current so the
   * next batch is true global order, not "whatever is left after a long random run".
   * Does not remount the current slide (playback continues).
   */
  function keepOnlyCurrentSlide() {
    const cur = currentItem();
    if (!cur) {
      trimFeedTail();
      return;
    }
    const scroller = $("#feedScroller");
    const curEl = scroller && scroller.querySelector(`.snap-slide[data-id="${cur.id}"]`);
    state.items = [cur];
    state.feedIndex = 0;
    if (!scroller || !curEl) {
      renderFeed();
      return;
    }
    scroller.querySelectorAll(".snap-slide").forEach((el) => {
      if (el !== curEl) _removeSlideEl(el);
    });
    curEl.dataset.index = "0";
  }

  function slideHtml(item, i) {
    const liked = item.liked ? "on" : "";
    const isImg = item.media_type === "image" || item.media_type === "gif";
    const muteAttr = state.wantSound ? "" : " muted";
    const poster = !isImg && item.thumb_url ? ` poster="${thumbUrl(item)}"` : "";
    const media = isImg
      ? `<img data-src="${fileUrl(item)}" alt="" draggable="false" />`
      : `<video data-src="${fileUrl(item)}"${poster} playsinline webkit-playsinline${muteAttr} loop preload="metadata"></video>
          <button type="button" class="media-play-toggle" aria-label="暂停" title="暂停/播放" tabindex="-1">${ICO.pause}</button>
          <div class="feed-progress" aria-hidden="true">
            <div class="feed-progress-track">
              <div class="feed-progress-fill"></div>
              <div class="feed-progress-knob"></div>
            </div>
            <div class="feed-progress-time"><span class="cur">0:00</span><span class="sep">/</span><span class="dur">0:00</span></div>
          </div>`;
    return `<section class="snap-slide" data-index="${i}" data-id="${item.id}">
          <div class="media-stage" title="单击显示进度 · 双击隐藏/恢复界面">${media}</div>
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
  }

  function bindSlideEl(el, { observe = true } = {}) {
    if (!el) return;
    el.querySelectorAll("[data-act]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        handleAction(btn.dataset.act, Number(btn.dataset.id), btn);
      });
    });
    el.querySelectorAll("button.chip.tag[data-tag]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        loadSimilarFromTag(btn.dataset.tag);
      });
    });
    const stage = el.querySelector(".media-stage");
    if (stage) {
      bindImmersiveToggle(stage);
      bindFeedProgress(stage);
    }
    el.querySelectorAll("video").forEach(applySoundToVideo);
    el.querySelectorAll("[data-act='mute']").forEach(syncMuteBtn);
    if (observe) {
      try {
        state._feedIo?.observe(el);
      } catch (_) {}
    }
  }

  /** Append ranked items without rebuilding the current slide (no playback interrupt). */
  function appendFeedItems(items) {
    if (!items || !items.length) return 0;
    const scroller = $("#feedScroller");
    const empty = $("#feedEmpty");
    if (!scroller) return 0;
    const have = new Set(playlistIds());
    const add = items.filter((x) => x && x.id != null && !have.has(x.id));
    if (!add.length) return 0;
    if (empty) empty.classList.add("hide");
    const start = state.items.length;
    state.items.push(...add);
    const frag = document.createDocumentFragment();
    const tmp = document.createElement("div");
    for (let j = 0; j < add.length; j++) {
      tmp.innerHTML = slideHtml(add[j], start + j);
      const el = tmp.firstElementChild;
      if (el) frag.appendChild(el);
    }
    scroller.appendChild(frag);
    for (let j = 0; j < add.length; j++) {
      const el = scroller.querySelector(`.snap-slide[data-index="${start + j}"]`);
      bindSlideEl(el);
    }
    return add.length;
  }

  /**
   * Ensure enough slides after the current one, ranked by active mode
   * (instant next-decision; does not touch earlier history).
   */
  async function ensureFeedAhead(minAhead = 8) {
    if (state.feedPrefetching) return;
    const ahead = state.items.length - (state.feedIndex | 0) - 1;
    if (ahead >= minAhead && !state.libDirty) return;
    state.feedPrefetching = true;
    try {
      const need = Math.max(12, minAhead - Math.max(0, ahead) + 4);
      const batch = await fetchFeedBatch({
        limit: need,
        exclude: playlistIds(),
        includeSeed: false,
      });
      appendFeedItems(batch);
      state.libDirty = false;
    } catch (e) {
      console.debug("ensureFeedAhead", e);
    } finally {
      state.feedPrefetching = false;
    }
  }

  /**
   * Switch mode without rebuilding the playing slide:
   * keep history + current (or only current for ordered modes),
   * discard old-mode queue, prefetch new-mode tail.
   */
  async function softModeSwitch(mode, { toast, clearSimilar = true } = {}) {
    const next = mode || "random";
    state.mode = next;
    if (next !== "similar" && clearSimilar) {
      state.similarTo = null;
      state.similarTag = null;
    }
    localStorage.setItem(feedModeKey, next);
    syncFeedModeSelects();

    // Empty library / first open — hard load
    if (!state.items.length) {
      await loadFeed({ quiet: true });
      if (toast) showToast(toast);
      return;
    }

    // recent/liked need a clean stream or "next" is polluted by long random history
    if (next === "recent" || next === "liked") {
      keepOnlyCurrentSlide();
    } else {
      trimFeedTail();
    }
    await ensureFeedAhead(12);
    if (toast) showToast(toast);
  }

  async function loadSimilarFromCurrent() {
    const it = currentItem();
    if (!it) {
      showToast("暂无当前媒体，已切回随机");
      await softModeSwitch("random");
      return;
    }
    const tags = it.tags || [];
    if (!tags.length) {
      showToast("当前媒体无标签，已切回随机");
      await softModeSwitch("random");
      return;
    }
    state.similarTo = it.id;
    state.similarTag = null;
    await softModeSwitch("similar", {
      toast: `相似推荐 · 基于 #${it.id} · ${tags.join(", ")}（下一条起生效）`,
      clearSimilar: false,
    });
    if (state.view !== "feed") setView("feed");
  }

  /** Click a #tag chip → similar mode ranked by that tag only. */
  async function loadSimilarFromTag(tag) {
    const t = String(tag || "")
      .trim()
      .toLowerCase()
      .replace(/^#/, "");
    if (!t) return;
    state.similarTag = t;
    state.similarTo = null;
    await softModeSwitch("similar", {
      toast: `相似推荐 · 标签 #${t}（下一条起生效）`,
      clearSimilar: false,
    });
    if (state.view !== "feed") setView("feed");
  }

  async function applyFeedMode(mode) {
    const next = mode || "random";
    if (next === "similar") {
      // dropdown "相似": media-based if no active tag focus
      if (state.similarTag) {
        await softModeSwitch("similar", {
          toast: `相似推荐 · 标签 #${state.similarTag}（下一条起生效）`,
          clearSimilar: false,
        });
        return;
      }
      await loadSimilarFromCurrent();
      return;
    }
    const labels = {
      random: "随机",
      recommend: "推荐",
      recent: "最新",
      liked: "已喜欢",
    };
    await softModeSwitch(next, {
      toast: `${labels[next] || next} · 下一条起生效`,
    });
  }

  /**
   * Library grew/shrank: do NOT rebuild Feed (keeps current playback).
   * Mark dirty so the next ensureFeedAhead can pull new items.
   */
  async function pollLibraryChange() {
    if (document.hidden || state.libRefreshing) return;
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
      state.libDirty = true;
      state.libRefreshing = true;
      try {
        // Feed: only top-up the tail under current mode (no full re-render)
        if (state.view === "feed" && state.items.length) {
          await ensureFeedAhead(10);
        } else if (state.view === "grid") {
          await renderGridQuiet();
        }
        if (state.view === "admin") {
          await refreshAdmin().catch(() => {});
        }
        showToast(`库已更新 · ${total} 项 · 下一条可刷到新内容`);
      } finally {
        state.libRefreshing = false;
      }
    } catch (e) {
      console.debug("lib poll", e);
    }
  }

  async function renderGridQuiet() {
    try {
      const data = await api("/api/media?limit=200&sort=new");
      state._gridCache = data.items || [];
      renderGrid(state._gridCache);
    } catch (_) {
      try {
        renderGrid();
      } catch (__) {}
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
    // Decision for upcoming items is live — top up when near the end
    const ahead = state.items.length - index - 1;
    if (ahead < 6 || state.libDirty) {
      ensureFeedAhead(10);
    }
  }

  function typeChip(item) {
    const partial = item.partial ? `<span class="chip warn">不完整</span>` : "";
    const tags = (item.tags || [])
      .map((t) => {
        const active = state.mode === "similar" && state.similarTag === t ? " is-active" : "";
        return `<button type="button" class="chip tag${active}" data-tag="${escapeHtml(t)}" title="按标签 #${escapeHtml(t)} 相似推荐">#${escapeHtml(t)}</button>`;
      })
      .join("");
    return `<span class="chip">${escapeHtml(item.media_type)}</span>
      <span class="chip">#${item.id}</span>${tags}${partial}`;
  }

  function renderFeed() {
    const scroller = $("#feedScroller");
    const empty = $("#feedEmpty");
    state.activeFeedId = null;
    state.playEpoch += 1;
    if (!state.items.length) {
      scroller.innerHTML = "";
      empty.classList.remove("hide");
      return;
    }
    empty.classList.add("hide");
    scroller.innerHTML = state.items.map((item, i) => slideHtml(item, i)).join("");

    scroller.querySelectorAll(".snap-slide").forEach((el) => bindSlideEl(el, { observe: false }));
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
   * Short-video style progress + center play/pause:
   * tap stage → show bar & center button (no pause);
   * tap center button → pause / resume;
   * auto-hide after idle (while paused, keep center button for resume).
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
    let toggleBtn = stage.querySelector(".media-play-toggle");
    if (!toggleBtn) {
      toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.className = "media-play-toggle";
      toggleBtn.setAttribute("aria-label", "暂停");
      toggleBtn.title = "暂停/播放";
      toggleBtn.tabIndex = -1;
      toggleBtn.innerHTML = ICO.pause;
      stage.insertBefore(toggleBtn, bar);
    }

    let hideTimer = null;
    let seeking = false;
    const HIDE_MS = 2800;

    const syncToggleIcon = () => {
      const paused = video.paused;
      toggleBtn.innerHTML = paused ? ICO.play : ICO.pause;
      toggleBtn.setAttribute("aria-label", paused ? "播放" : "暂停");
      toggleBtn.classList.toggle("is-paused", paused);
    };

    const isUserPaused = () => video.dataset.userPaused === "1";

    const hideChrome = () => {
      bar.classList.remove("is-visible");
      // only keep center control after *user* pause (not scroll/autoplay pause)
      if (video.paused && isUserPaused()) {
        toggleBtn.classList.add("is-visible");
      } else {
        toggleBtn.classList.remove("is-visible");
      }
    };

    const showChrome = () => {
      if (isChromeHidden()) return;
      bar.classList.add("is-visible");
      toggleBtn.classList.add("is-visible");
      syncToggleIcon();
      clearTimeout(hideTimer);
      if (!seeking) {
        hideTimer = setTimeout(() => {
          if (!seeking) hideChrome();
        }, HIDE_MS);
      }
    };

    const hideBarSoon = () => {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (!seeking) hideChrome();
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
      syncToggleIcon();
      // autoplay / resume: never leave center button open unless user opened the bar
      if (bar.classList.contains("is-visible")) {
        hideBarSoon();
      } else {
        toggleBtn.classList.remove("is-visible");
      }
    });
    video.addEventListener("pause", () => {
      syncToggleIcon();
      // programmatic pause (slide leave / load) must NOT flash the control
      if (!isChromeHidden() && isUserPaused()) {
        toggleBtn.classList.add("is-visible");
      } else {
        toggleBtn.classList.remove("is-visible");
      }
    });

    // Only clicks that hit the video's drawn box (not letterbox / empty stage)
    // show progress + center control; do NOT toggle play on stage tap.
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
      if (e.target.closest(".media-play-toggle")) return;
      if (e.target.closest(".hud")) return;
      if (Date.now() < (stage._uiCooldownUntil || 0)) return;
      if (!pointHitsVideo(e.clientX, e.clientY)) return;
      if (tapTimer) clearTimeout(tapTimer);
      tapTimer = setTimeout(() => {
        tapTimer = null;
        // immersive: don't pop chrome when UI is hidden
        if (!isChromeHidden()) showChrome();
      }, 260);
    });
    stage.addEventListener("dblclick", () => {
      if (tapTimer) {
        clearTimeout(tapTimer);
        tapTimer = null;
      }
    });

    toggleBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (Date.now() < (stage._uiCooldownUntil || 0)) return;
      if (video.paused) {
        video.dataset.userPaused = "0";
        pauseOtherFeedVideos(video);
        const gen = bumpVideoPlayGen(video);
        playVideoRobust(video, gen).then(() => syncToggleIcon());
      } else {
        video.dataset.userPaused = "1";
        try {
          video.pause();
        } catch (_) {}
      }
      syncToggleIcon();
      if (!isChromeHidden()) showChrome();
    });
    toggleBtn.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
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
      showChrome();
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

    syncToggleIcon();
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
        if (slide.dataset.userPaused !== "1") {
          pauseOtherFeedVideos(slide);
          const gen = bumpVideoPlayGen(slide);
          playVideoRobust(slide, gen);
        }
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

  /** Invalidate in-flight play/load for this element. */
  function bumpVideoPlayGen(v) {
    if (!v) return 0;
    const n = (Number(v.dataset.playGen) || 0) + 1;
    v.dataset.playGen = String(n);
    return n;
  }

  function hideSlideVideoChrome(slideEl) {
    if (!slideEl) return;
    const tgl = slideEl.querySelector(".media-play-toggle");
    if (tgl) tgl.classList.remove("is-visible");
    const pbar = slideEl.querySelector(".feed-progress");
    if (pbar) pbar.classList.remove("is-visible");
  }

  /** Hard-stop a feed video (no chrome flash). Keeps buffer unless unload=true. */
  function silenceFeedVideo(v, { unload = false } = {}) {
    if (!v || v.tagName !== "VIDEO") return;
    bumpVideoPlayGen(v);
    v.dataset.userPaused = "0";
    try {
      v.pause();
    } catch (_) {}
    if (unload) {
      try {
        delete v.dataset.loadedSrc;
        v.removeAttribute("src");
        v.load?.();
      } catch (_) {}
    }
    hideSlideVideoChrome(v.closest(".snap-slide"));
  }

  /** Only one feed video may audibly play — pause every other. */
  function pauseOtherFeedVideos(except) {
    document.querySelectorAll("#feedScroller video").forEach((v) => {
      if (v === except) return;
      silenceFeedVideo(v);
    });
  }

  function mediaSrcLoaded(el, url) {
    if (!el || !url) return false;
    return el.dataset.loadedSrc === url;
  }

  /**
   * Wait until video has a decodable frame (or timeout).
   * readyState: 2=HAVE_CURRENT_DATA, 3=HAVE_FUTURE_DATA, 4=HAVE_ENOUGH_DATA
   */
  function waitVideoReady(video, timeoutMs = 10000) {
    if (!video) return Promise.resolve(false);
    if (video.readyState >= 2 && video.videoWidth > 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const fin = (ok) => {
        if (done) return;
        done = true;
        events.forEach((ev) => video.removeEventListener(ev, onReady));
        video.removeEventListener("error", onErr);
        clearTimeout(timer);
        resolve(ok);
      };
      const onReady = () => {
        if (video.readyState >= 2) fin(true);
      };
      const onErr = () => fin(false);
      const events = ["loadeddata", "canplay", "canplaythrough", "loadedmetadata"];
      events.forEach((ev) => video.addEventListener(ev, onReady));
      video.addEventListener("error", onErr);
      const timer = setTimeout(() => fin(video.readyState >= 2), timeoutMs);
      // already progressing
      onReady();
    });
  }

  async function playVideoRobust(media, gen) {
    if (!media || media.tagName !== "VIDEO") return false;
    const alive = () =>
      media.isConnected &&
      String(media.dataset.playGen || "0") === String(gen) &&
      media.dataset.userPaused !== "1";

    if (!alive()) return false;
    applySoundToVideo(media);

    const attempt = async () => {
      if (!alive()) return false;
      try {
        await media.play();
        return alive() && !media.paused;
      } catch (_) {
        return false;
      }
    };

    // 1) preferred (may fail unmuted on mobile autoplay policy)
    if (await attempt()) return true;
    if (!alive()) return false;

    // 2) not ready yet — wait then retry
    await waitVideoReady(media, 8000);
    if (!alive()) return false;
    if (await attempt()) return true;
    if (!alive()) return false;

    // 3) autoplay policy: force muted play, then try restore sound
    const want = state.wantSound;
    media.muted = true;
    if (await attempt()) {
      if (want && alive()) {
        try {
          media.muted = false;
          if (media.muted) applySoundToVideo(media); // still blocked — keep muted until gesture
        } catch (_) {}
      } else {
        applySoundToVideo(media);
      }
      return alive() && !media.paused;
    }
    if (!alive()) return false;

    // 4) last resort: reload same src once (Edge/mobile stuck decoder)
    const src = media.getAttribute("data-src") || media.dataset.loadedSrc;
    if (src && alive()) {
      try {
        delete media.dataset.loadedSrc;
        await loadMediaEl(media, src, { force: true });
        await waitVideoReady(media, 8000);
        if (!alive()) return false;
        media.muted = true;
        if (await attempt()) {
          if (want && alive()) {
            try {
              media.muted = false;
            } catch (_) {}
          }
          applySoundToVideo(media);
          return alive() && !media.paused;
        }
      } catch (_) {}
    }
    return false;
  }

  /**
   * Activate a feed slide: exclusive audio, load+wait+play for video,
   * prefetch next. Safe against IntersectionObserver races.
   */
  async function activateFeedSlide(slideEl) {
    if (!slideEl || !slideEl.isConnected) return;
    const id = String(slideEl.dataset.id || "");
    const index = Number(slideEl.dataset.index || 0);
    const media = slideEl.querySelector(".media-stage img, .media-stage video");
    if (!media) return;

    const epoch = ++state.playEpoch;
    state.activeFeedId = id;
    onSlideActive(index);

    if (media.tagName === "VIDEO") {
      // exclusive: stop every other video immediately (fixes "上一条声音")
      pauseOtherFeedVideos(media);

      if (media.dataset.userPaused === "1") return;

      const gen = bumpVideoPlayGen(media);
      media.preload = "auto";

      const src = media.getAttribute("data-src");
      if (src && !mediaSrcLoaded(media, src)) {
        const ok = await loadMediaEl(media, src);
        // only abort self; never silence if a newer activation owns this slide
        if (!ok || epoch !== state.playEpoch || state.activeFeedId !== id) return;
      }

      // stale activation (user already swiped away)
      if (epoch !== state.playEpoch || state.activeFeedId !== id) {
        if (state.activeFeedId !== id) silenceFeedVideo(media);
        return;
      }
      if (String(media.dataset.playGen) !== String(gen)) return;

      const played = await playVideoRobust(media, gen);
      if (epoch !== state.playEpoch || state.activeFeedId !== id) {
        if (state.activeFeedId !== id) silenceFeedVideo(media);
        return;
      }
      // black-frame recovery: playing but no pixels yet
      if (played && media.videoWidth === 0) {
        await new Promise((r) => setTimeout(r, 200));
        if (epoch === state.playEpoch && state.activeFeedId === id && media.videoWidth === 0) {
          const g2 = bumpVideoPlayGen(media);
          await playVideoRobust(media, g2);
        }
      }
    } else {
      // image
      pauseOtherFeedVideos(null);
      const src = media.getAttribute("data-src");
      if (src && !mediaSrcLoaded(media, src) && media.getAttribute("src") !== src) {
        await loadMediaEl(media, src);
      }
    }

    if (epoch === state.playEpoch) {
      prefetchFeedAround(index);
    }
  }

  /** Warm next/prev video buffers without playing. */
  function prefetchFeedAround(index) {
    const scroller = $("#feedScroller");
    if (!scroller) return;
    for (const j of [index + 1, index + 2, index - 1]) {
      if (j < 0) continue;
      const slide = scroller.querySelector(`.snap-slide[data-index="${j}"]`);
      if (!slide) continue;
      const v = slide.querySelector("video");
      if (!v) continue;
      const src = v.getAttribute("data-src");
      if (!src || mediaSrcLoaded(v, src)) {
        // already have data — ensure preload stays warm
        if (v.preload !== "auto") v.preload = "auto";
        continue;
      }
      v.preload = "auto";
      // fire-and-forget; never play
      loadMediaEl(v, src).catch(() => {});
    }
  }

  /**
   * Pick the slide closest to the scroller viewport center.
   * Fallback when IntersectionObserver misses threshold edges (Edge mobile).
   */
  function syncActiveFromScroll() {
    const scroller = $("#feedScroller");
    if (!scroller || state.view !== "feed") return;
    const slides = scroller.querySelectorAll(".snap-slide");
    if (!slides.length) return;
    const root = scroller.getBoundingClientRect();
    const mid = root.top + root.height * 0.5;
    let best = null;
    let bestDist = Infinity;
    slides.forEach((el) => {
      const r = el.getBoundingClientRect();
      const c = r.top + r.height * 0.5;
      const d = Math.abs(c - mid);
      if (d < bestDist) {
        bestDist = d;
        best = el;
      }
    });
    if (!best) return;
    // only switch when clearly centered (avoid mid-fling thrash)
    if (bestDist > root.height * 0.35) return;
    const id = String(best.dataset.id || "");
    const media = best.querySelector("video");
    const needsPlay =
      media &&
      media.dataset.userPaused !== "1" &&
      (media.paused || !mediaSrcLoaded(media, media.getAttribute("data-src") || ""));
    if (state.activeFeedId === id && !needsPlay) return;
    activateFeedSlide(best);
  }

  function bindFeedScrollSync() {
    const scroller = $("#feedScroller");
    if (!scroller || scroller.dataset.scrollSyncBound === "1") return;
    scroller.dataset.scrollSyncBound = "1";
    let t = null;
    scroller.addEventListener(
      "scroll",
      () => {
        clearTimeout(t);
        t = setTimeout(syncActiveFromScroll, 90);
      },
      { passive: true }
    );
    // iOS/Edge: snap settle
    scroller.addEventListener(
      "scrollend",
      () => {
        clearTimeout(t);
        syncActiveFromScroll();
      },
      { passive: true }
    );
  }

  function observeFeedMedia() {
    const slides = [...document.querySelectorAll(".snap-slide")];
    if (state._feedIo) {
      try {
        state._feedIo.disconnect();
      } catch (_) {}
    }
    bindFeedScrollSync();
    const io = new IntersectionObserver(
      (entries) => {
        // Prefer highest intersection ratio among newly-visible slides
        let bestEnter = null;
        let bestRatio = 0;
        for (const en of entries) {
          const el = en.target;
          const media = el.querySelector(".media-stage img, .media-stage video");
          if (!media) continue;
          if (en.isIntersecting && en.intersectionRatio >= 0.55) {
            if (en.intersectionRatio >= bestRatio) {
              bestRatio = en.intersectionRatio;
              bestEnter = el;
            }
          } else if (!en.isIntersecting || en.intersectionRatio < 0.35) {
            if (media.tagName === "VIDEO") {
              // only silence if this slide is no longer the active one
              if (String(el.dataset.id) !== String(state.activeFeedId)) {
                silenceFeedVideo(media);
              }
            }
          }
        }
        if (bestEnter) {
          activateFeedSlide(bestEnter);
        }
      },
      { root: $("#feedScroller"), threshold: [0, 0.25, 0.35, 0.55, 0.75, 1] }
    );
    state._feedIo = io;
    slides.forEach((s) => io.observe(s));
    // first paint: activate centered slide (F5 cold start)
    requestAnimationFrame(() => {
      syncActiveFromScroll();
      // if still nothing (empty layout), try first slide
      if (!state.activeFeedId) {
        const first = document.querySelector("#feedScroller .snap-slide");
        if (first) activateFeedSlide(first);
      }
    });
  }

  async function loadMediaEl(el, url, opts = {}) {
    if (!url) return false;
    const authed = withAuthQuery(url);
    const force = !!opts.force;

    // VIDEO: never fetch-as-blob (breaks Range / OOM on mobile). Use native src + Range.
    if (el.tagName === "VIDEO") {
      try {
        if (!force && mediaSrcLoaded(el, url) && el.readyState >= 2) {
          return true;
        }
        if (el.src && el.src.startsWith("blob:")) {
          try {
            URL.revokeObjectURL(el.src);
          } catch (_) {}
        }
        // Avoid redundant load() when same logical URL already set
        if (!force && mediaSrcLoaded(el, url) && el.getAttribute("src")) {
          return true;
        }
        el.setAttribute("playsinline", "");
        el.setAttribute("webkit-playsinline", "");
        el.playsInline = true;
        if (!el.getAttribute("preload") || el.preload === "none") {
          el.preload = "auto";
        }
        el.src = authed;
        el.dataset.loadedSrc = url;
        if (typeof el.load === "function") el.load();
        // Wait for first frame data so callers don't play black
        await waitVideoReady(el, 12000);
        return el.readyState >= 1 || !!el.getAttribute("src");
      } catch (_) {
        return false;
      }
    }

    // Images: prefer direct URL with token (also works with Range-less GET)
    const t = token();
    if (!t) {
      el.src = url;
      el.dataset.loadedSrc = url;
      return true;
    }
    try {
      el.src = authed;
      el.dataset.loadedSrc = url;
      return true;
    } catch {
      try {
        const res = await fetch(url, { headers: { "X-LMW-Token": t } });
        if (!res.ok) return false;
        const blob = await res.blob();
        el.src = URL.createObjectURL(blob);
        el.dataset.loadedSrc = url;
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

  function renderGrid(list) {
    const grid = $("#grid");
    if (!grid) return;
    const items = list || state._gridCache || state.items;
    stopAllGridPreviews();
    grid.innerHTML = items
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
        if (state._gridCache) {
          state._gridCache = state._gridCache.filter((x) => x.id !== id);
        }
        // delete: rebuild feed is acceptable (item gone)
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
    // Event delegation: tag chips inside HUD (pointer-events fixed in CSS)
    const feedScroller = $("#feedScroller");
    if (feedScroller && feedScroller.dataset.tagDelegate !== "1") {
      feedScroller.dataset.tagDelegate = "1";
      feedScroller.addEventListener("click", (e) => {
        const btn = e.target.closest("button.chip.tag[data-tag]");
        if (!btn || !feedScroller.contains(btn)) return;
        e.preventDefault();
        e.stopPropagation();
        loadSimilarFromTag(btn.getAttribute("data-tag") || btn.dataset.tag);
      });
    }
    syncFeedModeSelects();
    for (const sel of feedModeSelects()) {
      sel.addEventListener("change", async (e) => {
        await applyFeedMode(e.target.value);
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
          .filter(Boolean);
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
