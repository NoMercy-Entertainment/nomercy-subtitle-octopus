// The caption render budget, ported from the KMP RenderScaleTest cases and MemoryTier tiers.

import { describe, expect, it } from 'vitest';
import { renderScaleFor, renderSizeFor, renderTierFor } from '../render-size';

describe('renderTierFor', () => {
	it('puts a 2 GB, 4-core box in the low tier', () => {
		expect(renderTierFor(2, 4)).toBe('low');
	});

	it('puts 4 GB in medium and more in high', () => {
		expect(renderTierFor(4, 8)).toBe('medium');
		expect(renderTierFor(8, 8)).toBe('high');
	});

	it('lets few cores lower the tier', () => {
		expect(renderTierFor(8, 2)).toBe('low');
		expect(renderTierFor(8, 4)).toBe('medium');
	});

	it('leaves a browser that reports nothing at the top tier', () => {
		expect(renderTierFor(undefined, undefined)).toBe('high');
	});

	// The living-room Nokia box (3.4 GB, 4 cores) reads as 4 GB and medium; KMP puts it in LOW by its 256 MB heap.
	it('puts a Cast or Android TV receiver in the low tier whatever it reports', () => {
		const castShell = 'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.159 Safari/537.36 CrKey/1.56.500000 DeviceType/AndroidTV';
		expect(renderTierFor(4, 4, castShell)).toBe('low');
		expect(renderTierFor(8, 8, 'Mozilla/5.0 (X11; Linux armv7l) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0 Safari/537.36 CrKey/1.56.500000')).toBe('low');
	});

	it('leaves a desktop browser to its memory and cores', () => {
		const desktop = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
		expect(renderTierFor(8, 8, desktop)).toBe('high');
	});
});

describe('renderScaleFor', () => {
	it('never goes above one', () => {
		expect(renderScaleFor(640, 360, 'low')).toBe(1);
	});

	it('leaves an unmeasured surface alone', () => {
		expect(renderScaleFor(0, 1080, 'low')).toBe(1);
		expect(renderScaleFor(1920, 0, 'low')).toBe(1);
	});

	it('uses the tighter axis', () => {
		expect(renderScaleFor(2560, 720, 'low')).toBe(0.5);
	});
});

describe('renderSizeFor', () => {
	const video = { width: 1920, height: 1080 };

	it('renders a 1920x1080 video in a 960x540 box at DPR 2 on a low tier at 1280x720', () => {
		expect(renderSizeFor(video, { width: 960, height: 540 }, 2, 'low')).toEqual({ width: 1280, height: 720 });
	});

	it('keeps the full surface on a tier that affords it', () => {
		expect(renderSizeFor(video, { width: 960, height: 540 }, 2, 'medium')).toEqual({ width: 1920, height: 1080 });
	});

	it('never renders above the surface the video lands on', () => {
		expect(renderSizeFor(video, { width: 640, height: 360 }, 1, 'high')).toEqual({ width: 640, height: 360 });
	});

	it('keeps the video aspect inside a box of another shape', () => {
		expect(renderSizeFor(video, { width: 960, height: 800 }, 2, 'high')).toEqual({ width: 1920, height: 1080 });
		expect(renderSizeFor(video, { width: 480, height: 800 }, 2, 'high')).toEqual({ width: 960, height: 540 });
	});

	it('keeps the aspect when the cap bites on a non-16:9 video', () => {
		const wide = { width: 2560, height: 1080 };
		const size = renderSizeFor(wide, { width: 1280, height: 540 }, 2, 'low');
		expect(size).toEqual({ width: 1280, height: 540 });
	});

	it('falls back to the video size when the box is not measured yet', () => {
		expect(renderSizeFor(video, { width: 0, height: 0 }, 2, 'low')).toEqual(video);
	});
});
