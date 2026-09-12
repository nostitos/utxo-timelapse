# UTXO Timelapse presentation release — September 12, 2026

The repository is now **[nostitos/utxo-timelapse](https://github.com/nostitos/utxo-timelapse)**. The old repository URL redirects to it. The upstream relationship, Git history and original MIT copyright are preserved.

- [Illustrated guide](https://nostitos.github.io/utxo-timelapse/)
- [Engineering reference](https://nostitos.github.io/utxo-timelapse/technical.html)
- [Branded explorer](https://utxo.aiception.ai/)

## What shipped

The repository presentation was rebuilt around a self-hosted-font editorial design, real rendered imagery and an educational walkthrough. The guide includes a ten-era gallery, 4K image enlargement, four short video previews across its two pages, density/palette explanations, eight detail/development crops, four actual explorer screenshots, an interactive production-matched time axis and an attributed upstream comparison. The technical page documents all 42 parsed configuration fields and 20 explicit tradeoffs.

README now introduces the project visually and links to the guide, explorer and technical reference. Current build/operations instructions are consolidated in `docs/README.md` and `AGENTS.md`; `CLAUDE.md` points to that guidance. Stale checkpoint and raster-averaging claims were corrected. Dated cleanup/debug evidence moved to `docs/history/`, and unused legacy presentation/configuration files were removed. Native source/configuration layout and the executable name `buv` remain stable.

The new explorer UI uses the UTXO Timelapse name, links back to the guide, describes pixel aggregation and weighted density accurately, and labels historical status as “unspent at cutoff.” Paused seeks target the midpoint of a video frame; the previous tiny boundary epsilon could display the preceding frame in native HEVC/HLS playback.

## Deployment

Guide source commit: `080b50ad191cc2fc243376325e4b547306fa4eec`.

[Initial Pages workflow](https://github.com/nostitos/utxo-timelapse/actions/runs/34671803077) completed successfully. The workflow validates on pull requests and publishes `site/` on master pushes. Public HTML and CSS were compared byte for byte with the committed source.

The explorer assets were uploaded to fresh immutable prefix `explorer/v5/site` and downloaded to verify equality. Worker release `append-966360-20260910-r4` was deployed as Cloudflare version `42ef4f07-c689-45de-b58d-6a2903650d00`. Only `sitePrefix` and `version` changed in the release descriptor. Every history routing field and `/api/info` value was retained; the stream is still `/hls/v3/media.m3u8`, through block 966,360. No full render, video re-encode, chain-data change or mobile rendition was performed for this presentation release.

## Verification

- Native build completed; focused palette, epoch-transition and checkpoint tests passed **1,965 assertions in three cases**. A bare macOS invocation ran zero legacy cases and was not counted as a regression test.
- Static validation passed **175 local links/assets**, complete coverage of **42 settings**, and a **64.9 MiB** site below the 80 MiB budget. Each individual asset is below 10 MiB.
- The guide mapper passed **57,459** coordinate/inverse comparisons against production, including all epoch transitions through the current cutoff.
- Browser checks covered 1440 px desktop, 800 px tablet and 390 px phone layouts, 4K image dialogs, Escape dismissal, comparison slider, time-axis controls, clip playback, configuration filtering and overflow. No page JavaScript errors were observed during the local guide checks.
- Public GitHub Pages rendered the guide and played its preview. Its explorer link opened the branded live player, which played the retained HEVC HLS stream.
- The shared view at block 314,000 / pixel (3000,1525) showed **two unspent outputs, 42,430 sat**, including **21,236 sat unspent at cutoff** and **21,194 sat spent at block 520,664**. The video HUD and controls both showed block 314,000 after the paused seek.
- Public explorer HTML matched the uploaded source and returned `x-worker-version: append-966360-20260910-r4`. API metadata before/after was identical.
- GitHub rendered all four README images. Secret scans of the pending implementation commits and staged presentation changes found no leaks.

Screenshots are documented in `site/assets/ui/provenance.json`; frame/clip provenance is in `site/assets/manifest.json`. The guide's portable H.264/VP9/WebP previews remain lossy. Full-explorer HEVC support remains browser/platform dependent; the compact history still cannot guarantee unique full-outpoint identity.
