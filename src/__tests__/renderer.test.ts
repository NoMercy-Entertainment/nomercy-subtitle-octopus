/**
 * LibassRenderer's clock: which time reaches the worker, and when.
 *
 * The video element is a fake with a controllable requestVideoFrameCallback,
 * because the claim under test is "the presented frame's own timestamp wins
 * over the polled currentTime", and a real element cannot be told which frame
 * it presented.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formatProbeReport, summarize } from '../probe';
import { LibassRenderer } from '../renderer';
import type { OctopusOptions } from '../types';

interface Sent { type: string; [key: string]: unknown }

const sent: Sent[] = [];
let listeners: ((event: MessageEvent) => void)[] = [];

class FakeWorker {
	constructor(public url: string) {}
	postMessage(message: Sent): void {
		sent.push(message);
	}

	addEventListener(_name: string, fn: (event: MessageEvent) => void): void {
		listeners.push(fn);
	}

	removeEventListener(_name: string, fn: (event: MessageEvent) => void): void {
		listeners = listeners.filter(listener => listener !== fn);
	}

	terminate(): void {}
}

type FrameCallback = (now: number, metadata: { mediaTime: number }) => void;

class FakeVideo extends EventTarget {
	currentTime = 0;
	videoWidth = 1920;
	videoHeight = 1080;
	clientWidth = 1920;
	clientHeight = 1080;
	parentElement = null;
	frameCallbacks = new Map<number, FrameCallback>();
	canceled: number[] = [];
	private nextId = 1;

	requestVideoFrameCallback = (callback: FrameCallback): number => {
		const id = this.nextId++;
		this.frameCallbacks.set(id, callback);
		return id;
	};

	cancelVideoFrameCallback = (id: number): void => {
		this.canceled.push(id);
		this.frameCallbacks.delete(id);
	};

	/** Present a frame: runs and clears the callbacks registered so far. */
	present(mediaTime: number): void {
		const due = [...this.frameCallbacks.entries()];
		this.frameCallbacks.clear();
		for (const [, callback] of due)
			callback(0, { mediaTime });
	}
}

function makeVideo(withFrameCallback = true): FakeVideo {
	const video = new FakeVideo();
	if (!withFrameCallback) {
		delete (video as Partial<FakeVideo>).requestVideoFrameCallback;
		delete (video as Partial<FakeVideo>).cancelVideoFrameCallback;
	}
	return video;
}

let animationFrames: (() => void)[] = [];

async function startRenderer(video: FakeVideo, extra: Partial<OctopusOptions> = {}): Promise<LibassRenderer> {
	const renderer = new LibassRenderer(
		{ video: video as unknown as HTMLVideoElement, ...extra },
		'worker.js',
		{ onReady: () => {}, onError: () => {} },
	);
	await renderer.start('[Script Info]', {});
	for (const listener of listeners)
		listener({ data: { type: 'nm:ready' } } as MessageEvent);
	return renderer;
}

const times = (): unknown[] => sent.filter(m => m.type === 'nm:time').map(m => m.timeMs);

beforeEach(() => {
	sent.length = 0;
	listeners = [];
	animationFrames = [];
	vi.stubGlobal('Worker', FakeWorker);
	Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
		configurable: true,
		value: () => ({ transferred: true }),
	});
	vi.stubGlobal('requestAnimationFrame', (fn: () => void) => animationFrames.push(fn));
	vi.stubGlobal('cancelAnimationFrame', () => {});
});

describe('the renderer clock with requestVideoFrameCallback', () => {
	it('renders the presented frame\'s mediaTime, not the polled currentTime', async () => {
		const video = makeVideo();
		video.currentTime = 12.4;
		await startRenderer(video);

		video.present(12.345);

		expect(times()).toContain(12345);
		expect(animationFrames).toHaveLength(0);
	});

	it('adds timeOffset to the presented time', async () => {
		const video = makeVideo();
		await startRenderer(video, { timeOffset: 0.5 });

		video.present(12.345);

		expect(times()).toContain(12845);
	});

	it('asks for the next frame after each one', async () => {
		const video = makeVideo();
		await startRenderer(video);

		video.present(1);
		video.present(1.042);

		expect(video.frameCallbacks.size).toBe(1);
	});

	it('renders one frame interval ahead while playing, to land with the frame it is drawn for', async () => {
		const video = makeVideo();
		await startRenderer(video);
		sent.length = 0;

		video.present(10);
		video.present(10.042);
		video.present(10.084);

		expect(times()).toEqual([10000, 10084, 10126]);
	});

	it('adds no lead on the first frame after a seek, a pause or a play', async () => {
		const video = makeVideo();
		await startRenderer(video);
		video.present(10);
		video.present(10.042);

		video.dispatchEvent(new Event('seeked'));
		sent.length = 0;
		video.present(50);
		video.present(50.042);

		expect(times()).toEqual([50000, 50084]);
	});

	it('keeps the lead steady when one frame arrives off the cadence', async () => {
		const video = makeVideo();
		await startRenderer(video);

		for (const t of [10, 10.042, 10.084, 10.126, 10.168, 10.21])
			video.present(t);
		sent.length = 0;
		video.present(10.262);
		video.present(10.294);

		expect(times()).toEqual([10304, 10336]);
	});

	it('adds no lead across a stall longer than a quarter second', async () => {
		const video = makeVideo();
		await startRenderer(video);
		sent.length = 0;

		video.present(10);
		video.present(12);

		expect(times()).toEqual([10000, 12000]);
	});

	it.each(['seeked', 'ratechange', 'play', 'pause'])('sends the current time on %s so a paused video shows the right frame', async (name) => {
		const video = makeVideo();
		await startRenderer(video);
		sent.length = 0;

		video.currentTime = 40.25;
		video.dispatchEvent(new Event(name));

		expect(times()).toEqual([40250]);
	});

	it('stops listening and cancels the pending callback on dispose', async () => {
		const video = makeVideo();
		const renderer = await startRenderer(video);
		const pending = [...video.frameCallbacks.keys()];

		renderer.dispose();
		sent.length = 0;
		video.dispatchEvent(new Event('seeked'));

		expect(video.canceled).toEqual(pending);
		expect(times()).toEqual([]);
	});
});

describe('the renderer clock without requestVideoFrameCallback', () => {
	it('falls back to polling currentTime on animation frames', async () => {
		const video = makeVideo(false);
		video.currentTime = 3.2;
		await startRenderer(video);

		expect(times()).toContain(3200);
		expect(animationFrames.length).toBeGreaterThan(0);
	});

	it('still sends the time on seeked', async () => {
		const video = makeVideo(false);
		await startRenderer(video);
		sent.length = 0;

		video.currentTime = 90;
		video.dispatchEvent(new Event('seeked'));

		expect(times()).toEqual([90000]);
	});
});

describe('the probe', () => {
	it('is off by default and tells the worker so', async () => {
		await startRenderer(makeVideo());

		expect(sent.find(m => m.type === 'nm:init')?.probe).toBe(false);
	});

	it('records mediaTime minus currentTime per frame and the worker\'s render times', async () => {
		const video = makeVideo();
		const renderer = await startRenderer(video, { debug: true });
		expect(sent.find(m => m.type === 'nm:init')?.probe).toBe(true);

		video.currentTime = 10.02;
		video.present(10);
		video.currentTime = 10.06;
		video.present(10.04);
		for (const listener of listeners) {
			listener({ data: { type: 'nm:probe', renderMs: 8, drew: true, dropped: 0 } } as MessageEvent);
			listener({ data: { type: 'nm:probe', renderMs: 40, drew: true, dropped: 3 } } as MessageEvent);
		}

		const report = renderer.probeReport();
		expect(report?.skewMs.count).toBe(2);
		expect(report?.skewMs.max).toBeCloseTo(-20, 5);
		expect(report?.renderMs.max).toBe(40);
		expect(report?.dropped).toBe(3);
		expect(formatProbeReport(report!)).toMatch(/render ms.*p50.*p95.*max/s);
	});

	it('reports nothing when it is off', async () => {
		const renderer = await startRenderer(makeVideo());

		expect(renderer.probeReport()).toBeNull();
	});
});

describe('the caption canvas on a player that is not the video\'s own size', () => {
	it('fits the canvas to its wrapper, keeping the video\'s aspect', async () => {
		const renderer = await startRenderer(makeVideo());

		expect(renderer.canvas.style.width).toBe('100%');
		expect(renderer.canvas.style.height).toBe('100%');
		expect(renderer.canvas.style.objectFit).toBe('contain');
	});

	it('keeps the drawing buffer at the video frame size', async () => {
		const renderer = await startRenderer(makeVideo());

		expect(renderer.canvas.width).toBe(1920);
		expect(renderer.canvas.height).toBe(1080);
	});
});

describe('summarize', () => {
	it('gives count, p50, p95 and max of a sample', () => {
		const sample = Array.from({ length: 100 }, (_, i) => i + 1);

		expect(summarize(sample)).toEqual({ count: 100, p50: 50, p95: 95, max: 100 });
	});

	it('is all zero for an empty sample', () => {
		expect(summarize([])).toEqual({ count: 0, p50: 0, p95: 0, max: 0 });
	});
});
