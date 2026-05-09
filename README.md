# @nomercy-entertainment/nomercy-subtitle-octopus

NoMercy-owned TypeScript wrapper around the libass-wasm (SubtitleOctopus) WASM renderer.

This package is **not** a fork of upstream — it's a thin consumer-side wrapper that adds the patches NoMercy needs without modifying the WASM worker. The actual fork of [libass/JavascriptSubtitlesOctopus](https://github.com/libass/JavascriptSubtitlesOctopus) lives at [`@nomercy-entertainment/libass-wasm`](../nomercy-libass-wasm/) — that package owns the C++ source, Emscripten build pipeline, and the binaries.

## Patches owned here (main-thread, TypeScript)

- **Bearer token auth** — pre-fetch subtitle + font files on the main thread with `Authorization: Bearer <token>`, hand the worker blob URLs. Worker stays unmodified, never makes auth-required calls. Custom request schemes (`nmsync:`, `cast:`, `data:`, `blob:`, `file:`, etc.) bypass the same-origin guard so the token never leaks onto requests that can't carry it.
- **Cross-origin worker instantiation** — Blob URL + `importScripts()` shim so workers load from a different origin (CDN deployments).
- **Canvas geometry sync** — `ResizeObserver` against a configurable `geometrySource` element; copies six CSS properties to `canvasParent` so the libass canvas tracks the player's overlay through fullscreen / theater / float transitions.
- **Lifecycle race guards** — `currentLoadedUrl` + race-token pattern, orphan canvas sweep, idempotent dispose.
- **URL resolution** — `basePath` prepend with proper RFC-3986 absolute-URL detection (any scheme, plus protocol-relative `//host/path`).

## Binaries

`public/subtitles-octopus-worker.{js,wasm}` and `public/default.ttf` are vendored from upstream `libass-wasm@4.1.0` pending a first NoMercy build out of the sister fork (`@nomercy-entertainment/libass-wasm`). License chain reproduced in `COPYRIGHT`.

## Usage

```ts
import { NMSubtitleOctopus } from '@nomercy-entertainment/nomercy-subtitle-octopus';

const octopus = new NMSubtitleOctopus({
	video: videoElement,
	accessToken: () => store.bearerToken,
	basePath: 'https://cdn.example.com/subtitles/',
	geometrySource: playerContainer,
});

octopus.on('rendererReady', ({ url }) => console.log('renderer ready', url));
octopus.trackUrl('/episode-1.ass');
```

## License

MIT — TypeScript wrapper code. The vendored WASM artefact carries the upstream license chain (LGPL-2.1 / FTL / GPL-2.0 / MIT / ISC / NTP / Zlib / BSL-1.0) reproduced in `COPYRIGHT`.
