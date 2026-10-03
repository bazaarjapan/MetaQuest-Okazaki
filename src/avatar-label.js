const segments = new Intl.Segmenter("ja", { granularity: "grapheme" });
export function avatarNickname(value) {
  if (typeof value !== "string" || value.includes("@")) return "参加者";
  const clean = value.slice(0, 512).replace(/[\p{Cc}\p{Bidi_Control}<>\u200b\u2060-\u206f\ufeff]/gu, "").trim();
  // Ignore invisible formatting for privacy checks, but keep valid emoji ZWJ
  // sequences in the displayed text. Formatting/combining marks alone are empty.
  const privacyText = clean.replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "").normalize("NFKC");
  if (!/[^\p{C}\p{M}\p{Z}]/u.test(privacyText) || privacyText.includes("@") || /^生徒-[a-f0-9]{4}$/iu.test(privacyText) ||
    /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(privacyText)) return "参加者";
  return [...segments.segment(clean)].slice(0, 20).map((part) => part.segment).join("") || "参加者";
}

// One billboard per avatar. Paint only on nickname changes; never interpret HTML.
export function createAvatarLabel(THREE, { parent, documentTarget = globalThis.document } = {}) {
  let name = null, displayed = null, disposed = false;
  const canvas = documentTarget?.createElement?.("canvas");
  const context = canvas?.getContext("2d");
  let texture, material, sprite;
  if (context) {
    canvas.width = 256; canvas.height = 64;
    texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = false; texture.minFilter = THREE.LinearFilter;
    material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false });
    sprite = new THREE.Sprite(material); sprite.name = "school-avatar-nickname";
    sprite.position.set(0, 2.16, 0); sprite.scale.set(1.4, .35, 1); parent.add(sprite);
  }
  function setName(value) {
    if (disposed) return;
    const next = avatarNickname(value); if (next === name) return; name = next;
    if (!context) return;
    context.font = "bold 28px sans-serif";
    const chars = [...segments.segment(name)].map((part) => part.segment);
    displayed = name;
    while (context.measureText(displayed).width > 240 && chars.length > 1) {
      chars.pop(); displayed = chars.join("") + "…";
    }
    context.clearRect(0, 0, 256, 64); context.fillStyle = "rgba(8,20,35,.85)";
    context.fillRect(0, 0, 256, 64); context.fillStyle = "white";
    context.textAlign = "center"; context.textBaseline = "middle";
    context.fillText(displayed, 128, 32); texture.needsUpdate = true;
  }
  return { setName, getState: () => ({ name, displayed, count: sprite && !disposed ? 1 : 0 }),
    dispose() { if (disposed) return; disposed = true; sprite?.removeFromParent(); texture?.dispose(); material?.dispose(); } };
}
