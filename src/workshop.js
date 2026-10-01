import { parseSTL, normalizeSTLPositions, STL_LIMITS } from "./stl-model.js";
import { validatePlacement } from "./placement.js";
import { workshopAccess, canEditWorkshopObject, createWorkshopScope, safeWorkshopTransform,
  sharedObjectOverlap } from "./workshop-access.js";
import "./workshop.css";

const MAX_ASSETS = 10, MAX_WORLD_TRIANGLES = 200000, MAX_CACHE_TRIANGLES = 220000;
const degrees = (r) => r * 180 / Math.PI;
const radians = (d) => d * Math.PI / 180;
function explainError(error) {
  const message = typeof error === "string" ? error : error?.code ?? error?.message ?? "";
  if (/login|session|unauth/.test(message)) return "ログインし直してください。";
  if (/stale_revision|conflict/.test(message)) return "他の人の変更と競合しました。最新のワールドで位置を確認し、もう一度確定してください。";
  if (/owner/.test(message)) return "変更できるのは自分の作品だけです。";
  if (/overlap/.test(message)) return "元の建物や他の作品に重なっています。別の場所を選んでください。";
  if (/asset_limit|quota/.test(message)) return "自分のSTLはワールドごとに10個・合計25MiBまでです。";
  if (/world_triangle_limit/.test(message)) return "ワールド全体の作品は20万三角形までです。";
  if (/world_object_limit/.test(message)) return "ワールドの作品数が上限に達しています。";
  if (/disconnected|connection/.test(message)) return "共同ワールドに接続してから操作してください。";
  if (/outside the editable region/.test(message)) return "駅周辺の配置範囲からはみ出しています。";
  if (/terrain|terrain contact/.test(message)) return "作品の下全体の実地形を確認できません。駅周辺の別の場所を選んでください。";
  if (/dimensions/.test(message)) return "作品の大きさは各方向100mまでです。縮尺を小さくしてください。";
  if (/complex/.test(message)) return "形状が複雑すぎて安全に配置を確認できません。簡略化したSTLを使ってください。";
  if (/triangles/.test(message)) return "STLは1〜2万三角形までです。形状を簡略化してください。";
  if (/6 MiB|size limit/.test(message)) return "STLは6MiBまでです。ファイルを小さくしてください。";
  if (/degenerate/.test(message)) return "STLに面積のない三角形があります。CADで形状を修復してください。";
  if (/hash|metadata/.test(message)) return "保存されたSTLの整合性を確認できません。再読込してください。";
  if (/STL|surface|coordinate/.test(message)) return "STLの形式や座標が不正です。CADから書き出し直してください。";
  return message || "処理できませんでした。接続を確認して再試行してください。";
}
function validAsset(asset) {
  return asset && typeof asset.id === "string" && typeof asset.ownerId === "string" &&
    ["y", "z"].includes(asset.upAxis) && ["m", "mm", "fit10"].includes(asset.units) &&
    Number.isInteger(asset.bytes) && asset.bytes > 0 && asset.bytes <= STL_LIMITS.maxBytes &&
    Number.isInteger(asset.triangles) && asset.triangles > 0 && asset.triangles <= STL_LIMITS.maxTriangles &&
    /^[a-f0-9]{64}$/.test(asset.sha256);
}
const assetKey = (asset) => `${asset.id}:${asset.sha256}:${asset.upAxis}:${asset.units}`;
const objectKey = (object) => JSON.stringify([object.assetId, object.position, object.rotation, object.scale]);
async function digest(buffer) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", buffer))].map((v) => v.toString(16).padStart(2, "0")).join("");
}

// Preserve source PLATEAU; committed server meshes and a separate local draft
// live in this group. Drafts never silently replace the authoritative world.
export function createWorkshop(THREE, { scene, domElement, camera, schoolClient,
  getEnvironment, getViewPosition, onChange = () => {}, onRequireLogin = () => {},
  isXR = () => false }) {
  const group = new THREE.Group(); group.name = "student-creations"; scene.add(group);
  const dialog = document.querySelector("#workshop-dialog");
  const q = (id) => dialog.querySelector(`#${id}`);
  const fields = ["x", "z", "scale", "rx", "ry", "rz"];
  const remote = new Map(), models = new Map(), loading = new Map(), failures = new Map();
  const scope = createWorkshopScope(), ray = new THREE.Raycaster();
  let state = schoolClient?.getState() ?? {}, selected = null, draft = null;
  let picking = false, operation = null, activeLoads = 0, message = "ログインして共同ワールドに参加すると作品を配置できます。";
  let syncScheduled = false, destroyed = false;
  const access = () => workshopAccess(state);
  const busy = () => operation !== null;
  const ownAssets = () => (state.assets ?? []).filter((asset) => validAsset(asset) && asset.ownerId === access().userId);
  const selectedItem = () => draft?.id === selected ? draft : remote.get(selected);
  const setMessage = (text) => { message = text; q("workshop-status").textContent = text; onChange(); };

  const library = document.createElement("div"); library.className = "workshop-library";
  const label = document.createElement("label"); label.textContent = "クラウドに保存済みの自分のSTL";
  const librarySelect = document.createElement("select"); librarySelect.id = "workshop-assets"; librarySelect.setAttribute("aria-label", "保存済みの自分のSTL");
  label.append(librarySelect); library.append(label);
  const reuse = document.createElement("button"); reuse.id = "object-reuse"; reuse.textContent = "選んだSTLを新しく配置"; library.append(reuse);
  q("workshop-list").parentElement.before(library);
  const cancel = document.createElement("button"); cancel.id = "object-cancel"; cancel.textContent = "下書きを取り消す";
  const retry = document.createElement("button"); retry.id = "object-retry"; retry.textContent = "表示できない作品を再読込";
  q("object-remove").after(cancel, retry);

  function requireAccess(prompt = true) {
    if (access().canEdit && !destroyed) return true;
    setMessage(!access().userId ? "作品の配置・編集にはGoogleログインが必要です。閲覧とVR体験はログインなしで利用できます。" :
      "共同ワールドに参加し、接続が完了してから作品を配置してください。");
    if (prompt) onRequireLogin(); return false;
  }
  function canChange(item) { return canEditWorkshopObject(state, item); }
  const currentToken = () => scope.capture();
  const accepts = (token) => !destroyed && scope.accepts(token);
  function disposeMesh(mesh) { group.remove(mesh); mesh.material.dispose(); }
  function stopPick() {
    picking = false; domElement.style.cursor = "";
    const hint = document.querySelector("#canvas-hint"); if (hint) hint.textContent = "ドラッグで回転 · ホイールで拡大";
  }
  function clearDraft() { if (draft) disposeMesh(draft.mesh); draft = null; stopPick(); }
  function clearWorld() {
    clearDraft(); for (const item of remote.values()) disposeMesh(item.mesh);
    remote.clear(); selected = null;
    for (const model of models.values()) model.geometry.dispose();
    models.clear();
    for (const task of loading.values()) task.resolve?.(null);
    loading.clear(); failures.clear(); operation = null;
  }
  function publicObject(item) {
    return { id: item.id, name: item.name, ownerId: item.ownerId, assetId: item.assetId,
      upAxis: item.upAxis, position: [...item.position], rotation: [...item.rotation],
      scale: [...item.scale], triangles: item.triangles, committed: item !== draft,
      valid: item === draft ? item.valid : true, editable: canChange(item) };
  }
  function renderList() {
    const select = q("workshop-list"); select.replaceChildren();
    for (const item of remote.values()) select.append(new Option(`${item.ownerId === access().userId ? "自分" : "他の人"} ✓ ${item.name}`, item.id));
    if (draft && !remote.has(draft.id)) select.append(new Option(`下書き ${draft.name}`, draft.id));
    if (selected) select.value = selected;
    const previousAsset = librarySelect.value; librarySelect.replaceChildren();
    for (const asset of ownAssets()) librarySelect.append(new Option(asset.name, asset.id));
    if ([...librarySelect.options].some((option) => option.value === previousAsset)) librarySelect.value = previousAsset;
    const item = selectedItem(), editable = canChange(item) && !busy();
    for (const field of fields) q(`object-${field}`).disabled = !editable;
    for (const id of ["stl-files", "stl-up", "stl-units"]) q(id).disabled = !access().canEdit || busy();
    q("object-pick").disabled = !editable; q("object-remove").disabled = !editable;
    q("object-apply").disabled = !editable || !draft?.valid;
    cancel.disabled = !draft || busy(); reuse.disabled = !access().canEdit || busy() || !ownAssets().length;
    retry.disabled = !access().canEdit || busy() || !failures.size;
    q("workshop-status").textContent = message + (failures.size ? ` ${failures.size}種類のSTLを表示できていません。「再読込」で再試行できます。` : "");
    if (!item) { q("object-y").textContent = "作品を選んでください。配置先は実地形で検証します。"; return; }
    q("object-x").value = item.position[0].toFixed(2); q("object-z").value = item.position[2].toFixed(2);
    q("object-scale").value = Number(item.scale[0].toPrecision(7));
    ["rx", "ry", "rz"].forEach((field, i) => { q(`object-${field}`).value = degrees(item.rotation[i]).toFixed(1); });
    q("object-y").textContent = `底面の標高 ${item.position[1].toFixed(2)} m · ${item.triangles.toLocaleString()}三角形${canChange(item) ? "" : " · 他の人の作品（閲覧のみ）"}`;
  }
  function makeMesh(model, isDraft = false) {
    const material = new THREE.MeshStandardMaterial({ color: isDraft ? "#37a693" : "#488caa", roughness: 0.85,
      side: THREE.DoubleSide, transparent: isDraft, opacity: isDraft ? 0.8 : 1 });
    const mesh = new THREE.Mesh(model.geometry, material); mesh.castShadow = false; mesh.receiveShadow = true;
    group.add(mesh); return mesh;
  }
  function applyTransform(mesh, item) {
    mesh.position.fromArray(item.position); mesh.rotation.set(...item.rotation, "XYZ");
    mesh.scale.fromArray(item.scale); mesh.updateMatrixWorld(true);
  }
  function modelReferences() {
    const ids = new Set((state.objects ?? []).map((object) => object.assetId));
    if (draft) ids.add(draft.assetId); return ids;
  }
  function makeCacheSpace(triangles, keepId) {
    const refs = modelReferences(); refs.add(keepId);
    let total = [...models.values()].reduce((sum, model) => sum + model.triangles, 0);
    for (const [id, model] of models) {
      if (total + triangles <= MAX_CACHE_TRIANGLES) break;
      if (!refs.has(id)) { model.geometry.dispose(); models.delete(id); total -= model.triangles; }
    }
    if (total + triangles > MAX_CACHE_TRIANGLES) throw new Error("ワールドのSTL表示容量を超えています。");
  }
  async function decodeAsset(asset, buffer, token) {
    if (!validAsset(asset) || !(buffer instanceof ArrayBuffer) || buffer.byteLength !== asset.bytes) throw new Error("asset_metadata_invalid");
    if (await digest(buffer) !== asset.sha256) throw new Error("asset_hash_mismatch");
    if (!accepts(token)) return null;
    const parsed = parseSTL(buffer); if (parsed.triangles !== asset.triangles) throw new Error("asset_metadata_invalid");
    const normalized = normalizeSTLPositions(parsed.positions, asset.upAxis);
    const existing = models.get(asset.id); if (existing?.key === assetKey(asset)) return existing;
    makeCacheSpace(parsed.triangles, asset.id);
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", new THREE.BufferAttribute(normalized.positions, 3));
    geometry.computeVertexNormals(); geometry.computeBoundingSphere(); geometry.computeBoundingBox();
    const model = { key: assetKey(asset), geometry, positions: normalized.positions, bounds: normalized.bounds, triangles: parsed.triangles };
    models.set(asset.id, model); failures.delete(asset.id); return model;
  }
  function scheduleSync() {
    if (syncScheduled || destroyed) return; syncScheduled = true;
    queueMicrotask(() => { syncScheduled = false; if (!destroyed) { syncObjects(); pumpDownloads(); renderList(); onChange(); } });
  }
  function queueAsset(asset) {
    if (!validAsset(asset) || models.get(asset.id)?.key === assetKey(asset) || loading.has(asset.id) || failures.has(asset.id)) return;
    loading.set(asset.id, { asset, token: currentToken(), started: false, resolve: null });
  }
  function pumpDownloads() {
    if (!access().canEdit) return;
    for (const [id, task] of loading) {
      if (activeLoads >= 2) break;
      if (task.started || !accepts(task.token)) continue;
      task.started = true; activeLoads++;
      Promise.resolve().then(() => accepts(task.token) ? schoolClient.downloadAsset(id) : null)
        .then((buffer) => buffer && accepts(task.token) ? decodeAsset(task.asset, buffer, task.token) : null)
        .catch((error) => { if (accepts(task.token)) { failures.set(id, explainError(error)); setMessage(`「${task.asset.name}」の表示に失敗しました：${explainError(error)}`); } })
        .finally(() => {
          activeLoads--; if (loading.get(id) === task) loading.delete(id);
          task.resolve?.(accepts(task.token) ? models.get(id) ?? null : null); scheduleSync();
        });
    }
  }
  async function ensureModel(asset, token) {
    const model = models.get(asset.id); if (model?.key === assetKey(asset)) return model;
    failures.delete(asset.id); queueAsset(asset);
    const task = loading.get(asset.id); if (!task) throw new Error("asset_metadata_invalid");
    // All model loads use the same bounded two-download queue.
    const wait = new Promise((resolve) => {
      const previous = task.resolve; task.resolve = (result) => { previous?.(result); resolve(result); };
    });
    pumpDownloads(); const result = await wait;
    if (!accepts(token)) return null;
    if (!result) throw new Error(failures.get(asset.id) ?? "STLの読み込みに失敗しました。"); return result;
  }
  function syncObjects() {
    if (!access().canEdit) return;
    const entries = state.objects ?? [], assets = new Map((state.assets ?? []).filter(validAsset).map((asset) => [asset.id, asset]));
    if (entries.length > 120 || entries.reduce((sum, object) => sum + (object.triangles ?? MAX_WORLD_TRIANGLES + 1), 0) > MAX_WORLD_TRIANGLES) {
      setMessage("ワールドの作品数・形状が表示上限を超えています。再接続してください。"); return;
    }
    const ids = new Set(entries.map((object) => object.id));
    for (const [id, item] of remote) if (!ids.has(id)) { disposeMesh(item.mesh); remote.delete(id); }
    if (draft?.baseId) {
      const authoritative = entries.find((object) => object.id === draft.baseId);
      if (!authoritative || objectKey(authoritative) !== draft.baseKey) {
        clearDraft(); setMessage("ワールドの復元・変更に合わせて下書きを取り消しました。最新の作品を選び直してください。");
      }
    }
    for (const object of entries) {
      const asset = assets.get(object.assetId);
      if (!asset || asset.ownerId !== object.ownerId || !safeWorkshopTransform(object)) continue;
      queueAsset(asset); const model = models.get(asset.id); if (!model || model.key !== assetKey(asset)) continue;
      let item = remote.get(object.id);
      if (item && item.assetId !== object.assetId) { disposeMesh(item.mesh); remote.delete(item.id); item = null; }
      if (!item) { item = { mesh: makeMesh(model) }; remote.set(object.id, item); }
      Object.assign(item, object, { name: typeof object.name === "string" ? object.name : asset.name, upAxis: asset.upAxis, positions: model.positions });
      item.mesh.name = `creation-${object.id}`; item.mesh.userData.creationId = object.id; item.mesh.userData.ownerId = object.ownerId;
      applyTransform(item.mesh, object);
    }
    if (selected && !remote.has(selected) && draft?.id !== selected) selected = null;
    makeCacheSpace(0, null);
  }
  function onState(next, event = "state") {
    state = next ?? schoolClient?.getState() ?? {};
    const status = scope.update(state);
    if (status.changed) {
      clearWorld(); if (dialog.open && !status.canEdit) dialog.close();
      message = status.canEdit ? "自分のSTLを読み込むか、保存済みのSTLを選んで配置してください。" :
        "作品の配置・編集にはログインと共同ワールドへの接続が必要です。VRで街を見るだけならログイン不要です。";
    }
    // Hundreds of peer poses per second must not rebuild every STL mesh/list.
    if (status.changed || !["pose", "participants", "worlds"].includes(event)) scheduleSync();
  }
  function seedPosition() {
    const point = getViewPosition(), bounds = getEnvironment()?.bounds;
    if (!Array.isArray(bounds) || bounds.length !== 4) throw new Error("Verified terrain is unavailable");
    return [Math.max(bounds[0] + 1, Math.min(bounds[2] - 1, point.x)), 0,
      Math.max(bounds[1] + 1, Math.min(bounds[3] - 1, point.z))];
  }
  function createDraft(asset, model) {
    const seed = seedPosition();
    clearDraft();
    const extent = Math.max(...model.bounds.max.map((v, i) => v - model.bounds.min[i]));
    const factor = asset.units === "mm" ? 0.001 : asset.units === "m" ? 1 : 10 / extent;
    const id = crypto.randomUUID();
    draft = { id, ownerId: access().userId, assetId: asset.id, name: asset.name, upAxis: asset.upAxis,
      positions: model.positions, triangles: model.triangles, mesh: makeMesh(model, true),
      position: seed, rotation: [0, 0, 0], scale: [factor, factor, factor], valid: false,
      baseId: null, baseKey: null };
    draft.mesh.userData.creationId = id; draft.mesh.userData.ownerId = draft.ownerId; draft.mesh.userData.isDraft = true;
    selected = id; return previewDraft();
  }
  function beginDraft() {
    if (draft?.id === selected) return draft;
    const item = remote.get(selected); if (!canChange(item)) return null;
    const model = models.get(item.assetId); if (!model) return null;
    clearDraft(); draft = { ...item, mesh: makeMesh(model, true), positions: model.positions,
      position: [...item.position], rotation: [...item.rotation], scale: [...item.scale],
      baseId: item.id, baseKey: objectKey(item), valid: true };
    draft.mesh.userData.creationId = item.id; draft.mesh.userData.ownerId = item.ownerId; draft.mesh.userData.isDraft = true;
    applyTransform(draft.mesh, draft); return draft;
  }
  function previewDraft({ position = draft?.position, rotation = draft?.rotation, scale = draft?.scale } = {}) {
    if (!draft || !requireAccess(false)) return { valid: false };
    if (!safeWorkshopTransform({ position, rotation, scale })) {
      draft.valid = false; draft.mesh.material.color.set("#dc584e");
      setMessage("値が範囲外です。縮尺は0.000001〜100、回転は±18000°以内で指定してください。");
      renderList(); return { valid: false };
    }
    const result = validatePlacement({ positions: draft.positions, position, rotation, scale }, getEnvironment());
    if (result.valid && (state.objects ?? []).some((object) => object.id !== draft.baseId && sharedObjectOverlap(result.bounds, object))) {
      result.valid = false; result.error = "object_overlap";
    }
    draft.position = result.position ?? [...position]; draft.rotation = [...rotation]; draft.scale = [...scale];
    draft.valid = result.valid; draft.bounds = result.bounds; applyTransform(draft.mesh, draft);
    draft.mesh.material.color.set(draft.valid ? "#37a693" : "#dc584e"); draft.mesh.material.opacity = draft.valid ? 0.8 : 0.45;
    setMessage(draft.valid ? "配置できます。「配置を確定」で共同ワールドへ保存します。" : `配置できません：${explainError(result.error)}`);
    renderList(); return result;
  }
  async function importFiles(files) {
    if (!requireAccess() || busy()) return false;
    const token = currentToken(), marker = {}; operation = marker; renderList(); let imported = 0;
    const upAxis = q("stl-up").value, units = q("stl-units").value;
    try {
      for (const file of files) {
        if (!accepts(token)) return false;
        if (ownAssets().length >= MAX_ASSETS) throw new Error("asset_limit");
        if (!/\.stl$/i.test(file.name)) throw new Error("STLファイルを選んでください.");
        if (file.size > STL_LIMITS.maxBytes) throw new Error("STL size limit");
        const buffer = await file.arrayBuffer(); if (!accepts(token)) return false;
        parseSTL(buffer);
        setMessage(`「${file.name}」をクラウドへ保存しています…`);
        const asset = await schoolClient.uploadAsset({ buffer, name: file.name, upAxis, units });
        if (!accepts(token)) return false;
        if (!validAsset(asset) || asset.ownerId !== access().userId) throw new Error("asset_metadata_invalid");
        clearDraft();
        const model = await decodeAsset(asset, buffer, token); if (!accepts(token) || !model) return false;
        createDraft(asset, model); imported++;
      }
      if (imported) setMessage(`${imported}個のSTLをクラウドに保存しました。配置はまだ下書きです。保存済み一覧から何度でも選べます。`);
      return imported > 0;
    } catch (error) { if (accepts(token)) setMessage(`${imported ? `${imported}個を保存しました。` : ""}${explainError(error)}`); return false; }
    finally { if (operation === marker) operation = null; q("stl-files").value = ""; renderList(); onChange(); scheduleSync(); }
  }
  async function useAsset(assetId) {
    if (!requireAccess() || busy()) return false;
    const asset = ownAssets().find((entry) => entry.id === assetId); if (!asset) { setMessage("自分の保存済みSTLを選んでください。"); return false; }
    const token = currentToken(), marker = {}; operation = marker; renderList();
    try {
      clearDraft();
      setMessage(`「${asset.name}」を読み込んでいます…`);
      const model = await ensureModel(asset, token); if (!accepts(token) || !model) return false;
      createDraft(asset, model); return true;
    } catch (error) { if (accepts(token)) setMessage(explainError(error)); return false; }
    finally { if (operation === marker) operation = null; renderList(); onChange(); }
  }
  function selectObject(id) {
    if (!requireAccess() || busy()) return false;
    const item = remote.get(id) ?? (draft?.id === id ? draft : null); if (!item) return false;
    if (selected !== id) clearDraft(); selected = id; renderList();
    setMessage(canChange(item) ? "自分の作品です。変更は下書きになり、確定後に共有されます。" : "他の人の作品です。閲覧できますが編集・削除はできません。"); return true;
  }
  function moveSelected(position) {
    if (!requireAccess() || busy() || !canChange(selectedItem())) return { valid: false };
    if (!beginDraft()) return { valid: false }; return previewDraft({ position });
  }
  function adjustSelected({ axis, radians: amount, rotationAxis, rotationDelta, scaleFactor } = {}) {
    if (!requireAccess() || busy() || !canChange(selectedItem()) || !beginDraft()) return { valid: false };
    const rotation = [...draft.rotation], scale = [...draft.scale];
    const selectedAxis = axis ?? rotationAxis, delta = amount ?? rotationDelta;
    if (selectedAxis !== undefined) {
      const index = ["x", "y", "z"].indexOf(selectedAxis); if (index < 0 || !Number.isFinite(delta)) return { valid: false };
      rotation[index] += delta;
    }
    if (scaleFactor !== undefined) {
      if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) return { valid: false };
      for (let index = 0; index < 3; index++) scale[index] *= scaleFactor;
    }
    return previewDraft({ rotation, scale });
  }
  async function commitSelected() {
    if (!requireAccess() || busy() || !draft || !canChange(draft) || !previewDraft().valid) return false;
    const item = draft, token = currentToken(), marker = {}; operation = marker; renderList();
    try {
      const ack = await schoolClient.editObject(item.baseId ? "object.update" : "object.create", {
        id: item.id, ...(item.baseId ? {} : { assetId: item.assetId }),
        position: [...item.position], rotation: [...item.rotation], scale: [...item.scale] });
      if (!accepts(token)) return false;
      // Only the server broadcast becomes committed, never the local preview.
      if (draft === item) clearDraft(); selected = ack.id ?? item.id;
      syncObjects(); setMessage("サーバーで配置を確定しました。参加者に共有され、次回も同じワールドで再開できます。"); return true;
    } catch (error) { if (accepts(token)) setMessage(`配置は確定していません：${explainError(error)}`); return false; }
    finally { if (operation === marker) operation = null; renderList(); onChange(); }
  }
  async function removeSelected() {
    if (!requireAccess() || busy() || !canChange(selectedItem())) return false;
    if (draft && !draft.baseId) { clearDraft(); selected = null; setMessage("下書きを取り消しました。保存済みSTLは残っています。"); renderList(); return true; }
    const item = remote.get(selected); if (!item) return false;
    const token = currentToken(), marker = {}; operation = marker; renderList();
    try {
      await schoolClient.editObject("object.delete", { id: item.id }); if (!accepts(token)) return false;
      clearDraft(); selected = null; syncObjects(); setMessage("サーバーで作品の配置を削除しました。保存済みSTLや元の街は削除していません。"); return true;
    } catch (error) { if (accepts(token)) setMessage(`削除できませんでした：${explainError(error)}`); return false; }
    finally { if (operation === marker) operation = null; renderList(); onChange(); }
  }
  function cancelDraft() {
    if (!requireAccess() || busy()) return false;
    const baseId = draft?.baseId; clearDraft(); selected = baseId && remote.has(baseId) ? baseId : null;
    setMessage("下書きを取り消しました。サーバー上の確定済み作品は変更していません。"); renderList(); return true;
  }
  async function cycleOwnAsset(direction = 1) {
    if (!requireAccess() || busy()) return false;
    const assets = ownAssets(); if (!assets.length) { setMessage("最初に2D画面の「STL作品」から自分のSTLを読み込んでください。"); return false; }
    const current = assets.findIndex((asset) => asset.id === selectedItem()?.assetId), delta = direction < 0 ? -1 : 1;
    return useAsset(assets[(current < 0 ? 0 : (current + delta + assets.length) % assets.length)].id);
  }
  function retryAssets() {
    if (!requireAccess() || busy()) return false;
    failures.clear(); scheduleSync(); setMessage("表示できなかった作品を再読込しています…"); return true;
  }
  function open() {
    if (!requireAccess()) return false;
    if (isXR()) { setMessage("VRでは作品操作パネルを使ってください。ファイル読み込みは2Dへ戻って行います。"); return false; }
    stopPick(); renderList(); if (!dialog.open) dialog.showModal(); return true;
  }
  q("stl-files").addEventListener("change", (event) => { void importFiles([...event.target.files]); });
  q("workshop-list").addEventListener("change", (event) => selectObject(event.target.value));
  for (const field of fields) q(`object-${field}`).addEventListener("change", () => {
    if (!requireAccess() || busy() || !canChange(selectedItem())) return;
    const values = Object.fromEntries(fields.map((name) => [name, q(`object-${name}`).valueAsNumber]));
    if (!Object.values(values).every(Number.isFinite)) { setMessage("数値を入力してください。"); renderList(); return; }
    if (!beginDraft()) return;
    previewDraft({ position: [values.x, draft.position[1], values.z], rotation: [values.rx, values.ry, values.rz].map(radians), scale: [values.scale, values.scale, values.scale] });
  });
  q("object-apply").onclick = () => { void commitSelected(); }; q("object-remove").onclick = () => { void removeSelected(); };
  reuse.onclick = () => { void useAsset(librarySelect.value); }; cancel.onclick = cancelDraft; retry.onclick = retryAssets;
  q("object-pick").onclick = () => {
    if (!requireAccess() || busy() || !canChange(selectedItem()) || isXR() || !beginDraft()) return;
    picking = true; dialog.close(); domElement.style.cursor = "crosshair";
    const hint = document.querySelector("#canvas-hint"); if (hint) hint.textContent = "実地面をクリックして作品の位置を選択（Escで取消）";
  };
  const onCanvasClick = (event) => {
    if (!picking || !requireAccess(false) || busy() || isXR()) return;
    const rect = domElement.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1,
      -(event.clientY - rect.top) / rect.height * 2 + 1), camera);
    const hit = ray.intersectObjects(getEnvironment().terrainMeshes ?? [], false)[0];
    stopPick(); if (!dialog.open) dialog.showModal();
    if (!hit) { setMessage("駅周辺の実地面を選んでください。広域・空・建物は配置対象外です。"); return; }
    moveSelected([hit.point.x, hit.point.y, hit.point.z]);
  };
  const onEscape = (event) => { if (event.code === "Escape" && picking) { stopPick(); if (requireAccess(false) && !isXR() && !dialog.open) dialog.showModal(); } };
  domElement.addEventListener("click", onCanvasClick); window.addEventListener("keydown", onEscape);
  q("workshop-close").onclick = () => dialog.close(); document.querySelector("#open-workshop").onclick = open;
  const unsubscribe = schoolClient?.subscribe(onState) ?? (() => {});
  onState(schoolClient?.getState() ?? {}); renderList();
  return { group, open, importFiles, selectObject, cycleOwnAsset, moveSelected, adjustSelected,
    commitSelected, removeSelected, cancelDraft, retryAssets,
    getState: () => {
      const objects = [...remote.values()].map((item) => draft?.id === item.id ? publicObject(draft) : publicObject(item));
      if (draft && !remote.has(draft.id)) objects.push(publicObject(draft));
      return { ...access(), busy: busy(), picking, selected, count: objects.length, committed: remote.size,
        triangles: objects.reduce((sum, item) => sum + item.triangles, 0), objects,
        current: selectedItem() ? publicObject(selectedItem()) : null,
        ownAssets: ownAssets().map(({ id, name, triangles }) => ({ id, name, triangles })),
        assetFailures: failures.size, message: q("workshop-status").textContent, storage: "cloud-world" };
    },
    destroy() { destroyed = true; unsubscribe(); clearWorld(); group.removeFromParent(); domElement.removeEventListener("click", onCanvasClick); window.removeEventListener("keydown", onEscape); },
  };
}
