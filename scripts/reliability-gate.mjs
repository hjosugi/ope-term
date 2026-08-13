#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

export function evaluateReliabilityReport(report, budgets) {
  requireValue(report && typeof report === "object", "Reliability report must be an object");
  requireValue(budgets && typeof budgets === "object", "Reliability budgets must be an object");
  requireValue(
    report.schemaVersion === budgets.schemaVersion,
    `Unsupported reliability report schema: ${String(report.schemaVersion)}`,
  );

  const checks = [
    ["duration", report.durationSeconds, ">=", budgets.minimumDurationSeconds, "seconds"],
    ["fault events", report.faultEvents, ">=", budgets.minimumFaultEvents, "events"],
    [
      "reconnects after dropped links",
      report.acceptedConnections,
      ">",
      report.droppedConnections,
      "connections",
    ],
    [
      "upstream connections",
      report.upstreamConnections,
      "==",
      report.acceptedConnections,
      "connections",
    ],
    [
      "client-to-upstream traffic",
      report.clientToUpstreamBytes,
      ">=",
      budgets.minimumTransferredBytes,
      "bytes",
    ],
    [
      "upstream-to-client traffic",
      report.upstreamToClientBytes,
      ">=",
      budgets.minimumTransferredBytes,
      "bytes",
    ],
    ["unexpected proxy errors", report.unexpectedErrors?.length, "==", 0, "errors"],
  ].map(([name, actual, comparison, limit, unit]) => {
    const passed =
      typeof actual === "number" &&
      Number.isFinite(actual) &&
      typeof limit === "number" &&
      Number.isFinite(limit) &&
      (comparison === ">=" ? actual >= limit : comparison === ">" ? actual > limit : actual === limit);
    return { name, actual, comparison, limit, unit, passed };
  });

  return { passed: checks.every((check) => check.passed), checks };
}

async function readStandardInput() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

async function main() {
  const reportPath = process.argv[2];
  requireValue(reportPath, "Usage: node scripts/reliability-gate.mjs <soak-report.json>");
  const budgets = JSON.parse(await readFile(resolve(root, "reliability-budgets.json"), "utf8"));
  const reportSource =
    reportPath === "-" ? await readStandardInput() : await readFile(resolve(reportPath), "utf8");
  const result = evaluateReliabilityReport(JSON.parse(reportSource), budgets);

  for (const check of result.checks) {
    console[check.passed ? "log" : "error"](
      `${check.passed ? "PASS" : "FAIL"} ${check.name}: ${String(check.actual)} ${check.unit} (${check.comparison} ${check.limit})`,
    );
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
