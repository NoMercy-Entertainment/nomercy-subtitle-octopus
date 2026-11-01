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

/** Nearest-rank percentiles, so a reported p95 is a value that was measured. */
export function summarize(values: readonly number[]): Summary {
	if (values.length === 0)
		return { count: 0, p50: 0, p95: 0, max: 0 };

	const sorted = [...values].sort((a, b) => a - b);
	const at = (fraction: number): number => sorted[Math.ceil(fraction * sorted.length) - 1];
	return { count: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

export function formatProbeReport(report: ProbeReport): string {
	const row = (label: string, s: Summary): string =>
		`${label.padEnd(10)} n=${s.count} p50=${s.p50.toFixed(2)} p95=${s.p95.toFixed(2)} max=${s.max.toFixed(2)}`;
	return [
		row('render ms', report.renderMs),
		row('skew ms', report.skewMs),
		`dropped ${report.dropped}, drawn ${report.drawn}`,
	].join('\n');
}
