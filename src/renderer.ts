import type { ProbeReport } from './probe';
import type { OctopusOptions } from './types';
import { summarize } from './probe';

// A paused or seeking video presents no new frame, so these re-send the time.
const CLOCK_EVENTS = ['seeked', 'ratechange', 'play', 'pause'] as const;
const PROBE_SAMPLE_CAP = 20_000;
const MAX_FRAME_STEP = 0.25;
const STEP_WINDOW = 5;
// Frames rendered ahead of the presented one, and how far a predicted time may drift.
const AHEAD_FRAMES = 2;
const MATCH_TOLERANCE_MS = 2;
const MAX_IN_FLIGHT = 6;

interface FrameReply {
	timeMs: number;
	seq: number;
	epoch: number;
	result: 'drawn' | 'same' | 'empty';
	bitmap?: ImageBitmap;
}

// Drives our own libass worker (the same pinned libass as desktop and phone). With frame
// callbacks the worker renders ahead and sends ImageBitmaps; each is drawn on the main
// thread inside the callback of its own frame. Otherwise the canvas moves to the worker.
export class LibassRenderer {
	readonly canvas: HTMLCanvasElement;
	readonly canvasParent: HTMLDivElement;

	private worker: Worker | null = null;
	private frame: number = 0;
	private videoFrame: number = 0;
	private ready = false;
	private readonly probing: boolean;
	private readonly bitmapMode: boolean;
	private context: CanvasRenderingContext2D | null = null;
	private epoch = 0;
	private seq = 0;
	private inFlight = 0;
	private readonly queue: FrameReply[] = [];
	// Latest time asked for ahead, the last restart's time and seq, the last presented frame.
	private requestedTo = -1;
	private restartMs = -1;
	private restartSeq = -1;
	private presentedMs = -1;
	private presented = -1;
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
		this.bitmapMode = typeof this.video.requestVideoFrameCallback === 'function' && typeof OffscreenCanvas !== 'undefined';
		this.onReady = callbacks.onReady;
		this.onError = callbacks.onError;

		this.canvasParent = document.createElement('div');
		this.canvasParent.className = 'nomercy-libass';
		this.canvasParent.style.position = 'absolute';
		this.canvasParent.style.pointerEvents = 'none';

		this.canvas = options.canvas ?? document.createElement('canvas');
		// The buffer is the video frame's size (see start()); the box follows the
		// wrapper, which CanvasGeometry keeps on the player. Without this the
		// canvas shows at its pixel size and only lines up at the video's own size.
		this.canvas.style.width = '100%';
		this.canvas.style.height = '100%';
		this.canvas.style.objectFit = 'contain';
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

		if (this.bitmapMode) {
			this.context = this.canvas.getContext('2d');
			worker.postMessage({
				type: 'nm:init',
				width,
				height,
				glyphCacheMax: this.options.libassGlyphLimit ?? 0,
				bitmapCacheMegabytes: this.options.libassMemoryLimit ?? 0,
				probe: this.probing,
			});
			return;
		}

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
		if (this.bitmapMode && this.ready) {
			this.canvas.width = width;
			this.canvas.height = height;
			this.restart(this.video.currentTime);
		}
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
		this.video.removeEventListener('seeking', this.onSeeking);
		this.flush();

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
		const msg = event.data as { type: string; message?: string; renderMs?: number; drew?: boolean; dropped?: number } & Partial<FrameReply>;
		if (msg.type === 'nm:frame') {
			this.onFrameReply(msg as FrameReply);
		}
		else if (msg.type === 'nm:ready') {
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
			if (!this.bitmapMode) {
				this.dropped = msg.dropped ?? this.dropped;
				if (msg.drew)
					this.drawn++;
			}
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
		this.video.addEventListener('seeking', this.onSeeking);
		if (this.bitmapMode)
			this.restart(this.video.currentTime);
		else
			this.sendTime(this.video.currentTime);

		if (typeof this.video.requestVideoFrameCallback === 'function')
			this.videoFrame = this.video.requestVideoFrameCallback(this.onVideoFrame);
		else
			this.pump();
	}

	private readonly onClockEvent = (event: Event): void => {
		this.lastMediaTime = -1;
		if (this.disposed || !this.ready)
			return;
		if (!this.bitmapMode) {
			this.sendTime(this.video.currentTime);
			return;
		}
		if (event.type === 'ratechange')
			this.steps.length = 0;
		// The picture is the last presented frame; currentTime runs ahead of it, or sits between frames.
		const onScreen = this.presented >= 0 && Math.abs(this.video.currentTime - this.presented) <= MAX_FRAME_STEP;
		const useFrame = onScreen && (event.type === 'pause' || event.type === 'play' || (event.type === 'seeked' && this.presentedSinceSeek));
		const at = useFrame ? this.presented : this.video.currentTime;
		this.restart(at);
		this.presentedMs = -1;
		if (!this.video.paused)
			this.askAhead(at);
	};

	private presentedSinceSeek = true;

	private readonly onSeeking = (): void => {
		this.presentedSinceSeek = false;
	};

	private toMs(seconds: number): number {
		return Math.round((seconds + (this.options.timeOffset ?? 0)) * 1000);
	}

	private request(timeMs: number, force: boolean): number {
		this.worker?.postMessage({ type: 'nm:frame', timeMs, seq: ++this.seq, epoch: this.epoch, force });
		this.inFlight++;
		return this.seq;
	}

	private flush(): void {
		this.epoch++;
		for (const entry of this.queue)
			entry.bitmap?.close();
		this.queue.length = 0;
		this.requestedTo = -1;
	}

	// Drop everything queued and render exactly this time now, with no lead.
	private restart(seconds: number): void {
		this.flush();
		this.restartMs = this.toMs(seconds);
		this.restartSeq = this.request(this.restartMs, true);
		this.requestedTo = this.restartMs;
	}

	private onFrameReply(reply: FrameReply): void {
		this.inFlight = Math.max(0, this.inFlight - 1);
		if (this.disposed || reply.epoch !== this.epoch) {
			reply.bitmap?.close();
			return;
		}
		this.queue.push(reply);
		// A restart's answer is not tied to a callback: draw it unless a later frame is already on screen.
		if (reply.seq === this.restartSeq && (this.video.paused || this.presentedMs < 0 || this.presentedMs <= reply.timeMs + MATCH_TOLERANCE_MS))
			this.showThrough(this.queue.length - 1);
	}

	// Show the newest content up to and including queue[index], then close and remove them all.
	private showThrough(index: number): void {
		let content: FrameReply | null = null;
		for (let i = 0; i <= index; i++) {
			if (this.queue[i].result !== 'same')
				content = this.queue[i];
		}
		if (content && this.context) {
			this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
			if (content.bitmap)
				this.context.drawImage(content.bitmap, 0, 0);
			this.drawn++;
		}
		for (const entry of this.queue.splice(0, index + 1))
			entry.bitmap?.close();
	}

	// Show the queued frame for this time inside its callback. False when none matches.
	private showFrame(timeMs: number): boolean {
		let match = -1;
		for (let i = 0; i < this.queue.length; i++) {
			const delta = this.queue[i].timeMs - timeMs;
			if (delta > MATCH_TOLERANCE_MS)
				break;
			if (delta >= -MATCH_TOLERANCE_MS) {
				match = i;
				break;
			}
		}
		if (match < 0)
			return false;
		this.dropped += match;
		this.showThrough(match);
		return true;
	}

	private askAhead(mediaTime: number): void {
		const step = this.lead();
		if (step <= 0 || this.inFlight >= MAX_IN_FLIGHT)
			return;
		for (let k = 1; k <= AHEAD_FRAMES; k++) {
			const timeMs = this.toMs(mediaTime + k * step);
			if (timeMs > this.requestedTo + MATCH_TOLERANCE_MS) {
				this.request(timeMs, false);
				this.requestedTo = timeMs;
			}
		}
	}

	private onPresentedFrame(metadata: VideoFrameCallbackMetadata, step: number): void {
		const timeMs = this.toMs(metadata.mediaTime);
		this.presented = metadata.mediaTime;
		this.presentedMs = timeMs;
		this.presentedSinceSeek = true;
		const jumped = step < 0 || step > MAX_FRAME_STEP;
		if (this.video.paused || jumped) {
			if (jumped || Math.abs(timeMs - this.restartMs) > MATCH_TOLERANCE_MS)
				this.restart(metadata.mediaTime);
			return;
		}
		if (!this.showFrame(timeMs) && Math.abs(timeMs - this.restartMs) > MATCH_TOLERANCE_MS)
			this.restart(metadata.mediaTime);
		this.askAhead(metadata.mediaTime);
	}

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
		if (this.bitmapMode) {
			this.onPresentedFrame(metadata, step);
			this.videoFrame = this.video.requestVideoFrameCallback(this.onVideoFrame);
			return;
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
