import type { OctopusOptions } from './types';

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
	private ready = false;
	private disposed = false;

	private readonly video: HTMLVideoElement;
	private readonly onReady: () => void;
	private readonly onError: (error: Error) => void;

	constructor(
		private readonly options: OctopusOptions,
		private readonly workerUrl: string,
		callbacks: { onReady: () => void; onError: (error: Error) => void },
	) {
		this.video = options.video;
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
			},
			[surface],
		);

		for (const [name, bytes] of Object.entries(fonts))
			worker.postMessage({ type: 'nm:font', name, bytes }, [bytes]);

		worker.postMessage({ type: 'nm:fonts-done' });
		worker.postMessage({ type: 'nm:track', content });
	}

	/** Resize the render surface after a layout change. */
	resize(): void {
		const width = this.video.videoWidth || this.video.clientWidth || 1;
		const height = this.video.videoHeight || this.video.clientHeight || 1;
		this.worker?.postMessage({ type: 'nm:resize', width, height });
	}

	dispose(): void {
		this.disposed = true;
		if (this.frame)
			cancelAnimationFrame(this.frame);
		this.frame = 0;

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
		const msg = event.data as { type: string; message?: string };
		if (msg.type === 'nm:ready') {
			this.ready = true;
			this.onReady();
			this.pump();
		}
		else if (msg.type === 'nm:error') {
			this.onError(new Error(msg.message ?? 'the libass worker failed'));
		}
	};

	// One message per animation frame, and only when the time actually moved.
	//
	// A paused player would otherwise send sixty identical render requests a
	// second, and the worker would composite the same cue sixty times to produce
	// the same pixels.
	private lastSent = -1;

	private readonly pump = (): void => {
		if (this.disposed || !this.ready)
			return;

		const timeMs = Math.round((this.video.currentTime + (this.options.timeOffset ?? 0)) * 1000);
		if (timeMs !== this.lastSent) {
			this.lastSent = timeMs;
			this.worker?.postMessage({ type: 'nm:time', timeMs });
		}

		this.frame = requestAnimationFrame(this.pump);
	};
}
