import type { ProbeReport } from './probe';
import type { OctopusOptions } from './types';
import { summarize } from './probe';

// A paused or seeking video presents no new frame, so these re-send the time.
const CLOCK_EVENTS = ['seeked', 'ratechange', 'play', 'pause'] as const;
const PROBE_SAMPLE_CAP = 20_000;

/**
 * Drives our own libass worker.
 *
 * This is what replaced the vendored SubtitlesOctopus. That build was a
 * JavaScript port of libass whose version nobody here chose and whose fixes
 * arrived when somebody else made them — the last surface in the trio drawing
 * ASS through code we did not build. The worker underneath is now the same
 * libass, from the same pinned sources, as the desktop DLL and the phone's .so.
 *
 * The canvas is transferred to the worker as an OffscreenCanvas so compositing
 * a frame — a per-cue loop over bitmaps — never runs between a video frame and
 * its deadline.
 */
export class LibassRenderer {
	readonly canvas: HTMLCanvasElement;
	readonly canvasParent: HTMLDivElement;

	private worker: Worker | null = null;
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

	constructor(
		private readonly options: OctopusOptions,
		private readonly workerUrl: string,
		callbacks: { onReady: () => void; onError: (error: Error) => void },
	) {
		this.video = options.video;
		this.probing = options.debug === true;
		this.onReady = callbacks.onReady;
		this.onError = callbacks.onError;

		this.canvasParent = document.createElement('div');
		this.canvasParent.className = 'nomercy-libass';
		this.canvasParent.style.position = 'absolute';
		this.canvasParent.style.pointerEvents = 'none';

		this.canvas = options.canvas ?? document.createElement('canvas');
		this.canvasParent.appendChild(this.canvas);
	}

	async start(content: string, fonts: Record<string, ArrayBuffer>): Promise<void> {
		const worker = new Worker(this.workerUrl, { type: 'classic' });
		this.worker = worker;
		this.pendingTrack = { content, fonts };
		worker.addEventListener('message', this.onMessage);

		// Sized from the video's own frame, not the element's box: libass lays a
		// script out against the resolution it was authored for, and handing it
		// the CSS size puts every \pos in the wrong place on a scaled player.
		const width = this.video.videoWidth || this.video.clientWidth || 1;
		const height = this.video.videoHeight || this.video.clientHeight || 1;
		this.canvas.width = width;
		this.canvas.height = height;

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

	/** Resize the render surface after a layout change. */
	resize(): void {
		const width = this.video.videoWidth || this.video.clientWidth || 1;
		const height = this.video.videoHeight || this.video.clientHeight || 1;
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
		this.canvasParent.remove();
	}

	private readonly onMessage = (event: MessageEvent): void => {
		const msg = event.data as { type: string; message?: string; renderMs?: number; drew?: boolean; dropped?: number };
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
			this.onReady();
			this.startClock();
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
		if (!this.disposed && this.ready)
			this.sendTime(this.video.currentTime);
	};

	private readonly onVideoFrame = (_now: number, metadata: VideoFrameCallbackMetadata): void => {
		if (this.disposed)
			return;

		if (this.probing && this.skewSamples.length < PROBE_SAMPLE_CAP)
			this.skewSamples.push((metadata.mediaTime - this.video.currentTime) * 1000);
		this.sendTime(metadata.mediaTime);
		this.videoFrame = this.video.requestVideoFrameCallback(this.onVideoFrame);
	};

	private readonly pump = (): void => {
		if (this.disposed || !this.ready)
			return;

		this.sendTime(this.video.currentTime);
		this.frame = requestAnimationFrame(this.pump);
	};
}
