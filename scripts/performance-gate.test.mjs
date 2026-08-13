import assert from "node:assert/strict";
import test from "node:test";

import { evaluatePerformanceReport } from "./performance-gate.mjs";

const budgets = {
  schemaVersion: 1,
  coldStartMs: 500,
  minimumInputSamples: 100,
  inputLatencyP99Ms: 16,
  idleMemoryMiB: 150,
  sessionIncrementMiB: 20,
  minimumOutputBytes: 100 * 1024 * 1024,
  maximumMainThreadStallMs: 100,
};

function passingReport() {
  return {
    schemaVersion: 1,
    createdAt: "2026-08-13T00:00:00.000Z",
    environment: {
      operatingSystem: "CachyOS Wayland",
      webview: "WebKitGTK",
      renderer: "webgl",
      machine: "test machine",
      commit: "deadbeef",
    },
    coldStartMs: 499.99,
    inputLatency: { samples: 100, p50Ms: 4, p95Ms: 8, p99Ms: 15.99 },
    memory: { idleMiB: 100, oneSessionMiB: 119.99, sessionIncrementMiB: 19.99 },
    output: {
      bytes: 100 * 1024 * 1024,
      durationMs: 1_000,
      throughputMiBPerSecond: 100,
      maximumMainThreadStallMs: 99.99,
      longTaskObserverSupported: true,
    },
  };
}

test("accepts a complete report within every performance budget", () => {
  const result = evaluatePerformanceReport(passingReport(), budgets);
  assert.equal(result.passed, true);
  assert.equal(result.checks.every((check) => check.passed), true);
});

test("rejects values on maximum limits and values below minimum limits", () => {
  const report = passingReport();
  report.coldStartMs = 500;
  report.inputLatency.samples = 99;
  report.inputLatency.p99Ms = 16;
  report.memory.idleMiB = 150;
  report.memory.oneSessionMiB = 170;
  report.memory.sessionIncrementMiB = 20;
  report.output.bytes -= 1;
  report.output.maximumMainThreadStallMs = 100;

  const result = evaluatePerformanceReport(report, budgets);
  assert.equal(result.passed, false);
  assert.equal(result.checks.filter((check) => !check.passed).length, 7);
});

test("rejects internally inconsistent measurements", () => {
  for (const [mutate, message] of [
    [(report) => (report.createdAt = "not-a-date"), /createdAt/u],
    [(report) => (report.inputLatency.p95Ms = 3), /ordered/u],
    [(report) => (report.memory.sessionIncrementMiB = 10), /must match/u],
    [(report) => (report.output.durationMs = 0), /duration must be positive/u],
    [(report) => (report.output.throughputMiBPerSecond = 0), /throughput must be positive/u],
    [(report) => delete report.output.longTaskObserverSupported, /observer support/u],
  ]) {
    const report = passingReport();
    mutate(report);
    assert.throws(() => evaluatePerformanceReport(report, budgets), message);
  }
});

test("preserves the profiler warning signal when Long Tasks API is unavailable", () => {
  const report = passingReport();
  report.output.longTaskObserverSupported = false;
  assert.equal(evaluatePerformanceReport(report, budgets).longTaskObserverSupported, false);
});
