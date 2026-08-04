/**
 * NMSubtitleOctopus against its own worker.
 *
 * These tests used to mock the vendored SubtitlesOctopus module and assert
 * which options reached its constructor. The guarantee they existed for is
 * kept — availableFonts must reach the renderer, because an ASS file whose
 * faces are skipped renders in a fallback and CJK produces no visible text —
 * but it is asserted one level lower now: the font arrives at the worker as
 * BYTES, under the family name, before the track does.
 *
 * That is a stronger claim than the old one, and it is the exact failure that
 * cost a session on the phone: a fetcher answering with text and no bytes let
 * the track load, report success, and draw in the wrong typeface.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NMSubtitleOctopus } from '../octopus';

interface SentMessage { type: string; [key: string]: unknown }

const sent: SentMessage[] = [];
let lastWorker: FakeWorker | null = null;

class FakeWorker {
	private listeners: ((event: MessageEvent) => void)[] = [];

	constructor(public url: string) {
		// Recorded so a test can answer as the worker would: the class is what
		// the code under test constructs, so there is no instance to spy on.
		// eslint-disable-next-line ts/no-this-alias
		lastWorker = this;
	}

	postMessage(message: SentMessage): void {
		sent.push(message);
	}

	addEventListener(_name: string, fn: (event: MessageEvent) => void): void {
		this.listeners.push(fn);
	}

	removeEventListener(_name: string, fn: (event: MessageEvent) => void): void {
		this.listeners = this.listeners.filter(listener => listener !== fn);
	}

	terminate(): void {}

	/** Answer as the real worker does once it holds a library and a renderer. */
	announceReady(): void {
		for (const listener of this.listeners)
			listener({ data: { type: 'nm:ready' } } as MessageEvent);
	}
}

function makeVideoElement(): HTMLVideoElement {
	const video = document.createElement('video');
	const parent = document.createElement('div');
	parent.appendChild(video);
	document.body.appendChild(parent);
	return video;
}

const ASS = '[Script Info]\n[V4+ Styles]\nStyle: Main,Negotiate Free,68\n[Events]\nDialogue: 0,0:00:01.00,0:00:03.00,Main,,0,0,0,,hello\n';

beforeEach(() => {
	sent.length = 0;
	lastWorker = null;
	document.body.innerHTML = '';
	vi.stubGlobal('Worker', FakeWorker);
	// happy-dom has no OffscreenCanvas, and transferControlToOffscreen is what
	// the renderer hands the worker.
	Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
		configurable: true,
		value: () => ({ transferred: true }),
	});
	vi.stubGlobal('requestAnimationFrame', () => 0);
	vi.stubGlobal('cancelAnimationFrame', () => {});
});

async function settle(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 0));
	await new Promise(resolve => setTimeout(resolve, 0));
}

describe('nMSubtitleOctopus — the worker protocol', () => {
	it('sends every font before the track, because libass resolves a face as it draws', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => ({
			ok: true,
			status: 200,
			arrayBuffer: async () => new Uint8Array([0, 1, 2, 3]).buffer,
		})));

		const player = new NMSubtitleOctopus({
			video: makeVideoElement(),
			trackContent: ASS,
			availableFonts: { 'negotiate free': 'https://media.test/negotiate.ttf' },
		});
		await settle();

		const order = sent.map(message => message.type);
		expect(order).toContain('nm:init');
		expect(order.indexOf('nm:font')).toBeGreaterThanOrEqual(0);
		expect(order.indexOf('nm:font')).toBeLessThan(order.indexOf('nm:track'));
		expect(sent.find(message => message.type === 'nm:track')?.content).toBe(ASS);

		player.dispose();
	});

	it('hands the worker font bytes, not a url and not a string', async () => {
		const bytes = new Uint8Array([1, 2, 3, 4, 5]).buffer;
		vi.stubGlobal('fetch', vi.fn(async () => ({
			ok: true,
			status: 200,
			arrayBuffer: async () => bytes,
		})));

		const player = new NMSubtitleOctopus({
			video: makeVideoElement(),
			trackContent: ASS,
			availableFonts: { 'negotiate free': 'https://media.test/negotiate.ttf' },
		});
		await settle();

		const font = sent.find(message => message.type === 'nm:font');
		expect(font?.name).toBe('negotiate free');
		expect(font?.bytes).toBeInstanceOf(ArrayBuffer);
		expect((font?.bytes as ArrayBuffer).byteLength).toBe(5);

		player.dispose();
	});

	it('attaches nothing when a face will not load, and still loads the track', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => ({
			ok: false,
			status: 404,
			arrayBuffer: async () => new ArrayBuffer(0),
		})));

		const player = new NMSubtitleOctopus({
			video: makeVideoElement(),
			trackContent: ASS,
			availableFonts: { 'negotiate free': 'https://media.test/missing.ttf' },
		});
		await settle();

		expect(sent.find(message => message.type === 'nm:font')).toBeUndefined();
		expect(sent.find(message => message.type === 'nm:track')).toBeDefined();

		player.dispose();
	});

	it('reports the renderer ready only once the worker says it is', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => ({
			ok: true,
			status: 200,
			arrayBuffer: async () => new ArrayBuffer(4),
		})));

		const ready = vi.fn();
		const player = new NMSubtitleOctopus({ video: makeVideoElement(), trackContent: ASS });
		player.on('rendererReady', ready);
		await settle();

		expect(ready).not.toHaveBeenCalled();
		lastWorker?.announceReady();
		expect(ready).toHaveBeenCalledTimes(1);

		player.dispose();
	});
});
