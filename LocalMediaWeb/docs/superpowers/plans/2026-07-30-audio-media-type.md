# Audio Media Type Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** First-class `media_type=audio` across scan, detect, upload/download, Feed/grid/lightbox UI.

**Architecture:** Backend treats audio like image/video as a string type; feed uses a singleton `<audio id="lmwFeedAudio">` parallel to the video player, reusing progress chrome. No waveform thumbs; CSS placeholder.

**Tech Stack:** Python FastAPI, existing util/scan/thumb; vanilla JS feed player patterns.

**Spec:** `LocalMediaWeb/docs/superpowers/specs/2026-07-30-audio-media-type-design.md`

---

## File map

| File | Role |
|------|------|
| `backend/app/services/util.py` | `detect_media_type`, `guess_ext` |
| `backend/app/services/scan.py` | `AUDIO_EXT` index |
| `backend/app/services/thumb.py` | no-op for audio |
| `backend/app/services/tags.py` | ext tags + type tag fix |
| `backend/app/api/routes.py` | upload accepts audio |
| `backend/tests/test_media_type.py` | unit tests |
| `frontend/public/assets/app.js` | feed audio player, lightbox, grid |
| `frontend/public/assets/app.css` | audio stage / grid placeholder |
| `LocalMediaWeb/README.md` | mention audio type |

### Task 1: Detect + tests

- [ ] Add tests for audio extensions / MIME / hints
- [ ] Implement util changes
- [ ] Run pytest

### Task 2: Scan, thumb, tags, upload

- [ ] `AUDIO_EXT` in scan
- [ ] thumb early return for audio
- [ ] tags EXT_TAGS + weak tag `audio` not `video`
- [ ] upload allowlist includes audio

### Task 3: Frontend feed + grid + lightbox + CSS

- [ ] Singleton audio player + activate path
- [ ] bindFeedProgress uses video|audio
- [ ] Grid placeholder; lightbox audio
- [ ] CSS

### Task 4: Verify + commit

- [ ] pytest pass
- [ ] Commit
