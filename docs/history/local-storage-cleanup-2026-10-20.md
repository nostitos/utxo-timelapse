# Project storage cleanup — October 20, 2026

The user selected lean retention: keep the current master and all current update inputs;
remove superseded masters and retired dataset editions. Scope was limited to this project's
folders, principally `/Volumes/4T Data/buv_render/`. Other drive folders were not modified.
No backup copies were created.

**Measured free-space increase: 728,751,120,384 bytes (728.75 GB).**
Container space available increased from 1,141,095,194,624 to 1,869,846,315,008 bytes
(1.14 TB to 1.87 TB). APFS shared extents and hard links make file-size totals different
from capacity actually recovered. These are decimal GB/TB.

`buv_render/` now contains 33,965 files, 389.54 GB of file contents and
approximately 382.05 GB allocated when each inode is counted once. APFS clones can share
additional extents, so this allocation figure is not an exclusive physical-space measurement.
`buv_coverage/` remains intact at about 3.29 GB; its unique research/provenance inputs and
completed results were not needed for this cleanup.

## Removed

| Category | File contents / scope |
|---|---:|
| Six superseded full video masters | 505.90 GB |
| Retired local datasets `landscape_966827/` and `landscape_970658/` | 151.57 GB |
| October 15 extraction BLK/checkpoint; duplicate October 18 extraction BLK | 48.04 GB |
| Five obsolete renderer checkpoints, including their historical hard links | 4.90 GB unique content; ten names |
| Original compatibility encoder's disposable `encode/` | 19.83 GB |
| Redundant compatibility publication media in `publication/` and `publication-retry1/` | 19.84 GB unique content; two sets of 4,031 names |
| Film temporary extraction/encoding files | 10.02 GB |
| Three dedicated capture browser profiles | 1.78 GB |
| Seven product-capture raw JPEG frame directories | 1.76 GB |
| Obsolete R2 recovery objects and downloaded decode samples | 1.54 GB |
| Film draft captures, capture tests and probes | 0.41 GB |

The first temporary-file pass freed 35.42 GB. The subsequent approved lean pass removed
older persistent outputs and redundant staging. In total, **43,487 file names**
were removed, representing 790,335,029,691 bytes when hard-linked names are
counted separately. The measured 728.75 GB figure above is the actual capacity increase.

The retained full master is `utxo_4k_epoch105k_60fps_transition_crf21_to_972052.mp4`.
The removed masters are the original `…exactledger_weighted_topband_splitpalette_transition_crf21.mp4`
and `…transition_crf21_to_966360`, `…to_966764`, `…to_966827`, `…to_970658` and
`…to_971587` MP4s. Removed renderer checkpoints were before blocks 964,980, 965,340,
965,400, 969,240 and 970,200. Their corresponding historical run links were also removed.

Small run configs, wrappers, receipts, metadata, catalogues and append manifests remain.
The original compatibility ledger retains every media object. Only its redundant encoding
and publication payloads were removed; both publication directories retain their small
JSON/playlist records. Formerly archived R2 objects are intentionally no longer recovery
copies; their hash/deletion receipts remain.

## Retained update and artwork inputs

- Current 84.82 GB master, working BLK/history and their indexes/manifests.
- Current updater checkpoint in `update_20261018/extract/checkpoint_v3.utxo` (11.07 GB),
  current renderer checkpoint before 970,620 and both validated publication pointers.
- History position and patch caches, current history catalogue and compatibility append
  ledger, original compatibility init and immutable published compatibility objects.
- Current `landscape_972052/` and supported rollback `landscape_971587/` datasets.
- Complete 132-item film package, controlled capture masters, encoded product recordings,
  final edits, verticals, stills, score stems, timing/provenance, scouting and review records.
  Raw JPEGs and discarded drafts were intermediates; the finished captured MP4s remain.

See [current render and update files](../render-files.md) for the maintained paths and
future lean-retention policy. Historical run recipes can name removed payloads; start a
fresh run from the current pointers instead of rerunning historical constants.

## Verification

- At the end of payload deletion, before updating the audit report: zero unexpected removals,
  zero missed selected files, zero changed survivors and zero added files. All 23,392 protected files retain
  their original device, inode, byte length and modification time.
- SHA-256 matched for all 132 indexed film-package items and six current publication/manifest
  files; zero missing or changed items. Both publication pointers remain unchanged.
- The current 84.82 GB master's full SHA-256 still matches its publication receipt:
  `b1dc7c1de0527de1c9c78986250b20537be3d1023b51d026fb20de10b9a24aa5`.
  It probes as HEVC 4:4:4, 3840×2160, 60 fps, 972,353 frames. Shared-history frame samples
  at 0 and 8,000 seconds match across all seven masters; the retained master's tail decodes.
  These sample comparisons are not a claim of full-file frame identity.
- The removed October 18 extraction BLK was byte-identical to the retained root BLK;
  the October 15 copy was an exact prefix. The current history header/catalogue match
  `history_publication_current.json`; all 4,430 current dataset chunks and 1,104 snapshots
  remain present with manifest sizes.
- All 4,031 redundant compatibility publication objects matched the retained ledger byte
  for byte and by SHA-256. The retry copies were hard links to those verified objects.
- Local dataset checks now prefer retained editions. Worker rows-table lookup derives the
  local folder from the release dataset ID, avoiding a dependency on a retired edition.
- After fast-forwarding to merged master `8f8d46c`, all 238 landscape unit tests and all
  11 Worker checks passed. Every one of the nine public hostnames reports the expected
  current release: `append-972052-20261020-retention-1` for 2D and
  `landscape-20261020-guide-1` for 3D. No cleanup deployment was needed.

Detailed metadata-only working records are in `/tmp/4t-cleanup-20261020/`. No payloads
were copied there or elsewhere. This cleanup changed no live/cloud objects. The guide
release landed independently during cleanup, retaining the same dataset and rollback IDs;
verification follows the newly merged release rather than the stale pre-cleanup checkout.
The existing `r2-retention-audit-20261020/index.html` was then updated with a local-cleanup
summary and a small `local-cleanup.json` receipt; these are intentional metadata changes.
