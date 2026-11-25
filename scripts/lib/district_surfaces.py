"""Editable finishes and the shared, tileable weathering map used by the web viewer."""

import math
import struct
import zlib

import bpy
import numpy as np


# These indices are also used by src/district-surfaces.js. Keep numeric values
# in the Finish UV layer so each exported tile can remain one opaque primitive.
PLAIN, CERAMIC, METAL, MEMBRANE, WALL, GLASS = range(6)


def finish(kind, axis=(1, 0)):
    return ((kind + 0.5) / 6, math.atan2(axis[1], axis[0]) / math.tau % 1)


def weathering_map():
    size = 256
    rng = np.random.default_rng(20261125)

    def noise(cols, rows):
        lattice = rng.random((rows, cols))
        y, x = np.mgrid[:size, :size] * np.array([rows, cols])[:, None, None] / size
        i, j = y.astype(int), x.astype(int)
        u, v = x - j, y - i
        u, v = u * u * (3 - 2 * u), v * v * (3 - 2 * v)
        lower = lattice[i, j] * (1 - u) + lattice[i, (j + 1) % cols] * u
        upper = lattice[(i + 1) % rows, j] * (1 - u) + lattice[(i + 1) % rows, (j + 1) % cols] * u
        return lower * (1 - v) + upper * v

    channels = np.stack(
        [noise(8, 8) * 0.7 + noise(23, 23) * 0.3, noise(96, 96), noise(20, 20), 0.25 + 0.75 * noise(38, 4)],
        axis=-1,
    )
    pixels = np.rint(255 * channels).astype("u1")

    def chunk(name, payload):
        return struct.pack(">I", len(payload)) + name + payload + struct.pack(">I", zlib.crc32(name + payload))

    image = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    rows = b"".join(b"\x00" + row.tobytes() for row in pixels)
    return image + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b"")


def make_material(image_path):
    material = bpy.data.materials.new("Okazaki · painted surfaces and weathering")
    material.use_nodes = True
    material.use_backface_culling = True
    nodes, links = material.node_tree.nodes, material.node_tree.links
    shader = nodes.get("Principled BSDF")
    paint = nodes.new("ShaderNodeVertexColor")
    paint.layer_name = "Paint"

    def wire(value, socket):
        if isinstance(value, (int, float)):
            socket.default_value = value
        else:
            links.new(value, socket)

    def math_node(op, *values):
        node = nodes.new("ShaderNodeMath")
        node.operation = op
        for i, value in enumerate(values):
            wire(value, node.inputs[i])
        return node.outputs[0]

    def separate(vector):
        node = nodes.new("ShaderNodeSeparateXYZ")
        links.new(vector, node.inputs["Vector"])
        return node.outputs

    def seam(coordinate, spacing, width):
        period = math_node("MULTIPLY", coordinate, 1 / spacing)
        nearest = math_node("PINGPONG", math_node("ABSOLUTE", period), 0.5)
        return math_node("LESS_THAN", nearest, width)

    finish_uv = nodes.new("ShaderNodeUVMap")
    finish_uv.uv_map = "Finish"
    uv = separate(finish_uv.outputs["UV"])
    kind = math_node("FLOOR", math_node("MULTIPLY", uv["X"], 6))
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = bpy.data.images.load(str(image_path))
    texture.image.name = "Okazaki weathering · shared map"
    texture.image.colorspace_settings.name = "Non-Color"
    texture.image.pack()
    texture.image.filepath = "//surfaces.png"
    geometry = nodes.new("ShaderNodeNewGeometry")
    bearing = nodes.new("ShaderNodeVectorRotate")
    bearing.rotation_type = "Z_AXIS"
    links.new(geometry.outputs["Position"], bearing.inputs["Vector"])
    links.new(math_node("MULTIPLY", uv["Y"], math.tau), bearing.inputs["Angle"])
    aligned = separate(bearing.outputs["Vector"])
    coordinate = nodes.new("ShaderNodeVectorMath")
    coordinate.operation = "SCALE"
    coordinate.inputs["Scale"].default_value = 0.28
    links.new(geometry.outputs["Position"], coordinate.inputs[0])
    links.new(coordinate.outputs["Vector"], texture.inputs["Vector"])

    # Authoring preview of the same material families, including a subtle
    # bump in Blender. The web uses distance-filtered seams and no bump map.
    joints = 0
    gloss = 0
    for surface, pattern, change in (
        (CERAMIC, seam(aligned["Y"], 0.30, 0.07), 0.24),
        (METAL, seam(aligned["X"], 0.42, 0.06), 0.36),
        (MEMBRANE, math_node("MAXIMUM", seam(aligned["X"], 1.5, 0.015), seam(aligned["Y"], 1.5, 0.015)), 0.0),
        (WALL, seam(aligned["Z"], 0.60, 0.020), 0.0),
        (GLASS, seam(aligned["X"], 1.75, 0.020), 0.54),
    ):
        enabled = math_node("COMPARE", kind, surface, 0.1)
        joints = math_node("MULTIPLY_ADD", pattern, enabled, joints)
        gloss = math_node("MULTIPLY_ADD", enabled, change, gloss)
    mix = nodes.new("ShaderNodeMixRGB")
    mix.blend_type = "MULTIPLY"
    links.new(paint.outputs["Color"], mix.inputs[1])
    links.new(texture.outputs["Color"], mix.inputs[2])
    links.new(math_node("MULTIPLY_ADD", joints, 0.17, 0.12), mix.inputs[0])
    links.new(mix.outputs[0], shader.inputs["Base Color"])
    links.new(math_node("SUBTRACT", 0.88, gloss), shader.inputs["Roughness"])
    bump = nodes.new("ShaderNodeBump")
    bump.invert = True
    bump.inputs["Strength"].default_value = 0.19
    bump.inputs["Distance"].default_value = 0.012
    links.new(joints, bump.inputs["Height"])
    links.new(bump.outputs["Normal"], shader.inputs["Normal"])
    return material
