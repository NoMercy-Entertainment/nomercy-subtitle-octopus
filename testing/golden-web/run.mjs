// Copyright (c) NoMercy Entertainment
// Licensed under the Apache License, Version 2.0. See LICENSE for details.
// SPDX-License-Identifier: Apache-2.0
//
// Web harness for the golden ASS fixtures: headless Chrome plays a generated H.264
// clip, the kit under test draws the fixture, every presented frame's overlay is
// captured, and analyze.py compares it with the ffmpeg reference stills.
//
// node run.mjs --kit <kit dist dir> --golden <golden-ass worktree> --fixture <name> --clip <mp4> --out <dir> [--chrome <exe>]
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), []));
for (const k of ['kit', 'golden', 'fixture', 'clip', 'out'])
	if (!args[k]) throw new Error(`missing --${k}`);
const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(args.golden, 'testdata', 'golden-ass', args.fixture);
const fontsDir = path.join(args.golden, 'testdata', 'golden-ass', 'fonts');
const manifest = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'manifest.json'), 'utf8'));
const FRAME = 1001 / 24000;
const first = manifest.frames[0].index;
const last = manifest.frames.at(-1).index;
const ws = first * FRAME;
const we = last * FRAME;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mp4': 'video/mp4', '.ass': 'text/plain', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.data': 'application/octet-stream' };

function serveFile(req, res, file) {
	if (!fs.existsSync(file)) { res.statusCode = 404; res.end(); return; }
	const size = fs.statSync(file).size;
	const type = types[path.extname(file)] ?? 'application/octet-stream';
	const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
	if (range) {
		const start = range[1] ? Number(range[1]) : 0;
		const end = range[2] ? Number(range[2]) : size - 1;
		res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
		fs.createReadStream(file, { start, end }).pipe(res);
		return;
	}
	res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size });
	fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
	const url = new URL(req.url, 'http://x').pathname;
	if (url === '/page.html') serveFile(req, res, path.join(here, 'page.html'));
	else if (url === '/clip.mp4') serveFile(req, res, args.clip);
	else if (url === '/fixture.ass') serveFile(req, res, path.join(fixtureDir, 'fixture.ass'));
	else if (url.startsWith('/kit/')) serveFile(req, res, path.join(args.kit, path.basename(url)));
	else if (url.startsWith('/fonts/')) serveFile(req, res, path.join(fontsDir, path.basename(url)));
	else { res.statusCode = 404; res.end(); }
});
await new Promise(r => server.listen(9470, '127.0.0.1', r));

const profile = path.join(args.out, 'profile');
fs.mkdirSync(args.out, { recursive: true });
const chrome = spawn(args.chrome ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
	'--headless=new', '--remote-debugging-port=9371', `--user-data-dir=${profile}`, '--mute-audio',
	'--autoplay-policy=no-user-gesture-required', '--window-size=1280,720', '--no-first-run', 'about:blank',
], { stdio: 'ignore' });
let tab;
for (let i = 0; i < 40 && !tab; i++) {
	await new Promise(r => setTimeout(r, 500));
	try { tab = await (await fetch('http://127.0.0.1:9371/json/new?about:blank', { method: 'PUT' })).json(); } catch { /* chrome still starting */ }
}
if (!tab) throw new Error('chrome did not start');
const ws2 = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise(r => ws2.addEventListener('open', r));
let id = 0;
const pending = new Map();
ws2.addEventListener('message', (ev) => {
	const m = JSON.parse(ev.data);
	if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
});
const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws2.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => {
	const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
	if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
	return r.result.value;
};

try {
	await send('Page.enable');
	await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__nmTimes = [];
		const orig = Worker.prototype.postMessage;
		Worker.prototype.postMessage = function (m, t) { if (m && m.type === 'nm:time') window.__nmTimes.push([performance.now(), m.timeMs]); return orig.call(this, m, t); };` });
	await send('Page.navigate', { url: 'http://127.0.0.1:9470/page.html' });
	for (let i = 0; i < 60 && (await evaluate('window.goldenReady === true')) !== true; i++) await new Promise(r => setTimeout(r, 500));
	const fonts = fs.readdirSync(fontsDir).map(f => `/fonts/${f}`);
	console.log('start', await evaluate(`window.golden.start(${JSON.stringify(fonts)})`));
	await evaluate(`window.golden.play(${ws}, ${we})`);
	const mid = manifest.frames.filter((_, i) => [4, 10, 16].includes(i)).map(f => (f.index + 0.5) * FRAME);
	await evaluate(`window.golden.seek(${JSON.stringify(mid)})`);
	await evaluate(`window.golden.pauseResume(${ws}, ${we})`);
	const meta = JSON.parse(await evaluate('window.golden.meta()'));
	fs.writeFileSync(path.join(args.out, 'meta.json'), JSON.stringify(meta));
	for (let i = 0; i < meta.frames.length; i += 20) {
		JSON.parse(await evaluate(`window.golden.chunk(${i}, 20)`)).forEach((b64, j) => {
			if (b64) fs.writeFileSync(path.join(args.out, `f${String(i + j).padStart(4, '0')}.rgb`), Buffer.from(b64, 'base64'));
		});
	}
	console.log('captured', meta.frames.length);
}
finally {
	try { await send('Browser.close'); } catch { /* already closed */ }
	chrome.kill();
	server.close();
}
const r = spawnSync('python', [path.join(here, 'analyze.py'), args.out, fixtureDir], { stdio: 'inherit' });
process.exit(r.status ?? 1);
