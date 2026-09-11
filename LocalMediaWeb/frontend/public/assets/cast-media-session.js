/**
 * Media Session helpers for DLNA cast lock-screen / headset controls.
 * No volume action (OS hardware keys only). Browser-safe; also loadable in Node.
 */
(function (root) {
  "use strict";

  var ACTIONS = ["play", "pause", "previoustrack", "nexttrack", "seekto"];
  var UNBIND_EXTRA = ["seekbackward", "seekforward", "stop"];
  /** Tiny looping silent WAV so lock-screen controls can attach without local video. */
  var SILENT_WAV =
    "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAAABPAAABAAgAZGF0YQAAAAA=";

  function absUrl(path, origin) {
    if (!path) return "";
    var s = String(path);
    if (/^https?:\/\//i.test(s) || s.indexOf("data:") === 0) return s;
    var base = origin;
    if (!base && typeof location !== "undefined" && location.href) {
      base = location.origin || location.href;
    }
    if (!base) return s;
    try {
      if (typeof URL === "function") return new URL(s, base).href;
    } catch (_) {}
    if (s.charAt(0) === "/") {
      return String(base).replace(/\/$/, "") + s;
    }
    return String(base).replace(/\/?$/, "/") + s;
  }

  function artworkList(thumbUrl, origin) {
    var src = absUrl(thumbUrl, origin);
    if (!src) return [];
    return [{ src: src, sizes: "512x512", type: "image/jpeg" }];
  }

  function buildMetadata(opts) {
    opts = opts || {};
    var id = opts.mediaId != null ? String(opts.mediaId) : "";
    var title = String(opts.title || "").trim() || (id ? "#" + id : "投屏");
    var artist = opts.deviceName
      ? "投屏 · " + String(opts.deviceName)
      : "LocalMediaWeb";
    return {
      title: title,
      artist: artist,
      album: "LocalMediaWeb",
      artwork: artworkList(opts.thumbUrl, opts.origin),
    };
  }

  function playbackState(paused) {
    return paused ? "paused" : "playing";
  }

  function nextIndex(cur, delta, length) {
    var n = (cur | 0) + (delta | 0);
    var len = length | 0;
    if (len <= 0) return null;
    if (n < 0 || n >= len) return null;
    return n;
  }

  function safePositionState(ms, duration, position, rate) {
    if (!ms || typeof ms.setPositionState !== "function") return false;
    var d = Number(duration);
    var p = Number(position);
    if (!isFinite(d) || d <= 0) return false;
    if (!isFinite(p) || p < 0) p = 0;
    if (p > d) p = d;
    var r = Number(rate);
    if (!isFinite(r) || r <= 0) r = 1;
    try {
      ms.setPositionState({ duration: d, playbackRate: r, position: p });
      return true;
    } catch (_) {
      return false;
    }
  }

  function applyMetadata(ms, meta) {
    if (!ms) return false;
    try {
      if (typeof MediaMetadata === "function") {
        ms.metadata = new MediaMetadata(meta || {});
      } else {
        ms.metadata = meta || null;
      }
      return true;
    } catch (_) {
      try {
        ms.metadata = meta || null;
        return true;
      } catch (e2) {
        return false;
      }
    }
  }

  function bindActions(ms, handlers) {
    if (!ms || typeof ms.setActionHandler !== "function") return [];
    var bound = [];
    var h = handlers || {};
    ACTIONS.forEach(function (name) {
      var fn = h[name];
      try {
        ms.setActionHandler(name, typeof fn === "function" ? fn : null);
        if (typeof fn === "function") bound.push(name);
      } catch (_) {}
    });
    return bound;
  }

  function unbindActions(ms) {
    if (!ms || typeof ms.setActionHandler !== "function") return;
    ACTIONS.concat(UNBIND_EXTRA).forEach(function (name) {
      try {
        ms.setActionHandler(name, null);
      } catch (_) {}
    });
    try {
      ms.playbackState = "none";
    } catch (_) {}
    try {
      ms.metadata = null;
    } catch (_) {}
  }

  function createSilentEl(doc) {
    var d = doc || (typeof document !== "undefined" ? document : null);
    if (!d || typeof d.createElement !== "function") return null;
    var el = d.createElement("audio");
    el.setAttribute("playsinline", "1");
    el.setAttribute("webkit-playsinline", "1");
    el.setAttribute("loop", "loop");
    el.loop = true;
    el.preload = "auto";
    el.muted = false;
    try {
      el.volume = 0.01;
    } catch (_) {}
    el.src = SILENT_WAV;
    el.setAttribute("aria-hidden", "true");
    el.setAttribute("tabindex", "-1");
    el.style.cssText =
      "position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px";
    return el;
  }

  var api = {
    ACTIONS: ACTIONS,
    SILENT_WAV: SILENT_WAV,
    absUrl: absUrl,
    artworkList: artworkList,
    buildMetadata: buildMetadata,
    playbackState: playbackState,
    nextIndex: nextIndex,
    safePositionState: safePositionState,
    applyMetadata: applyMetadata,
    bindActions: bindActions,
    unbindActions: unbindActions,
    createSilentEl: createSilentEl,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.lmwCastMediaSession = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
