"""Generate the editable 2 km Okazaki district and the game's 64 GLBs using Blender 5.x.

blender -b --factory-startup --python-exit-code 1 -P scripts/build-okazaki-district.py -- --rebuild
blender -b --factory-startup --python-exit-code 1 -P scripts/build-okazaki-district.py -- --export-edited

A normal invocation exports existing edits. --rebuild explicitly replaces the
native file. --blend and --output can be used to write an independent copy.
"""

from collections import Counter, defaultdict
from pathlib import Path
import argparse
import hashlib
import json
import math
import sys
from tempfile import TemporaryDirectory

import bpy
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / "scripts/lib"))
from district_survey import read_roofs, overlaps
from district_gltf import pack_glb
from district_surfaces import CERAMIC, GLASS, MEMBRANE, METAL, PLAIN, WALL, finish, make_material, weathering_map

parser = argparse.ArgumentParser(description=__doc__)
mode = parser.add_mutually_exclusive_group()
mode.add_argument("--rebuild", action="store_true")
mode.add_argument("--export-edited", action="store_true")
parser.add_argument("--blend", type=Path, default=ROOT / "art/okazaki-district.blend")
parser.add_argument("--output", type=Path, default=ROOT / "public/station/district")
args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else [])
station = json.loads((ROOT / "public/city/manifest.json").read_text(encoding="utf8"))["station"]
cx, cy, cz = station
size = 250
side = 8
west, north = cx - size * side / 2, cz - size * side / 2
bounds = [west, north, west + side * size, north + side * size]
# Minimum measured X/Z and roof altitude identify the existing station
# landmark's roofs and its adjoining transfer/stair structures precisely.
station_roofs = [
    (117.12, 47.78, 21.60),
    (144.38, 31.97, 25.53),
    (54.74, 13.70, 19.22),
    (78.14, 12.65, 19.69),
    (59.16, 23.62, 26.95),
    (81.18, 53.83, 19.08),
    (91.62, 11.85, 20.10),
    (84.54, 50.23, 26.99),
    (106.11, -28.86, 20.12),
    (100.91, -35.41, 20.32),
    (111.63, 49.93, 19.21),
    (131.96, 18.15, 22.65),
    (120.50, -11.52, 19.36),
]

# Restrained steel, clay and blue-grey roofs; bays use darker reveals with
# pale frames that remain legible at classroom viewport resolutions.
slates = ["565B5D", "6C6F6C", "687274", "4B5459", "77746D", "775F55", "5D676C", "575855"]
sheet = ["767E7F", "7E8885", "56686E", "67808A", "777B6B"]
membranes = ["A2A5A0", "8C928E", "99928A", "969FA2", "B0ADA0"]
walls = ["DED5C7", "C9C9BE", "E1D3BC", "C2C8C1", "D5CABE", "D8CEC6"]
features = ["886C58", "637D75", "8B836C", "657982", "927565"]
glasses = ["51636C", "495E69", "677A82", "54666B"]
plain = finish(PLAIN)


def clip(poly, distance):
    if not poly:
        return []
    out = []
    a = poly[-1]
    da = distance(a)
    for b in poly:
        db = distance(b)
        if (da < 0) != (db < 0):
            t = da / (da - db)
            out.append(tuple(av + (bv - av) * t for av, bv in zip(a, b)))
        if db >= 0:
            out.append(b)
        a, da = b, db
    return out


def hull(points):
    pts = sorted(set(tuple(p) for p in points))

    def half(seq):
        stack = []
        for p in seq:
            while len(stack) >= 2:
                a, b = stack[-2:]
                if (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) > 0:
                    break
                stack.pop()
            stack.append(p)
        return stack

    return half(pts)[:-1] + half(reversed(pts))[:-1]


def rectangle(xz):
    border = hull(xz)
    best = None
    for a, b in zip(border, border[1:] + border[:1]):
        dx, dz = b[0] - a[0], b[1] - a[1]
        length = math.hypot(dx, dz)
        if not length:
            continue
        u = np.array([dx / length, dz / length])
        v = np.array([-u[1], u[0]])
        pu, pv = xz @ u, xz @ v
        du, dv = float(np.ptp(pu)), float(np.ptp(pv))
        if best is None or du * dv < best[0] - 1e-4:
            if du < dv:
                u, v = v, -u
                pu, pv = pv, -pu
                du, dv = dv, du
            best = (du * dv, u, v, float(min(pu)), float(min(pv)), du, dv)
    return best


class Cell:
    def __init__(self, row, col):
        self.id = f"r{row}-c{col}"
        self.bounds = [
            west + col * size,
            north + row * size,
            west + (col + 1) * size,
            north + (row + 1) * size,
        ]
        self.center_x = west + (col + 0.5) * size
        self.center_z = north + (row + 0.5) * size
        self.vertices = []
        self.vertex_ids = {}
        self.faces = []
        self.colors = []
        self.finishes = []
        self.roofs = set()
        self.sources = set()

    def face(self, poly, color, surface, patch):
        # Clip each overlay to its physical cell, including at the outer edge.
        x0, z0, x1, z1 = self.bounds
        for axis, low, high in ((0, x0, x1), (2, z0, z1)):
            if min(p[axis] for p in poly) < low:
                poly = clip(poly, lambda p: p[axis] - low)
            if len(poly) < 3:
                return
            if max(p[axis] for p in poly) > high:
                poly = clip(poly, lambda p: high - p[axis])
            if len(poly) < 3:
                return
        ids = []
        for x, y, z in poly:
            key = (round(x - self.center_x, 5), round(self.center_z - z, 5), round(y - cy, 5))
            i = self.vertex_ids.get(key)
            if i is None:
                i = len(self.vertices)
                self.vertex_ids[key] = i
                self.vertices.append(key)
            if i not in ids:
                ids.append(i)
        if len(ids) < 3:
            return
        self.faces.append(ids)
        self.colors.append(color)
        self.finishes.append(surface)
        self.roofs.add(patch[0])
        self.sources.update(patch[1])

    def native(self, material):
        mesh = bpy.data.meshes.new(self.id)
        mesh.from_pydata(self.vertices, [], self.faces)
        color = mesh.color_attributes.new(name="Paint", type="BYTE_COLOR", domain="CORNER")
        # BYTE_COLOR stores sRGB; bulk writing linear values through the
        # color_srgb RNA property avoids per-loop Python calls.
        colors = np.array([list(bytes.fromhex(v)) + [255] for v in self.colors], dtype=np.float32) / 255
        indices = np.repeat(np.arange(len(self.faces)), [len(f) for f in self.faces])
        color.data.foreach_set("color_srgb", colors[indices].ravel())
        mesh.color_attributes.active_color = color
        uv = mesh.uv_layers.new(name="Finish", do_init=False)
        uv.uv.foreach_set("vector", np.array(self.finishes, dtype="f4")[indices].ravel())
        mesh.validate()
        mesh.update()
        mesh.materials.append(material)
        obj = bpy.data.objects.new(self.id, mesh)
        bpy.context.collection.objects.link(obj)
        obj.location = (self.center_x - cx, cz - self.center_z, 0)
        obj["sourceRoofs"] = len(self.roofs)
        obj["sourceFiles"] = json.dumps(sorted(self.sources))
        return obj


class District:
    def __init__(self):
        self.tiles = [[Cell(r, c) for c in range(side)] for r in range(side)]
        self.patch = None

    def face(self, poly, color, surface=plain):
        x, z = [p[0] for p in poly], [p[2] for p in poly]
        cs = range(
            max(0, math.floor((min(x) - west) / size)), min(side - 1, math.floor((max(x) - west) / size)) + 1
        )
        rs = range(
            max(0, math.floor((min(z) - north) / size)),
            min(side - 1, math.floor((max(z) - north) / size)) + 1,
        )
        for r in rs:
            for c in cs:
                self.tiles[r][c].face(poly, color, surface, self.patch)


def frontage_index():
    directory = ROOT / "public/field"
    tiles = json.loads((directory / "vector-streets.json").read_text(encoding="utf8"))["tiles"]
    grid = defaultdict(list)
    for tile in tiles:
        if not overlaps(tile["bounds"], bounds):
            continue
        for road in json.loads((directory / tile["file"]).read_text(encoding="utf8"))["roads"]:
            for a, b in zip(road["line"], road["line"][1:]):
                dx, dz = b[0] - a[0], b[1] - a[1]
                if dx * dx + dz * dz < 0.04:
                    continue
                for i in range(math.floor(min(a[0], b[0]) / 40) - 1, math.floor(max(a[0], b[0]) / 40) + 2):
                    for j in range(
                        math.floor(min(a[1], b[1]) / 40) - 1, math.floor(max(a[1], b[1]) / 40) + 2
                    ):
                        grid[i, j].append((a, dx, dz, road["width"]))
    return grid


def facade(d, pts, edges, ground, style, seed, streets):
    best = None
    # Select the outward-facing wall looking onto the nearest mapped road.
    for i, j in edges:
        a, b = pts[i], pts[j]
        dx, dz = b[0] - a[0], b[2] - a[2]
        length = math.hypot(dx, dz)
        if length < 2.5:
            continue
        mx, mz = (a[0] + b[0]) / 2, (a[2] + b[2]) / 2
        nx, nz = -dz / length, dx / length
        local = streets.get((math.floor(mx / 40), math.floor(mz / 40)), ())
        for p, rx, rz, width in local:
            t = max(0, min(1, ((mx - p[0]) * rx + (mz - p[1]) * rz) / (rx * rx + rz * rz)))
            vx, vz = p[0] + t * rx - mx, p[1] + t * rz - mz
            dist = math.hypot(vx, vz)
            if not 0 < dist < 55 or (vx * nx + vz * nz) / dist < 0.45:
                continue
            score = max(0, dist - width / 2) + 8 * (1 - (vx * nx + vz * nz) / dist) - min(length, 30) * 0.14
            if best is None or score < best[0]:
                best = (score, a, b, length, dist - width / 2)
    if best is None:
        return False
    _, a, b, length, clearance = best
    top = min(a[1], b[1]) - 0.22
    height = top - ground
    if height < 2.05:
        return False
    ux, uz = (b[0] - a[0]) / length, (b[2] - a[2]) / length
    nx, nz = -uz, ux

    plaster, glass = finish(WALL, (ux, uz)), finish(GLASS, (ux, uz))

    def point(u, y, offset):
        return (a[0] + u * ux + offset * nx, y, a[2] + u * uz + offset * nz)

    def band(left, right, low, high, offset, color, surface=plain):
        if right - left < 0.04 or high - low < 0.04:
            return
        d.face([
            point(left, low, offset), point(right, low, offset),
            point(right, high, offset), point(left, high, offset),
        ], color, surface)

    def ledge(left, right, height_y, depth, color):
        d.face([
            point(left, height_y, 0.06), point(left, height_y, depth),
            point(right, height_y, depth), point(right, height_y, 0.06),
        ], color)
        band(left, right, height_y - 0.075, height_y, depth, color)

    margin = min(0.48, length * 0.10)
    band(margin, length - margin, ground + 0.18, ground + 0.52, 0.038, "8F9189", plaster)
    band(margin, length - margin, ground + 0.52, top, 0.056, walls[seed % len(walls)], plaster)
    trim = features[seed % len(features)]
    if style in ("terrace", "sheet"):
        floors = max(1, min(16, int(height / 3.06)))
        rise = height / floors
        bays = min(10, max(1, int((length - 2 * margin) / 2.75)))
        slot = (length - 2 * margin) / bays
        for level in range(floors):
            floor = ground + level * rise
            shop = level == 0 and length >= 8 and rise >= 2.65
            low = floor + (0.50 if shop else 0.84)
            high = min(floor + (2.34 if shop else 2.37), floor + rise - 0.32)
            band(margin+0.10, length-margin-0.10, low, high, 0.082, "515755")
            for k in range(bays):
                left = margin + slot * k + 0.20
                band(left, left + slot - 0.36, low + 0.08, high - 0.08, 0.109,
                     glasses[(seed + k + level) % len(glasses)], glass)
            band(margin, length-margin, low - 0.07, low + 0.015, 0.137, "A6ACA5")
            if shop and clearance > 0.9:
                ledge(margin + slot * 0.4, length - margin - slot * 0.35, high + 0.24, 0.56, trim)
        band(margin, length - margin, top - 0.22, top, 0.10, trim)
    else:
        bays = min(4, max(1, round((length - 2 * margin) / 3.0)))
        slot = (length - 2 * margin) / bays
        floors = 2 if height >= 5.55 else 1
        door = seed % bays if bays > 1 and height >= 2.75 else -1
        for level in range(floors):
            floor = ground + level * height / floors
            high = min(floor + 2.27, ground + (level + 1) * height / floors - 0.32)
            for k in range(bays):
                x = margin + slot * (k + 0.5)
                if k == door and level == 0:
                    band(x - 0.52, x + 0.52, ground + 0.23, high + 0.09, 0.102, trim)
                    band(x - 0.43, x + 0.43, ground + 0.33, high, 0.126, "615950")
                    if clearance > 0.7:
                        ledge(x - 0.64, x + 0.64, high + 0.22, 0.38, trim)
                    continue
                half = min(0.74, slot * 0.33)
                low = floor + 0.86
                band(x - half, x + half, low, high, 0.085, "4A5658")
                band(x - half + 0.085, x + half - 0.085, low + 0.10, high - 0.083, 0.111,
                     glasses[(seed + k + level) % len(glasses)], glass)
                ledge(x - half - 0.06, x + half + 0.06, low + 0.025, 0.18, "A6ACA5")
        band(margin, length - margin, top - 0.15, top, 0.10, trim)
    return True


def roof_patch(d, data, seed, streets):
    pts, triangles, edges, ground, src = data
    lo, hi = pts.min(axis=0), pts.max(axis=0)
    if any(
        abs(lo[0] - x) < 0.08 and abs(lo[2] - z) < 0.08 and abs(hi[1] - y) < 0.08 for x, z, y in station_roofs
    ):
        return "station", False
    tri = pts[triangles]
    areas = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])[:, 1] / 2
    area = areas.sum()
    xz = pts[:, [0, 2]]
    fit = rectangle(xz)
    if not fit or area <= 0.001:
        return "degenerate", False
    box_area, u, v, u0, v0, length, width = fit
    height = hi[1] - ground
    flat = hi[1] - lo[1] < 0.23
    if not flat:
        style = "measured"
    elif area < 265 and height < 10 and width >= 1.8 and area / max(box_area, 0.01) > 0.80:
        style = "gable" if seed % 5 == 0 else "hip"
    elif height < 8.8 and area >= 120:
        style = "sheet"
    else:
        style = "terrace"
    if style == "terrace":
        palette, roof_finish = membranes, finish(MEMBRANE, u)
    elif style == "sheet" or seed % 5 == 1:
        palette, roof_finish = sheet, finish(METAL, u)
    else:
        palette, roof_finish = slates, finish(CERAMIC, u)
    tone = palette[seed % len(palette)]
    # Roof pitch is a decorative inference, confined to the measured footprint.
    # Clipping each source triangle to the roof planes preserves holes, setbacks
    # and concavities, including irregular low house footprints.
    q = np.column_stack((xz @ u - u0, xz @ v - v0))

    def world(p, h):
        xx, zz = u * (u0 + p[0]) + v * (v0 + p[1])
        return (xx, h, zz)

    if style in ("hip", "gable"):
        slope = min(0.49, 4.5 / width)
        planes = [(0, slope, 0), (0, -slope, width * slope)]
        if style == "hip":
            planes.extend([(slope, 0, 0), (-slope, 0, length * slope)])

        def altitude(p, plane):
            return p[0] * plane[0] + p[1] * plane[1] + plane[2]

        for face in triangles:
            base = [tuple(q[i]) for i in face]
            for k, plane in enumerate(planes):
                poly = base
                for m, other in enumerate(planes):
                    if m != k:
                        poly = clip(poly, lambda p: altitude(p, other) - altitude(p, plane))
                    if not poly:
                        break
                if len(poly) >= 3:
                    d.face([world(p, hi[1] + 0.13 + altitude(p, plane)) for p in poly], tone, roof_finish)
        for a, b in edges:
            qa, qb = q[a], q[b]
            # Subdivide boundary at each plane switch so gable ends fully close.
            knots = [0, 1]
            for k, pa in enumerate(planes):
                for pb in planes[k + 1 :]:
                    da, db = altitude(qa, pa) - altitude(qa, pb), altitude(qb, pa) - altitude(qb, pb)
                    if da * db < 0:
                        knots.append(da / (da - db))
            knots = sorted(set(knots))
            for t0, t1 in zip(knots, knots[1:]):
                p, r = qa + (qb - qa) * t0, qa + (qb - qa) * t1
                y0 = hi[1] + 0.135 + min(altitude(p, k) for k in planes)
                y1 = hi[1] + 0.135 + min(altitude(r, k) for k in planes)
                d.face(
                    [world(p, hi[1] + 0.009), world(r, hi[1] + 0.009), world(r, y1), world(p, y0)], "69716E"
                )
    else:
        for face in tri:
            d.face([(x, y + 0.105, z) for x, y, z in face], tone, roof_finish)
        # Crest of a roof is a narrow raised rim, kept inside the actual roof.
        for a, b in edges:
            p, r = pts[a], pts[b]
            dx, dz = r[0] - p[0], r[2] - p[2]
            dist = math.hypot(dx, dz)
            if dist < 0.3:
                continue
            lift = 0.12 if style == "measured" else 0.34 if style == "terrace" else 0.20
            # Use the exact adjacent roof vertex to keep the rim inside concave corners.
            key = next(i for i in triangles if a in i and b in i)
            third = pts[next(i for i in key if i not in (a, b))]
            s0 = min(0.15, 0.24 / max(dist, np.linalg.norm(third - p), np.linalg.norm(third - r)))
            low = [(p[0], p[1] + 0.02, p[2]), (r[0], r[1] + 0.02, r[2])]
            top = [(x, y + lift, z) for x, y, z in low]
            d.face([*low, top[1], top[0]], "606F74")
            pp = p * (1 - s0) + third * s0
            rr = r * (1 - s0) + third * s0
            d.face(
                [top[0], top[1], (rr[0], rr[1] + lift + 0.02, rr[2]), (pp[0], pp[1] + lift + 0.02, pp[2])],
                "B4BFBA",
            )
        if style == "terrace" and area > 100 and height > 8:
            # Barycentric inset ensures this screen never bridges a courtyard.
            a, b, c = tri[int(np.argmax(areas))]
            m = (a + b + c) / 3
            r = min(
                1.8,
                min(
                    np.linalg.norm(np.cross(n - m, k - m)) / np.linalg.norm(n - k)
                    for n, k in ((a, b), (b, c), (c, a))
                )
                * 0.58,
            )
            if r > 0.38:
                base = [
                    (
                        m[0] + sx * r * u[0] + sz * r * 0.56 * v[0],
                        hi[1] + 0.12,
                        m[2] + sx * r * u[1] + sz * r * 0.56 * v[1],
                    )
                    for sx, sz in [(-1, -1), (-1, 1), (1, 1), (1, -1)]
                ]
                top = [(x, y + min(1.3, r * 0.67), z) for x, y, z in base]
                d.face(top, "C9CCC0")
                for i in range(4):
                    d.face([base[i], base[(i + 1) % 4], top[(i + 1) % 4], top[i]], "82918D")
    return style, facade(d, pts, edges, ground, style, seed, streets)


def add_survey_reference(references, material):
    """Keep the measured context visible in Blender and out of streamed tiles."""
    collection = bpy.data.collections.new("Survey reference · PLATEAU 2020")
    bpy.context.scene.collection.children.link(collection)
    for source, triangles in references.items():
        vertices, indices = np.unique(triangles.reshape(-1, 3), axis=0, return_inverse=True)
        local = np.column_stack((vertices[:, 0] - cx, cz - vertices[:, 2], vertices[:, 1] - cy))
        mesh = bpy.data.meshes.new(source)
        mesh.from_pydata(local.tolist(), [], indices.reshape(-1, 3).tolist())
        paint = mesh.color_attributes.new(name="Paint", type="BYTE_COLOR", domain="CORNER")
        rgb = [0.66, 0.72, 0.59] if source == "city/mesh-4.bin" else [0.79, 0.79, 0.72]
        paint.data.foreach_set("color_srgb", np.tile([*rgb, 1.0], len(paint.data)).astype("f4"))
        mesh.color_attributes.active_color = paint
        mesh.materials.append(material)
        obj = bpy.data.objects.new(source, mesh)
        collection.objects.link(obj)
        obj.hide_select = True
    # The original station is already authored in the same metric frame.
    # Append its four decorative sections so the editable .blend is portable.
    landmark = ROOT / "art/okazaki-station.blend"
    with bpy.data.libraries.load(str(landmark), link=False) as (templates, selected):
        selected.objects = [n for n in templates.objects if not n.startswith("PLATEAU ")]
    for obj in selected.objects:
        collection.objects.link(obj)
        obj.hide_select = True
    for obj in collection.objects:
        obj["districtSurveyReference"] = True


def create_source():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    with TemporaryDirectory() as directory:
        path = Path(directory) / "surfaces.png"
        path.write_bytes(weathering_map())
        material = make_material(path)
    district = District()
    roads = frontage_index()
    roofs, references = read_roofs(ROOT, bounds)
    styles = Counter()
    facades = 0
    for i, data in enumerate(roofs):
        p = data[0]
        mid = (p.min(axis=0) + p.max(axis=0)) / 2
        seed = abs(round(mid[0] * 10) * 73856093 ^ round(mid[2] * 10) * 19349663)
        district.patch = (i, data[-1])
        style, front = roof_patch(district, data, seed, roads)
        styles[style] += 1
        facades += int(front)
    touched = set()
    for row in district.tiles:
        for tile in row:
            tile.native(material)
            touched.update(tile.roofs)
    survey = {
        "sourceRoofSurfaces": len(roofs),
        "decoratedRoofSurfaces": len(touched),
        "frontages": facades,
        "styles": dict(sorted(styles.items())),
        "source": "国土交通省 PLATEAU 岡崎市 2020年度 建築物 / 国土地理院 最適化ベクトルタイル 道路中心線",
        "method": "実測屋根面・高さと道路中心線に基づく。補完した屋根、外装と建具は授業用の表現。駅舎の専用モデルを優先。",
    }
    print("District survey:", survey, flush=True)
    bpy.context.scene["survey"] = json.dumps(survey, ensure_ascii=False)
    add_survey_reference(references, material)
    for a in bpy.context.screen.areas:
        if a.type == "VIEW_3D":
            from mathutils import Vector

            a.spaces.active.shading.color_type = "VERTEX"
            a.spaces.active.clip_end = 4000
            a.spaces.active.region_3d.view_perspective = "ORTHO"
            a.spaces.active.region_3d.view_distance = 2280
            a.spaces.active.region_3d.view_rotation = Vector((-0.55, -0.8, -1.16)).to_track_quat("-Z", "Y")
            a.spaces.active.overlay.show_overlays = False
    args.blend.parent.mkdir(parents=True, exist_ok=True)
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(args.blend.resolve()), compress=True)


def export_district(staging):
    ids = {f"r{r}-c{c}" for r in range(side) for c in range(side)}
    if bpy.context.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    for obj in bpy.context.scene.objects:
        reference = obj.get("districtSurveyReference") and any(
            c.name == "Survey reference · PLATEAU 2020" for c in obj.users_collection
        )
        geometry = obj.type not in {"EMPTY", "CAMERA", "LIGHT"} or obj.instance_type == "COLLECTION"
        if geometry and obj.name not in ids and not reference:
            raise ValueError(
                f"Join the new geometry {obj.name!r} to its named rN-cN tile mesh before export."
            )
    tiles = []
    for r in range(side):
        for c in range(side):
            key = f"r{r}-c{c}"
            obj = bpy.context.view_layer.objects.get(key)
            if obj is None or obj.type != "MESH":
                raise ValueError(f"Expected the editable mesh {key!r} in the active view layer.")
            obj.hide_viewport = obj.hide_select = False
            obj.hide_set(False)
            bpy.ops.object.select_all(action="DESELECT")
            obj.select_set(True)
            bpy.context.view_layer.objects.active = obj
            file = key + ".glb"
            path = staging / file
            bpy.ops.export_scene.gltf(
                filepath=str(path.resolve()),
                export_format="GLB",
                use_selection=True,
                export_apply=True,
                export_vertex_color="ACTIVE",
                export_materials="NONE",
                export_animations=False,
                export_texcoords=True,
                export_cameras=False,
                export_lights=False,
            )
            data, triangles, (low, high) = pack_glb(path.read_bytes())
            if not (0 < triangles <= 32000 and len(data) <= 1024 * 1024):
                raise ValueError(f"Reduce {key} to at most 32,000 triangles and 1 MiB for classroom devices.")
            x0, z0 = west + c * size, north + r * size
            low = low + station
            high = high + station
            if min(low[0] - x0, low[2] - z0, x0 + size - high[0], z0 + size - high[2]) < -0.016:
                raise ValueError(f"Edited geometry leaves {key}. Split the faces at the 250 m cell boundary.")
            path.write_bytes(data)
            sources = json.loads(obj["sourceFiles"])
            tiles.append(
                {
                    "id": key,
                    "file": file,
                    "bytes": len(data),
                    "triangles": triangles,
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "bounds": [
                        west + c * size,
                        north + r * size,
                        west + (c + 1) * size,
                        north + (r + 1) * size,
                    ],
                    "heightRange": [low[1], high[1]],
                    "regionBuildings": [Path(v).stem for v in sources if v.startswith("region/")],
                    "sourceRoofs": obj["sourceRoofs"],
                    "sourceFiles": sources,
                }
            )
    surface_png = weathering_map()
    (staging / "surfaces.png").write_bytes(surface_png)
    report = {
        "version": 2,
        "origin": station,
        "bounds": bounds,
        "tileSize": size,
        "surfaces": {"file": "surfaces.png", "bytes": len(surface_png), "sha256": hashlib.sha256(surface_png).hexdigest()},
        "survey": json.loads(bpy.context.scene["survey"]),
        "tiles": tiles,
    }
    (staging / "manifest.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf8", newline="\n"
    )
    for tile in tiles:
        (staging / tile["file"]).replace(args.output / tile["file"])
    (staging / "surfaces.png").replace(args.output / "surfaces.png")
    (staging / "manifest.json").replace(args.output / "manifest.json")
    print(
        "District totals:",
        sum(t["triangles"] for t in tiles),
        "triangles;",
        sum(t["bytes"] for t in tiles),
        "bytes",
        flush=True,
    )


if args.export_edited or (args.blend.is_file() and not args.rebuild):
    bpy.ops.wm.open_mainfile(filepath=str(args.blend.resolve()), load_ui=False, use_scripts=False)
else:
    create_source()
args.output.mkdir(parents=True, exist_ok=True)
with TemporaryDirectory(dir=args.output.parent) as staging:
    export_district(Path(staging))
