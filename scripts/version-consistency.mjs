#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function packageVersionFromCargoLock(text, packageName) {
  for (const block of text.split("[[package]]")) {
    const name = block.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    if (name !== packageName) continue;
    return block.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  }
  return undefined;
}

function packageVersionFromCargoToml(text) {
  const packageBlock = text.match(/(?:^|\n)\[package\]\s*\n([\s\S]*?)(?=\n\[|$)/)?.[1];
  return packageBlock?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
}

export async function readProjectVersions(root = process.cwd()) {
  const [packageText, cargoText, cargoLockText, tauriText] = await Promise.all([
    readFile(resolve(root, "package.json"), "utf8"),
    readFile(resolve(root, "src-tauri/Cargo.toml"), "utf8"),
    readFile(resolve(root, "src-tauri/Cargo.lock"), "utf8"),
    readFile(resolve(root, "src-tauri/tauri.conf.json"), "utf8"),
  ]);

  const packageJson = JSON.parse(packageText);
  const tauriConfig = JSON.parse(tauriText);
  return {
    npm: packageJson.version,
    cargo: packageVersionFromCargoToml(cargoText),
    cargoLock: packageVersionFromCargoLock(cargoLockText, packageJson.name),
    tauri: tauriConfig.version,
  };
}

export async function verifyVersionConsistency({ root = process.cwd(), tag } = {}) {
  const versions = await readProjectVersions(root);
  const entries = Object.entries(versions);
  const missing = entries.filter(([, version]) => typeof version !== "string");
  if (missing.length > 0) {
    throw new Error(`version not found in: ${missing.map(([source]) => source).join(", ")}`);
  }

  const expected = versions.tauri;
  if (!VERSION_PATTERN.test(expected)) {
    throw new Error(`invalid semantic version in Tauri config: ${expected}`);
  }

  const mismatches = entries.filter(([, version]) => version !== expected);
  if (mismatches.length > 0) {
    const detail = entries.map(([source, version]) => `${source}=${version}`).join(", ");
    throw new Error(`project versions do not match: ${detail}`);
  }

  if (tag !== undefined && tag !== `v${expected}`) {
    throw new Error(`release tag ${tag} does not match version v${expected}`);
  }

  return { version: expected, versions, tag };
}

function parseTag(argv, env) {
  const tagIndex = argv.indexOf("--tag");
  if (tagIndex >= 0) {
    if (!argv[tagIndex + 1]) throw new Error("--tag requires a value");
    return argv[tagIndex + 1];
  }
  return env.GITHUB_REF_TYPE === "tag" ? env.GITHUB_REF_NAME : undefined;
}

async function main() {
  const result = await verifyVersionConsistency({ tag: parseTag(process.argv.slice(2), process.env) });
  const suffix = result.tag ? ` and tag ${result.tag}` : "";
  console.log(`version ${result.version} is consistent across npm, Cargo, Cargo.lock and Tauri${suffix}`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
