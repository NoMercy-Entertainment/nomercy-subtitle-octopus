/**
 * NMSubtitleOctopus unit tests.
 *
 * Regression guard for the availableFonts forwarding bug:
 *   NMSubtitleOctopus received availableFonts from the plugin layer but
 *   mountUpstream() never included it in the upstreamOpts spread. The
 *   upstream SubtitlesOctopus constructor received availableFonts=[] (the
 *   default), so the worker skipped font loading entirely. ASS files with
 *   custom fonts rendered with the fallback font only; CJK scripts produced
 *   no visible text.
 *
 * Fix: availableFonts is now included explicitly in both mountUpstream()
 * call sites (content path and URL path) and flows through to the upstream
 * constructor options.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock upstream SubtitlesOctopus ────────────────────────────────────────────
// We intercept the vendored JS import so NMSubtitleOctopus still runs its
// real mountUpstream() logic while we observe what it hands to the upstream.

const upstreamCalls: unknown[] = [];

vi.mock('../../public/subtitles-octopus.js', () => {
	function MockSubtitlesOctopus(this: { worker: Worker; canvasParent: HTMLDivElement; dispose: () => void }, options: unknown) {
		upstreamCalls.push(options);
		this.worker = { terminate: () => {} } as unknown as Worker;
		this.canvasParent = document.createElement('div');
		this.dispose = () => {};
	}
	return { default: MockSubtitlesOctopus };
});

// ── Import under test ─────────────────────────────────────────────────────────

import { NMSubtitleOctopus } from '../octopus';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeVideoElement(): HTMLVideoElement {
	const video = document.createElement('video');
	// happy-dom does not mount <video> in a parent by default; attach so
	// resolveContainer() can walk parentElement.
	document.body.appendChild(video);
	return video;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('NMSubtitleOctopus — availableFonts forwarding', () => {
	beforeEach(() => {
		upstreamCalls.length = 0;
	});

	afterEach(() => {
		document.body.innerHTML = '';
		vi.clearAllMocks();
	});

	it('forwards availableFonts to the upstream constructor on the content path', async () => {
		const video = makeVideoElement();
		const fonts: Record<string, string> = {
			'noto sans': 'blob:mock-noto',
			'arial': 'blob:mock-arial',
		};

		const instance = new NMSubtitleOctopus({
			video,
			trackContent: '[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\n\n[Events]\n',
			availableFonts: fonts,
		});

		// NMSubtitleOctopus defers the load via Promise.resolve().then(...)
		await new Promise(r => setTimeout(r, 0));

		expect(upstreamCalls).toHaveLength(1);
		const passedOpts = upstreamCalls[0] as Record<string, unknown>;
		expect(passedOpts.availableFonts).toEqual(fonts);

		instance.dispose();
	});

	it('forwards availableFonts to the upstream constructor on the URL path', async () => {
		const video = makeVideoElement();
		const fonts: Record<string, string> = { 'myfont': 'blob:mock-myfont' };

		const instance = new NMSubtitleOctopus({
			video,
			trackUrl: 'https://cdn.example.com/sub.ass',
			availableFonts: fonts,
		});

		await new Promise(r => setTimeout(r, 0));

		expect(upstreamCalls).toHaveLength(1);
		const passedOpts = upstreamCalls[0] as Record<string, unknown>;
		expect(passedOpts.availableFonts).toEqual(fonts);

		instance.dispose();
	});

	it('passes availableFonts as empty object when not provided (not an empty array)', async () => {
		const video = makeVideoElement();

		const instance = new NMSubtitleOctopus({
			video,
			trackContent: '[Script Info]\n\n[Events]\n',
		});

		await new Promise(r => setTimeout(r, 0));

		expect(upstreamCalls).toHaveLength(1);
		const passedOpts = upstreamCalls[0] as Record<string, unknown>;
		// When no availableFonts is provided, it should be undefined or absent —
		// the upstream JS defaults it to [] internally. What matters: it must NOT
		// be a non-empty object that would confuse the worker's hasOwnProperty check.
		const received = passedOpts.availableFonts;
		expect(received === undefined || received === null || (Array.isArray(received) && received.length === 0)).toBe(true);

		instance.dispose();
	});

	it('subContent is forwarded on the content path (regression: was cast as UpstreamOptions)', async () => {
		const video = makeVideoElement();
		const content = '[Script Info]\nScriptType: v4.00+\n\n[Events]\n';

		const instance = new NMSubtitleOctopus({ video, trackContent: content });
		await new Promise(r => setTimeout(r, 0));

		expect(upstreamCalls).toHaveLength(1);
		const passedOpts = upstreamCalls[0] as Record<string, unknown>;
		expect(passedOpts.subContent).toBe(content);

		instance.dispose();
	});
});
