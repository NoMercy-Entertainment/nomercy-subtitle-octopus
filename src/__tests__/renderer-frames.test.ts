// Draw each caption in the video-frame callback of its own frame.
// Time is virtual: the worker answers a fixed latency after a request, callbacks fire on a schedule.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LibassRenderer } from '../renderer';

interface Sent { type: string; [key: string]: unknown }
interface Bitmap { timeMs: number; closed: boolean; close: () => void }

const STEP = 1001 / 24000;
const LATENCY_MS = 20;
const TOLERANCE_MS = 2;

let now = 0;
let scheduled: { at: number; run: () => void }[] = [];
let listeners: ((event: MessageEvent) => void)[] = [];
let sent: Sent[] = [];
let bitmaps: Bitmap[] = [];
let screen = -1;
let draws: { at: number; timeMs: number }[] = [];
let video: FakeVideo;

class FakeWorker {
	constructor(public url: string) {}
	postMessage(message: Sent): void {
		sent.push(message);
		const at = now + LATENCY_MS;
		if (message.type === 'nm:frame') {
			scheduled.push({ at, run: () => reply(message) });
		}
		else if (message.type === 'nm:time') {
			// The previous design: the worker owns the canvas, so its commit is the draw.
			scheduled.push({
				at,
				run: () => {
					screen = message.timeMs as number;
				},
			});
		}
	}

	addEventListener(_name: string, fn: (event: MessageEvent) => void): void {
		listeners.push(fn);
	}

	removeEventListener(_name: string, fn: (event: MessageEvent) => void): void {
		listeners = listeners.filter(listener => listener !== fn);
	}

	terminate(): void {}
}

function reply(request: Sent, result: string = 'drawn'): void {
	const data: Sent = { type: 'nm:frame', timeMs: request.timeMs, seq: request.seq, epoch: request.epoch, result };
	if (result === 'drawn') {
		const bitmap: Bitmap = {
			timeMs: request.timeMs as number,
			closed: false,
			close() {
				bitmap.closed = true;
			},
		};
		bitmaps.push(bitmap);
		data.bitmap = bitmap;
	}
	for (const listener of listeners)
		listener({ data } as MessageEvent);
}

class FakeVideo extends EventTarget {
	currentTime = 0;
	paused = false;
	videoWidth = 1280;
	videoHeight = 720;
	clientWidth = 1280;
	clientHeight = 720;
	parentElement = null;
	private callbacks = new Map<number, (now: number, metadata: { mediaTime: number }) => void>();
	private nextId = 1;

	requestVideoFrameCallback = (callback: (now: number, metadata: { mediaTime: number }) => void): number => {
		const id = this.nextId++;
		this.callbacks.set(id, callback);
		return id;
	};

	cancelVideoFrameCallback = (id: number): void => {
		this.callbacks.delete(id);
	};

	present(mediaTime: number): void {
		const due = [...this.callbacks.values()];
		this.callbacks.clear();
		for (const callback of due)
			callback(now, { mediaTime });
	}
}

/** Runs worker answers due up to `until`. */
function advance(until: number): void {
	for (;;) {
		const next = scheduled.filter(item => item.at <= until).sort((a, b) => a.at - b.at)[0];
		if (!next)
			break;
		scheduled = scheduled.filter(item => item !== next);
		now = next.at;
		next.run();
	}
	now = until;
}

// 24 fps on a 60 Hz display: uneven gaps, with some callbacks only 16.5 ms apart.
const GAPS = [41.7, 16.5, 33.4, 50, 16.6, 33.4, 41.6, 16.5, 33.5, 50, 16.7, 33.3];

/** Presents `count` frames from `from` seconds at the uneven gaps; returns the callback times. */
function play(from: number, count: number): number[] {
	const at: number[] = [];
	for (let n = 0; n < count; n++) {
		advance(now + GAPS[n % GAPS.length]);
		at.push(now);
		video.present(from + n * STEP);
	}
	return at;
}

async function startRenderer(): Promise<LibassRenderer> {
	video = new FakeVideo();
	const renderer = new LibassRenderer(
		{ video: video as unknown as HTMLVideoElement },
		'worker.js',
		{ onReady: () => {}, onError: () => {} },
	);
	await renderer.start('[Script Info]', {});
	for (const listener of listeners)
		listener({ data: { type: 'nm:ready' } } as MessageEvent);
	return renderer;
}

const frames = (): Sent[] => sent.filter(m => m.type === 'nm:frame');
const ms = (seconds: number): number => Math.round(seconds * 1000);
const open = (): Bitmap[] => bitmaps.filter(bitmap => !bitmap.closed);

beforeEach(() => {
	now = 0;
	scheduled = [];
	listeners = [];
	sent = [];
	bitmaps = [];
	screen = -1;
	draws = [];
	vi.stubGlobal('Worker', FakeWorker);
	vi.stubGlobal('OffscreenCanvas', class {});
	vi.stubGlobal('requestAnimationFrame', () => 0);
	vi.stubGlobal('cancelAnimationFrame', () => {});
	Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
		configurable: true,
		value: () => ({ transferred: true }),
	});
	vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({
		clearRect: () => { screen = -1; },
		drawImage: (bitmap: Bitmap) => {
			screen = bitmap.timeMs;
			draws.push({ at: now, timeMs: bitmap.timeMs });
		},
	})) as never);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('drawing each caption in the callback of its own frame', () => {
	it('shows the caption of every frame in that frame\'s own callback, with callbacks 16.5 ms apart', async () => {
		await startRenderer();
		const shown: [number, number][] = [];
		for (let n = 0; n < 24; n++) {
			play(n * STEP, 1);
			shown.push([screen, ms(n * STEP)]);
		}

		const late = shown.slice(4).filter(([on, want]) => Math.abs(on - want) > TOLERANCE_MS);
		expect(late).toEqual([]);
	});

	it('draws a bitmap only inside a frame callback and in frame order', async () => {
		await startRenderer();
		const callbackAt = play(0, 16);

		// The first frames render on demand while the cadence is learned.
		const steady = draws.filter(draw => draw.at >= callbackAt[5]);
		expect(steady.length).toBeGreaterThan(8);
		expect(steady.every(draw => callbackAt.includes(draw.at))).toBe(true);
		const order = draws.map(draw => draw.timeMs);
		expect(order).toEqual([...order].sort((a, b) => a - b));
	});

	it('asks the worker for the frame two ahead of the presented one, once the cadence is known', async () => {
		await startRenderer();
		play(10, 5);
		sent.length = 0;

		advance(now + 41.7);
		video.present(10 + 5 * STEP);

		expect(frames().map(m => m.timeMs)).toEqual([ms(10 + 7 * STEP)]);
	});

	it('does not draw a bitmap before its frame is presented', async () => {
		await startRenderer();
		play(10, 6);
		advance(now + 100);

		const last = ms(10 + 5 * STEP);
		expect(open().length).toBeGreaterThan(0);
		expect(draws.filter(draw => draw.timeMs > last + TOLERANCE_MS)).toEqual([]);
		expect(screen).toBeLessThanOrEqual(last + TOLERANCE_MS);
	});

	it('drops and closes a bitmap that is older than the frame', async () => {
		await startRenderer();
		play(10, 4);
		const epoch = frames().at(-1)?.epoch;
		reply({ type: 'nm:frame', timeMs: ms(10 + 0.5 * STEP), seq: 99, epoch });
		const stale = bitmaps.at(-1)!;

		play(10 + 4 * STEP, 3);

		expect(draws.map(d => d.timeMs)).not.toContain(stale.timeMs);
		expect(stale.closed).toBe(true);
	});

	it('closes every bitmap it received once the stream has moved on', async () => {
		const renderer = await startRenderer();
		play(0, 20);
		advance(now + 200);
		renderer.dispose();

		expect(bitmaps.length).toBeGreaterThan(10);
		expect(open()).toEqual([]);
	});

	it('renders the start time with no lead once the worker is ready', async () => {
		await startRenderer();

		expect(frames()[0]).toMatchObject({ type: 'nm:frame', timeMs: 0, force: true });
	});
});

describe('seek, pause and rate changes', () => {
	it('flushes queued bitmaps on seek and asks for the new time with no lead', async () => {
		await startRenderer();
		play(10, 8);
		advance(now + 100);
		const queued = open();
		expect(queued.length).toBeGreaterThan(0);

		video.currentTime = 50;
		sent.length = 0;
		video.dispatchEvent(new Event('seeked'));

		expect(queued.every(bitmap => bitmap.closed)).toBe(true);
		expect(frames()[0]).toMatchObject({ timeMs: 50000, force: true });
		expect(frames().slice(1).map(m => m.force)).toEqual([false, false]);
	});

	it('ignores a reply that belongs to the time before the seek', async () => {
		await startRenderer();
		play(10, 6);
		const before = frames().at(-1)!;
		video.currentTime = 50;
		video.dispatchEvent(new Event('seeked'));
		const drawsBefore = draws.length;

		reply(before);

		expect(draws.length).toBe(drawsBefore);
		expect(bitmaps.at(-1)!.closed).toBe(true);
	});

	it('draws the answer to a seek at once, without waiting for a frame callback', async () => {
		await startRenderer();
		play(10, 4);
		video.paused = true;
		video.currentTime = 50;
		video.dispatchEvent(new Event('seeked'));
		advance(now + 100);

		expect(screen).toBe(50000);
	});

	it('on pause renders the last presented frame, not the audio clock, and draws it at once', async () => {
		await startRenderer();
		play(10, 4);
		video.paused = true;
		video.currentTime = 10 + 5 * STEP;
		sent.length = 0;

		video.dispatchEvent(new Event('pause'));
		advance(now + 100);

		expect(frames()[0]).toMatchObject({ timeMs: ms(10 + 3 * STEP), force: true });
		expect(screen).toBe(ms(10 + 3 * STEP));
	});

	it('asks for no frame ahead while paused', async () => {
		await startRenderer();
		play(10, 4);
		video.paused = true;
		video.currentTime = 10 + 3 * STEP;
		video.dispatchEvent(new Event('pause'));
		advance(now + 100);
		sent.length = 0;

		video.present(10 + 3 * STEP);

		expect(frames()).toEqual([]);
	});

	it('starts over at the frame time after a gap longer than a quarter second', async () => {
		await startRenderer();
		play(10, 5);
		sent.length = 0;

		advance(now + 600);
		video.present(20);

		expect(frames()[0]).toMatchObject({ timeMs: 20000, force: true });
	});

	it('starts over on a rate change', async () => {
		await startRenderer();
		play(10, 6);
		advance(now + 100);
		const queued = open();
		expect(queued.length).toBeGreaterThan(0);
		video.currentTime = 10 + 5 * STEP;
		sent.length = 0;

		video.dispatchEvent(new Event('ratechange'));

		expect(frames()[0]).toMatchObject({ force: true });
		expect(queued.every(bitmap => bitmap.closed)).toBe(true);
	});

	it('does not transfer the canvas and tells the worker so by sending none', async () => {
		await startRenderer();

		const init = sent.find(m => m.type === 'nm:init');
		expect(init?.canvas).toBeUndefined();
		expect(init?.width).toBe(1280);
	});
});
