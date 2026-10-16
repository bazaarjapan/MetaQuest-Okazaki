import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
const source=(await readFile(new URL("../src/hotbar.js",import.meta.url),"utf8")).replace(/^import .*;\r?\n/gm,"").replace(/^export /gm,"");
const api=vm.runInNewContext(source+"\n({hotbarSlot,retrievalHoldMs})");
test("number row 1 through 0 maps exactly to ten distinct slots",()=>{
  assert.deepEqual([1,2,3,4,5,6,7,8,9,0].map(n=>api.hotbarSlot(`Digit${n}`)),[0,1,2,3,4,5,6,7,8,9]);
  for(const key of ["KeyW","Escape","Digit10","Numpad1","F5",""]) assert.equal(api.hotbarSlot(key),-1);
});
test("retrieval requires a deliberate hold, not an ordinary right click",()=>{
  assert.equal(api.retrievalHoldMs,700);
});
