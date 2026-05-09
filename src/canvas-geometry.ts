/**
 * Patch 3 — ResizeObserver-driven canvas geometry sync.
 *
 * v1 behaviour: on every window resize the wrapper copied six CSS properties
 * from the player container onto the libass canvas parent so the subtitle
 * overlay stayed pixel-locked to the video even when the layout shifted.
 */

const SYNCED_PROPS: ReadonlyArray<keyof CSSStyleDeclaration & string> = [
	'width',
	'height',
	'position',
	'top',
	'left',
	'transform',
] as const;

export class CanvasGeometry {
	private readonly source: HTMLElement;
	private readonly target: HTMLElement;
	private observer: ResizeObserver | null = null;

	constructor(source: HTMLElement, target: HTMLElement) {
		this.source = source;
		this.target = target;
	}

	attach(): void {
		if (this.observer)
			return;
		this.sync();
		this.observer = new ResizeObserver(() => this.sync());
		this.observer.observe(this.source);
	}

	detach(): void {
		this.observer?.disconnect();
		this.observer = null;
	}

	private sync(): void {
		const src = getComputedStyle(this.source);
		for (const prop of SYNCED_PROPS) {
			(this.target.style as unknown as Record<string, string>)[prop] = src[prop] as string;
		}
	}
}
