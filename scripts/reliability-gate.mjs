#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = process.argv[2];
if (!reportPath) {
  console.error('Usage: node scripts/reliability-gate.mjs <soak-report.json>');
  process.exit(2);
}
const budgets = JSON.parse(await readFile(resolve(root, 'reliability-budgets.json'), 'utf8'));
const reportSource = reportPath === '-' ? await readStandardInput() : await readFile(resolve(reportPath), 'utf8');
const report = JSON.parse(reportSource);
if (report.schemaVersion !== budgets.schemaVersion) throw new Error('Unsupported reliability report schema');

const checks = [
  ['duration', report.durationSeconds, '>=', budgets.minimumDurationSeconds, 'seconds'],
  ['fault events', report.faultEvents, '>=', budgets.minimumFaultEvents, 'events'],
  ['reconnects after dropped links', report.acceptedConnections, '>', report.droppedConnections, 'connections'],
  ['upstream connections', report.upstreamConnections, '==', report.acceptedConnections, 'connections'],
  ['unexpected proxy errors', report.unexpectedErrors?.length, '==', 0, 'errors'],
];
let failed = false;
for (const [name, actual, comparison, limit, unit] of checks) {
  const passed = typeof actual === 'number' && Number.isFinite(actual) && (
    comparison === '>=' ? actual >= limit : comparison === '>' ? actual > limit : actual === limit
  );
  console[passed ? 'log' : 'error'](`${passed ? 'PASS' : 'FAIL'} ${name}: ${String(actual)} ${unit} (${comparison} ${limit})`);
  failed ||= !passed;
}
if (failed) process.exitCode = 1;

async function readStandardInput() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  return input;
}
