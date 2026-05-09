import type { OctopusEvents, WorkerOutboundMessage } from './types';

/**
 * Patch 2 — Cross-origin worker instantiation via Blob URL.
 *
 * v1 behaviour: when the workerUrl origin differed from location.origin the
 * browser refused to construct the Worker (same-origin policy on worker
 * scripts). The fix was to wrap the URL in a Blob that `importScripts`'d it,
 * setting `Module.locateFile` to point sibling WASM/font assets back to the
 * worker directory. The blob URL was revoked immediately after the Worker was
 * constructed.
 */

/** Derive the directory component of a URL string (trailing slash included). */
function workerDir(workerUrl: string): string {
	try {
		const u = new URL(workerUrl, document.baseURI);
		return u.href.slice(0, u.href.lastIndexOf('/') + 1);
	}
	catch {
		const slash = workerUrl.lastIndexOf('/');
		return slash >= 0 ? workerUrl.slice(0, slash + 1) : './';
	}
}

/** True when `workerUrl` is cross-origin relative to the current page. */
function isCrossOrigin(workerUrl: string): boolean {
	try {
		const u = new URL(workerUrl, document.baseURI);
		return u.origin !== location.origin;
	}
	catch {
		return false;
	}
}

/**
 * Construct a Worker from `workerUrl`, wrapping it in a Blob when cross-origin.
 * The blob URL is revoked synchronously after the Worker is started.
 */
export function createWorker(workerUrl: string): Worker {
	if (!isCrossOrigin(workerUrl)) {
		return new Worker(workerUrl, { type: 'classic' });
	}

	const dir = workerDir(workerUrl);
	const blob = new Blob(
		[`var Module={locateFile:function(f){return ${JSON.stringify(dir)}+f;}};importScripts(${JSON.stringify(workerUrl)});`],
		{ type: 'application/javascript' },
	);
	const blobUrl = URL.createObjectURL(blob);
	try {
		return new Worker(blobUrl, { type: 'classic' });
	}
	finally {
		URL.revokeObjectURL(blobUrl);
	}
}

type EventListener<T> = (data: T) => void;
type EventMap = OctopusEvents;

/** Minimal typed event emitter — no external deps. */
export class EventEmitter {
	private readonly listeners = new Map<string, Set<EventListener<unknown>>>();

	on<K extends keyof EventMap>(name: K, fn: EventListener<EventMap[K]>): void {
		let set = this.listeners.get(name as string);
		if (!set) {
			set = new Set();
			this.listeners.set(name as string, set);
		}
		set.add(fn as EventListener<unknown>);
	}

	off<K extends keyof EventMap>(name: K, fn: EventListener<EventMap[K]>): void {
		this.listeners.get(name as string)?.delete(fn as EventListener<unknown>);
	}

	emit<K extends keyof EventMap>(name: K, data: EventMap[K]): void {
		this.listeners.get(name as string)?.forEach(fn => fn(data));
	}

	removeAll(): void {
		this.listeners.clear();
	}
}

/**
 * Thin bridge between the NMSubtitleOctopus main-thread class and the libass
 * worker. Translates outbound worker messages into typed EventEmitter emissions.
 */
export class WorkerBridge {
	readonly worker: Worker;
	private readonly emitter: EventEmitter;

	constructor(worker: Worker, emitter: EventEmitter) {
		this.worker = worker;
		this.emitter = emitter;
		this.worker.addEventListener('message', this.onMessage);
	}

	private readonly onMessage = (ev: MessageEvent): void => {
		const msg = ev.data as WorkerOutboundMessage;
		switch (msg.type) {
			case 'nm:ready':
				this.emitter.emit('ready', undefined as void);
				break;
			case 'nm:error':
				this.emitter.emit('error', new Error(msg.message));
				break;
			case 'nm:fonts-loaded':
				this.emitter.emit('fontsLoaded', { count: msg.count });
				break;
		}
	};

	dispose(): void {
		this.worker.removeEventListener('message', this.onMessage);
		try {
			this.worker.terminate();
		}
		catch {
			// ignore
		}
	}
}
