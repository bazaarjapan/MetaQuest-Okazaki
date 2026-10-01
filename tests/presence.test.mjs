import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createSchoolPresence, eyeToFeet, interpolateYaw, remoteParticipants,
  presenceColor, presenceLabel, presenceLimits } from "../src/school-presence.js";

function participant(id, extra = {}) {
  return { id, name: `生徒-${id}`, color: "#2ecc71", role: "student", position: [1, 21.65, 3], yaw: 0, ...extra };
}
function fixture() {
  let state = { user: { id: "own", role: "student" }, world: { id: "class-1" },
    connection: "connected", participants: [participant("own"), participant("other")] };
  const listeners = new Set();
  const client = { getState: () => state, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } };
  const scene = new THREE.Scene();
  const presence = createSchoolPresence(THREE, { scene, client, documentTarget: null });
  return { presence, scene, client, listeners, state: () => state,
    set(value) { state = { ...state, ...value }; for (const listener of listeners) listener(state); } };
}
function near(a, b, epsilon = 1e-7) { assert.ok(Math.abs(a - b) < epsilon, `${a} != ${b}`); }

test("remote feet derive from signed eye pose without harvesting profile/email names", () => {
  assert.deepEqual(eyeToFeet([5, 20, 10]), [5, 18.35, 10]);
  for (const invalid of [null, [1, 2], [NaN, 2, 3], [0, Infinity, 0], [1e8, 2, 3]]) assert.equal(eyeToFeet(invalid), null);
  assert.equal(presenceLabel("person@example.com"), "参加者");
  assert.equal(presenceLabel("<nick>\u0000"), "nick");
  assert.equal([...presenceLabel("あ".repeat(100))].length, presenceLimits.labelCharacters);
  assert.equal(presenceColor("#ABCDEF"), "#ABCDEF");
  assert.equal(presenceColor("url(javascript:bad)"), "#4a90e2");
});

test("presence excludes local identity, duplicates, malformed poses and caps valid remote participants at 30", () => {
  const state = { user: { id: "own" }, world: { id: "class" }, connection: "connected",
    participants: [participant("own"), participant("bad", { position: [1, NaN, 3] }),
      participant("dup"), participant("dup"), ...Array.from({ length: 35 }, (_, i) => participant(`remote-${i}`))] };
  const values = remoteParticipants(state);
  assert.equal(values.length, 30); assert.equal(new Set(values.map((entry) => entry.id)).size, 30);
  assert.ok(!values.some((entry) => ["own", "bad"].includes(entry.id)));
  for (const extra of [{ user: null }, { world: null }, { connection: "reconnecting" }]) {
    assert.deepEqual(remoteParticipants({ ...state, ...extra }), []);
  }
});

test("yaw interpolation follows shortest arc around +/-pi", () => {
  near(Math.abs(interpolateYaw(Math.PI - 0.05, -Math.PI + 0.05, 0.5)), Math.PI);
  near(interpolateYaw(0, 1, 0), 0); near(interpolateYaw(0, 1, 1), 1);
  near(interpolateYaw(0, 1, 2), 1); assert.equal(interpolateYaw(NaN, 1, 1), 0);
});

test("other avatar smooths to latest eye pose; very large teleports snap rather than traversing a classroom", () => {
  const f = fixture();
  assert.equal(f.presence.getState().count, 1); assert.deepEqual(f.presence.getState().actors[0].position, [1, 20, 3]);
  f.set({ participants: [participant("other", { position: [11, 21.65, 3], yaw: 0.5 })] });
  assert.equal(f.presence.getState().actors[0].position[0], 1);
  f.presence.update(0.05);
  const after = f.presence.getState().actors[0];
  assert.ok(after.position[0] > 1 && after.position[0] < 11); assert.ok(after.yaw > 0 && after.yaw < 0.5);
  for (let i = 0; i < 30; i++) f.presence.update(0.1);
  near(f.presence.getState().actors[0].position[0], 11);
  f.set({ participants: [participant("other", { position: [1000, 31.65, 8], yaw: -1 })] });
  assert.deepEqual(f.presence.getState().actors[0].position, [1000, 30, 8]);
  assert.equal(f.presence.getState().actors[0].yaw, -1);
  f.presence.dispose();
});

test("logout, leave, disconnect and world change remove old avatar geometry and unsubscribe once", () => {
  for (const next of [{ user: null }, { world: null }, { connection: "offline" }]) {
    const f = fixture(), actor = f.presence.group.children[0];
    let disposed = 0; actor.children.find((child) => child.isMesh).geometry.addEventListener("dispose", () => disposed++);
    f.set(next); assert.equal(f.presence.getState().count, 0); assert.equal(disposed, 1);
    assert.equal(f.presence.group.visible, false); f.presence.dispose(); f.presence.dispose();
    assert.equal(f.listeners.size, 0); assert.equal(f.scene.children.length, 0);
  }
  const f = fixture(), old = f.presence.group.children[0];
  f.set({ world: { id: "class-2" }, participants: [participant("other")] });
  assert.notEqual(f.presence.group.children[0], old); assert.equal(old.parent, null);
  assert.equal(f.presence.getState().count, 1); f.presence.dispose();
});

test("avatar nickname and approved color updates are bounded; snapshot cannot mutate renderer position", () => {
  const f = fixture(), old = f.presence.group.children[0];
  f.set({ participants: [participant("other", { color: "#e67e22", name: "myNickname" })] });
  assert.notEqual(f.presence.group.children[0], old);
  const view = f.presence.getState(); assert.equal(view.actors[0].name, "myNickname");
  assert.equal(view.actors[0].color, "#e67e22"); view.actors[0].position[0] = 999;
  assert.equal(f.presence.getState().actors[0].position[0], 1); f.presence.dispose();
});

