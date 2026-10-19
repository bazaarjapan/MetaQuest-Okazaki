import test from "node:test";
import assert from "node:assert/strict";
import { validSTLColor, stlColor, describeWorkLocation } from "../src/workshop-presentation.js";

test("STL color validates finite hex colors and preserves legacy blue", () => {
  for (const value of [null, undefined, "red", "#fff", "#123456;", {}, 123]) assert.equal(validSTLColor(value), false);
  assert.equal(stlColor(), "#488caa"); assert.equal(stlColor("#FF8800"), "#ff8800");
});
test("work location describes direction and horizontal distance, not altitude", () => {
  assert.match(describeWorkLocation([110,500,220], { x:110,z:220 }, [10,0,20]), /東 100 m.*南 200 m.*距離 0 m/);
  assert.match(describeWorkLocation([0,0,0], { x:3,z:4 }, null), /距離 5 m/);
});
