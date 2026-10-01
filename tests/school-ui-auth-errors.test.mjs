import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// Run the actual public error formatter; CSS/DOM/GIS are not needed to format.
const source = (await readFile(new URL("../src/school-ui.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
const context = vm.createContext({ createGoogleIdentityLoader: () => () => {}, URL });
vm.runInContext(`${source}\nthis.explain = explainSchoolError;`, context);
const explain = value => context.explain(value);
const generic = explain({ code: "unknown_future_error" });

test("Google key retrieval failure has a precise safe retry message", () => {
  const message = explain({ code: "google_keys_unavailable" });
  assert.notEqual(message, generic); assert.match(message, /公開鍵.*取得/); assert.match(message, /1分.*Googleログインを表示/);
});
test("expired/missing preparation and rejected identity distinguish their recovery instructions", () => {
  const cases = {
    login_challenge_required: /準備情報.*Cookie/,
    login_challenge_expired: /期限切れ.*使用済み/,
    invalid_token: /ログイン情報.*アカウントを選び直/,
    invalid_origin: /https:\/\/metaquest001\.gigach\.net\//,
    login_cancelled: /アカウントの状態/,
    login_failed: /通信/,
  };
  for (const [code, expected] of Object.entries(cases)) {
    const message = explain({ code });
    assert.notEqual(message, generic); assert.match(message, expected);
    assert.equal(explain(new Error(code)), message); assert.equal(explain(code), message);
  }
});
test("unrecognized errors remain generic instead of displaying provider or exception details", () => {
  assert.equal(explain(new Error("private-provider-diagnostic")), generic);
  assert.equal(explain({ code: "untrusted-code", message: "private-provider-diagnostic" }), generic);
});
