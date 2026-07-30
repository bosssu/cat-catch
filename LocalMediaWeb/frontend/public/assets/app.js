(() => {
  const tokenKey = "lmw_token";
  const feedModeKey = "lmw_feed_mode";
  const searchHistoryKey = "lmw_search_history";
  /** include media tagged 限制级 in feed/search/grid (default off) */
  const includeRestrictedKey = "lmw_include_restricted";
  /** session: once user unmutes, keep sound on for later videos in this tab */
  const soundKey = "lmw_want_sound";
  /** session: browser media element unlocked for unmuted play (user gesture) */
  const audioUnlockKey = "lmw_audio_unlocked";
  const state = {
    view: "feed",
    /** view before opening search (for back) */
    prevView: "feed",
    mode: localStorage.getItem(feedModeKey) || "random",
    includeRestricted: localStorage.getItem(includeRestrictedKey) === "1",
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
    /**
     * True after a real user unmute gesture (or successful unmuted play).
     * Combined with a single shared <video>, this is how short-video apps keep
     * sound across swipes under autoplay policy.
     */
    audioUnlocked: sessionStorage.getItem(audioUnlockKey) === "1",
    /** singleton feed <video> — never recreate per slide */
    _feedPlayer: null,
    /** currently active feed slide id (string); exclusivity for video audio */
    activeFeedId: null,
    /** monotinic token so stale play/load races abort */
    playEpoch: 0,
    /** search page */
    searchQ: "",
    searchItems: [],
    searchTotal: 0,
    searchOffset: 0,
    searchLoading: false,
    /**
     * Feed playlist source:
     * - "normal": /api/feed ranked by mode
     * - "search": /api/media?q=… (same UI/ops as normal feed)
     */
    feedSource: "normal",
    /** active query when feedSource === "search" */
    searchFeedQ: "",
    /** next offset for search-feed tail prefetch */
    searchFeedOffset: 0,
    /** admin media library filter */
    adminMediaQ: "",
    /**
     * Session-seen media ids (for exclude after history prune).
     * Caps growth so exclude_ids query stays reasonable on mobile.
     */
    feedSeenIds: [],
    feedSeenSet: new Set(),
  };

  /** Coarse / small screens: aggressive media windowing (desktop left alone). */
  function isMobileFeedClient() {
    try {
      if (window.matchMedia("(pointer: coarse)").matches) return true;
      if (window.matchMedia("(max-width: 900px)").matches) return true;
      if ((navigator.maxTouchPoints || 0) > 1 && window.innerWidth < 1100) return true;
    } catch (_) {}
    return false;
  }

  /**
   * Viewport form factor for fit + orientation policy (independent of GC throttling).
   * - phone: real handheld (short edge / Mobile UA)
   * - headset: Pico / Quest / wide VR browser → always contain
   * - desktop: mouse PC and large touch laptops
   */
  function detectViewportProfile() {
    const w = window.innerWidth || 1;
    const h = window.innerHeight || 1;
    const shortEdge = Math.min(w, h);
    const longEdge = Math.max(w, h);
    const ar = longEdge / shortEdge;
    const ua = navigator.userAgent || "";
    let landscape = w > h;
    try {
      if (window.matchMedia("(orientation: landscape)").matches) landscape = true;
      if (window.matchMedia("(orientation: portrait)").matches) landscape = false;
    } catch (_) {}

    const headsetUa =
      /Pico|PicoBrowser|Pico Neo|Quest|OculusBrowser|Wolvic|Immersed|XRBrowser|SamsungBrowser.*VR/i.test(
        ua
      );
    const coarse = (() => {
      try {
        return window.matchMedia("(pointer: coarse)").matches;
      } catch (_) {
        return false;
      }
    })();
    const touch = (navigator.maxTouchPoints || 0) > 0;
    const mobileUa = /Mobile|Android.*Mobile|iPhone|iPod|webOS|BlackBerry/i.test(ua);
    // Pad-ish / phone: short edge phone-sized, or classic mobile UA
    const phoneSized = shortEdge <= 520 || (mobileUa && shortEdge <= 700);
    // Wide VR browser without clear UA: coarse + wide aspect + not tiny phone
    const headsetHeuristic =
      !mobileUa && coarse && shortEdge > 520 && ar >= 1.45 && touch;

    let profile = "desktop";
    if (headsetUa || headsetHeuristic) profile = "headset";
    else if (phoneSized || mobileUa) profile = "phone";

    return {
      profile,
      orientation: landscape ? "landscape" : "portrait",
      landscape,
      isPhone: profile === "phone",
      isPhoneLandscape: profile === "phone" && landscape,
      isPhonePortrait: profile === "phone" && !landscape,
      isHeadset: profile === "headset",
      isDesktop: profile === "desktop",
      shortEdge,
      width: w,
      height: h,
    };
  }

  function isDocumentFullscreen() {
    return !!(
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.webkitCurrentFullScreenElement
    );
  }

  /** True while orientation / FS exit must not switch slides or pause the active clip. */
  /**
   * ─── Feed identity (simple) ───
   * committedFeedId: only written by user swipe / cold start.
   * On any rotate: lock to committed, freeze scroller (no snap), never switch.
   */
  function isOrientLockActive() {
    return !!state._orientLockActive;
  }

  function getCommittedFeedId() {
    return state.committedFeedId != null ? String(state.committedFeedId) : null;
  }

  function getLockedFeedId() {
    return state._lockedFeedId != null ? String(state._lockedFeedId) : null;
  }

  function getClipFreezeId() {
    return getLockedFeedId() || getCommittedFeedId();
  }

  function markFrozenSlide(id) {
    const scroller = document.getElementById("feedScroller");
    if (!scroller) return;
    const sid = id != null ? String(id) : "";
    scroller.querySelectorAll(".snap-slide").forEach((el) => {
      el.classList.toggle("is-feed-frozen", sid !== "" && String(el.dataset.id) === sid);
    });
  }

  function clearFrozenSlideMarks() {
    document.querySelectorAll("#feedScroller .snap-slide.is-feed-frozen").forEach((el) => {
      el.classList.remove("is-feed-frozen");
    });
  }

  /** User / cold-start only. Source of truth for rotate lock. */
  function commitFeedId(id, index) {
    if (id == null) return;
    state.committedFeedId = String(id);
    if (index != null && Number.isFinite(Number(index))) {
      state.committedFeedIndex = Number(index) | 0;
    } else {
      const slide = document.querySelector(
        `#feedScroller .snap-slide[data-id="${state.committedFeedId}"]`
      );
      state.committedFeedIndex =
        slide && slide.dataset.index != null
          ? Number(slide.dataset.index) || 0
          : state.feedIndex | 0;
    }
    state.activeFeedId = state.committedFeedId;
    state.feedIndex = state.committedFeedIndex | 0;
  }

  /**
   * Lock to committed (never to a drifted activeFeedId).
   * Once locked, id is immutable until unlockFeedId.
   */
  function lockFeedId(_preferIgnored, reason) {
    if (state._lockedFeedId == null) {
      const id = getCommittedFeedId() || state.activeFeedId;
      if (id == null) return null;
      state._lockedFeedId = String(id);
      state._lockedFeedIndex =
        state.committedFeedIndex != null
          ? state.committedFeedIndex | 0
          : state.feedIndex | 0;
      const slide = document.querySelector(
        `#feedScroller .snap-slide[data-id="${state._lockedFeedId}"]`
      );
      if (slide && slide.dataset.index != null) {
        state._lockedFeedIndex = Number(slide.dataset.index) || 0;
      }
      state._lockReason = reason || "";
    }
    state.activeFeedId = String(state._lockedFeedId);
    state.feedIndex = state._lockedFeedIndex | 0;
    // Keep committed aligned (rotate must not invent a new commit)
    state.committedFeedId = String(state._lockedFeedId);
    state.committedFeedIndex = state._lockedFeedIndex | 0;
    markFrozenSlide(state._lockedFeedId);
    state._userScrollPending = false;
    return state._lockedFeedId;
  }

  function unlockFeedId() {
    state._lockedFeedId = null;
    state._lockedFeedIndex = null;
    state._lockReason = "";
    clearFrozenSlideMarks();
  }

  function captureClipFreeze() {
    return lockFeedId(null, "freeze");
  }
  function releaseClipFreeze() {
    unlockFeedId();
  }

  function isFeedIdentityLocked() {
    return (
      state._lockedFeedId != null ||
      !!state._landscapeImmersive ||
      isOrientLockActive() ||
      document.body.classList.contains("lmw-viewport-freeze")
    );
  }

  function isPlaybackGuarded() {
    return (
      !!state._viewportResizing ||
      !!state._programmaticScroll ||
      isOrientLockActive() ||
      document.body.classList.contains("lmw-viewport-freeze") ||
      (Number(state._playbackGuardUntil) || 0) > Date.now()
    );
  }

  function armPlaybackGuard(ms = 1800) {
    const until = Date.now() + Math.max(200, ms | 0);
    state._playbackGuardUntil = Math.max(Number(state._playbackGuardUntil) || 0, until);
    state._layoutResumeIgnoreUserPause = true;
    clearTimeout(state._playbackGuardClearT);
    state._playbackGuardClearT = setTimeout(() => {
      if ((Number(state._playbackGuardUntil) || 0) <= Date.now() && !state._orientLockActive) {
        state._layoutResumeIgnoreUserPause = false;
      }
    }, ms + 50);
  }

  function resetPlaybackGuard(ms = 0) {
    state._playbackGuardUntil = Date.now() + Math.max(0, ms | 0);
    state._layoutResumeIgnoreUserPause = ms > 0;
    clearTimeout(state._playbackGuardClearT);
    if (ms > 0) {
      state._playbackGuardClearT = setTimeout(() => {
        state._layoutResumeIgnoreUserPause = false;
      }, ms + 40);
    } else {
      state._layoutResumeIgnoreUserPause = false;
    }
  }

  function setActiveFeedIdFromUser(id, index) {
    commitFeedId(id, index);
  }

  function exitDocFullscreen() {
    try {
      if (!isDocumentFullscreen()) return Promise.resolve();
      if (document.exitFullscreen) return document.exitFullscreen();
      if (document.webkitExitFullscreen) return document.webkitExitFullscreen();
      if (document.webkitCancelFullScreen) return document.webkitCancelFullScreen();
    } catch (_) {}
    return Promise.resolve();
  }

  function lockScrollerPhysics(scroller) {
    if (!scroller) return;
    scroller.dataset.orientLock = "1";
    scroller.style.scrollSnapType = "none";
    scroller.style.overflowY = "hidden";
  }

  function unlockScrollerPhysics(scroller) {
    if (!scroller) return;
    try {
      scroller.style.scrollSnapType = "";
      scroller.style.overflowY = "";
      delete scroller.dataset.orientLock;
    } catch (_) {}
  }

  /**
   * Full-viewport shield: move shared video (or image) onto a fixed layer so
   * scroller reflow / snap / class toggles are invisible. Layout finishes under
   * visibility:hidden; we cut back in one frame — no visible shake.
   */
  function ensureOrientShield() {
    let el = document.getElementById("lmwOrientShield");
    if (!el) {
      el = document.createElement("div");
      el.id = "lmwOrientShield";
      el.setAttribute("aria-hidden", "true");
      document.body.appendChild(el);
    }
    return el;
  }

  function showOrientShield() {
    // After settle, ignore re-entry that would flash UI away again
    if (Date.now() < (Number(state._orientGraceUntil) || 0) && !state._orientLockActive) {
      return;
    }
    const shield = ensureOrientShield();
    document.body.classList.add("lmw-orient-shielded");
    shield.classList.add("is-on");
    state._orientShieldOn = true;

    // Prefer shared feed video; keep decoding uninterrupted
    let media =
      state._feedPlayer ||
      document.getElementById("lmwFeedPlayer") ||
      document.querySelector("#feedScroller .media-stage video") ||
      document.querySelector("#feedScroller .media-stage img");

    if (!media) {
      // Try active slide image
      const id = getLockedFeedId() || getCommittedFeedId() || state.activeFeedId;
      if (id != null) {
        media = document.querySelector(
          `#feedScroller .snap-slide[data-id="${id}"] .media-stage img, #feedScroller .snap-slide[data-id="${id}"] .media-stage video`
        );
      }
    }
    if (media && media.parentNode !== shield) {
      try {
        // Clear inline styles that might fight contain layout
        media.style.width = "";
        media.style.height = "";
        shield.appendChild(media);
        if (media.tagName === "VIDEO") {
          media.classList.add("is-ready");
          try {
            if (media.paused && media.dataset.userPaused !== "1") media.play().catch(() => {});
          } catch (_) {}
        }
      } catch (_) {}
    }
  }

  /** Pin scroller, put media back on slide, drop shield — one visual cut. */
  function hideOrientShield() {
    const shield = document.getElementById("lmwOrientShield");
    const id = getLockedFeedId() || getCommittedFeedId() || state.activeFeedId;
    const slide = pinFeedIdOnce(id, {
      stayLocked: isOrientLockActive() || !!state._landscapeImmersive,
    });

    // Media currently on shield (or already moved)
    let media =
      (shield && (shield.querySelector("video") || shield.querySelector("img"))) ||
      state._feedPlayer ||
      document.getElementById("lmwFeedPlayer");

    if (slide && media) {
      try {
        if (media.tagName === "VIDEO") {
          mountFeedPlayer(slide);
          media = getSharedFeedVideo() || media;
          applyMediaStageFit(media);
          media.dataset.userPaused = "0";
          if (media.paused) softResumeFeedVideo(media);
          if (!media.paused) media.classList.add("is-ready");
          setSlideLoading(slide, false);
        } else if (media.tagName === "IMG") {
          const stage = slide.querySelector(".media-stage");
          if (stage && media.parentNode !== stage) {
            const loading = stage.querySelector(".media-loading");
            if (loading) loading.after(media);
            else stage.insertBefore(media, stage.firstChild);
          }
          applyMediaStageFit(media);
          setSlideLoading(slide, false);
        }
      } catch (_) {}
    }

    if (shield) {
      shield.classList.remove("is-on");
      // Video should already be remounted; clear any non-player leftovers only
      try {
        [...shield.childNodes].forEach((n) => {
          if (n && n.id !== "lmwFeedPlayer" && n !== state._feedPlayer) {
            try {
              n.remove();
            } catch (_) {}
          }
        });
      } catch (_) {}
    }
    document.body.classList.remove("lmw-orient-shielded");
    state._orientShieldOn = false;
  }

  /** Mark orientation session finished — block re-shield from residual resize noise. */
  function markOrientSettled(orientation) {
    const vp = detectViewportProfile();
    const o = orientation || vp.orientation || "portrait";
    state._settledOrientation = o;
    state._lastViewportKey = viewportKey(vp);
    state._orientGraceUntil = Date.now() + 900;
    state._orientTarget = null;
    state._orientFinishing = false;
  }

  /**
   * Single pin of scroll position.
   * stayLocked=true only during orient session — normal settle must NOT leave overflow:hidden
   * (cold start resize/pin was freezing the feed until a rotate cycle unlocked it).
   */
  function pinFeedIdOnce(forceId, opts = {}) {
    const scroller = document.getElementById("feedScroller");
    if (!scroller || state.view !== "feed") return null;
    const id =
      getLockedFeedId() ||
      forceId ||
      getCommittedFeedId() ||
      state.activeFeedId;
    if (id == null) return null;
    let slide = scroller.querySelector(`.snap-slide[data-id="${id}"]`);
    if (!slide) {
      const idx =
        state._lockedFeedIndex != null
          ? state._lockedFeedIndex
          : state.committedFeedIndex != null
            ? state.committedFeedIndex
            : state.feedIndex | 0;
      slide = scroller.querySelector(`.snap-slide[data-index="${idx}"]`);
    }
    if (!slide) return null;

    state.activeFeedId = String(slide.dataset.id || id);
    if (slide.dataset.index != null) {
      const ix = Number(slide.dataset.index);
      if (Number.isFinite(ix)) state.feedIndex = ix;
    }

    const stayLocked =
      opts.stayLocked === true ||
      (opts.stayLocked !== false &&
        (isOrientLockActive() ||
          !!state._landscapeImmersive ||
          !!state._orientShieldOn));

    state._programmaticScroll = true;
    clearTimeout(state._pinScrollClearT);

    if (stayLocked) {
      lockScrollerPhysics(scroller);
      document.body.classList.add("lmw-viewport-freeze");
    } else {
      try {
        scroller.style.scrollSnapType = "none";
      } catch (_) {}
    }

    const landscape = document.body.classList.contains("lmw-phone-landscape");
    if (landscape) {
      scroller.scrollTop = 0;
    } else {
      void scroller.offsetHeight;
      let top = slide.offsetTop;
      const ch = scroller.clientHeight || window.innerHeight || 1;
      const ix = Number(slide.dataset.index);
      if (Number.isFinite(ix) && ix > 0 && top === 0) top = ix * ch;
      scroller.scrollTop = top;
    }

    if (!stayLocked) {
      // Restore snap immediately after pin — keep scroll enabled
      try {
        scroller.style.scrollSnapType = "";
        if (scroller.style.overflowY === "hidden") scroller.style.overflowY = "";
        delete scroller.dataset.orientLock;
      } catch (_) {}
      state._pinScrollClearT = setTimeout(() => {
        state._programmaticScroll = false;
      }, 80);
    }
    return slide;
  }

  function hardSnapToFeedId(forceId, opts = {}) {
    return pinFeedIdOnce(forceId, opts);
  }

  function pinActiveFeedSlide(forceId) {
    // Default: soft pin that does not freeze the scroller
    return pinFeedIdOnce(forceId, { stayLocked: false });
  }

  /** Emergency / cold-start / stuck-after-rotate: always re-enable feed scrolling + UI. */
  function forceEnableFeedScroll() {
    const scroller = document.getElementById("feedScroller");
    const portrait =
      !state._landscapeImmersive &&
      !document.body.classList.contains("lmw-phone-landscape");
    try {
      document.body.classList.remove("lmw-viewport-freeze");
      document.body.classList.remove("lmw-orient-shielded");
      const shield = document.getElementById("lmwOrientShield");
      if (shield) shield.classList.remove("is-on");
      // If video still on shield, put it back on committed slide
      const id =
        getLockedFeedId() || getCommittedFeedId() || state.activeFeedId;
      const slide =
        id != null
          ? document.querySelector(`#feedScroller .snap-slide[data-id="${id}"]`)
          : null;
      const v =
        (shield && (shield.querySelector("video") || shield.querySelector("img"))) ||
        state._feedPlayer ||
        document.getElementById("lmwFeedPlayer");
      if (slide && v) {
        try {
          if (v.tagName === "VIDEO") {
            mountFeedPlayer(slide);
            applyMediaStageFit(v);
            if (v.paused && v.dataset.userPaused !== "1") {
              try {
                softResumeFeedVideo(v);
              } catch (_) {}
            }
          } else if (v.tagName === "IMG") {
            const stage = slide.querySelector(".media-stage");
            if (stage && v.parentNode !== stage) {
              const loading = stage.querySelector(".media-loading");
              if (loading) loading.after(v);
              else stage.insertBefore(v, stage.firstChild);
            }
            applyMediaStageFit(v);
          }
        } catch (_) {}
      }
      // Orphan media left on shield after is-on removed → black feed
      if (shield) {
        try {
          [...shield.childNodes].forEach((n) => {
            if (n && n.id !== "lmwFeedPlayer" && n !== state._feedPlayer) {
              try {
                n.remove();
              } catch (_) {}
            }
          });
        } catch (_) {}
      }
      unlockScrollerPhysics(scroller);
      if (scroller) {
        scroller.style.overflowY = "";
        scroller.style.scrollSnapType = "";
        scroller.style.touchAction = "";
        delete scroller.dataset.orientLock;
      }
    } catch (_) {}
    if (portrait) {
      unlockFeedId();
      state._orientLockActive = false;
      // Landscape entry hides chrome; portrait must show UI again unless user hid it
      if (state._fsRestore) {
        setChromeHidden(!!state._fsRestore.chromeHidden);
        state._fsRestore = null;
      } else if (!isChromeHidden()) {
        /* already visible */
      } else {
        // Stuck after L→P with chrome still hidden from immersive
        setChromeHidden(false);
      }
      // Pin committed slide without re-freezing
      try {
        pinFeedIdOnce(getCommittedFeedId() || state.activeFeedId, {
          stayLocked: false,
        });
      } catch (_) {}
    }
    state._viewportResizing = false;
    state._programmaticScroll = false;
    state._userScrollPending = false;
    state._feedScrolling = false;
    state._orientShieldOn = false;
    resetPlaybackGuard(0);
  }

  /**
   * After viewport settles, apply landscape shell from final geometry only.
   * Prevents intermediate L↔P flicker from leaving immersive stuck on portrait.
   */
  function reconcilePhoneShellFromProfile(vp) {
    const profile = vp || detectViewportProfile();
    if (profile.isPhoneLandscape || profile.isHeadset) {
      if (!state._landscapeImmersive) {
        enterPhoneLandscapeImmersive();
      } else {
        document.body.classList.add("lmw-phone-landscape");
        markFrozenSlide(getLockedFeedId() || getCommittedFeedId());
      }
      return true;
    }
    // Portrait (or non-phone): leave immersive if still on
    if (
      state._landscapeImmersive ||
      document.body.classList.contains("lmw-phone-landscape")
    ) {
      // shield only if a real orient session is mid-flight (not post-unlock cleanup)
      leavePhoneLandscapeImmersive({
        shield: !!state._orientLockActive && !state._orientFinishing,
      });
    } else {
      document.body.classList.remove("lmw-phone-landscape");
      state._landscapeImmersive = false;
    }
    return false;
  }

  /**
   * Instant freeze on real rotate only (before scroll can rewrite active id).
   */
  function freezeViewportNow(reason) {
    const scroller = document.getElementById("feedScroller");
    const keepId = lockFeedId(null, reason || "viewport");
    state._orientLockActive = true;
    state._orientLockId = keepId;
    if (!state._orientLockGen) state._orientLockGen = 0;
    state._viewportResizing = true;
    state._feedScrolling = false;
    state._userScrollPending = false;
    document.body.classList.add("lmw-viewport-freeze");
    lockScrollerPhysics(scroller);
    showOrientShield();
    pinFeedIdOnce(keepId, { stayLocked: true });
    return keepId;
  }

  function beginOrientLock(reason, targetOrient) {
    // Same in-flight session: keep gen, do not restart (restart = UI flash)
    if (
      state._orientLockActive &&
      targetOrient &&
      state._orientTarget === targetOrient
    ) {
      freezeViewportNow(reason || "orient-keep");
      return state._orientLockGen || 1;
    }
    state._orientLockGen = (state._orientLockGen || 0) + 1;
    state._orientTarget = targetOrient || null;
    state._orientFinishing = false;
    // Real new orient: cancel grace so shield can show
    state._orientGraceUntil = 0;
    freezeViewportNow(reason || "orient");
    return state._orientLockGen;
  }

  /**
   * End orient: pin under shield, then drop shield + unlock in one cut.
   * Portrait ALWAYS force-enables scroll + UI (L→P was leaving freeze/shield/chrome stuck).
   */
  function endOrientLock(gen, opts = {}) {
    if (gen != null && gen !== state._orientLockGen) return;
    if (state._orientFinishing && opts.force !== true) return;
    state._orientFinishing = true;

    const scroller = document.getElementById("feedScroller");
    const keepId = getLockedFeedId() || getCommittedFeedId() || state.activeFeedId;

    // Prefer explicit opts; else final geometry after settle
    let land =
      opts.landscape != null
        ? !!opts.landscape
        : !!state._landscapeImmersive ||
          document.body.classList.contains("lmw-phone-landscape");
    if (opts.unlock === true) land = false;
    if (opts.unlock === false) land = true;

    document.body.classList.add("lmw-viewport-freeze");
    lockScrollerPhysics(scroller);
    pinFeedIdOnce(keepId, { stayLocked: true });

    if (land) {
      // Still landscape: reveal into single-slide stage under shield, then drop shield
      markFrozenSlide(keepId);
      state._orientLockActive = false;
      hideOrientShield();
      document.body.classList.remove("lmw-viewport-freeze");
      document.body.classList.remove("lmw-orient-shielded");
      state._viewportResizing = false;
      state._userScrollPending = false;
      state._programmaticScroll = false;
      state._orientShieldOn = false;
      state._orientFinishing = false;
      markOrientSettled("landscape");
      resetPlaybackGuard(0);
      try {
        // Bind transport only — stay hidden until user single-taps
        ensureLandControls();
        syncLandControlsVideo();
        hideLandControls();
        state._landSuppressAutoShowUntil = Date.now() + 800;
      } catch (_) {}
      return;
    }

    // Portrait: one frame under shield then full unlock (avoid double-rAF race with new locks)
    const finishPortrait = () => {
      // Allow finish even if a size-only event tried to keep same gen; abort only on NEW gen
      if (gen != null && gen !== state._orientLockGen) return;
      // Ensure shell is not stuck landscape
      document.body.classList.remove("lmw-phone-landscape");
      state._landscapeImmersive = false;
      if (scroller) {
        const slide = scroller.querySelector(`.snap-slide[data-id="${keepId}"]`);
        if (slide) {
          void scroller.offsetHeight;
          let top = slide.offsetTop;
          const ch = scroller.clientHeight || window.innerHeight || 1;
          const ix = Number(slide.dataset.index);
          if (Number.isFinite(ix) && ix > 0 && top === 0) top = ix * ch;
          scroller.scrollTop = top;
        }
      }
      // hideOrientShield must not re-freeze while we unlock
      state._orientLockActive = false;
      hideOrientShield();
      unlockFeedId();
      forceEnableFeedScroll();
      pinFeedIdOnce(keepId, { stayLocked: false });
      state._postOrientReload = true;
      state._orientFinishing = false;
      markOrientSettled("portrait");
    };

    requestAnimationFrame(finishPortrait);
  }

  function enterPhoneLandscapeImmersive() {
    // Already immersive: do not re-freeze/re-shield (causes UI flash)
    if (state._landscapeImmersive && document.body.classList.contains("lmw-phone-landscape")) {
      markFrozenSlide(getLockedFeedId() || getCommittedFeedId());
      const scroller = document.getElementById("feedScroller");
      if (scroller) scroller.scrollTop = 0;
      try {
        ensureLandControls();
        syncLandControlsVideo();
        hideLandControls();
      } catch (_) {}
      return getLockedFeedId() || getCommittedFeedId();
    }
    const freezeId =
      state._orientLockActive && state._orientShieldOn
        ? lockFeedId(null, "landscape")
        : freezeViewportNow("landscape");
    if (state._fsRestore == null) {
      state._fsRestore = { chromeHidden: isChromeHidden() };
    }
    document.body.classList.add("lmw-phone-landscape");
    setChromeHidden(true);
    state._landscapeImmersive = true;
    state._landscapeFsRequested = false;
    state._pendingLandscapeFs = false;
    markFrozenSlide(freezeId);
    const scroller = document.getElementById("feedScroller");
    if (scroller) scroller.scrollTop = 0;
    pinFeedIdOnce(freezeId, { stayLocked: true });
    try {
      ensureLandControls();
      syncLandControlsVideo();
      hideLandControls();
      state._landSuppressAutoShowUntil = Date.now() + 800;
    } catch (_) {}
    return freezeId;
  }

  function leavePhoneLandscapeImmersive(opts = {}) {
    // Do NOT re-open shield if we are finishing unlock or in grace — that is the
    // "UI shows then vanishes" flash. Shield is already up during a real orient lock.
    const wantShield = opts.shield !== false && !!state._orientLockActive && !state._orientFinishing;
    if (wantShield && !state._orientShieldOn) showOrientShield();
    try {
      tearDownLandControls();
    } catch (_) {}
    document.body.classList.remove("lmw-phone-landscape");
    state._landscapeImmersive = false;
    state._landscapeFsRequested = false;
    state._pendingLandscapeFs = false;
    if (state._orientLockActive) {
      document.body.classList.add("lmw-viewport-freeze");
    }
    if (state._fsRestore) {
      setChromeHidden(!!state._fsRestore.chromeHidden);
      state._fsRestore = null;
    } else {
      setChromeHidden(false);
    }
    return exitDocFullscreen().catch(() => {});
  }

  function reapplyActiveMediaFit() {
    const scroller = $("#feedScroller");
    if (!scroller) return;
    const id = getClipFreezeId() || state.activeFeedId;
    const slide =
      (id != null && scroller.querySelector(`.snap-slide[data-id="${id}"]`)) ||
      scroller.querySelector(`.snap-slide[data-index="${state.feedIndex | 0}"]`);
    if (!slide) return;
    const media = slide.querySelector(".media-stage video, .media-stage img");
    if (media) applyMediaStageFit(media);
  }

  function getActiveFeedSlideEl(keepId) {
    const scroller = $("#feedScroller");
    if (!scroller) return null;
    const id =
      keepId != null
        ? keepId
        : state._orientLockActive && state._orientLockId != null
          ? state._orientLockId
          : state.activeFeedId;
    if (id != null) {
      const el = scroller.querySelector(`.snap-slide[data-id="${id}"]`);
      if (el) return el;
    }
    return scroller.querySelector(`.snap-slide[data-index="${state.feedIndex | 0}"]`);
  }

  function getSharedFeedVideo() {
    return (
      state._feedPlayer ||
      document.getElementById("lmwFeedPlayer") ||
      document.querySelector("#lmwOrientShield video") ||
      document.querySelector("#feedScroller .media-stage video")
    );
  }

  /**
   * Wait until viewport size/orientation stops changing (iOS fires many resizes).
   */
  function waitViewportStable(stableMs = 220, timeoutMs = 1400) {
    return new Promise((resolve) => {
      let last = viewportKey();
      let lastChange = Date.now();
      const t0 = Date.now();
      const step = () => {
        const k = viewportKey();
        if (k !== last) {
          last = k;
          lastChange = Date.now();
        }
        if (Date.now() - lastChange >= stableMs || Date.now() - t0 >= timeoutMs) {
          resolve(last);
          return;
        }
        setTimeout(step, 40);
      };
      setTimeout(step, 40);
    });
  }

  /**
   * Soft resume after orientation / immersive exit — SAME clip only.
   * Never activate a different slide; remount singleton; avoid load() if possible.
   */
  /**
   * Resume SAME clip under shield (do not remount off shield until hideOrientShield).
   */
  function resumeActiveFeedAfterLayout(keepId, opts = {}) {
    if (state.view !== "feed") return;
    const id =
      getLockedFeedId() ||
      getCommittedFeedId() ||
      (keepId != null ? keepId : null) ||
      state.activeFeedId;
    const resumeEpoch = (state._layoutResumeEpoch = (state._layoutResumeEpoch || 0) + 1);
    state._userScrollPending = false;
    clearTimeout(state._layoutResumeRetryT);

    if (id != null) state.activeFeedId = String(id);
    // Pin scroller only — video stays on shield if shield is up
    pinFeedIdOnce(id, { stayLocked: true });

    const v = getSharedFeedVideo();
    const done = () => {
      if (resumeEpoch !== state._layoutResumeEpoch) return;
      if (typeof opts.onDone === "function") {
        try {
          opts.onDone();
        } catch (_) {}
      }
    };

    if (!v || v.tagName !== "VIDEO") {
      done();
      return;
    }

    v.dataset.userPaused = "0";
    try {
      v.setAttribute("playsinline", "");
      v.setAttribute("webkit-playsinline", "");
      v.playsInline = true;
    } catch (_) {}

    // Soft keep-alive on shield; remount happens in hideOrientShield
    const gen = Number(v.dataset.playGen || "0") || bumpVideoPlayGen(v);
    if (v.paused) {
      playVideoRobust(v, gen).finally(() => {
        if (!v.paused) v.classList.add("is-ready");
        done();
      });
    } else {
      v.classList.add("is-ready");
      done();
    }
  }

  function viewportKey(vp) {
    const p = vp || detectViewportProfile();
    return `${p.profile}|${p.orientation}|${p.width}|${p.height}`;
  }

  /**
   * Handle rotate after freezeViewportNow already ran.
   * ONLY real orientation flips start a lock session.
   * Size/chrome noise must never re-shield (that was "UI flash then gone").
   */
  function onViewportLayoutChange() {
    if (state.view !== "feed") {
      state._lastViewportKey = viewportKey();
      return;
    }
    // Feed not interactive yet — never freeze (cold open was stuck unscrollable)
    if (!state._feedScrollReady) {
      state._lastViewportKey = viewportKey();
      return;
    }
    const vp = detectViewportProfile();
    const key = viewportKey(vp);
    const prevKey = state._lastViewportKey;
    const nextOrient = vp.orientation;
    const settled = state._settledOrientation || "";
    const prevOrient =
      settled || (prevKey ? String(prevKey).split("|")[1] : "") || "";
    const orientChanged = !!prevOrient && !!nextOrient && prevOrient !== nextOrient;
    const nowLandscape = nextOrient === "landscape";
    const wasLandscape = prevOrient === "landscape";
    const inGrace = Date.now() < (Number(state._orientGraceUntil) || 0);

    // ── Grace / size-only: never start a new shield session ──
    if (!orientChanged) {
      state._lastViewportKey = key;

      // Mid real-orient session: only re-pin, do not bump gen / re-show shield
      if (state._orientLockActive && !state._orientFinishing) {
        pinFeedIdOnce(getLockedFeedId() || getCommittedFeedId(), {
          stayLocked: true,
        });
        return;
      }

      // Stuck immersive flag while geometry is portrait
      if (
        (state._landscapeImmersive ||
          document.body.classList.contains("lmw-phone-landscape")) &&
        !vp.isPhoneLandscape &&
        !nowLandscape
      ) {
        leavePhoneLandscapeImmersive({ shield: false });
        forceEnableFeedScroll();
        markOrientSettled("portrait");
        return;
      }

      // Residual freeze/shield without an active session → clear
      if (
        !state._orientLockActive &&
        (document.body.classList.contains("lmw-viewport-freeze") ||
          document.body.classList.contains("lmw-orient-shielded") ||
          (document.getElementById("feedScroller") || {}).style?.overflowY ===
            "hidden")
      ) {
        forceEnableFeedScroll();
      }
      return;
    }

    // Real orient flip during grace is allowed (user rotated again quickly)
    // Same target already in flight → do not restart session
    if (
      state._orientLockActive &&
      state._orientTarget === nextOrient &&
      !state._orientFinishing
    ) {
      state._lastViewportKey = key;
      pinFeedIdOnce(getLockedFeedId() || getCommittedFeedId(), {
        stayLocked: true,
      });
      return;
    }

    // Brief grace: ignore flaky intermediate flips that bounce back (iOS)
    // unless matchMedia agrees and we're past a tiny debounce held by schedule()
    if (inGrace && settled && nextOrient !== settled) {
      // Require phone landscape detection to match claimed orient (anti-jitter)
      if (nextOrient === "landscape" && !vp.isPhoneLandscape && !vp.isHeadset) {
        state._lastViewportKey = key;
        return;
      }
      if (nextOrient === "portrait" && vp.isPhoneLandscape) {
        state._lastViewportKey = key;
        return;
      }
    }

    state._lastViewportKey = key;

    const lockGen = beginOrientLock(
      nowLandscape ? "to-landscape" : "to-portrait",
      nextOrient
    );
    const keepId = getLockedFeedId() || getCommittedFeedId();
    clearTimeout(state._viewportResizeT);
    clearTimeout(state._orientFinishT);
    // Safety: never leave freeze/shield forever
    clearTimeout(state._orientSafetyT);
    state._orientSafetyT = setTimeout(() => {
      if (state._orientLockGen !== lockGen) return;
      try {
        const finalVp = detectViewportProfile();
        const land = reconcilePhoneShellFromProfile(finalVp);
        if (land) {
          endOrientLock(lockGen, { unlock: false, landscape: true, force: true });
        } else {
          endOrientLock(lockGen, { unlock: true, landscape: false, force: true });
          forceEnableFeedScroll();
          markOrientSettled("portrait");
        }
      } catch (_) {
        try {
          leavePhoneLandscapeImmersive({ shield: false });
        } catch (__) {}
        forceEnableFeedScroll();
        markOrientSettled(detectViewportProfile().orientation);
      }
    }, 1600);

    // Immediate shell guess (reconcile again after stable)
    if (vp.isPhoneLandscape || nowLandscape) {
      enterPhoneLandscapeImmersive();
    } else if (wasLandscape || state._landscapeImmersive || isDocumentFullscreen()) {
      leavePhoneLandscapeImmersive({ shield: true });
    } else {
      document.body.classList.remove("lmw-phone-landscape");
      state._landscapeImmersive = false;
    }

    pinFeedIdOnce(keepId, { stayLocked: true });

    waitViewportStable(160, 800).then(() => {
      if (lockGen !== state._orientLockGen) return;
      clearTimeout(state._orientSafetyT);
      const finalVp = detectViewportProfile();
      state._lastViewportKey = viewportKey(finalVp);
      const land = reconcilePhoneShellFromProfile(finalVp);
      const id = getLockedFeedId() || getCommittedFeedId() || keepId;
      pinFeedIdOnce(id, { stayLocked: true });
      resumeActiveFeedAfterLayout(id, {
        hard: true,
        onDone: () => {
          if (lockGen !== state._orientLockGen) return;
          const vp2 = detectViewportProfile();
          const land2 = reconcilePhoneShellFromProfile(vp2);
          endOrientLock(lockGen, {
            unlock: !land2,
            landscape: land2,
          });
          if (!land2) {
            requestAnimationFrame(() => {
              if (state._orientLockGen !== lockGen) return;
              if (
                document.body.classList.contains("lmw-viewport-freeze") ||
                document.body.classList.contains("lmw-orient-shielded") ||
                document.body.classList.contains("lmw-phone-landscape") ||
                state._orientShieldOn
              ) {
                document.body.classList.remove("lmw-phone-landscape");
                state._landscapeImmersive = false;
                forceEnableFeedScroll();
                markOrientSettled("portrait");
              }
            });
          }
        },
      });
    });
  }

  function bindViewportLayout() {
    if (window.__lmwViewportBound) return;
    window.__lmwViewportBound = true;
    state._lastViewportKey = viewportKey();
    let debounceT = null;

    const freezeImmediate = (reason) => {
      if (state.view !== "feed" || !state._feedScrollReady) return;
      // During post-settle grace, do not flash shield for residual events
      if (
        Date.now() < (Number(state._orientGraceUntil) || 0) &&
        !state._orientLockActive
      ) {
        return;
      }
      freezeViewportNow(reason || "event");
    };

    const schedule = () => {
      if (!state._feedScrollReady) {
        state._lastViewportKey = viewportKey();
        return;
      }
      clearTimeout(debounceT);
      debounceT = setTimeout(() => {
        try {
          onViewportLayoutChange();
        } catch (e) {
          console.warn("viewport layout", e);
          forceEnableFeedScroll();
        }
      }, 60);
    };

    const onPossiblyOrient = (reason) => {
      // Only freeze on real orientation flip — not toolbar/visualViewport noise
      try {
        const vp = detectViewportProfile();
        const settled = state._settledOrientation || "";
        const prev = state._lastViewportKey;
        const po = settled || (prev ? String(prev).split("|")[1] : "");
        const no = vp.orientation;
        if (po && no && po !== no) {
          // Real flip: freeze only if not already handling this target
          if (!(state._orientLockActive && state._orientTarget === no)) {
            freezeImmediate(reason);
          }
        } else if (state._orientLockActive && !state._orientFinishing) {
          // Mid orient settle: keep scroller frozen only (do not re-shield)
          document.body.classList.add("lmw-viewport-freeze");
          lockScrollerPhysics(document.getElementById("feedScroller"));
        }
      } catch (_) {}
      schedule();
    };

    window.addEventListener("resize", () => onPossiblyOrient("resize"), { passive: true });
    window.addEventListener(
      "orientationchange",
      () => {
        if (!state._feedScrollReady) return;
        // orientationchange alone is noisy on iOS; only freeze if matchMedia flipped
        try {
          const vp = detectViewportProfile();
          const settled = state._settledOrientation || "";
          if (settled && vp.orientation && settled !== vp.orientation) {
            freezeImmediate("orientationchange");
          } else if (!settled) {
            freezeImmediate("orientationchange");
          }
        } catch (_) {
          freezeImmediate("orientationchange");
        }
        schedule();
      },
      { passive: true }
    );
    try {
      if (window.visualViewport) {
        window.visualViewport.addEventListener(
          "resize",
          () => onPossiblyOrient("visualViewport"),
          { passive: true }
        );
      }
    } catch (_) {}

    const onFsChange = () => {
      if (isDocumentFullscreen()) return;
      freezeImmediate("fs-exit");
      const lockGen = state._orientLockGen;
      const keepId = getLockedFeedId() || getCommittedFeedId();
      const vp = detectViewportProfile();
      if (vp.isPhoneLandscape) {
        enterPhoneLandscapeImmersive();
      } else {
        leavePhoneLandscapeImmersive();
      }
      clearTimeout(state._fsExitResumeT);
      state._fsExitResumeT = setTimeout(() => {
        resumeActiveFeedAfterLayout(keepId, {
          hard: true,
          onDone: () =>
            endOrientLock(lockGen, {
              unlock: !detectViewportProfile().isPhoneLandscape,
            }),
        });
      }, 80);
    };
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);

    const bindVideoFsHooks = (v) => {
      if (!v || v.dataset.fsHooks === "1") return;
      v.dataset.fsHooks = "1";
      v.addEventListener("webkitendfullscreen", () => {
        freezeImmediate("webkit-fs");
        const lockGen = state._orientLockGen;
        const keepId = getLockedFeedId();
        setTimeout(() => {
          resumeActiveFeedAfterLayout(keepId, {
            hard: true,
            onDone: () =>
              endOrientLock(lockGen, {
                unlock: !detectViewportProfile().isPhoneLandscape,
              }),
          });
        }, 40);
      });
      v.addEventListener("webkitbeginfullscreen", () => {
        freezeImmediate("webkit-fs-begin");
      });
    };
    const v0 = getSharedFeedVideo();
    if (v0) bindVideoFsHooks(v0);
    state._bindVideoFsHooks = bindVideoFsHooks;
  }

  /** Stage tap: ensure landscape immersive is on (CSS); container FS only on gesture. */
  function tryPendingLandscapeFullscreen() {
    const vp = detectViewportProfile();
    if (!vp.isPhoneLandscape) {
      state._pendingLandscapeFs = false;
      return;
    }
    if (!state._landscapeImmersive) {
      enterPhoneLandscapeImmersive();
    }
    // Optional container FS — user gesture only (not on auto-rotate)
    if (!isDocumentFullscreen()) {
      const scroller = document.getElementById("feedScroller");
      try {
        if (scroller && scroller.requestFullscreen) scroller.requestFullscreen().catch(() => {});
        else if (document.documentElement.requestFullscreen) {
          document.documentElement.requestFullscreen().catch(() => {});
        }
        state._landscapeFsRequested = true;
      } catch (_) {}
    }
    const v = getSharedFeedVideo();
    if (v && v.paused && v.dataset.userPaused !== "1" && !isOrientLockActive()) {
      resumeActiveFeedAfterLayout(state.activeFeedId, { hard: false });
    }
  }

  function rememberFeedSeen(id) {
    if (id == null) return;
    const n = Number(id);
    if (!Number.isFinite(n)) return;
    if (state.feedSeenSet.has(n)) return;
    state.feedSeenSet.add(n);
    state.feedSeenIds.push(n);
    // keep last ~180 (enough for random de-dupe without huge URLs)
    while (state.feedSeenIds.length > 180) {
      const old = state.feedSeenIds.shift();
      state.feedSeenSet.delete(old);
    }
  }

  /** Ids to exclude from next ranked batch (playlist + session history). */
  function excludeFeedIds() {
    const s = new Set(playlistIds());
    for (const id of state.feedSeenIds) s.add(id);
    return [...s];
  }

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

  /**
   * Session sound preference. Only the mute button (or explicit call) should change this.
   * Never flip it from video volumechange — browsers mute for autoplay constantly.
   */
  function markAudioUnlocked() {
    state.audioUnlocked = true;
    try {
      sessionStorage.setItem(audioUnlockKey, "1");
    } catch (_) {}
  }

  function setWantSound(on) {
    const next = !!on;
    if (next) markAudioUnlocked(); // unmute tap = user gesture unlock
    if (state.wantSound === next) {
      document.querySelectorAll("[data-act='mute']").forEach(syncMuteBtn);
      return;
    }
    state.wantSound = next;
    try {
      sessionStorage.setItem(soundKey, state.wantSound ? "1" : "0");
    } catch (_) {}
    // Only the shared feed player (or current slide video)
    const active = getFeedPlayer(false) || document.querySelector(
      `#feedScroller .snap-slide[data-id="${state.activeFeedId}"] video`
    );
    if (active) applySoundToVideo(active);
    document.querySelectorAll("[data-act='mute']").forEach(syncMuteBtn);
  }

  /**
   * ONE persistent <video> for the whole feed.
   * iOS/Android unlock unmuted playback on the element that received the user
   * gesture — creating a new <video> per slide loses that unlock (silent next).
   */
  function getFeedPlayer(create = true) {
    if (state._feedPlayer && state._feedPlayer.tagName === "VIDEO") {
      return state._feedPlayer;
    }
    let v = document.getElementById("lmwFeedPlayer");
    if (!v && create) {
      v = document.createElement("video");
      v.id = "lmwFeedPlayer";
      v.className = "feed-player";
      v.setAttribute("playsinline", "");
      v.setAttribute("webkit-playsinline", "");
      v.playsInline = true;
      v.loop = true;
      v.preload = "auto";
      v.muted = !state.wantSound;
      if (v.muted) v.setAttribute("muted", "");
    }
    if (v) {
      state._feedPlayer = v;
      try {
        if (typeof state._bindVideoFsHooks === "function") state._bindVideoFsHooks(v);
      } catch (_) {}
    }
    return v || null;
  }

  /**
   * ONE persistent <audio> for feed audio slides (parallel to video singleton).
   * Keeps mute unlock across swipes the same way the video player does.
   */
  function getFeedAudioPlayer(create = true) {
    if (state._feedAudioPlayer && state._feedAudioPlayer.tagName === "AUDIO") {
      return state._feedAudioPlayer;
    }
    let a = document.getElementById("lmwFeedAudio");
    if (!a && create) {
      a = document.createElement("audio");
      a.id = "lmwFeedAudio";
      a.className = "feed-audio-player";
      a.loop = true;
      a.preload = "auto";
      a.muted = !state.wantSound;
      if (a.muted) a.setAttribute("muted", "");
    }
    if (a) state._feedAudioPlayer = a;
    return a || null;
  }

  function feedPlayerParkEl() {
    let park = document.getElementById("lmwFeedPlayerPark");
    if (!park) {
      park = document.createElement("div");
      park.id = "lmwFeedPlayerPark";
      park.setAttribute("aria-hidden", "true");
      park.style.cssText =
        "position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none";
      document.body.appendChild(park);
    }
    return park;
  }

  function parkFeedPlayer() {
    const v = getFeedPlayer(false);
    if (!v) return;
    try {
      if (!v.paused) v.pause();
    } catch (_) {}
    const park = feedPlayerParkEl();
    if (v.parentNode !== park) {
      try {
        park.appendChild(v);
      } catch (_) {}
    }
  }

  function parkFeedAudio() {
    const a = getFeedAudioPlayer(false);
    if (!a) return;
    try {
      if (!a.paused) a.pause();
    } catch (_) {}
    const park = feedPlayerParkEl();
    if (a.parentNode !== park) {
      try {
        park.appendChild(a);
      } catch (_) {}
    }
  }

  /** Move singleton player into the active slide stage; rebind progress. */
  function mountFeedPlayer(slideEl) {
    if (!slideEl) return null;
    const stage = slideEl.querySelector(".media-stage");
    if (!stage) return null;
    parkFeedAudio();
    const v = getFeedPlayer(true);
    if (!v) return null;
    // Remove any leftover per-slide <video> shells (old markup / recovery)
    stage.querySelectorAll("video").forEach((el) => {
      if (el !== v) {
        try {
          el.remove();
        } catch (_) {}
      }
    });
    if (v.parentNode !== stage) {
      const loading = stage.querySelector(".media-loading");
      if (loading) loading.after(v);
      else stage.insertBefore(v, stage.firstChild);
    }
    // data-src on stage is the clip URL for this slide
    const clip = stage.getAttribute("data-src") || "";
    if (clip) v.setAttribute("data-src", clip);
    try {
      delete stage.dataset.progressBound;
    } catch (_) {}
    bindFeedProgress(stage);
    applySoundToVideo(v);
    if (document.body.classList.contains("lmw-phone-landscape")) {
      try {
        syncLandControlsVideo();
      } catch (_) {}
    }
    return v;
  }

  function mountFeedAudioPlayer(slideEl) {
    if (!slideEl) return null;
    const stage = slideEl.querySelector(".media-stage");
    if (!stage) return null;
    parkFeedPlayer();
    const a = getFeedAudioPlayer(true);
    if (!a) return null;
    stage.querySelectorAll("audio").forEach((el) => {
      if (el !== a) {
        try {
          el.remove();
        } catch (_) {}
      }
    });
    if (a.parentNode !== stage) {
      const loading = stage.querySelector(".media-loading");
      if (loading) loading.after(a);
      else stage.insertBefore(a, stage.firstChild);
    }
    const clip = stage.getAttribute("data-src") || "";
    if (clip) a.setAttribute("data-src", clip);
    try {
      delete stage.dataset.progressBound;
    } catch (_) {}
    bindFeedProgress(stage);
    applySoundToVideo(a);
    return a;
  }

  function isFeedPlayer(el) {
    return !!(el && (el.id === "lmwFeedPlayer" || el === state._feedPlayer));
  }

  function isFeedAudioPlayer(el) {
    return !!(el && (el.id === "lmwFeedAudio" || el === state._feedAudioPlayer));
  }

  function isFeedMediaEl(el) {
    return isFeedPlayer(el) || isFeedAudioPlayer(el);
  }

  /**
   * Programmatic mute/unmute. Marks element so delayed volumechange (iOS/Edge)
   * never rewrites state.wantSound.
   */
  function setVideoMutedProg(v, muted) {
    if (!v || (v.tagName !== "VIDEO" && v.tagName !== "AUDIO")) return;
    const gen = String((Number(v.dataset.progSoundGen || "0") || 0) + 1);
    v.dataset.progSoundGen = gen;
    v.dataset.progSound = "1";
    try {
      v.muted = !!muted;
      if (muted) v.setAttribute("muted", "");
      else v.removeAttribute("muted");
    } catch (_) {}
    // iOS may fire volumechange async after play()/load(); keep shield longer than a microtask
    clearTimeout(v._progSoundTimer);
    v._progSoundTimer = setTimeout(() => {
      if (v.dataset.progSoundGen === gen) {
        try {
          delete v.dataset.progSound;
        } catch (_) {}
      }
    }, 800);
  }

  function applySoundToVideo(v) {
    if (!v || (v.tagName !== "VIDEO" && v.tagName !== "AUDIO")) return;
    const wantMute = !state.wantSound;
    // Always drive element from preference (HTML muted attr can stick after load())
    setVideoMutedProg(v, wantMute);
    if (state.wantSound) {
      try {
        if (v.volume === 0) v.volume = 1;
      } catch (_) {}
    }
    // Intentionally NO volumechange → setWantSound(false).
    // Autoplay policy, load(), and pauseOther all mute the element without user intent.
    // Preference only changes via mute button (handleAction).
  }

  function applySoundToAllVideos() {
    document.querySelectorAll("video, audio").forEach(applySoundToVideo);
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
    // Search playlist uses a virtual mode label; not persisted to localStorage
    const v =
      state.feedSource === "search" ? "search" : state.mode && state.mode !== "search" ? state.mode : "random";
    for (const sel of feedModeSelects()) {
      // ensure option exists (older cached HTML may lack it)
      if (v === "search" && ![...sel.options].some((o) => o.value === "search")) {
        const opt = document.createElement("option");
        opt.value = "search";
        opt.textContent = "搜索";
        sel.appendChild(opt);
      }
      if ([...sel.options].some((o) => o.value === v)) {
        sel.value = v;
      }
    }
  }

  function playlistIds() {
    return state.items.map((x) => x.id).filter((id) => id != null);
  }

  /**
   * Single-stream media window:
   * ONLY the active index may hold a video src / decoder.
   * Next items stay black (no preload) until fully snapped in.
   */
  function applyFeedMediaWindow(centerIndex) {
    const scroller = $("#feedScroller");
    if (!scroller) return;
    const idx = centerIndex | 0;
    const player = getFeedPlayer(false);
    scroller.querySelectorAll(".snap-slide").forEach((slide) => {
      const i = Number(slide.dataset.index);
      if (!Number.isFinite(i)) return;
      if (i === idx) return;
      // Shared player lives only on the active slide; ignore it on others
      slide.querySelectorAll("video").forEach((v) => {
        if (v === player || isFeedPlayer(v)) return;
        silenceFeedVideo(v, { unload: true });
        try {
          v.remove();
        } catch (_) {}
      });
      // non-active images: drop decoded bitmap
      const img = slide.querySelector(".media-stage img");
      if (img && img.getAttribute("src")) {
        try {
          img.removeAttribute("src");
          delete img.dataset.loadedSrc;
        } catch (_) {}
      }
    });
  }

  /**
   * Pin scroller without treating it as a user fling.
   * Setting scrollTop fires "scroll" on mobile → was aborting in-flight activate
   * (classic black screen around the 4th–6th swipe when history first gets pruned).
   */
  function setFeedScrollTop(scroller, top) {
    if (!scroller) return;
    state._programmaticScroll = true;
    clearTimeout(state._programmaticScrollTimer);
    try {
      scroller.scrollTop = top;
    } catch (_) {}
    // Keep guard through the scroll event flush + a couple frames
    state._programmaticScrollTimer = setTimeout(() => {
      state._programmaticScroll = false;
    }, 120);
  }

  /**
   * Surgical compact — NEVER full innerHTML rebuild.
   * Mobile: delay pruning until deeper into the feed, and NEVER force-reactivate
   * after prune (scrollTop pin used to re-enter scroll → kill playEpoch).
   */
  function compactFeedIfNeeded() {
    const scroller = $("#feedScroller");
    if (!scroller || state.view !== "feed") return;
    if (state._feedScrolling || state._feedCompacting || state._feedActivating) return;
    if (state._programmaticScroll || isPlaybackGuarded() || isOrientLockActive()) return;
    // Never prune DOM while clip identity is frozen (landscape session)
    if (getClipFreezeId() != null || state._landscapeImmersive) return;

    const mobile = isMobileFeedClient();
    // Mobile: keep more history before first prune; fewer <video> still via strip
    const maxBehind = mobile ? 2 : 3;
    const maxAhead = mobile ? 6 : 12;
    // Don't prune at all until user is well past cold start (avoids 5th-slide death)
    const minIndexBeforePrune = mobile ? 8 : 4;
    const idx = state.feedIndex | 0;
    const total = state.items.length;

    if (idx < minIndexBeforePrune) {
      stripDistantFeedVideos(idx);
      return;
    }
    if (idx < maxBehind && total <= maxBehind + 1 + maxAhead) {
      stripDistantFeedVideos(idx);
      return;
    }

    const start = Math.max(0, idx - maxBehind);
    const end = Math.min(total, idx + 1 + maxAhead);
    if (start <= 0 && end >= total) {
      stripDistantFeedVideos(idx);
      return;
    }

    const activeId =
      state.activeFeedId != null
        ? state.activeFeedId
        : state.items[idx] != null
          ? state.items[idx].id
          : null;
    const activeEl =
      (activeId != null &&
        scroller.querySelector(`.snap-slide[data-id="${activeId}"]`)) ||
      scroller.querySelector(`.snap-slide[data-index="${idx}"]`);
    if (!activeEl || !activeEl.isConnected) return;

    // Only prune when active clip is healthy — never mid-buffer
    const av = activeEl.querySelector("video");
    if (
      av &&
      av.dataset.userPaused !== "1" &&
      (state._feedActivating ||
        !av.classList.contains("is-ready") ||
        av.paused ||
        av.readyState < 2)
    ) {
      scheduleFeedGc(800);
      return;
    }

    state._feedCompacting = true;
    try {
      const slice = state.items.slice(start, end);
      if (!slice.length) {
        state._feedCompacting = false;
        return;
      }
      const keepIds = new Set(slice.map((x) => String(x.id)));
      const scrollBefore = scroller.scrollTop;
      const topBefore = activeEl.offsetTop;

      scroller.querySelectorAll(".snap-slide").forEach((el) => {
        if (el === activeEl) return;
        if (!keepIds.has(String(el.dataset.id || ""))) {
          _removeSlideEl(el);
        }
      });

      let fi = 0;
      for (let i = 0; i < slice.length; i++) {
        const item = slice[i];
        const el = scroller.querySelector(`.snap-slide[data-id="${item.id}"]`);
        if (el) el.dataset.index = String(i);
        if (String(item.id) === String(activeId)) fi = i;
      }

      state.items = slice;
      state.feedIndex = fi;

      const topAfter = activeEl.offsetTop;
      const delta = topAfter - topBefore;
      scroller.style.scrollSnapType = "none";
      if (delta !== 0) {
        setFeedScrollTop(scroller, Math.max(0, scrollBefore + delta));
      }
      setFeedScrollTop(scroller, activeEl.offsetTop);

      stripDistantFeedVideos(fi);
      applyFeedMediaWindow(fi);
      observeFeedMedia({ skipAutoActivate: true });

      requestAnimationFrame(() => {
        try {
          scroller.style.scrollSnapType = "";
        } catch (_) {}
        if (activeEl.isConnected) {
          setFeedScrollTop(scroller, activeEl.offsetTop);
          // Do NOT activateFeedSlide here — programmatic scroll used to cascade
          // into settle → force activate → cancel the playing clip.
        }
        state._feedCompacting = false;
      });
    } catch (e) {
      state._feedCompacting = false;
      console.debug("compactFeedIfNeeded", e);
    }
  }

  /**
   * Replace non-active <video> nodes with a fresh empty shell so mobile
   * decoder pools release (pause/removeAttribute is not always enough after
   * many swipes). Active slide is never touched.
   */
  function stripDistantFeedVideos(centerIndex) {
    const scroller = $("#feedScroller");
    if (!scroller) return;
    const idx = centerIndex | 0;
    const activeId = state.activeFeedId;
    const player = getFeedPlayer(false);
    scroller.querySelectorAll(".snap-slide").forEach((slide) => {
      const i = Number(slide.dataset.index);
      if (!Number.isFinite(i) || i === idx) return;
      if (activeId != null && String(slide.dataset.id) === String(activeId)) return;
      // Remove leftover non-singleton videos only; never touch shared player
      slide.querySelectorAll("video").forEach((v) => {
        if (v === player || isFeedPlayer(v)) return;
        silenceFeedVideo(v, { unload: true });
        try {
          v.remove();
        } catch (_) {}
      });
    });
  }

  /**
   * Legacy recovery: must not destroy the shared feed player.
   * For singleton architecture this mostly parks stray nodes.
   */
  function recreateFeedVideoShell(slideEl, { hard = false } = {}) {
    if (!slideEl) return getFeedPlayer(false);
    const stage = slideEl.querySelector(".media-stage");
    if (!stage) return null;
    const old = stage.querySelector("video");
    if (old && isFeedPlayer(old)) {
      // Keep singleton; optional hard just remounts
      if (hard) return mountFeedPlayer(slideEl);
      return old;
    }
    if (old) {
      silenceFeedVideo(old, { unload: true });
      try {
        old.remove();
      } catch (_) {}
    }
    if (hard && stage.getAttribute("data-kind") === "video") {
      return mountFeedPlayer(slideEl);
    }
    if (hard && stage.getAttribute("data-kind") === "audio") {
      return mountFeedAudioPlayer(slideEl);
    }
    return null;
  }

  /** After scroll settles: unload neighbors + surgical compact. Never mid-fling / mid-activate. */
  function scheduleFeedGc(delayMs) {
    const ms = delayMs != null ? delayMs : isMobileFeedClient() ? 700 : 280;
    clearTimeout(state._feedGcTimer);
    state._feedGcTimer = setTimeout(() => {
      if (state.view !== "feed") return;
      if (state._feedScrolling || state._feedCompacting || state._feedActivating) {
        scheduleFeedGc(320);
        return;
      }
      applyFeedMediaWindow(state.feedIndex | 0);
      compactFeedIfNeeded();
      // Soft check only; never schedules hard reload thrash
      checkStuckFeedPlayback();
    }, ms);
  }

  /**
   * Soft-resume without tearing down the element and WITHOUT toggling mute
   * (toggling mute was pausing mobile and feeding a reload loop when wantSound).
   */
  function softResumeFeedVideo(v) {
    if (!v || (v.tagName !== "VIDEO" && v.tagName !== "AUDIO")) return false;
    if (v.dataset.userPaused === "1") return false;
    try {
      if (v.paused) {
        const p = v.play();
        if (p && typeof p.catch === "function") p.catch(() => {});
      }
      return !v.paused || v.readyState >= 2;
    } catch (_) {
      return false;
    }
  }

  /**
   * Stuck recovery: soft play only. Hard recreate was thrashing whenever
   * unmuted playback paused (common with wantSound) → loading every few seconds.
   * Hard path only on MEDIA_ERR / no source.
   */
  function checkStuckFeedPlayback() {
    if (state.view !== "feed") return;
    if (state._feedScrolling || state._feedCompacting || state._feedActivating) return;
    if (isPlaybackGuarded() || isOrientLockActive() || state._viewportResizing) return;

    const scroller = $("#feedScroller");
    if (!scroller) return;
    const id = state.activeFeedId;
    const slide =
      (id != null && scroller.querySelector(`.snap-slide[data-id="${id}"]`)) ||
      scroller.querySelector(`.snap-slide[data-index="${state.feedIndex | 0}"]`);
    if (!slide) return;
    const v = slide.querySelector("video, audio");
    if (!v || v.dataset.userPaused === "1") {
      state._stuckSince = 0;
      return;
    }

    const hasSrc = !!(v.getAttribute("src") || v.dataset.loadedSrc);
    const loadingOn = !!slide.querySelector(".media-loading.is-on");

    if (!v.paused && !v.error) {
      if (loadingOn) setSlideLoading(slide, false);
      if (!v.classList.contains("is-ready")) v.classList.add("is-ready");
      state._stuckSince = 0;
      state._stuckRecoverCount = 0;
      return;
    }

    // Soft resume only — never full reload for pause / autoplay policy
    if (hasSrc && !v.error) {
      softResumeFeedVideo(v);
      if (!v.paused) {
        v.classList.add("is-ready");
        setSlideLoading(slide, false);
        state._stuckSince = 0;
      }
      return;
    }

    // Only real media failure gets one hard recover
    if (!v.error && hasSrc) return;
    if ((state._stuckRecoverCount || 0) >= 1) return;
    state._stuckRecoverCount = 1;
    console.debug("stuck feed hard recover (media error)", id, v.error);
    state._feedActivating = false;
    try {
      recreateFeedVideoShell(slide, { hard: true });
    } catch (_) {}
    activateFeedSlide(slide, { force: true });
  }

  function armStuckWatchdog(delayMs) {
    // Intentionally mild — was a primary cause of sound-on reload thrash
    clearTimeout(state._stuckWatchTimer);
    state._stuckWatchTimer = setTimeout(() => {
      checkStuckFeedPlayback();
    }, delayMs != null ? delayMs : 8000);
  }

  /**
   * Tail-fetch after the current clip has started — avoids fighting video Range
   * requests for bandwidth/CPU on mobile (was the main source of mid-swipe /api/feed).
   */
  function scheduleEnsureFeedAhead(minAhead) {
    const target = minAhead != null ? minAhead : isMobileFeedClient() ? 8 : 10;
    clearTimeout(state._feedPrefetchTimer);
    const delay = isMobileFeedClient() ? 520 : 140;
    state._feedPrefetchTimer = setTimeout(() => {
      if (state.view !== "feed") return;
      if (state._feedActivating || state._feedCompacting || state._feedScrolling) {
        scheduleEnsureFeedAhead(target);
        return;
      }
      ensureFeedAhead(target);
    }, delay);
  }

  function clearSearchFeedSource() {
    state.feedSource = "normal";
    state.searchFeedQ = "";
    state.searchFeedOffset = 0;
  }

  /**
   * Search playlist tail: same filters as manage/search page (`/api/media?q=`).
   * Paginates until enough unseen items or no more pages.
   */
  async function fetchSearchFeedBatch({ limit = 24, exclude = null } = {}) {
    const query = (state.searchFeedQ || "").trim();
    if (!query) return [];
    const have = new Set(exclude != null ? exclude : excludeFeedIds());
    const out = [];
    let offset = Math.max(0, state.searchFeedOffset | 0);
    let guard = 0;
    while (out.length < limit && guard < 12) {
      guard += 1;
      const pageSize = Math.max(limit, 24);
      const params = new URLSearchParams({
        q: query,
        sort: "new",
        limit: String(pageSize),
        offset: String(offset),
        include_restricted: state.includeRestricted ? "true" : "false",
      });
      const data = await api(`/api/media?${params}`);
      const items = data.items || [];
      if (data.total != null) state.searchTotal = data.total;
      if (!items.length) break;
      offset += items.length;
      state.searchFeedOffset = offset;
      for (const it of items) {
        if (!it || it.id == null || have.has(it.id)) continue;
        have.add(it.id);
        out.push(it);
        if (out.length >= limit) break;
      }
      if (items.length < pageSize) break;
    }
    return out;
  }

  /**
   * Fetch a ranked batch. exclude playlist so next-decision never repeats
   * what's already on screen (history + current + queued tail).
   */
  async function fetchFeedBatch({ limit = 24, exclude = null, includeSeed = true } = {}) {
    if (state.feedSource === "search" && (state.searchFeedQ || "").trim()) {
      return fetchSearchFeedBatch({ limit, exclude });
    }
    const q = new URLSearchParams({
      mode: state.mode || "random",
      limit: String(limit),
      include_restricted: state.includeRestricted ? "true" : "false",
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
    const ex = exclude != null ? exclude : excludeFeedIds();
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
    // Search-playlist rebuild: restart from first page of the same query
    if (state.feedSource === "search" && (state.searchFeedQ || "").trim() && keepId == null) {
      state.searchFeedOffset = 0;
    }
    // Mobile: small initial playlist — large DOM of <video> dies after ~10 plays
    const batchLimit = isMobileFeedClient() ? 8 : 40;
    const items = await fetchFeedBatch({
      limit: batchLimit,
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
    // keep session de-dupe across soft rebuilds; hard empty only on full logout-like reset
    if (keepId == null && !quiet) {
      state.feedSeenIds = [];
      state.feedSeenSet = new Set();
    }
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
    // First open / hard rebuild: force-play current slide (scroll settle alone often misses first paint on iOS Edge)
    kickFeedAutoplay(keepId != null ? keepId : state.items[0]?.id);
    state.libDirty = false;
    // Allow swipe — and clear any accidental freeze from early resize events
    state._feedScrollReady = true;
    state._lastViewportKey = viewportKey();
    forceEnableFeedScroll();
  }

  /**
   * Ensure the target (or first) feed slide actually starts playing.
   * Bypasses scroll-lock races that block activate on cold start.
   */
  function kickFeedAutoplay(preferId, attempt = 0) {
    if (state.view !== "feed") return;
    const scroller = $("#feedScroller");
    if (!scroller) return;
    state._feedScrolling = false;
    let slide = null;
    if (preferId != null) {
      slide = scroller.querySelector(`.snap-slide[data-id="${preferId}"]`);
    }
    if (!slide) {
      const idx = state.feedIndex | 0;
      slide =
        scroller.querySelector(`.snap-slide[data-index="${idx}"]`) ||
        scroller.querySelector(".snap-slide");
    }
    if (!slide) {
      if (attempt < 6) setTimeout(() => kickFeedAutoplay(preferId, attempt + 1), 80);
      return;
    }
    activateFeedSlide(slide, { force: true }).then(() => {
      const media = slide.querySelector(".media-stage video, .media-stage img");
      if (!media) return;
      const videoOk =
        media.tagName === "VIDEO" &&
        !media.paused &&
        media.classList.contains("is-ready");
      const imgOk =
        media.tagName === "IMG" &&
        mediaSrcLoaded(media, media.getAttribute("data-src") || "") &&
        media.naturalWidth > 0;
      if ((videoOk || imgOk) && String(state.activeFeedId) === String(slide.dataset.id)) {
        setSlideLoading(slide, false);
        return;
      }
      // Retry a few times (autoplay policy / late layout)
      if (attempt < 5) {
        setTimeout(() => kickFeedAutoplay(preferId, attempt + 1), 220 + attempt * 120);
      }
    });
  }

  function _removeSlideEl(el) {
    if (!el) return;
    try {
      state._feedIo?.unobserve(el);
    } catch (_) {}
    const v = el.querySelector("video");
    if (v) {
      if (isFeedPlayer(v)) parkFeedPlayer();
      else silenceFeedVideo(v, { unload: true });
    }
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

  function setSlideLoading(slideEl, on) {
    if (!slideEl) return;
    const el = slideEl.querySelector(".media-loading");
    if (!el) return;
    el.classList.toggle("is-on", !!on);
    el.setAttribute("aria-hidden", on ? "false" : "true");
  }

  /**
   * Adaptive fit for all form factors:
   * - phone + portrait + media taller than stage → cover (TikTok-style, mild crop)
   * - phone + landscape / desktop / headset → always contain (no forced width crop)
   * Cover is refused when visible fraction would drop below ~72% (safety net).
   */
  function applyMediaStageFit(media) {
    if (!media) return;
    const stage = media.closest(".media-stage");
    const mw = media.videoWidth || media.naturalWidth || 0;
    const mh = media.videoHeight || media.naturalHeight || 0;
    if (!mw || !mh) {
      media.classList.remove("fit-cover");
      media.classList.add("fit-contain");
      return;
    }
    const sw = (stage && stage.clientWidth) || window.innerWidth || 1;
    const sh = (stage && stage.clientHeight) || window.innerHeight || 1;
    if (sw < 2 || sh < 2) return;

    const mediaAR = mw / mh;
    const stageAR = sw / sh;
    const vp = detectViewportProfile();
    // Only phone portrait may use cover for taller-than-stage media.
    // Refuse cover when it would crop away more than ~28% of the frame.
    let useCover = false;
    if (vp.isPhonePortrait && mediaAR + 0.02 < stageAR) {
      const visibleFrac = Math.min(1, stageAR / mediaAR);
      if (visibleFrac >= 0.72) useCover = true;
    }

    if (useCover) {
      media.classList.add("fit-cover");
      media.classList.remove("fit-contain");
    } else {
      media.classList.add("fit-contain");
      media.classList.remove("fit-cover");
    }
  }

  function slideHtml(item, i) {
    const liked = item.liked ? "on" : "";
    const isImg = item.media_type === "image" || item.media_type === "gif";
    const isAudio = item.media_type === "audio";
    const loading = `<div class="media-loading is-on" aria-hidden="false" aria-label="加载中"><div class="media-loading-spinner"></div></div>`;
    // Video/audio slides: NO per-slide media element. Shared players mount on activate
    // so the browser keeps the unmuted "unlock" across swipes.
    const progressChrome = `${loading}
          <button type="button" class="media-play-toggle" aria-label="暂停" title="暂停/播放" tabindex="-1">${ICO.pause}</button>
          <div class="feed-progress" aria-hidden="true">
            <div class="feed-progress-track">
              <div class="feed-progress-fill"></div>
              <div class="feed-progress-knob"></div>
            </div>
            <div class="feed-progress-time"><span class="cur">0:00</span><span class="sep">/</span><span class="dur">0:00</span></div>
          </div>`;
    const audioArt = `<div class="audio-stage-art" aria-hidden="true"><span class="audio-note">♪</span></div>`;
    const media = isImg
      ? `${loading}<img data-src="${fileUrl(item)}" alt="" draggable="false" />`
      : isAudio
        ? `${audioArt}${progressChrome}`
        : progressChrome;
    const stageAttrs = isImg
      ? `class="media-stage" title="单击显示进度 · 双击隐藏/恢复界面"`
      : isAudio
        ? `class="media-stage media-stage-audio" data-kind="audio" data-src="${fileUrl(item)}" title="单击显示进度 · 双击隐藏/恢复界面"`
        : `class="media-stage" data-kind="video" data-src="${fileUrl(item)}" title="单击显示进度 · 双击隐藏/恢复界面"`;
    return `<section class="snap-slide" data-index="${i}" data-id="${item.id}">
          <div ${stageAttrs}>${media}</div>
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
   * Mobile target is intentionally close to desktop so swipe rarely waits on /api/feed.
   */
  async function ensureFeedAhead(minAhead = 8, opts = {}) {
    // Mid-activate block is only for background swipe prefetch (bandwidth).
    // Mode switch / search open pass force:true so the tail still refills.
    if (state.feedPrefetching || state._feedCompacting) return;
    if (state._feedActivating && !opts.force) return;
    const mobile = isMobileFeedClient();
    // Mobile compact keeps ~5 ahead — don't request more than that or we thrash.
    const target = mobile ? Math.min(Math.max(minAhead, 4), 6) : minAhead;
    const ahead = state.items.length - (state.feedIndex | 0) - 1;
    if (ahead >= target && !state.libDirty) return;
    state.feedPrefetching = true;
    try {
      const need = mobile
        ? Math.max(4, target - Math.max(0, ahead) + 1)
        : Math.max(12, target - Math.max(0, ahead) + 4);
      const batch = await fetchFeedBatch({
        limit: need,
        exclude: excludeFeedIds(),
        includeSeed: false,
      });
      appendFeedItems(batch);
      state.libDirty = false;
      // media/history compact only after scroll idle (scheduleFeedGc)
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
    // Leaving search playlist → ranked feed modes
    clearSearchFeedSource();
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
    await ensureFeedAhead(12, { force: true });
    if (toast) showToast(toast);
  }

  /**
   * Open a search hit in the full Feed UI (same slides, HUD, gestures, progress).
   * Playlist = current search results; more pages append as you swipe near the end.
   */
  function openSearchResultInFeed(startId) {
    const list = (state.searchItems || []).filter((x) => x && x.id != null);
    if (!list.length) {
      showToast("没有可播放的搜索结果");
      return;
    }
    const q = (state.searchQ || "").trim();
    state.feedSource = "search";
    state.searchFeedQ = q;
    state.searchFeedOffset = Math.max(0, state.searchOffset | 0);
    state.items = list.slice();
    state.viewedIds = new Set();
    const idNum = Number(startId);
    let idx = list.findIndex((x) => Number(x.id) === idNum);
    if (idx < 0) idx = 0;
    state.feedIndex = idx;
    stopAllGridPreviews();
    setView("feed");
    renderFeed();
    requestAnimationFrame(() => {
      const slide = document.querySelector(`.snap-slide[data-id="${list[idx].id}"]`);
      if (slide) {
        slide.scrollIntoView({ block: "nearest", behavior: "auto" });
        activateFeedSlide(slide, { force: true });
      }
      kickFeedAutoplay(list[idx].id);
    });
    const total = state.searchTotal || list.length;
    showToast(
      q
        ? `搜索结果 · 「${q}」· ${idx + 1}/${list.length}${total > list.length ? `（共 ${total}）` : ""}`
        : `搜索结果 · ${idx + 1}/${list.length}`
    );
    syncFeedModeSelects();
    // Prefetch next search pages into the tail
    ensureFeedAhead(10, { force: true });
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
    if (next === "search") {
      // Virtual mode: keep current search playlist, or open search page
      if (state.feedSource === "search" && state.items.length) {
        syncFeedModeSelects();
        if (state.view !== "feed") setView("feed");
        return;
      }
      openSearchPage(state.searchQ || state.searchFeedQ || "");
      // Not in search playlist until user picks a result — restore label
      syncFeedModeSelects();
      return;
    }
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
          await ensureFeedAhead(10, { force: true });
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
      const q = new URLSearchParams({
        limit: "200",
        sort: "new",
        include_restricted: state.includeRestricted ? "true" : "false",
      });
      const data = await api(`/api/media?${q}`);
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
    // Locked / freeze: refuse index drift
    if (isFeedIdentityLocked()) {
      const li =
        state._lockedFeedIndex != null
          ? state._lockedFeedIndex
          : state.committedFeedIndex;
      const lid = getLockedFeedId() || getCommittedFeedId();
      if (lid != null && (index | 0) !== (li | 0)) {
        state.feedIndex = li | 0;
        state.activeFeedId = String(lid);
        return;
      }
    }
    const prev = state.feedIndex;
    state.feedIndex = index | 0;
    state.dwellStart = Date.now();
    const item = state.items[state.feedIndex];
    if (!item) return;
    rememberFeedSeen(item.id);
    if (!state.viewedIds.has(item.id)) {
      state.viewedIds.add(item.id);
      postInteract(item.id, "view");
    }
    // Do NOT prune/unload here — mid-snap DOM/scroll edits cause rollback.
    // GC runs after scroll settles (scheduleFeedGc).
    scheduleFeedGc();
    const mobile = isMobileFeedClient();
    const ahead = state.items.length - (state.feedIndex | 0) - 1;
    // Prefetch only when the tail is short; defer so video Range wins the pipe.
    // Keep target aligned with compact maxAhead (mobile ~5) to avoid fetch/prune thrash.
    if (ahead < (mobile ? 2 : 6) || state.libDirty) {
      scheduleEnsureFeedAhead(mobile ? 5 : 10);
    }
    if (prev !== (state.feedIndex | 0)) {
      flushDwell(prev).catch(() => {});
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
    // Preserve singleton <video> outside the scroller before wiping DOM
    parkFeedPlayer();
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
    // Shared video or audio singleton (rebound after mount)
    const video =
      stage.querySelector("video") ||
      stage.querySelector("audio") ||
      (stage.getAttribute("data-kind") === "audio" ? getFeedAudioPlayer(false) : null) ||
      (stage.getAttribute("data-kind") === "video" ? getFeedPlayer(false) : null);
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
    /** UI scrub target (seconds); drives bar while user drags. */
    let scrubTarget = null;
    /** Latest time we want the decoder to land on (coalesced). */
    let pendingSeekT = null;
    let seekInFlight = false;
    let lastSeekIssuedAt = 0;
    /** Was playing when scrub started → resume after final seek. */
    let resumeAfterScrub = false;
    const HIDE_MS = 2800;
    /**
     * Preview seek interval while dragging.
     * UI (fill/knob/time) updates every move; only the decoder is throttled.
     * ~8–10Hz keeps scrubbing feel without seek-storm freezes.
     */
    const SEEK_PREVIEW_MS = 110;
    const SEEK_EPS = 0.04;

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

    const paintFromTime = (t) => {
      const d = video.duration;
      const tt = typeof t === "number" && isFinite(t) ? t : 0;
      const ratio = d && isFinite(d) && d > 0 ? Math.min(1, Math.max(0, tt / d)) : 0;
      if (fill) fill.style.width = `${ratio * 100}%`;
      if (knob) knob.style.left = `${ratio * 100}%`;
      if (curEl) curEl.textContent = formatMediaTime(tt);
      if (durEl) durEl.textContent = formatMediaTime(isFinite(d) ? d : 0);
    };

    const paint = () => {
      // While scrubbing, bar follows finger target — not decoder clock
      // (currentTime can lag or jump during coalesced seeks).
      if (seeking && scrubTarget != null) {
        paintFromTime(scrubTarget);
        return;
      }
      paintFromTime(video.currentTime || 0);
    };

    /**
     * Apply at most one in-flight seek; queue superseding targets.
     * Flooding currentTime on every pointermove freezes many decoders
     * while the playback clock still advances (progress moves, frames stick).
     */
    const flushSeek = (force) => {
      if (pendingSeekT == null) return;
      const d = video.duration;
      if (!d || !isFinite(d) || d <= 0) return;
      const t = Math.min(Math.max(0, pendingSeekT), Math.max(0, d - 0.05));
      const now = performance.now();
      if (!force) {
        if (seekInFlight) return;
        if (now - lastSeekIssuedAt < SEEK_PREVIEW_MS) return;
      } else if (seekInFlight && Math.abs((video.currentTime || 0) - t) < SEEK_EPS) {
        // already landing on final target
        pendingSeekT = null;
        return;
      }
      const cur = video.currentTime || 0;
      if (!force && Math.abs(cur - t) < SEEK_EPS && !seekInFlight) {
        pendingSeekT = null;
        return;
      }
      pendingSeekT = null;
      seekInFlight = true;
      lastSeekIssuedAt = now;
      try {
        video.currentTime = t;
      } catch (_) {
        seekInFlight = false;
      }
    };

    const scheduleSeek = (t, force) => {
      pendingSeekT = t;
      if (force) {
        flushSeek(true);
        return;
      }
      if (!seekInFlight && performance.now() - lastSeekIssuedAt >= SEEK_PREVIEW_MS) {
        flushSeek(false);
      }
    };

    const onSeeked = () => {
      seekInFlight = false;
      // drain newer scrub target (preview while drag, or final on release)
      if (pendingSeekT != null) {
        flushSeek(seeking ? false : true);
      }
      if (!seeking) paint();
    };

    const waitSeekQueueIdle = (timeoutMs = 600) =>
      new Promise((resolve) => {
        if (!seekInFlight && pendingSeekT == null) {
          resolve();
          return;
        }
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          video.removeEventListener("seeked", onSeekedTick);
          clearInterval(poll);
          clearTimeout(tm);
          resolve();
        };
        const onSeekedTick = () => {
          if (!seekInFlight && pendingSeekT == null) finish();
        };
        video.addEventListener("seeked", onSeekedTick);
        // pending can sit until SEEK_PREVIEW_MS without a seeked
        const poll = setInterval(() => {
          if (!seekInFlight && pendingSeekT != null) flushSeek(true);
          if (!seekInFlight && pendingSeekT == null) finish();
        }, 40);
        const tm = setTimeout(finish, timeoutMs);
      });

    const resumeAfterSeekIfNeeded = async () => {
      if (!resumeAfterScrub) return;
      resumeAfterScrub = false;
      if (video.dataset.userPaused === "1") return;
      if (!video.isConnected) return;
      // Drain coalesced seeks so play starts on the final scrub position.
      await waitSeekQueueIdle(700);
      if (video.dataset.userPaused === "1" || !video.isConnected) return;
      pauseOtherFeedVideos(video);
      const gen = bumpVideoPlayGen(video);
      const ok = await playVideoRobust(video, gen);
      // Mild recovery: playing but still no frame after heavy seeks
      if (ok && video.videoWidth === 0) {
        await new Promise((r) => setTimeout(r, 120));
        if (video.isConnected && video.dataset.userPaused !== "1" && video.videoWidth === 0) {
          try {
            const t = video.currentTime || 0;
            video.currentTime = Math.max(0, t);
          } catch (_) {}
          await playVideoRobust(video, bumpVideoPlayGen(video));
        }
      }
      syncToggleIcon();
    };

    video.addEventListener("timeupdate", paint);
    video.addEventListener("loadedmetadata", paint);
    video.addEventListener("durationchange", paint);
    video.addEventListener("seeked", onSeeked);
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
      // programmatic pause (slide leave / load / scrub) must NOT flash the control
      if (!isChromeHidden() && isUserPaused() && !seeking) {
        toggleBtn.classList.add("is-visible");
      } else if (!seeking) {
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
      // User gesture: complete phone-landscape fullscreen if auto request was blocked
      try {
        tryPendingLandscapeFullscreen();
      } catch (_) {}
      // Landscape: primarily hit-layer toggles; this is backup when meta HUD is up
      // (hit has pointer-events:none) — do not require video pixel hit (letterbox OK).
      const land = document.body.classList.contains("lmw-phone-landscape");
      if (!land && !pointHitsVideo(e.clientX, e.clientY)) return;
      if (tapTimer) clearTimeout(tapTimer);
      tapTimer = setTimeout(() => {
        tapTimer = null;
        if (document.body.classList.contains("lmw-phone-landscape")) {
          try {
            state._landSuppressAutoShowUntil = 0;
            if (isLandControlsOpen()) hideLandControls();
            else showLandControls({ force: true, fromUser: true });
          } catch (_) {}
          return;
        }
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
        // User gesture: hard resume (survives post-rotate / post-immersive stuck state)
        armPlaybackGuard(1500);
        pauseOtherFeedVideos(video);
        const slideEl = video.closest(".snap-slide");
        if (slideEl) {
          try {
            mountFeedPlayer(slideEl);
          } catch (_) {}
        }
        const gen = bumpVideoPlayGen(video);
        playVideoRobust(video, gen).then((ok) => {
          if (!ok || video.paused) {
            // Gesture context still active — one more force activate
            if (slideEl) {
              try {
                activateFeedSlide(slideEl, { force: true });
              } catch (_) {}
            } else {
              softResumeFeedVideo(video);
            }
          } else {
            video.classList.add("is-ready");
            if (slideEl) setSlideLoading(slideEl, false);
          }
          syncToggleIcon();
        });
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

    const ratioFromEvent = (clientX) => {
      const rect = track.getBoundingClientRect();
      const d = video.duration;
      if (!rect.width || !d || !isFinite(d)) return null;
      const r = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return { r, t: r * d, d };
    };

    /** UI every move; decoder seek coalesced / throttled. */
    const scrubFromEvent = (clientX, forceSeek) => {
      const hit = ratioFromEvent(clientX);
      if (!hit) return;
      scrubTarget = hit.t;
      paintFromTime(hit.t);
      scheduleSeek(hit.t, !!forceSeek);
    };

    const onPointerDown = (e) => {
      if (!e.isPrimary && e.pointerType === "touch") return;
      seeking = true;
      // Pause while scrubbing so the decoder is not decoding + seeking at once.
      resumeAfterScrub = !video.paused && video.dataset.userPaused !== "1";
      if (!video.paused) {
        try {
          video.pause();
        } catch (_) {}
      }
      showChrome();
      bar.classList.add("is-seeking");
      track.setPointerCapture?.(e.pointerId);
      // first contact: seek immediately for responsive preview frame
      scrubFromEvent(e.clientX, true);
      e.preventDefault();
      e.stopPropagation();
    };
    const onPointerMove = (e) => {
      if (!seeking) return;
      scrubFromEvent(e.clientX, false);
      e.preventDefault();
    };
    const onPointerUp = (e) => {
      if (!seeking) return;
      seeking = false;
      bar.classList.remove("is-seeking");
      try {
        track.releasePointerCapture?.(e.pointerId);
      } catch (_) {}
      // final exact position
      if (e && typeof e.clientX === "number") {
        scrubFromEvent(e.clientX, true);
      } else if (scrubTarget != null) {
        scheduleSeek(scrubTarget, true);
      }
      scrubTarget = null;
      hideBarSoon();
      // resume after decoder lands (async)
      resumeAfterSeekIfNeeded().catch(() => {});
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

  /**
   * Landscape fullscreen transport: play/pause + scrub + time.
   * Independent of portrait HUD / is-chrome-hidden (landscape always hides those).
   */
  function ensureLandControls() {
    let root = document.getElementById("lmwLandControls");
    if (root) return root;
    root = document.createElement("div");
    root.id = "lmwLandControls";
    root.className = "lmw-land-controls";
    root.setAttribute("aria-hidden", "true");
    root.innerHTML = `
      <div class="lmw-land-hit" data-land="hit" aria-hidden="true"></div>
      <button type="button" class="lmw-land-center" data-land="center" aria-label="播放" title="播放/暂停" tabindex="-1">${ICO.play}</button>
      <div class="lmw-land-dock" data-land="dock">
        <button type="button" class="lmw-land-play" data-land="play" aria-label="播放" title="播放/暂停">${ICO.play}</button>
        <span class="lmw-land-time lmw-land-cur" data-land="cur">0:00</span>
        <div class="lmw-land-track" data-land="track">
          <div class="lmw-land-fill" data-land="fill"></div>
          <div class="lmw-land-knob" data-land="knob"></div>
        </div>
        <span class="lmw-land-time is-dur" data-land="dur">0:00</span>
      </div>`;
    document.body.appendChild(root);
    bindLandControls(root);
    return root;
  }

  function isLandControlsOpen() {
    const root = document.getElementById("lmwLandControls");
    return !!(root && root.classList.contains("is-open"));
  }

  function getLandVideo() {
    return (
      state._landBoundVideo ||
      getSharedFeedVideo() ||
      document.querySelector("#feedScroller .snap-slide.is-feed-frozen video") ||
      document.querySelector("#feedScroller .media-stage video")
    );
  }

  function bindLandControls(root) {
    if (!root || root.dataset.bound === "1") return;
    root.dataset.bound = "1";

    const hit = root.querySelector('[data-land="hit"]');
    const centerBtn = root.querySelector('[data-land="center"]');
    const playBtn = root.querySelector('[data-land="play"]');
    const track = root.querySelector('[data-land="track"]');
    const fill = root.querySelector('[data-land="fill"]');
    const knob = root.querySelector('[data-land="knob"]');
    const curEl = root.querySelector('[data-land="cur"]');
    const durEl = root.querySelector('[data-land="dur"]');
    const dock = root.querySelector('[data-land="dock"]');

    let hideTimer = null;
    let seeking = false;
    let surfaceTapTimer = null;
    let surfaceTouchMoved = false;
    let surfaceTouchX = 0;
    let surfaceTouchY = 0;
    let lastSurfaceToggleAt = 0;
    let scrubTarget = null;
    let pendingSeekT = null;
    let seekInFlight = false;
    let lastSeekIssuedAt = 0;
    let resumeAfterScrub = false;
    const HIDE_MS = 3200;
    const SEEK_PREVIEW_MS = 110;
    const SEEK_EPS = 0.04;

    const syncIcons = () => {
      const v = getLandVideo();
      const paused = !v || v.paused;
      const html = paused ? ICO.play : ICO.pause;
      const label = paused ? "播放" : "暂停";
      if (playBtn) {
        playBtn.innerHTML = html;
        playBtn.setAttribute("aria-label", label);
        playBtn.classList.toggle("is-paused", paused);
      }
      if (centerBtn) {
        centerBtn.innerHTML = html;
        centerBtn.setAttribute("aria-label", label);
        centerBtn.classList.toggle("is-paused", paused);
      }
      root.classList.toggle("is-paused-hold", !!(paused && v && v.dataset.userPaused === "1"));
    };

    const paintFromTime = (t) => {
      const v = getLandVideo();
      const d = v && isFinite(v.duration) ? v.duration : 0;
      const tt = typeof t === "number" && isFinite(t) ? t : 0;
      const ratio = d > 0 ? Math.min(1, Math.max(0, tt / d)) : 0;
      if (fill) fill.style.width = `${ratio * 100}%`;
      if (knob) knob.style.left = `${ratio * 100}%`;
      if (curEl) curEl.textContent = formatMediaTime(tt);
      if (durEl) durEl.textContent = formatMediaTime(d);
    };

    const paint = () => {
      if (seeking && scrubTarget != null) {
        paintFromTime(scrubTarget);
        return;
      }
      const v = getLandVideo();
      paintFromTime(v ? v.currentTime || 0 : 0);
      syncIcons();
    };

    const flushSeek = (force) => {
      const v = getLandVideo();
      if (!v || pendingSeekT == null) return;
      const d = v.duration;
      if (!d || !isFinite(d) || d <= 0) return;
      const t = Math.min(Math.max(0, pendingSeekT), Math.max(0, d - 0.05));
      const now = performance.now();
      if (!force) {
        if (seekInFlight) return;
        if (now - lastSeekIssuedAt < SEEK_PREVIEW_MS) return;
      }
      const cur = v.currentTime || 0;
      if (!force && Math.abs(cur - t) < SEEK_EPS && !seekInFlight) {
        pendingSeekT = null;
        return;
      }
      pendingSeekT = null;
      seekInFlight = true;
      lastSeekIssuedAt = now;
      try {
        v.currentTime = t;
      } catch (_) {
        seekInFlight = false;
      }
    };

    const scheduleSeek = (t, force) => {
      pendingSeekT = t;
      if (force) flushSeek(true);
      else if (!seekInFlight && performance.now() - lastSeekIssuedAt >= SEEK_PREVIEW_MS) {
        flushSeek(false);
      }
    };

    const onSeeked = () => {
      seekInFlight = false;
      if (pendingSeekT != null) flushSeek(seeking ? false : true);
      if (!seeking) paint();
    };

    const hideLandChrome = () => {
      if (seeking) return;
      root.classList.remove("is-open");
      root.setAttribute("aria-hidden", "true");
      const v = getLandVideo();
      // Keep center play when user paused so resume is one tap
      if (v && v.paused && v.dataset.userPaused === "1") {
        root.classList.add("is-paused-hold");
      } else {
        root.classList.remove("is-paused-hold");
      }
    };

    const showLandChrome = (opts = {}) => {
      if (!document.body.classList.contains("lmw-phone-landscape")) return;
      // After P→L settle: ignore auto show (pause/play events); user tap sets force
      if (
        !opts.force &&
        Date.now() < (Number(state._landSuppressAutoShowUntil) || 0)
      ) {
        return;
      }
      root.classList.add("is-open");
      root.classList.remove("is-paused-hold");
      root.setAttribute("aria-hidden", "false");
      paint();
      syncIcons();
      clearTimeout(hideTimer);
      if (opts.sticky) return;
      const v = getLandVideo();
      if (v && v.paused && v.dataset.userPaused === "1") return;
      hideTimer = setTimeout(() => {
        if (!seeking) hideLandChrome();
      }, HIDE_MS);
    };

    const togglePlay = async (e) => {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      const v = getLandVideo();
      if (!v || v.tagName !== "VIDEO") return;
      if (v.paused) {
        v.dataset.userPaused = "0";
        armPlaybackGuard(1500);
        pauseOtherFeedVideos(v);
        const slideEl = v.closest(".snap-slide");
        if (slideEl) {
          try {
            mountFeedPlayer(slideEl);
          } catch (_) {}
        }
        const gen = bumpVideoPlayGen(v);
        await playVideoRobust(v, gen);
        if (!v.paused) {
          v.classList.add("is-ready");
          if (slideEl) setSlideLoading(slideEl, false);
        }
      } else {
        v.dataset.userPaused = "1";
        try {
          v.pause();
        } catch (_) {}
      }
      syncIcons();
      showLandChrome({ force: true });
    };

    const ratioFromEvent = (clientX) => {
      const v = getLandVideo();
      if (!v || !track) return null;
      const rect = track.getBoundingClientRect();
      const d = v.duration;
      if (!rect.width || !d || !isFinite(d)) return null;
      const r = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return { r, t: r * d, d };
    };

    const scrubFromEvent = (clientX, forceSeek) => {
      const hitR = ratioFromEvent(clientX);
      if (!hitR) return;
      scrubTarget = hitR.t;
      paintFromTime(hitR.t);
      scheduleSeek(hitR.t, !!forceSeek);
    };

    const onPointerDown = (e) => {
      if (!e.isPrimary && e.pointerType === "touch") return;
      const v = getLandVideo();
      if (!v) return;
      seeking = true;
      root.classList.add("is-seeking");
      resumeAfterScrub = !v.paused && v.dataset.userPaused !== "1";
      if (!v.paused) {
        try {
          v.pause();
        } catch (_) {}
      }
      showLandChrome({ sticky: true, force: true });
      track.setPointerCapture?.(e.pointerId);
      scrubFromEvent(e.clientX, true);
      e.preventDefault();
      e.stopPropagation();
    };
    const onPointerMove = (e) => {
      if (!seeking) return;
      scrubFromEvent(e.clientX, false);
      e.preventDefault();
    };
    const onPointerUp = (e) => {
      if (!seeking) return;
      seeking = false;
      root.classList.remove("is-seeking");
      try {
        track.releasePointerCapture?.(e.pointerId);
      } catch (_) {}
      if (e && typeof e.clientX === "number") scrubFromEvent(e.clientX, true);
      else if (scrubTarget != null) scheduleSeek(scrubTarget, true);
      scrubTarget = null;
      showLandChrome({ force: true });
      if (resumeAfterScrub) {
        resumeAfterScrub = false;
        const v = getLandVideo();
        if (v && v.dataset.userPaused !== "1") {
          const gen = bumpVideoPlayGen(v);
          playVideoRobust(v, gen).then(() => syncIcons());
        }
      }
    };

    /**
     * Full-screen hit layer: only reliable way to re-open controls after auto-hide
     * on iOS (video/stage often never get a synthetic click).
     */
    const toggleFromSurface = (src) => {
      if (!document.body.classList.contains("lmw-phone-landscape")) return;
      if (root.classList.contains("is-no-video")) return;
      if (Date.now() < (Number(state._landUiCooldown) || 0)) return;
      const now = Date.now();
      // Debounce touchend + click ghost / double fire
      if (now - lastSurfaceToggleAt < 320) return;
      lastSurfaceToggleAt = now;
      // User gesture always allowed (even during post-rotate suppress window)
      state._landSuppressAutoShowUntil = 0;
      if (root.classList.contains("is-open")) hideLandChrome();
      else showLandChrome({ force: true });
    };

    const onSurfacePointer = (e) => {
      // Ignore interactions meant for dock / center play
      if (
        e.target.closest(
          '[data-land="dock"], [data-land="center"], [data-land="play"], [data-land="track"]'
        )
      ) {
        return;
      }
      if (seeking) return;
      if (Date.now() < (Number(state._landUiCooldown) || 0)) return;

      // Delay so double-tap (immersive / meta HUD) can cancel
      if (surfaceTapTimer) clearTimeout(surfaceTapTimer);
      surfaceTapTimer = setTimeout(() => {
        surfaceTapTimer = null;
        toggleFromSurface(e.type);
      }, 280);
    };

    if (hit) {
      hit.addEventListener(
        "touchstart",
        (e) => {
          if (!e.touches || e.touches.length !== 1) {
            surfaceTouchMoved = true;
            return;
          }
          const t = e.touches[0];
          surfaceTouchX = t.clientX;
          surfaceTouchY = t.clientY;
          surfaceTouchMoved = false;
        },
        { passive: true }
      );
      hit.addEventListener(
        "touchmove",
        (e) => {
          if (!e.touches || e.touches.length !== 1) {
            surfaceTouchMoved = true;
            return;
          }
          const t = e.touches[0];
          if (
            Math.hypot(t.clientX - surfaceTouchX, t.clientY - surfaceTouchY) > 12
          ) {
            surfaceTouchMoved = true;
            if (surfaceTapTimer) {
              clearTimeout(surfaceTapTimer);
              surfaceTapTimer = null;
            }
          }
        },
        { passive: true }
      );
      hit.addEventListener(
        "touchend",
        (e) => {
          if (surfaceTouchMoved || !e.changedTouches || e.changedTouches.length !== 1) {
            return;
          }
          // Don't let the later ghost click also toggle
          state._landSuppressClickUntil = Date.now() + 450;
          onSurfacePointer(e);
        },
        { passive: true }
      );
      hit.addEventListener("click", (e) => {
        if (Date.now() < (Number(state._landSuppressClickUntil) || 0)) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        onSurfacePointer(e);
      });
      hit.addEventListener("dblclick", (e) => {
        if (surfaceTapTimer) {
          clearTimeout(surfaceTapTimer);
          surfaceTapTimer = null;
        }
        state._landUiCooldown = Date.now() + 520;
        e.preventDefault();
        e.stopPropagation();
        // Double-tap on surface: toggle meta HUD (like/mute), same as stage immersive
        try {
          setChromeHidden(!isChromeHidden());
          if (!isChromeHidden()) showLandChrome({ sticky: true, force: true });
        } catch (_) {}
      });
    }

    playBtn.addEventListener("click", togglePlay);
    centerBtn.addEventListener("click", togglePlay);
    dock.addEventListener("click", (e) => e.stopPropagation());
    dock.addEventListener("dblclick", (e) => e.stopPropagation());

    track.addEventListener("pointerdown", onPointerDown);
    track.addEventListener("pointermove", onPointerMove);
    track.addEventListener("pointerup", onPointerUp);
    track.addEventListener("pointercancel", onPointerUp);

    // Persist handlers for rebind
    state._landCtrl = {
      root,
      paint,
      syncIcons,
      show: showLandChrome,
      hide: hideLandChrome,
      onSeeked,
      attach(v) {
        const prev = state._landBoundVideo;
        if (prev && prev !== v) {
          try {
            prev.removeEventListener("timeupdate", paint);
            prev.removeEventListener("loadedmetadata", paint);
            prev.removeEventListener("durationchange", paint);
            prev.removeEventListener("seeked", onSeeked);
            prev.removeEventListener("play", onPlay);
            prev.removeEventListener("pause", onPause);
          } catch (_) {}
        }
        state._landBoundVideo = v || null;
        if (!v) return;
        v.addEventListener("timeupdate", paint);
        v.addEventListener("loadedmetadata", paint);
        v.addEventListener("durationchange", paint);
        v.addEventListener("seeked", onSeeked);
        v.addEventListener("play", onPlay);
        v.addEventListener("pause", onPause);
        paint();
        syncIcons();
      },
    };

    function onPlay() {
      syncIcons();
      if (root.classList.contains("is-open")) showLandChrome({ force: true });
      else root.classList.remove("is-paused-hold");
    }
    function onPause() {
      syncIcons();
      const v = getLandVideo();
      // Only after intentional user pause — never flash bar on rotate/layout pause
      if (
        v &&
        v.dataset.userPaused === "1" &&
        !seeking &&
        Date.now() >= (Number(state._landSuppressAutoShowUntil) || 0)
      ) {
        root.classList.add("is-paused-hold");
        showLandChrome({ sticky: true, force: true });
      }
    }
  }

  function syncLandControlsVideo() {
    if (!document.body.classList.contains("lmw-phone-landscape")) return;
    const root = ensureLandControls();
    const v = getSharedFeedVideo();
    const hasVideo = !!(v && v.tagName === "VIDEO");
    root.classList.toggle("is-no-video", !hasVideo);
    if (state._landCtrl && state._landCtrl.attach) {
      state._landCtrl.attach(hasVideo ? v : null);
    } else if (root) {
      bindLandControls(root);
      state._landCtrl?.attach?.(hasVideo ? v : null);
    }
  }

  function showLandControls(opts) {
    ensureLandControls();
    syncLandControlsVideo();
    const o = opts || {};
    // Default force for explicit API callers that mean "user wants bar"
    if (o.force == null && o.fromUser) o.force = true;
    state._landCtrl?.show?.(o);
  }

  function hideLandControls() {
    clearTimeout(state._landHideT);
    const root = document.getElementById("lmwLandControls");
    if (root) {
      root.classList.remove("is-open", "is-seeking", "is-paused-hold");
      root.setAttribute("aria-hidden", "true");
    }
    state._landCtrl?.hide?.();
  }

  function tearDownLandControls() {
    clearTimeout(state._landHideT);
    const root = document.getElementById("lmwLandControls");
    if (root) {
      root.classList.remove("is-open", "is-seeking", "is-paused-hold");
      root.setAttribute("aria-hidden", "true");
    }
    const prev = state._landBoundVideo;
    if (prev && state._landCtrl) {
      try {
        // listeners removed on next attach(null) path
        state._landCtrl.attach(null);
      } catch (_) {}
    }
    state._landBoundVideo = null;
  }

  async function handleAction(act, id, btn) {
    const idx = state.items.findIndex((x) => x.id === id);
    if (act === "mute") {
      const turningOn = !state.wantSound;
      setWantSound(turningOn);
      // User gesture on the SHARED player — this unlocks unmuted play for later swipes
      const v =
        getFeedPlayer(false) ||
        document.querySelector(`.snap-slide[data-id="${id}"] video`) ||
        document.querySelector(`.snap-slide[data-index="${state.feedIndex}"] video`);
      if (v && v.dataset.userPaused !== "1") {
        if (turningOn) {
          markAudioUnlocked();
          setVideoMutedProg(v, false);
          try {
            const p = v.play();
            if (p && typeof p.then === "function") {
              p.then(() => markAudioUnlocked()).catch(() => {});
            }
          } catch (_) {}
        } else {
          setVideoMutedProg(v, true);
        }
        const slideEl = v.closest(".snap-slide");
        if (slideEl && !v.paused) {
          v.classList.add("is-ready");
          setSlideLoading(slideEl, false);
          state._stuckSince = 0;
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

  /** Hard-stop a feed video (no chrome flash). Shared player: pause only, never destroy. */
  function silenceFeedVideo(v, { unload = false } = {}) {
    if (!v || (v.tagName !== "VIDEO" && v.tagName !== "AUDIO")) return;
    // Never tear down the singleton — that drops the audio unlock
    if (isFeedMediaEl(v)) {
      // Guard: do not kill active shared player during orientation / immersive exit
      if (isPlaybackGuarded() || isOrientLockActive()) return;
      bumpVideoPlayGen(v);
      try {
        if (!v.paused) v.pause();
      } catch (_) {}
      try {
        v.classList.remove("is-ready");
      } catch (_) {}
      return;
    }
    bumpVideoPlayGen(v);
    if (unload) v.dataset.userPaused = "0";
    try {
      v.classList.remove("is-ready");
    } catch (_) {}
    try {
      if (!v.paused) v.pause();
    } catch (_) {}
    if (unload) {
      try {
        if (v.src && String(v.src).startsWith("blob:")) {
          try {
            URL.revokeObjectURL(v.src);
          } catch (_) {}
        }
        delete v.dataset.loadedSrc;
        v.removeAttribute("src");
        v.removeAttribute("poster");
        while (v.firstChild) v.removeChild(v.firstChild);
        v.preload = "none";
        if (typeof v.load === "function") v.load();
      } catch (_) {}
    }
    hideSlideVideoChrome(v.closest(".snap-slide"));
  }

  /** Single-stream: remove stray non-singleton videos/audio; park player only when except=null. */
  function pauseOtherFeedVideos(except) {
    document.querySelectorAll("#feedScroller video, #feedScroller audio").forEach((v) => {
      if (v === except) return;
      if (isFeedMediaEl(v)) {
        if (!except) {
          try {
            if (!v.paused) v.pause();
          } catch (_) {}
        }
        return;
      }
      silenceFeedVideo(v, { unload: true });
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
    const isAudio = video.tagName === "AUDIO";
    // Prefer a real frame (videoWidth>0). readyState alone can be true for audio-first demux.
    // For <audio>, readyState is enough (no videoWidth).
    const isFrameReady = () =>
      isAudio
        ? video.readyState >= 2
        : video.readyState >= 2 && (video.videoWidth > 0 || video.readyState >= 3);
    if (isFrameReady()) return Promise.resolve(true);
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
        if (isFrameReady()) fin(true);
        // metadata-only still useful as soft progress; don't finish early on mobile
        else if (!isAudio && video.readyState >= 2 && video.videoWidth > 0) fin(true);
        else if (isAudio && video.readyState >= 1) fin(true);
      };
      const onErr = () => fin(false);
      const events = ["loadeddata", "canplay", "canplaythrough", "loadedmetadata", "playing"];
      events.forEach((ev) => video.addEventListener(ev, onReady));
      video.addEventListener("error", onErr);
      const timer = setTimeout(() => fin(video.readyState >= 2 || video.readyState >= 1), timeoutMs);
      // already progressing
      onReady();
    });
  }

  async function playVideoRobust(media, gen) {
    if (!media || (media.tagName !== "VIDEO" && media.tagName !== "AUDIO")) return false;
    const alive = () =>
      media.isConnected &&
      String(media.dataset.playGen || "0") === String(gen) &&
      media.dataset.userPaused !== "1";

    if (!alive()) return false;

    const attempt = async () => {
      if (!alive()) return false;
      try {
        await media.play();
        return alive() && !media.paused;
      } catch (_) {
        return false;
      }
    };

    const want = !!state.wantSound;
    // Unlocked = user has unmuted once on THIS element lineage (shared player)
    const unlocked = !!(state.audioUnlocked || state.wantSound);

    // Preferred path after unlock: play WITH sound first (same element keeps privilege)
    if (want && unlocked) {
      setVideoMutedProg(media, false);
      if (await attempt()) {
        markAudioUnlocked();
        return true;
      }
      await waitVideoReady(media, isMobileFeedClient() ? 5000 : 8000);
      if (!alive()) return false;
      setVideoMutedProg(media, false);
      if (await attempt()) {
        markAudioUnlocked();
        return true;
      }
      // Policy blocked this moment — muted so picture continues; next gesture unlocks again
      setVideoMutedProg(media, true);
      if (await attempt()) return true;
      return false;
    }

    // Cold start / still muted preference
    setVideoMutedProg(media, true);
    if (await attempt()) return true;
    await waitVideoReady(media, isMobileFeedClient() ? 6000 : 8000);
    if (!alive()) return false;
    setVideoMutedProg(media, true);
    return attempt();
  }

  /** Soft retry only — never full activate (that was the sound-on loading thrash). */
  function scheduleActivateRetry(slideEl, id, reason) {
    if (!slideEl || !id) return;
    clearTimeout(state._activateRetryTimer);
    const n = (state._activateRetryCount || 0) + 1;
    if (n > 2) {
      state._activateRetryCount = 0;
      return;
    }
    state._activateRetryCount = n;
    state._activateRetryTimer = setTimeout(() => {
      if (state.view !== "feed") return;
      if (String(state.activeFeedId) !== String(id)) return;
      const el =
        (slideEl.isConnected && slideEl) ||
        document.querySelector(`#feedScroller .snap-slide[data-id="${id}"]`);
      if (!el) return;
      const v = el.querySelector("video");
      if (!v || v.dataset.userPaused === "1") return;
      if (!v.paused && v.classList.contains("is-ready")) {
        state._activateRetryCount = 0;
        setSlideLoading(el, false);
        return;
      }
      console.debug("activate soft retry", reason, n, id);
      softResumeFeedVideo(v);
      if (!v.paused) {
        v.classList.add("is-ready");
        setSlideLoading(el, false);
        state._activateRetryCount = 0;
      }
    }, 400 + n * 300);
  }

  /** Hide spinner / mark ready. Never load() or toggle mute in a thrashy way. */
  function revealFeedVideo(media, slideEl, { epoch, id, gen } = {}) {
    if (!media || !slideEl) return false;
    if (epoch != null && epoch !== state.playEpoch) return false;
    if (id != null && String(state.activeFeedId) !== String(id)) return false;
    if (gen != null && String(media.dataset.playGen || "0") !== String(gen)) return false;
    if (!media.isConnected || !slideEl.isConnected) return false;
    try {
      applyMediaStageFit(media);
      media.classList.add("is-ready");
      setSlideLoading(slideEl, false);
      const muteBtn = slideEl.querySelector("[data-act='mute']");
      if (muteBtn) syncMuteBtn(muteBtn);
      state._activateRetryCount = 0;
      state._stuckSince = 0;
      state._stuckRecoverCount = 0;
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Single-stream activate:
   * - Only after scroll settle (caller), unless opts.force (cold start)
   * - Unload every other video first
   * - Load current only; stay black + loading spinner until playing from t≈0
   * - Never prefetch next media blob (playlist tail is separate)
   */
  async function activateFeedSlide(slideEl, opts = {}) {
    if (!slideEl || !slideEl.isConnected) return;
    const force = !!opts.force;
    const fromUser = !!opts.fromUserScroll;
    if (state._feedCompacting && !force && !fromUser) return;
    if (!force && !fromUser && state._feedScrolling) return;

    const wantId = String(slideEl.dataset.id || "");
    const lockedId = getLockedFeedId();
    const curId = state.activeFeedId != null ? String(state.activeFeedId) : null;

    // ── Rule: only user swipe may change clip ──
    if (wantId && curId && wantId !== curId) {
      if (!fromUser) {
        // Orient/resize/IO/retry must never switch
        hardSnapToFeedId(lockedId || curId, {
          stayLocked: isFeedIdentityLocked(),
        });
        return;
      }
      if (lockedId != null && wantId !== lockedId) {
        hardSnapToFeedId(lockedId, { stayLocked: true });
        return;
      }
    }
    if (lockedId != null && wantId && wantId !== lockedId) {
      hardSnapToFeedId(lockedId, { stayLocked: true });
      return;
    }
    if ((isOrientLockActive() || state._viewportResizing) && !force && !fromUser) return;
    if (force) state._feedScrolling = false;

    const id = wantId;
    const index = Number(slideEl.dataset.index || 0);
    // Commit only for user swipe, or first cold start (no committed yet)
    if (id && (fromUser || !getCommittedFeedId())) {
      commitFeedId(id, index);
    }
    const stage = slideEl.querySelector(".media-stage");
    if (!stage) return;

    const kind = (stage.getAttribute("data-kind") || "").toLowerCase();
    const isAudioSlide = kind === "audio";
    const isVideoSlide =
      !isAudioSlide &&
      (kind === "video" ||
        !!stage.querySelector("video") ||
        (!stage.querySelector("img") && !!stage.getAttribute("data-src")));

    // —— Audio slides (shared <audio> + progress chrome) ——
    if (isAudioSlide) {
      const src = stage.getAttribute("data-src") || "";
      if (!src) return;

      let media = mountFeedAudioPlayer(slideEl);
      if (!media) return;

      const isDifferentClip =
        !mediaSrcLoaded(media, src) ||
        (media.getAttribute("data-src") && media.getAttribute("data-src") !== src);

      if (
        media.dataset.userPaused !== "1" &&
        mediaSrcLoaded(media, src) &&
        media.getAttribute("src") &&
        media.readyState >= 1 &&
        !media.error
      ) {
        state.activeFeedId = id;
        onSlideActive(index);
        pauseOtherFeedVideos(media);
        if (media.paused) {
          const gen = bumpVideoPlayGen(media);
          await playVideoRobust(media, gen);
        } else if (state.wantSound && media.muted && state.audioUnlocked) {
          setVideoMutedProg(media, false);
          if (media.paused) softResumeFeedVideo(media);
        }
        media.classList.add("is-ready");
        setSlideLoading(slideEl, false);
        return;
      }

      const epoch = ++state.playEpoch;
      state.activeFeedId = id;
      state._feedActivating = true;
      onSlideActive(index);
      setSlideLoading(slideEl, true);
      const releaseActivating = () => {
        if (epoch === state.playEpoch) state._feedActivating = false;
      };
      pauseOtherFeedVideos(media);
      media = mountFeedAudioPlayer(slideEl) || media;
      if (isDifferentClip) media.dataset.userPaused = "0";
      if (media.dataset.userPaused === "1") {
        setSlideLoading(slideEl, false);
        releaseActivating();
        return;
      }
      const gen = bumpVideoPlayGen(media);
      try {
        media.classList.remove("is-ready");
      } catch (_) {}
      media.setAttribute("data-src", src);
      media.preload = "auto";
      try {
        const needForce =
          !!media.error ||
          !media.getAttribute("src") ||
          !mediaSrcLoaded(media, src) ||
          isDifferentClip;
        const ok = await loadMediaEl(media, src, { force: needForce });
        if (!ok || epoch !== state.playEpoch || state.activeFeedId !== id) {
          releaseActivating();
          return;
        }
        let played = await playVideoRobust(media, gen);
        if (!played && epoch === state.playEpoch && media.isConnected && !media.paused) {
          played = true;
        }
        if (!played || epoch !== state.playEpoch || state.activeFeedId !== id) {
          releaseActivating();
          return;
        }
        if (state.wantSound && !media.muted) markAudioUnlocked();
        media.classList.add("is-ready");
        setSlideLoading(slideEl, false);
        state._activateRetryCount = 0;
      } finally {
        releaseActivating();
      }
      return;
    }

    // —— Image slides ——
    if (!isVideoSlide) {
      parkFeedPlayer();
      parkFeedAudio();
      let media = stage.querySelector("img");
      if (!media) return;
      const srcHint = media.getAttribute("data-src") || "";
      if (mediaSrcLoaded(media, srcHint) && media.naturalWidth > 0) {
        state.activeFeedId = id;
        applyMediaStageFit(media);
        setSlideLoading(slideEl, false);
        onSlideActive(index);
        return;
      }
      const epoch = ++state.playEpoch;
      state.activeFeedId = id;
      state._feedActivating = true;
      onSlideActive(index);
      setSlideLoading(slideEl, true);
      try {
        pauseOtherFeedVideos(null);
        const src = media.getAttribute("data-src");
        if (src && !mediaSrcLoaded(media, src)) await loadMediaEl(media, src);
        if (epoch !== state.playEpoch || state.activeFeedId !== id) return;
        if (media.complete && media.naturalWidth > 0) {
          applyMediaStageFit(media);
          setSlideLoading(slideEl, false);
        } else {
          await new Promise((resolve) => {
            let done = false;
            const fin = () => {
              if (done) return;
              done = true;
              media.removeEventListener("load", fin);
              media.removeEventListener("error", fin);
              resolve();
            };
            media.addEventListener("load", fin);
            media.addEventListener("error", fin);
            setTimeout(fin, 8000);
          });
          if (epoch === state.playEpoch && state.activeFeedId === id) {
            applyMediaStageFit(media);
            setSlideLoading(slideEl, false);
          }
        }
      } finally {
        if (epoch === state.playEpoch) state._feedActivating = false;
      }
      return;
    }

    // —— Video: mount singleton player into this slide ——
    const src =
      stage.getAttribute("data-src") ||
      slideEl.querySelector("video")?.getAttribute("data-src") ||
      "";
    if (!src) return;

    let media = mountFeedPlayer(slideEl);
    if (!media) return;

    // Same clip already loaded & ready → soft resume (keep sound unlock)
    // After L→P, first switch to a *different* clip must not take soft path on stale buffer
    const isDifferentClip =
      !mediaSrcLoaded(media, src) ||
      (media.getAttribute("data-src") &&
        media.getAttribute("data-src") !== src);
    const forcePostOrient =
      !!state._postOrientReload &&
      (isDifferentClip || String(state.activeFeedId) !== String(id));

    if (
      !forcePostOrient &&
      media.dataset.userPaused !== "1" &&
      mediaSrcLoaded(media, src) &&
      media.getAttribute("src") &&
      media.readyState >= 1 &&
      !media.error
    ) {
      state.activeFeedId = id;
      onSlideActive(index);
      pauseOtherFeedVideos(media);
      stripDistantFeedVideos(index);
      if (media.paused) {
        const gen = bumpVideoPlayGen(media);
        await playVideoRobust(media, gen);
      } else if (state.wantSound && media.muted && state.audioUnlocked) {
        setVideoMutedProg(media, false);
        if (media.paused) {
          softResumeFeedVideo(media);
        }
      }
      applyMediaStageFit(media);
      media.classList.add("is-ready");
      setSlideLoading(slideEl, false);
      return;
    }

    const epoch = ++state.playEpoch;
    state.activeFeedId = id;
    state._feedActivating = true;
    onSlideActive(index);
    if (!slideEl.isConnected) {
      if (epoch === state.playEpoch) state._feedActivating = false;
      return;
    }

    setSlideLoading(slideEl, true);
    const releaseActivating = () => {
      if (epoch === state.playEpoch) state._feedActivating = false;
    };

    pauseOtherFeedVideos(media);
    stripDistantFeedVideos(index);

    // Re-mount in case compact moved DOM
    media = mountFeedPlayer(slideEl) || media;

    // Clear sticky userPaused from orient thrash when switching clips
    if (forcePostOrient || isDifferentClip) {
      media.dataset.userPaused = "0";
    }

    if (media.dataset.userPaused === "1") {
      setSlideLoading(slideEl, false);
      releaseActivating();
      return;
    }

    const gen = bumpVideoPlayGen(media);
    try {
      media.classList.remove("is-ready");
      media.removeAttribute("poster");
    } catch (_) {}

    media.setAttribute("data-src", src);
    media.preload = "auto";

    try {
      const needForce =
        !!media.error ||
        !media.getAttribute("src") ||
        !mediaSrcLoaded(media, src) ||
        forcePostOrient ||
        isDifferentClip;
      const ok = await loadMediaEl(media, src, { force: needForce });
      if (!ok || epoch !== state.playEpoch || state.activeFeedId !== id) {
        releaseActivating();
        if (epoch === state.playEpoch && state.activeFeedId === id) {
          scheduleActivateRetry(slideEl, id, "load-fail");
        }
        return;
      }
      if (epoch !== state.playEpoch || state.activeFeedId !== id) {
        releaseActivating();
        return;
      }
      if (String(media.dataset.playGen) !== String(gen)) {
        releaseActivating();
        return;
      }

      applyMediaStageFit(media);

      let played = await playVideoRobust(media, gen);
      if (
        !played &&
        epoch === state.playEpoch &&
        media.isConnected &&
        !media.paused
      ) {
        played = true;
      }

      if (!played || epoch !== state.playEpoch || state.activeFeedId !== id) {
        releaseActivating();
        if (epoch === state.playEpoch && state.activeFeedId === id) {
          scheduleActivateRetry(slideEl, id, "play-fail");
        }
        return;
      }

      if (state.wantSound && !media.muted) markAudioUnlocked();

      // Successfully started a clip after orient → clear one-shot reload flag
      if (forcePostOrient || isDifferentClip) {
        state._postOrientReload = false;
      }

      const reveal = () => revealFeedVideo(media, slideEl, { epoch, id, gen });
      reveal();
      if (media.readyState < 2 || !media.videoWidth) {
        const onFrame = () => {
          media.removeEventListener("loadeddata", onFrame);
          media.removeEventListener("playing", onFrame);
          reveal();
        };
        media.addEventListener("loadeddata", onFrame);
        media.addEventListener("playing", onFrame);
        setTimeout(onFrame, 400);
      }
    } finally {
      releaseActivating();
    }
  }

  /** Disabled: single-stream policy forbids warming the next item. */
  function prefetchFeedAround(_index) {
    /* intentionally empty */
  }

  /**
   * Pick the slide closest to the scroller viewport center.
   * Fallback when IntersectionObserver misses threshold edges (Edge mobile).
   */
  function syncActiveFromScroll() {
    const scroller = $("#feedScroller");
    if (!scroller || state.view !== "feed") return;
    if (state._feedScrolling) return;

    // Locked / layout: pin only, never switch
    if (isFeedIdentityLocked() || state._viewportResizing || state._programmaticScroll) {
      const lockId = getLockedFeedId() || state.activeFeedId;
      if (lockId != null) {
        hardSnapToFeedId(lockId, { stayLocked: isFeedIdentityLocked() });
      }
      state._userScrollPending = false;
      return;
    }

    // Not a user gesture settle (e.g. residual scroll after unlock) → pin current only
    if (!state._userScrollPending) {
      if (state.activeFeedId != null) {
        hardSnapToFeedId(state.activeFeedId, { stayLocked: false });
      }
      return;
    }
    state._userScrollPending = false;

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

    // Mid-page: snap to current active (user can fling again)
    if (bestDist > root.height * 0.2) {
      if (state.activeFeedId != null) hardSnapToFeedId(state.activeFeedId, { stayLocked: false });
      return;
    }

    const id = String(best.dataset.id || "");
    // User swipe settled → only place that may change clip
    activateFeedSlide(best, {
      fromUserScroll: true,
      force: !!state._postOrientReload && String(state.activeFeedId) !== id,
    });
  }

  function bindFeedScrollSync() {
    const scroller = $("#feedScroller");
    if (!scroller || scroller.dataset.scrollSyncBound === "1") return;
    scroller.dataset.scrollSyncBound = "1";
    let settleTimer = null;
    const onSettle = () => {
      if (
        state._programmaticScroll ||
        isOrientLockActive() ||
        state._viewportResizing ||
        isFeedIdentityLocked()
      ) {
        state._feedScrolling = false;
        state._userScrollPending = false;
        const id = getLockedFeedId() || state.activeFeedId;
        if (id != null) hardSnapToFeedId(id, { stayLocked: isFeedIdentityLocked() });
        return;
      }
      state._feedScrolling = false;
      requestAnimationFrame(() => {
        if (
          state._programmaticScroll ||
          state._feedCompacting ||
          isOrientLockActive() ||
          state._viewportResizing
        ) {
          return;
        }
        syncActiveFromScroll();
        scheduleFeedGc(isMobileFeedClient() ? 1200 : 220);
      });
    };
    scroller.addEventListener(
      "scroll",
      () => {
        if (
          state._programmaticScroll ||
          state._feedCompacting ||
          state._viewportResizing ||
          isOrientLockActive() ||
          isFeedIdentityLocked()
        ) {
          return;
        }
        // Real user finger scroll only
        state._feedScrolling = true;
        state._userScrollPending = true;
        clearTimeout(settleTimer);
        settleTimer = setTimeout(onSettle, isMobileFeedClient() ? 180 : 100);
      },
      { passive: true }
    );
    scroller.addEventListener(
      "scrollend",
      () => {
        if (
          state._programmaticScroll ||
          state._feedCompacting ||
          state._viewportResizing ||
          isOrientLockActive() ||
          isFeedIdentityLocked()
        ) {
          return;
        }
        clearTimeout(settleTimer);
        onSettle();
      },
      { passive: true }
    );
  }

  function observeFeedMedia(opts = {}) {
    const slides = [...document.querySelectorAll("#feedScroller .snap-slide")];
    if (state._feedIo) {
      try {
        state._feedIo.disconnect();
      } catch (_) {}
    }
    bindFeedScrollSync();
    // Single authority for "which slide is active": scroll settle (syncActiveFromScroll).
    // IO only pauses non-active videos leaving the viewport — avoids double-activate thrash.
    const io = new IntersectionObserver(
      (entries) => {
        // During rotate / immersive exit, never pause — layout thrash lies about ratios
        if (isPlaybackGuarded()) return;
        for (const en of entries) {
          if (en.isIntersecting && en.intersectionRatio >= 0.6) continue;
          if (en.isIntersecting && en.intersectionRatio >= 0.35) continue;
          const el = en.target;
          const media = el.querySelector(".media-stage video");
          if (!media) continue;
          if (String(el.dataset.id) === String(state.activeFeedId)) continue;
          // Never pause the shared feed player via IO (even if id mismatch mid-move)
          if (isFeedPlayer(media)) continue;
          try {
            if (!media.paused) media.pause();
          } catch (_) {}
        }
      },
      { root: $("#feedScroller"), threshold: [0, 0.35, 0.6, 1] }
    );
    state._feedIo = io;
    slides.forEach((s) => io.observe(s));
    if (!opts.skipAutoActivate) {
      requestAnimationFrame(() => {
        syncActiveFromScroll();
        if (!state.activeFeedId) {
          const first = document.querySelector("#feedScroller .snap-slide");
          if (first) activateFeedSlide(first, { force: true });
        }
      });
    }
  }

  async function loadMediaEl(el, url, opts = {}) {
    if (!url) return false;
    const authed = withAuthQuery(url);
    const force = !!opts.force;

    // VIDEO / AUDIO: never fetch-as-blob (breaks Range / OOM on mobile). Use native src + Range.
    if (el.tagName === "VIDEO" || el.tagName === "AUDIO") {
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
        if (el.tagName === "VIDEO") {
          el.setAttribute("playsinline", "");
          el.setAttribute("webkit-playsinline", "");
          el.playsInline = true;
        }
        const light = !!opts.prefetch || !!opts.light;
        if (light) {
          el.preload = "metadata";
        } else if (!el.getAttribute("preload") || el.preload === "none") {
          el.preload = "auto";
        }
        const prevSrc = el.getAttribute("src") || "";
        el.src = authed;
        el.dataset.loadedSrc = url;
        // Only call load() when src actually changes (iOS: load() is expensive)
        if (force || prevSrc !== authed) {
          if (typeof el.load === "function") el.load();
        }
        // Prefetch: non-blocking; active play waits for a frame.
        if (light) {
          return true;
        }
        // Wait for a decodable frame when possible. readyState>=1 alone still
        // leaves mobile UAs in "audio first / black video" longer.
        await waitVideoReady(el, isMobileFeedClient() ? 9000 : 10000);
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
    if (type === "audio") {
      img.classList.add("cell-thumb-audio");
      img.removeAttribute("src");
      img.alt = "audio";
      return;
    }
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
    let el;
    if (type === "image" || type === "gif") {
      el = document.createElement("img");
    } else if (type === "audio") {
      el = document.createElement("audio");
      el.controls = true;
      el.autoplay = true;
      el.className = "lb-audio";
      applySoundToVideo(el);
    } else {
      el = document.createElement("video");
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
      if (el.tagName === "VIDEO" || el.tagName === "AUDIO") {
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
    body.querySelectorAll("video, audio").forEach((media) => {
      try {
        media.pause();
        media.removeAttribute("src");
        media.load();
      } catch (_) {}
    });
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
    try {
      clearChromeHidden();
    } catch (_) {}
    try {
      // Leaving feed: drop phone-landscape immersive shell
      document.body.classList.remove("lmw-phone-landscape");
      state._landscapeImmersive = false;
      state._landscapeFsRequested = false;
      state._pendingLandscapeFs = false;
    } catch (_) {}
    try {
      stopAllGridPreviews();
    } catch (_) {}
    if (name === "search" && state.view !== "search") {
      state.prevView = state.view && state.view !== "search" ? state.view : "feed";
    }
    // leaving feed: stop audio
    if (state.view === "feed" && name !== "feed") {
      try {
        pauseOtherFeedVideos(null);
      } catch (_) {}
    }
    state.view = name;
    document.body.classList.toggle("search-open", name === "search");
    // PWA standalone: feed locks viewport; other views need page scroll
    document.body.classList.toggle("is-scroll-page", name !== "feed");
    document.querySelectorAll(".topnav .nav").forEach((b) => {
      b.classList.toggle("active", b.dataset.view === name);
    });
    ["feed", "grid", "admin", "search"].forEach((v) => {
      const el = document.getElementById(`view-${v}`);
      if (el) el.classList.toggle("hide", v !== name);
    });
    if (name === "admin") {
      try {
        refreshAdmin();
      } catch (e) {
        console.error("refreshAdmin", e);
      }
    }
    if (name === "search") {
      try {
        onEnterSearchPage();
      } catch (e) {
        console.error("onEnterSearchPage", e);
      }
    } else if (name === "feed") {
      // Leaving feed pauses the shared player; pin-only scroll sync does not resume.
      // Force re-activate the committed slide (respects userPaused).
      const resumeFeedAfterView = () => {
        try {
          if (state.view !== "feed") return;
          const scroller = document.getElementById("feedScroller");
          if (!scroller) return;
          const id = getCommittedFeedId() || state.activeFeedId;
          let slide =
            id != null
              ? scroller.querySelector(`.snap-slide[data-id="${id}"]`)
              : null;
          if (!slide) {
            slide = scroller.querySelector(
              `.snap-slide[data-index="${state.feedIndex | 0}"]`
            );
          }
          if (!slide) {
            syncActiveFromScroll();
            return;
          }
          pinFeedIdOnce(id || slide.dataset.id, { stayLocked: false });
          activateFeedSlide(slide, { force: true });
        } catch (e) {
          console.error("resume feed after view", e);
        }
      };
      // Double rAF: wait until #view-feed is painted after .hide removal
      requestAnimationFrame(() => requestAnimationFrame(resumeFeedAfterView));
    }
  }

  /* —— Search history (local) —— */
  function getSearchHistory() {
    try {
      const raw = JSON.parse(localStorage.getItem(searchHistoryKey) || "[]");
      return Array.isArray(raw) ? raw.filter((x) => typeof x === "string" && x.trim()).slice(0, 20) : [];
    } catch (_) {
      return [];
    }
  }

  function pushSearchHistory(q) {
    const t = String(q || "").trim();
    if (!t) return;
    const list = getSearchHistory().filter((x) => x.toLowerCase() !== t.toLowerCase());
    list.unshift(t);
    localStorage.setItem(searchHistoryKey, JSON.stringify(list.slice(0, 20)));
  }

  function clearSearchHistory() {
    localStorage.removeItem(searchHistoryKey);
  }

  function renderSearchChips(container, items, { withCount = false } = {}) {
    if (!container) return;
    if (!items || !items.length) {
      container.innerHTML = `<span class="muted" style="font-size:13px">暂无</span>`;
      return;
    }
    container.innerHTML = items
      .map((it) => {
        if (typeof it === "string") {
          return `<button type="button" class="search-chip" data-q="${escapeHtml(it)}">${escapeHtml(it)}</button>`;
        }
        const name = it.name || it.q || "";
        const cnt = withCount && it.count != null ? `<span class="cnt">${it.count}</span>` : "";
        return `<button type="button" class="search-chip" data-q="${escapeHtml(name)}">${escapeHtml(name)}${cnt}</button>`;
      })
      .join("");
    container.querySelectorAll(".search-chip[data-q]").forEach((btn) => {
      btn.onclick = () => {
        const q = btn.getAttribute("data-q") || "";
        const input = $("#searchInput");
        if (input) input.value = q;
        syncSearchClearBtn();
        runSearch(q, { reset: true });
      };
    });
  }

  function renderSearchHistoryUI() {
    const hist = getSearchHistory();
    const block = $("#searchHistoryBlock");
    if (block) block.classList.toggle("hide", !hist.length);
    renderSearchChips($("#searchHistory"), hist);
  }

  async function loadHotTags() {
    const box = $("#searchHotTags");
    if (!box) return;
    try {
      const data = await api("/api/tags?limit=24");
      const tags = data.tags || [];
      renderSearchChips(box, tags, { withCount: true });
    } catch (_) {
      box.innerHTML = `<span class="muted" style="font-size:13px">标签加载失败</span>`;
    }
  }

  function syncSearchClearBtn() {
    const input = $("#searchInput");
    const clear = $("#btnSearchClear");
    if (!input || !clear) return;
    clear.classList.toggle("hide", !(input.value || "").trim());
  }

  function onEnterSearchPage() {
    renderSearchHistoryUI();
    loadHotTags();
    const input = $("#searchInput");
    if (input) {
      // focus after paint (mobile soft keyboard)
      requestAnimationFrame(() => {
        try {
          input.focus({ preventScroll: true });
        } catch (_) {
          input.focus();
        }
      });
    }
    syncSearchClearBtn();
    // restore last result UI if any
    if (state.searchQ) {
      $("#searchDiscover")?.classList.add("hide");
      $("#searchResultHead")?.classList.remove("hide");
    } else {
      $("#searchDiscover")?.classList.remove("hide");
      $("#searchResultHead")?.classList.add("hide");
      $("#searchEmpty")?.classList.add("hide");
    }
  }

  function openSearchPage(prefill) {
    try {
      if (state.view !== "search") state.prevView = state.view || "feed";
      setView("search");
      if (prefill != null && prefill !== "") {
        const input = document.getElementById("searchInput");
        if (input) input.value = String(prefill);
        syncSearchClearBtn();
        runSearch(String(prefill), { reset: true });
      }
    } catch (e) {
      console.error("openSearchPage", e);
      try {
        showToast("打开搜索失败");
      } catch (_) {}
    }
  }

  function closeSearchPage() {
    const back = state.prevView && state.prevView !== "search" ? state.prevView : "feed";
    setView(back);
  }

  /**
   * Media list search — same API as manage page: title / URL / tags via `q`.
   */
  async function runSearch(q, { reset = true } = {}) {
    const query = String(q ?? $("#searchInput")?.value ?? "").trim();
    state.searchQ = query;
    const discover = $("#searchDiscover");
    const head = $("#searchResultHead");
    const empty = $("#searchEmpty");
    const moreWrap = $("#searchMoreWrap");
    const meta = $("#searchResultMeta");
    const grid = $("#searchGrid");

    if (!query) {
      state.searchItems = [];
      state.searchTotal = 0;
      state.searchOffset = 0;
      if (grid) grid.innerHTML = "";
      discover?.classList.remove("hide");
      head?.classList.add("hide");
      empty?.classList.add("hide");
      moreWrap?.classList.add("hide");
      renderSearchHistoryUI();
      return;
    }

    if (state.searchLoading) return;
    state.searchLoading = true;
    discover?.classList.add("hide");
    head?.classList.remove("hide");
    if (reset) {
      state.searchOffset = 0;
      state.searchItems = [];
      if (grid) grid.innerHTML = "";
      if (meta) meta.textContent = "搜索中…";
      empty?.classList.add("hide");
    }

    try {
      const limit = 48;
      const offset = reset ? 0 : state.searchOffset;
      const params = new URLSearchParams({
        q: query,
        sort: "new",
        limit: String(limit),
        offset: String(offset),
        include_restricted: state.includeRestricted ? "true" : "false",
      });
      const data = await api(`/api/media?${params}`);
      const items = data.items || [];
      const total = data.total ?? items.length;
      if (reset) {
        state.searchItems = items;
        pushSearchHistory(query);
        renderSearchHistoryUI();
      } else {
        state.searchItems = state.searchItems.concat(items);
      }
      state.searchTotal = total;
      state.searchOffset = offset + items.length;
      renderSearchResults();
      if (meta) {
        meta.textContent = total
          ? `「${query}」共 ${total} 条 · 已加载 ${state.searchItems.length}`
          : `「${query}」无结果`;
      }
      empty?.classList.toggle("hide", state.searchItems.length > 0);
      moreWrap?.classList.toggle("hide", state.searchItems.length >= total || !items.length);
    } catch (e) {
      if (meta) meta.textContent = "搜索失败: " + e.message;
      empty?.classList.remove("hide");
      if (empty) empty.textContent = "搜索失败: " + e.message;
    } finally {
      state.searchLoading = false;
    }
  }

  function renderSearchResults() {
    const grid = $("#searchGrid");
    if (!grid) return;
    const items = state.searchItems || [];
    stopAllGridPreviews();
    grid.innerHTML = items
      .map((item) => {
        const motion = isGridMotionType(item.media_type) ? " cell-has-motion" : "";
        const tags = (item.tags || []).slice(0, 3).map((t) => "#" + t).join(" ");
        const tip = [item.title || "", tags].filter(Boolean).join(" · ") || "单击进入 Feed 播放";
        return `<div class="cell${motion}" data-id="${item.id}" title="${escapeHtml(tip)}">
          <img class="cell-thumb" alt="" data-thumb="${thumbUrl(item)}" data-file="${fileUrl(item)}" data-type="${item.media_type}" />
          ${isGridMotionType(item.media_type) ? `<span class="cell-play-hint" aria-hidden="true">▶</span>` : ""}
          <span class="tag">${escapeHtml(item.media_type)}${item.liked ? " · ♥" : ""}${tags ? " · " + escapeHtml(tags) : ""}</span>
        </div>`;
      })
      .join("");
    grid.querySelectorAll("img.cell-thumb").forEach((img) => loadGridStaticThumb(img));
    grid.querySelectorAll(".cell").forEach((cell) => {
      bindGridHoverPreview(cell);
      cell.addEventListener("click", () => {
        stopAllGridPreviews();
        const id = Number(cell.dataset.id);
        if (!id) return;
        // Same full-screen Feed UI & gestures as normal browsing
        openSearchResultInFeed(id);
      });
    });
  }

  async function refreshAdminMedia() {
    const box = document.getElementById("adminMedia");
    const meta = document.getElementById("adminMediaMeta");
    const input = document.getElementById("adminMediaQ");
    // Always prefer live input value so Search button / debounce can't desync
    if (input) state.adminMediaQ = input.value || "";
    const q = (state.adminMediaQ || "").trim();
    try {
      if (meta) meta.textContent = q ? `搜索「${q}」…` : "加载中…";
      const params = new URLSearchParams({ limit: "100", sort: "new" });
      if (q) params.set("q", q);
      const data = await api(`/api/media?${params}`);
      const items = data.items || [];
      const total = data.total ?? items.length;
      if (meta) {
        meta.textContent = q
          ? `搜索「${q}」· 共 ${total} 条（显示前 ${items.length}）`
          : `共 ${total} 条（显示前 ${items.length}）`;
      }
      if (!box) return;
      box.innerHTML =
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
          .join("") || `<div class='muted'>${q ? "无匹配媒体" : "暂无媒体"}</div>`;
      box.querySelectorAll(".admin-thumb").forEach((img) => {
        loadMediaEl(img, img.dataset.src);
      });
      box.querySelectorAll("[data-adel]").forEach((b) => {
        b.onclick = async () => {
          const id = Number(b.dataset.adel);
          if (!confirm(`确定删除媒体 #${id}？不可恢复。`)) return;
          await api(`/api/media/${id}`, { method: "DELETE" });
          await refreshAdminMedia();
          await loadFeed();
        };
      });
    } catch (e) {
      console.error("refreshAdminMedia", e);
      if (meta) meta.textContent = "搜索失败";
      if (box) box.innerHTML = `<div class="muted" style="color:var(--danger)">加载失败: ${escapeHtml(e.message || e)}</div>`;
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

  function debounce(fn, ms) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function bind() {
    // —— Global click delegation (survives re-renders; capture beats feed layer) ——
    if (!document.documentElement.dataset.lmwSearchBound) {
      document.documentElement.dataset.lmwSearchBound = "1";
      document.addEventListener(
        "click",
        (e) => {
          const t = e.target;
          if (!t || !t.closest) return;
          const openBtn = t.closest("#btnOpenSearch, [data-action='open-search']");
          if (openBtn) {
            e.preventDefault();
            e.stopPropagation();
            openSearchPage();
            return;
          }
          if (t.closest("#btnSearchBack")) {
            e.preventDefault();
            e.stopPropagation();
            closeSearchPage();
            return;
          }
          if (t.closest("#btnSearchSubmit")) {
            e.preventDefault();
            e.stopPropagation();
            const v = (document.getElementById("searchInput") || {}).value || "";
            runSearch(v, { reset: true });
            return;
          }
          if (t.closest("#btnSearchClear")) {
            e.preventDefault();
            const input = document.getElementById("searchInput");
            if (input) input.value = "";
            syncSearchClearBtn();
            runSearch("", { reset: true });
            if (input) input.focus();
            return;
          }
          if (t.closest("#btnClearHistory")) {
            e.preventDefault();
            clearSearchHistory();
            renderSearchHistoryUI();
            return;
          }
          if (t.closest("#btnSearchMore")) {
            e.preventDefault();
            runSearch(state.searchQ, { reset: false });
            return;
          }
          if (t.closest("#btnAdminMediaSearch")) {
            e.preventDefault();
            e.stopPropagation();
            const adminQ = document.getElementById("adminMediaQ");
            state.adminMediaQ = (adminQ && adminQ.value) || "";
            refreshAdminMedia();
            return;
          }
        },
        true
      );
    }

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

    // —— Search input (enter / clear-on-empty) ——
    const searchInput = document.getElementById("searchInput");
    if (searchInput && searchInput.dataset.bound !== "1") {
      searchInput.dataset.bound = "1";
      searchInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          runSearch(searchInput.value, { reset: true });
        }
        if (e.key === "Escape") {
          if ((searchInput.value || "").trim()) {
            searchInput.value = "";
            syncSearchClearBtn();
            runSearch("", { reset: true });
          } else {
            closeSearchPage();
          }
        }
      });
      searchInput.addEventListener("input", () => {
        syncSearchClearBtn();
        if (!(searchInput.value || "").trim() && state.searchQ) {
          runSearch("", { reset: true });
        }
      });
    }

    // —— Admin media library search ——
    const adminQ = document.getElementById("adminMediaQ");
    const runAdminSearch = debounce(() => {
      state.adminMediaQ = (adminQ && adminQ.value) || "";
      refreshAdminMedia();
    }, 320);
    if (adminQ && adminQ.dataset.bound !== "1") {
      adminQ.dataset.bound = "1";
      adminQ.addEventListener("input", runAdminSearch);
      adminQ.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          state.adminMediaQ = adminQ.value || "";
          refreshAdminMedia();
        }
      });
    }

    const btnSaveToken = $("#btnSaveToken");
    if (btnSaveToken) {
      btnSaveToken.onclick = () => {
        localStorage.setItem(tokenKey, ($("#tokenInput") && $("#tokenInput").value.trim()) || "");
        alert("已保存");
      };
    }
    const restrictedToggle = document.getElementById("includeRestrictedToggle");
    if (restrictedToggle) {
      restrictedToggle.checked = !!state.includeRestricted;
      restrictedToggle.addEventListener("change", async () => {
        state.includeRestricted = !!restrictedToggle.checked;
        localStorage.setItem(includeRestrictedKey, state.includeRestricted ? "1" : "0");
        showToast(
          state.includeRestricted
            ? "已开启限制级内容"
            : "已隐藏限制级内容"
        );
        try {
          await loadFeed({ quiet: true });
          if (state.view === "grid") await renderGridQuiet();
          if (state.view === "search" && (state.searchQ || "").trim()) {
            await runSearch(state.searchQ, { reset: true });
          }
        } catch (e) {
          console.warn("restricted filter refresh", e);
        }
      });
    }
    const btnRescan = $("#btnRescan");
    if (btnRescan) {
      btnRescan.onclick = async () => {
        const r = await api("/api/rescan", { method: "POST" });
        alert(`扫描完成\n新增 ${r.added ?? 0} · 跳过 ${r.skipped ?? 0}`);
        await loadFeed();
        await refreshAdminMedia();
      };
    }
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
    const btnRefreshJobs = $("#btnRefreshJobs");
    if (btnRefreshJobs) btnRefreshJobs.onclick = () => refreshAdmin();
    const btnRefreshMedia = $("#btnRefreshMedia");
    if (btnRefreshMedia) btnRefreshMedia.onclick = () => refreshAdminMedia();
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
    const lbClose = $("#lbClose");
    if (lbClose) {
      lbClose.onclick = (e) => {
        e.stopPropagation();
        closeLightbox();
      };
    }
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
        if (state.view === "search") {
          // input handler also covers clear; global Esc closes search when not typing focus
          if (document.activeElement !== $("#searchInput")) {
            closeSearchPage();
            return;
          }
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

  /**
   * PWA / home-screen standalone: same app, no Safari URL+tab chrome.
   * No service worker — personal LAN app; avoid stale media caches.
   */
  function isStandaloneDisplay() {
    try {
      if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) {
        return true;
      }
    } catch (_) {}
    // iOS Safari legacy
    if (typeof navigator !== "undefined" && navigator.standalone === true) return true;
    return false;
  }

  function applyStandaloneClass() {
    if (!isStandaloneDisplay()) return;
    try {
      document.documentElement.classList.add("lmw-standalone");
      document.body.classList.add("lmw-standalone-body");
      document.body.classList.toggle("is-scroll-page", state.view !== "feed");
    } catch (_) {}
  }

  function maybeShowPwaInstallTip() {
    const key = "lmw_pwa_tip_dismissed";
    if (isStandaloneDisplay()) return;
    try {
      if (localStorage.getItem(key) === "1") return;
    } catch (_) {}
    // iPhone / iPad Safari only (where A2HS removes the two bars)
    const ua = navigator.userAgent || "";
    const isIOS =
      /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1);
    if (!isIOS) return;
    if (document.getElementById("lmwPwaTip")) return;

    const tip = document.createElement("div");
    tip.id = "lmwPwaTip";
    tip.className = "lmw-pwa-tip";
    tip.setAttribute("role", "status");
    tip.innerHTML =
      `<div class="lmw-pwa-tip-text">` +
      `<strong>无地址栏全屏：添加到主屏幕</strong>` +
      `<span class="muted">Safari 底部分享 →「添加到主屏幕」，从图标打开即完整 App（Feed/网格/管理），无页签与地址栏。</span>` +
      `</div>` +
      `<button type="button" class="lmw-pwa-tip-x" aria-label="关闭">×</button>`;
    const dismiss = () => {
      try {
        localStorage.setItem(key, "1");
      } catch (_) {}
      tip.remove();
    };
    tip.querySelector(".lmw-pwa-tip-x")?.addEventListener("click", dismiss);
    document.body.appendChild(tip);
  }

  bind();
  applyStandaloneClass();
  // Not ready until first loadFeed finishes — ignore cold-start resize freezes
  state._feedScrollReady = false;
  try {
    bindViewportLayout();
  } catch (e) {
    console.warn("bindViewportLayout", e);
  }
  // Defer tip so first paint / feed load is not blocked
  setTimeout(() => {
    try {
      maybeShowPwaInstallTip();
    } catch (_) {}
  }, 1800);
  loadFeed()
    .then(() => {
      state._feedScrollReady = true;
      forceEnableFeedScroll();
      try {
        const vp0 = detectViewportProfile();
        markOrientSettled(vp0.orientation);
        // Landscape cold open only after feed is ready
        if (vp0.isPhoneLandscape || vp0.isHeadset) {
          // Clear grace so first landscape shell can apply
          state._orientGraceUntil = 0;
          requestAnimationFrame(() => {
            try {
              onViewportLayoutChange();
            } catch (_) {}
          });
        }
      } catch (_) {}
      startLibraryPoll();
    })
    .catch((e) => {
      state._feedScrollReady = true;
      forceEnableFeedScroll();
      try {
        markOrientSettled(detectViewportProfile().orientation);
      } catch (_) {}
      const empty = $("#feedEmpty");
      empty.classList.remove("hide");
      empty.innerHTML = `<div class="empty-card"><p>加载失败</p><p class="muted">${escapeHtml(e.message)}</p></div>`;
    });
})();
