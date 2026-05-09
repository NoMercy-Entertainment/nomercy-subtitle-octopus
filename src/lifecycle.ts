/**
 * Patch 4 — Worker reuse prevention and instance lifecycle race guards.
 *
 * v1 behaviour: rapid subtitle switches left stale worker instances alive
 * and stale canvas elements in the DOM. The wrapper tracked the loaded URL
 * and aborted in-flight loads if the URL changed during async operations.
 * Orphan `.libassjs-canvas-parent` elements were swept before each new mount.
 */

const SUPPORTED_EXTENSIONS = new Set(['ass', 'ssa']);

/** Extract the lowercase file extension from a URL, ignoring query/fragment. */
function extension(url: string): string {
	try {
		const path = new URL(url, document.baseURI).pathname;
		const dot = path.lastIndexOf('.');
		return dot >= 0 ? path.slice(dot + 1).toLowerCase() : '';
	}
	catch {
		const dot = url.lastIndexOf('.');
		return dot >= 0 ? url.slice(dot + 1).split(/[?#]/)[0]!.toLowerCase() : '';
	}
}

/** True when the URL points to a supported subtitle format. */
export function isSupportedSubtitle(url: string): boolean {
	return SUPPORTED_EXTENSIONS.has(extension(url));
}

/**
 * Remove stale `.libassjs-canvas-parent` elements from `container`.
 * Prevents ghost overlays after hot-reload or rapid plugin re-init.
 */
export function sweepOrphanCanvases(container: HTMLElement): void {
	container
		.querySelectorAll<HTMLElement>('.libassjs-canvas-parent')
		.forEach(el => el.remove());
}

/**
 * Lightweight race token. Callers obtain a new token before each async
 * operation and check `.cancelled` after every await to abort stale work.
 */
export class RaceToken {
	cancelled = false;
}

/**
 * Thin lifecycle wrapper around a disposable resource.
 * Tracks cleanup callbacks added during setup and runs them in reverse on destroy.
 */
export class Lifecycle {
	private cleanups: Array<() => void> = [];

	addCleanup(fn: () => void): void {
		this.cleanups.push(fn);
	}

	destroy(): void {
		for (let i = this.cleanups.length - 1; i >= 0; i--) {
			try {
				this.cleanups[i]!();
			}
			catch {
				// ignore cleanup errors
			}
		}
		this.cleanups = [];
	}
}
