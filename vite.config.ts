import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
	publicDir: resolve(__dirname, 'public'),
	plugins: [dts({ insertTypesEntry: true })],
	build: {
		sourcemap: false,
		minify: 'esbuild',
		target: 'es2022',
		lib: {
			entry: resolve(__dirname, 'src/index.ts'),
			name: 'NMSubtitleOctopus',
			formats: ['es'],
			fileName: 'nomercy-subtitle-octopus',
		},
		rollupOptions: {
			external: [],
		},
	},
});
