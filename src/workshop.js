import { parseSTL, normalizeSTLPositions, STL_LIMITS } from "./stl-model.js";
import { createFinishGallery } from "./stl-finish-gallery.js";
import { createSTLEditorPreview } from "./stl-editor-preview.js";
import { createSTLThumbnailRenderer } from "./stl-thumbnail.js";
import { validatePlacement } from "./placement.js";
import { workshopAccess, canEditWorkshopObject, createWorkshopScope, safeWorkshopTransform,
  sharedObjectOverlap } from "./workshop-access.js";
import "./workshop.css";
import { stlColor, validSTLColor, describeWorkLocation, validExhibitText, exhibitTitle } from "./workshop-presentation.js";
import { stlFinish, stlSurface, validSTLFinish, validSTLSurface } from "./stl-appearance.js";
import { applySTLFinish } from "./stl-finish-material.js";

const MAX_ASSETS = 10, MAX_WORLD_TRIANGLES = 200000, MAX_CACHE_TRIANGLES = 220000;
const degrees = (r) => r * 180 / Math.PI;
const radians = (d) => d * Math.PI / 180;
function explainError(error) {
  const message = typeof error === "string" ? error : error?.code ?? error?.message ?? "";
  if (/login|session|unauth/.test(message)) return "ログインし直してください。";
  if (/stale_revision|conflict/.test(message)) return "他の人の変更と競合しました。最新のワールドで位置を確認し、もう一度確定してください。";
  if (/owner/.test(message)) return "変更できるのは自分の作品だけです。";
  if (/asset_already_placed/.test(message)) return "このSTLは設置済みです。左長押しで回収してから置き直してください。";
  if (/own_object_limit/.test(message)) return "同時に置ける自分の作品は10点までです。先に回収してください。";
  if (/overlap/.test(message)) return "元の建物や他の作品に重なっています。別の場所を選んでください。";
  if (/asset_limit|quota/.test(message)) return "自分のSTLはワールドごとに10個・合計25MiBまでです。";
  if (/world_triangle_limit/.test(message)) return "ワールド全体の作品は20万三角形までです。";
  if (/world_object_limit/.test(message)) return "ワールドの作品数が上限に達しています。";
  if (/disconnected|connection/.test(message)) return "共同ワールドに接続してから操作してください。";
  if (/placement_source_unavailable/.test(message)) return "地面の標高データを取得できませんでした。STLは手元に残っています。少し待って再度置いてください。";
  if (/still loading/.test(message)) return "周辺の地面と建物を読み込んでいます。近づいて少し待ってください。";
  if (/outside the editable region/.test(message)) return "表示できる岡崎の街の範囲からはみ出しています。";
  if (/terrain|terrain contact/.test(message)) return "作品の下全体の実地形を確認できません。近づいて地面の読み込みを待つか、別の場所を選んでください。";
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
const objectKey = (object) => JSON.stringify([object.assetId, object.position, object.rotation, object.scale, stlColor(object.color), stlFinish(object.finish), stlSurface(object.surface)]);
async function digest(buffer) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", buffer))].map((v) => v.toString(16).padStart(2, "0")).join("");
}

// Preserve source PLATEAU; committed server meshes and a separate local draft
// live in this group. Drafts never silently replace the authoritative world.
export function createWorkshop(THREE, { scene, renderer, domElement, camera, schoolClient,
  getEnvironment, getViewPosition, onChange = () => {}, onRequireLogin = () => {}, onStartPicking = () => {},
  isXR = () => false, getStation = () => null, onLocate = () => false }) {
  const group = new THREE.Group(); group.name = "student-creations"; scene.add(group);
  const dialog = document.querySelector("#workshop-dialog");
  const pickControls = document.querySelector("#ground-pick-controls");
  const pickHint = document.querySelector("#ground-pick-hint");
  const pickCancel = document.querySelector("#ground-pick-cancel");
  const q = (id) => dialog.querySelector(`#${id}`);
  const fields = ["x", "z", "scale", "rx", "ry", "rz"];
  const remote = new Map(), models = new Map(), loading = new Map(), failures = new Map();
  const thumbnails = new Map();
  let thumbnailRenderer, thumbnailQueue = Promise.resolve(), thumbnailRevision = 0;
  const scope = createWorkshopScope(), ray = new THREE.Raycaster();
  let state = schoolClient?.getState() ?? {}, selected = null, draft = null;
  let picking = false, operation = null, activeLoads = 0, message = "ログインして共同ワールドに参加すると作品を配置できます。";
  let syncScheduled = false, destroyed = false;
  let locator = null, locatedId = null;
  let colorSelectionKey = "", exhibitSelectionKey = "";
  let typingScaleFor = null, invalidScaleFor = null;
  let scaleValidationTimer;
  const access = () => workshopAccess(state);
  const busy = () => operation !== null;
  const ownAssets = () => (state.assets ?? []).filter((asset) => validAsset(asset) && asset.ownerId === access().userId);
  const selectedItem = () => draft?.id === selected ? draft : remote.get(selected);
  let messageIsHint = false;
  const setMessage = (text, { coveredByHint = false } = {}) => {
    message = text; messageIsHint = coveredByHint;
    q("workshop-status").hidden = coveredByHint && !failures.size;
    q("workshop-status").textContent = text; onChange();
  };

  const library = document.createElement("div"); library.className = "workshop-library";
  const label = document.createElement("label"); label.textContent = "クラウドに保存済みの自分のSTL";
  const librarySelect = document.createElement("select"); librarySelect.id = "workshop-assets"; librarySelect.setAttribute("aria-label", "保存済みの自分のSTL");
  label.append(librarySelect); library.append(label);
  const reuse = document.createElement("button"); reuse.id = "object-reuse"; reuse.textContent = "選んだSTLを使う"; library.append(reuse);
  q("workshop-list").parentElement.before(library);
  const cancel = document.createElement("button"); cancel.id = "object-cancel"; cancel.textContent = "変更を取り消す";
  const retry = document.createElement("button"); retry.id = "object-retry"; retry.textContent = "表示できない作品を再読込";
  q("object-apply").before(cancel);
  q("object-remove").after(retry);

  function requireAccess(prompt = true) {
    if (access().canEdit && !destroyed) return true;
    setMessage(!access().userId ? "街の操作・作品の配置には、生徒はID・パスワード、先生はGoogleでログインしてください。" :
      "共同ワールドに参加し、接続が完了してから作品を配置してください。");
    if (prompt) onRequireLogin(); return false;
  }
  function canChange(item) { return canEditWorkshopObject(state, item); }
  const currentToken = () => scope.capture();
  const accepts = (token) => !destroyed && scope.accepts(token);
  function disposeMesh(mesh) { group.remove(mesh); mesh.material.dispose(); }
  function stopPick() {
    picking = false; domElement.style.cursor = "";
    pickControls.hidden = true;
  }
  function clearDraft() {
    clearTimeout(scaleValidationTimer);
    if (draft) {
      const original = remote.get(draft.baseId);
      if (original) original.mesh.visible = true;
      disposeMesh(draft.mesh);
    }
    draft = null; typingScaleFor = null; invalidScaleFor = null; stopPick();
  }
  function clearLocator() {
    if (locator) { locator.removeFromParent(); locator.geometry.dispose(); locator.material.dispose(); }
    locator = null; locatedId = null;
  }
  let preview, previewFrame = 0;
  const previewPanel = q("stl-editor-preview");
  const gallery = createFinishGallery(q("stl-finish-gallery"), q("object-finish"));
  function resetPreview() {
    if (previewFrame) cancelAnimationFrame(previewFrame);
    previewFrame = 0;
    if (preview) {
      preview.dispose();
      const canvas = q("stl-editor-canvas");
      canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
      q("stl-editor-dimensions").textContent = "";
    }
    preview = null;
    previewPanel.hidden = true;
  }
  function requestPreview() {
    if (!renderer || !dialog.open || isXR() || previewFrame) return;
    previewFrame = requestAnimationFrame(() => {
      previewFrame = 0;
      const item = selectedItem();
      if (destroyed || !dialog.open || isXR() || !item?.mesh) { resetPreview(); return; }
      previewPanel.hidden = false;
      preview ??= createSTLEditorPreview(THREE, renderer, q("stl-editor-canvas"), q("stl-editor-dimensions"));
      preview.draw(item, q("object-color").value, q("object-finish").value, q("object-surface").value);
    });
  }
  dialog.addEventListener("close", () => {
    resetPreview();
    // Leaving an unfinished number must not block placing a held STL later.
    if (!draft || invalidScaleFor !== draft) return;
    invalidScaleFor = null; typingScaleFor = null; previewDraft();
  });
  dialog.addEventListener("input", requestPreview);
  dialog.addEventListener("change", requestPreview);
  function clearWorld() {
    resetPreview();
    thumbnails.clear(); thumbnailQueue = Promise.resolve();
    thumbnailRenderer?.dispose(); thumbnailRenderer = null;
    clearLocator();
    clearDraft(); colorSelectionKey = ""; exhibitSelectionKey = "";
    for (const item of remote.values()) disposeMesh(item.mesh);
    remote.clear(); selected = null;
    for (const model of models.values()) model.geometry.dispose();
    models.clear();
    for (const task of loading.values()) task.resolve?.(null);
    loading.clear(); failures.clear(); operation = null;
  }
  function publicObject(item) {
    return { id: item.id, name: item.name, title: item.title, description: item.description, authorName: item.authorName, ownerId: item.ownerId, assetId: item.assetId,
      upAxis: item.upAxis, position: [...item.position], rotation: [...item.rotation],
      scale: [...item.scale], color: stlColor(item.color), finish: stlFinish(item.finish), surface: stlSurface(item.surface),
      triangles: item.triangles, committed: item !== draft,
      valid: item === draft ? item.valid : true, editable: canChange(item) };
  }
  function readAppearance() {
    return { color: q("object-color").value, finish: q("object-finish").value, surface: q("object-surface").value };
  }
  function saveKind(item) {
    if (!canChange(item)) return null;
    if (item === draft && !draft.baseId) return "create";
    const saved = remote.get(item.id);
    if (!saved) return null;
    if (item === draft && (!draft.valid || draft.title !== saved.title || draft.description !== saved.description ||
        ["position", "rotation", "scale"].some(field => draft[field].some((value, i) => value !== saved[field][i])))) return "update";
    const appearance = readAppearance();
    if (appearance.color !== stlColor(saved.color) || appearance.finish !== stlFinish(saved.finish) ||
        (appearance.finish !== "solid" && appearance.surface !== stlSurface(saved.surface))) return "paint";
    return null;
  }
  function renderSaveAction() {
    const item = selectedItem(), kind = saveKind(item), button = q("object-apply");
    const disabledDraft = item && item === draft && (!draft.valid || invalidScaleFor === draft);
    button.textContent = kind === "create" ? "この場所に配置" : kind === "paint" ? "見た目を保存" : "変更を保存";
    button.hidden = !canChange(item);
    button.disabled = !kind || busy() || Boolean(disabledDraft);
    cancel.hidden = !canChange(item) || (!draft?.baseId && kind !== "paint");
    cancel.disabled = busy();
    let hint;
    if (!access().canEdit) hint = "共同ワールドに接続すると作品を編集できます。";
    else if (busy()) hint = "処理中です。しばらくお待ちください。";
    else if (!item) hint = "作品を選ぶか、STLファイルを追加してください。";
    else if (!canChange(item)) hint = "ほかの人の作品です。作者だけが変更できます。";
    else if (invalidScaleFor === item) hint = "縮尺に0.000001〜100の数値を入力してください。";
    else if (disabledDraft) hint = draft.placementHint || "「地面を選んで移動」で、空いている場所を選んでください。";
    else if (kind === "create") hint = "未配置の作品です。今の見た目で、選んだ場所に置きます。";
    else if (kind === "paint") hint = "色と仕上げを、今の場所にある作品へ保存します。";
    else if (kind === "update") hint = "この作品の編集内容をワールドに保存します。";
    else hint = "配置済みです。色・仕上げ・大きさなどを変えると保存できます。";
    q("workshop-save-hint").textContent = hint;
  }
  function renderList() {
    requestPreview();
    const select = q("workshop-list"); select.replaceChildren();
    for (const item of remote.values()) select.append(new Option(`${item.ownerId === access().userId ? "自分" : item.authorName || "他の人"} ✓ ${exhibitTitle(item)}`, item.id));
    if (draft && !remote.has(draft.id)) select.append(new Option(`下書き ${draft.name}`, draft.id));
    if (selected) select.value = selected;
    const previousAsset = librarySelect.value; librarySelect.replaceChildren();
    for (const asset of ownAssets()) librarySelect.append(new Option(asset.name, asset.id));
    if ([...librarySelect.options].some((option) => option.value === previousAsset)) librarySelect.value = previousAsset;
    const item = selectedItem(), editable = canChange(item) && !busy();
    library.hidden = !ownAssets().length;
    q("object-color").disabled = q("object-finish").disabled = !editable;
    const finish = stlFinish(item?.finish), surface = stlSurface(item?.surface);
    const colorKey = JSON.stringify([item?.id, stlColor(item?.color), finish, surface]);
    // Keep unfinished selections if another participant changes their own work.
    if (colorKey !== colorSelectionKey) {
      colorSelectionKey = colorKey;
      q("object-color").value = stlColor(item?.color);
      q("object-finish").value = finish;
      q("object-surface").value = surface;
    }
    q("object-surface").disabled = !editable || q("object-finish").value === "solid";
    gallery?.refresh();
    renderSaveAction();
    q("object-locate").disabled = !access().canEdit || !item || busy() || item === draft || isXR();
    q("object-name").textContent = item ? `選択中：${exhibitTitle(item)}` : "作品はまだ選ばれていません";
    const exhibitKey = JSON.stringify([item?.id, item?.title, item?.description]);
    if (exhibitKey !== exhibitSelectionKey) {
      exhibitSelectionKey = exhibitKey;
      q("exhibit-title").value = item?.title ?? "";
      q("exhibit-description").value = item?.description ?? "";
    }
    q("exhibit-title").readOnly = q("exhibit-description").readOnly = !editable;
    q("exhibit-save").disabled = !editable;
    q("exhibit-save").textContent = item && item === draft ? "展示名・説明を下書きに反映" : "展示名・説明を保存";
    q("exhibit-author").textContent = item?.authorName ? `作者：${item.authorName}` : "";
    q("object-location").textContent = item ? `${item === draft ? "未確定のプレビュー" : "設置済み"}：${describeWorkLocation(item.position, getViewPosition(), getStation())}` : "設置済みの自分の作品を選ぶと、場所を確認できます。";
    for (const field of fields) q(`object-${field}`).disabled = !editable;
    q("object-scale").setAttribute("aria-invalid", String(Boolean(item && invalidScaleFor === item)));
    for (const id of ["stl-files", "stl-up", "stl-units"]) q(id).disabled = !access().canEdit || busy();
    q("object-pick").disabled = !editable; q("object-remove").disabled = !editable;
    q("object-remove").textContent = item === draft && !draft?.baseId ? "手持ちをしまう" : "ホットバーへ戻す";
    q("object-remove").title = "配置を解除します。保存済みのSTL原本は残り、また使えます。";
    reuse.disabled = !access().canEdit || busy() || !ownAssets().length;
    retry.disabled = !access().canEdit || busy() || !failures.size;
    retry.hidden = !failures.size;
    q("workshop-status").hidden = messageIsHint && !failures.size;
    q("workshop-status").textContent = message + (failures.size ? ` ${failures.size}種類のSTLを表示できていません。「再読込」で再試行できます。` : "");
    if (!item) { q("object-y").textContent = "作品を選んでください。配置先は実地形で検証します。"; return; }
    q("object-x").value = item.position[0].toFixed(2); q("object-z").value = item.position[2].toFixed(2);
    if (item !== typingScaleFor) q("object-scale").value = Number(item.scale[0].toPrecision(7));
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
  function displayAppearance(item, invalid = false) {
    const { mesh } = item;
    mesh.userData.stlColor = stlColor(item.color);
    mesh.userData.stlFinish = stlFinish(item.finish);
    mesh.userData.stlSurface = stlSurface(item.surface);
    mesh.material.color.set(invalid ? "#dc584e" : mesh.userData.stlColor);
    applySTLFinish(mesh, invalid ? "solid" : mesh.userData.stlFinish, mesh.userData.stlSurface);
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
  function getAssetThumbnail(id) {
    const asset = ownAssets().find(item => item.id === id);
    if (!renderer || !asset || !access().canEdit || destroyed) return Promise.resolve(null);
    const key = assetKey(asset);
    if (thumbnails.has(key)) return thumbnails.get(key);
    const token = currentToken();
    const available = () => accepts(token) && !isXR() && !renderer.xr.isPresenting &&
      ownAssets().some(item => assetKey(item) === key);
    // One icon at a time. Placed meshes and hotbar selection share ensureModel's
    // existing two-download budget, including for unplaced assets after login.
    const job = thumbnailQueue.then(async () => {
      await new Promise(resolve => {
        if (globalThis.requestIdleCallback) globalThis.requestIdleCallback(resolve, { timeout: 500 });
        else setTimeout(resolve, 16);
      });
      if (!available() || failures.has(id)) return null;
      const model = await ensureModel(asset, token);
      if (!model || !available()) return null;
      thumbnailRenderer ??= createSTLThumbnailRenderer(THREE, renderer);
      return thumbnailRenderer.render(model.geometry);
    }).catch(() => null);
    thumbnails.set(key, job);
    thumbnailQueue = job.then(url => { if (!url && thumbnails.get(key) === job) thumbnails.delete(key); });
    return job;
  }
  function syncObjects() {
    if (!access().canEdit) return;
    if (thumbnails.size) {
      const liveKeys = new Set(ownAssets().map(assetKey));
      for (const key of thumbnails.keys()) if (!liveKeys.has(key)) { thumbnails.delete(key); thumbnailRevision++; }
    }
    const entries = state.objects ?? [], assets = new Map((state.assets ?? []).filter(validAsset).map((asset) => [asset.id, asset]));
    if (entries.length > 340 || entries.reduce((sum, object) => sum + (object.triangles ?? MAX_WORLD_TRIANGLES + 1), 0) > MAX_WORLD_TRIANGLES) {
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
      Object.assign(item, object, { name: typeof object.name === "string" ? object.name : asset.name, upAxis: asset.upAxis,
        color: stlColor(object.color), finish: stlFinish(object.finish), surface: stlSurface(object.surface), positions: model.positions });
      displayAppearance(item);
      item.mesh.name = `creation-${object.id}`; item.mesh.userData.creationId = object.id; item.mesh.userData.ownerId = object.ownerId;
      applyTransform(item.mesh, object);
    }
    if (selected && !remote.has(selected) && draft?.id !== selected) selected = null;
    if (locator) {
      const item = remote.get(locatedId);
      if (!item) clearLocator();
      else locator.box.setFromObject(item.mesh).expandByScalar(.15);
    }
    makeCacheSpace(0, null);
  }
  function onState(next, event = "state") {
    state = next ?? schoolClient?.getState() ?? {};
    const status = scope.update(state);
    if (status.changed) {
      clearWorld(); messageIsHint = false;
      if (dialog.open && !status.canEdit) dialog.close();
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
      color: stlColor(), finish: "solid", surface: "all", position: seed, rotation: [0, 0, 0], scale: [factor, factor, factor], valid: false,
      baseId: null, baseKey: null };
    draft.mesh.userData.creationId = id; draft.mesh.userData.ownerId = draft.ownerId; draft.mesh.userData.isDraft = true;
    selected = id; return previewDraft();
  }
  function beginDraft() {
    if (draft?.id === selected) return draft;
    const item = remote.get(selected); if (!canChange(item)) return null;
    const model = models.get(item.assetId); if (!model) return null;
    const appearance = dialog.open ? readAppearance() : {};
    clearDraft(); draft = { ...item, ...appearance, mesh: makeMesh(model, true), positions: model.positions,
      position: [...item.position], rotation: [...item.rotation], scale: [...item.scale],
      baseId: item.id, baseKey: objectKey(item), valid: true };
    draft.mesh.userData.creationId = item.id; draft.mesh.userData.ownerId = item.ownerId; draft.mesh.userData.isDraft = true;
    // While shrinking an existing work, its original would cover the smaller preview.
    item.mesh.visible = false;
    displayAppearance(draft); applyTransform(draft.mesh, draft); return draft;
  }
  function previewDraft({ position = draft?.position, rotation = draft?.rotation, scale = draft?.scale } = {}) {
    clearTimeout(scaleValidationTimer);
    if (!draft || !requireAccess(false)) return { valid: false };
    if (!safeWorkshopTransform({ position, rotation, scale })) {
      draft.valid = false; displayAppearance(draft, true);
      draft.placementHint = "値が範囲外です。縮尺は0.000001〜100、回転は±18000°以内で指定してください。";
      setMessage(draft.placementHint, { coveredByHint: true });
      renderList(); return { valid: false };
    }
    const candidate={ positions: draft.positions, position, rotation, scale };
    const result = validatePlacement(candidate, getEnvironment(candidate));
    if (result.valid && (state.objects ?? []).some((object) => object.id !== draft.baseId && sharedObjectOverlap(result.bounds, object))) {
      result.valid = false; result.error = "object_overlap";
    }
    draft.position = result.position ?? [...position]; draft.rotation = [...rotation]; draft.scale = [...scale];
    draft.valid = result.valid; draft.bounds = result.bounds; applyTransform(draft.mesh, draft);
    displayAppearance(draft, !draft.valid); draft.mesh.material.opacity = draft.valid ? 0.8 : 0.45;
    draft.placementHint = draft.valid ? "" : explainError(result.error);
    setMessage(draft.valid ? (draft.baseId ? "変更をプレビュー中です。" : "配置できる場所です。") : `配置できません：${draft.placementHint}`, { coveredByHint: true });
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
      if (state.singleClassroom) {
        // Quest asset cycling and 2D reuse both select the existing placement.
        // Never manufacture a duplicate draft the shared room must reject.
        syncObjects();
        const placed = [...remote.values()].find(item => item.assetId === assetId && canChange(item));
        if (placed) {
          selected = placed.id;
          setMessage("設置済みの自分の作品を選びました。位置・回転・大きさを変更できます。");
          return true;
        }
      }
      createDraft(asset, model); return true;
    } catch (error) { if (accepts(token)) setMessage(explainError(error)); return false; }
    finally { if (operation === marker) operation = null; renderList(); onChange(); }
  }
  function selectObject(id) {
    if (!requireAccess() || busy()) return false;
    const item = remote.get(id) ?? (draft?.id === id ? draft : null); if (!item) return false;
    if (selected !== id) clearDraft(); selected = id; renderList();
    setMessage(canChange(item) ? "自分の作品を選びました。" : "他の人の作品を選びました。", { coveredByHint: true }); return true;
  }
  function moveSelected(position) {
    if (!requireAccess() || busy() || !canChange(selectedItem())) return { valid: false };
    if (!beginDraft()) return { valid: false }; return previewDraft({ position });
  }
  function adjustSelected({ axis, radians: amount, rotationAxis, rotationDelta, scaleFactor, position = draft?.position } = {}) {
    if (!requireAccess() || busy() || !canChange(selectedItem()) || !beginDraft()) return { valid: false };
    const rotation = [...draft.rotation], scale = [...draft.scale];
    const selectedAxis = axis ?? rotationAxis, delta = amount ?? rotationDelta;
    if (selectedAxis !== undefined) {
      const index = ["x", "y", "z"].indexOf(selectedAxis); if (index < 0 || !Number.isFinite(delta)) return { valid: false };
      rotation[index] += delta;
    }
    if (scaleFactor !== undefined) {
      if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) return { valid: false };
      typingScaleFor = null; invalidScaleFor = null;
      for (let index = 0; index < 3; index++) {
        const value=scale[index]*scaleFactor, tolerance=4*Number.EPSILON;
        // Clamp only floating-point overshoot of the documented bounds. Real
        // out-of-range edits still fail validation rather than distorting shape.
        scale[index]=value>100 && value<=100*(1+tolerance) ? 100 :
          value<1e-6 && value>=1e-6*(1-tolerance) ? 1e-6 : value;
      }
    }
    return previewDraft({ rotation, scale, position });
  }
  async function commitSelected() {
    if (!requireAccess() || busy() || !draft || !canChange(draft) || invalidScaleFor === draft || !previewDraft().valid) return false;
    const item = draft;
    if (dialog.open) {
      const { color, finish, surface } = readAppearance();
      if (validSTLColor(color) && validSTLFinish(finish) && validSTLSurface(surface)) {
        Object.assign(item, { color: stlColor(color), finish, surface });
        displayAppearance(item);
      }
    }
    const token = currentToken(), marker = {}; operation = marker; renderList();
    try {
      const ack = await schoolClient.editObject(item.baseId ? "object.update" : "object.create", {
        id: item.id, ...(item.baseId ? {} : { assetId: item.assetId }),
        title: item.title ?? "", description: item.description ?? "",
        position: [...item.position], rotation: [...item.rotation], scale: [...item.scale], color: stlColor(item.color),
        finish: stlFinish(item.finish), surface: stlSurface(item.surface) });
      if (!accepts(token)) return false;
      // Only the server broadcast becomes committed, never the local preview.
      if (draft === item) clearDraft(); selected = ack.id ?? item.id;
      syncObjects(); setMessage(item.baseId ? "作品の変更を保存しました。" : "作品をワールドに配置しました。"); return true;
    } catch (error) { if (accepts(token)) setMessage(`${item.baseId ? "変更を保存できませんでした" : "配置は確定していません"}：${explainError(error)}`); return false; }
    finally { if (operation === marker) operation = null; renderList(); onChange(); }
  }
  async function removeSelected() {
    if (!requireAccess() || busy() || !canChange(selectedItem())) return false;
    if (draft && !draft.baseId) { clearDraft(); selected = null; setMessage("下書きを取り消しました。保存済みSTLは残っています。"); renderList(); return true; }
    const item = remote.get(selected); if (!item) return false;
    const token = currentToken(), marker = {}; operation = marker; renderList();
    try {
      await schoolClient.editObject("object.delete", { id: item.id }); if (!accepts(token)) return false;
      clearDraft(); selected = null; syncObjects(); setMessage("作品をホットバーへ戻しました。保存済みのSTLはまた配置できます。"); return true;
    } catch (error) { if (accepts(token)) setMessage(`配置を解除できませんでした：${explainError(error)}`); return false; }
    finally { if (operation === marker) operation = null; renderList(); onChange(); }
  }
  async function retrieveSelected() {
    const item=remote.get(selected), model=item && models.get(item.assetId);
    if(!requireAccess() || busy() || !canChange(item) || !model) return false;
    // Prepare the hand-held copy before deleting anything. Keep the placement
    // visible until the authoritative delete ACK; failures leave it untouched.
    const held={...item,id:crypto.randomUUID(),positions:model.positions,
      position:[...item.position],rotation:[...item.rotation],scale:[...item.scale],
      color:stlColor(item.color),mesh:makeMesh(model,true),baseId:null,baseKey:null,valid:false};
    held.mesh.visible=false; held.mesh.userData.creationId=held.id;
    held.mesh.userData.ownerId=item.ownerId; held.mesh.userData.isDraft=true;
    displayAppearance(held); applyTransform(held.mesh,held);
    const token=currentToken(),marker={}; operation=marker; renderList(); let adopted=false;
    try {
      await schoolClient.editObject("object.delete",{id:item.id});
      if(!accepts(token)) return false;
      clearDraft(); draft=held; selected=held.id; adopted=true; syncObjects();
      setMessage("見た目・大きさ・回転を保って手に持ちました。地面をねらい、右クリックで置き直してください。再配置するまでは下書きです。");
      return true;
    } catch(error) { if(accepts(token)) setMessage(`回収できませんでした：${explainError(error)}`); return false; }
    finally { if(!adopted)disposeMesh(held.mesh); if(operation===marker)operation=null; renderList();onChange(); }
  }
  function cancelDraft() {
    if (!requireAccess() || busy()) return false;
    const baseId = draft ? draft.baseId : selected; clearDraft(); colorSelectionKey = ""; selected = baseId && remote.has(baseId) ? baseId : null;
    setMessage("下書きを取り消しました。サーバー上の確定済み作品は変更していません。"); renderList(); return true;
  }
  async function cycleOwnAsset(direction = 1) {
    if (!requireAccess() || busy()) return false;
    const assets = ownAssets(); if (!assets.length) { setMessage("最初に2D画面の「STL作品」から自分のSTLを読み込んでください。"); return false; }
    const current = assets.findIndex((asset) => asset.id === selectedItem()?.assetId), delta = direction < 0 ? -1 : 1;
    return useAsset(assets[(current < 0 ? 0 : (current + delta + assets.length) % assets.length)].id);
  }
  async function paintSelected(color, finish, surface) {
    const item = selectedItem();
    finish ??= stlFinish(item?.finish); surface ??= stlSurface(item?.surface);
    if (!requireAccess() || busy() || !canChange(item) || !validSTLColor(color) || !validSTLFinish(finish) || !validSTLSurface(surface)) return false;
    const appearance = { color: stlColor(color), finish, surface };
    if (item === draft) {
      Object.assign(draft, appearance); previewDraft();
      if (draft.valid) setMessage(draft.baseId ? "見た目を下書きに反映しました。「変更を保存」で共有します。" : "見た目を下書きに反映しました。「この場所に配置」で共有します。");
      return true;
    }
    return saveAppearance(item, appearance);
  }
  async function saveAppearance(item, appearance) {
    const token = currentToken(), marker = {}; operation = marker; renderList();
    try {
      await schoolClient.editObject("object.paint", { id: item.id, ...appearance });
      if (!accepts(token)) return false;
      if (item === draft) clearDraft();
      syncObjects(); setMessage("作品の見た目を保存しました。"); return true;
    } catch (error) { if (accepts(token)) setMessage(`見た目を保存できませんでした：${explainError(error)}`); return false; }
    finally { if (operation === marker) operation = null; renderList(); onChange(); }
  }
  async function locateSelected() {
    const item = selectedItem();
    if (!requireAccess() || busy() || !item || item === draft || isXR()) return false;
    const token=currentToken(),key=objectKey(item),marker={};operation=marker;renderList();
    const stillValid=()=>accepts(token) && !isXR() && remote.has(item.id) && objectKey(remote.get(item.id))===key;
    clearLocator();
    setMessage("作品のそばの地面と建物を確認しています…");
    try {
    if (!await onLocate(publicObject(item),stillValid) || !stillValid()) { if(accepts(token))setMessage("安全に立てる地面を確認できませんでした。場所は移動していません。地図の読み込み後にもう一度お試しください。"); return false; }
    clearLocator(); locatedId = item.id;
    locator = new THREE.Box3Helper(new THREE.Box3().setFromObject(item.mesh).expandByScalar(.15), 0xffca28);
    locator.name = "own-work-location-marker";
    locator.material.depthTest = false; locator.material.depthWrite = false; locator.renderOrder = 999;
    scene.add(locator);
    if (dialog.open) dialog.close();
    setMessage(`「${item.name}」の隣へ移動しました。作品自体の位置は変更していません。`); return true;
    } catch(error) { if(accepts(token))setMessage(`移動できませんでした：${explainError(error)}`);return false; }
    finally { if(operation===marker)operation=null;renderList();onChange(); }
  }
  function retryAssets() {
    if (!requireAccess() || busy()) return false;
    thumbnailRevision++;
    failures.clear(); scheduleSync(); setMessage("表示できなかった作品を再読込しています…"); return true;
  }
  async function describeSelected(title, description) {
    const item = selectedItem();
    if (!requireAccess() || busy() || !canChange(item) || !validExhibitText(title, description)) return false;
    if (item === draft) {
      Object.assign(item, { title: title.trim(), description: description.trim() });
      renderList(); setMessage(draft.baseId ? "展示名・説明を下書きに反映しました。「変更を保存」で共有します。" : "展示名・説明を下書きに反映しました。作品を置くときに保存します。"); return true;
    }
    const token = currentToken(), marker = {}; operation = marker; renderList();
    try {
      await schoolClient.editObject("object.describe", { id: item.id, title, description });
      if (!accepts(token)) return false;
      syncObjects(); setMessage("展示名・説明を保存しました。"); return true;
    } catch (error) { if (accepts(token)) setMessage(`保存できませんでした：${explainError(error)}`); return false; }
    finally { if (operation === marker) operation = null; renderList(); }
  }
  function open({ editSelected = false } = {}) {
    if (!requireAccess()) return false;
    if (isXR()) { setMessage("VRでは作品操作パネルを使ってください。ファイル読み込みは2Dへ戻って行います。"); return false; }
    if (!selectedItem()) selected = [...remote.values()].find(item => canChange(item))?.id ?? null;
    const importPanel=q("workshop-import"),body=q("workshop-body");
    if(importPanel)importPanel.open=!ownAssets().length;
    stopPick(); renderList(); if (!dialog.open) dialog.showModal(); requestPreview();
    const collection = q("workshop-collection");
    if (collection) collection.open = !selectedItem();
    if (body) {
      body.scrollTop = 0;
      if (editSelected && selectedItem()) {
        const appearance = q("workshop-appearance");
        if (appearance) body.scrollTop = Math.max(0, appearance.getBoundingClientRect().top - body.getBoundingClientRect().top);
      }
    }
    return true;
  }
  q("stl-files").addEventListener("change", (event) => { void importFiles([...event.target.files]); });
  q("workshop-list").addEventListener("change", (event) => selectObject(event.target.value));
  const scaleInput = q("object-scale");
  function previewScaleInput() {
    if (busy() || !canChange(selectedItem()) || !beginDraft()) return;
    typingScaleFor = draft;
    const value = scaleInput.valueAsNumber;
    const scale = draft.scale.map(axis => (axis / draft.scale[0]) * value);
    if (scaleInput.value === "" || !safeWorkshopTransform({ ...draft, scale })) {
      clearTimeout(scaleValidationTimer);
      invalidScaleFor = draft;
      draft.valid = false;
      setMessage("縮尺は0.000001〜100の数値を入力してください。", { coveredByHint: true });
      renderList(); return;
    }
    invalidScaleFor = null;
    if (draft.triangles < 2000) { previewDraft({ scale }); return; }
    // Exact terrain contact visits every triangle. Draw immediately and check
    // the latest size after scrubbing pauses. A save always checks synchronously.
    clearTimeout(scaleValidationTimer);
    draft.scale = scale; draft.valid = false; draft.bounds = null;
    draft.placementHint = "地面や周りの作品との重なりを確認しています。";
    applyTransform(draft.mesh, draft);
    setMessage(draft.placementHint, { coveredByHint: true });
    renderList();
    const edited = draft;
    scaleValidationTimer = setTimeout(() => {
      if (draft === edited && canChange(edited)) previewDraft();
    }, 160);
  }
  scaleInput.addEventListener("input", previewScaleInput);
  scaleInput.addEventListener("change", previewScaleInput);
  scaleInput.addEventListener("blur", () => {
    if (typingScaleFor && !invalidScaleFor) {
      typingScaleFor = null;
      scaleInput.value = Number(selectedItem().scale[0].toPrecision(7));
    }
  });

  let scrub = null, scrubFrame = null;
  function applyScrub() {
    scrubFrame = null;
    if (!scrub || selectedItem() !== scrub.item || busy() || !canChange(scrub.item)) return;
    const value = Math.max(1e-6, Math.min(100, scrub.startScale * 2 ** ((scrub.x - scrub.startX) / 100)));
    scaleInput.value = Number(value.toPrecision(7));
    previewScaleInput();
    scrub.item = selectedItem();
  }
  function endScrub(event) {
    if (!scrub || scrub.pointerId !== event.pointerId) return;
    if (scrubFrame !== null) { cancelAnimationFrame(scrubFrame); scrubFrame = null; }
    if (scrub.moved && event.type === "pointerup") {
      scrub.x = event.clientX; applyScrub();
    }
    scrub = null;
    if (scaleInput.hasPointerCapture?.(event.pointerId)) scaleInput.releasePointerCapture(event.pointerId);
  }
  scaleInput.addEventListener("pointerdown", event => {
    const item = selectedItem();
    if (scrub || event.button !== 0 || event.pointerType === "touch" || busy() || !canChange(item)) return;
    scrub = { pointerId: event.pointerId, item, startScale: item.scale[0], startX: event.clientX, x: event.clientX, moved: false };
    scaleInput.setPointerCapture?.(event.pointerId);
  });
  // Chrome otherwise starts dragging the selected number as text, cancels the
  // captured pointer, and stops sending moves after the first few pixels.
  scaleInput.addEventListener("dragstart", event => { if (scrub) event.preventDefault(); });
  scaleInput.addEventListener("pointermove", event => {
    if (!scrub || scrub.pointerId !== event.pointerId) return;
    scrub.x = event.clientX;
    if (!scrub.moved && Math.abs(scrub.x - scrub.startX) < 4) return;
    scrub.moved = true; event.preventDefault();
    if (scrubFrame === null) scrubFrame = requestAnimationFrame(applyScrub);
  });
  for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) scaleInput.addEventListener(event, endScrub);

  for (const field of fields.filter(name => name !== "scale")) q(`object-${field}`).addEventListener("change", () => {
    if (!requireAccess() || busy() || !canChange(selectedItem())) return;
    const value = q(`object-${field}`).valueAsNumber;
    if (!Number.isFinite(value)) { setMessage("数値を入力してください。"); renderList(); return; }
    if (!beginDraft()) return;
    const position = [...draft.position], rotation = [...draft.rotation];
    if (field === "x" || field === "z") position[field === "x" ? 0 : 2] = value;
    else rotation[["rx", "ry", "rz"].indexOf(field)] = radians(value);
    previewDraft({ position, rotation });
  });
  q("object-apply").onclick = () => {
    const item = selectedItem(), kind = saveKind(item);
    if (!kind || busy() || (item === draft && (!item.valid || invalidScaleFor === item))) return;
    if (kind === "paint") {
      const appearance = readAppearance();
      if (validSTLColor(appearance.color) && validSTLFinish(appearance.finish) && validSTLSurface(appearance.surface)) {
        void saveAppearance(item, appearance);
      }
    } else void commitSelected();
  };
  q("object-remove").onclick = () => { void removeSelected(); };
  function appearanceChanged() {
    const item = selectedItem();
    if (!canChange(item) || busy()) return;
    const appearance = readAppearance();
    q("object-surface").disabled = appearance.finish === "solid";
    if (item === draft) {
      Object.assign(item, appearance);
      displayAppearance(item, !item.valid);
    }
    if (message && !failures.size) setMessage("");
    renderSaveAction();
    requestPreview();
  }
  for (const id of ["object-color", "object-finish", "object-surface"]) q(id).addEventListener("change", appearanceChanged);
  q("object-color").addEventListener("input", appearanceChanged);
  q("object-locate").onclick = locateSelected;
  q("exhibit-save").onclick = () => { void describeSelected(q("exhibit-title").value, q("exhibit-description").value); };
  reuse.onclick = () => { void useAsset(librarySelect.value); }; cancel.onclick = cancelDraft; retry.onclick = retryAssets;
  q("object-pick").onclick = () => {
    if (!requireAccess() || busy() || !canChange(selectedItem()) || isXR()) return;
    picking = true;
    onStartPicking();
    dialog.close();
    domElement.style.cursor = "crosshair";
    pickHint.textContent = "作品を置きたい地面を選んでください。";
    pickControls.hidden = false;
    pickCancel.focus({ preventScroll: true });
  };
  const returnToEditor = () => {
    stopPick();
    if (!requireAccess(false) || isXR()) return;
    if (!dialog.open) dialog.showModal();
    q("object-pick").focus({ preventScroll: true });
    requestPreview();
  };
  pickCancel.onclick = returnToEditor;
  const onCanvasClick = (event) => {
    if (!picking || !requireAccess(false) || busy() || isXR()) return;
    const rect = domElement.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1,
      -(event.clientY - rect.top) / rect.height * 2 + 1), camera);
    const hit = ray.intersectObjects(getEnvironment().terrainMeshes ?? [], false)[0];
    if (!hit) { pickHint.textContent = "地面が見つかりません。街の地面をもう一度選んでください。"; return; }
    returnToEditor();
    moveSelected([hit.point.x, hit.point.y, hit.point.z]);
  };
  const onEscape = (event) => {
    if (!picking || event.key !== "Escape" && event.code !== "Escape") return;
    event.preventDefault();
    returnToEditor();
  };
  domElement.addEventListener("click", onCanvasClick); window.addEventListener("keydown", onEscape);
  q("workshop-close").onclick = () => dialog.close(); document.querySelector("#open-workshop").onclick = open;
  const unsubscribe = schoolClient?.subscribe(onState) ?? (() => {});
  onState(schoolClient?.getState() ?? {}); renderList();
  return { group, open, importFiles, useAsset, selectObject, cycleOwnAsset, moveSelected, adjustSelected,
    commitSelected, removeSelected, retrieveSelected, cancelDraft, retryAssets, paintSelected, locateSelected, describeSelected,
    // Rendering-only handle: avoid cloning the full classroom every frame.
    // Editing an existing placement is not holding a new inventory item.
    getAssetThumbnail, isPicking: () => picking,
    getHeldDraft: () => draft && !draft.baseId && canChange(draft) ? draft.mesh : null,
    getState: () => {
      const objects = [...remote.values()].map((item) => draft?.id === item.id ? publicObject(draft) : publicObject(item));
      if (draft && !remote.has(draft.id)) objects.push(publicObject(draft));
      return { ...access(), busy: busy(), picking, selected, count: objects.length, committed: remote.size,
        locatedName: remote.get(locatedId)?.name ?? null,
        triangles: objects.reduce((sum, item) => sum + item.triangles, 0), objects,
        current: selectedItem() ? publicObject(selectedItem()) : null,
        thumbnailRevision,
        ownAssets: ownAssets().map(({ id, name, triangles }) => ({ id, name, triangles })),
        assetFailures: failures.size, message: q("workshop-status").textContent, storage: "cloud-world" };
    },
    destroy() { destroyed = true; unsubscribe(); clearWorld(); group.removeFromParent(); domElement.removeEventListener("click", onCanvasClick); window.removeEventListener("keydown", onEscape); },
  };
}
