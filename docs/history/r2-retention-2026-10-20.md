# R2 retention: first pass — October 20, 2026

The approved first pass removed **16,498 objects / 152,807,355,401 bytes** from the private
`utxo-video` bucket. A complete post-deletion listing contains **21,724 objects /
401,215,443,169 bytes** (401.22 decimal GB), down from 38,222 objects / 554.02 GB.

Every surviving object's size and ETag is unchanged. All **21,692 protected objects** reachable
from the current or immediate rollback releases remain present. There were no unexpected
deletions. Small unreferenced metadata and font/software licences were retained.

## Removed and retained

- Retired 3D datasets `landscape/d966827-20261008/` and `landscape/d970658-20261009/`:
  11,001 objects / 151,567,908,337 bytes. Their complete local dataset directories remain.
- Superseded history patches/tail shards, unused video tails and init objects, retired playlists,
  old UI copies and upload test files: 5,497 objects / 1,239,447,064 bytes. These were archived
  locally with SHA-256 receipts before deletion; single-part objects also matched their MD5 ETags.
- Retained current 3D dataset `d972052-20261018` and rollback `d971587-20261015`, both active
  2D video renditions and their rollback dependencies, every active history base and patch,
  the original 83.93 GB cloud MP4 and its legacy download routes.
- No local chain data, histories, masters, checkpoints, position caches, publication pointers or
  append ledgers were deleted. The validated history-publication pointer has the same SHA-256
  before and after (`c5ed51b920b3e69c3a2dd01bedf205b1c3e5d0a6c5efb880e68bc3f3e7744fc9`).
  The next append still starts from its catalogue and the current `d972052` manifests.

This was the conservative cleanup only. The optional retirement of full-MP4 downloads and
deduplication of the current/rollback 3D datasets were not performed.

## Retirement release

[PR #40](https://github.com/nostitos/utxo-timelapse/pull/40), merged as `07bcd34`, retired the
two old dataset IDs and redirected superseded playlists before deletion. It changed no app
assets, video metadata, history routing, dataset contents or site prefix.

- 3D Worker: `landscape-20261020-retention-1`; Cloudflare version
  `10c60b5f-6b96-42d2-87f8-0b55ab718a9a`.
- 2D Worker: `append-972052-20261020-retention-1`; Cloudflare version
  `a83f462a-760e-4150-8fe4-6a142f38bbf1`.
- All nine public hostnames verified with `scripts/check_live_release.mjs`.
- Old `hls/v1`–`v6` playlists redirect to the current full rendition, and
  `hls/compat1`/`compat2` playlists to the current compatibility rendition, both resolved
  from the release's immutable `info.json`. Shared objects inside old prefixes are retained.
  The immediate rollback playlists `v7` and `compat3` are unchanged.

The deletion tool used only the approved key list; compared a fresh full inventory to its recorded
sizes and ETags; checked supported dataset manifests and local copies of the retired datasets;
and checked both live release versions and the publication pointer before each batch of 500 keys.
Any mismatch stopped it. There was no wildcard or bucket-wide deletion.

## Verification

- Local/CI: 237 landscape tests passed (one skipped), 8 landscape Worker checks, HLS redirect,
  shared-object and range checks; history-source, navigation, quality and sharing checks;
  static-guide validation, 57,459 coordinate/mapping checks and CSP hash.
- Post-deletion inventory: exact expected key set; 0 unexpected deletions, 0 changed survivors,
  0 missing protected objects.
- All seven sampled public API responses are identical to the before-deletion baseline:
  info, three 2D pixels and three 3D cells. The featured cell still reads 214 outputs at
  block 969,652 and 94 at 970,852.
- Current and rollback 3D manifests load; retired dataset endpoints reject requests.
- All eight retired playlist URLs redirect to working current streams; the legacy MP4
  redirect and its byte-range response still work.
- Real Chrome: 2D compatibility playback seeks to blocks 314,000, 630,000 and 972,052 with
  nonblank 2560×1440 frames, then advances 2.08 seconds during a 2.2-second playback check.
  No page exceptions, failed requests or video errors.
- Real Chrome: 3D startup, inspector and playback pass, including exact 1×/2×/5×/Max replay,
  steady playback and inspector/replay count agreement. Column-line and GPU count diagnostics
  pass on an isolated retry. The initial concurrent diagnostic hit a GPU readback exception;
  no app asset changed in this release.
- FFmpeg decoded first, middle and final fragments of both current 4K and 1440p renditions,
  plus the last fragments of both rollback streams (eight samples, three decoded frames each).

Evidence and recovery archive:
`/Volumes/4T Data/buv_render/r2-retention-first-pass-20261020/`, including
`execution.json`, `deleted-keys.jsonl`, `verified-inventory.json`,
`archive-receipts.json`, `archived-obsolete-objects/`, API comparisons,
browser screenshots and decoded-media receipts. The original review inventory is in
`r2-retention-audit-20261020/`.
