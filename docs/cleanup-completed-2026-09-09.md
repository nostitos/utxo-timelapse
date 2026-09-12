# Cleanup completed — September 9, 2026

Latest-only cleanup completed, without creating extra backup copies.

| Location | Artifact bytes removed | Measured free-space change |
|---|---:|---:|
| External drive | 2,182.16 GB | **+2,182.15 GB** |
| Umbrel | 143.06 GB | **+143.97 GB**, including retired container storage |
| Mac project | 26.32 GB | No increase yet; concurrent allocation and retained APFS blocks affect the result |

The project directory shrank from about 26.8 GB to 0.48 GB. Nine purgeable Time
Machine snapshots exist on the Mac, and no removed UTXO data file remains open.
Those snapshots/shared extents likely retain the deleted data blocks. System
snapshots were not removed as part of this project cleanup.

## Retained

The five large working files total **189.06 GB across Mac and node**:

- Current MP4: 83.93 GB, on the external drive.
- Current Mac render input: 18.22 GB, on the external drive.
- Explorer history: 58.25 GB, on the external drive.
- Node v3 changes stream: 18.22 GB, on Umbrel.
- Matching node v3 checkpoint: 10.45 GB, on Umbrel.

Locations and working configurations are listed in [render-files.md](render-files.md).
The node checkpoint has no extra copy on the Mac. No large backup copy was made.
The temporary source archive created at the start was removed when the user
clarified that extra backup copies were unwanted. Small operation logs remain.

## Completed checks and changes

- Verified the retained MP4's 4K60 HEVC 4:4:4 metadata and 964,689 frames; decoded
  frames near the beginning, middle and end. Kept its successful render/remux logs.
- Verified all 1,610 expected cloud HLS objects against recorded sizes and ETags,
  matched the public playlist, and compared sampled bytes before deleting local
  streaming staging. No cloud object was modified or deleted.
- After cleanup the public info and pixel APIs and playlist responded successfully;
  first/middle/last video segments returned Range 206.
- Checked the node v3 checkpoint marker, height, BLK length, final record hash,
  complete tail/EOF and the node's matching block hash. Data is retained through
  block 964,483. No chain-data update was run.
- Checked the local history header and retained files. Current render/explorer
  configurations point to existing working files. Older maintained local render
  presets now use the same retained Mac input.
- Canonical update configs and the node v3 config now have
  `allowBlkFileTruncate: false`; v3 paths are explicit in the canonical updater.
- Removed four stopped legacy containers after preserving their log tails and
  inspection records. Kept `buv_blk_v3` and its runtime images.
- Removed 35 stale PID files. Preserved source/Git work and necessary software.
- Bitcoin Core REST remained healthy and reported mainnet, with initial download
  complete. Other node applications and Bitcoin/wallet data were outside the
  deletion list.

The initial backup preflight found that Umbrel lacks `lsof` and `crontab`.
Open-file/memory-map checks were completed through privileged `/proc` inspection,
and schedule directories were inspected directly. The backup operation was then
cancelled under the user's clarified retention policy before any data copy.

[Reviewed file manifest](cleanup-audit-2026-09-09/artifact-manifest.csv) and
[machine-readable completion results](cleanup-audit-2026-09-09/completion.json).
Detailed per-file deletion records are under
`/Volumes/4T Data/buv_render/cleanup-records-20260910/`; the node also retains
`/home/umbrel/buv_cleanup_20260910.jsonl`.
