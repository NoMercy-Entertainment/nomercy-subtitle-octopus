export interface SubtitlesOctopusOptions {
	video: HTMLVideoElement;
	/** URL of the subtitle file. Required unless `subContent` is provided. */
	subUrl: string;
	/**
	 * Inline ASS/SSA subtitle content. Alternative to `subUrl` — the upstream
	 * JS reads this and skips the URL-based XHR fetch entirely. Preferred when
	 * the plugin layer pre-fetches content via the kit auth pipeline.
	 */
	subContent?: string;
	/** Font file URLs fetched by the worker. Prefer `availableFonts` for auth-gated fonts. */
	fonts?: string[];
	/**
	 * Named font map — key is font name (lower-case), value is a URL (or blob URL).
	 * The worker loads these on demand when the ASS script references a font name
	 * that matches an entry. Preferred over `fonts[]` for the auth-pre-fetch path:
	 * the plugin layer fetches each binary and creates a blob URL so the worker
	 * never performs authenticated XHRs.
	 */
	availableFonts?: Record<string, string>;
	lossyRender?: boolean;
	targetFps?: number;
	debug?: boolean;
	blendRender?: boolean;
	lazyFileLoading?: boolean;
	renderAhead?: number;
	workerUrl?: string;
	legacyWorkerUrl?: string;
	fallbackFont?: string;
	onReady?: () => void;
	onError?: (event: unknown) => void;
}

declare class SubtitlesOctopus {
	worker: Worker;
	canvasParent: HTMLDivElement;

	constructor(options: SubtitlesOctopusOptions);
	dispose(): void;
}

export default SubtitlesOctopus;
