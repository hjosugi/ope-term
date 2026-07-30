#!/usr/bin/env node

import { readFile, readdir } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function fail(message) {
  failures.push(message);
}

async function readJson(path) {
  return JSON.parse(await readFile(join(root, path), 'utf8'));
}

function parseCsp(value) {
  const directives = new Map();
  for (const segment of value.split(';')) {
    const [name, ...sources] = segment.trim().split(/\s+/u);
    if (name) directives.set(name, sources);
  }
  return directives;
}

function requireExactDirective(directives, name, expected) {
  const actual = directives.get(name);
  if (!actual || actual.length !== expected.length || expected.some((value) => !actual.includes(value))) {
    fail(`CSP ${name} must be exactly: ${expected.join(' ')}`);
  }
}

function requireExactCsp(value, expected, label) {
  const directives = parseCsp(value);
  if (
    directives.size !== Object.keys(expected).length ||
    [...directives.keys()].some((name) => !(name in expected))
  ) {
    fail(`${label} CSP must contain only: ${Object.keys(expected).join(' ')}`);
  }
  for (const [name, sources] of Object.entries(expected)) {
    requireExactDirective(directives, name, sources);
  }
}

async function collectFrontendFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFrontendFiles(path)));
    } else if (['.html', '.js', '.ts', '.tsx'].includes(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

const tauri = await readJson('src-tauri/tauri.conf.json');
const security = tauri.app?.security;
if (typeof security?.csp !== 'string') {
  fail('Tauri CSP must be a non-empty string');
} else {
  requireExactCsp(
    security.csp,
    {
      'default-src': ["'self'", 'customprotocol:', 'asset:'],
      'script-src': ["'self'"],
      'connect-src': ['ipc:', 'http://ipc.localhost'],
      'style-src': ["'self'", "'unsafe-inline'"],
      'font-src': ["'self'", 'data:'],
      'img-src': ["'self'", 'data:'],
      'object-src': ["'none'"],
      'base-uri': ["'none'"],
      'form-action': ["'none'"],
      'frame-src': ["'none'"],
      'frame-ancestors': ["'none'"],
    },
    'production',
  );
}
if (typeof security?.devCsp !== 'string') {
  fail('Tauri development CSP must be a non-empty string');
} else {
  requireExactCsp(
    security.devCsp,
    {
      'default-src': ["'self'", 'customprotocol:', 'asset:'],
      'script-src': ["'self'"],
      'connect-src': ['ipc:', 'http://ipc.localhost', 'ws://localhost:1420'],
      'style-src': ["'self'", "'unsafe-inline'"],
      'font-src': ["'self'", 'data:'],
      'img-src': ["'self'", 'data:'],
      'object-src': ["'none'"],
      'base-uri': ["'none'"],
      'form-action': ["'none'"],
      'frame-src': ["'none'"],
      'frame-ancestors': ["'none'"],
    },
    'development',
  );
}
if (security?.freezePrototype !== true) {
  fail('Tauri security.freezePrototype must stay enabled');
}
if (security?.dangerousDisableAssetCspModification !== false) {
  fail('Tauri CSP asset rewriting must not be disabled');
}

const capabilityFiles = (await readdir(join(root, 'src-tauri/capabilities')))
  .filter((name) => name.endsWith('.json'))
  .sort();
if (JSON.stringify(capabilityFiles) !== JSON.stringify(['default.json'])) {
  fail('Tauri capabilities must contain only default.json');
}

const capabilities = await readJson('src-tauri/capabilities/default.json');
if (
  JSON.stringify(capabilities.windows) !== JSON.stringify(['main']) ||
  JSON.stringify(capabilities.permissions) !== JSON.stringify(['core:default'])
) {
  fail('default capability must remain limited to main + core:default');
}

const forbiddenFrontendPatterns = [
  ['HTML injection API', /\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/u],
  ['browser clipboard API', /\bnavigator\.clipboard\b/u],
  ['window opening API', /\bwindow\.open\s*\(/u],
  ['Tauri shell plugin', /@tauri-apps\/plugin-shell/u],
  ['Tauri clipboard plugin', /@tauri-apps\/plugin-clipboard/u],
];
for (const path of await collectFrontendFiles(join(root, 'src'))) {
  const source = await readFile(path, 'utf8');
  for (const [description, pattern] of forbiddenFrontendPatterns) {
    if (pattern.test(source)) {
      fail(`${relative(root, path)} uses forbidden ${description}`);
    }
  }
}

const terminalSource = await readFile(join(root, 'src/main.ts'), 'utf8');
const terminalRequirements = [
  ['proposed xterm APIs disabled', /\ballowProposedApi:\s*false\b/u],
  ['OSC 8 activation handler present', /\blinkHandler:\s*\{/u],
  ['non-HTTP protocols disabled', /\ballowNonHttpProtocols:\s*false\b/u],
  ['window controls disabled', /\bwindowOptions:\s*\{\s*\}/u],
];
for (const [description, pattern] of terminalRequirements) {
  if (!pattern.test(terminalSource)) fail(`terminal policy missing: ${description}`);
}

if (failures.length > 0) {
  console.error('Security policy audit failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Security policy audit passed.');
}
