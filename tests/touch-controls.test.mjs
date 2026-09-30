import { test } from "node:test";
import assert from "node:assert/strict";
import { createTouchControls, normalizeTouchPoint } from "../src/touch-controls.js";

class FakeElement extends EventTarget {
  constructor(document) {
    super();
    this.ownerDocument = document;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.captured = new Set();
    this.rect = { left: 10, top: 20, width: 100, height: 100 };
  }
  append(...elements) {
    for (const element of elements) {
      element.parent = this;
      this.children.push(element);
    }
  }
  remove() {
    this.parent.children = this.parent.children.filter((element) => element !== this);
    this.parent = null;
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  getBoundingClientRect() { return this.rect; }
  setPointerCapture(id) { this.captured.add(id); }
  hasPointerCapture(id) { return this.captured.has(id); }
  releasePointerCapture(id) {
    this.captured.delete(id);
    this.dispatchEvent(pointer("lostpointercapture", id, 60, 70));
  }
}

function fixture(options) {
  const window = new EventTarget();
  const document = new EventTarget();
  document.defaultView = window;
  document.createElement = () => new FakeElement(document);
  const viewport = new FakeElement(document);
  const controls = createTouchControls(viewport, options);
  const container = viewport.children[0];
  const [left, right] = container.children;
  return { controls, container, left, right, window, document, viewport };
}

function pointer(type, pointerId, clientX = 60, clientY = 70, button = 0) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { pointerId, clientX, clientY, button });
  return event;
}

function close(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-12); }

test("touch normalization matches raw Mode 2 signs and returns zero at center", () => {
  const rect = { left: 10, top: 20, width: 100, height: 100 };
  assert.deepEqual(normalizeTouchPoint(rect, 60, 70), [0, 0]);
  assert.deepEqual(normalizeTouchPoint(rect, 60, 20), [0, -1]);
  assert.deepEqual(normalizeTouchPoint(rect, 110, 70), [1, 0]);
  assert.deepEqual(normalizeTouchPoint(rect, 60, 95), [0, 0.5]);
});

test("touch normalization clamps diagonal travel to one and rejects invalid points", () => {
  const axes = normalizeTouchPoint({ left: 0, top: 0, width: 100, height: 100 }, 150, -50);
  close(axes[0], Math.SQRT1_2);
  close(axes[1], -Math.SQRT1_2);
  close(Math.hypot(...axes), 1);
  assert.deepEqual(normalizeTouchPoint({ left: 0, top: 0, width: 0, height: 1 }, 0, 0), [0, 0]);
  assert.deepEqual(normalizeTouchPoint({ left: 0, top: 0, width: 1, height: 1 }, NaN, 0), [0, 0]);
  assert.deepEqual(normalizeTouchPoint(null, 0, 0), [0, 0]);
});

test("controls start hidden and inert until the caller enables free flight", () => {
  const { controls, container, left, right } = fixture();
  assert.equal(container.hidden, true);
  left.dispatchEvent(pointer("pointerdown", 1, 110, 70));
  assert.deepEqual(controls.getAxes(), { left: [0, 0], right: [0, 0] });
  controls.setEnabled(true);
  assert.equal(container.hidden, false);
  assert.equal(left.style.touchAction, "none");
  assert.equal(right.style.touchAction, "none");
  assert.equal(container.style.touchAction, undefined);
});

test("each stick captures its own finger and both can move simultaneously", () => {
  const { controls, left, right } = fixture();
  controls.setEnabled(true);
  left.dispatchEvent(pointer("pointerdown", 3, 60, 20));
  right.dispatchEvent(pointer("pointerdown", 4, 110, 70));
  assert.deepEqual(controls.getAxes(), { left: [0, -1], right: [1, 0] });
  assert.equal(left.hasPointerCapture(3), true);
  assert.equal(right.hasPointerCapture(4), true);
  assert.equal(controls.getState().activePointers, 2);
  left.dispatchEvent(pointer("pointermove", 3, 85, 70));
  assert.deepEqual(controls.getAxes(), { left: [0.5, 0], right: [1, 0] });
  assert.match(left.children[1].style.transform, /translate\(25px, 0px\)/);
});

test("a second finger cannot steal or release an occupied stick", () => {
  const { controls, left } = fixture();
  controls.setEnabled(true);
  left.dispatchEvent(pointer("pointerdown", 3, 60, 20));
  left.dispatchEvent(pointer("pointerdown", 5, 60, 120));
  left.dispatchEvent(pointer("pointermove", 5, 60, 120));
  left.dispatchEvent(pointer("pointerup", 5));
  assert.deepEqual(controls.getAxes().left, [0, -1]);
  assert.equal(controls.getState().pointers.left, 3);
});

for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
  test(`${type} stops that stick immediately without clearing the other stick`, () => {
    const { controls, left, right } = fixture();
    controls.setEnabled(true);
    left.dispatchEvent(pointer("pointerdown", 3, 60, 20));
    right.dispatchEvent(pointer("pointerdown", 4, 110, 70));
    left.dispatchEvent(pointer(type, 3));
    assert.deepEqual(controls.getAxes(), { left: [0, 0], right: [1, 0] });
    assert.equal(controls.getState().pointers.left, null);
  });
}

for (const [target, type] of [["window", "blur"], ["window", "resize"], ["window", "orientationchange"], ["document", "visibilitychange"]]) {
  test(`${type} releases both touches, preventing stuck movement`, () => {
    const context = fixture();
    context.controls.setEnabled(true);
    context.left.dispatchEvent(pointer("pointerdown", 3, 60, 20));
    context.right.dispatchEvent(pointer("pointerdown", 4, 110, 70));
    context[target].dispatchEvent(new Event(type));
    assert.deepEqual(context.controls.getAxes(), { left: [0, 0], right: [0, 0] });
    assert.equal(context.controls.getState().activePointers, 0);
  });
}

test("disabling clears ownership and cannot revive a previously captured pointer", () => {
  const { controls, left } = fixture();
  controls.setEnabled(true);
  left.dispatchEvent(pointer("pointerdown", 3, 60, 20));
  controls.setEnabled(false);
  controls.setEnabled(true);
  left.dispatchEvent(pointer("pointermove", 3, 60, 20));
  assert.deepEqual(controls.getAxes().left, [0, 0]);
  assert.equal(controls.getState().activePointers, 0);
});

test("failed capture still receives movement and release through window fallback", () => {
  const { controls, left, window } = fixture();
  left.setPointerCapture = () => { throw new Error("capture unavailable"); };
  controls.setEnabled(true);
  left.dispatchEvent(pointer("pointerdown", 3));
  window.dispatchEvent(pointer("pointermove", 3, 60, 20));
  assert.deepEqual(controls.getAxes().left, [0, -1]);
  window.dispatchEvent(pointer("pointerup", 3));
  assert.deepEqual(controls.getAxes().left, [0, 0]);
});

test("unowned pointers outside the pads preserve ordinary browser gestures", () => {
  const { controls, window } = fixture();
  controls.setEnabled(true);
  const event = pointer("pointermove", 44, 100, 100);
  window.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);
});

test("axis copies and frozen diagnostics cannot mutate live input", () => {
  const { controls, left } = fixture();
  controls.setEnabled(true);
  left.dispatchEvent(pointer("pointerdown", 3, 60, 20));
  const axes = controls.getAxes();
  axes.left[1] = 0;
  assert.deepEqual(controls.getAxes().left, [0, -1]);
  assert.throws(() => { controls.getState().axes.left[1] = 0; }, TypeError);
});

test("dispose neutralizes input, removes DOM and detaches lifecycle listeners", () => {
  let calls = 0;
  const { controls, left, window, viewport } = fixture({ onActivity: () => { calls += 1; } });
  controls.setEnabled(true);
  left.dispatchEvent(pointer("pointerdown", 3, 60, 20));
  controls.dispose();
  const afterDispose = calls;
  window.dispatchEvent(new Event("blur"));
  left.dispatchEvent(pointer("pointerdown", 7, 60, 20));
  controls.setEnabled(true);
  controls.dispose();
  assert.equal(calls, afterDispose);
  assert.equal(viewport.children.length, 0);
  assert.equal(controls.getState().disposed, true);
  assert.equal(controls.getState().enabled, false);
  assert.deepEqual(controls.getAxes(), { left: [0, 0], right: [0, 0] });
});
