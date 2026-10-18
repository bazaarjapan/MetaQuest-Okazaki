import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { LIMITS } from '../worker/school-common.mjs';
import { creativeViews, creativeConfig } from '../src/creative-controls.js';
const root = new URL('../',import.meta.url);
const manual = await readFile(new URL('public/manual/index.html',root),'utf8');

test('public classroom manual has both roles and complete same-page navigation',()=>{
  assert.match(manual,/<html lang="ja">/);
  assert.equal((manual.match(/<h1\b/g)??[]).length,1);
  for(const id of ['teacher','student','pc','stl','quest','mobile','trouble','lesson']) {
    assert.match(manual,new RegExp(`id="${id}"`));
    assert.match(manual,new RegExp(`href="#${id}"`));
  }
  const ids=[...manual.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
  assert.equal(new Set(ids).size,ids.length,'unique anchors');
  for(const [,target] of manual.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.includes(target),target);
  assert.match(manual,/このマニュアルはログインせずに読めます/);
});
test('manual is a lightweight first-party page with accessible code-native diagrams',async()=>{
  assert.doesNotMatch(manual,/(?:src|href)="https?:\/\/(?!metaquest001\.gigach\.net)/);
  assert.doesNotMatch(manual,/<script[^>]*>\s*\S[\s\S]*?<\/script>|\bonclick=|type="password"|three|webgl/i);
  assert.match(manual,/<svg[^>]+role="img"[^>]+aria-labelledby=/);
  assert.match(manual,/<title id="placement-title">/);
  assert.match(manual,/<desc id="placement-desc">/);
  for(const path of ['manual.css','manual.js']) await access(new URL('public/manual/'+path,root));
  const css=await readFile(new URL('public/manual/manual.css',root),'utf8');
  assert.match(css,/@media\(max-width:680px\)/);
  assert.match(css,/@media print/);
  assert.match(css,/prefers-reduced-motion/);
  assert.match(css,/:focus-visible/);
});
test('manual documents implemented controls, cloud persistence and quotas',()=>{
  assert.match(manual,/右ドラッグ/); assert.match(manual,/右クリック/); assert.match(manual,/0.8秒長押し/); assert.match(manual,/<kbd>R<\/kbd>/);
  assert.match(manual,/ホイール/); assert.match(manual,/1\.5秒長押し/);
  assert.match(manual,/左スティック：上下＝上昇・下降、左右＝旋回/);
  assert.match(manual,/右スティック：上下＝前進・後退、左右＝横移動/);
  assert.match(manual,/ドローン・モード2が自動で選ばれます/);
  assert.match(manual,/2Dの全画面とVR表示は別/);
  assert.match(manual,/小さいウィンドウでは「メニュー」→「設定」/);
  assert.match(manual,/次回も同じID・パスワード/); assert.match(manual,/全員の作品・位置が巻き戻ります/);
  assert.match(manual,new RegExp(`最大${LIMITS.students}人`));
  assert.match(manual,new RegExp(`最大${LIMITS.userAssets}ファイル`));
  assert.match(manual,new RegExp(`${LIMITS.stlBytes/1024/1024}MiB・2万三角形`));
  assert.match(manual,new RegExp(`合計${LIMITS.userAssetBytes/1024/1024}MiB`));
  assert.match(manual,new RegExp(`高速上昇</strong>（${creativeConfig.fastClimbSpeed}m/s）`));
  assert.deepEqual(creativeViews,['first','back','front']);
  assert.match(manual,/後方 → 前方 → 一人称/);
  assert.match(manual,/実教室30台での速度・Quest実機の快適性を保証するものではありません/);
  assert.doesNotMatch(manual,/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
});
test('manual links are available before login without weakening the activity gate',async()=>{
  const index=await readFile(new URL('index.html',root),'utf8');
  assert.match(index,/<section id="login-gate"[^>]*>[\s\S]*?href="\/manual"[\s\S]*?<\/section>/);
  assert.match(index,/<dialog id="help-dialog">[\s\S]*?href="\/manual"/);
  const old=await readFile(new URL('public/teacher.html',root),'utf8');
  assert.match(old,/href="\/manual"/);
});
