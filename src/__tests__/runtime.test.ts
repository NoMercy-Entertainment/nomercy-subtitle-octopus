// Worker events, cross-origin worker, resize and a supplied canvas (audit AUD-3703, 3704, 3705).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NMSubtitleOctopus } from '../octopus';

interface Sent { type: string; [key: string]: unknown }

const sent: Sent[] = [];
const workers: FakeWorker[] = [];

class FakeWorker {
	private listeners: ((event: MessageEvent) => void)[] = [];

	constructor(public url: string) {
		workers.push(this);
	}

	postMessage(message: Sent): void {
		sent.push(message);
	}

	addEventListener(_name: string, fn: (event: MessageEvent) => void): void {
		this.listeners.push(fn);
	}

	removeEventListener(_name: string, fn: (event: MessageEvent) => void): void {
		this.listeners = this.listeners.filter(listener => listener !== fn);
	}

	terminate(): void {}

	say(data: Sent): void {
		for (const listener of this.listeners)
			listener({ data } as MessageEvent);
	}
}

function makeVideo(): HTMLVideoElement {
	const video = document.createElement('video');
	const parent = document.createElement('div');
	parent.appendChild(video);
	document.body.appendChild(parent);
	return video;
}

const ASS = '[Script Info]\n[Events]\nDialogue: 0,0:00:01.00,0:00:03.00,Main,,0,0,0,,hello\n';

async function settle(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 0));
	await new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(() => {
	sent.length = 0;
	workers.length = 0;
	document.body.innerHTML = '';
	vi.stubGlobal('Worker', FakeWorker);
	vi.stubGlobal('requestAnimationFrame', () => 0);
	vi.stubGlobal('cancelAnimationFrame', () => {});
	const transferred = new WeakSet<HTMLCanvasElement>();
	Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
		configurable: true,
		value(this: HTMLCanvasElement) {
			if (transferred.has(this))
				throw new DOMException('already transferred', 'InvalidStateError');
			transferred.add(this);
			return { transferred: true };
		},
	});
});

describe('worker events reach the public API', () => {
	it('emits ready and fontsLoaded from the worker messages', async () => {
		const player = new NMSubtitleOctopus({ video: makeVideo(), trackContent: ASS });
		const ready = vi.fn();
		const fonts = vi.fn();
		player.on('ready', ready);
		player.on('fontsLoaded', fonts);
		await settle();

		workers[0].say({ type: 'nm:ready' });
		workers[0].say({ type: 'nm:fonts-loaded', count: 2 });

		expect(ready).toHaveBeenCalledTimes(1);
		expect(fonts).toHaveBeenCalledWith({ count: 2 });
		player.dispose();
	});

	it('wraps a cross-origin worker url in a blob worker', async () => {
		vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:wrapped', revokeObjectURL: () => {} }));
		const player = new NMSubtitleOctopus({
			video: makeVideo(),
			trackContent: ASS,
			workerUrl: 'https://cdn.example.test/worker.js',
		});
		await settle();

		expect(workers[0].url).toBe('blob:wrapped');
		player.dispose();
	});

	it('reports a failing worker start as an error event', async () => {
		vi.stubGlobal('Worker', class {
			constructor() {
				throw new Error('SecurityError');
			}
		});
		const errors: Error[] = [];
		const player = new NMSubtitleOctopus({ video: makeVideo(), trackContent: ASS });
		player.on('error', error => errors.push(error));
		await settle();

		expect(errors.map(error => error.message)).toEqual(['SecurityError']);
		player.dispose();
	});
});

describe('the render surface follows the video', () => {
	it('sends nm:resize when the video metadata arrives with a new frame size', async () => {
		const video = makeVideo();
		const player = new NMSubtitleOctopus({ video, trackContent: ASS });
		await settle();
		workers[0].say({ type: 'nm:ready' });

		Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1280 });
		Object.defineProperty(video, 'videoHeight', { configurable: true, value: 720 });
		video.dispatchEvent(new Event('loadedmetadata'));

		expect(sent.filter(m => m.type === 'nm:resize')).toEqual([{ type: 'nm:resize', width: 1280, height: 720 }]);
		player.dispose();
	});

	it('sends nm:resize from the public resize()', async () => {
		const video = makeVideo();
		const player = new NMSubtitleOctopus({ video, trackContent: ASS });
		await settle();
		workers[0].say({ type: 'nm:ready' });

		player.resize();

		expect(sent.filter(m => m.type === 'nm:resize')).toHaveLength(1);
		player.dispose();
	});
});

describe('a canvas supplied by the consumer', () => {
	it('survives a second load and stays where the consumer put it', async () => {
		const video = makeVideo();
		const canvas = document.createElement('canvas');
		const home = document.createElement('div');
		home.appendChild(canvas);
		document.body.appendChild(home);
		const player = new NMSubtitleOctopus({ video, canvas });
		const errors: Error[] = [];
		player.on('error', error => errors.push(error));

		player.trackContent(ASS);
		await settle();
		player.trackContent(`${ASS}\n`);
		await settle();

		expect(sent.filter(m => m.type === 'nm:init')).toHaveLength(2);
		expect(errors).toEqual([]);
		player.dispose();
		expect(canvas.parentElement).toBe(home);
	});
});
