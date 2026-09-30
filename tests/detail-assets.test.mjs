import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { checkDetailAssets } from "../scripts/check-detail-assets.mjs";

const source = new URL("../public/city/", import.meta.url);
const script = fileURLToPath(new URL("../scripts/check-detail-assets.mjs", import.meta.url));
const run = promisify(execFile);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "okazaki-detail-assets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["detail.json", "Texture-001.png", "terrain-standard.webp", "terrain-high.webp"]) {
    await copyFile(new URL(name, source), join(root, name));
  }
  const detail = JSON.parse(await readFile(join(root, "detail.json"), "utf8"));
  return {
    root,
    detail,
    save: () => writeFile(join(root, "detail.json"), JSON.stringify(detail)),
  };
}

test("repository-only detail checks preserve all Web checks and report native source unverified", async (t) => {
  const f = await fixture(t);
  const result = await checkDetailAssets({ root: f.root });
  assert.equal(result.ok, true);
  assert.equal(result.nativeSourceVerified, false);
  assert.equal(result.uvSamples, 54);
  assert.deepEqual(result.profiles.map(p => [p.id, p.size, p.verified]), [
    ["standard", [1536, 1024], true],
    ["high", [3072, 2048], true],
  ]);
});

test("repository-only CLI succeeds without requiring any external Unity source", async () => {
  const { stdout } = await run(process.execPath, [script]);
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.nativeSourceVerified, false);
  assert.equal(result.profiles.length, 2);
});

test("detail CLI rejects unknown and duplicate arguments instead of silently skipping source checks", async () => {
  for (const args of [["--with-native-sorce"], ["--with-native-source", "--with-native-source"], ["--root", "elsewhere"]]) {
    await assert.rejects(run(process.execPath, [script, ...args]), error => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /Usage: node scripts\/check-detail-assets\.mjs/);
      return true;
    });
  }
});

test("Web PNG byte corruption is rejected by its recorded SHA-256 before decoding", async (t) => {
  const f = await fixture(t);
  const path = join(f.root, f.detail.originalAtlas.file);
  const bytes = await readFile(path);
  bytes[bytes.length - 1] ^= 1;
  await writeFile(path, bytes);
  await assert.rejects(checkDetailAssets({ root: f.root }), /Web atlas SHA-256 mismatch/);
});

test("decoded Web RGB digest mismatch is rejected", async (t) => {
  const f = await fixture(t);
  f.detail.uvValidation.decodedPixelSha256 = "0".repeat(64);
  await f.save();
  await assert.rejects(checkDetailAssets({ root: f.root }), /Decoded Web atlas RGB SHA-256 mismatch/);
});

test("decoded Web RGB channel count mismatch is rejected", async (t) => {
  const f = await fixture(t);
  f.detail.uvValidation.decodedChannelsCompared += 1;
  await f.save();
  await assert.rejects(checkDetailAssets({ root: f.root }), { code: "ERR_ASSERTION" });
});

test("recorded Web atlas dimensions must match the actual PNG", async (t) => {
  const f = await fixture(t);
  f.detail.originalAtlas.width += 1;
  await f.save();
  await assert.rejects(checkDetailAssets({ root: f.root }), { code: "ERR_ASSERTION" });
});

for (const [name, value] of [
  ["samples", 53],
  ["channelsCompared", 161],
  ["exactPixelEquality", false],
  ["webAtlasExactPixelEquality", false],
]) {
  test(`UV validation record ${name} remains enforced in repository-only mode`, async (t) => {
    const f = await fixture(t);
    f.detail.uvValidation[name] = value;
    await f.save();
    await assert.rejects(checkDetailAssets({ root: f.root }), { code: "ERR_ASSERTION" });
  });
}

test("native verification explicitly requested with a missing source must fail", async (t) => {
  const f = await fixture(t);
  await assert.rejects(checkDetailAssets({
    root: f.root,
    nativeAtlasUrl: join(f.root, "missing-native-source.png"),
  }), { code: "ENOENT" });
});

test("native source byte digest mismatch must fail even with identical RGB", async (t) => {
  const f = await fixture(t);
  const nativeAtlasUrl = join(f.root, "native-source.png");
  await copyFile(join(f.root, f.detail.originalAtlas.file), nativeAtlasUrl);
  f.detail.uvValidation.nativeSourceAtlasSha256 = "0".repeat(64);
  await f.save();
  await assert.rejects(checkDetailAssets({ root: f.root, nativeAtlasUrl }), /Native source atlas SHA-256 mismatch/);
});

test("native source with its recorded bytes and identical RGB is explicitly verified", async (t) => {
  const f = await fixture(t);
  const webAtlasBytes = await readFile(join(f.root, f.detail.originalAtlas.file));
  const nativeAtlasBytes = await sharp(webAtlasBytes).removeAlpha().png({ compressionLevel: 0 }).toBuffer();
  assert.notEqual(hash(nativeAtlasBytes), hash(webAtlasBytes), "Fixture must exercise different PNG encodings");
  const nativeAtlasUrl = join(f.root, "native-source.png");
  await writeFile(nativeAtlasUrl, nativeAtlasBytes);
  f.detail.uvValidation.nativeSourceAtlasSha256 = hash(nativeAtlasBytes);
  await f.save();
  const result = await checkDetailAssets({ root: f.root, nativeAtlasUrl });
  assert.equal(result.nativeSourceVerified, true);
  assert.equal(result.profiles.length, 2);
});

test("native source with a valid byte digest but different RGB must fail", async (t) => {
  const f = await fixture(t);
  const { data, info } = await sharp(join(f.root, f.detail.originalAtlas.file)).removeAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  data[0] ^= 255;
  const nativeAtlasBytes = await sharp(data, { raw: info }).png().toBuffer();
  const nativeAtlasUrl = join(f.root, "native-source.png");
  await writeFile(nativeAtlasUrl, nativeAtlasBytes);
  f.detail.uvValidation.nativeSourceAtlasSha256 = hash(nativeAtlasBytes);
  await f.save();
  await assert.rejects(checkDetailAssets({ root: f.root, nativeAtlasUrl }),
    /Native and Web atlas encodings must decode to identical RGB pixels/);
});

for (const id of ["standard", "high"]) {
  test(`${id} profile byte length remains enforced`, async (t) => {
    const f = await fixture(t);
    f.detail.profiles[id].bytes += 1;
    await f.save();
    await assert.rejects(checkDetailAssets({ root: f.root }), new RegExp(`${id} profile byte length mismatch`));
  });

  test(`${id} profile SHA-256 remains enforced`, async (t) => {
    const f = await fixture(t);
    f.detail.profiles[id].sha256 = "0".repeat(64);
    await f.save();
    await assert.rejects(checkDetailAssets({ root: f.root }), new RegExp(`${id} profile SHA-256 mismatch`));
  });

  test(`${id} profile image dimensions remain enforced`, async (t) => {
    const f = await fixture(t);
    f.detail.profiles[id].height += 1;
    await f.save();
    await assert.rejects(checkDetailAssets({ root: f.root }), { code: "ERR_ASSERTION" });
  });

  test(`${id} profile extent and tile counts remain enforced`, async (t) => {
    const f = await fixture(t);
    f.detail.profiles[id].extent.xMin += 1;
    await f.save();
    await assert.rejects(checkDetailAssets({ root: f.root }), { code: "ERR_ASSERTION" });
    f.detail.profiles[id].extent.xMin -= 1;
    f.detail.profiles[id].cachedTiles += 1;
    await f.save();
    await assert.rejects(checkDetailAssets({ root: f.root }), { code: "ERR_ASSERTION" });
  });
}
