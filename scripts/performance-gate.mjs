#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function requirePositiveFinite(value, message) {
  requireValue(typeof value === "number" && Number.isFinite(value) && value > 0, message);
}

export function evaluatePerformanceReport(report, budgets) {
  requireValue(report && typeof report === "object", "Performance report must be an object");
  requireValue(budgets && typeof budgets === "object", "Performance budgets must be an object");
  requireValue(
    report.schemaVersion === budgets.schemaVersion,
    `Unsupported performance report schema: ${String(report.schemaVersion)}`,
  );
  requireValue(
    typeof report.createdAt === "string" && Number.isFinite(Date.parse(report.createdAt)),
    "Performance report createdAt must be an ISO timestamp",
  );

  for (const field of ["operatingSystem", "webview", "machine", "commit"]) {
    requireValue(
      typeof report.environment?.[field] === "string" && report.environment[field].trim(),
      `Performance report environment.${field} is required`,
    );
  }
  requireValue(
    ["webgl", "fallback"].includes(report.environment?.renderer),
    "Performance report must identify the measured renderer",
  );

  requirePositiveFinite(report.coldStartMs, "Performance report coldStartMs must be positive");
  requireValue(
    Number.isInteger(report.inputLatency?.samples) && report.inputLatency.samples >= 0,
    "Performance report input sample count must be a non-negative integer",
  );
  const percentiles = [
    report.inputLatency?.p50Ms,
    report.inputLatency?.p95Ms,
    report.inputLatency?.p99Ms,
  ];
  requireValue(
    percentiles.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0) &&
      percentiles[0] <= percentiles[1] &&
      percentiles[1] <= percentiles[2],
    "Performance report input percentiles must be finite, non-negative, and ordered p50 <= p95 <= p99",
  );

  requirePositiveFinite(report.memory?.idleMiB, "Performance report idle memory must be positive");
  requirePositiveFinite(report.memory?.oneSessionMiB, "Performance report session memory must be positive");
  requireValue(
    typeof report.memory?.sessionIncrementMiB === "number" &&
      Number.isFinite(report.memory.sessionIncrementMiB) &&
      report.memory.sessionIncrementMiB >= 0 &&
      Math.abs(
        report.memory.sessionIncrementMiB - (report.memory.oneSessionMiB - report.memory.idleMiB),
      ) < 0.011,
    "Performance report session memory increment must match oneSessionMiB - idleMiB",
  );

  requireValue(
    Number.isInteger(report.output?.bytes) && report.output.bytes >= 0,
    "Performance report output bytes must be a non-negative integer",
  );
  requirePositiveFinite(report.output?.durationMs, "Performance report output duration must be positive");
  requirePositiveFinite(
    report.output?.throughputMiBPerSecond,
    "Performance report output throughput must be positive",
  );
  requireValue(
    typeof report.output?.maximumMainThreadStallMs === "number" &&
      Number.isFinite(report.output.maximumMainThreadStallMs) &&
      report.output.maximumMainThreadStallMs >= 0,
    "Performance report maximum main-thread stall must be finite and non-negative",
  );
  requireValue(
    typeof report.output?.longTaskObserverSupported === "boolean",
    "Performance report must state long-task observer support",
  );

  const checks = [
    ["cold start", report.coldStartMs, "<", budgets.coldStartMs, "ms"],
    ["input samples", report.inputLatency.samples, ">=", budgets.minimumInputSamples, "events"],
    ["input latency p99", report.inputLatency.p99Ms, "<", budgets.inputLatencyP99Ms, "ms"],
    ["idle memory", report.memory.idleMiB, "<", budgets.idleMemoryMiB, "MiB"],
    [
      "session memory increment",
      report.memory.sessionIncrementMiB,
      "<",
      budgets.sessionIncrementMiB,
      "MiB",
    ],
    ["output fixture", report.output.bytes, ">=", budgets.minimumOutputBytes, "bytes"],
    [
      "main-thread stall",
      report.output.maximumMainThreadStallMs,
      "<",
      budgets.maximumMainThreadStallMs,
      "ms",
    ],
  ].map(([name, actual, comparison, limit, unit]) => {
    const passed =
      typeof limit === "number" &&
      Number.isFinite(limit) &&
      (comparison === ">=" ? actual >= limit : actual < limit);
    return { name, actual, comparison, limit, unit, passed };
  });

  return {
    passed: checks.every((check) => check.passed),
    checks,
    longTaskObserverSupported: report.output.longTaskObserverSupported,
  };
}

async function readStandardInput() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

async function main() {
  const reportPath = process.argv[2];
  requireValue(reportPath, "Usage: node scripts/performance-gate.mjs <report.json>");
  const budgets = JSON.parse(await readFile(resolve(root, "performance-budgets.json"), "utf8"));
  const reportSource =
    reportPath === "-" ? await readStandardInput() : await readFile(resolve(reportPath), "utf8");
  const result = evaluatePerformanceReport(JSON.parse(reportSource), budgets);

  for (const check of result.checks) {
    console[check.passed ? "log" : "error"](
      `${check.passed ? "PASS" : "FAIL"} ${check.name}: ${check.actual} ${check.unit} (${check.comparison} ${check.limit})`,
    );
  }
  if (!result.longTaskObserverSupported) {
    console.warn("WARN long-task observer unavailable; corroborate stalls with platform profiler");
  }
  if (!result.passed) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
