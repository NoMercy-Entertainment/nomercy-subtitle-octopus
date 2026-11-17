// Port of the KMP caption render budget (subtitles-libass MemoryTier.kt and RenderScale.kt).

export interface RenderBudget {
	maxWidth: number;
	maxHeight: number;
}

// MemoryTier.kt:31-53 (maxRenderWidth/maxRenderHeight of LOW, MEDIUM, HIGH).
export const RENDER_BUDGETS = {
	low: { maxWidth: 1280, maxHeight: 720 },
	medium: { maxWidth: 1920, maxHeight: 1080 },
	high: { maxWidth: 1920, maxHeight: 1080 },
} as const satisfies Record<string, RenderBudget>;

export type RenderTier = keyof typeof RENDER_BUDGETS;

// MemoryTier.kt:86-88 picks by heap (256 and 384 MB). A browser has no heap size,
// so device memory (GB) and core count stand in; the lower of the two wins.
const LOW_DEVICE_MEMORY_GB = 2;
const MEDIUM_DEVICE_MEMORY_GB = 4;
const LOW_CORES = 2;
const MEDIUM_CORES = 4;

const ORDER: readonly RenderTier[] = ['low', 'medium', 'high'];

function tierByCeilings(value: number | undefined, lowCeiling: number, mediumCeiling: number): RenderTier {
	if (value === undefined || !(value > 0))
		return 'high';
	if (value <= lowCeiling)
		return 'low';
	return value <= mediumCeiling ? 'medium' : 'high';
}

/** The tier of this device. A value the browser does not report counts as no limit. */
export function renderTierFor(deviceMemory: number | undefined, hardwareConcurrency: number | undefined): RenderTier {
	const byMemory = tierByCeilings(deviceMemory, LOW_DEVICE_MEMORY_GB, MEDIUM_DEVICE_MEMORY_GB);
	const byCores = tierByCeilings(hardwareConcurrency, LOW_CORES, MEDIUM_CORES);
	return ORDER[Math.min(ORDER.indexOf(byMemory), ORDER.indexOf(byCores))];
}

/** RenderScale.kt:26-33: one factor for both axes, never above one, 1 for an unmeasured surface. */
export function renderScaleFor(width: number, height: number, tier: RenderTier): number {
	if (!(width > 0) || !(height > 0))
		return 1;
	const budget = RENDER_BUDGETS[tier];
	return Math.min(1, budget.maxWidth / width, budget.maxHeight / height);
}

export interface Size {
	width: number;
	height: number;
}

/**
 * The libass frame size: the part of the box the video fills, in device pixels,
 * scaled down to the tier's budget. The video's own aspect is kept.
 */
export function renderSizeFor(video: Size, box: Size, pixelRatio: number, tier: RenderTier): Size {
	const own: Size = { width: Math.max(1, Math.round(video.width)), height: Math.max(1, Math.round(video.height)) };
	if (!(box.width > 0) || !(box.height > 0) || !(pixelRatio > 0))
		return own;

	const fit = Math.min(box.width / own.width, box.height / own.height);
	const surfaceWidth = own.width * fit * pixelRatio;
	const surfaceHeight = own.height * fit * pixelRatio;
	const scale = renderScaleFor(surfaceWidth, surfaceHeight, tier);
	return {
		width: Math.max(1, Math.round(surfaceWidth * scale)),
		height: Math.max(1, Math.round(surfaceHeight * scale)),
	};
}
