# Mobile album upload + Feed review notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users upload photos/videos from the phone album on the web 管理 page, and add editable per-media review notes on Feed (replacing Feed delete).

**Architecture:** Reuse `POST /api/upload` for album files. Add `media_items.review` (Text) with SQLite column migrate, expose via `MediaOut` / `MediaPatch`, and wire Feed HUD + modal. Admin settings gain a multi-file picker with batch tags/restricted and sequential uploads.

**Tech Stack:** FastAPI + SQLAlchemy (SQLite), vanilla JS frontend (`frontend/public/assets/app.js`), pytest for backend.

**Spec:** `LocalMediaWeb/docs/superpowers/specs/2026-07-31-mobile-upload-and-review-design.md`

---

## File map

| File | Responsibility |
|------|----------------|
| `LocalMediaWeb/backend/app/models/entities.py` | `MediaItem.review` column |
| `LocalMediaWeb/backend/app/core/db.py` | SQLite `ALTER` migrate for `review` |
| `LocalMediaWeb/backend/app/api/schemas.py` | `MediaOut.review`, `MediaPatch.review` |
| `LocalMediaWeb/backend/app/api/routes.py` | `_media_out`, `patch_media` validation (max 2000); do **not** add review to `q` search |
| `LocalMediaWeb/backend/tests/test_review.py` | PATCH set/clear/oversize; search excludes review |
| `LocalMediaWeb/frontend/public/index.html` | Album upload card fields; review modal markup |
| `LocalMediaWeb/frontend/public/assets/app.css` | Upload block, review button `.on`, modal styles |
| `LocalMediaWeb/frontend/public/assets/app.js` | Feed review UI; admin sequential upload; remove Feed `del` |

---

### Task 1: Backend model + migrate + schema + PATCH

**Files:**
- Modify: `LocalMediaWeb/backend/app/models/entities.py`
- Modify: `LocalMediaWeb/backend/app/core/db.py`
- Modify: `LocalMediaWeb/backend/app/api/schemas.py`
- Modify: `LocalMediaWeb/backend/app/api/routes.py`
- Create: `LocalMediaWeb/backend/tests/test_review.py`

- [ ] **Step 1: Write failing tests**

Create `LocalMediaWeb/backend/tests/test_review.py`:

```python
"""Media review notes: PATCH + MediaOut; search must not match review text."""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker


@pytest.fixture()
def client(tmp_path, monkeypatch):
    # Isolate SQLite + data dirs so we never touch the real library.
    db_file = tmp_path / "t.db"
    medias = tmp_path / "Medias"
    data = tmp_path / "data"
    medias.mkdir()
    data.mkdir()
    monkeypatch.setenv("LMW_DATA_DIR", str(data))
    # Prefer project settings override if config reads env; else patch get_settings.
    from app.core import config as config_mod
    from app.core import db as db_mod

    # Minimal: point settings paths if Settings has data_dir / medias
    s = config_mod.get_settings()
    # Force re-init with temp paths when possible
    if hasattr(s, "data_dir"):
        monkeypatch.setattr(s, "data_dir", str(data), raising=False)
    monkeypatch.setattr(config_mod, "_settings", None, raising=False)

    # Fallback: write a tiny media row via session after app import
    from app.main import app
    from app.core.db import init_db, session_scope
    from app.models.entities import MediaItem

    init_db()
    with session_scope() as db:
        # clear any leftover
        for m in db.scalars(select(MediaItem)).all():
            db.delete(m)
        m = MediaItem(
            title="probe-title",
            media_type="video",
            rel_path="probe.mp4",
            source_url="",
            file_size=1,
            mime="video/mp4",
            review="",
        )
        db.add(m)
        db.commit()
        mid = m.id

    with TestClient(app) as c:
        yield c, mid


def test_patch_review_set_and_clear(client):
    c, mid = client
    r = c.patch(f"/api/media/{mid}", json={"review": "好看 👍"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("review") == "好看 👍"

    r2 = c.patch(f"/api/media/{mid}", json={"review": ""})
    assert r2.status_code == 200
    assert r2.json().get("review") == ""


def test_patch_review_too_long(client):
    c, mid = client
    r = c.patch(f"/api/media/{mid}", json={"review": "x" * 2001})
    assert r.status_code == 400


def test_search_q_does_not_match_review(client):
    c, mid = client
    secret = "zzreviewonlytoken999"
    r = c.patch(f"/api/media/{mid}", json={"review": secret})
    assert r.status_code == 200
    listed = c.get("/api/media", params={"q": secret, "include_restricted": True})
    assert listed.status_code == 200
    ids = [x["id"] for x in listed.json().get("items") or []]
    assert mid not in ids
```

**Note for implementer:** If `TestClient` / settings isolation fails in this repo, adapt the fixture to match any existing conftest or how other tests boot the app. `test_audio_av.py` is script-style; this plan prefers TestClient. Minimum viable: pure unit tests that call `patch_media` logic after constructing `MediaItem` in a temp SQLite engine — but prefer HTTP tests if `require_token` allows empty token in test settings.

If token is required in test env, set the same token header as production test config, or monkeypatch `require_token`.

Simpler **unit-style alternative** if TestClient is painful:

```python
def test_review_length_and_assign():
    text = "x" * 2001
    assert len(text) > 2000
    # after implementation, importing a helper normalize_review(text) raises or returns error
```

Prefer full API tests once fixture works.

- [ ] **Step 2: Run tests — expect fail**

```bash
cd LocalMediaWeb/backend
python -m pytest tests/test_review.py -v
```

Expected: FAIL (no `review` field / column / 422 or AttributeError).

- [ ] **Step 3: Model column**

In `LocalMediaWeb/backend/app/models/entities.py`, on `MediaItem` after `warning` (or near tags):

```python
    # Free-text user note (single-user LAN); not used in search
    review: Mapped[str] = mapped_column(Text, default="")
```

- [ ] **Step 4: SQLite migrate**

In `LocalMediaWeb/backend/app/core/db.py`, add to `alters` list:

```python
        ("media_items", "review", "TEXT DEFAULT ''"),
```

- [ ] **Step 5: Schemas**

In `MediaOut` add:

```python
    review: str = ""
```

In `MediaPatch` add:

```python
    review: str | None = None
```

- [ ] **Step 6: `_media_out` + `patch_media`**

In `routes.py` `_media_out`:

```python
        review=(getattr(m, "review", None) or ""),
```

In `patch_media`, after restricted handling:

```python
    if body.review is not None:
        rev = body.review if isinstance(body.review, str) else str(body.review)
        # Normalize: strip only for empty check; keep internal newlines
        if len(rev) > 2000:
            raise HTTPException(400, "review too long (max 2000)")
        # Whitespace-only → empty
        if not rev.strip():
            m.review = ""
        else:
            m.review = rev
```

Do **not** change `list_media` `q` filters (title / source_url / tags only).

- [ ] **Step 7: Run tests — expect pass**

```bash
cd LocalMediaWeb/backend
python -m pytest tests/test_review.py -v
```

Expected: PASS (or fix fixture/token until green).

- [ ] **Step 8: Commit**

```bash
git add LocalMediaWeb/backend/app/models/entities.py \
  LocalMediaWeb/backend/app/core/db.py \
  LocalMediaWeb/backend/app/api/schemas.py \
  LocalMediaWeb/backend/app/api/routes.py \
  LocalMediaWeb/backend/tests/test_review.py
git commit -m "feat(LocalMediaWeb): add media review field and PATCH API"
```

---

### Task 2: Feed review button + modal (frontend)

**Files:**
- Modify: `LocalMediaWeb/frontend/public/index.html`
- Modify: `LocalMediaWeb/frontend/public/assets/app.css`
- Modify: `LocalMediaWeb/frontend/public/assets/app.js`

- [ ] **Step 1: Modal markup in `index.html`**

Before closing `</div>` of `#app` (near lightbox), add:

```html
    <div id="reviewModal" class="review-modal hide" aria-hidden="true" role="dialog" aria-labelledby="reviewModalTitle">
      <div class="review-modal-backdrop" data-review-dismiss="1"></div>
      <div class="review-modal-card">
        <h2 id="reviewModalTitle" class="review-modal-title">点评</h2>
        <p class="muted review-modal-sub" id="reviewModalSub"></p>
        <textarea id="reviewInput" class="review-input" rows="6" maxlength="2000" placeholder="写下对这条媒体的点评…"></textarea>
        <div class="review-modal-actions">
          <button type="button" id="btnReviewClear" class="btn ghost">清空</button>
          <span class="review-spacer"></span>
          <button type="button" id="btnReviewCancel" class="btn ghost">取消</button>
          <button type="button" id="btnReviewSave" class="btn primary">保存</button>
        </div>
      </div>
    </div>
```

Bump script/css cache query if used, e.g. `app.css?v=20260731review1` and `app.js?v=20260731review1`.

- [ ] **Step 2: CSS for modal + review button**

Append to `app.css` (after `.hud .round` block ~1302):

```css
.hud .round.review.on {
  border-color: rgba(120, 180, 255, 0.55);
  color: #9ec5ff;
  box-shadow: 0 0 0 1px rgba(120, 180, 255, 0.25);
}
.review-modal {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: env(safe-area-inset-top) 12px calc(12px + env(safe-area-inset-bottom));
}
.review-modal.hide { display: none; }
.review-modal-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
}
.review-modal-card {
  position: relative;
  width: min(520px, 100%);
  max-height: min(70vh, 520px);
  overflow: auto;
  background: var(--card, #16161f);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 16px 16px 12px 12px;
  padding: 16px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
}
.review-modal-title { margin: 0 0 4px; font-size: 1.1rem; }
.review-modal-sub { margin: 0 0 10px; font-size: 0.85rem; }
.review-input {
  width: 100%;
  box-sizing: border-box;
  min-height: 120px;
  resize: vertical;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(0, 0, 0, 0.35);
  color: inherit;
  padding: 10px 12px;
  font: inherit;
  line-height: 1.45;
}
.review-modal-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-top: 12px;
}
.review-spacer { flex: 1; }
```

- [ ] **Step 3: Icon + slide template**

In `app.js` `ICO` object, add (comment icon):

```javascript
    review: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M20 2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14l4 4V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/></svg>`,
```

Replace delete button in slide HTML (was `data-act="del"`):

```javascript
              <button type="button" class="round review ${(item.review || "").trim() ? "on" : ""}" data-act="review" data-id="${item.id}" title="点评">${ICO.review}</button>
```

- [ ] **Step 4: Review modal state + handlers**

Add near other state helpers:

```javascript
  let reviewTargetId = null;

  function openReviewModal(id) {
    const item = state.items.find((x) => x.id === id);
    reviewTargetId = id;
    const modal = document.getElementById("reviewModal");
    const input = document.getElementById("reviewInput");
    const sub = document.getElementById("reviewModalSub");
    if (!modal || !input) return;
    input.value = (item && item.review) || "";
    if (sub) sub.textContent = item ? `#${id} · ${(item.title || "").slice(0, 40)}` : `#${id}`;
    modal.classList.remove("hide");
    modal.setAttribute("aria-hidden", "false");
    setTimeout(() => input.focus(), 50);
  }

  function closeReviewModal() {
    const modal = document.getElementById("reviewModal");
    if (modal) {
      modal.classList.add("hide");
      modal.setAttribute("aria-hidden", "true");
    }
    reviewTargetId = null;
  }

  function syncReviewButton(id, reviewText) {
    const on = !!(reviewText || "").trim();
    document.querySelectorAll(`.snap-slide[data-id="${id}"] button[data-act="review"]`).forEach((btn) => {
      btn.classList.toggle("on", on);
    });
  }

  async function saveReview({ clear = false } = {}) {
    const id = reviewTargetId;
    if (id == null) return;
    const input = document.getElementById("reviewInput");
    let text = clear ? "" : (input ? input.value : "");
    if (text.length > 2000) {
      alert("点评最多 2000 字");
      return;
    }
    try {
      const m = await api(`/api/media/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ review: text }),
      });
      const idx = state.items.findIndex((x) => x.id === id);
      if (idx >= 0) state.items[idx] = m;
      syncReviewButton(id, m.review || "");
      closeReviewModal();
    } catch (e) {
      alert("保存点评失败: " + e.message);
    }
  }
```

In `handleAction`, **remove** the entire `if (act === "del") { ... }` block for Feed (or leave unused — better delete). Add:

```javascript
    if (act === "review") {
      openReviewModal(id);
      return;
    }
```

In `bind()` (or one-time DOM bind), wire modal buttons:

```javascript
    const rm = document.getElementById("reviewModal");
    if (rm && rm.dataset.bound !== "1") {
      rm.dataset.bound = "1";
      document.getElementById("btnReviewCancel")?.addEventListener("click", () => closeReviewModal());
      document.getElementById("btnReviewSave")?.addEventListener("click", () => saveReview());
      document.getElementById("btnReviewClear")?.addEventListener("click", () => {
        const input = document.getElementById("reviewInput");
        if (input) input.value = "";
        saveReview({ clear: true });
      });
      rm.querySelector("[data-review-dismiss]")?.addEventListener("click", () => closeReviewModal());
    }
```

Grid delete (`data-del`) and admin delete stay unchanged.

- [ ] **Step 5: Manual smoke**

1. Open Feed → right dock shows 点评 not 删除.  
2. Save a note → button gains `.on`; reopen shows text.  
3. Clear → button off.  
4. Grid/admin still delete.

- [ ] **Step 6: Commit**

```bash
git add LocalMediaWeb/frontend/public/index.html \
  LocalMediaWeb/frontend/public/assets/app.css \
  LocalMediaWeb/frontend/public/assets/app.js
git commit -m "feat(LocalMediaWeb): Feed review notes UI replacing delete"
```

---

### Task 3: Admin album upload UI

**Files:**
- Modify: `LocalMediaWeb/frontend/public/index.html`
- Modify: `LocalMediaWeb/frontend/public/assets/app.css`
- Modify: `LocalMediaWeb/frontend/public/assets/app.js`

- [ ] **Step 1: HTML section in 设置 card**

Inside the first admin-card (设置), after the 限制级 tip paragraph (before closing `</div>` of that card), insert:

```html
        <hr class="admin-sep" />
        <h3 class="admin-subhead">从相册上传</h3>
        <p class="muted tip">iOS / Android 可选相册图片与视频；视频服务端默认 remux。多选后排队上传。</p>
        <label class="btn file-label" style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;">
          选择照片或视频
          <input type="file" id="albumUploadInput" accept="image/*,video/*" multiple hidden />
        </label>
        <label>本批标签
          <input id="albumUploadTags" type="text" placeholder="逗号分隔，可选" autocomplete="off" />
        </label>
        <label class="switch-row" title="本批打上限制级标签">
          <span>限制级</span>
          <input type="checkbox" id="albumUploadRestricted" />
        </label>
        <div id="albumUploadProg" class="muted tip" aria-live="polite"></div>
```

Optional minimal CSS:

```css
.admin-sep {
  border: 0;
  border-top: 1px solid rgba(255,255,255,0.08);
  margin: 16px 0 12px;
}
.admin-subhead {
  margin: 0 0 8px;
  font-size: 1rem;
  font-weight: 600;
}
```

- [ ] **Step 2: Upload helpers in `app.js`**

```javascript
  function parseTagsInput(raw) {
    return String(raw || "")
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async function uploadAlbumFile(file, { tags, restricted }) {
    const fd = new FormData();
    fd.append("title", file.name.replace(/\.[^.]+$/, "") || file.name);
    fd.append("source_url", "");
    fd.append("media_type", (file.type || "").startsWith("image/") ? "image" : (file.type || "").startsWith("audio/") ? "audio" : "video");
    fd.append("remux", "1");
    if (tags && tags.length) fd.append("tags", JSON.stringify(tags));
    if (restricted) fd.append("restricted", "1");
    fd.append("file", file, file.name || "upload.bin");
    // Do not set Content-Type — browser sets multipart boundary
    return api("/api/upload", { method: "POST", body: fd });
  }

  async function runAlbumUpload(fileList) {
    const files = Array.from(fileList || []);
    const prog = document.getElementById("albumUploadProg");
    if (!files.length) return;
    const tags = parseTagsInput(document.getElementById("albumUploadTags")?.value);
    const restricted = !!document.getElementById("albumUploadRestricted")?.checked;
    let ok = 0;
    let fail = 0;
    const errors = [];
    for (let i = 0; i < files.length; i++) {
      if (prog) prog.textContent = `${i + 1}/${files.length} 上传中… ${files[i].name}`;
      try {
        await uploadAlbumFile(files[i], { tags, restricted });
        ok += 1;
      } catch (e) {
        fail += 1;
        errors.push(`${files[i].name}: ${e.message || e}`);
      }
    }
    if (prog) {
      prog.textContent =
        `完成：成功 ${ok}` +
        (fail ? `，失败 ${fail}` : "") +
        (errors.length ? " — " + errors.slice(0, 2).join("; ") : "");
    }
    try {
      await refreshAdminMedia();
    } catch (_) {}
  }
```

- [ ] **Step 3: Bind file input in `bind()`**

```javascript
    const albumIn = document.getElementById("albumUploadInput");
    if (albumIn && albumIn.dataset.bound !== "1") {
      albumIn.dataset.bound = "1";
      albumIn.addEventListener("change", () => {
        const list = albumIn.files;
        runAlbumUpload(list).finally(() => {
          albumIn.value = "";
        });
      });
    }
```

Important: `api()` must not force `Content-Type: application/json` on FormData. Current `api` only merges headers and does not set Content-Type — good. Ensure callers never pass `Content-Type` for upload.

- [ ] **Step 4: Manual smoke**

1. Desktop: pick a jpg + mp4 → progress → appears in 媒体库.  
2. If possible iOS Safari: album multi-select.  
3. With 限制级 on + filter off → item hidden in feed until toggle on.

- [ ] **Step 5: Commit**

```bash
git add LocalMediaWeb/frontend/public/index.html \
  LocalMediaWeb/frontend/public/assets/app.css \
  LocalMediaWeb/frontend/public/assets/app.js
git commit -m "feat(LocalMediaWeb): admin album upload for mobile photos/videos"
```

---

### Task 4: Final verification

- [ ] **Step 1: Backend tests**

```bash
cd LocalMediaWeb/backend
python -m pytest tests/test_review.py tests/test_feed_rank.py -v
```

Expected: all pass.

- [ ] **Step 2: Checklist vs spec**

| Spec item | Done? |
|-----------|--------|
| Album multi upload on 管理 | |
| tags + 限制级 + remux=1 | |
| video remux path unchanged server-side | |
| `review` field + PATCH + MediaOut | |
| Feed 点评 replaces 删除 | |
| Button `.on` when note exists | |
| Modal edit/clear | |
| Delete only grid + admin | |
| review not in search | |
| max 2000 | |

- [ ] **Step 3: Optional docs one-liner**

If `LocalMediaWeb/README.md` lists features, add one line: 管理页支持手机相册上传；Feed 支持媒体点评。

```bash
git add LocalMediaWeb/README.md
git commit -m "docs(LocalMediaWeb): mention album upload and feed review"
```

---

## Self-review (plan vs spec)

| Spec requirement | Task |
|------------------|------|
| Admin album upload multi + tags + restricted + remux | Task 3 |
| Reuse `/api/upload` | Task 3 |
| `review` column + migrate | Task 1 |
| MediaOut / MediaPatch / PATCH max 2000 | Task 1 |
| Not in search | Task 1 (no q change) + test |
| Feed button replace delete, modal, button state | Task 2 |
| Grid/admin delete keep | Task 2 (no grid change) |
| No long overlay text | Task 2 |

No TBD placeholders. Types: field name is consistently `review` (not `note`/`comment`).
