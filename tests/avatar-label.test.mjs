import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { avatarNickname, createAvatarLabel } from "../src/avatar-label.js";
import { avatarAppearance } from "../src/block-avatar.js";

test("shared nicknames keep Japanese and whole emoji while rejecting email and invisible controls", () => {
  assert.equal(avatarNickname(" 岡崎の生徒 🌸 "), "岡崎の生徒 🌸");
  const emoji = "👩‍🚀"; assert.equal(avatarNickname(emoji.repeat(30)), emoji.repeat(20));
  for (const value of [null, "", " \u0085\u202e\u2066\u200b\u061c", "person@example.com", "person＠example.com", "生徒-ab\u202e12", "12345678-abcd-1234-abcd-123456789abc"]) assert.equal(avatarNickname(value), "参加者");
  assert.equal(avatarNickname("<script>\n名前\u202e"), "script名前");
});

test("billboard is reused, width truncates whole graphemes without squeezing, and resources dispose once", () => {
  const writes = [], context = { measureText: (text) => ({ width: [...text].length * 28 }),
    clearRect() {}, fillRect() {}, fillText: (...args) => writes.push(args) };
  const parent = new THREE.Group();
  const label = createAvatarLabel(THREE, { parent, documentTarget: { createElement: () => ({ getContext: () => context }) } });
  label.setName("長い日本語の表示名です🌸"); label.setName("長い日本語の表示名です🌸");
  assert.equal(writes.length, 1); assert.equal(writes[0].length, 3); assert.ok(writes[0][0].endsWith("…"));
  assert.equal(parent.children.length, 1); assert.equal(parent.children[0].material.depthTest, true);
  label.setName("新しい名前"); assert.equal(parent.children.length, 1); assert.equal(writes.length, 2);
  let disposed = 0; parent.children[0].material.map.addEventListener("dispose", () => disposed++);
  label.dispose(); label.dispose(); label.setName("古い名前"); assert.equal(disposed, 1);
  assert.equal(parent.children.length, 0); assert.equal(label.getState().count, 0);
});

test("opaque identities provide multiple colors, hair silhouettes and clothing patterns deterministically", () => {
  const looks = Array.from({ length: 100 }, (_, i) => avatarAppearance(`fixture-${i}`));
  for (const key of ["accent", "hairStyle", "pattern"]) assert.ok(new Set(looks.map((look) => look[key])).size >= 3);
  assert.deepEqual(avatarAppearance("fixture-17"), looks[17]);
});
