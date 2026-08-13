#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function auditCsp(value, expected, label) {
  const failures = [];
  const directives = new Map();
  for (const segment of value.split(";")) {
    const [name, ...sources] = segment.trim().split(/\s+/u);
    if (!name) continue;
    if (directives.has(name)) {
      failures.push(`${label} CSP must not repeat ${name}`);
      continue;
    }
    directives.set(name, sources);
  }

  if (
    directives.size !== Object.keys(expected).length ||
    [...directives.keys()].some((name) => !(name in expected))
  ) {
    failures.push(`${label} CSP must contain only: ${Object.keys(expected).join(" ")}`);
  }
  for (const [name, expectedSources] of Object.entries(expected)) {
    const actual = directives.get(name);
    if (
      !actual ||
      actual.length !== expectedSources.length ||
      expectedSources.some((source) => !actual.includes(source))
    ) {
      failures.push(`CSP ${name} must be exactly: ${expectedSources.join(" ")}`);
    }
  }
  return failures;
}

export function auditCheckoutCredentials(workflow, label) {
  const checkouts = workflow.match(/uses:\s*actions\/checkout@/gu)?.length ?? 0;
  const disabledCredentials = workflow.match(/persist-credentials:\s*false/gu)?.length ?? 0;
  if (checkouts === disabledCredentials) return [];
  return [
    `${label} must set persist-credentials: false on every checkout (${disabledCredentials}/${checkouts})`,
  ];
}

async function collectFrontendFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFrontendFiles(path)));
    } else if ([".html", ".js", ".ts", ".tsx"].includes(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

export async function verifySecurityPolicy(root = defaultRoot) {
  const failures = [];
  const fail = (message) => failures.push(message);
  const readJson = async (path) => JSON.parse(await readFile(join(root, path), "utf8"));

  const tauri = await readJson("src-tauri/tauri.conf.json");
  const security = tauri.app?.security;
  const productionCsp = {
    "default-src": ["'self'", "customprotocol:", "asset:"],
    "script-src": ["'self'"],
    "connect-src": ["ipc:", "http://ipc.localhost"],
    "style-src": ["'self'", "'unsafe-inline'"],
    "font-src": ["'self'", "data:"],
    "img-src": ["'self'", "data:"],
    "object-src": ["'none'"],
    "base-uri": ["'none'"],
    "form-action": ["'none'"],
    "frame-src": ["'none'"],
    "frame-ancestors": ["'none'"],
  };
  if (typeof security?.csp !== "string") {
    fail("Tauri CSP must be a non-empty string");
  } else {
    failures.push(...auditCsp(security.csp, productionCsp, "production"));
  }

  if (typeof security?.devCsp !== "string") {
    fail("Tauri development CSP must be a non-empty string");
  } else {
    failures.push(
      ...auditCsp(
        security.devCsp,
        {
          ...productionCsp,
          "connect-src": ["ipc:", "http://ipc.localhost", "ws://localhost:1420"],
        },
        "development",
      ),
    );
  }
  if (security?.freezePrototype !== true) {
    fail("Tauri security.freezePrototype must stay enabled");
  }
  if (security?.dangerousDisableAssetCspModification !== false) {
    fail("Tauri CSP asset rewriting must not be disabled");
  }

  const capabilityFiles = (await readdir(join(root, "src-tauri/capabilities")))
    .filter((name) => name.endsWith(".json"))
    .sort();
  if (JSON.stringify(capabilityFiles) !== JSON.stringify(["default.json"])) {
    fail("Tauri capabilities must contain only default.json");
  }

  const capabilities = await readJson("src-tauri/capabilities/default.json");
  if (
    JSON.stringify(capabilities.windows) !== JSON.stringify(["main"]) ||
    JSON.stringify(capabilities.permissions) !== JSON.stringify(["core:default"])
  ) {
    fail("default capability must remain limited to main + core:default");
  }

  const forbiddenFrontendPatterns = [
    ["HTML injection API", /\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/u],
    ["browser clipboard API", /\bnavigator\.clipboard\b/u],
    ["window opening API", /\bwindow\.open\s*\(/u],
    ["Tauri shell plugin", /@tauri-apps\/plugin-shell/u],
    ["Tauri clipboard plugin", /@tauri-apps\/plugin-clipboard/u],
  ];
  for (const path of await collectFrontendFiles(join(root, "src"))) {
    const source = await readFile(path, "utf8");
    for (const [description, pattern] of forbiddenFrontendPatterns) {
      if (pattern.test(source)) {
        fail(`${relative(root, path)} uses forbidden ${description}`);
      }
    }
  }

  const terminalSource = await readFile(join(root, "src/main.ts"), "utf8");
  const terminalRequirements = [
    ["proposed xterm APIs disabled", /\ballowProposedApi:\s*false\b/u],
    ["OSC 8 activation handler present", /\blinkHandler:\s*\{/u],
    ["non-HTTP protocols disabled", /\ballowNonHttpProtocols:\s*false\b/u],
    ["window controls disabled", /\bwindowOptions:\s*\{\s*\}/u],
  ];
  for (const [description, pattern] of terminalRequirements) {
    if (!pattern.test(terminalSource)) fail(`terminal policy missing: ${description}`);
  }

  for (const name of await readdir(join(root, ".github/workflows"))) {
    if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
    const workflow = await readFile(join(root, ".github/workflows", name), "utf8");
    failures.push(...auditCheckoutCredentials(workflow, name));
  }

  return failures;
}

async function main() {
  const failures = await verifySecurityPolicy();
  if (failures.length > 0) {
    console.error("Security policy audit failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  } else {
    console.log("Security policy audit passed.");
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
