/**
 * The bundled default face must carry a glyph for Arabic, Hebrew and Thai.
 *
 * Without one, libass draws the missing glyph, an empty box, for every letter
 * of a cue in those scripts. The test reads the font's own cmap table.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// vitest runs from the package root; happy-dom makes import.meta.url non-file.
const font = readFileSync(resolve(process.cwd(), 'public/default.ttf'));

function tableOffset(tag: string): number {
	const count = font.readUInt16BE(4);
	for (let i = 0; i < count; i++) {
		const record = 12 + i * 16;
		if (font.toString('latin1', record, record + 4) === tag)
			return font.readUInt32BE(record + 8);
	}
	throw new Error(`font has no ${tag} table`);
}

/** True when any Unicode cmap subtable (format 4 or 12) maps the code point. */
function mapsCodePoint(codePoint: number): boolean {
	const cmap = tableOffset('cmap');
	const subtables = font.readUInt16BE(cmap + 2);
	for (let i = 0; i < subtables; i++) {
		const offset = cmap + font.readUInt32BE(cmap + 4 + i * 8 + 4);
		const format = font.readUInt16BE(offset);
		if (format === 4 && codePoint <= 0xFFFF) {
			const segX2 = font.readUInt16BE(offset + 6);
			const ends = offset + 14;
			const starts = ends + segX2 + 2;
			const deltas = starts + segX2;
			const ranges = deltas + segX2;
			for (let s = 0; s < segX2; s += 2) {
				if (codePoint > font.readUInt16BE(ends + s) || codePoint < font.readUInt16BE(starts + s))
					continue;
				const rangeOffset = font.readUInt16BE(ranges + s);
				if (rangeOffset === 0)
					return ((codePoint + font.readInt16BE(deltas + s)) & 0xFFFF) !== 0;
				const glyph = font.readUInt16BE(ranges + s + rangeOffset + (codePoint - font.readUInt16BE(starts + s)) * 2);
				if (glyph !== 0)
					return true;
			}
		}
		else if (format === 12) {
			const groups = font.readUInt32BE(offset + 12);
			for (let g = 0; g < groups; g++) {
				const group = offset + 16 + g * 12;
				if (codePoint >= font.readUInt32BE(group) && codePoint <= font.readUInt32BE(group + 4))
					return true;
			}
		}
	}
	return false;
}

describe('public/default.ttf script coverage', () => {
	it.each([
		['Arabic alef', 0x0627],
		['Hebrew alef', 0x05D0],
		['Thai ko kai', 0x0E01],
	])('maps %s', (_name, codePoint) => {
		expect(mapsCodePoint(codePoint)).toBe(true);
	});

	it('maps Latin A, so the parser is not answering true for everything', () => {
		expect(mapsCodePoint(0x41)).toBe(true);
		expect(mapsCodePoint(0x10FFFF)).toBe(false);
	});
});
