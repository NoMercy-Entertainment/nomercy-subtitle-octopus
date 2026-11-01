#!/usr/bin/env python3
# Copyright (c) NoMercy Entertainment
# Licensed under the Apache License, Version 2.0. See LICENSE for details.
# SPDX-License-Identifier: Apache-2.0
"""Turn a run.mjs capture into crop PNGs plus a manifest per scenario, run the golden
compare script on each, and report stutter and the jitter of the lead.

Usage: analyze.py CAPTURE_DIR FIXTURE_DIR
"""
import json
import os
import subprocess
import sys

import numpy as np
from PIL import Image

cap_dir, fixture_dir = sys.argv[1], sys.argv[2]
compare = os.path.join(fixture_dir, '..', '..', '..', 'scripts', 'golden-ass', 'compare-overlay-frames.py')
meta = json.load(open(os.path.join(cap_dir, 'meta.json')))
ref = json.load(open(os.path.join(fixture_dir, 'manifest.json')))['frames']
ref_pts = [f['pts_ms'] for f in ref]
FRAME_MS = 1001 / 24


def ref_index(pts):
    j = min(range(len(ref_pts)), key=lambda q: abs(ref_pts[q] - pts))
    return j if abs(ref_pts[j] - pts) <= 21 else None


def read(directory, fr):
    return None if fr['file'] is None else (tuple(fr['crop']), open(os.path.join(directory, fr['file']), 'rb').read())


scenarios = {}
for i, f in enumerate(meta['frames']):
    pts = int(f['mt'] * 1000 + 0.5)
    out = scenarios.setdefault(f['scenario'], {'dir': os.path.join(cap_dir, 'cap-' + f['scenario']), 'frames': [], 'leads': []})
    os.makedirs(out['dir'], exist_ok=True)
    name = None
    if f['crop']:
        x, y, w, h = f['crop']
        a = np.frombuffer(open(os.path.join(cap_dir, 'f%04d.rgb' % i), 'rb').read(), np.uint8).reshape(h, w, 3)
        name = 'c%04d.png' % i
        Image.fromarray(a).save(os.path.join(out['dir'], name))
    out['frames'].append({'index': len(out['frames']), 'pts_ms': pts, 'cues': [], 'crop': f['crop'], 'file': name})
    send = next((t for t in meta['sent'] if f['now'] - 0.5 <= t[0] <= f['now'] + 30), None)
    if send:
        out['leads'].append(send[1] - f['mt'] * 1000)

CONFIG = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'compare-config.json')))
CANVAS = json.load(open(os.path.join(fixture_dir, 'manifest.json')))['canvas']
_full = {}


def full_frame(directory, fr):
    key = (directory, fr['file'])
    if key not in _full:
        a = np.zeros((CANVAS[1], CANVAS[0], 3), np.int16)
        if fr['file']:
            x, y, w, h = fr['crop']
            a[y:y + h, x:x + w] = np.array(Image.open(os.path.join(directory, fr['file'])).convert('RGB'))
        _full[key] = a
    return _full[key]


def check_tolerance(s):
    """Primary: the nearest reference frame is the exact one. Secondary: large pixel differences stay under the fixture's threshold."""
    cfg = CONFIG['fixtures'][os.path.basename(os.path.normpath(fixture_dir))]
    exact = total = 0
    worst = 0
    for f in s['frames']:
        j = ref_index(f['pts_ms'])
        if j is None:
            continue
        a = full_frame(s['dir'], f)
        near = {k: int((np.abs(a - full_frame(fixture_dir, ref[k])).max(axis=2) > 0).sum())
                for k in range(max(0, j - CONFIG['search']), min(len(ref), j + CONFIG['search'] + 1))}
        total += 1
        if min(near, key=lambda k: (near[k], abs(k - j))) == j:
            exact += 1
            worst = max(worst, int((np.abs(a - full_frame(fixture_dir, ref[j])).max(axis=2) > cfg['channelOver']).sum()))
    ok = exact == total and worst <= cfg['maxPixels']
    print('tolerance: exact-frame=%d/%d large-diff-px max=%d (over %d per channel, limit %d) %s' % (exact, total, worst, cfg['channelOver'], cfg['maxPixels'], 'PASS' if ok else 'FAIL'))


for name, s in scenarios.items():
    json.dump({'canvas': [1280, 720], 'frames': s['frames']}, open(os.path.join(s['dir'], 'manifest.json'), 'w'))
    print('== scenario %s: %d frames' % (name, len(s['frames'])))
    r = subprocess.run([sys.executable, compare, '--capture', s['dir'], '--ref', fixture_dir, '--all'], capture_output=True, text=True)
    lines = r.stdout.strip().splitlines()
    print('\n'.join(l for l in lines if l.startswith(('frames=', 'diff_px', 'offset_ms'))))
    rows = [l.split() for l in lines if l[:1] == ' ' or l[:1].isdigit()]
    print('signed offset_ms per frame (positive = overlay shows a later frame than the video):', [int(r[4]) for r in rows if len(r) >= 5])
    inside = [(f, ref_index(f['pts_ms'])) for f in s['frames']]
    inside = [(f, j) for f, j in inside if j is not None]
    if name == 'play':
        check_tolerance(s)
    if name == 'play' and inside:
        rep = moved = late = 0
        gaps = []
        last_change = None
        prev = None
        for f, j in inside:
            cur, ref_cur = read(s['dir'], f), read(fixture_dir, ref[j])
            if prev is not None:
                if ref_cur != prev[1]:
                    moved += 1
                    if cur == prev[0]:
                        rep += 1
            if prev is None or cur != prev[0]:
                if last_change is not None:
                    gaps.append(f['pts_ms'] - last_change)
                last_change = f['pts_ms']
            prev = (cur, ref_cur)
        late = sum(1 for g in gaps if g > FRAME_MS * 1.5)
        print('stutter: ref-moved=%d repeated-while-moved=%d visible-updates=%d max-gap=%d ms updates-later-than-one-frame=%d' % (moved, rep, len(gaps) + 1, max(gaps or [0]), late))
    if name == 'play' and inside:
        # Position of the moving content per frame: top-left of the non-black box, against the reference's.
        def pos(fr):
            return None if fr['crop'] is None else (fr['crop'][0], fr['crop'][1])
        cp = [pos(f) for f, _ in inside]
        rp = [pos(ref[j]) for _, j in inside]
        if all(cp) and all(rp):
            for axis, label in ((0, 'x'), (1, 'y')):
                cd = [cp[k + 1][axis] - cp[k][axis] for k in range(len(cp) - 1)]
                rd = [rp[k + 1][axis] - rp[k][axis] for k in range(len(rp) - 1)]
                rev = sum(1 for a, b in zip(cd, rd) if a * b < 0)
                print('position %s delta px per frame: capture %s' % (label, cd))
                print('position %s reference: %s | std capture=%.2f reference=%.2f reversals-vs-reference=%d' % (label, rd, np.std(cd), np.std(rd), rev))
        first_send = meta['frames'][[i for i, f in enumerate(meta['frames']) if f['scenario'] == 'play'][0]]['sends']
        last_send = meta['frames'][[i for i, f in enumerate(meta['frames']) if f['scenario'] == 'play'][-1]]['sends']
        ts = [t[1] for t in meta['sent'][first_send:last_send]]
        print('sent times in play: n=%d reversals=%d duplicates=%d' % (len(ts), sum(1 for a, b in zip(ts, ts[1:]) if b < a), sum(1 for a, b in zip(ts, ts[1:]) if b == a)))
    if s['leads']:
        L = np.array(s['leads'])
        print('lead_ms: n=%d mean=%.2f std=%.2f min=%.1f max=%.1f' % (len(L), L.mean(), L.std(), L.min(), L.max()))
        if len(L) > 8:
            print('lead_ms after 6 warm-up frames: std=%.2f min=%.1f max=%.1f' % (L[6:].std(), L[6:].min(), L[6:].max()))
