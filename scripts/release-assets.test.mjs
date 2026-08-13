import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { stageReleaseAssets } from "./release-assets.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ope-term-release-assets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(join(root, "input/linux"), { recursive: true }),
    mkdir(join(root, "input/windows"), { recursive: true }),
  ]);
  return root;
}

test("flattens workflow artifacts and checksums the published names", async (t) => {
  const root = await fixture(t);
  await Promise.all([
    writeFile(join(root, "input/linux/ope-term.deb"), "linux bundle"),
    writeFile(join(root, "input/windows/ope-term.msi"), "windows bundle"),
  ]);

  const result = await stageReleaseAssets(join(root, "input"), join(root, "output"));
  assert.deepEqual(result.assets, ["ope-term.deb", "ope-term.msi"]);
  assert.deepEqual((await readdir(join(root, "output"))).sort(), [
    "SHA256SUMS",
    "ope-term.deb",
    "ope-term.msi",
  ]);

  const expectedHash = createHash("sha256").update("linux bundle").digest("hex");
  const checksums = await readFile(join(root, "output/SHA256SUMS"), "utf8");
  assert.match(checksums, new RegExp(`^${expectedHash}  ope-term\\.deb$`, "m"));
  assert.doesNotMatch(checksums, /linux\//u);
});

test("rejects artifact basenames that would collide on a GitHub Release", async (t) => {
  const root = await fixture(t);
  await Promise.all([
    writeFile(join(root, "input/linux/ope-term.bin"), "linux"),
    writeFile(join(root, "input/windows/ope-term.bin"), "windows"),
  ]);

  await assert.rejects(
    () => stageReleaseAssets(join(root, "input"), join(root, "output")),
    /duplicate release asset basename: ope-term\.bin/u,
  );
});
