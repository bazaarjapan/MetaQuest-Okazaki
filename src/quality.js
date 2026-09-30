// XR framebuffer size is selected before entering VR. A profile change must
// never resize the framebuffer of a live XR session. These are requested
// quality settings, not measured Quest frame rates or new source-model detail.
export const qualityProfiles = Object.freeze({
  performance: Object.freeze({
    id: "performance",
    label: "軽量",
    hint: "動きの滑らかさを優先。重く感じるときに選んでください。",
    xrScale: 0.85,
    foveation: 0.8,
    dpr: 1.25,
    anisotropy: 2,
  }),
  balanced: Object.freeze({
    id: "balanced",
    label: "標準（くっきり）",
    hint: "見やすさと軽さのバランス。高精細が重く感じるときに選んでください。",
    xrScale: 1,
    foveation: 0.5,
    dpr: 1.5,
    anisotropy: 4,
  }),
  high: Object.freeze({
    id: "high",
    label: "高精細",
    hint: "輪郭と斜め方向の写真をくっきり表示。重い場合は標準へ戻してください。",
    xrScale: 1.2,
    foveation: 0.3,
    dpr: 2,
    anisotropy: 8,
  }),
});

// A new UI release starts in high quality without overwriting preferences from
// the previous release. Once selected, a v2 preference is restored normally.
export const QUALITY_STORAGE_KEY = "okazaki-webxr-quality-v2";

function isProfileId(id) {
  return typeof id === "string" && Object.hasOwn(qualityProfiles, id);
}

export function qualityProfile(id, fallback = "high") {
  if (isProfileId(id)) return qualityProfiles[id];
  return qualityProfiles[isProfileId(fallback) ? fallback : "high"];
}

// The caller supplies storage so importing this module needs neither a browser
// nor access to global localStorage. Private browsing / policy restrictions are
// harmless: storage failures simply retain the high-quality default.
export function readQuality(storage) {
  try {
    return qualityProfile(storage?.getItem(QUALITY_STORAGE_KEY));
  } catch {
    return qualityProfiles.high;
  }
}

export function saveQuality(storage, id) {
  if (!isProfileId(id)) return false;
  try {
    if (typeof storage?.setItem !== "function") return false;
    storage.setItem(QUALITY_STORAGE_KEY, id);
    return true;
  } catch {
    return false;
  }
}

export function getNextQuality(id) {
  const ids = Object.keys(qualityProfiles);
  const currentIndex = ids.indexOf(qualityProfile(id).id);
  return qualityProfiles[ids[(currentIndex + 1) % ids.length]];
}

// Estimated uncompressed texture bytes, including the exact mip pyramid when
// requested. PNG/JPEG download size is not GPU texture memory. Compression,
// driver copies, stereo buffers and geometry are intentionally not included.
export function textureMemoryBytes(width, height, channels = 4, includeMips = true) {
  if (![width, height, channels].every((v) => Number.isSafeInteger(v) && v > 0)) {
    return 0;
  }
  let total = 0;
  let w = width;
  let h = height;
  do {
    const level = w * h * channels;
    if (!Number.isSafeInteger(level) || !Number.isSafeInteger(total + level)) return 0;
    total += level;
    if (!includeMips || (w === 1 && h === 1)) return total;
    w = Math.max(1, Math.floor(w / 2));
    h = Math.max(1, Math.floor(h / 2));
  } while (true);
}
