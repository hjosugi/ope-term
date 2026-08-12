#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = process.argv[2];
if (!reportPath) {
  console.error('Usage: node scripts/performance-gate.mjs <report.json>');
  process.exit(2);
}

const budgets = JSON.parse(await readFile(resolve(root, 'performance-budgets.json'), 'utf8'));
const reportSource = reportPath === '-' ? await readStandardInput() : await readFile(resolve(reportPath), 'utf8');
const report = JSON.parse(reportSource);
if (report.schemaVersion !== budgets.schemaVersion) {
  throw new Error(`Unsupported performance report schema: ${String(report.schemaVersion)}`);
}

const environmentFields = ['operatingSystem', 'webview', 'machine', 'commit'];
for (const field of environmentFields) {
  if (typeof report.environment?.[field] !== 'string' || !report.environment[field].trim()) {
    throw new Error(`Performance report environment.${field} is required`);
  }
}
if (!['webgl', 'fallback'].includes(report.environment?.renderer)) {
  throw new Error('Performance report must identify the measured renderer');
}
if (!(report.coldStartMs > 0) || !(report.memory?.idleMiB > 0) || !(report.memory?.oneSessionMiB >= report.memory?.idleMiB)) {
  throw new Error('Performance report timings and RSS measurements must be positive and internally consistent');
}

const checks = [
  ['cold start', report.coldStartMs, '<', budgets.coldStartMs, 'ms'],
  ['input samples', report.inputLatency?.samples, '>=', budgets.minimumInputSamples, 'events'],
  ['input latency p99', report.inputLatency?.p99Ms, '<', budgets.inputLatencyP99Ms, 'ms'],
  ['idle memory', report.memory?.idleMiB, '<', budgets.idleMemoryMiB, 'MiB'],
  ['session memory increment', report.memory?.sessionIncrementMiB, '<', budgets.sessionIncrementMiB, 'MiB'],
  ['output fixture', report.output?.bytes, '>=', budgets.minimumOutputBytes, 'bytes'],
  ['main-thread stall', report.output?.maximumMainThreadStallMs, '<', budgets.maximumMainThreadStallMs, 'ms'],
];

let failed = false;
for (const [name, actual, comparison, limit, unit] of checks) {
  if (typeof actual !== 'number' || !Number.isFinite(actual)) {
    console.error(`FAIL ${name}: missing finite number`);
    failed = true;
    continue;
  }
  const passed = comparison === '>=' ? actual >= limit : actual < limit;
  console[passed ? 'log' : 'error'](`${passed ? 'PASS' : 'FAIL'} ${name}: ${actual} ${unit} (${comparison} ${limit})`);
  failed ||= !passed;
}

if (!report.output?.longTaskObserverSupported) {
  console.warn('WARN long-task observer unavailable; corroborate stalls with platform profiler');
}
if (failed) process.exitCode = 1;

async function readStandardInput() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  return input;
}
