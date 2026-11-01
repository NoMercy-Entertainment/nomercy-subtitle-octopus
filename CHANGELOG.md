# Changelog — @nomercy-entertainment/nomercy-subtitle-octopus

## [0.2.1] — 2026-11-01

### Fixed

- A plain `npm install` resolves this package again. `publishConfig.tag` pinned every release to the `beta` dist-tag, so 0.2.0 sat on `beta` and `latest` stayed on 0.1.0. The content of 0.2.1 equals 0.2.0.

## [0.2.0] — 2026-11-01

### Added

- Subtitle time locks to the presented video frame (`requestVideoFrameCallback`), so captions change on the frame they belong to.
- A render probe: `probe: true` turns it on, `rendererInstance()?.probeReport()` reads it, `summarize` and `formatProbeReport` format it.

### Changed

- The caption canvas fits its wrapper, so captions line up at any player size.
- The bundled libass worker uploads the whole frame instead of the dirty box. A partial upload made the video drop 3-6% of its frames while captions were busy.
- The default worker URL is `nomercy-libass-worker.js`.

### Removed

- The renderer options `renderMode`, `prescaleFactor`, `prescaleHeightLimit`, `maxRenderHeight`, `targetFps`, `renderAhead` and `lossyRender`, and the `RenderMode` type. The worker never read them, so removing them changes no behavior. Delete them from your options; TypeScript flags each one.

## [0.1.0]

First release.
