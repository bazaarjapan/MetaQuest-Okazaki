import { avatarDesign, avatarDesignFields, avatarOptions, avatarPresets, defaultAvatarDesign } from "./avatar-design.js";
import { avatarNickname } from "./avatar-label.js";
import { createBlockAvatar } from "./block-avatar.js";
import { explainSchoolError } from "./school-ui.js";
import { createSTLRenderSurface as createRenderSurface } from "./stl-thumbnail.js";
import "./avatar-editor.css";

const fieldLabels = { hairStyle: "髪型", face: "顔・表情", outfit: "服装", accessory: "小物", skinTone: "肌の色", hairColor: "髪の色" };
const standardColor = "#4a90e2";
const sameDesign = (a, b) => avatarDesignFields.every(field => a?.[field] === b?.[field]);

function makePreview(THREE, renderer, canvas) {
  const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera();
  const light = new THREE.DirectionalLight(0xfff1d5, 2.5);
  light.position.set(-3, 6, -4);
  scene.add(light, new THREE.HemisphereLight(0xe4fffb, 0x91a7a8, 1.65));
  const avatar = createBlockAvatar(THREE, { batchBlocks: true });
  const stage = new THREE.Mesh(new THREE.CylinderGeometry(.66, .68, .12, 32),
    new THREE.MeshStandardMaterial({ color: 0x4d7771, roughness: .92 }));
  stage.position.y = -.061;
  scene.add(avatar.group, stage);
  const surface = createRenderSurface(THREE, renderer, canvas);
  const sample = document.createElement("canvas");
  sample.width = 84; sample.height = 92;
  const samples = createRenderSurface(THREE, renderer, sample);
  function draw(identity, color, design, back = false, thumbnail = null) {
    const aspect = canvas.width / canvas.height;
    camera.left = -1.13 * aspect; camera.right = 1.13 * aspect;
    camera.top = 1.13; camera.bottom = -1.13;
    camera.near = .01; camera.far = 20;
    camera.position.set(-1.75, 2.17, -4.9);
    camera.lookAt(0, .97, 0);
    camera.updateProjectionMatrix();
    avatar.setIdentity(identity); avatar.setColor(color); avatar.setDesign(design);
    avatar.update({ yaw: back ? Math.PI : 0 });
    if (!thumbnail) return surface.render(scene, camera);
    if (!samples.render(scene, camera)) return false;
    const context = thumbnail.getContext("2d");
    context.clearRect(0, 0, thumbnail.width, thumbnail.height);
    context.drawImage(sample, 0, 0);
    return true;
  }
  return { draw };
}

export function createAvatarEditor(THREE, { renderer, client, onBeforeOpen }) {
  const $ = id => document.getElementById(id);
  const dialog = $("avatar-dialog"), form = $("avatar-form"), opener = $("open-avatar"), name = $("avatar-name");
  const shirt = $("avatar-shirt"), fields = $("avatar-fields"), save = $("avatar-save"), close = $("avatar-close");
  const turn = $("avatar-turn"), status = $("avatar-status"), previewName = $("avatar-preview-name");
  const previewCanvas = $("avatar-preview"), parts = $("avatar-parts");
  let user, initial, busy = false, back = false, preview, viewFrame = 0, sampleFrame = 0, samplesFor, opening = 0;

  const inputs = Object.fromEntries(avatarDesignFields.map(field => {
    const label = document.createElement("label"), title = document.createElement("strong"), select = document.createElement("select");
    label.className = "avatar-field"; title.textContent = fieldLabels[field]; select.id = `avatar-${field}`;
    for (const [id, text] of avatarOptions[field]) select.append(new Option(text, id));
    label.append(title, select); parts.insertBefore(label, shirt.parentElement);
    return [field, select];
  }));
  const presets = avatarPresets.map(preset => {
    const button = document.createElement("button"), canvas = document.createElement("canvas"), label = document.createElement("span");
    button.type = "button"; button.className = "avatar-preset"; button.setAttribute("aria-pressed", "false");
    canvas.width = 84; canvas.height = 92; canvas.setAttribute("aria-hidden", "true");
    label.textContent = preset.name;
    button.append(canvas, label); $("avatar-presets").append(button);
    button.addEventListener("click", () => { apply(preset); changed(); });
    return { ...preset, button, canvas };
  });

  function setStatus(message = "", error = false) {
    status.textContent = message;
    status.dataset.error = String(error);
  }
  function profile(value) {
    return { name: value.name, color: value.color?.toLowerCase() ?? standardColor, design: avatarDesign(value.design) };
  }
  function apply({ color, design }) {
    shirt.value = color;
    for (const field of avatarDesignFields) inputs[field].value = (design ?? defaultAvatarDesign)[field];
  }
  function draft() {
    const design = Object.fromEntries(avatarDesignFields.map(field => [field, inputs[field].value]));
    return { name: name.value.trim(), color: shirt.value, design: sameDesign(design, defaultAvatarDesign) ? null : design };
  }
  function sync() {
    if (!dialog.open || !initial) return;
    const value = draft();
    save.disabled = busy || (!value.name || (value.name === initial.name && value.color === initial.color && sameDesign(value.design, initial.design)));
    fields.disabled = name.disabled = close.disabled = busy;
    previewName.value = avatarNickname(value.name);
    for (const preset of presets) preset.button.setAttribute("aria-pressed", String(preset.color === value.color && sameDesign(preset.design, value.design)));
    if (viewFrame) return;
    viewFrame = requestAnimationFrame(() => {
      viewFrame = 0;
      if (!dialog.open) return;
      const latest = draft();
      preview ??= makePreview(THREE, renderer, previewCanvas);
      preview.draw(user.id, latest.color, latest.design, back);
    });
  }
  function changed() { setStatus(); sync(); }
  function drawSamples(id) {
    if (samplesFor === id || sampleFrame) return;
    let index = 0;
    function next() {
      sampleFrame = 0;
      if (!dialog.open || user?.id !== id) return;
      preview ??= makePreview(THREE, renderer, previewCanvas);
      for (let item = 0; item < 2 && index < presets.length; item++, index++) {
        const { color, design, canvas } = presets[index];
        if (!preview.draw(id, color, design, false, canvas)) return;
      }
      if (index === presets.length) samplesFor = id;
      else sampleFrame = requestAnimationFrame(next);
    }
    sampleFrame = requestAnimationFrame(next);
  }
  function open() {
    if (!user || user.namePending || document.querySelector("dialog[open]") || onBeforeOpen() === false) return false;
    opening++; initial = profile(user); busy = back = false;
    apply(initial); name.value = initial.name; turn.textContent = "後ろを見る";
    setStatus(); dialog.showModal();
    dialog.querySelector(".avatar-layout").scrollTop = 0;
    sync(); drawSamples(user.id);
    return true;
  }
  opener.addEventListener("click", open);
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    opening++; initial = null; busy = false;
    cancelAnimationFrame(viewFrame); cancelAnimationFrame(sampleFrame); viewFrame = sampleFrame = 0;
  });
  $("avatar-standard").addEventListener("click", () => { apply({ color: standardColor, design: null }); changed(); });
  turn.addEventListener("click", () => { back = !back; turn.textContent = back ? "前を見る" : "後ろを見る"; sync(); });
  form.addEventListener("input", changed);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (save.disabled || !initial || !user) return;
    const value = draft(), session = opening, owner = user.id, changes = {};
    if (value.name !== initial.name) changes.name = value.name;
    if (value.color !== initial.color) changes.color = value.color;
    if (!sameDesign(value.design, initial.design)) changes.design = value.design;
    const current = () => session === opening && user?.id === owner && dialog.open;
    busy = true; setStatus("保存しています…"); sync();
    try {
      const saved = await client.updateAvatar(changes);
      if (!current()) return;
      initial = profile(saved); name.value = initial.name; apply(initial);
      setStatus("キャラクターを保存しました。");
    } catch (error) {
      if (current()) setStatus(explainSchoolError(error), true);
    } finally {
      if (current()) { busy = false; sync(); }
    }
  });
  client.subscribe((state, event) => {
    if (event === "pose") return;
    const next = state.user;
    if (dialog.open && (next?.id !== user?.id || next?.namePending)) dialog.close();
    user = next;
    opener.disabled = !user || user.namePending === true;
  });
  return { open };
}
