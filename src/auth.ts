import type { OctopusOptions } from './types';

/**
 * Patch 1 — Auth pre-fetch on the main thread.
 *
 * v1 behaviour: the upstream worker XHR'd subtitle and font URLs directly. Five
 * call sites inside the worker source were patched to inject an Authorization
 * header. That required maintaining a fork of the worker binary.
 *
 * NoMercy approach: we keep the vendor worker unmodified. Instead, the main
 * thread fetches auth-gated resources with the bearer token and converts them
 * to object URLs or inline strings before handing anything to the worker.
 * The worker only ever sees same-origin blob: URLs or plain strings — no auth
 * header needed inside the WASM sandbox.
 *
 * Trade-off: slightly higher main-thread memory at load time (one extra Blob
 * per subtitle/font). Acceptable — subtitle files are typically < 1 MB.
 */

/** Resolve the access token from the option (string or factory). */
export function resolveToken(accessToken: OctopusOptions['accessToken']): string | undefined {
	if (!accessToken)
		return undefined;
	if (typeof accessToken === 'string')
		return accessToken || undefined;
	try {
		return accessToken() || undefined;
	}
	catch {
		return undefined;
	}
}

/** Derive the auth origin: explicit option, or the current page's origin. */
export function resolveAuthOrigin(options: Pick<OctopusOptions, 'authOrigin'>): string {
	if (options.authOrigin)
		return options.authOrigin;
	try {
		return new URL(document.URL).origin;
	}
	catch {
		return '';
	}
}

/** True when the token should accompany a request to `url`. */
function shouldAddAuth(url: string, authOrigin: string): boolean {
	if (!authOrigin)
		return false;
	// Same-origin and relative paths always get the header.
	if (!url.startsWith('http'))
		return true;
	return url.startsWith(authOrigin);
}

/**
 * Fetch `url` with a bearer token when the same-origin guard passes.
 * Returns a Blob URL — caller is responsible for revoking it after use.
 */
export async function fetchWithAuth(
	url: string,
	token: string | undefined,
	authOrigin: string,
): Promise<string> {
	const headers: HeadersInit = {};
	if (token && shouldAddAuth(url, authOrigin)) {
		headers.Authorization = `Bearer ${token}`;
	}

	const response = await fetch(url, { headers });
	if (!response.ok) {
		throw new Error(`Auth fetch failed for ${url}: ${response.status} ${response.statusText}`);
	}

	const blob = await response.blob();
	return URL.createObjectURL(blob);
}

/**
 * Pre-fetch a subtitle file and all font URLs using auth, returning blob URLs.
 * Blob URLs must be revoked by the caller once the worker no longer needs them.
 */
export async function prefetchWithAuth(
	subtitleUrl: string,
	fontUrls: string[],
	options: Pick<OctopusOptions, 'accessToken' | 'authOrigin'>,
): Promise<{ subtitleBlobUrl: string; fontBlobUrls: string[] }> {
	const token = resolveToken(options.accessToken);
	const authOrigin = resolveAuthOrigin(options);

	const [subtitleBlobUrl, ...fontBlobUrls] = await Promise.all([
		fetchWithAuth(subtitleUrl, token, authOrigin),
		...fontUrls.map(f => fetchWithAuth(f, token, authOrigin)),
	]);

	return { subtitleBlobUrl, fontBlobUrls };
}
