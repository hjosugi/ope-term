#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CHECKSUM_FILE = "SHA256SUMS";

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

async function collectFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path)));
    } else {
      requireValue(entry.isFile(), `release asset must be a regular file: ${path}`);
      files.push(path);
    }
  }
  return files;
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function stageReleaseAssets(sourceDirectory, outputDirectory) {
  const source = resolve(sourceDirectory);
  const output = resolve(outputDirectory);
  requireValue(source !== output, "release asset source and output must differ");
  requireValue((await stat(source)).isDirectory(), `release asset source is not a directory: ${source}`);

  const sourceFiles = (await collectFiles(source)).sort((left, right) =>
    relative(source, left).localeCompare(relative(source, right)),
  );
  requireValue(sourceFiles.length > 0, "release asset source is empty");

  const names = new Set();
  for (const sourceFile of sourceFiles) {
    const name = basename(sourceFile);
    requireValue(name !== CHECKSUM_FILE, `${CHECKSUM_FILE} is generated and must not be an input asset`);
    requireValue(!/[\r\n]/u.test(name), `release asset name contains a newline: ${name}`);
    requireValue(!names.has(name), `duplicate release asset basename: ${name}`);
    names.add(name);
  }

  await mkdir(output, { recursive: true });
  for (const sourceFile of sourceFiles) {
    const name = basename(sourceFile);
    await copyFile(sourceFile, join(output, name), constants.COPYFILE_EXCL);
  }

  const sortedNames = [...names].sort((left, right) => left.localeCompare(right));
  const checksumLines = await Promise.all(
    sortedNames.map(async (name) => `${await sha256(join(output, name))}  ${name}`),
  );
  await writeFile(join(output, CHECKSUM_FILE), `${checksumLines.join("\n")}\n`, { flag: "wx" });

  return { assets: sortedNames, checksumFile: CHECKSUM_FILE };
}

async function main() {
  const [source, output] = process.argv.slice(2);
  requireValue(source && output, "usage: release-assets.mjs <source-directory> <output-directory>");
  const result = await stageReleaseAssets(source, output);
  console.log(`staged ${result.assets.length} release assets and ${result.checksumFile}`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
