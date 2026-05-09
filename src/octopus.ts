import type { OctopusEvents, OctopusOptions } from './types';
import { prefetchWithAuth } from './auth';
import { CanvasGeometry } from './canvas-geometry';
import { isSupportedSubtitle, Lifecycle, RaceToken, sweepOrphanCanvases } from './lifecycle';
import { resolveUrl } from './url-resolution';
import { createWorker, EventEmitter, WorkerBridge } from './worker-bridge';

/**
 * Default worker paths relative to this package's `public/` directory.
 * Consumers override via `options.workerUrl` / `options.legacyWorkerUrl`.
 */
const DEFAULT_WORKER_URL = new URL('../public/subtitles-octopus-worker.js', import.meta.url).href;
const DEFAULT_FALLBACK_FONT = new URL('../public/default.ttf', import.meta.url).href;

/**
 * NMSubtitleOctopus — NoMercy headless libass renderer wrapper.
 *
 * All five v1 patch families are built in:
 *   Patch 1 (auth)     — main-thread pre-fetch via fetchWithAuth in auth.ts
 *   Patch 2 (worker)   — cross-origin Blob instantiation in worker-bridge.ts
 *   Patch 3 (geometry) — ResizeObserver canvas sync in canvas-geometry.ts
 *   Patch 4 (lifecycle)— race guards + orphan sweep in lifecycle.ts
 *   Patch 5 (urls)     — basePath prepend + encodeURI in url-resolution.ts
 *
 * Public API uses overloaded noun() / noun(value) form — no setX methods.
 */
export class NMSubtitleOctopus {
	private readonly options: OctopusOptions;
	private readonly emitter = new EventEmitter();
	private readonly lifecycle = new Lifecycle();

	private bridge: WorkerBridge | null = null;
	private geometry: CanvasGeometry | null = null;
	private canvasParent: HTMLElement | null = null;

	private _trackUrl: string | null = null;
	private _trackContent: string | null = null;
	private _currentTime: number = 0;

	/** Blob URLs allocated during pre-fetch that must be revoked on teardown. */
	private pendingBlobUrls: string[] = [];

	/** Token to detect and abort stale async loads (Patch 4). */
	private raceToken: RaceToken = new RaceToken();

	constructor(options: OctopusOptions) {
		this.options = options;

		if (options.trackUrl) {
			// Defer one microtask so callers can attach `on('ready')` synchronously.
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
		if (url === this._trackUrl)
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

	/** Get the current playback position in seconds. */
	currentTime(): number;
	/** Sync the renderer to `seconds`. */
	currentTime(seconds: number): void;
	currentTime(seconds?: number): number | void {
		if (seconds === undefined)
			return this._currentTime;
		this._currentTime = seconds;
		this.bridge?.worker.postMessage({ type: 'nm:set-time', seconds });
	}

	/** Tear down the current track without destroying the renderer. */
	freeTrack(): void {
		this._trackUrl = null;
		this._trackContent = null;
		this.raceToken.cancelled = true;
		this.raceToken = new RaceToken();
		this.revokePendingBlobs();
		this.bridge?.worker.postMessage({ type: 'nm:free-track' });
	}

	/** Signal a resize so the canvas geometry syncs immediately (Patch 3). */
	resize(): void {
		this.geometry?.detach();
		this.geometry?.attach();
	}

	/** Tear down the renderer, worker, and all DOM side-effects. */
	dispose(): void {
		this.raceToken.cancelled = true;
		this.revokePendingBlobs();
		this.geometry?.detach();
		this.geometry = null;
		this.bridge?.dispose();
		this.bridge = null;
		this.canvasParent?.remove();
		this.canvasParent = null;
		this._trackUrl = null;
		this._trackContent = null;
		this.lifecycle.destroy();
		this.emitter.removeAll();
	}

	on<K extends keyof OctopusEvents>(name: K, fn: (data: OctopusEvents[K]) => void): void {
		this.emitter.on(name, fn);
	}

	off<K extends keyof OctopusEvents>(name: K, fn: (data: OctopusEvents[K]) => void): void {
		this.emitter.off(name, fn);
	}

	// ---------------------------------------------------------------------------
	// Private
	// ---------------------------------------------------------------------------

	private async load(url: string | null, content: string | null): Promise<void> {
		// Invalidate any in-flight load (Patch 4).
		this.raceToken.cancelled = true;
		const token = new RaceToken();
		this.raceToken = token;

		this.revokePendingBlobs();
		this.teardownBridge();

		// Sweep stale libass canvas parents left by a previous instance (Patch 4).
		const container = this.resolveContainer();
		sweepOrphanCanvases(container);

		const workerUrl = this.options.workerUrl ?? DEFAULT_WORKER_URL;
		const fallbackFont = this.options.fallbackFont ?? DEFAULT_FALLBACK_FONT;
		const fontUrls = [fallbackFont, ...(this.options.fonts ?? [])].map(f =>
			resolveUrl(this.options.basePath, f),
		);

		let resolvedSubUrl: string | null = null;
		let resolvedContent: string | null = content;
		const blobUrls: string[] = [];

		try {
			if (url) {
				const resolved = resolveUrl(this.options.basePath, url);

				// Patch 1: pre-fetch with auth on main thread, pass blob URL to worker.
				const { subtitleBlobUrl, fontBlobUrls } = await prefetchWithAuth(
					resolved,
					fontUrls,
					this.options,
				);

				if (token.cancelled) {
					URL.revokeObjectURL(subtitleBlobUrl);
					fontBlobUrls.forEach(u => URL.revokeObjectURL(u));
					return;
				}

				blobUrls.push(subtitleBlobUrl, ...fontBlobUrls);
				resolvedSubUrl = subtitleBlobUrl;
				this.pendingBlobUrls = blobUrls;
				this._trackUrl = url;
				this._trackContent = null;
			}
			else if (content) {
				// Inline content — auth pre-fetch not needed for font URLs only.
				const { fontBlobUrls } = await prefetchWithAuth('', fontUrls, this.options);
				if (token.cancelled) {
					fontBlobUrls.forEach(u => URL.revokeObjectURL(u));
					return;
				}
				blobUrls.push(...fontBlobUrls);
				this.pendingBlobUrls = blobUrls;
				resolvedContent = content;
				this._trackContent = content;
				this._trackUrl = null;
			}
		}
		catch (err) {
			if (!token.cancelled) {
				this.emitter.emit('error', err instanceof Error ? err : new Error(String(err)));
			}
			return;
		}

		if (token.cancelled)
			return;

		// Patch 2: cross-origin worker creation handled inside createWorker.
		const worker = createWorker(workerUrl);
		this.bridge = new WorkerBridge(worker, this.emitter);
		this.lifecycle.addCleanup(() => this.bridge?.dispose());

		// Send init context — worker dir for WASM asset resolution (Patch 2).
		const dir = workerUrl.slice(0, workerUrl.lastIndexOf('/') + 1);
		worker.postMessage({ type: 'nm:init', workerDir: dir });

		if (resolvedSubUrl) {
			worker.postMessage({ type: 'nm:set-track-url', url: resolvedSubUrl });
			this.emitter.emit('rendererReady', { url: this._trackUrl! });
		}
		else if (resolvedContent) {
			worker.postMessage({ type: 'nm:set-track-content', content: resolvedContent });
		}

		// Patch 3: wire canvas geometry once the worker has created the canvas parent.
		const geometrySource = this.options.geometrySource ?? this.resolveContainer();
		this.waitForCanvasParent(container, geometrySource, token);
	}

	/**
	 * Poll for the `.libassjs-canvas-parent` element created by the worker,
	 * then attach the ResizeObserver geometry sync (Patch 3).
	 * Uses MutationObserver to avoid busy-polling.
	 */
	private waitForCanvasParent(container: HTMLElement, geometrySource: HTMLElement, token: RaceToken): void {
		const existing = container.querySelector<HTMLElement>('.libassjs-canvas-parent');
		if (existing) {
			this.attachGeometry(existing, geometrySource);
			return;
		}

		const mo = new MutationObserver(() => {
			if (token.cancelled) {
				mo.disconnect();
				return;
			}
			const el = container.querySelector<HTMLElement>('.libassjs-canvas-parent');
			if (el) {
				mo.disconnect();
				this.canvasParent = el;
				this.attachGeometry(el, geometrySource);
			}
		});
		mo.observe(container, { childList: true, subtree: true });
		this.lifecycle.addCleanup(() => mo.disconnect());
	}

	private attachGeometry(canvasParent: HTMLElement, geometrySource: HTMLElement): void {
		this.geometry?.detach();
		this.geometry = new CanvasGeometry(geometrySource, canvasParent);
		this.geometry.attach();
	}

	private teardownBridge(): void {
		this.bridge?.dispose();
		this.bridge = null;
		this.geometry?.detach();
		this.geometry = null;
	}

	private revokePendingBlobs(): void {
		this.pendingBlobUrls.forEach(u => URL.revokeObjectURL(u));
		this.pendingBlobUrls = [];
	}

	private resolveContainer(): HTMLElement {
		return this.options.geometrySource
			?? this.options.video.parentElement
			?? document.body;
	}
}
