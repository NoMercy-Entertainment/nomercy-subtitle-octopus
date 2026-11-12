/**
 * The worker this package ships is the nomercy-libass v0.17.5-2 wasm build
 * (FreeType 2.15.0, HarfBuzz 15.1.0). A copy from an older build would bring
 * back font parsers with known advisories, so the bytes are pinned here.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const RELEASE_SHA256: Record<string, string> = {
	'nomercy-libass-worker.js': 'e8355837a0e852dfe734311fad837b834945dc900f4ec8d6717e1b2e8e9ba52f',
	'nomercy-libass-worker.wasm': '4ab38f09c7e1721c37004ad76250bb56586a9a8f76fb6f1e8fae435ac0559547',
	'nomercy-libass-worker.data': '35cad63f43d3fc4b5b5a9148e2d761130da3b78b10549b9664812f8f185d8446',
};

describe('the bundled libass worker', () => {
	for (const [file, expected] of Object.entries(RELEASE_SHA256)) {
		it(`${file} is the nomercy-libass v0.17.5-2 release file`, () => {
			const bytes = readFileSync(resolve(process.cwd(), 'public', file));

			expect(createHash('sha256').update(bytes).digest('hex')).toBe(expected);
		});
	}
});
