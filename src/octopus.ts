import type { OctopusEvents, OctopusOptions } from './types';
import { CanvasGeometry } from './canvas-geometry';
import { isSupportedSubtitle, sweepOrphanCanvases } from './lifecycle';
import { resolveUrl } from './url-resolution';
import { EventEmitter } from './worker-bridge';
// eslint-disable-next-line ts/ban-ts-comment
// @ts-ignore — upstream JS file shipped alongside its declaration in `public/`.
import SubtitlesOctopus from '../public/subtitles-octopus.js';
import type { SubtitlesOctopusOptions as UpstreamOptions } from '../public/subtitles-octopus';

/**
 * Default worker paths relative to this package's `public/` directory.
 * Consumers override via `options.workerUrl` / `options.legacyWorkerUrl`.
 */
const DEFAULT_WORKER_URL = new URL('../public/subtitles-octopus-worker.js', import.meta.url).href;
const DEFAULT_LEGACY_WORKER_URL = new URL('../public/subtitles-octopus-worker-legacy.js', import.meta.url).href;
const DEFAULT_FALLBACK_FONT = new URL('../public/default.ttf', import.meta.url).href;

interface UpstreamInstance {
	worker: Worker;
	canvasParent: HTMLDivElement;
	dispose: () => void;
}

/**
 * NMSubtitleOctopus — NoMercy headless libass renderer wrapper.
 *
 * Wraps the upstream `SubtitlesOctopus` (vendored from libass-wasm) and
 * layers NoMercy patches around it:
 *
 *   Patch 1 (worker)   — cross-origin Blob+importScripts shim is upstream
 *                        behaviour; nothing to do.
 *   Patch 2 (geometry) — `CanvasGeometry` ResizeObserver overrides upstream's
 *                        `<video>`-anchored canvas position so the canvas
 *                        tracks the player's overlay through fullscreen /
 *                        theater / float transitions.
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

	private upstream: UpstreamInstance | null = null;
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
		if (url === this._trackUrl && this.upstream)
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
	 * Upstream syncs from the bound `<video>` element via its own listeners —
	 * this method exists for parity and explicit control. Reading returns the
	 * last value we cached.
	 */
	currentTime(): number;
	currentTime(seconds: number): void;
	currentTime(seconds?: number): number | void {
		if (seconds === undefined)
			return this._currentTime;
		this._currentTime = seconds;
		// Upstream tracks the video element automatically; explicit setter
		// is a no-op against the renderer but useful for headless tests.
	}

	/** Tear down the current track without destroying the renderer. */
	freeTrack(): void {
		this._trackUrl = null;
		this._trackContent = null;
		this.loadId += 1;
		this.disposeUpstream();
	}

	/** Signal a resize so the canvas geometry syncs immediately (Patch 3). */
	resize(): void {
		this.geometry?.detach();
		this.geometry?.attach();
	}

	/** Tear down the renderer, worker, and all DOM side-effects. */
	dispose(): void {
		this.loadId += 1;
		this.disposeUpstream();
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

	/** Direct handle to the upstream renderer. Plugin retains lifecycle ownership. */
	upstreamInstance(): UpstreamInstance | null {
		return this.upstream;
	}

	// ---------------------------------------------------------------------------
	// Private
	// ---------------------------------------------------------------------------

	private async load(url: string | null, content: string | null): Promise<void> {
		const id = ++this.loadId;

		// Patch 4: tear down previous instance and orphan canvases.
		this.disposeUpstream();
		const container = this.resolveContainer();
		sweepOrphanCanvases(container);

		// Patch 5: resolve URLs through basePath + isAbsolute classifier.
		const resolvedSub = url ? resolveUrl(this.options.basePath, url) : '';
		const fontUrls = (this.options.fonts ?? []).map(f =>
			resolveUrl(this.options.basePath, f),
		);

		// Inline-content path bypasses upstream URL fetch entirely.
		if (content && !url) {
			this._trackContent = content;
			this._trackUrl = null;
			this.mountUpstream({
				video: this.options.video,
				subContent: content,
				fonts: fontUrls,
			} as UpstreamOptions & { subContent: string }, id);
			return;
		}

		this._trackUrl = url;
		this._trackContent = null;

		this.mountUpstream({
			video: this.options.video,
			subUrl: resolvedSub,
			fonts: fontUrls,
		}, id);
	}

	private mountUpstream(extra: Partial<UpstreamOptions>, id: number): void {
		if (id !== this.loadId)
			return;

		const upstreamOpts: UpstreamOptions = {
			video: this.options.video,
			subUrl: '',
			...extra,
			workerUrl: this.options.workerUrl ?? DEFAULT_WORKER_URL,
			legacyWorkerUrl: this.options.legacyWorkerUrl ?? DEFAULT_LEGACY_WORKER_URL,
			fallbackFont: this.options.fallbackFont ?? DEFAULT_FALLBACK_FONT,
			targetFps: this.options.targetFps,
			lazyFileLoading: this.options.lazyFileLoading,
			lossyRender: this.options.lossyRender ?? this.options.renderMode === 'lossy',
			blendRender: this.options.renderMode === 'wasm-blend' || this.options.renderMode === 'js-blend',
			renderAhead: this.options.renderAhead,
			debug: this.options.debug,
			onReady: () => {
				if (id !== this.loadId)
					return;
				this.emitter.emit('rendererReady', { url: this._trackUrl ?? '' });
			},
			onError: (event: unknown) => {
				if (id !== this.loadId)
					return;
				const err = event instanceof Error ? event : new Error(String(event));
				this.emitter.emit('error', err);
			},
		};

		const Ctor = SubtitlesOctopus as unknown as new (opts: UpstreamOptions) => UpstreamInstance;
		this.upstream = new Ctor(upstreamOpts);

		// Patch 3: override upstream's <video>-anchored canvas geometry once
		// the canvas parent is in the DOM.
		const geometrySource = this.options.geometrySource ?? this.resolveContainer();
		this.attachGeometry(this.upstream.canvasParent, geometrySource);
	}

	private attachGeometry(canvasParent: HTMLElement, geometrySource: HTMLElement): void {
		this.geometry?.detach();
		this.geometry = new CanvasGeometry(geometrySource, canvasParent);
		this.geometry.attach();
	}

	private disposeUpstream(): void {
		this.geometry?.detach();
		this.geometry = null;
		const inst = this.upstream;
		this.upstream = null;
		if (!inst)
			return;
		try {
			inst.worker?.terminate();
		}
		catch {
			// Defensive — never let teardown errors escape.
		}
		try {
			if (inst.canvasParent)
				inst.dispose();
		}
		catch {
			// Same — upstream's dispose can throw on a half-initialised state.
		}
	}

	private resolveContainer(): HTMLElement {
		return this.options.geometrySource
			?? this.options.video.parentElement
			?? document.body;
	}
}
