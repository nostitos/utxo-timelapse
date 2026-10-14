# Cleanup log

Behavior-preserving cleanup passes. Each pass reads this file first, skips items marked done or "won't do", and appends a new dated section.

## 2026-10-14 — pass 1

Branch `cleanup/2026-10-14`, created from `codex/plane-mode` at `1264af5` (`master` is an ancestor of that commit, 55 commits behind). Area: Python append/publish scripts and their tests.

### Checks

| Check | Command | Baseline | After |
|---|---|---|---|
| Landscape unit tests | `node --test landscape/tests/` | 213 pass, 4 skipped, 0 fail | same |
| Python tests | `python3 -m unittest discover -s tests` | 41 OK | same |
| Script tests | `python3 -m unittest discover -s scripts/tests` | 94 run, 5 errors | same |
| CI compat media tests | `PYTHONPATH=scripts/tests python3 -m unittest test_compat_rendition test_fragment_publication test_replace_tail test_import_hls_catalog test_publication_commands` | OK | OK (73 incl. `test_append_update`) |
| Guide | `python3 scripts/check_site.py` | pass | pass |
| Guide mapping | `node --experimental-default-type=module scripts/check_site_mapping.mjs` | 57,459 pass | same |
| Explorer/HLS (CI) | `check_explorer_navigation.mjs`, `check_explorer_sharing.cjs`, `check_explorer_quality.cjs`, `check_hls_routes.mjs` | pass | pass |
| C++ build + cases | `cmake --build build_local`; `buv -ns '-tc=density_palette,epoch_transition_mapping,checkpoint_v3'`; `buv -ns -tc=landscape_state` | build OK; 3/3 and 1/1 pass | not rerun (no C++ touched) |

Baseline failures, unchanged: the 5 script-test errors are import failures for packages missing from this machine (`boto3` for `test_history_delta_publish`, `duckdb`/`pyarrow`/`yaml` for the four `test_address_coverage_*` modules). No dependency was installed. The `src/cpp/unit` doctest files compile only on Linux/Docker (see `src/cpp/CMakeLists.txt`), so they are not part of the macOS baseline. Browser checks (`landscape/tests/shell-browser-checks.mjs`) were not run because no landscape code changed.

### Changes

Equivalence was checked by comparing each file's AST with imports removed (identical before and after) and confirming no removed name is still referenced.

- `a2c5a0e` Remove unused imports from `finalize_video_append.py` (`hashlib`, `os`, `sys`, `time`, `ROOT`), `publish_video_append.py` (`os`, `subprocess`), `r2_publish_history_delta.py` (`os`, `struct`, `sys`) and `check_range_replay.py` (`shutil`).
- `dcb9bc8` Remove the never-acquired `lock=threading.Lock()` from `r2_publish_history_delta.main` and its now-unused `threading` import.
- `71b9c2a` Remove unused imports from `test_compat_rendition.py` (`hashlib`, `fragment_manifest as fm`; `compat_rendition` still loads that module), `test_import_hls_catalog.py` (`copy`, `patch`), `test_append_update.py` (`struct`) and `tests/test_sync_blk_append.py` (`importlib.util`).
- `7efe7b9` `benchmark_history_delta.py` uses its own `argparse` import instead of `p.argparse` (verified to be the same module object). The benchmark itself was not run: it needs `boto3` and a real history file.

### Skipped

- **Needs a human decision:** `update_video_append.prepare` assigns `events` (parses `timings.jsonl` on every poll) and `before` (reads `node-before.json`) without using either. Removing them would stop the function from raising when those files are missing or malformed, so they may be intentional guards.
- **Won't do:** `append_update.progress_snapshot` catches `(KeyError, ValueError)` and passes. Missing or malformed progress fields are meant to stay `None`.
- **Won't do (not dead):** `publication_commands.execute_publication`/`recover_publication` (used by `publish_append.py` and tests) and `sync_blk_append.remote_op` (called by name inside the remote code string and by tests).
- **Won't do (false positive):** `status`/`headers` in `test_import_hls_catalog.py` are class attributes of the fake response.
- Skipped as cosmetic: the unused tuple field `n` in `fragment_manifest.rebase`.
- Deferred: unused tuple locals in `address_coverage_analyze.py`, whose tests cannot run here without `duckdb`/`pyarrow`/`yaml`.
- Deferred: extracting shared helpers across run-specific scripts (for example, three scripts import `ENDPOINT` from `r2_publish_history_delta`, which loads `boto3` and `numpy` for one constant). AGENTS.md asks for these scripts to be inspected per run, so this needs owner input.
- Left alone: `TODO(martinus)` in `src/cpp/app/Utxo.h:202` is an unresolved upstream note.

### Next pass candidates

1. Unused named imports in deployed landscape renderer modules: `render/index.js` (`Vector3`), `render/post.js` (`Vector2`), `render/stub-terrain.js` (`float`), `render/terrain/atlas.js` (`RedFormat`, `uniform`, `tileInfo`), `render/terrain/index.js` (`Color`, `SLOT_CELLS`), `render/terrain/shading.js` (`Fn`, `log2`). Keep each import statement that still has names, and run the matching `shell-browser-checks.mjs --only …` terrain/render checks.
2. Unused names in landscape tests and dev harnesses: `wrapAngle` (`plane.test.mjs`), `readFileSync` (`replay.test.mjs`), `rowOfAmount` (`web/dev/ui_shell-stubs.js`), `pt` (`shell-browser-checks.mjs`), `errorsBefore` (`web/dev/render_post-functional.js`).
3. The `update_video_append.prepare` reads above, once an owner says whether they are intentional.
4. `address_coverage_*`: get a baseline in an environment with `scripts/address_coverage_requirements.txt` installed, then review unused tuple locals.
5. Cloudflare Worker sources (`cloudflare/utxo-video-worker/src`, `utxo-landscape-worker/src`): rerun the unused-import scan and check them with `check_landscape_worker.mjs` and the CI explorer/HLS checks.
