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

## Worker files — copy to public

The libass WASM worker files ship inside this package's `dist/` directory. Your build tool must copy them into the public/static directory so the browser can load them:

```ts
// vite.config.ts
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default {
  plugins: [
    viteStaticCopy({
      targets: [
        {
          src: 'node_modules/@nomercy-entertainment/nomercy-subtitle-octopus/dist/subtitles-octopus-worker*.{js,wasm,data}',
          dest: 'static',
        },
      ],
    }),
  ],
};
```

Then pass the copied paths when registering the plugin:

```ts
player.addPlugin(OctopusPlugin, {
  workerUrl: '/static/subtitles-octopus-worker.js',
  legacyWorkerUrl: '/static/subtitles-octopus-worker-legacy.js',
});
```

## Usage

```ts
import { NMSubtitleOctopus } from '@nomercy-entertainment/nomercy-subtitle-octopus';

// Pre-fetch subtitle bytes and font binaries with whatever auth pipeline you use.
const trackContent = await fetchAuthedText('/episode-1.ass');
const availableFonts = await fetchAuthedFonts('/fonts/');

const octopus = new NMSubtitleOctopus({
	video: videoElement,
	trackContent,
	availableFonts,
	geometrySource: playerContainer,
});

octopus.on('rendererReady', ({ url }) => console.log('renderer ready', url));
```

The renderer never performs authenticated network I/O — your consumer (or the
NoMercy player kit) pre-fetches every byte the worker needs and passes it as
`trackContent` plus a `name → blob:URL` font map.

## License

MIT — TypeScript wrapper code. The vendored WASM artefact carries the upstream license chain (LGPL-2.1 / FTL / GPL-2.0 / MIT / ISC / NTP / Zlib / BSL-1.0) reproduced in `COPYRIGHT`.
