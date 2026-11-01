export interface Summary { count: number; p50: number; p95: number; max: number }

export interface ProbeReport {
	/** Per-frame libass render time in the worker, in milliseconds. */
	renderMs: Summary;
	/** `mediaTime - video.currentTime` per presented frame, in milliseconds. */
	skewMs: Summary;
	/** `nm:time` requests the worker dropped because a newer one was waiting. */
	dropped: number;
	/** Renders that composited and uploaded something. */
	drawn: number;
}

export function summarize(_values: readonly number[]): Summary {
	return { count: 0, p50: 0, p95: 0, max: 0 };
}

export function formatProbeReport(_report: ProbeReport): string {
	return '';
}
