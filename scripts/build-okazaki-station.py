"""Build the JR Okazaki landmark with Blender 5.x in background mode.

Export saved Blender edits to the app (the .blend is only read):
blender -b --factory-startup --python-exit-code 1 -P scripts/build-okazaki-station.py -- --export-edited

Regenerate both the editable model and the GLB from the survey measurements:
blender -b --factory-startup --python-exit-code 1 -P scripts/build-okazaki-station.py -- --rebuild

--blend PATH and --glb PATH override the paths. With no mode, an existing
.blend is exported, or a new one is generated at an unused path. --font PATH
selects the Japanese font used to generate the sign during a rebuild.
"""

import argparse
import json
import math
from pathlib import Path
import struct
import sys

import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--blend", type=Path, default=ROOT / "art" / "okazaki-station.blend")
parser.add_argument("--glb", type=Path, default=ROOT / "public" / "station" / "okazaki-station.glb")
parser.add_argument("--font", type=Path)
mode = parser.add_mutually_exclusive_group()
mode.add_argument("--export-edited", action="store_true", help="Export a saved .blend without changing it.")
mode.add_argument("--rebuild", action="store_true", help="Regenerate the .blend and overwrite it if present.")
args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else [])
if args.blend.suffix.lower() != ".blend" or args.glb.suffix.lower() != ".glb":
    parser.error("Expected --blend FILE.blend and --glb FILE.glb.")
ARCHITECTURE = ("Concourse and entrance signs", "East transfer deck", "Platform roofs and edges")
CLOCK = "EastPlazaClock"
manifest = json.loads((ROOT / "public/city/manifest.json").read_text(encoding="utf-8"))
anchor_x, anchor_y, anchor_z = manifest["station"]

# u follows the bridge eastwards, v follows the tracks southwards, h is the
# existing city mesh elevation. Coordinates and bounds were obtained from
# public/city/mesh-1.bin; the GLB origin is the manifest's station marker.
c, s = math.cos(0.06485), math.sin(0.06485)
west_x, west_z = 59.665, 48.14


def world_uv(x, z):
    dx, dz = x - west_x, z - west_z
    return dx * c - dz * s, dx * s + dz * c


def local(point):
    u, v, h = point
    return Vector((west_x + c * u + s * v - anchor_x, anchor_z - (west_z - s * u + c * v), h - anchor_y))


chalk = "E8E7DE"
silver = "B6C5C9"
light = "F9F2DC"
ink = "293D49"
frame = "405763"
roof = "768993"
standing_seam = "A2B0B3"
glass = ("5C8190", "7295A0", "628895", "809FA6")
accent = "EE893F"
sand = "CDAE85"


def rgba(hex_color):
    return tuple(int(hex_color[i : i + 2], 16) / 255 for i in (0, 2, 4)) + (1,)


class Part:
    def __init__(self, name):
        self.name = name
        self.vertices = []
        self.vertex_indices = {}
        self.faces = []
        self.colors = []

    def vertex_index(self, point):
        key = tuple(round(value, 6) for value in point)
        if key not in self.vertex_indices:
            self.vertex_indices[key] = len(self.vertices)
            self.vertices.append(local(point))
        return self.vertex_indices[key]

    def face(self, points, color, outward):
        pts = [Vector(p) for p in points]
        if (pts[1] - pts[0]).cross(pts[2] - pts[0]).dot(Vector(outward)) > 0:
            pts.reverse()  # south-positive drafting frame flips Blender's Y
        self.faces.append(tuple(self.vertex_index(point) for point in pts))
        self.colors.append(color)

    def prism(self, a, b, color):
        rings = [list(map(Vector, a)), list(map(Vector, b))]
        center = sum(rings[0] + rings[1], Vector()) / (2 * len(a))
        polygons = [rings[0], rings[1]]
        for i in range(len(a)):
            j = (i + 1) % len(a)
            polygons.append((rings[0][i], rings[0][j], rings[1][j], rings[1][i]))
        for poly in polygons:
            self.face(poly, color, sum(poly, Vector()) / len(poly) - center)

    def box(self, u0, u1, v0, v1, h0, h1, color):
        base = [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]
        self.prism([(u, v, h0) for u, v in base], [(u, v, h1) for u, v in base], color)

    def beam(self, a, b, width, depth, color):
        a, b = Vector(a), Vector(b)
        axis = (b - a).normalized()
        seed = Vector((0, 0, 1)) if abs(axis.z) < 0.95 else Vector((0, 1, 0))
        across = axis.cross(seed).normalized() * width / 2
        vertical = axis.cross(across).normalized() * depth / 2
        offsets = [-across - vertical, across - vertical, across + vertical, -across + vertical]
        self.prism([a + d for d in offsets], [b + d for d in offsets], color)

    def object(self, material):
        mesh = bpy.data.meshes.new(self.name)
        mesh.from_pydata(self.vertices, [], self.faces)
        mesh.update()
        colors = mesh.color_attributes.new(name="Paint", type="BYTE_COLOR", domain="CORNER")
        palette = {key: rgba(key) for key in set(self.colors)}
        for poly, key in zip(mesh.polygons, self.colors):
            for i in poly.loop_indices:
                colors.data[i].color_srgb = palette[key]
        mesh.color_attributes.active_color = colors
        obj = bpy.data.objects.new(self.name, mesh)
        bpy.context.collection.objects.link(obj)
        mesh.materials.append(material)
        return obj


def section(part, start, end, profile, color):
    part.prism([(start, v, h) for v, h in profile], [(end, v, h) for v, h in profile], color)


def roof_cap(part, start, end, center, halfwidth, base, rise):
    profile = [
        (center - halfwidth, base),
        (center + halfwidth, base),
        (center + halfwidth, base + 0.18),
        (center, base + rise),
        (center - halfwidth, base + 0.18),
    ]
    section(part, start, end, profile, roof)
    for side in (-1, 1):
        v = center + side * halfwidth
        part.box(start, end, v - 0.07, v + 0.07, base - 0.13, base + 0.1, ink)
    part.box(
        start, end, center - 0.085, center + 0.085, base + rise - 0.04, base + rise + 0.07, standing_seam
    )


def bridge(part, kanji):
    roof_cap(part, -0.35, 84.65, -0.45, 5.95, 27.02, 1.55)
    for u in range(2, 84, 3):
        for edge in (-6.4, 5.5):
            part.beam((u, edge, 27.21), (u, -0.45, 28.62), 0.065, 0.065, standing_seam)
    # Upper walls are layered onto the surveyed footprint. The existing
    # city mesh supplies the body and walk/collision surfaces underneath.
    for sign, edge in [(-1, -5.96), (1, 5.10)]:
        v = edge + sign * 0.20
        start, end = 8.1, 84.1
        part.box(start, end, v - 0.08, v + 0.08, 21.65, 26.99, chalk)
        part.box(start, end, v - 0.16, v + 0.16, 21.50, 21.75, frame)
        part.box(start, end, v - 0.17, v + 0.17, 24.8, 25.04, silver)
        face_v = v + sign * 0.12
        part.face(
            [(start, face_v, 22.1), (end, face_v, 22.1), (end, face_v, 24.72), (start, face_v, 24.72)],
            ink,
            (0, sign, 0),
        )
        count = 31
        for i in range(count):
            lo = start + (end - start) * i / count + 0.09
            hi = start + (end - start) * (i + 1) / count - 0.09
            vv = face_v + sign * 0.02
            part.face(
                [(lo, vv, 22.26), (hi, vv, 22.26), (hi, vv, 24.58), (lo, vv, 24.58)],
                glass[i % 4],
                (0, sign, 0),
            )
            if i % 4 == 0:
                part.box(lo - 0.12, lo + 0.05, v - 0.19, v + 0.19, 21.82, 26.9, silver)
    # Slightly taller entrance pavilion with the fanlight from the station photograph.
    for u, sign, label in [(-0.28, -1, "WEST"), (84.47, 1, "EAST")]:
        front = u + sign * 0.21
        back = u - sign * 4.6
        shell = [
            (-6.6, 27.02),
            (5.7, 27.02),
            (5.7, 28.08),
            (2.7, 29.12),
            (2.7, 30.03),
            (-0.45, 31.45),
            (-3.6, 30.03),
            (-3.6, 29.12),
            (-6.6, 28.08),
        ]
        section(part, back, u, shell, frame)
        for (v0, h0), (v1, h1) in zip(shell[2:], shell[3:]):
            part.beam((u, v0, h0), (u, v1, h1), 0.22, 0.17, silver)
        center = -0.45
        radius = 2.59
        base = 27.42
        arc = [
            (front, center + radius * math.cos(i * math.pi / 16), base + radius * math.sin(i * math.pi / 16))
            for i in range(17)
        ]
        # Split into fan triangles to keep the cap and its radial framing crisp.
        for i in range(16):
            part.face([(front, center, base), arc[i], arc[i + 1]], glass[(i // 4) % 4], (sign, 0, 0))
        part.beam(
            (front + 0.06 * sign, center - radius, base),
            (front + 0.06 * sign, center + radius, base),
            0.105,
            0.10,
            ink,
        )
        for i in (4, 8, 12):
            _, v, h = arc[i]
            part.beam((front + 0.06 * sign, center, base), (front + 0.06 * sign, v, h), 0.105, 0.10, ink)
        for p, q in zip(arc, arc[1:]):
            part.beam(p, q, 0.105, 0.105, silver)
        part.box(min(u, front), max(u, front), -6.48, 5.58, 24.80, 27.08, chalk)
        part.box(min(u, front) + sign * 0.04, max(u, front) + sign * 0.04, -6.48, 5.58, 24.82, 24.97, accent)
        text_face(part, "岡崎駅", front + sign * 0.055, center, 26.24, 1.0, sign, kanji)
        text_face(part, "OKAZAKI  /  " + label, front + sign * 0.055, center, 25.37, 0.285, sign, None)
        for v in (-6.22, 5.32):
            part.box(min(back, front), max(back, front), v - 0.21, v + 0.21, 26.8, 27.40, silver)


def text_face(part, value, u, v, h, height, sign, font):
    curve = bpy.data.curves.new("Station sign typesetting", "FONT")
    curve.body = value
    if font:
        curve.font = font
    curve.resolution_u = 2
    obj = bpy.data.objects.new("Temporary lettering", curve)
    bpy.context.collection.objects.link(obj)
    bpy.context.view_layer.update()
    mesh = obj.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh()
    mesh.calc_loop_triangles()
    points = [vert.co.copy() for vert in mesh.vertices]
    if not points:
        raise RuntimeError(f"Could not typeset {value}")
    xs, ys = [p.x for p in points], [p.y for p in points]
    scale = height / (max(ys) - min(ys))
    mid_x, mid_y = (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2
    vertices = [(u, v - sign * (p.x - mid_x) * scale, h + (p.y - mid_y) * scale) for p in points]
    for tri in mesh.loop_triangles:
        part.face([vertices[i] for i in tri.vertices], ink, (sign, 0, 0))
    obj.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh_clear()
    bpy.data.objects.remove(obj, do_unlink=True)
    bpy.data.curves.remove(curve)


def transfer_deck(part):
    # The surveyed east deck runs across the forecourt. Dress its existing
    # slab; its two access paths and the roads below keep their original mesh.
    u0, v = world_uv(145.8, 41.98)
    u1, _ = world_uv(179.55, 39.78)
    part.box(u0, u1, v - 2.5, v + 2.5, 25.55, 25.65, sand)
    for side in (-1, 1):
        edge = v + side * 2.36
        part.box(u0, u1, edge - 0.06, edge + 0.06, 26.57, 26.69, silver)
        part.box(u0, u1, edge - 0.04, edge + 0.04, 26.0, 26.08, frame)
        for j in range(9):
            u = u0 + 0.25 + (u1 - u0 - 0.5) * j / 8
            part.box(u - 0.07, u + 0.07, edge - 0.07, edge + 0.07, 25.65, 26.69, frame)
    roof_cap(part, u0 - 0.1, u1 + 0.12, v, 1.96, 28.25, 0.57)
    for j in range(7):
        u = u0 + 0.30 + (u1 - u0 - 0.60) * j / 6
        for side in (-1, 1):
            edge = v + side * 1.70
            part.box(u - 0.10, u + 0.10, edge - 0.10, edge + 0.10, 25.65, 28.28, chalk)
            part.beam((u, edge, 27.71), (u, edge - side * 0.54, 28.3), 0.10, 0.10, frame)


def platform_cap(part, start, end, width, base):
    # The PLATEAU LoD1 platform roofs appear as slender prisms. The cap and
    # shadow fascia follow each individual axis and stop at its footprint ends.
    a = Vector(world_uv(*start))
    b = Vector(world_uv(*end))
    axis = (b - a).normalized()
    side = Vector((-axis.y, axis.x))
    profile = [
        (-width / 2, base),
        (width / 2, base),
        (width / 2, base + 0.17),
        (0, base + 0.62),
        (-width / 2, base + 0.17),
    ]

    def ring(pos):
        return [(*tuple(pos + offset * side), h) for offset, h in profile]

    part.prism(ring(a), ring(b), roof)
    for sign in (-1, 1):
        offset = sign * width / 2 * side
        part.beam((*tuple(a + offset), base + 0.04), (*tuple(b + offset), base + 0.04), 0.11, 0.18, frame)
    for i in range(1, int((b - a).length / 4)):
        r = a + axis * (i * 4)
        for sign in (-1, 1):
            tip = r + side * (sign * width / 2)
            part.beam((*tuple(r), base + 0.65), (*tuple(tip), base + 0.2), 0.065, 0.065, standing_seam)


def plaza_clock(part):
    # Surveyed traffic island, clear of the surrounding streets and buildings.
    u, v = world_uv(163, -4)
    part.box(u - 0.81, u + 0.81, v - 1.18, v + 1.18, 16.54, 16.83, sand)
    part.box(u - 0.24, u + 0.24, v - 0.80, v + 0.80, 16.81, 22.85, ink)
    for sign in (-1, 1):
        front = u + sign * 0.258
        part.face(
            [
                (front, v - 0.61, 17.08),
                (front, v + 0.61, 17.08),
                (front, v + 0.61, 21.0),
                (front, v - 0.61, 21.0),
            ],
            chalk,
            (sign, 0, 0),
        )
        part.box(front - 0.02, front + 0.02, v - 0.57, v + 0.57, 20.66, 20.8, accent)
        # The actual clock has a circular analogue dial set in a dark frame.
        mid = 21.90
        circle = [
            (front, v + 0.59 * math.cos(i * math.tau / 32), mid + 0.59 * math.sin(i * math.tau / 32))
            for i in range(32)
        ]
        part.face(circle, light, (sign, 0, 0))
        for i in range(12):
            angle = i * math.tau / 12

            def mark(r):
                return (front + sign * 0.024, v + r * math.sin(angle), mid + r * math.cos(angle))

            part.beam(mark(0.48), mark(0.54), 0.032, 0.030, frame)
        for angle, r in [(math.radians(308), 0.31), (math.radians(62), 0.42)]:
            part.beam(
                (front + sign * 0.05, v, mid),
                (front + sign * 0.05, v + r * math.sin(angle), mid + r * math.cos(angle)),
                0.060,
                0.060,
                ink,
            )


def platform_sides(part, footprint, roof_h, ground):
    outline = [Vector(world_uv(x, z)) for x, z in footprint]
    edges = list(zip(outline, outline[1:] + outline[:1]))
    winding = 1 if sum(a.x * b.y - a.y * b.x for a, b in edges) > 0 else -1
    for a, b in edges:
        axis = (b - a).normalized()
        length = (b - a).length
        outward = Vector((axis.y, -axis.x)) * winding

        def band(start, end, bottom, top, offset, color):
            p = a + start * axis + offset * outward
            q = a + end * axis + offset * outward
            part.face([(*p, bottom), (*q, bottom), (*q, top), (*p, top)], color, (*outward, 0))

        # Existing low LoD1 solids use the game's generic office-window shader.
        # Cap their vertical sides with shaded waiting bays and a raised kerb.
        band(-0.03, length + 0.03, ground - 0.08, roof_h, 0.08, "546C73")
        band(-0.035, length + 0.035, roof_h - 0.55, roof_h, 0.10, ink)
        band(-0.035, length + 0.035, ground - 0.07, ground + 0.72, 0.11, "8B9899")
        band(-0.04, length + 0.04, ground + 0.72, ground + 0.85, 0.12, "E5CA80")
        bays = max(1, round(length / 5.5))
        for j in range(bays):
            low = j * length / bays
            band(low, min(low + 0.18, length), ground + 0.85, roof_h - 0.19, 0.13, silver)


def reference_city(material):
    # Include a bounded, selectable-in-the-Outliner survey context only in the
    # editable file, so the .blend opens with the same ground and building mass.
    for entry in manifest["parts"]:
        if entry["name"] not in ("Mesh-001", "Mesh-004"):
            continue
        count = entry["vertices"]
        raw = (ROOT / "public/city" / entry["file"]).read_bytes()
        xyz = list(struct.iter_unpack("<3f", raw[: count * 12]))
        faces = struct.iter_unpack("<3I", raw[count * 32 : count * 32 + entry["indices"] * 4])
        city = Part(entry["name"])
        for ids in faces:
            verts = [xyz[i] for i in ids]
            if not all(15 < x < 202 and -51 < z < 182 for x, y, z in verts):
                continue
            points = [(*world_uv(x, z), y) for x, y, z in verts]
            city.faces.append(tuple(city.vertex_index(p) for p in points))
            if entry["name"] == "Mesh-004":
                city.colors.append("B3BC9D")
            elif max(p[2] for p in points) - min(p[2] for p in points) < 0.05:
                city.colors.append("A5ADA9")
            else:
                city.colors.append("BFC4BE")
        obj = city.object(material)
        obj.name = f"PLATEAU 2020 · {entry['name']}"
        obj.hide_select = True


def build_editable_source():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    font_paths = [
        args.font,
        Path("C:/Windows/Fonts/NotoSansJP-VF.ttf"),
        Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
        Path("/System/Library/Fonts/ヒラギノ角ゴシック W4.ttc"),
    ]
    font_path = next((p for p in font_paths if p and p.is_file()), None)
    if not font_path:
        raise FileNotFoundError("Supply a Japanese typeface with --font for the 岡崎駅 station sign.")
    kanji = bpy.data.fonts.load(str(font_path))
    material = bpy.data.materials.new("Station paint and glazing")
    material.use_nodes = True
    material.use_backface_culling = True
    bsdf = material.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Roughness"].default_value = 0.72
    color = material.node_tree.nodes.new("ShaderNodeVertexColor")
    color.layer_name = "Paint"
    material.node_tree.links.new(color.outputs["Color"], bsdf.inputs["Base Color"])

    concourse = Part(ARCHITECTURE[0])
    bridge(concourse, kanji)
    deck = Part(ARCHITECTURE[1])
    transfer_deck(deck)
    platforms = Part(ARCHITECTURE[2])
    for start, end, width, h in [
        ((80.8, 13.03), (82.62, 40.49), 5.45, 19.73),
        ((94.23, 12.16), (95.93, 39.76), 5.27, 20.14),
        ((109.16, -28.41), (113.72, 38.34), 6.04, 20.16),
        ((103.21, -35.09), (108.38, 38.70), 4.77, 20.36),
        ((84.73, 76.95), (91.05, 171.38), 4.45, 19.12),
    ]:
        platform_cap(platforms, start, end, width, h)
    for footprint, roof_h, ground in [
        ([(85.33, 40.53), (80.07, 40.87), (78.14, 13.01), (83.38, 12.65)], 19.69, 15.91),
        ([(98.65, 39.66), (93.2, 40.02), (91.62, 12.15), (96.79, 11.85)], 20.1, 15.9),
        ([(116.79, 38.48), (110.77, 38.87), (106.11, -28.44), (112.13, -28.86)], 20.12, 15.95),
        (
            [(106.11, -28.44), (105.63, -35.41), (100.91, -35.08), (106.09, 39.18), (110.77, 38.87)],
            20.32,
            15.91,
        ),
        (
            [
                (89.19, 104.17),
                (87.9, 104.26),
                (87.78, 100.54),
                (84.71, 100.76),
                (85.12, 107.27),
                (85.19, 108.44),
                (89.44, 108.19),
                (93.39, 171.49),
                (88.94, 171.81),
                (81.18, 53.99),
                (83.57, 53.83),
                (85.7, 76.66),
                (87.47, 76.62),
            ],
            19.08,
            15.63,
        ),
    ]:
        platform_sides(platforms, footprint, roof_h, ground)
    clock = Part(CLOCK)
    plaza_clock(clock)
    for part in (concourse, deck, platforms, clock):
        part.object(material)
    reference_city(material)
    bpy.context.scene["Survey reference"] = manifest["source"]
    bpy.context.scene["Survey source"] = "https://www.mlit.go.jp/plateau/"
    bpy.data.fonts.remove(kanji)
    for area in bpy.context.screen.areas:
        if area.type == "VIEW_3D":
            area.spaces.active.shading.color_type = "VERTEX"
            area.spaces.active.overlay.show_overlays = False
            region = area.spaces.active.region_3d
            region.view_distance = 122
            region.view_rotation = Vector((-1, -0.85, -0.65)).to_track_quat("-Z", "Y")
            region.view_location = (7, 6, 5)
    args.blend.parent.mkdir(parents=True, exist_ok=True)
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(args.blend.resolve()), compress=True)


def export_landmark():
    authored = []
    for name in (*ARCHITECTURE, CLOCK):
        obj = bpy.context.view_layer.objects.get(name)
        if obj is None or obj.type != "MESH":
            raise ValueError(f"Expected a mesh named {name!r} in the current view layer.")
        authored.append(obj)
    if bpy.context.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="DESELECT")
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for obj in authored:
        obj.hide_viewport = obj.hide_select = False
        obj.hide_set(False)
        # Mesh joins discard modifiers on all but the active object. Bake the
        # evaluated edit in memory before batching the architecture for WebXR.
        if obj.modifiers or obj.data.shape_keys:
            evaluated = obj.evaluated_get(depsgraph)
            mesh = bpy.data.meshes.new_from_object(
                evaluated, preserve_all_data_layers=True, depsgraph=depsgraph
            )
            obj.modifiers.clear()
            obj.data = mesh
    for obj in authored[:-1]:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = authored[0]
    bpy.ops.object.join()
    bpy.context.view_layer.objects.active.name = "StationArchitecture"
    bpy.context.view_layer.objects.active.data.name = "StationArchitecture"
    authored[-1].select_set(True)
    args.glb.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(args.glb.resolve()),
        export_format="GLB",
        use_selection=True,
        export_vertex_color="MATERIAL",
        export_animations=False,
        export_texcoords=False,
        export_cameras=False,
        export_lights=False,
    )


if args.export_edited or (args.blend.is_file() and not args.rebuild):
    bpy.ops.wm.open_mainfile(filepath=str(args.blend.resolve()), load_ui=False, use_scripts=False)
else:
    build_editable_source()
export_landmark()
