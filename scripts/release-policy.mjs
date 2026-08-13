#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function pngDimensions(bytes, label) {
  requireValue(bytes.length >= 24, `${label} is too small to be a PNG`);
  requireValue(bytes.subarray(0, 8).equals(PNG_SIGNATURE), `${label} has an invalid PNG signature`);
  requireValue(bytes.subarray(12, 16).toString("ascii") === "IHDR", `${label} has no IHDR chunk`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function requireWorkflowFragment(workflow, fragment, description) {
  requireValue(workflow.includes(fragment), `release workflow is missing ${description}`);
}

export async function verifyReleasePolicy(root = process.cwd()) {
  const tauriRoot = resolve(root, "src-tauri");
  const [configText, workflow, justfile] = await Promise.all([
    readFile(resolve(tauriRoot, "tauri.conf.json"), "utf8"),
    readFile(resolve(root, ".github/workflows/release.yml"), "utf8"),
    readFile(resolve(root, "Justfile"), "utf8"),
  ]);
  const config = JSON.parse(configText);
  const icons = config.bundle?.icon;

  requireValue(config.bundle?.active === true, "Tauri bundle.active must stay enabled");
  requireValue(config.bundle?.targets === "all", "Tauri bundle.targets must cover all configured targets");
  requireValue(Array.isArray(icons) && icons.length > 0, "Tauri bundle.icon must not be empty");

  const pngSizes = new Set();
  const extensions = new Set();
  for (const icon of icons) {
    requireValue(typeof icon === "string" && icon.length > 0, "bundle icon paths must be strings");
    const path = resolve(tauriRoot, icon);
    requireValue(
      relative(tauriRoot, path) !== "" && !relative(tauriRoot, path).startsWith(".."),
      `bundle icon escapes src-tauri: ${icon}`,
    );
    await access(path);
    const extension = extname(path).toLowerCase();
    extensions.add(extension);
    if (extension === ".png") {
      const { width, height } = pngDimensions(await readFile(path), icon);
      requireValue(width === height, `bundle icon must be square: ${icon} is ${width}x${height}`);
      pngSizes.add(width);
    }
  }

  for (const size of [32, 128, 256]) {
    requireValue(pngSizes.has(size), `Tauri bundle icons must include a ${size}x${size} PNG`);
  }
  for (const extension of [".icns", ".ico"]) {
    requireValue(extensions.has(extension), `Tauri bundle icons must include ${extension}`);
  }

  const workflowRequirements = [
    ["bundles: appimage,deb,rpm", "Linux AppImage/deb/rpm matrix entry"],
    ["bundles: msi,nsis", "Windows MSI/NSIS matrix entry"],
    ["target: aarch64-apple-darwin", "Apple Silicon target"],
    ["target: x86_64-apple-darwin", "Intel macOS target"],
    ["WINDOWS_CERTIFICATE", "Windows signing secret gate"],
    ["APPLE_CERTIFICATE", "macOS signing secret gate"],
    ["uploadWorkflowArtifacts: true", "workflow artifact upload"],
    ["-- --locked", "Cargo.lock-enforced bundle build"],
    ["ope-term.cdx.json", "CycloneDX SBOM generation"],
    ["node scripts/release-assets.mjs release-assets release-upload", "flat release staging"],
    ["generate SHA-256 checksums", "release checksums"],
    ["name: Attest release assets", "artifact provenance attestation"],
    ["subject-path: release-upload/*", "attestation of published asset paths"],
    ["name: Preserve staged release assets", "read-only release staging job"],
    ["name: Download staged release assets", "write-scoped publish job"],
    ["needs: stage-release", "publish dependency on attested assets"],
    ["gh release create", "draft Release creation"],
  ];
  for (const [fragment, description] of workflowRequirements) {
    requireWorkflowFragment(workflow, fragment, description);
  }

  for (const [fragment, description] of [
    ["require(\"./package.json\").version", "package-derived SBOM version"],
    ["--exclude './.venv*/**'", "local Python environment SBOM exclusion"],
    ["--exclude './graphify-out/**'", "generated knowledge graph SBOM exclusion"],
  ]) {
    requireValue(justfile.includes(fragment), `SBOM recipe is missing ${description}`);
  }

  return { iconCount: icons.length, pngSizes: [...pngSizes].sort((left, right) => left - right) };
}

async function main() {
  const result = await verifyReleasePolicy();
  console.log(
    `release policy passed (${result.iconCount} icons; PNG sizes ${result.pngSizes.join(", ")})`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
