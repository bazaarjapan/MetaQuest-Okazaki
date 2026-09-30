import { test } from "node:test";
import assert from "node:assert/strict";
import {
  qualityProfiles,
  QUALITY_STORAGE_KEY,
  qualityProfile,
  readQuality,
  saveQuality,
  getNextQuality,
  textureMemoryBytes,
} from "../src/quality.js";

test("quality defaults to high and handles unknown or prototype keys", () => {
  assert.equal(qualityProfile(), qualityProfiles.high);
  for (const invalid of [null, "invalid", "__proto__", "constructor", 0, {}, "HIGH"]) {
    assert.equal(qualityProfile(invalid), qualityProfiles.high);
  }
  assert.equal(qualityProfile("invalid", "performance"), qualityProfiles.performance);
  assert.equal(qualityProfile("invalid", "also-invalid"), qualityProfiles.high);
  assert.equal(qualityProfile("invalid", "__proto__"), qualityProfiles.high);
  assert.equal(qualityProfile("high", "performance"), qualityProfiles.high);
});

test("profiles are immutable and renderer settings remain within safe bounds", () => {
  assert.equal(Object.isFrozen(qualityProfiles), true);
  for (const [id, profile] of Object.entries(qualityProfiles)) {
    assert.equal(Object.isFrozen(profile), true);
    assert.equal(profile.id, id);
    assert.ok(profile.label.length > 1);
    assert.ok(profile.hint.length > 8);
    assert.ok(profile.xrScale >= 0.85 && profile.xrScale <= 1.2);
    assert.ok(profile.foveation >= 0 && profile.foveation <= 1);
    assert.ok(profile.dpr >= 1 && profile.dpr <= 2);
    assert.ok([2, 4, 8].includes(profile.anisotropy));
  }
});

test("high requests more render pixels, lower foveation and stronger photo filtering", () => {
  const { performance, balanced, high } = qualityProfiles;
  assert.ok(performance.xrScale ** 2 < balanced.xrScale ** 2);
  assert.ok(balanced.xrScale ** 2 < high.xrScale ** 2);
  assert.ok(Math.abs(high.xrScale ** 2 / balanced.xrScale ** 2 - 1.44) < 1e-12);
  assert.ok(performance.foveation > balanced.foveation);
  assert.ok(balanced.foveation > high.foveation);
  assert.ok(performance.anisotropy < balanced.anisotropy);
  assert.ok(balanced.anisotropy < high.anisotropy);
});

test("valid choices are stored locally and restored using the exported key", () => {
  const items = new Map();
  const storage = {
    getItem(key) { return items.get(key) ?? null; },
    setItem(key, value) { items.set(key, value); },
  };
  assert.equal(readQuality(storage), qualityProfiles.high);
  assert.equal(saveQuality(storage, "high"), true);
  assert.equal(items.get(QUALITY_STORAGE_KEY), "high");
  assert.equal(readQuality(storage), qualityProfiles.high);
  assert.equal(saveQuality(storage, "invalid"), false);
  assert.equal(readQuality(storage), qualityProfiles.high);
  items.set(QUALITY_STORAGE_KEY, "old-setting");
  assert.equal(readQuality(storage), qualityProfiles.high);
});

test("the new quality key ignores but preserves previous-release choices", () => {
  const oldKey = "okazaki-webxr-quality-v1";
  const items = new Map([[oldKey, "balanced"]]);
  const storage = {
    getItem(key) { return items.get(key) ?? null; },
    setItem(key, value) { items.set(key, value); },
  };
  assert.equal(QUALITY_STORAGE_KEY, "okazaki-webxr-quality-v2");
  assert.equal(readQuality(storage), qualityProfiles.high);
  assert.equal(items.has(QUALITY_STORAGE_KEY), false);
  assert.equal(items.get(oldKey), "balanced");

  for (const id of ["performance", "balanced", "high"]) {
    assert.equal(saveQuality(storage, id), true);
    assert.equal(readQuality(storage), qualityProfiles[id]);
    assert.equal(items.get(oldKey), "balanced");
  }
});

test("missing or inaccessible storage never prevents startup or a setting change", () => {
  for (const storage of [undefined, null, {}, {
    getItem() { throw new Error("SecurityError"); },
    setItem() { throw new Error("QuotaExceededError"); },
  }, new Proxy({}, { get() { throw new Error("Access denied"); } })]) {
    assert.equal(readQuality(storage), qualityProfiles.high);
    assert.equal(saveQuality(storage, "high"), false);
  }
});

test("quality cycling visits all profiles and unknown settings start from high", () => {
  assert.equal(getNextQuality("performance"), qualityProfiles.balanced);
  assert.equal(getNextQuality("balanced"), qualityProfiles.high);
  assert.equal(getNextQuality("high"), qualityProfiles.performance);
  assert.equal(getNextQuality("invalid"), qualityProfiles.performance);
});

test("texture memory estimates count exact rectangular and non-power-of-two mips", () => {
  assert.equal(textureMemoryBytes(2, 2, 4, false), 16);
  assert.equal(textureMemoryBytes(2, 2), 20);
  assert.equal(textureMemoryBytes(4, 2), 44);
  assert.equal(textureMemoryBytes(3, 5), 72);
  assert.equal(textureMemoryBytes(1, 1), 4);
  assert.equal(textureMemoryBytes(4096, 4096), 89_478_484);
});

test("texture memory invalid dimensions and unsafe arithmetic return zero", () => {
  for (const [width, height, channels] of [
    [0, 1, 4], [-1, 1, 4], [1.5, 1, 4], [NaN, 1, 4],
    [1, Infinity, 4], [1, 1, 0], [1, 1, null],
    [Number.MAX_SAFE_INTEGER, 1, 4],
  ]) {
    assert.equal(textureMemoryBytes(width, height, channels), 0);
  }
});
