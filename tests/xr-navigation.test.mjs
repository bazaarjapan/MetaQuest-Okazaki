import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { horizontalViewAxes, createXRFlightStart, armXRFlightStart, cancelXRFlightStart, pollXRFlightStart } from "../src/xr-navigation.js";

const quaternion = (yaw, pitch = 0, roll = 0) => new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, "YXZ"));
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
test("view-relative axes follow head yaw and remain horizontal, normalized and orthogonal", () => {
  for (const yaw of [0, .5, -1, Math.PI / 2, Math.PI, -Math.PI]) {
    for (const pitch of [0, .9, -.9, 1.5]) {
      const axes = horizontalViewAxes(quaternion(yaw, pitch, .4));
      close(axes.forward[0], -Math.sin(yaw)); close(axes.forward[2], -Math.cos(yaw));
      close(axes.forward[1], 0); close(axes.right[1], 0);
      close(Math.hypot(...axes.forward), 1); close(Math.hypot(...axes.right), 1);
      close(axes.forward.reduce((n, v, i) => n + v * axes.right[i], 0), 0);
    }
  }
});
test("vertical gaze retains prior heading instead of noise, slow travel or climbing", () => {
  for (const pitch of [Math.PI / 2, -Math.PI / 2, Math.PI / 2 - .001]) {
    const axes = horizontalViewAxes(quaternion(1.7, pitch), .65);
    close(axes.yaw, .65); close(Math.hypot(...axes.forward), 1); close(axes.forward[1], 0);
  }
});
test("view axes normalize quaternions and reject malformed orientation safely", () => {
  const scaled = quaternion(.7); for (const key of ["x", "y", "z", "w"]) scaled[key] *= 4;
  close(horizontalViewAxes(scaled).yaw, .7);
  for (const bad of [null, {}, {x:NaN,y:0,z:0,w:1}, {x:0,y:0,z:0,w:0}]) {
    close(horizontalViewAxes(bad, .4).yaw, .4);
  }
  close(horizontalViewAxes(null, NaN).yaw, 0);
});
const source = handedness => ({ handedness, gamepad: { axes: [0,0,0,0], buttons: [{pressed:false}] } });
function fixture() {
  const start = createXRFlightStart(); armXRFlightStart(start);
  return { start, frame: { allowed:true, ready:true, visible:true, poseReady:true, trackedHands:["left","right"], sources:[source("left"),source("right")] } };
}
test("VR entry and explicit re-entry start once with valid neutral tracked controllers", () => {
  const { start, frame } = fixture();
  assert.equal(pollXRFlightStart(start, frame), true);
  assert.equal(pollXRFlightStart(start, frame), false);
  armXRFlightStart(start); assert.equal(pollXRFlightStart(start, frame), true);
});
test("startup waits for pose, readiness, both controllers and release of held sticks/buttons", () => {
  const { start, frame } = fixture();
  for (const patch of [{poseReady:false},{ready:false},{sources:[]},{sources:[source("left")]}]) {
    assert.equal(pollXRFlightStart(start,{...frame,...patch}),false); assert.equal(start.pending,true);
  }
  frame.sources[1].gamepad.axes[3] = -.6;
  assert.equal(pollXRFlightStart(start,frame),false);
  frame.sources[1].gamepad.axes[3] = .05; // Deadzone is neutral.
  frame.sources[0].gamepad.buttons[0].pressed = true;
  assert.equal(pollXRFlightStart(start,frame),false);
  frame.sources[0].gamepad.buttons[0].pressed = false;
  assert.equal(pollXRFlightStart(start,frame),true);
});
test("auth/visibility loss or an explicit safety stop cancel startup without automatic restart", () => {
  for (const patch of [{allowed:false},{visible:false}]) {
    const { start, frame } = fixture(); assert.equal(pollXRFlightStart(start,{...frame,...patch}),false);
    assert.equal(pollXRFlightStart(start,frame),false); assert.equal(start.pending,false);
  }
  const { start, frame } = fixture(); cancelXRFlightStart(start);
  assert.equal(pollXRFlightStart(start,frame),false);
});
test("connected gamepads without current poses cancel automatic start, even after tracking returns", () => {
  for (const trackedHands of [[],["left"],["right"]]) {
    const { start, frame } = fixture();
    assert.equal(pollXRFlightStart(start,{...frame,trackedHands}),false);
    assert.equal(start.pending,false);
    assert.equal(pollXRFlightStart(start,frame),false);
  }
});
test("head tracking lost while waiting for neutral input cancels the pending automatic start", () => {
  const { start, frame } = fixture(); frame.sources[1].gamepad.axes[3] = -1;
  assert.equal(pollXRFlightStart(start,frame),false); assert.equal(start.pending,true);
  assert.equal(pollXRFlightStart(start,{...frame,poseReady:false}),false);
  frame.sources[1].gamepad.axes[3] = 0;
  assert.equal(pollXRFlightStart(start,frame),false); assert.equal(start.pending,false);
});
