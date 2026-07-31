# Design: Mobile album upload + Feed review notes

**Date:** 2026-07-31  
**Status:** Approved for implementation  
**Scope:** LocalMediaWeb web frontend (admin settings + Feed) and backend media model/API

## Goals

1. **Album upload on iOS (and other mobile browsers)** from the app **管理 / 设置** area: pick photos and videos from the device library, upload into the media library via the existing upload pipeline.
2. **Per-item review notes on Feed:** replace the Feed dock delete control with a **点评** control; open a text dialog to write/edit a note; visual state when a note exists. Delete remains available only on **网格** and **管理**.

## Non-goals

- Multi-user / threaded comments, mentions, likes-on-comments
- Overlaying long review text on the Feed player surface
- Including `review` in search (`q` / title / tags only stays as today)
- Client-side video transcoding or HEIC conversion pipeline
- Camera-only capture mode (`capture=`) as primary UX (album picker is enough)
- Persistent multi-device upload job queue beyond the current request lifecycle

## Background (existing code)

- `POST /api/upload` already accepts multipart files, optional `tags` / `restricted` / `remux` (default remux on for video), classifies content, remuxes/transcodes when needed for playability, registers into `media_items`.
- Extension manage page already uploads via the same API; web **管理** page did not expose local file pick for phone albums.
- Feed dock currently includes a delete button that hard-deletes disk + DB (confirm dialog).
- `MediaItem` has no free-text review field; `MediaPatch` only supports `title` / `tags` / `restricted`.

## Feature 1 — Local album upload (管理页)

### UX

- Placement: **管理** view, near connection/token settings — section **「从相册上传」**.
- Controls:
  - File input: `accept="image/*,video/*"` + `multiple` (iOS Safari / standalone PWA opens Photos).
  - Optional batch tags text field (same semantics as extension manage upload).
  - Optional **限制级** checkbox for the batch.
  - Progress line: e.g. `3/10 上传中…` / success & failure counts.
- Flow: user picks files → sequential (or small-concurrency) `FormData` POSTs to `/api/upload` with auth token header → on success refresh admin media list (and optionally soft-notify). Single-file failure does not abort the rest of the batch.
- Defaults: `remux=1` for server-side video remux/transcode path; do not force client `media_type` beyond file `type` hint when useful.

### Server

- **No new endpoint required** if existing `/api/upload` + token auth are used.
- Behavior remains: stream to disk, `classify_media_file`, video remux via `remux_to_playable` when appropriate (copy+faststart; encode when codecs are not mobile-friendly).
- Images: store + thumb; no full re-encode required.
- Respect `max_file_bytes` and existing error shapes.

### iOS / format notes

- Users select only authorized library items; no silent full-library scan.
- HEVC `.mov` and similar should follow existing remux/transcode rules.
- HEIC: prefer browser-converted JPEG when the OS provides it; if raw HEIC lands on disk, classification may fall back depending on server decode support — out of scope to add a dedicated HEIC pipeline in v1 unless already free via existing tools.

## Feature 2 — Feed review notes

### Data model

- Add column on `media_items`:

  | Column   | Type | Default | Notes                          |
  |----------|------|---------|--------------------------------|
  | `review` | Text | `""`    | Single-user free text note     |

- Migration: SQLAlchemy create/alter path used by this project (same pattern as prior column adds; empty string for existing rows).
- Max length: **2000** Unicode characters (validate on PATCH; trim optional whitespace-only → store as `""`).

### API

- `MediaOut.review: str = ""` (always present for clients).
- `MediaPatch.review: str | None = None`
  - `None` → leave unchanged
  - `""` → clear note
  - non-empty → set (enforce max length → 400 if over)
- `PATCH /api/media/{id}` already exists; extend handler to apply `review`.
- `_media_out` / any serializers must include `review`.
- **Search:** do **not** match against `review` in list/feed search queries.

### Feed UI

- Replace dock **删除** button with **点评** (icon + title).
- Button state:
  - No review: default style
  - Non-empty `review`: “has note” emphasis (highlight and/or small badge/dot)
- Tap → modal/sheet:
  - Multiline textarea prefilled with current `review`
  - **保存** → `PATCH` with `{ review }`, update in-memory feed item + button state
  - **取消** → close without save
  - Optional **清空** that saves `""` (or clear field + save) — implement at least clear-by-empty-save
- Do **not** paint long text over the video stage.
- Remove Feed delete action only; **网格** cell delete and **管理** delete/batch delete stay.

### Grid / admin

- v1: no required review editor on grid (Feed is primary). Admin rows may show a truncated review later; not required for first ship.

## Error handling

| Case | Behavior |
|------|----------|
| Upload network/HTTP error | Record fail for that file; continue batch; show summary |
| File too large | Server 400; count as fail |
| Review over 2000 chars | Client prevent + server 400 |
| PATCH offline | Alert / toast; keep modal open with draft text if easy |

## Testing

- Backend: unit/API test that PATCH sets/clears `review`; MediaOut includes field; search by `q` does not hit `review` text.
- Backend: existing upload tests remain green; optional smoke that upload still remux-flags video when remux=1.
- Manual: iOS Safari or PWA pick photo+video → appears in admin/feed; write/edit review on Feed; confirm delete only from grid/admin.

## Implementation outline (for planning)

1. DB + model + schema + `patch_media` + `_media_out`
2. Frontend Feed: dock button, modal, PATCH wiring, remove Feed delete
3. Frontend admin: album upload section + sequential upload + progress
4. Light tests + manual checklist

## Decisions log

| Decision | Choice |
|----------|--------|
| Feed delete | Removed from Feed only (grid + admin keep delete) |
| Review display | Button state only; full text in dialog |
| Upload defaults | Multi-select, batch tags + 限制级, remux=1 |
| Architecture | Reuse `/api/upload`; single `review` column; no review in search |
| Review max length | 2000 chars |
