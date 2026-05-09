/** Render pipeline mode forwarded to the libass worker. */
export type RenderMode = 'wasm-blend' | 'js-blend' | 'lossy';

export interface OctopusOptions {
	/** Target video element — required. */
	video: HTMLVideoElement;
	/** Explicit canvas element. When omitted the wrapper creates one. */
	canvas?: HTMLCanvasElement;

	/** Initial subtitle URL to load (ASS/SSA only). */
	trackUrl?: string;
	/** Raw subtitle content string (ASS/SSA). */
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

	timeOffset?: number;
	lazyFileLoading?: boolean;
	dropAllAnimations?: boolean;
	debug?: boolean;

	/** Bearer token or factory. Auth pre-fetch happens on main thread; worker is never involved. */
	accessToken?: string | (() => string | undefined);
	/** Origin that receives the Authorization header. Defaults to location.origin. */
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
