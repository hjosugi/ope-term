#!/usr/bin/env node
// Runs the built ope-term app in its scripted measurement mode once per
// renderer, gates each report, and bundles a WebGL / fallback comparison.
//
// Usage:
//   node scripts/performance-autorun.mjs --app <ope-term binary> --output <directory>
//     [--renderers fallback,webgl] [--profile ci-linux-xvfb] [--label "CachyOS Wayland"]
//     [--timeout-seconds 900]
//
// The app writes each report itself (OPE_TERM_PERFORMANCE_REPORT) and exits.
// It opens a real window, so run it in a desktop session or under xvfb-run.

import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluatePerformanceReport, selectPerformanceBudgets } from './performance-gate.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RENDERERS = ['webgl', 'fallback'];

export function parseArguments(args) {
  const options = { renderers: ['fallback', 'webgl'], timeoutSeconds: 900, label: undefined, profile: undefined };
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    if (flag === '--app') options.app = resolve(value);
    else if (flag === '--output') options.output = resolve(value);
    else if (flag === '--profile') options.profile = value;
    else if (flag === '--label') options.label = value;
    else if (flag === '--timeout-seconds') {
      const seconds = Number.parseInt(value, 10);
      if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error('--timeout-seconds must be a positive integer');
      options.timeoutSeconds = seconds;
    } else if (flag === '--renderers') {
      const renderers = value.split(',').map((renderer) => renderer.trim()).filter(Boolean);
      if (renderers.length === 0 || renderers.some((renderer) => !RENDERERS.includes(renderer))) {
        throw new Error('--renderers takes a comma-separated list of webgl and fallback');
      }
      options.renderers = renderers;
    } else throw new Error(`Unknown option: ${flag}`);
  }
  if (!options.app || !options.output) {
    throw new Error('Usage: node scripts/performance-autorun.mjs --app <binary> --output <directory> [--renderers fallback,webgl] [--profile name] [--label text] [--timeout-seconds 900]');
  }
  return options;
}

/** Quotes one argument for the local shell the app types the fixture into. */
export function shellQuote(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$').replaceAll('`', '\\`')}"`;
}

function currentCommit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function runApp(app, env, timeoutMs) {
  return new Promise((resolveRun) => {
    const child = spawn(app, [], { env, stdio: ['ignore', 'inherit', 'inherit'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolveRun({ timedOut: true, code: null });
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolveRun({ timedOut: false, code });
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      resolveRun({ timedOut: false, code: null, error });
    });
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  await mkdir(options.output, { recursive: true });
  const budgets = selectPerformanceBudgets(
    JSON.parse(await readFile(resolve(root, 'performance-budgets.json'), 'utf8')),
    options.profile,
  );
  const fixture = `${shellQuote(process.execPath)} ${shellQuote(resolve(root, 'scripts/performance-fixture.mjs'))}`;
  const commit = currentCommit();
  const reports = {};
  let failed = false;

  for (const renderer of options.renderers) {
    const reportPath = resolve(options.output, `${renderer}.json`);
    const env = {
      ...process.env,
      OPE_TERM_PERFORMANCE_REPORT: reportPath,
      OPE_TERM_PERFORMANCE_RENDERER: renderer,
      OPE_TERM_PERFORMANCE_FIXTURE: fixture,
      OPE_TERM_COMMIT: commit,
      ...(options.label ? { OPE_TERM_PERFORMANCE_OS: options.label } : {}),
    };
    console.log(`== ${renderer}: launching ${options.app}`);
    const run = await runApp(options.app, env, options.timeoutSeconds * 1000);
    if (run.timedOut || run.error) {
      console.error(`FAIL ${renderer}: app ${run.timedOut ? 'timed out' : `could not start: ${run.error}`}`);
      failed = true;
      continue;
    }
    let report;
    try {
      report = JSON.parse(await readFile(reportPath, 'utf8'));
    } catch (error) {
      console.error(`FAIL ${renderer}: no report (${error instanceof Error ? error.message : error})`);
      failed = true;
      continue;
    }
    if (report.error) {
      console.error(`FAIL ${renderer}: autorun error: ${report.error}`);
      failed = true;
      continue;
    }
    reports[renderer] = { path: reportPath, report };
    if (report.environment?.renderer !== renderer) {
      console.warn(`WARN ${renderer}: the app measured ${report.environment?.renderer} (renderer unavailable here)`);
    }
    try {
      const result = evaluatePerformanceReport(report, budgets);
      for (const check of result.checks) {
        console[check.passed ? 'log' : 'error'](
          `${check.passed ? 'PASS' : 'FAIL'} ${renderer} ${check.name}: ${check.actual} ${check.unit} (${check.comparison} ${check.limit})`,
        );
      }
      if (!result.longTaskObserverSupported) {
        console.warn(`WARN ${renderer}: long-task observer unavailable; main-thread stall is not measured`);
      }
      if (!result.passed) failed = true;
    } catch (error) {
      console.error(`FAIL ${renderer}: ${error instanceof Error ? error.message : error}`);
      failed = true;
    }
  }

  const webgl = reports.webgl;
  const fallback = reports.fallback;
  if (webgl && fallback && webgl.report.environment.renderer === 'webgl') {
    execFileSync(process.execPath, [
      resolve(root, 'scripts/performance-bundle.mjs'),
      '--webgl', webgl.path,
      '--fallback', fallback.path,
      '--output', resolve(options.output, 'bundle'),
    ], { stdio: 'inherit' });
  } else if (webgl && fallback) {
    console.warn('WARN WebGL was unavailable, so no WebGL / fallback comparison bundle was written');
  }
  if (failed) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
