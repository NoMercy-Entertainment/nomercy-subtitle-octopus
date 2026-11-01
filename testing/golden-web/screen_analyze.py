#!/usr/bin/env python3
# Copyright (c) NoMercy Entertainment
# Licensed under the Apache License, Version 2.0. See LICENSE for details.
# SPDX-License-Identifier: Apache-2.0
"""Read the composited frames of a run.mjs --screen 1 run (clip with the frame number burned in as
binary squares), keep the first screen frame that shows each video frame, and run analyze.py on
those crops. Prints how long each video frame showed the wrong caption.

Usage: screen_analyze.py CAPTURE_DIR FIXTURE_DIR
"""
import json
import os
import subprocess
import sys

import numpy as np
from PIL import Image

cap_dir, fixture_dir = sys.argv[1], sys.argv[2]
here = os.path.dirname(os.path.abspath(__file__))
ref = json.load(open(os.path.join(fixture_dir, 'manifest.json')))['frames']
first, last = ref[0]['index'], ref[-1]['index']
shots = json.load(open(os.path.join(cap_dir, 'screen.json')))
FRAME_S = 1001 / 24000
out = os.path.join(cap_dir, 'screen-cap')
os.makedirs(out, exist_ok=True)


def video_index(a):
    bits = [int(a[8, 8 + 16 * i, :3].mean() > 128) for i in range(12)]
    return sum(b << i for i, b in enumerate(bits))


NOISE = 8  # video compression leaves a faint floor on the black picture


def caption_crop(a):
    body = a[16:, :, :3].copy()
    body[body.max(axis=2) <= NOISE] = 0
    ys, xs = np.nonzero(body.max(axis=2))
    if len(xs) == 0:
        return None
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    return [int(x0), int(y0 + 16), int(x1 - x0 + 1), int(y1 - y0 + 1)], body[y0:y1 + 1, x0:x1 + 1]


seen = {}
rows = []
for s in shots:
    a = np.array(Image.open(os.path.join(cap_dir, 'screen', s['file'])).convert('RGB'))
    if a.shape[:2] != (720, 1280):
        raise SystemExit('screen frame %s is %s, not 720x1280' % (s['file'], a.shape))
    n = video_index(a)
    rows.append((s['ts'], n, caption_crop(a)))
    if first - 2 <= n <= last + 1 and n not in seen:
        seen[n] = (s['ts'], caption_crop(a))

# How many screen frames showed video frame n with a caption other than the one on its first frame.
stale = {}
firsts = {n: v[1][1].tobytes() if v[1] else None for n, v in seen.items()}
for ts, n, c in rows:
    if n in firsts and n in seen and ts != seen[n][0]:
        now = c[1].tobytes() if c else None
        if now != firsts[n]:
            stale[n] = stale.get(n, 0) + 1

frames = []
for k, n in enumerate(sorted(seen)):
    ts, c = seen[n]
    crop = None
    if c:
        crop = c[0]
        open(os.path.join(out, 'f%04d.rgb' % k), 'wb').write(c[1].astype(np.uint8).tobytes())
    frames.append({'scenario': 'play', 'now': ts * 1000, 'mt': n * FRAME_S, 'edt': None, 'cbAt': None, 'sends': 0, 'crop': crop})
json.dump({'frames': frames, 'sent': []}, open(os.path.join(out, 'meta.json'), 'w'))
inwin = [n for n in seen if first <= n <= last]
print('screen frames=%d video frames seen=%d of %d in window; screen frames showing a changed caption after the first=%s' % (len(shots), len(inwin), last - first + 1, {n: stale[n] for n in sorted(stale) if first <= n <= last}))
subprocess.run([sys.executable, os.path.join(here, 'analyze.py'), out, fixture_dir])
