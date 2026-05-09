/**
 * Patch 5 — basePath prepend + URI encoding.
 * v1 behaviour: all subtitle and font URLs were prefixed with `basePath` before
 * being handed to the worker, preventing 404s when the page is not served from /.
 */

/**
 * Prepend `basePath` to `url` and URI-encode the result.
 * Absolute URLs (http/https) bypass prepend but still get encoded.
 */
export function resolveUrl(basePath: string | undefined, url: string): string {
	if (!url)
		return '';
	const isAbsolute = /^https?:\/\//i.test(url);
	const raw = isAbsolute ? url : (basePath ?? '') + url;
	return encodeURI(raw);
}
