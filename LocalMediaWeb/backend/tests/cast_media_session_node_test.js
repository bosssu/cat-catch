"use strict";

const path = require("path");
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

const jsPath = path.join(
  __dirname,
  "..",
  "..",
  "frontend",
  "public",
  "assets",
  "cast-media-session.js"
);
const src = fs.readFileSync(jsPath, "utf8");
const sandbox = { module: { exports: {} }, exports: {}, globalThis: {}, URL: URL };
sandbox.globalThis = sandbox;
vm.runInNewContext(src, sandbox, { filename: "cast-media-session.js" });
const api = sandbox.module.exports;
assert.ok(api && api.ACTIONS, "exports api");

function FakeMS() {
  this.handlers = {};
  this.metadata = undefined;
  this.playbackState = "none";
  this.pos = null;
  this.setActionHandler = function (name, fn) {
    this.handlers[name] = fn;
  };
  this.setPositionState = function (st) {
    if (!st || !(st.duration > 0)) throw new Error("bad duration");
    if (st.position < 0 || st.position > st.duration) throw new Error("bad pos");
    this.pos = st;
  };
}

// ACTIONS: play/pause/prev/next/seekto; never volume
const wantActions = ["play", "pause", "previoustrack", "nexttrack", "seekto"];
assert.strictEqual(api.ACTIONS.length, wantActions.length);
wantActions.forEach((a) => assert.ok(api.ACTIONS.indexOf(a) >= 0, a));
assert.ok(!api.ACTIONS.includes("volume"));
assert.ok(!api.ACTIONS.includes("volumechange"));

// nextIndex bounds
assert.strictEqual(api.nextIndex(0, -1, 5), null);
assert.strictEqual(api.nextIndex(4, 1, 5), null);
assert.strictEqual(api.nextIndex(2, 1, 5), 3);
assert.strictEqual(api.nextIndex(2, -1, 5), 1);
assert.strictEqual(api.nextIndex(0, 1, 0), null);

// absUrl + artwork same-origin
const origin = "http://192.168.1.8:8787";
const thumb = "/api/media/12/thumb?v=3&token=abc";
const abs = api.absUrl(thumb, origin);
assert.strictEqual(abs, origin + thumb);
const art = api.artworkList(thumb, origin);
assert.strictEqual(art.length, 1);
assert.strictEqual(art[0].src, abs);
assert.ok(art[0].src.indexOf(origin) === 0);

const remote = "https://cdn.example/x.jpg";
assert.strictEqual(api.absUrl(remote, origin), remote);
assert.strictEqual(api.artworkList("", origin).length, 0);

// metadata
const meta = api.buildMetadata({
  title: "  clip  ",
  mediaId: 12,
  deviceName: "Living TV",
  thumbUrl: thumb,
  origin: origin,
});
assert.strictEqual(meta.title, "clip");
assert.strictEqual(meta.artist, "投屏 · Living TV");
assert.strictEqual(meta.album, "LocalMediaWeb");
assert.strictEqual(meta.artwork[0].src, abs);

const meta2 = api.buildMetadata({ mediaId: 9, origin: origin });
assert.strictEqual(meta2.title, "#9");

assert.strictEqual(api.playbackState(true), "paused");
assert.strictEqual(api.playbackState(false), "playing");

// positionState guards
const ms = new FakeMS();
assert.strictEqual(api.safePositionState(ms, NaN, 1, 1), false);
assert.strictEqual(api.safePositionState(ms, 0, 1, 1), false);
assert.strictEqual(api.safePositionState(ms, 10, -2, 1), true);
assert.strictEqual(ms.pos.position, 0);
assert.strictEqual(api.safePositionState(ms, 10, 99, 1), true);
assert.strictEqual(ms.pos.position, 10);
assert.strictEqual(api.safePositionState(ms, 10, 3, 0), true);
assert.strictEqual(ms.pos.playbackRate, 1);

// bind / unbind
const fired = [];
const bound = api.bindActions(ms, {
  play: () => fired.push("play"),
  pause: () => fired.push("pause"),
  previoustrack: () => fired.push("prev"),
  nexttrack: () => fired.push("next"),
  seekto: (d) => fired.push("seek:" + d.seekTime),
});
assert.strictEqual(bound.length, api.ACTIONS.length);
api.ACTIONS.forEach((a) => assert.ok(bound.indexOf(a) >= 0, "bound " + a));
ms.handlers.play();
ms.handlers.nexttrack();
ms.handlers.seekto({ seekTime: 12.5 });
assert.strictEqual(fired.join(","), "play,next,seek:12.5");
assert.ok(!Object.prototype.hasOwnProperty.call(ms.handlers, "volume"));

api.unbindActions(ms);
assert.strictEqual(ms.handlers.play, null);
assert.strictEqual(ms.handlers.nexttrack, null);
assert.strictEqual(ms.handlers.seekto, null);
assert.strictEqual(ms.playbackState, "none");
assert.strictEqual(ms.metadata, null);

// silent wav is RIFF WAVE
const b64 = api.SILENT_WAV.split(",")[1];
const buf = Buffer.from(b64, "base64");
assert.strictEqual(buf.slice(0, 4).toString("ascii"), "RIFF");
assert.strictEqual(buf.slice(8, 12).toString("ascii"), "WAVE");

// fake document createElement
const fakeDoc = {
  createElement: function (tag) {
    const el = {
      tagName: tag,
      attrs: {},
      style: { cssText: "" },
      loop: false,
      muted: false,
      volume: 1,
      src: "",
      preload: "",
      setAttribute: function (k, v) {
        this.attrs[k] = v;
      },
    };
    return el;
  },
};
const audio = api.createSilentEl(fakeDoc);
assert.strictEqual(audio.tagName, "audio");
assert.strictEqual(audio.loop, true);
assert.strictEqual(audio.src, api.SILENT_WAV);
assert.ok(audio.volume > 0 && audio.volume <= 0.05);

console.log("ok cast-media-session node tests");
