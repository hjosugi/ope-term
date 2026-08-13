import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

test('bundles matching WebGL and fallback reports with deltas', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'ope-term-performance-'));
  const webgl = resolve(directory, 'webgl.json');
  const fallback = resolve(directory, 'fallback.json');
  const output = resolve(directory, 'bundle');
  await writeFile(webgl, JSON.stringify(report('webgl', 10)));
  await writeFile(fallback, JSON.stringify(report('fallback', 14)));
  const result = spawnSync(process.execPath, [
    'scripts/performance-bundle.mjs', '--webgl', webgl, '--fallback', fallback, '--output', output,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(await readFile(resolve(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.comparison.inputP99Ms.delta, -4);
  assert.equal(manifest.reports.webgl, 'webgl-webgl.json');
});

test('rejects reports captured with the wrong renderer', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'ope-term-performance-'));
  const first = resolve(directory, 'first.json');
  const second = resolve(directory, 'second.json');
  await writeFile(first, JSON.stringify(report('fallback', 10)));
  await writeFile(second, JSON.stringify(report('fallback', 14)));
  const result = spawnSync(process.execPath, [
    'scripts/performance-bundle.mjs', '--webgl', first, '--fallback', second, '--output', resolve(directory, 'bundle'),
  ], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Expected webgl report/u);
});

function report(renderer, inputP99Ms) {
  return {
    schemaVersion: 1,
    createdAt: '2026-08-13T00:00:00Z',
    environment: {
      operatingSystem: 'CachyOS Wayland', webview: 'WebKitGTK', renderer,
      machine: 'test machine', commit: 'deadbeef',
    },
    coldStartMs: 100,
    inputLatency: { samples: 100, p50Ms: 2, p95Ms: 5, p99Ms: inputP99Ms },
    memory: { idleMiB: 90, oneSessionMiB: 100, sessionIncrementMiB: 10 },
    output: {
      bytes: 104857600, durationMs: 1000, throughputMiBPerSecond: 100,
      maximumMainThreadStallMs: 20, longTaskObserverSupported: true,
    },
  };
}

