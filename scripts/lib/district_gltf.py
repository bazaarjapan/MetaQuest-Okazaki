"""Pack a Blender-exported, static, vertex-coloured tile using glTF's GPU-native KHR_mesh_quantization."""

import json
import struct

import numpy as np


def scene_extents(nodes, mesh_node, positions):
    """Apply the exported node hierarchy, including the GPU dequantization scale."""
    parent = {child: i for i, node in enumerate(nodes) for child in node.get("children", [])}
    points = positions.astype(float)
    index = mesh_node
    while index is not None:
        node = nodes[index]
        if "matrix" in node:
            matrix = np.array(node["matrix"]).reshape(4, 4).T
            points = points @ matrix[:3, :3].T + matrix[:3, 3]
        else:
            points *= node.get("scale", [1, 1, 1])
            if "rotation" in node:
                q = np.array(node["rotation"])
                twice = 2 * np.cross(q[:3], points)
                points += q[3] * twice + np.cross(q[:3], twice)
            points += node.get("translation", [0, 0, 0])
        index = parent.get(index)
    return points.min(axis=0), points.max(axis=0)


def pack_glb(raw):
    text_length = struct.unpack_from("<I", raw, 12)[0]
    doc = json.loads(raw[20 : 20 + text_length])
    data = memoryview(raw)[28 + text_length :]
    if len(doc["meshes"]) != 1 or len(doc["meshes"][0]["primitives"]) != 1:
        raise ValueError("Keep each district cell a single vertex-painted mesh using one material.")
    prim = doc["meshes"][0]["primitives"][0]
    if set(prim["attributes"]) != {"POSITION", "NORMAL", "COLOR_0", "TEXCOORD_0"}:
        raise ValueError("Expected positions, normals, Paint and exactly one Finish UV layer.")

    def read(index):
        accessor = doc["accessors"][index]
        view = doc["bufferViews"][accessor["bufferView"]]
        dtype = {5121: "u1", 5123: "<u2", 5125: "<u4", 5126: "<f4"}[accessor["componentType"]]
        channels = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[accessor["type"]]
        item = np.dtype(dtype).itemsize
        return np.ndarray(
            (accessor["count"], channels),
            dtype=dtype,
            buffer=data,
            offset=view.get("byteOffset", 0) + accessor.get("byteOffset", 0),
            strides=(view.get("byteStride", channels * item), item),
        )

    attr = prim["attributes"]
    # 1/64 m steps are exact in binary, including at every 250 m tile boundary.
    pos = np.rint(read(attr["POSITION"]) * 64)
    if pos.min() < -32768 or pos.max() > 32767:
        raise ValueError("The authored district moved outside the supported local range.")
    normal = np.rint(np.clip(read(attr["NORMAL"]), -1, 1) * 127)
    colors = read(attr["COLOR_0"])
    if colors.dtype.kind == "u":
        colors = colors / np.iinfo(colors.dtype).max
    colors = np.rint(np.clip(colors[:, :3], 0, 1) * 255)
    finish = read(attr["TEXCOORD_0"])
    classes = np.floor(finish[:, 0] * 6)
    if np.any((classes < 0) | (classes > 5)) or not np.isfinite(finish).all() or np.any((finish < 0) | (finish > 1)):
        raise ValueError("Finish UV must use the authored surface class and rotation in [0, 1].")
    finish = np.rint(finish * 65535).astype("<u2")
    # Each vertex attribute starts at a four-byte boundary for WebGL.
    packed = np.zeros((len(pos), 20), dtype="u1")
    packed[:, :6] = pos.astype("<i2").view("u1").reshape(-1, 6)
    packed[:, 8:11] = normal.astype("i1").view("u1")
    packed[:, 12:15] = colors.astype("u1")
    packed[:, 16:20] = finish.view("u1").reshape(-1, 4)
    unique, remap = np.unique(packed, axis=0, return_inverse=True)
    tri = remap[read(prim["indices"]).reshape(-1, 3)]
    xyz = unique[:, :6].copy().view("<i2").reshape(-1, 3).astype("i8")
    a, b, c = (xyz[tri[:, i]] for i in range(3))
    tri = tri[np.any(np.cross(b - a, c - a) != 0, axis=1)]
    used, indices = np.unique(tri.ravel(), return_inverse=True)
    vertices = unique[used]
    xyz = xyz[used]
    component = 5123 if len(used) <= 65535 else 5125
    indices = indices.astype("<u2" if component == 5123 else "<u4")
    vertex_data = vertices.tobytes()
    index_data = indices.tobytes()
    size = len(vertex_data) + len(index_data)
    binary = vertex_data + index_data + bytes((-size) % 4)
    doc["bufferViews"] = [
        {"buffer": 0, "byteLength": len(vertex_data), "byteStride": 20, "target": 34962},
        {"buffer": 0, "byteOffset": len(vertex_data), "byteLength": len(index_data), "target": 34963},
    ]
    vertex = {"bufferView": 0, "count": len(used), "type": "VEC3"}
    doc["accessors"] = [
        dict(vertex, componentType=5122, min=xyz.min(axis=0).tolist(), max=xyz.max(axis=0).tolist()),
        dict(vertex, componentType=5120, byteOffset=8, normalized=True),
        dict(vertex, componentType=5121, byteOffset=12, normalized=True),
        dict(vertex, type="VEC2", componentType=5123, byteOffset=16, normalized=True),
        {"bufferView": 1, "count": int(indices.size), "type": "SCALAR", "componentType": component},
    ]
    doc["buffers"] = [{"byteLength": size}]
    prim["attributes"] = {"POSITION": 0, "NORMAL": 1, "COLOR_0": 2, "TEXCOORD_0": 3}
    prim["indices"] = 4
    prim["material"] = 0
    doc["materials"] = [{"name": "Okazaki neighbourhood", "pbrMetallicRoughness": {
        "metallicFactor": 0, "roughnessFactor": 0.88,
    }}]
    mesh_node = next(i for i, n in enumerate(doc["nodes"]) if n.get("mesh") == 0)
    node = doc["nodes"][mesh_node]
    if "matrix" in node:
        matrix = node["matrix"]
        matrix[:12] = [v / 64 for v in matrix[:12]]
    else:
        node["scale"] = [v / 64 for v in node.get("scale", [1, 1, 1])]
    for key in ("extensionsUsed", "extensionsRequired"):
        doc[key] = sorted(set(doc.get(key, [])) | {"KHR_mesh_quantization"})
    text = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf8")
    text += b" " * ((-len(text)) % 4)
    header = b"glTF" + struct.pack("<II", 2, 28 + len(text) + len(binary))
    packed_glb = (
        header
        + struct.pack("<I4s", len(text), b"JSON")
        + text
        + struct.pack("<I4s", len(binary), b"BIN\0")
        + binary
    )
    return packed_glb, int(len(tri)), scene_extents(doc["nodes"], mesh_node, xyz)
