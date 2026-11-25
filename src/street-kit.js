const url = "/station/street-kit.glb";
export const streetKitAsset = Object.freeze({
  bytes: 376520,
  sha256: "7073bd2a56867a0eda6598f7d7783dd40286914eb1c9badab404de41637e0c4e",
  triangles: 4800,
});

export const streetKitParts = Object.freeze([
  "car-kei", "car-van", "train-cab", "train-middle",
  "tree-keyaki", "tree-pine", "tree-riverside", "grass-meadow", "grass-reeds",
  "signal-arm", "signal-lens", "street-light",
]);

export async function parseStreetKit(bytes) {
  const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
  const { scene } = await new GLTFLoader().parseAsync(bytes, "/station/");
  const geometries = new Map(), materials = new Set();
  let triangles = 0;
  try {
    for (const mesh of scene.children) {
      if (!mesh.isMesh || mesh.children.length || !streetKitParts.includes(mesh.name) || geometries.has(mesh.name) ||
          !mesh.geometry.hasAttribute("color") || !mesh.geometry.hasAttribute("normal") ||
          mesh.geometry.groups.length || !mesh.geometry.index || mesh.position.lengthSq() > 0 ||
          mesh.material.transparent || mesh.material.map ||
          !(mesh.quaternion.x === 0 && mesh.quaternion.y === 0 && mesh.quaternion.z === 0 && mesh.quaternion.w === 1) ||
          mesh.scale.toArray().some(v => v !== 1)) {
        throw Error("Expected one opaque, origin-aligned Blender mesh per street prop");
      }
      geometries.set(mesh.name, mesh.geometry);
      triangles += mesh.geometry.index.count / 3;
    }
    if (geometries.size !== streetKitParts.length || triangles !== streetKitAsset.triangles) {
      throw Error("Incomplete street kit");
    }
    return geometries;
  } catch (error) {
    scene.traverse(mesh => { if (mesh.isMesh) mesh.geometry.dispose(); });
    throw error;
  } finally {
    scene.traverse(mesh => { if (mesh.isMesh) materials.add(mesh.material); });
    for (const material of materials) material.dispose();
  }
}

export function createStreetKitLoader(onReady, fetchImpl = fetch) {
  let status = "idle", retryAt = 0;
  return {
    update(enabled, time) {
      if (!enabled || status === "ready" || status === "loading" || time < retryAt) return;
      status = "loading";
      void (async () => {
        try {
          const response = await fetchImpl(url + "?v=" + streetKitAsset.sha256, {
            credentials: "same-origin", redirect: "error", signal: AbortSignal.timeout(15000),
          });
          if (!response.ok) throw Error("Street kit is unavailable");
          const bytes = await response.arrayBuffer();
          if (bytes.byteLength !== streetKitAsset.bytes) throw Error("Street kit size mismatch");
          const raw = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
          const hash = Array.from(raw, v => v.toString(16).padStart(2, "0")).join("");
          if (hash !== streetKitAsset.sha256) throw Error("Street kit hash mismatch");
          onReady(await parseStreetKit(bytes));
          status = "ready";
        } catch {
          status = "unavailable";
          retryAt = time + 15000;
        }
      })();
    },
    getStatus: () => status,
  };
}
