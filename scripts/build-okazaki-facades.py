"""Model editable facade modules in Blender and bake one orthographic atlas."""

import argparse
from pathlib import Path
import sys

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[1]
KINDS = ("Residential sliders", "Side casement", "Slatted entry", "Shopfront",
         "Apartment balcony", "Office ribbon", "Roller shutter", "Clerestory")


def linear(byte):
    channel = int(byte, 16) / 255
    return channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4


def material(label, color, roughness=.65, metallic=0):
    mat = bpy.data.materials.new(label)
    rgb = tuple(linear(color[i:i + 2]) for i in (0, 2, 4)) + (1,)
    mat.diffuse_color = rgb
    mat.use_nodes = True
    principled = mat.node_tree.nodes.get("Principled BSDF")
    principled.inputs["Base Color"].default_value = rgb
    principled.inputs["Roughness"].default_value = roughness
    principled.inputs["Metallic"].default_value = metallic
    return mat


class Module:
    def __init__(self, index, palette):
        self.center = (2.0 * (index % 4) - 3, 1 - 2.0 * (index // 4))
        self.materials = palette
        self.collection = bpy.data.collections.new(KINDS[index])
        bpy.context.scene.collection.children.link(self.collection)

    def box(self, name, x, z, width, height, front, tint, thickness=.045):
        cx, cz = self.center
        bpy.ops.mesh.primitive_cube_add(size=1, location=(cx + x, -front, cz + z))
        obj = bpy.context.object
        obj.dimensions = (width, thickness, height)
        obj.name = name
        obj.data.materials.append(self.materials[tint])
        for parent in list(obj.users_collection):
            parent.objects.unlink(obj)
        self.collection.objects.link(obj)

    def frame(self, width, bottom, top, bars, tint="bronze", sill="stone"):
        center, height = (bottom + top) / 2, top - bottom
        self.box("Dark reveal", 0, center, width, height, .015, "reveal")
        for sign in (-1, 1):
            self.box("Outer jamb", sign * (width / 2 - .045), center, .075, height - .02, .097, tint)
        for z in (bottom + .043, top - .043):
            self.box("Outer head or rail", 0, z, width - .07, .067, .097, tint)
        inner = width - .17
        for i in range(bars):
            x = -inner / 2 + inner * (i + .5) / bars
            w = inner / bars - .024
            self.box("Glass with sky reflection", x, center, w, height - .17, .054, "glass")
            self.box("Soft upper reflection", x, top - height * .23, w, height * .28, .079, "sky", .008)
            self.box("Interior shade", x, bottom + height * .15, w, height * .14, .078, "shade", .012)
            if i:
                self.box("Mullion", x - inner / bars / 2, center, .034, height - .13, .109, tint)
        self.box("Water shedding sill", 0, bottom - .042, width + .045, .059, .119, sill, .14)


def create(blend):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    palette = {name: material(name, color, roughness, metal) for name, color, roughness, metal in (
        ("reveal", "343B3C", .84, 0), ("bronze", "555957", .44, .18),
        ("metal", "B7C3BB", .35, .32), ("glass", "547884", .29, .16),
        ("sky", "7CA2B2", .4, .12), ("shade", "3C555F", .66, .05),
        ("stone", "C8C0AA", .82, 0), ("wood", "946647", .73, 0),
        ("groove", "593D33", .79, 0), ("paper", "DAD1B7", .89, 0),
        ("shop", "43716C", .59, .1), ("rail", "727E81", .56, .2),
        ("shutter", "8E9492", .66, .16),
    )}
    def module(index):
        return Module(index, palette)

    house = module(0)
    house.frame(1.8, -.8, .9, 2, "bronze")
    house.box("Half drawn curtain", -.67, .12, .24, 1.32, .085, "paper", .012)
    house.box("Meeting rail handle", .08, -.05, .055, .18, .15, "metal")

    side = module(1)
    side.frame(1.74, -.81, .89, 1, "metal")
    side.box("Awning rail", 0, -.39, 1.56, .055, .112, "metal")
    side.box("Frosted lower glass", 0, -.566, 1.55, .27, .087, "paper", .01)

    entry = module(2)
    entry.box("Entry reveal", 0, .016, 1.81, 1.83, .019, "reveal")
    entry.box("Timber door", -.11, .014, 1.39, 1.70, .077, "wood")
    for i in range(9):
        entry.box("Timber joint", -.71 + .135 * i, .014, .012, 1.67, .102, "groove", .012)
    entry.box("Frosted sidelight", .67, .035, .19, 1.55, .091, "sky")
    entry.box("Door handle", .46, -.083, .032, .25, .15, "metal")
    entry.box("Stone threshold", 0, -.92, 1.88, .076, .14, "stone", .23)

    shop = module(3)
    shop.frame(1.87, -.89, .58, 3, "shop", "stone")
    shop.box("Signboard with canopy", 0, .721, 1.91, .22, .135, "shop", .19)
    shop.box("Storefront sign line", 0, .715, 1.12, .025, .24, "paper", .02)
    shop.box("Exterior counter rail", -.32, -.211, 1.12, .051, .132, "bronze")
    shop.box("Entry pull", .42, -.168, .034, .29, .145, "metal")

    apartment = module(4)
    apartment.frame(1.82, -.78, .90, 2, "metal")
    apartment.box("Balcony slab", 0, -.88, 1.92, .17, .26, "stone", .36)
    for i in range(13):
        apartment.box("Guardrail picket", -.852 + .142 * i, -.527, .024, .55, .40, "rail")
    apartment.box("Top rail", 0, -.225, 1.86, .068, .40, "rail", .092)
    apartment.box("Curtain", -.64, .273, .35, .988, .085, "paper", .016)

    office = module(5)
    office.frame(1.88, -.81, .89, 3, "metal")
    office.box("Shadow at slab edge", 0, .865, 1.90, .11, .18, "rail", .19)
    for i in range(4):
        office.box("Tilted blind edge", 0, .61 - i * .073, 1.69, .024, .085, "sky", .01)

    garage = module(6)
    garage.box("Door frame", 0, .028, 1.87, 1.81, .04, "bronze")
    garage.box("Rolled metal", 0, -.012, 1.69, 1.66, .093, "shutter")
    for i in range(14):
        garage.box("Slat underside", 0, -.778 + .117 * i, 1.69, .026, .123, "rail", .02)
    garage.box("Header bead", 0, .865, 1.89, .11, .132, "metal", .11)

    clerestory = module(7)
    clerestory.frame(1.82, -.76, .84, 3, "rail")
    for i in range(4):
        clerestory.box("Louvre blade", 0, -.53 + .35 * i, 1.54, .082, .155, "shutter", .10)

    bpy.ops.object.camera_add(location=(0, -24, 0))
    scene.camera = bpy.context.object
    scene.camera.name = "Orthographic atlas"
    scene.camera.rotation_euler = Vector((0, 1, 0)).to_track_quat("-Z", "Y").to_euler()
    scene.camera.data.type = "ORTHO"
    scene.camera.data.ortho_scale = 8
    scene.world = bpy.data.worlds.new("Warm daylight")
    scene.world.use_nodes = True
    scene.world.node_tree.nodes.get("Background").inputs["Strength"].default_value = .53
    for name, where, power, size in (("Soft daylight", (-3.0, -6.5, 4.4), 980, 5.0),
                                       ("Sky bounce", (3.5, -5.5, .3), 390, 6.0)):
        bpy.ops.object.light_add(type="AREA", location=where)
        light = bpy.context.object
        light.name = name
        light.rotation_euler = (-Vector(where)).to_track_quat("-Z", "Y").to_euler()
        light.data.energy = power
        light.data.size = size
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 12
    scene.cycles.use_denoising = True
    scene.view_settings.view_transform = "Standard"
    scene.render.resolution_x, scene.render.resolution_y = 1024, 512
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == "VIEW_3D":
                area.spaces.active.region_3d.view_perspective = "CAMERA"
                area.spaces.active.shading.type = "MATERIAL"
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(blend.resolve()), compress=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rebuild", action="store_true")
    parser.add_argument("--blend", type=Path, default=ROOT / "art/okazaki-facades.blend")
    parser.add_argument("--output", type=Path, default=ROOT / "public/station/facade-atlas.webp")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    if args.rebuild:
        create(args.blend)
    else:
        bpy.ops.wm.open_mainfile(filepath=str(args.blend.resolve()), load_ui=False, use_scripts=False)
    render = bpy.context.scene.render
    render.image_settings.file_format = "WEBP"
    render.image_settings.color_mode = "RGBA"
    render.image_settings.quality = 89
    render.filepath = str(args.output.resolve())
    bpy.ops.render.render(write_still=True)
