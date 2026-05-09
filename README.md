# @nomercy-entertainment/nomercy-subtitle-octopus

NoMercy-owned wrapper around the libass-wasm (SubtitleOctopus) WASM renderer.

The wrapper adds first-class support for:
- Bearer token auth (pre-fetch with Authorization header; worker never makes auth-required calls)
- Cross-origin worker instantiation via Blob URL
- ResizeObserver-driven canvas geometry sync
- Lifecycle race guards and orphan-canvas sweep
- basePath-prepended URL resolution

**WASM binaries in `public/` are vendored from the upstream libass-wasm package** and are subject to the LGPL-2.1 license reproduced in `COPYRIGHT`. A NoMercy in-house Emscripten build is planned (tracked as NME-octopus).

## Usage

```ts
import { NMSubtitleOctopus } from '@nomercy-entertainment/nomercy-subtitle-octopus';

const octopus = new NMSubtitleOctopus({
	video: videoElement,
	accessToken: () => store.bearerToken,
	basePath: 'https://cdn.example.com/subtitles/',
});

octopus.on('ready', () => console.log('renderer ready'));
octopus.trackUrl('/episode-1.ass');
```

## License

MIT — wrapper code. See `COPYRIGHT` for the vendored WASM binary license (LGPL-2.1).
