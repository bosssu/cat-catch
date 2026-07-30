# Design: LocalMediaWeb audio media type

**Date:** 2026-07-30  
**Status:** Approved for implementation planning  
**Scope:** Full pipeline — scan, download/upload detect, Feed / grid / lightbox playback, tags, ranking diversity

## Goal

Add a first-class `media_type=audio` so local library, ingest, and UI treat sound files as audio (not mislabeled video), with Feed UX reusing the existing short-video-style progress / mute / like controls.

## Non-goals

- Online radio, lyrics, EQ, playlists as a separate product surface
- ID3/album-art extraction or ffmpeg waveform thumbs (may follow later)
- Non-browser formats (wma, ape, etc.)

## Supported formats

Browser-friendly set (scan + `detect_media_type` + `guess_ext`):

| Extension | Typical MIME |
|-----------|----------------|
| `.mp3` | `audio/mpeg` |
| `.m4a` | `audio/mp4`, `audio/x-m4a` |
| `.aac` | `audio/aac` |
| `.ogg` | `audio/ogg` |
| `.opus` | `audio/opus` |
| `.wav` | `audio/wav`, `audio/x-wav` |
| `.flac` | `audio/flac` |

## Architecture

### Backend type surface

- **Canonical type:** `audio` (string on `MediaItem.media_type`, same as `image` / `gif` / `video`).
- **Detection** (`util.detect_media_type`):
  - URL path ends with audio extension → `audio`
  - Content-Type starts with `audio/` → `audio`
  - Explicit hint `audio` accepted (alongside existing image/gif/video/m3u8/dash)
  - Existing dash/m3u8/image/gif precedence unchanged; audio checked before default `video`
- **Extension guess** (`guess_ext`): map audio MIME and `media_type=="audio"` default (e.g. `mp3` or path-derived).
- **Scan** (`scan.py`): `AUDIO_EXT` set; index as `media_type=audio`.
- **Upload** (`routes.upload`): allow `audio` in accepted types; do not coerce audio to `video`. Skip Jasna. Remux: skip for audio (store as-is).
- **Download ingest**: rely on `detect_media_type`; when result is `audio`, persist `media_type=audio` and generate thumb via same path (no-op frame extract).
- **Thumbs** (`thumb.generate_thumb`): for `audio`, return `""` (no ffmpeg frame). Frontend supplies CSS/SVG placeholder.
- **Tags** (`tags.py`): already lists `audio`; keep behavior (e.g. weak type tag). Ensure ext tags cover new extensions if `_ext_tag` is extension-driven.
- **Jasna**: skip non-video (existing type checks must treat `audio` as non-candidate).
- **API filter**: existing `type=` query continues to work with `type=audio`.

### Frontend playback

- **Feed:**
  - Slide stage: `data-kind="audio"` + `data-src` (file URL with token as today).
  - Singleton `<audio id="lmwFeedAudio">` (parallel to shared feed `<video>`), not a per-slide element.
  - On activate: mount/bind shared audio to stage (or keep off-DOM and drive UI only), set `src`, `play()` after metadata/canplay; exclusivity: pause and clear src when leaving slide / activating video.
  - Reuse progress bar, center play/pause, mute preference, like/delete chrome; media time events from the active element (`audio` or `video`).
  - Visual: gradient + note icon + title (no `object-fit` video frame).
- **Grid:** do **not** treat audio as hover-preview motion type; show placeholder + `audio` chip; click → lightbox.
- **Lightbox:** `openLightbox` branch for `audio` → `<audio controls>` (autoplay when allowed).
- **Admin / chips:** display `media_type` as today.

### Ranking

- `feed_rank` already diversifies by `media_type`; no algorithm change required beyond data containing `audio`. Optional test: pool with audio does not clump exclusively.

## Data flow

```
Disk / URL / upload
  → detect_media_type / AUDIO_EXT
  → MediaItem(media_type="audio", rel_path=...)
  → thumb_rel empty
  → API list/feed
  → Feed: shared <audio> + chrome
  → Grid/lightbox: placeholder + <audio controls>
```

## Error handling

- Unplayable codec in browser: show stage placeholder; play() failure silent/log; user can still delete/like.
- Missing file: existing purge/rescan paths unchanged.
- Partial downloads: same job machinery; type still `audio` when detected.

## Testing

- Unit: `detect_media_type` for extensions + `audio/*` + hints.
- Unit/integration: scan indexes a temp `.mp3` as `audio`.
- Upload path accepts `media_type=audio` (or auto-detect from filename).
- Optional: feed_rank diversity includes `audio` item in mixed pool.
- Manual: Feed progress scrub, mute carry-over, grid → lightbox play.

## Implementation touch list (guidance)

| Area | Files (expected) |
|------|------------------|
| Detect / ext | `backend/app/services/util.py` |
| Scan | `backend/app/services/scan.py` |
| Thumb | `backend/app/services/thumb.py` |
| Upload / API | `backend/app/api/routes.py` |
| Download (if hard-coded video) | `backend/app/services/download.py` |
| Jasna guard | `backend/app/services/jasna.py` (if needed) |
| Tags ext | `backend/app/services/tags.py` (if needed) |
| Feed / grid / lightbox | `frontend/public/assets/app.js`, `app.css` |
| Tests | `backend/tests/` |
| Docs | `LocalMediaWeb/README.md` (brief type list) |

## Success criteria

1. Rescan indexes mp3/m4a/… as `audio`.
2. Upload/download of audio does not force `video`.
3. Feed plays audio with shared progress/mute/like UX.
4. Grid/lightbox open and play audio; no false “video hover preview”.
5. Jasna does not queue audio items.
`