#!/usr/bin/env python3
"""Rasterise Natural Earth 110m land polygons (public domain) into a 720x360 (0.5 deg) 1-bit equirectangular mask.

usage: gen_land_mask.py ne_110m_land.geojson ../assets/land_mask.bin
Row 0 = lat +90 (north), column 0 = lon -180. Bits are packed MSB first, row-major.
"""
import json, sys

W, H = 720, 360
src, dst = sys.argv[1], sys.argv[2]
gj = json.load(open(src))
rings = []
for f in gj["features"]:
    g = f["geometry"]
    polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
    for p in polys:
        for r in p:  # even-odd fill handles holes
            rings.append(r)

edges = []  # (y0, y1, x0, slope) in mask pixel space
for r in rings:
    for (x0, y0), (x1, y1) in zip(r, r[1:]):
        px0, py0 = (x0 + 180) / 360 * W, (90 - y0) / 180 * H
        px1, py1 = (x1 + 180) / 360 * W, (90 - y1) / 180 * H
        if py0 == py1:
            continue
        if py0 > py1:
            px0, py0, px1, py1 = px1, py1, px0, py0
        edges.append((py0, py1, px0, (px1 - px0) / (py1 - py0)))

bits = bytearray(W * H // 8)
for row in range(H):
    yc = row + 0.5
    xs = sorted(x0 + s * (yc - y0) for (y0, y1, x0, s) in edges if y0 <= yc < y1)
    for a, b in zip(xs[0::2], xs[1::2]):
        c0, c1 = max(0, int(a + 0.5)), min(W, int(b + 0.5))
        for c in range(c0, c1):
            i = row * W + c
            bits[i >> 3] |= 0x80 >> (i & 7)
open(dst, "wb").write(bits)
land = sum(bin(b).count("1") for b in bits)
print(f"{len(rings)} rings, land fraction {land / (W * H):.3f}")
