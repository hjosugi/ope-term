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
      report.droppedConnections + (report.blackholedConnections ?? 0),
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

/**
 * Checks the headless soak driver's report (`cargo run --example
 * reliability_soak`): every injected fault must end in an automatic reconnect,
 * no automatic retry budget may run out, no heartbeat may be replayed, and the
 * shell must keep answering.
 */
export function evaluateClientReport(report, budgets, proxyReport) {
  requireValue(report && typeof report === "object", "Soak client report must be an object");
  requireValue(
    report.schemaVersion === 1 && report.kind === "ope-term-soak-client",
    `Unsupported soak client report: ${String(report.kind)} v${String(report.schemaVersion)}`,
  );
  const heartbeats = report.heartbeats ?? {};
  // Heartbeats in flight when an injected fault killed the link are expected
  // losses; everything else sent on a live shell must be answered.
  const answerable = (heartbeats.sent ?? 0) - (heartbeats.droppedByDisconnect ?? 0);
  const ackRatio = answerable > 0 ? heartbeats.acknowledged / answerable : 0;
  const expectedReconnects = proxyReport
    ? Math.max(budgets.minimumFaultEvents, proxyReport.faultEvents - 1)
    : budgets.minimumFaultEvents;
  const checks = [
    ["client duration", report.durationSeconds, ">=", budgets.minimumDurationSeconds, "seconds"],
    ["automatic reconnects", report.autoReconnects, ">=", expectedReconnects, "reconnects"],
    ["exhausted retry budgets", report.exhaustedRetryBudgets, "==", 0, "times"],
    ["unexpected closes", report.unexpectedCloses, "==", 0, "closes"],
    ["replayed heartbeats", heartbeats.duplicates, "==", 0, "heartbeats"],
    ["heartbeat acknowledgement ratio", ackRatio, ">=", budgets.minimumHeartbeatAckRatio, "ratio"],
  ].map(([name, actual, comparison, limit, unit]) => {
    const passed =
      typeof actual === "number" &&
      Number.isFinite(actual) &&
      typeof limit === "number" &&
      Number.isFinite(limit) &&
      (comparison === ">=" ? actual >= limit : actual === limit);
    return { name, actual, comparison, limit, unit, passed };
  });
  return { passed: checks.every((check) => check.passed), checks };
}

/** Applies a named profile (e.g. the short scheduled CI soak) over the 24 h defaults. */
export function selectBudgets(budgets, profile) {
  if (!profile) return budgets;
  const overrides = budgets.profiles?.[profile];
  requireValue(overrides && typeof overrides === "object", `Unknown reliability budget profile: ${profile}`);
  return { ...budgets, ...overrides };
}

async function readStandardInput() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

async function main() {
  const args = process.argv.slice(2);
  const profileIndex = args.indexOf("--profile");
  const profile = profileIndex >= 0 ? args[profileIndex + 1] : undefined;
  if (profileIndex >= 0) args.splice(profileIndex, 2);
  const [reportPath, clientPath] = args;
  requireValue(
    reportPath,
    "Usage: node scripts/reliability-gate.mjs <proxy-report.json> [client-report.json] [--profile ci]",
  );
  const budgets = selectBudgets(
    JSON.parse(await readFile(resolve(root, "reliability-budgets.json"), "utf8")),
    profile,
  );
  const reportSource =
    reportPath === "-" ? await readStandardInput() : await readFile(resolve(reportPath), "utf8");
  const proxyReport = JSON.parse(reportSource);
  const proxyResult = evaluateReliabilityReport(proxyReport, budgets);
  const clientResult = clientPath
    ? evaluateClientReport(JSON.parse(await readFile(resolve(clientPath), "utf8")), budgets, proxyReport)
    : { passed: true, checks: [] };
  const result = {
    passed: proxyResult.passed && clientResult.passed,
    checks: [...proxyResult.checks, ...clientResult.checks],
  };

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
