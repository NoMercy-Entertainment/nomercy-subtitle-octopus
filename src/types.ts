/** Render pipeline mode forwarded to the libass worker. */
export type RenderMode = 'wasm-blend' | 'js-blend' | 'lossy';

export interface OctopusOptions {
	/** Target video element — required. */
	video: HTMLVideoElement;
	/** Explicit canvas element. When omitted the wrapper creates one. */
	canvas?: HTMLCanvasElement;

	/**
	 * Initial subtitle URL to load (ASS/SSA only).
	 * @deprecated Use `trackContent` — the plugin layer pre-fetches the ASS body
	 * via the kit auth pipeline and passes it as inline content. URL-based loading
	 * involves the worker in network I/O which bypasses auth. Planned removal: 2.1.
	 */
	trackUrl?: string;
	/** Raw subtitle content string (ASS/SSA). Preferred over `trackUrl`. */
	trackContent?: string;

	/** Worker JS URL. Defaults to the bundled public/subtitles-octopus-worker.js. */
	workerUrl?: string;
	/** Legacy worker URL for browsers without WASM streaming. */
	legacyWorkerUrl?: string;
	/** Font file URLs to preload before rendering. */
	fonts?: string[];
	/** Named font map forwarded to the worker. */
	availableFonts?: Record<string, string>;
	/** Fallback font URL when the subtitle requests an unavailable face. */
	fallbackFont?: string;

	renderMode?: RenderMode;
	prescaleFactor?: number;
	prescaleHeightLimit?: number;
	maxRenderHeight?: number;
	targetFps?: number;
	libassMemoryLimit?: number;
	libassGlyphLimit?: number;

	/**
	 * Number of frames the renderer pre-computes ahead of `currentTime`. Forwarded
	 * to the worker; stock libass-wasm ignores it, NoMercy fork builds use it for
	 * the look-ahead render cache. Typical value: `10`.
	 */
	renderAhead?: number;

	/** Convenience flag: shorthand for `renderMode: 'lossy'`. */
	lossyRender?: boolean;

	timeOffset?: number;
	lazyFileLoading?: boolean;
	dropAllAnimations?: boolean;
	debug?: boolean;

	/**
	 * Bearer token or factory forwarded to the upstream worker.
	 * @deprecated The plugin layer now pre-fetches all content (subtitle body +
	 * font binaries) via the kit auth pipeline and passes them as `trackContent` /
	 * `availableFonts`. The worker never performs authenticated network I/O.
	 * Planned removal: 2.1.
	 */
	accessToken?: string | (() => string | undefined);
	/**
	 * Origin that receives the Authorization header in the worker.
	 * @deprecated Superseded by the plugin-layer pre-fetch approach. Planned removal: 2.1.
	 */
	authOrigin?: string;
	/** Prepended to relative subtitle and font URLs before passing to the worker. */
	basePath?: string;
	/** Element whose geometry drives the canvas overlay. Defaults to the video's parent. */
	geometrySource?: HTMLElement;
}

export interface OctopusEvents {
	/** Worker is initialised and the first frame is ready. */
	ready: void;
	/** Worker or renderer error. */
	error: Error;
	/** All requested font files finished loading. */
	fontsLoaded: { count: number };
	/** A new subtitle URL has been accepted by the renderer. */
	rendererReady: { url: string };
}

/** Internal message shapes for the main↔worker protocol. */
export type WorkerInboundMessage
	= | { type: 'nm:init'; workerDir: string }
		| { type: 'nm:set-track-url'; url: string }
		| { type: 'nm:set-track-content'; content: string }
		| { type: 'nm:set-time'; seconds: number }
		| { type: 'nm:free-track' }
		| { type: 'nm:dispose' };

export type WorkerOutboundMessage
	= | { type: 'nm:ready' }
		| { type: 'nm:error'; message: string }
		| { type: 'nm:fonts-loaded'; count: number };
