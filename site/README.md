# The illustrated guide

Published at **https://nostitos.github.io/utxo-timelapse/**. Plain HTML, CSS and ES modules; no package install or build step. `index.html` is the visual guide and `technical.html` the engineering reference. The main explorer remains at **https://utxo.aiception.ai/**.

## Preview and validate

From the repository root:

```sh
python3 -m http.server 8080 --directory site
python3 scripts/check_site.py
node --experimental-default-type=module scripts/check_site_mapping.mjs
```

Open `http://localhost:8080/`. Also validate under a `/utxo-timelapse/` prefix before publishing. The Pages workflow runs link/asset/config coverage and mapper checks, then deploys only `site/` on pushes to `master`. Pull requests validate without deploying. Repository Pages settings must select **GitHub Actions**.

Test the hero/clip play controls, keyboard image lightbox, era links, before/after slider, epoch demo, configuration filter, mobile navigation and technical table scrolling. Respect reduced motion; all editorial text and image links remain available without JavaScript. Review desktop and narrow-screen screenshots after visual changes.

## Media provenance

The hero statistics are conservative lower bounds that remain true as updates are appended. “8 trillion+ pixels rendered” counts 3,840 × 2,160 × 966,361 block frames = 8,015,384,678,400 pixel positions across the September 10, 2026 master, excluding its final hold frames. This measures frame pixels, not CPU instructions or distinct outputs. The output-record count and frame count come from `assets/manifest.json`; the dated captions describe those source snapshots, while the explorer may contain a newer published timeline.

All chain imagery comes from the retained 4K master. `assets/manifest.json` records source filename, edition, exact frame blocks/timestamps and clip ranges. The 1080p WebP images are gallery previews; clicking opens 4K WebP. Four short clips have H.264 and VP9 versions. These are lossy previews, not original RGB evidence.

```sh
python3 scripts/build_site_media.py \
  --master /path/to/published-master.mp4 \
  --history /path/to/utxo_history.bin
```

Requires FFmpeg, cwebp and ImageMagick. Existing outputs are retained unless `--force`. The script extracts by integer-second seek plus exact frame index, reads the small timestamp table, and never changes the source master/history. It does not render a new film. Review captions when changing source editions. Palette experiment crops are preserved from the development diagnostics; rebuilding those needs the original local diagnostic PNGs, which are not published.

`assets/ui/` contains actual browser captures of the branded explorer, verified against the production video/history. Screenshot source and states are recorded in `assets/ui/provenance.json`. `assets/readme/annotated-frame.jpg` uses a real frame with editorial labels. `assets/readme/social.jpg` is a social preview crop. `assets/diagrams/` contains authored explanatory SVGs. No generated illustration stands in for observed blockchain data.

`assets/upstream/` contains the three original comparison images/animation from **[Martinus's BitcoinUtxoVisualizer](https://github.com/martinus/BitcoinUtxoVisualizer)**, retained under the repository's original MIT license. These are explicitly labelled as upstream material. Development palette comparisons are labelled separately.

## Asset budgets and licenses

Keep the entire static site below **80 MiB**, and each individual asset below **10 MiB**. The guide lazy-loads gallery media; 4K images load only when opened. Avoid adding full videos, chain datasets or uncurated screenshots. The social image is 1200×630. Self-hosted Instrument Serif and IBM Plex Sans/Mono include their SIL Open Font License files under `assets/fonts/`.

The original project MIT license remains in the repository root. hls.js and native dependencies retain their own licenses; see the [technical credits](technical.html#credits).
