# AppCatch scan/adapt audit report

Root: `AppCatch`

## Confirmed findings (6)

### F1 [P0] `D:\GIT\fur\cat-catch\AppCatch\app\main.py`
- **Issue:** run_catch runs build_session and source collection synchronously on the Qt UI thread; grid only opens after session returns.
- **Fix hint:** Offload build_session to a background thread; marshal UI (toast/grid) via signals; keep busy flag until done.
- **Verified:** main.py:488-529: self._busy=True; raw_extra=self._snapshot_clipboard(info); session=self.pipeline.build_session(info, extra=extra). Grid only after session: mode=="grid" -> _open_grid (567-574); screenshot_fallback (598); default multi path (635-641). finally clears _busy (646-648). QtCore imports are QTimer/QObject/Qt only (line 9)—no QThread for catch. Contrast: _download_list uses DownloadJob+threading.Thread (701-718). build_session (pipeline.py:106-199) synchronously merges sentry/buffer/extra, registry.collect_for_session, cache collect_for_process, folder drain_new, then filter/grade—so collection blocks until complete before UI grid opens.

### F2 [P0] `D:\GIT\fur\cat-catch\AppCatch\app\sources\cache_sentry.py`
- **Issue:** collect_for_process always os.walks profile roots plus %TEMP%/%LOCALAPPDATA%\Temp (depth 2–4) on the catch path; non-Discord apps with empty network buffer still pay full disk scan.
- **Fix hint:** Background scan + time/file visit budget; skip temp unless boost; early-stop after enough owned hits.
- **Verified:** pipeline.py:156-173 — if cache_enabled (default True): self._cache_sentry.collect_for_process(info.process_name, info.pid, ...); no network_buffer check. cache_sentry.py:249-255 — candidates always extend %TEMP% and %LOCALAPPDATA%\Temp. cache_sentry.py:336-358 — roots = roots_for_process(...); depth = 2 if is_temp else max_depth (default 4); _scan_root per root. cache_sentry.py:421-449 — os.walk(root); after stat min_bytes/mtime filters, sniff_media(fp). main.py build_session on catch; config defaults cache_enabled True.

### F3 [P0] `D:\GIT\fur\cat-catch\AppCatch\app\sources\cache_sentry.py`
- **Issue:** sniff_media uses path.read_bytes()[:32], which loads entire files into memory during every walk hit—catastrophic for large videos on UI thread.
- **Fix hint:** with path.open('rb') as f: data = f.read(32)
- **Verified:** cache_sentry.py L76-79: def sniff_media(...): try: data = head if head is not None else path.read_bytes()[:32]. Call site L449: sniffed = sniff_media(fp) with no head during os.walk of cache roots (files already filtered only by min_bytes/mtime, not max size). Contrast media_integrity.py L14-20: explicit comment 'never read the whole file into memory' + with p.open('rb') as f: head = f.read(min(64, size)).

### E1 [P0] `D:\GIT\fur\cat-catch\AppCatch\app\main.py`
- **Issue:** screenshot_fallback uses undefined is_discord; NameError aborts after ensure_screenshot so empty smart catch never opens grid or ingests
- **Fix hint:** Set is_discord from process_name (e.g. 'discord' in name.lower()) or remove Discord branch and always open grid on screenshot-only
- **Verified:** AppCatch/app/main.py:595 uses `if is_discord or len(visible) != 1 or not self.cfg.get(...)`; :600 uses `if is_discord:`. rg under AppCatch finds only those two bare `is_discord` uses (clipboard_sentry has unrelated `_is_discordish_url`). No prior assignment in run_catch or AppController. Path: decision=="screenshot_fallback" → ensure_screenshot (591) → NameError on is_discord → except at 642-644 toasts "抓取失败" → skips _open_grid (598) and ingest_candidate (611).

### F4 [P1] `D:\GIT\fur\cat-catch\AppCatch\app\sources\cache_sentry.py`
- **Issue:** Per cache hit: is_media_complete for videos and PIL Image.open for images; filters annotate integrity again for local videos.
- **Fix hint:** Defer integrity/dims to top-N after sort; cache by path+size+mtime.
- **Verified:** D:\GIT\fur\cat-catch\AppCatch\app\sources\cache_sentry.py:374-404 — complete, creason = True,'ok'; if mtype == MediaType.VIDEO: complete, creason = is_media_complete(path); skip if not complete; if IMAGE/GIF: w,h = _try_image_size(path) which does with Image.open(path). D:\GIT\fur\cat-catch\AppCatch\app\core\filters.py:58-66 — if mt == 'video' and local file: complete = annotate_candidate_integrity(c). D:\GIT\fur\cat-catch\AppCatch\app\sources\media_integrity.py:111-137 — annotate_candidate_integrity calls is_media_complete(p) when meta lacks media_complete+_integrity_path match; cache_sentry meta sets media_complete without _integrity_path.

### F5 [P1] `D:\GIT\fur\cat-catch\AppCatch\app\sources\folder_watch.py`
- **Issue:** First drain_new in build_session bootstraps by walking watch dirs + Downloads on the UI thread; extension-less files call sniff_media (full read).
- **Fix hint:** Background bootstrap at startup; never first-walk Downloads inside catch.
- **Verified:** folder_watch.py:140-151 if not self._bootstrapped: for path,mtime,size in self._iter_media_files() ... self._bootstrapped=True; _iter_media_files:176-198 os.walk + if not ext or len(ext)>6: sniff_media(fp); FolderWatch __init__ include_downloads + default_downloads + cfg watch_dirs; pipeline.py:51 FolderWatch(include_downloads=True), :186-190 drain_new in build_session; cache_sentry.py:79 path.read_bytes()[:32]; main.py:420/529 build_session in run_catch/_catch_clipboard (sync Qt path).

## Summary

AppCatch freezes and yields empty/no-grid catches because run_catch runs build_session (cache/folder walks, full-file sniff_media, integrity) on the Qt UI thread, and screenshot_fallback references undefined is_discord so empty smart catches crash after ensure_screenshot. Non-Discord apps still pay Temp/AppData scans; process switch only clears boost, not CaptureSession/grid or buffer isolation guarantees. Fix: bounded I/O, off-thread catch, process-switch session reset, always grid-or-toast with target process name—generic, no new app whitelist.

## Must fix

1. **P0** Never block Qt UI: offload build_session/catch to worker; marshal toast/grid via signals
   - files: AppCatch/app/main.py
   - why: run_catch sets _busy then calls pipeline.build_session (cache os.walk + folder drain + filters) synchronously; grid opens only after return—freezes hover for all apps, worst when network buffer empty.
1. **P0** sniff_media must read only first 32 bytes (not path.read_bytes()[:32])
   - files: AppCatch/app/sources/cache_sentry.py (also folder_watch call sites)
   - why: Path.read_bytes() loads entire files before slice; cache/folder walks hit large videos on the catch path—memory and UI stalls.
1. **P0** Fix undefined is_discord on screenshot_fallback so empty catch always grid or toast
   - files: AppCatch/app/main.py
   - why: is_discord used at ~595/600 with no assignment; NameError after ensure_screenshot is swallowed as 抓取失败—grid and one-click screenshot ingest never run.
1. **P0** Budget/skip Temp cache walk; early-stop after enough owned hits
   - files: AppCatch/app/sources/cache_sentry.py; AppCatch/app/core/pipeline.py
   - why: collect_for_process always walks profile roots + %TEMP%/%LOCALAPPDATA%\Temp; empty-network non-Discord apps still pay full disk scan on every catch.
1. **P0** Process switch must release prior CaptureSession/boost and prevent cross-app session merge
   - files: AppCatch/app/main.py; AppCatch/app/core/pipeline.py; AppCatch/app/ui/media_grid_panel.py
   - why: _on_hover_target clears boost only; open grid may still show previous session; session must only use current pid/process network sources—no leftover boost widening other apps.
1. **P1** Bootstrap FolderWatch at startup; never first-walk Downloads inside catch
   - files: AppCatch/app/sources/folder_watch.py; AppCatch/app/main.py or pipeline init
   - why: First drain_new in build_session walks watch_dirs+Downloads on catch path; extension-less files call sniff_media (was full-file).
1. **P1** Defer video integrity and image dims to top-N after sort; set _integrity_path to avoid double check
   - files: AppCatch/app/sources/cache_sentry.py; AppCatch/app/core/filters.py
   - why: Per cache hit is_media_complete + PIL; apply_filters re-annotates local videos because media_complete lacks matching _integrity_path.

## Isolation invariants

- On process_name change (exe-stripped): clear UI boost (_boost_until/pid/process), pipeline.clear_cache_boost(), and close/replace grid CaptureSession so prior app candidates never remain visible.
- CaptureSession may only pull network_sentry by current pid and current process_name; never candidates_for_process of a different app.
- pipeline._network_buffer is pid-keyed only: session extends only _network_buffer[info.pid]; do not merge other pids.
- Cache hits must pass foreign-app path filter for target process_name; Temp shared roots allowed only as noise-filtered/budgeted secondary.
- FolderWatch _seen is global by path, but each drain_new candidate is stamped with catch-time process_name and pid only.
- Clipboard extras: stamp empty process with target; strip cross-app media/URL ownership unless boost or explicit clipboard mode.
- Ignore or drop in-flight catch worker results if target pid/process changed before UI apply.
- Boost (UI and pipeline cache boost) is process+time scoped; never widen cache for a process that did not own the boost.
- Every catch terminal path must open grid or toast including target process short name; no silent abort.
- Deep os.walk, bulk sniffs, and is_media_complete must not run on the Qt main thread.
- Baseline screenshot/clipboard/cache-by-name stays generic—no new per-app whitelist required for those sources.

## P0 implementation steps

1. Fix sniff_media to open('rb') and f.read(32) only; keep optional head= for callers that already buffered.
2. In run_catch screenshot_fallback: set is_discord from process_name ('discord' in lower name) OR remove Discord-only branch and always _open_grid + generic tip when multi/fallback.
3. Refactor run_catch: capture WindowInfo snapshot; start background worker for clipboard filter + pipeline.build_session (+ decide path prep); keep _busy until done; on success/error emit Qt signal to main thread.
4. Main-thread slot: if info still current target (or accept hwnd/pid match), toast '目标: {proc} · 候选 N', then decide_ui / _open_grid / ingest / empty messages as today; on error toast '抓取失败 · {proc}: …' and tray red.
5. On process switch in _on_hover_target: existing boost clear + clear/close media_grid_panel session (_session=None, hide/reset UI); cancel or mark stale any in-flight catch for old pid.
6. Optional isolation: drop or age-out _network_buffer entries for pids not equal to current target when process changes (keep pid-only merge rule either way).
7. cache_sentry.collect_for_process: skip Temp roots unless boost active or owned-profile hits still below limit after profile roots; add file-visit or time budget; early-stop when len(results)>=limit with owned preference.
8. Verify smoke: non-Discord empty buffer stays responsive, ends with grid or process-named toast; switch Discord→other app clears grid and boost; no NameError on empty smart catch.
