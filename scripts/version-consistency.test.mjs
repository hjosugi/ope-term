import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { verifyVersionConsistency } from "./version-consistency.mjs";

async function fixture(versions) {
  const root = await mkdtemp(join(tmpdir(), "ope-term-version-"));
  await mkdir(join(root, "src-tauri"));
  await Promise.all([
    writeFile(join(root, "package.json"), JSON.stringify({ name: "ope-term", version: versions.npm })),
    writeFile(join(root, "src-tauri/Cargo.toml"), `[package]\nname = "ope-term"\nversion = "${versions.cargo}"\n`),
    writeFile(
      join(root, "src-tauri/Cargo.lock"),
      `[[package]]\nname = "other"\nversion = "9.9.9"\n\n[[package]]\nname = "ope-term"\nversion = "${versions.cargoLock}"\n`,
    ),
    writeFile(join(root, "src-tauri/tauri.conf.json"), JSON.stringify({ version: versions.tauri })),
  ]);
  return root;
}

const matchingVersions = { npm: "1.2.3", cargo: "1.2.3", cargoLock: "1.2.3", tauri: "1.2.3" };

test("accepts matching project versions and release tag", async (t) => {
  const root = await fixture(matchingVersions);
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await verifyVersionConsistency({ root, tag: "v1.2.3" });
  assert.equal(result.version, "1.2.3");
});

test("rejects a version mismatch", async (t) => {
  const root = await fixture({ ...matchingVersions, cargoLock: "1.2.2" });
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(() => verifyVersionConsistency({ root }), /project versions do not match/);
});

test("rejects a tag mismatch", async (t) => {
  const root = await fixture(matchingVersions);
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    () => verifyVersionConsistency({ root, tag: "v1.2.4" }),
    /release tag v1\.2\.4 does not match version v1\.2\.3/,
  );
});
