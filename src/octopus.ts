import type { OctopusEvents, OctopusOptions } from './types';
import { CanvasGeometry } from './canvas-geometry';
import { isSupportedSubtitle, sweepOrphanCanvases } from './lifecycle';
import { resolveUrl } from './url-resolution';
import { EventEmitter } from './worker-bridge';
import { LibassRenderer } from './renderer';

/**
 * Default worker paths relative to this package's `public/` directory.
 * Consumers override via `options.workerUrl` / `options.legacyWorkerUrl`.
 */
// Our own worker, built by nomercy-libass from the same pinned sources as the
// desktop, Android and Apple builds — not the vendored SubtitlesOctopus one.
//
// The vendored build was a JavaScript port of libass whose version nobody here
// chose and whose fixes arrived when someone else made them, and it was the
// last surface in the trio rendering ASS through code we did not build.
//
// There is no legacy asm.js worker any more. Our pipeline emits wasm only, and
// a browser without WebAssembly is not one this player targets on any other
// surface; a consumer that needs one still passes it through
// `options.legacyWorkerUrl`, which is now simply another worker url.
const DEFAULT_WORKER_URL = new URL('../public/nomercy-libass-worker.js', import.meta.url).href;

/**
 * NMSubtitleOctopus — NoMercy headless libass renderer wrapper.
 *
 * Drives our own libass worker (see `renderer.ts`) and layers the NoMercy
 * behaviour the video player depends on:
 *
 *   Geometry  — `CanvasGeometry` keeps the overlay on the player's box rather
 *               than the video element's, so it tracks fullscreen, theater and
 *               float transitions.
 *   Patch 3 (lifecycle)— same-URL no-op, race-token guards through async
 *                        loads, orphan-canvas sweep before mount.
 *   Patch 4 (urls)     — `basePath` prepend + RFC-3986 absolute-scheme
 *                        detection so custom schemes (`nmsync:`, `cast:`,
 *                        `data:`, `blob:`, `file:`) bypass the prefix.
 *
 * Authentication is the plugin layer's responsibility: the kit's auth fetch
 * pre-fetches subtitle bytes and font binaries, then hands them to this
 * renderer via `trackContent` / `availableFonts`. The worker never performs
 * authenticated network I/O.
 *
 * Public API uses overloaded noun() / noun(value) form — no setX methods.
 */
export class NMSubtitleOctopus {
	private readonly options: OctopusOptions;
	private readonly emitter = new EventEmitter();

	private renderer: LibassRenderer | null = null;
	private geometry: CanvasGeometry | null = null;

	private _trackUrl: string | null = null;
	private _trackContent: string | null = null;
	private _currentTime: number = 0;

	/** Monotonic load token — every load() bumps this; stale awaits abort by id. */
	private loadId: number = 0;

	constructor(options: OctopusOptions) {
		this.options = options;

		if (options.trackUrl) {
			Promise.resolve().then(() => this.trackUrl(options.trackUrl!));
		}
		else if (options.trackContent) {
			Promise.resolve().then(() => this.trackContent(options.trackContent!));
		}
	}

	// ---------------------------------------------------------------------------
	// Public API — overloaded noun() / noun(value)
	// ---------------------------------------------------------------------------

	/** Get the currently loaded track URL. */
	trackUrl(): string | null;
	/** Load a subtitle by URL. Null frees the current track. */
	trackUrl(url: string | null): void;
	trackUrl(url?: string | null): string | null | void {
		if (url === undefined)
			return this._trackUrl;
		if (url === null) {
			this.freeTrack();
			return;
		}
		if (url === this._trackUrl && this.renderer)
			return;
		if (!isSupportedSubtitle(url)) {
			this.freeTrack();
			return;
		}
		void this.load(url, null);
	}

	/** Get the currently loaded inline track content. */
	trackContent(): string | null;
	/** Load a subtitle from an inline ASS/SSA string. Null frees the current track. */
	trackContent(content: string | null): void;
	trackContent(content?: string | null): string | null | void {
		if (content === undefined)
			return this._trackContent;
		if (content === null) {
			this.freeTrack();
			return;
		}
		void this.load(null, content);
	}

	/**
	 * Get the current playback position in seconds.
	 *
	 * The renderer reads the bound `<video>` every animation frame, so this is
	 * for explicit control and headless tests. Reading returns the last value
	 * we cached.
	 */
	currentTime(): number;
	currentTime(seconds: number): void;
	currentTime(seconds?: number): number | void {
		if (seconds === undefined)
			return this._currentTime;
		this._currentTime = seconds;
		// The render loop reads the element itself; this only records what a
		// caller asked for.
	}

	/** Tear down the current track without destroying the renderer. */
	freeTrack(): void {
		this._trackUrl = null;
		this._trackContent = null;
		this.loadId += 1;
		this.teardown();
	}

	/** Signal a resize so the canvas geometry syncs immediately (Patch 3). */
	resize(): void {
		this.geometry?.detach();
		this.geometry?.attach();
	}

	/** Tear down the renderer, worker, and all DOM side-effects. */
	dispose(): void {
		this.loadId += 1;
		this.teardown();
		this._trackUrl = null;
		this._trackContent = null;
		this.emitter.removeAll();
	}

	on<K extends keyof OctopusEvents>(name: K, fn: (data: OctopusEvents[K]) => void): void {
		this.emitter.on(name, fn);
	}

	off<K extends keyof OctopusEvents>(name: K, fn: (data: OctopusEvents[K]) => void): void {
		this.emitter.off(name, fn);
	}

	/** Direct handle to the renderer. The plugin retains lifecycle ownership. */
	rendererInstance(): LibassRenderer | null {
		return this.renderer;
	}

	// ---------------------------------------------------------------------------
	// Private
	// ---------------------------------------------------------------------------

	private async load(url: string | null, content: string | null): Promise<void> {
		const id = ++this.loadId;

		// Patch 4: tear down previous instance and orphan canvases.
		this.teardown();
		const container = this.resolveContainer();
		sweepOrphanCanvases(container);

		// Patch 5: resolve URLs through basePath + isAbsolute classifier.
		const resolvedSub = url ? resolveUrl(this.options.basePath, url) : '';
		const fontUrls = (this.options.fonts ?? []).map(f =>
			resolveUrl(this.options.basePath, f),
		);

		// Inline content is the preferred path: the plugin already fetched it
		// through the kit's authenticated pipeline.
		if (content && !url) {
			this._trackContent = content;
			this._trackUrl = null;
			void this.mount(content, id);
			return;
		}

		this._trackUrl = url;
		this._trackContent = null;

		// Fetched here rather than in the worker, for the same reason the fonts
		// are: the request has to carry the viewer's token.
		const response = await fetch(resolvedSub);
		if (!response.ok) {
			this.emitter.emit('error', new Error(`the subtitle at ${resolvedSub} returned ${response.status}`));
			return;
		}
		void this.mount(await response.text(), id);
	}

	// Fonts are bytes by the time they reach here.
	//
	// The worker performs no network I/O on purpose: on a real install every
	// sidecar sits behind the same bearer token as the stream, and a worker
	// fetching a font itself is a request that cannot carry it.
	private async mount(content: string, id: number): Promise<void> {
		if (id !== this.loadId)
			return;

		const renderer = new LibassRenderer(
			this.options,
			this.options.workerUrl ?? DEFAULT_WORKER_URL,
			{
				onReady: () => {
					if (id !== this.loadId)
						return;
					this.emitter.emit('rendererReady', { url: this._trackUrl ?? '' });
				},
				onError: (error: Error) => {
					if (id !== this.loadId)
						return;
					this.emitter.emit('error', error);
				},
			},
		);

		const container = this.resolveContainer();
		container.appendChild(renderer.canvasParent);
		this.renderer = renderer;

		const fonts = await this.fetchFonts();
		if (id !== this.loadId) {
			renderer.dispose();
			return;
		}

		await renderer.start(content, fonts);

		const geometrySource = this.options.geometrySource ?? container;
		this.attachGeometry(renderer.canvasParent, geometrySource);
	}

	private async fetchFonts(): Promise<Record<string, ArrayBuffer>> {
		const named = Object.entries(this.options.availableFonts ?? {});
		const listed = (this.options.fonts ?? []).map(url => [url, url] as const);
		const wanted = [...named, ...listed];

		const loaded: Record<string, ArrayBuffer> = {};
		await Promise.all(wanted.map(async ([name, url]) => {
			try {
				const response = await fetch(resolveUrl(this.options.basePath, url));
				if (!response.ok)
					return;
				loaded[name] = await response.arrayBuffer();
			}
			catch {
				// A face that will not load costs the typeface, not the film.
				// The worker reports what it actually attached.
			}
		}));
		return loaded;
	}

	private attachGeometry(canvasParent: HTMLElement, geometrySource: HTMLElement): void {
		this.geometry?.detach();
		this.geometry = new CanvasGeometry(geometrySource, canvasParent);
		this.geometry.attach();
	}

	private teardown(): void {
		this.geometry?.detach();
		this.geometry = null;
		const renderer = this.renderer;
		this.renderer = null;
		renderer?.dispose();
	}

	private resolveContainer(): HTMLElement {
		return this.options.geometrySource
			?? this.options.video.parentElement
			?? document.body;
	}
}
