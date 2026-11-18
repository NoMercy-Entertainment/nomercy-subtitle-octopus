import type { ProbeReport } from './probe';
import type { OctopusOptions } from './types';
import { summarize } from './probe';
import type { Size } from './render-size';
import { renderSizeFor, renderTierFor } from './render-size';
import { createWorker } from './worker-bridge';

// A canvas moves to a worker once; a later renderer needs a fresh one.
const transferredCanvases = new WeakSet<HTMLCanvasElement>();

// A paused or seeking video presents no new frame, so these re-send the time.
const CLOCK_EVENTS = ['seeked', 'ratechange', 'play', 'pause'] as const;
const RESIZE_EVENTS = ['loadedmetadata', 'resize'] as const;
const PROBE_SAMPLE_CAP = 20_000;
const MAX_FRAME_STEP = 0.25;
const STEP_WINDOW = 5;

// Drives our own libass worker (the same pinned libass as desktop and phone). The canvas
// moves to the worker as an OffscreenCanvas so compositing never runs between a frame
// and its deadline.
export class LibassRenderer {
	readonly canvas: HTMLCanvasElement;
	readonly canvasParent: HTMLDivElement;

	private worker: Worker | null = null;
	private boxObserver: ResizeObserver | null = null;
	private sentWidth = 0;
	private sentHeight = 0;
	private frame: number = 0;
	private videoFrame: number = 0;
	private ready = false;
	private readonly probing: boolean;
	private readonly renderSamples: number[] = [];
	private readonly skewSamples: number[] = [];
	private dropped = 0;
	private drawn = 0;
	private disposed = false;
	private pendingTrack: { content: string; fonts: Record<string, ArrayBuffer> } | null = null;

	private readonly video: HTMLVideoElement;
	private readonly onReady: () => void;
	private readonly onError: (error: Error) => void;
	private readonly onFontsLoaded: (count: number) => void;
	private readonly suppliedCanvas: HTMLCanvasElement | null;
	private readonly suppliedHome: { parent: Node; next: Node | null } | null;

	constructor(
		private readonly options: OctopusOptions,
		private readonly workerUrl: string,
		callbacks: { onReady: () => void; onError: (error: Error) => void; onFontsLoaded?: (count: number) => void },
	) {
		this.video = options.video;
		this.probing = options.debug === true;
		this.onReady = callbacks.onReady;
		this.onError = callbacks.onError;
		this.onFontsLoaded = callbacks.onFontsLoaded ?? (() => {});

		this.canvasParent = document.createElement('div');
		this.canvasParent.className = 'nomercy-libass';
		this.canvasParent.style.position = 'absolute';
		this.canvasParent.style.pointerEvents = 'none';

		const supplied = options.canvas && !transferredCanvases.has(options.canvas) ? options.canvas : null;
		this.suppliedCanvas = supplied;
		this.suppliedHome = supplied?.parentNode ? { parent: supplied.parentNode, next: supplied.nextSibling } : null;
		this.canvas = supplied ?? document.createElement('canvas');
		// The buffer is the video frame's size (see start()); the box follows the
		// wrapper, which CanvasGeometry keeps on the player. Without this the
		// canvas shows at its pixel size and only lines up at the video's own size.
		this.canvas.style.width = '100%';
		this.canvas.style.height = '100%';
		this.canvas.style.objectFit = 'contain';
		this.canvasParent.appendChild(this.canvas);
	}

	async start(content: string, fonts: Record<string, ArrayBuffer>): Promise<void> {
		const worker = createWorker(this.workerUrl);
		this.worker = worker;
		this.pendingTrack = { content, fonts };
		worker.addEventListener('message', this.onMessage);
		for (const name of RESIZE_EVENTS)
			this.video.addEventListener(name, this.onResizeEvent);

		const { width, height } = this.renderSize();
		this.sentWidth = width;
		this.sentHeight = height;
		this.canvas.width = width;
		this.canvas.height = height;
		if (typeof ResizeObserver !== 'undefined') {
			this.boxObserver = new ResizeObserver(this.onResizeEvent);
			this.boxObserver.observe(this.canvasParent);
		}

		transferredCanvases.add(this.canvas);
		const surface = this.canvas.transferControlToOffscreen();
		worker.postMessage(
			{
				type: 'nm:init',
				canvas: surface,
				width,
				height,
				glyphCacheMax: this.options.libassGlyphLimit ?? 0,
				bitmapCacheMegabytes: this.options.libassMemoryLimit ?? 0,
				probe: this.probing,
			},
			[surface],
		);
	}

	// A box that moves without changing the capped size would only make the worker
	// reallocate its frame, so the observer and the video events send changes only.
	private readonly onResizeEvent = (): void => {
		const { width, height } = this.renderSize();
		if (width !== this.sentWidth || height !== this.sentHeight)
			this.resize();
	};

	// The video's aspect, at the size it is shown (CSS box x pixel ratio), capped by
	// the device tier. Never the CSS size: libass places \pos by the script's own aspect.
	private renderSize(): Size {
		const video: Size = {
			width: this.video.videoWidth || this.video.clientWidth || 1,
			height: this.video.videoHeight || this.video.clientHeight || 1,
		};
		// The rect, not clientWidth: a player scaled by a CSS transform shows a smaller box than it lays out.
		const shown = this.canvasParent.getBoundingClientRect();
		const box: Size = {
			width: shown.width || this.video.clientWidth,
			height: shown.height || this.video.clientHeight,
		};
		const nav = typeof navigator === 'undefined' ? undefined : navigator as Navigator & { deviceMemory?: number };
		const tier = renderTierFor(nav?.deviceMemory, nav?.hardwareConcurrency, nav?.userAgent);
		return renderSizeFor(video, box, globalThis.devicePixelRatio || 1, tier);
	}

	/** Resize the render surface after a layout change. */
	resize(): void {
		// The worker has no canvas until its init finishes; nm:ready catches up.
		if (!this.ready)
			return;
		const { width, height } = this.renderSize();
		this.sentWidth = width;
		this.sentHeight = height;
		this.worker?.postMessage({ type: 'nm:resize', width, height });
	}

	/** Percentiles of what the opt-in probe (`debug: true`) measured; null when it is off. */
	probeReport(): ProbeReport | null {
		if (!this.probing)
			return null;
		return {
			renderMs: summarize(this.renderSamples),
			skewMs: summarize(this.skewSamples),
			dropped: this.dropped,
			drawn: this.drawn,
		};
	}

	dispose(): void {
		this.disposed = true;
		this.pendingTrack = null;
		if (this.frame)
			cancelAnimationFrame(this.frame);
		this.frame = 0;
		if (this.videoFrame)
			this.video.cancelVideoFrameCallback?.(this.videoFrame);
		this.videoFrame = 0;
		for (const name of CLOCK_EVENTS)
			this.video.removeEventListener(name, this.onClockEvent);
		for (const name of RESIZE_EVENTS)
			this.video.removeEventListener(name, this.onResizeEvent);

		this.boxObserver?.disconnect();
		this.boxObserver = null;
		const worker = this.worker;
		this.worker = null;
		if (worker) {
			worker.removeEventListener('message', this.onMessage);
			try {
				worker.terminate();
			}
			catch {
				// Teardown never throws outward.
			}
		}
		if (this.suppliedCanvas && this.suppliedHome)
			this.suppliedHome.parent.insertBefore(this.suppliedCanvas, this.suppliedHome.next);
		this.canvasParent.remove();
	}

	private readonly onMessage = (event: MessageEvent): void => {
		const msg = event.data as { type: string; message?: string; count?: number; renderMs?: number; drew?: boolean; dropped?: number };
		if (msg.type === 'nm:ready') {
			if (this.disposed || this.ready)
				return;
			this.ready = true;
			const pending = this.pendingTrack;
			this.pendingTrack = null;
			if (pending && this.worker) {
				for (const [name, bytes] of Object.entries(pending.fonts))
					this.worker.postMessage({ type: 'nm:font', name, bytes }, [bytes]);
				this.worker.postMessage({ type: 'nm:fonts-done' });
				this.worker.postMessage({ type: 'nm:track', content: pending.content });
			}
			this.onResizeEvent();
			this.onReady();
			this.startClock();
		}
		else if (msg.type === 'nm:fonts-loaded') {
			this.onFontsLoaded(msg.count ?? 0);
		}
		else if (msg.type === 'nm:probe' && this.probing) {
			if (this.renderSamples.length < PROBE_SAMPLE_CAP)
				this.renderSamples.push(msg.renderMs ?? 0);
			this.dropped = msg.dropped ?? this.dropped;
			if (msg.drew)
				this.drawn++;
		}
		else if (msg.type === 'nm:error') {
			this.onError(new Error(msg.message ?? 'the libass worker failed'));
		}
	};

	// Only when the time actually moved: a paused player would otherwise send
	// sixty identical render requests a second for the same pixels.
	private lastSent = -1;

	private sendTime(seconds: number): void {
		const timeMs = Math.round((seconds + (this.options.timeOffset ?? 0)) * 1000);
		if (timeMs === this.lastSent)
			return;
		this.lastSent = timeMs;
		this.worker?.postMessage({ type: 'nm:time', timeMs });
	}

	// The presented frame's own timestamp when the browser reports it. Polling
	// currentTime reads the audio clock, which runs ahead of the picture, so a
	// moving sign lands a frame or two off the video it is drawn on.
	private startClock(): void {
		for (const name of CLOCK_EVENTS)
			this.video.addEventListener(name, this.onClockEvent);
		this.sendTime(this.video.currentTime);

		if (typeof this.video.requestVideoFrameCallback === 'function')
			this.videoFrame = this.video.requestVideoFrameCallback(this.onVideoFrame);
		else
			this.pump();
	}

	private readonly onClockEvent = (): void => {
		this.lastMediaTime = -1;
		if (!this.disposed && this.ready)
			this.sendTime(this.video.currentTime);
	};

	// The worker draws async and the canvas commits a frame later, so ask one
	// frame interval ahead to land with frame N. No lead while paused.
	private lastMediaTime = -1;
	private lastAsked = -1;
	private readonly steps: number[] = [];

	// Median of recent steps, so one odd frame cannot jitter the lead.
	private lead(): number {
		if (this.steps.length === 0)
			return 0;
		const sorted = [...this.steps].sort((a, b) => a - b);
		return sorted[Math.floor(sorted.length / 2)];
	}

	private readonly onVideoFrame = (_now: number, metadata: VideoFrameCallbackMetadata): void => {
		if (this.disposed)
			return;

		if (this.probing && this.skewSamples.length < PROBE_SAMPLE_CAP)
			this.skewSamples.push((metadata.mediaTime - this.video.currentTime) * 1000);
		const step = this.lastMediaTime < 0 ? 0 : metadata.mediaTime - this.lastMediaTime;
		this.lastMediaTime = metadata.mediaTime;
		if (step > 0 && step <= MAX_FRAME_STEP) {
			this.steps.push(step);
			if (this.steps.length > STEP_WINDOW)
				this.steps.shift();
		}
		let asked = metadata.mediaTime + (this.video.paused ? 0 : this.lead());
		if (!this.video.paused && step > 0 && asked < this.lastAsked)
			asked = this.lastAsked;
		this.lastAsked = asked;
		this.sendTime(asked);
		this.videoFrame = this.video.requestVideoFrameCallback(this.onVideoFrame);
	};

	private readonly pump = (): void => {
		if (this.disposed || !this.ready)
			return;

		this.sendTime(this.video.currentTime);
		this.frame = requestAnimationFrame(this.pump);
	};
}
