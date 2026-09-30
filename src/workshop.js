import { parseSTL, normalizeSTLPositions, STL_LIMITS } from "./stl-model.js";
import { validatePlacement } from "./placement.js";
import "./workshop.css";

const MAX_OBJECTS = 10, MAX_TOTAL_TRIANGLES = 100000;
const degrees = (r) => r * 180 / Math.PI;
const radians = (d) => d * Math.PI / 180;
function explainError(error) {
  const message = typeof error === "string" ? error : error?.message ?? "";
  if (/overlaps/.test(message)) return "元の建物や占有部分に重なっています。別の場所を選んでください。";
  if (/outside the editable region/.test(message)) return "駅周辺の配置範囲からはみ出しています。";
  if (/terrain|terrain contact/.test(message)) return "作品の下全体の実地形を確認できません。駅周辺の別の場所を選んでください。";
  if (/dimensions/.test(message)) return "作品の大きさは各方向100mまでです。縮尺を小さくしてください。";
  if (/complex/.test(message)) return "形状が複雑すぎて安全に配置を確認できません。簡略化したSTLを使ってください。";
  if (/triangles/.test(message)) return "STLは1〜2万三角形までです。形状を簡略化して書き出してください。";
  if (/6 MiB/.test(message)) return "STLは6MiBまでです。ファイルを小さくしてください。";
  if (/degenerate/.test(message)) return "STLに面積のない三角形があります。CADで形状を修復してください。";
  if (/STL|surface|coordinate/.test(message)) return "STLの形式や座標が不正です。CADからSTLを書き出し直してください。";
  return message;
}

// Imported creations are a separate layer. No source city geometry is changed.
export function createWorkshop(THREE, { scene, domElement, camera,
  getEnvironment, getViewPosition, onChange = () => {} }) {
  const group = new THREE.Group();
  group.name = "student-creations"; scene.add(group);
  const dialog = document.querySelector("#workshop-dialog");
  const q = (id) => dialog.querySelector(`#${id}`);
  const objects = new Map();
  let selected = null, picking = false, busy = false;
  const ray = new THREE.Raycaster();
  const setMessage = (text) => { q("workshop-status").textContent = text; };
  const fields = ["x", "z", "scale", "rx", "ry", "rz"];
  const current = () => objects.get(selected);
  const publicObject = (item) => ({ id: item.id, name: item.name,
    ownerId: item.ownerId, assetId: item.assetId ?? null, upAxis: item.upAxis,
    position: [...item.position], rotation: [...item.rotation], scale: [...item.scale],
    triangles: item.triangles, committed: item.committed, valid: item.valid });

  function renderList() {
    const select = q("workshop-list"); select.replaceChildren();
    for (const item of objects.values()) {
      select.append(new Option(`${item.committed ? "✓" : "下書き"} ${item.name}`, item.id));
    }
    if (selected) select.value = selected;
    const item = current();
    for (const field of fields) q(`object-${field}`).disabled = !item;
    q("object-pick").disabled = !item;
    q("object-remove").disabled = !item;
    q("object-apply").disabled = !item?.valid;
    if (!item) return;
    q("object-x").value = item.position[0].toFixed(2);
    q("object-z").value = item.position[2].toFixed(2);
    q("object-scale").value = Number(item.scale[0].toPrecision(7));
    ["rx", "ry", "rz"].forEach((field, i) => {
      q(`object-${field}`).value = degrees(item.rotation[i]).toFixed(1);
    });
    q("object-y").textContent = `底面の標高 ${item.position[1].toFixed(2)} m · ${item.triangles.toLocaleString()}三角形`;
  }

  function preview(item, { position = item.position, rotation = item.rotation,
    scale = item.scale } = {}) {
    // Do not write a rejected transform to a GPU matrix: finite JS numbers
    // such as 1e308 overflow Float32 even before they become NaN/Infinity.
    const safeTransform = position.every((v) => Number.isFinite(v) && Math.abs(v) <= 1e7) &&
      rotation.every((v) => Number.isFinite(v) && Math.abs(v) <= Math.PI * 100) &&
      scale.every((v) => Number.isFinite(v) && v >= 1e-6 && v <= 100);
    if (!safeTransform) {
      item.valid = false; item.committed = false;
      item.mesh.material.color.set("#dc584e");
      setMessage("値が範囲外です。縮尺は0.000001〜100、回転は±18000°以内で指定してください。");
      renderList(); onChange(); return { valid: false };
    }
    const result = validatePlacement({ positions: item.positions, position, rotation, scale },
      getEnvironment());
    // Invalid drafts remain visibly red; they are never committed to the world.
    item.position = result.position ?? [...position];
    item.rotation = [...rotation]; item.scale = [...scale]; item.valid = result.valid;
    item.committed = false;
    item.mesh.position.fromArray(item.position);
    item.mesh.rotation.set(...item.rotation, "XYZ");
    item.mesh.scale.fromArray(item.scale);
    item.mesh.material.color.set(item.valid ? "#37a693" : "#dc584e");
    item.mesh.material.opacity = item.valid ? 0.8 : 0.45;
    item.mesh.material.transparent = true;
    item.mesh.updateMatrixWorld(true);
    setMessage(item.valid ? "配置できます。「配置を確定」を押してください。" :
      `配置できません：${explainError(result.error) || "地形を確認できません"}`);
    renderList(); onChange(); return result;
  }

  async function importFiles(files) {
    if (busy) return;
    busy = true; q("stl-files").disabled = true;
    let imported = 0;
    try {
      for (const file of files) {
        if (objects.size >= MAX_OBJECTS) throw new Error(`作品は最大${MAX_OBJECTS}個です。`);
        if (!/\.stl$/i.test(file.name)) throw new Error("STLファイルを選んでください。");
        if (file.size > STL_LIMITS.maxBytes) throw new Error("STLのファイルサイズが上限を超えています。");
        const buffer = await file.arrayBuffer();
        const parsed = parseSTL(buffer);
        const total = [...objects.values()].reduce((sum, item) => sum + item.triangles, 0);
        if (total + parsed.triangles > MAX_TOTAL_TRIANGLES) throw new Error("作品全体は10万三角形までです。不要な作品を削除してください。");
        const upAxis = q("stl-up").value;
        const normalized = normalizeSTLPositions(parsed.positions, upAxis);
        const positions = normalized.positions;
        const extent = Math.max(...normalized.bounds.max.map((v, i) => v - normalized.bounds.min[i]));
        const units = q("stl-units").value;
        const factor = units === "mm" ? 0.001 : units === "m" ? 1 : 10 / extent;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        geometry.computeVertexNormals(); geometry.computeBoundingSphere(); geometry.computeBoundingBox();
        const material = new THREE.MeshStandardMaterial({ color: "#37a693", roughness: 0.85,
          side: THREE.DoubleSide });
        const mesh = new THREE.Mesh(geometry, material); mesh.castShadow = mesh.receiveShadow = true;
        const point = getViewPosition();
        const bounds = getEnvironment().bounds;
        const seed = [Math.max(bounds[0] + 10, Math.min(bounds[2] - 10, point.x)), 0,
          Math.max(bounds[1] + 10, Math.min(bounds[3] - 10, point.z))];
        const item = { id: crypto.randomUUID(), name: file.name.slice(0, 100), ownerId: "local",
          positions, source: buffer, upAxis, triangles: parsed.triangles, mesh,
          position: seed, rotation: [0, 0, 0], scale: [factor, factor, factor],
          committed: false, valid: false };
        mesh.name = `creation-${item.id}`; mesh.userData.creationId = item.id;
        group.add(mesh); objects.set(item.id, item); selected = item.id;
        preview(item); imported++;
      }
    } catch (error) { setMessage(`${imported ? `${imported}個を読み込みました。` : ""}${explainError(error)}`); }
    finally { busy = false; q("stl-files").disabled = false; q("stl-files").value = ""; }
  }

  q("stl-files").addEventListener("change", (event) => importFiles([...event.target.files]));
  q("workshop-list").addEventListener("change", (event) => {
    selected = event.target.value; renderList();
    const item = current();
    if (item) setMessage(item.committed ? "配置済み。値を変えると再び下書きになります。" : "下書きの配置を調整してください。");
  });
  for (const field of fields) q(`object-${field}`).addEventListener("change", () => {
    const item = current(); if (!item) return;
    const values = Object.fromEntries(fields.map((name) => [name, q(`object-${name}`).valueAsNumber]));
    if (!Object.values(values).every(Number.isFinite)) { setMessage("数値を入力してください。"); renderList(); return; }
    preview(item, { position: [values.x, item.position[1], values.z],
      rotation: [values.rx, values.ry, values.rz].map(radians),
      scale: [values.scale, values.scale, values.scale] });
  });
  q("object-apply").onclick = () => {
    const item = current(); if (!item) return;
    if (!preview(item).valid) return;
    item.committed = true;
    item.mesh.material.transparent = false; item.mesh.material.opacity = 1;
    setMessage("この端末の体験に配置しました。クラウド保存・他の人との共有はまだありません。");
    renderList(); onChange();
  };
  q("object-remove").onclick = () => {
    const item = current(); if (!item) return;
    group.remove(item.mesh); item.mesh.geometry.dispose(); item.mesh.material.dispose();
    objects.delete(item.id); selected = objects.keys().next().value ?? null;
    renderList(); setMessage("選んだ作品を削除しました（元のSTLファイルは削除していません）。"); onChange();
  };
  q("object-pick").onclick = () => {
    if (!current()) return;
    picking = true; dialog.close();
    document.querySelector("#canvas-hint").textContent = "地面をクリックして作品の配置場所を選択（Escで取消）";
    domElement.style.cursor = "crosshair";
  };
  const stopPick = () => { picking = false; domElement.style.cursor = "";
    document.querySelector("#canvas-hint").textContent = "ドラッグで回転 · ホイールで拡大"; };
  domElement.addEventListener("click", (event) => {
    if (!picking || !current()) return;
    const rect = domElement.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1,
      -(event.clientY - rect.top) / rect.height * 2 + 1), camera);
    const terrainMeshes = getEnvironment().terrainMeshes ?? [];
    const hit = ray.intersectObjects(terrainMeshes, false)[0];
    stopPick(); dialog.showModal();
    if (!hit) { setMessage("駅周辺の実地面を選んでください。広域・空・建物は配置対象外です。"); return; }
    preview(current(), { position: [hit.point.x, hit.point.y, hit.point.z] });
  });
  window.addEventListener("keydown", (event) => { if (event.code === "Escape" && picking) { stopPick(); dialog.showModal(); } });
  q("workshop-close").onclick = () => dialog.close();
  document.querySelector("#open-workshop").onclick = () => {
    stopPick(); renderList(); dialog.showModal();
  };
  renderList();
  return { group, importFiles,
    getState: () => ({ busy, picking, selected, count: objects.size,
      committed: [...objects.values()].filter((item) => item.committed).length,
      triangles: [...objects.values()].reduce((sum, item) => sum + item.triangles, 0),
      objects: [...objects.values()].map(publicObject),
      message: q("workshop-status").textContent, storage: "current-page-only" }) };
}
