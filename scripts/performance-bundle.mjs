#!/usr/bin/env node

import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { release as osRelease } from 'node:os';

const options = parseArguments(process.argv.slice(2));
if (!options.webgl || !options.fallback || !options.output) {
  console.error('Usage: node scripts/performance-bundle.mjs --webgl <report.json> --fallback <report.json> --output <directory>');
  process.exit(2);
}

const [webgl, fallback] = await Promise.all([readReport(options.webgl), readReport(options.fallback)]);
assertRenderer(webgl, 'webgl');
assertRenderer(fallback, 'fallback');
for (const field of ['operatingSystem', 'webview', 'machine', 'commit']) {
  if (webgl.environment[field] !== fallback.environment[field]) {
    throw new Error(`Reports must share environment.${field}`);
  }
}

const output = resolve(options.output);
await mkdir(output, { recursive: true });
const webglName = `webgl-${basename(options.webgl)}`;
const fallbackName = `fallback-${basename(options.fallback)}`;
await Promise.all([
  cp(resolve(options.webgl), resolve(output, webglName)),
  cp(resolve(options.fallback), resolve(output, fallbackName)),
]);
const manifest = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  environment: webgl.environment,
  host: {
    platform: process.platform,
    release: osRelease(),
    nodeVersion: process.version,
    architecture: process.arch,
    waylandDisplayPresent: Boolean(process.env.WAYLAND_DISPLAY),
    sessionType: process.env.XDG_SESSION_TYPE || 'unknown',
    desktop: process.env.XDG_CURRENT_DESKTOP || 'unknown',
  },
  reports: { webgl: webglName, fallback: fallbackName },
  comparison: compare(webgl, fallback),
};
await writeFile(resolve(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Performance artifact bundle written to ${output}`);

function parseArguments(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.replace(/^--/u, '');
    const value = args[index + 1];
    if (key && value) parsed[key] = value;
  }
  return parsed;
}

async function readReport(path) {
  const report = JSON.parse(await readFile(resolve(path), 'utf8'));
  if (report.schemaVersion !== 1 || !report.environment || !report.inputLatency || !report.memory || !report.output) {
    throw new Error(`${path} is not a performance report schema v1`);
  }
  return report;
}

function assertRenderer(report, renderer) {
  if (report.environment.renderer !== renderer) {
    throw new Error(`Expected ${renderer} report, got ${String(report.environment.renderer)}`);
  }
}

function compare(webgl, fallback) {
  const metrics = {
    coldStartMs: [webgl.coldStartMs, fallback.coldStartMs],
    inputP99Ms: [webgl.inputLatency.p99Ms, fallback.inputLatency.p99Ms],
    idleMiB: [webgl.memory.idleMiB, fallback.memory.idleMiB],
    sessionIncrementMiB: [webgl.memory.sessionIncrementMiB, fallback.memory.sessionIncrementMiB],
    throughputMiBPerSecond: [webgl.output.throughputMiBPerSecond, fallback.output.throughputMiBPerSecond],
    maximumMainThreadStallMs: [webgl.output.maximumMainThreadStallMs, fallback.output.maximumMainThreadStallMs],
  };
  return Object.fromEntries(Object.entries(metrics).map(([name, [webglValue, fallbackValue]]) => [name, {
    webgl: webglValue,
    fallback: fallbackValue,
    delta: Math.round((webglValue - fallbackValue) * 100) / 100,
  }]));
}
