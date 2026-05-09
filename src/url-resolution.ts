/**
 * Patch 5 — basePath prepend + URI encoding.
 * v1 behaviour: all subtitle and font URLs were prefixed with `basePath` before
 * being handed to the worker, preventing 404s when the page is not served from /.
 */

/**
 * RFC-3986 scheme prefix — `scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )`
 * followed by `:`. Matches every custom scheme the consumer might inject:
 * `http`, `https`, `ws`, `wss`, `data`, `blob`, `file`, `mailto`, plus
 * NoMercy-specific schemes (`nmsync:`, `cast:`, etc.).
 */
const ABSOLUTE_URL_RE = /^[a-z][a-z0-9+\-.]*:/i;

/** Protocol-relative form (`//host/path`) — absolute against the page's protocol. */
const PROTOCOL_RELATIVE_RE = /^\/\//;

/** True when `url` carries its own scheme or is protocol-relative. */
export function isAbsoluteUrl(url: string): boolean {
	return ABSOLUTE_URL_RE.test(url) || PROTOCOL_RELATIVE_RE.test(url);
}

/**
 * Prepend `basePath` to `url` and URI-encode the result.
 *
 * Absolute URLs — anything carrying a scheme (`http:`, `https:`, `ws:`,
 * `data:`, `blob:`, `file:`, `mailto:`, `nmsync:`, etc.) — and
 * protocol-relative URLs (`//host/path`) bypass prepend. Relative and
 * root-relative paths get `basePath` prefixed. Encoding is applied uniformly
 * so a basePath with already-encoded segments doesn't double-encode the
 * tail.
 */
export function resolveUrl(basePath: string | undefined, url: string): string {
	if (!url)
		return '';
	const raw = isAbsoluteUrl(url) ? url : (basePath ?? '') + url;
	return encodeURI(raw);
}
