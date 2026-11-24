"""Read the distributed PLATEAU core and neighbouring regional roof surfaces."""

from collections import defaultdict
from itertools import product
import json
import math

import numpy as np


def overlaps(a, b):
    return a[0] <= b[2] and a[2] >= b[0] and a[1] <= b[3] and a[3] >= b[1]


def read_roofs(root, bounds):
    city = json.loads((root / "public/city/manifest.json").read_text(encoding="utf8"))
    regional = json.loads((root / "public/region/buildings.json").read_text(encoding="utf8"))
    # Keep complete footprints just beyond the cut line while collecting source
    # triangles. Only the finished decoration is clipped to the exact square.
    margin = 220
    search = [bounds[0] - margin, bounds[1] - margin, bounds[2] + margin, bounds[3] + margin]
    roof_data = []
    bases = {}
    references = {}
    for entry in city["parts"] + regional["tiles"]:
        core = "texture" in entry
        if not core and not overlaps(entry["bounds"], search):
            continue
        directory = "city" if core else "region"
        source = directory + "/" + entry["file"]
        data = (root / "public" / source).read_bytes()
        n = entry["vertices"]
        if core:
            pos = np.frombuffer(data, "<f4", n * 3).reshape(-1, 3).astype(float)
            idx_offset = n * 32
        else:
            pos = np.frombuffer(data, "<i2", n * 3).reshape(-1, 3) * entry["scale"] + np.array(
                entry["origin"]
            )
            idx_offset = entry["indexOffset"]
        ids = np.frombuffer(data, "<u4", entry["indices"], idx_offset).reshape(-1, 3)
        pts = pos[ids]
        horizontal = pts[:, :, [0, 2]]
        low, high = horizontal.min(axis=1), horizontal.max(axis=1)
        inside = (
            (low[:, 0] >= bounds[0])
            & (low[:, 1] >= bounds[1])
            & (high[:, 0] <= bounds[2])
            & (high[:, 1] <= bounds[3])
            & (pts[:, :, 1].min(axis=1) > 1)
        )
        if np.any(inside):
            references[source] = pts[inside]
        if core and entry["texture"] == "Texture-001.png":
            continue
        mask = (
            (high[:, 0] >= search[0])
            & (high[:, 1] >= search[1])
            & (low[:, 0] <= search[2])
            & (low[:, 1] <= search[3])
        )
        pts = pts[mask]
        if not len(pts):
            continue
        normals = np.cross(pts[:, 1] - pts[:, 0], pts[:, 2] - pts[:, 0])
        lengths = np.linalg.norm(normals, axis=1)
        # Export includes a flat y=0 reference surface. Only measured,
        # upward-facing parts of closed buildings with real walls qualify.
        roofs = pts[(normals[:, 1] > lengths * 0.49) & (lengths > 1e-4) & (pts[:, :, 1].min(axis=1) > 1)]
        if not len(roofs):
            continue
        roof_data.extend((face, source) for face in roofs)
        for x, y, z in pts.reshape(-1, 3):
            key = (round(x * 5), round(z * 5))
            bases[key] = min(y, bases.get(key, math.inf))

    # Weld coincident roof edges. Regional chunks quantize their individual
    # coordinates to +/- 1 cm, hence a neighbourhood search at chunk seams.
    cells, positions, faces, source_ids = defaultdict(list), [], [], []

    def weld(p):
        slot = tuple(int(math.floor(a / 0.06)) for a in p)
        for i in cells[slot]:
            if max(abs(p[j] - positions[i][j]) for j in range(3)) < 0.035:
                return i
        for delta in product((-1, 0, 1), repeat=3):
            if delta == (0, 0, 0):
                continue
            for i in cells.get(tuple(a + b for a, b in zip(slot, delta)), ()):
                if max(abs(p[j] - positions[i][j]) for j in range(3)) < 0.035:
                    return i
        i = len(positions)
        positions.append(tuple(p))
        cells[slot].append(i)
        return i

    for tri, src in roof_data:
        f = tuple(weld(p) for p in tri)
        if len(set(f)) == 3:
            faces.append(f)
            source_ids.append(src)
    parents = list(range(len(faces)))

    def find(n):
        while parents[n] != n:
            parents[n] = parents[parents[n]]
            n = parents[n]
        return n

    edge_owner = {}
    for i, tri in enumerate(faces):
        for a, b in zip(tri, (tri[1], tri[2], tri[0])):
            key = tuple(sorted((a, b)))
            old = edge_owner.setdefault(key, i)
            parents[find(old)] = find(i)
    groups = defaultdict(list)
    for i in range(len(faces)):
        groups[find(i)].append(i)
    result = []
    for group in groups.values():
        face_ids = np.array([faces[i] for i in group])
        keys, indices = np.unique(face_ids, return_inverse=True)
        pts = np.array([positions[i] for i in keys])
        tris = indices.reshape(-1, 3)
        lo, hi = pts.min(axis=0), pts.max(axis=0)
        bb = [lo[0], lo[2], hi[0], hi[2]]
        if not overlaps(bb, bounds):
            continue
        edges = {}
        for a, b, c in tris:
            for edge in ((a, b), (b, c), (c, a)):
                key = tuple(sorted(edge))
                edges[key] = None if key in edges else edge
        free = [v for v in edges.values() if v is not None]
        if not free:
            continue
        ground = min(bases.get((round(x * 5), round(z * 5)), y) for x, y, z in pts)
        if hi[1] - ground < 0.28:
            continue
        result.append((pts, tris, free, ground, sorted({source_ids[i] for i in group})))
    return result, references
