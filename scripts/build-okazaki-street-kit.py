"""Build the editable Okazaki street models and one opaque vertex-colour GLB.

blender -b --factory-startup --python-exit-code 1 -P scripts/build-okazaki-street-kit.py -- --rebuild
blender -b --factory-startup --python-exit-code 1 -P scripts/build-okazaki-street-kit.py
"""

import argparse
import hashlib
import json
import math
from pathlib import Path
import random
import sys
from tempfile import TemporaryDirectory

import bmesh
import bpy
from mathutils import Euler, Vector

ROOT = Path(__file__).resolve().parents[1]


def shade(color, factor):
    return "".join(f"{min(255, round(channel * factor)):02X}" for channel in bytes.fromhex(color))


class Prop:
    """Coordinates in metres, with ground at Y=0 and model front at +Z."""

    def __init__(self, name):
        self.name = name
        self.vertices = []
        self.vertex_index = {}
        self.polygons = []
        self.paint = []

    def face(self, points, color):
        face = []
        for x, y, z in points:
            key = (round(x, 6), round(-z, 6), round(y, 6))
            if key not in self.vertex_index:
                self.vertex_index[key] = len(self.vertices)
                self.vertices.append(key)
            face.append(self.vertex_index[key])
        self.polygons.append(face)
        self.paint.append(color)

    def box(self, center, size, color):
        x, y, z = center
        a, b, c = (v / 2 for v in size)
        self.loft([(y - b, a, c, 0, z), (y + b, a, c, 0, z)], color, x=x)

    def loft(self, levels, color, top=None, x=0):
        rings = []
        for y, a, b, cut, z in levels:
            if cut:
                loop = [(-a + cut, -b), (a - cut, -b), (a, -b + cut), (a, b - cut),
                        (a - cut, b), (-a + cut, b), (-a, b - cut), (-a, -b + cut)]
            else:
                loop = [(-a, -b), (a, -b), (a, b), (-a, b)]
            rings.append([(x + dx, y, z + dz) for dx, dz in loop])
        count = len(rings[0])
        self.face(rings[0], shade(color, 0.78))
        self.face(rings[-1][::-1], top or shade(color, 1.06))
        for band, (bottom, upper) in enumerate(zip(rings, rings[1:])):
            for n in range(count):
                m = (n + 1) % count
                self.face([bottom[n], upper[n], upper[m], bottom[m]],
                          shade(color, 0.95 + (n % 3) * 0.023 + band * 0.01))

    def tube(self, start, end, radius, taper, sides, color):
        a, b = Vector(start), Vector(end)
        direction = (b - a).normalized()
        axis = Vector((0, 1, 0)) if abs(direction.y) < 0.8 else Vector((1, 0, 0))
        u = axis.cross(direction).normalized()
        v = direction.cross(u)
        offsets = [u * math.cos(i * math.tau / sides) + v * math.sin(i * math.tau / sides)
                   for i in range(sides)]
        foot = [a + d * radius for d in offsets]
        tip = [b + d * taper for d in offsets]
        self.face(foot[::-1], shade(color, 0.83))
        self.face(tip, shade(color, 1.08))
        for i in range(sides):
            j = (i + 1) % sides
            self.face([foot[i], foot[j], tip[j], tip[i]], shade(color, 0.90 + i % 4 * 0.046))

    def crown(self, center, size, color, seed, detail=1):
        rng = random.Random(seed)
        mesh = bmesh.new()
        bmesh.ops.create_icosphere(mesh, subdivisions=detail, radius=1)
        rotation = Euler((0, rng.uniform(0, math.tau), rng.uniform(-0.18, 0.18))).to_matrix()
        for face in mesh.faces:
            points = []
            for v in face.verts:
                p = rotation @ v.co
                points.append(tuple(c + a * s for c, a, s in zip(center, p, size)))
            top = (face.normal.y + 1) / 2
            self.face(points, shade(color, 0.76 + 0.34 * top + rng.uniform(-0.055, 0.055)))
        mesh.free()

    def make(self, material, contact):
        mesh = bpy.data.meshes.new(self.name)
        mesh.from_pydata(self.vertices, [], self.polygons)
        paint = mesh.color_attributes.new(name="Paint", type="BYTE_COLOR", domain="CORNER")
        for polygon, color in zip(mesh.polygons, self.paint):
            rgba = tuple(c / 255 for c in bytes.fromhex(color)) + (1,)
            for index in polygon.loop_indices:
                paint.data[index].color_srgb = rgba
        mesh.color_attributes.active_color = paint
        mesh.validate()
        mesh.update()
        mesh.materials.append(material)
        obj = bpy.data.objects.new(self.name, mesh)
        bpy.context.collection.objects.link(obj)
        obj.location = contact
        return obj


def car(name, paint, glass_top, van=False):
    p = Prop(name)
    p.loft([(0.26, .74, 1.71, .20, 0), (.44, .80, 1.79, .17, 0), (.86, .79, 1.77, .15, 0),
            (.96, .72, 1.63, .16, 0)], paint)
    # Taper the glazed cabin independently of the curved fenders and sill.
    p.loft([(.91, .69, 1.17, .12, -.16), (glass_top, .57, .92, .12, -.29)], "344652", top=paint)
    for side in (-1, 1):
        p.box((side * .635, glass_top - .215, -.17), (.105, .34, .064), shade(paint, .89))
        p.box((side * .787, .79, -.14), (.027, .07, .13), "A0ADB1")
        p.box((side * .815, .88, .65), (.19, .12, .23), paint)
        for z in (-1.13, 1.10):
            p.tube((side * .69, .27, z), (side * .82, .27, z), .269, .269, 10, "292D33")
            p.tube((side * .821, .27, z), (side * .828, .27, z), .139, .139, 8, "A4ABB0")
        p.box((side * .51, .71, 1.783), (.32, .18, .025), "F4EFCE")
        p.box((side * .57, .66, -1.785), (.29, .20, .020), "C5433C")
        if van:
            p.box((side * .78, .64, -.55), (.016, .036, .86), "384752")
    p.box((0, .52, 1.795), (.74, .17, .009), "303943")
    p.box((0, .47, -1.794), (.30, .13, .010), "D3DDDE")
    return p


def train(name, cab):
    p = Prop(name)
    p.loft([(.45, 1.20, 5.82, .15, 0), (.76, 1.36, 5.96, .16, 0),
            (3.12, 1.36, 5.96, .16, 0), (3.35, 1.19, 5.90, .16, 0)], "BFC7CF", top="919EA8")
    p.loft([(3.30, 1.20, 5.72, .18, 0), (3.52, .98, 5.60, .18, 0)], "7B8992")
    for side in (-1, 1):
        x = side * 1.367
        p.box((x, 1.15, 0), (.013, .26, 11.58), "DD652E")
        p.box((x, 1.03, 0), (.016, .045, 11.58), "8F4E3A")
        p.box((x, 2.32, 0), (.010, 1.01, 11.51), "343E49")
        for z in (-3.84, 0, 3.84):
            p.box((x, 1.89, z), (.022, 2.04, .96), "A6B1BB")
            p.box((x + side * .014, 2.28, z), (.012, .82, .72), "41535F")
            p.box((x + side * .022, 1.88, z), (.012, 1.96, .032), "6B7B85")
            p.box((x + side * .018, 2.95, z), (.014, .09, .56), "B16D3C")
        for z in (-5.12, -2.55, -1.30, 1.30, 2.55, 5.12):
            p.box((x + side * .008, 2.37, z), (.020, .66, .91), "556B79")
            p.box((x + side * .018, 2.61, z), (.012, .047, .87), "7F98A6")
        for z in (-3.95, 3.95):
            p.box((side * .91, .36, z), (.38, .34, 1.28), "404951")
            for axle in (-.39, .39):
                p.tube((side * .48, .21, z + axle), (side * .86, .21, z + axle), .208, .208, 8, "303740")
    for z in (-2.54, 2.54):
        p.loft([(3.49, .53, .87, .12, z), (3.64, .49, .81, .12, z)], "9EA8AD")
        for grille in (-.38, -.12, .14, .40):
            p.box((0, 3.64, z + grille), (.81, .024, .066), "687681")
    if cab:
        p.loft([(.75, 1.19, .08, .04, 5.88), (2.90, 1.18, .08, .04, 5.90)], "515F69")
        p.box((0, 2.54, 5.982), (1.98, .73, .014), "293742")
        p.box((0, 2.78, 5.992), (1.93, .06, .008), "66818E")
        p.box((0, 2.54, 5.992), (.044, .73, .008), "76828A")
        p.box((0, 3.02, 5.97), (1.02, .19, .02), "20282F")
        p.box((0, 1.31, 5.983), (2.18, .29, .018), "DD652E")
        for side in (-1, 1):
            p.box((side * .88, 1.54, 5.99), (.24, .14, .018), "FCF1CB")
            p.box((side * .60, 1.54, 5.99), (.13, .13, .019), "AA3830")
    else:
        p.box((0, 3.57, 0.0), (.60, .18, .28), "475763")
        p.tube((-.22, 3.58, -.16), (.28, 3.78, .17), .032, .032, 5, "475763")
    return p


def trees():
    broad = Prop("tree-keyaki")
    broad.tube((0, 0, 0), (.14, 4.4, .11), .27, .07, 7, "695547")
    for index, (x, y, z) in enumerate([(-1.54, 4.65, -.20), (.78, 4.82, 1.02), (1.33, 4.96, -.72), (-.47, 5.3, -.85)]):
        broad.tube((0, 2.16 + index * .25, 0), (x, y, z), .084, .038, 5, "725D4D")
        broad.crown((x, y, z), (1.26, 1.14, 1.13), "64894D", 12 + index)
    broad.crown((.12, 5.62, 0), (1.71, 1.23, 1.52), "749953", 122)

    pine = Prop("tree-pine")
    pine.tube((0, 0, 0), (.19, 7.1, 0), .23, .05, 7, "645041")
    for index, (x, y, z, wide) in enumerate([(-.83, 4.37, -.04, 1.44), (.64, 5.3, .42, 1.29),
                                              (.05, 6.35, -.62, 1.39), (.25, 7.27, .09, 1.03)]):
        pine.tube((.10, y - 1.24, 0), (x, y, z), .080, .042, 5, "675444")
        pine.crown((x, y, z), (wide, .75, wide * .86), "43664B", 51 + index)

    slender = Prop("tree-riverside")
    slender.tube((0, 0, 0), (-.17, 4.7, .30), .19, .045, 7, "756749")
    for index, (x, y, z) in enumerate([(-.77, 3.92, -.38), (.46, 4.43, -.59), (.74, 4.65, .52), (-.55, 5.18, .62)]):
        slender.tube((0, y - 1.14, .1), (x, y + .27, z), .069, .036, 5, "756749")
        slender.crown((x, y, z), (.94, 1.67, .83), "7D9960", 75 + index)
    return broad, pine, slender


def grass(name, tall):
    prop = Prop(name)
    rng = random.Random(249 if tall else 224)
    for i in range(16):
        ring = math.sqrt((i + .5) / 16) * 1.85
        angle = i * 2.39996
        x, z = math.cos(angle) * ring, math.sin(angle) * ring
        h = rng.uniform(.24, .57) if tall else rng.uniform(.12, .35)
        for blade in range(2):
            angle += 2.12
            dx, dz = math.cos(angle), math.sin(angle)
            width = rng.uniform(.019, .039)
            lean = (0.12 if tall else 0.21) * h
            base = [(x - dx * width, 0, z - dz * width), (x + dx * width, 0, z + dz * width)]
            bend = [(x - dz * lean - dx * width * .65, h * .59, z + dx * lean - dz * width * .65),
                    (x - dz * lean + dx * width * .65, h * .59, z + dx * lean + dz * width * .65)]
            top = (x - dz * lean * 2.2, h, z + dx * lean * 2.2)
            color = ["5D7642", "779655", "8AA45B", "9CAD65"][rng.randrange(4)]
            prop.face([base[0], base[1], bend[1], bend[0]], shade(color, .88))
            prop.face([bend[0], bend[1], top], color)
        if i % (4 if tall else 5) == 0:
            c = (x - dz * lean * 2, h, z + dx * lean * 2)
            prop.box((c[0], c[1] + .013, c[2]), (.053, .033, .053), "D6C991" if tall else "ECE4B8")
    return prop


def street_furniture():
    signal = Prop("signal-arm")
    signal.tube((0, 0, 0), (0, 5.62, 0), .118, .084, 9, "87939B")
    signal.tube((0, 0, 0), (0, .16, 0), .23, .23, 8, "9AA3A5")
    signal.tube((0, 5.44, 0), (-3.20, 5.44, 0), .066, .059, 7, "89959C")
    signal.tube((0, 5.11, 0), (-.90, 5.44, 0), .042, .042, 6, "74808A")
    signal.box((-3.20, 5.30, .09), (1.44, .48, .28), "687781")
    signal.box((-3.20, 5.30, .23), (1.30, .37, .049), "29343D")
    for i in range(3):
        x = -3.64 + i * .44
        signal.tube((x, 5.30, .253), (x, 5.30, .308), .156, .151, 10, "242D36")
        signal.box((x, 5.451, .345), (.34, .067, .205), "495661")
        signal.box((x - .127, 5.403, .343), (.048, .085, .143), "38464D")
        signal.box((x + .127, 5.403, .343), (.048, .085, .143), "38464D")
    lens = Prop("signal-lens")
    lens.tube((0, 0, -.022), (0, 0, .004), .114, .114, 12, "FFFFFF")

    light = Prop("street-light")
    light.tube((0, 0, 0), (0, 7.05, 0), .113, .066, 8, "879296")
    light.tube((0, 6.88, 0), (-.55, 7.21, 0), .060, .046, 7, "9DA8AE")
    light.tube((-.55, 7.21, 0), (-1.65, 7.19, 0), .046, .042, 7, "9DA8AE")
    light.loft([(7.12, .52, .195, .075, 0), (7.245, .44, .152, .075, 0)], "82949C", x=-1.66)
    light.box((-1.68, 7.104, 0), (.81, .021, .29), "D6DED6")
    return signal, lens, light


def create_source(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    material = bpy.data.materials.new("Okazaki street kit · vertex paint")
    material.use_nodes = True
    material.use_backface_culling = True
    bsdf = material.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Roughness"].default_value = .78
    paint = material.node_tree.nodes.new("ShaderNodeVertexColor")
    paint.layer_name = "Paint"
    material.node_tree.links.new(paint.outputs["Color"], bsdf.inputs["Base Color"])
    props = [car("car-kei", "ECEBE5", 1.43), car("car-van", "6B8595", 1.61, van=True),
             train("train-cab", True), train("train-middle", False),
             *trees(), grass("grass-meadow", False), grass("grass-reeds", True), *street_furniture()]
    for i, prop in enumerate(props):
        prop.make(material, ((i % 4 - 1.5) * 11, (i // 4 - 1) * 17, 0))
    for area in bpy.context.screen.areas:
        if area.type == "VIEW_3D":
            area.spaces.active.shading.color_type = "VERTEX"
            region = area.spaces.active.region_3d
            region.view_perspective = "ORTHO"
            region.view_distance = 62
            region.view_rotation = Vector((-.48, -.67, -.56)).to_track_quat("-Z", "Y")
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(path.resolve()), compress=True)


def export(blend, output):
    bpy.ops.wm.open_mainfile(filepath=str(blend.resolve()), load_ui=False, use_scripts=False)
    # The native scene lays out the props for editing. GLB instances all share
    # the same ground origin and point forward in common local coordinates.
    triangles = 0
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH" or len(obj.data.materials) != 1 or not obj.data.color_attributes.get("Paint"):
            raise ValueError(f"Expected one vertex-painted mesh for {obj.name}")
        obj.location = (0, 0, 0)
        obj.data.calc_loop_triangles()
        triangles += len(obj.data.loop_triangles)
    if triangles > 6000:
        raise ValueError("The street kit exceeded 6,000 source triangles.")
    output.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=output.parent) as staging:
        path = Path(staging) / output.name
        bpy.ops.export_scene.gltf(
            filepath=str(path.resolve()), export_format="GLB", export_vertex_color="MATERIAL",
            export_animations=False, export_texcoords=False, export_cameras=False, export_lights=False,
        )
        data = path.read_bytes()
        if len(data) > 640_000:
            raise ValueError("The street kit exceeded 640 KB.")
        path.replace(output)
    print(json.dumps({"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "triangles": triangles}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rebuild", action="store_true")
    parser.add_argument("--blend", type=Path, default=ROOT / "art/okazaki-street-kit.blend")
    parser.add_argument("--output", type=Path, default=ROOT / "public/station/street-kit.glb")
    opts = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    if opts.rebuild:
        create_source(opts.blend)
    export(opts.blend, opts.output)
