import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateClientReport,
  evaluateReliabilityReport,
  selectBudgets,
} from "./reliability-gate.mjs";

const budgets = {
  schemaVersion: 1,
  minimumDurationSeconds: 86_400,
  minimumFaultEvents: 10,
  minimumTransferredBytes: 1,
  minimumHeartbeatAckRatio: 0.95,
  profiles: { ci: { minimumDurationSeconds: 1_500, minimumFaultEvents: 10, minimumHeartbeatAckRatio: 0.9 } },
};

function passingReport() {
  return {
    schemaVersion: 1,
    durationSeconds: 86_400,
    acceptedConnections: 11,
    upstreamConnections: 11,
    faultEvents: 10,
    droppedConnections: 10,
    clientToUpstreamBytes: 1,
    upstreamToClientBytes: 1,
    unexpectedErrors: [],
  };
}

test("accepts a complete report at every reliability boundary", () => {
  const result = evaluateReliabilityReport(passingReport(), budgets);
  assert.equal(result.passed, true);
  assert.equal(result.checks.every((check) => check.passed), true);
});

test("rejects reports without reconnect traffic", () => {
  const report = passingReport();
  report.clientToUpstreamBytes = 0;
  report.upstreamToClientBytes = 0;

  const result = evaluateReliabilityReport(report, budgets);
  assert.equal(result.passed, false);
  assert.deepEqual(
    result.checks.filter((check) => !check.passed).map((check) => check.name),
    ["client-to-upstream traffic", "upstream-to-client traffic"],
  );
});

test("rejects every failed duration, fault, reconnect, upstream, and error invariant", () => {
  for (const mutate of [
    (report) => (report.durationSeconds -= 1),
    (report) => (report.faultEvents -= 1),
    (report) => (report.acceptedConnections = report.droppedConnections),
    (report) => (report.upstreamConnections -= 1),
    (report) => report.unexpectedErrors.push("ECONNREFUSED"),
  ]) {
    const report = passingReport();
    mutate(report);
    assert.equal(evaluateReliabilityReport(report, budgets).passed, false);
  }
});

test("rejects unsupported schemas and non-finite metrics", () => {
  assert.throws(
    () => evaluateReliabilityReport({ ...passingReport(), schemaVersion: 2 }, budgets),
    /Unsupported reliability report schema: 2/u,
  );

  const report = passingReport();
  report.durationSeconds = Number.NaN;
  assert.equal(evaluateReliabilityReport(report, budgets).passed, false);
});

function passingClientReport() {
  return {
    schemaVersion: 1,
    kind: "ope-term-soak-client",
    durationSeconds: 86_400,
    autoReconnects: 10,
    exhaustedRetryBudgets: 0,
    unexpectedCloses: 0,
    heartbeats: { sent: 100, acknowledged: 95, missed: 0, duplicates: 0, droppedByDisconnect: 5 },
  };
}

test("counts blackholed links as faults that need a reconnect", () => {
  const report = passingReport();
  report.droppedConnections = 5;
  report.blackholedConnections = 5;
  assert.equal(evaluateReliabilityReport(report, budgets).passed, true);
  report.acceptedConnections = 10;
  assert.equal(evaluateReliabilityReport(report, budgets).passed, false);
});

test("accepts a client report that recovered from every fault", () => {
  const result = evaluateClientReport(passingClientReport(), budgets, passingReport());
  assert.equal(result.passed, true, JSON.stringify(result.checks.filter((check) => !check.passed)));
});

test("rejects client reports with replays, exhausted budgets, or a silent shell", () => {
  for (const mutate of [
    (report) => (report.durationSeconds -= 1),
    (report) => (report.autoReconnects = 8),
    (report) => (report.exhaustedRetryBudgets = 1),
    (report) => (report.unexpectedCloses = 1),
    (report) => (report.heartbeats.duplicates = 1),
    (report) => (report.heartbeats.acknowledged = 90),
    (report) => (report.heartbeats.sent = 0),
  ]) {
    const report = passingClientReport();
    mutate(report);
    assert.equal(evaluateClientReport(report, budgets, passingReport()).passed, false);
  }
  assert.throws(() => evaluateClientReport({ schemaVersion: 1, kind: "other" }, budgets), /Unsupported soak client report/u);
});

test("applies the short CI profile over the 24 hour defaults", () => {
  const ci = selectBudgets(budgets, "ci");
  assert.equal(ci.minimumDurationSeconds, 1_500);
  assert.equal(ci.minimumHeartbeatAckRatio, 0.9);
  assert.equal(ci.minimumTransferredBytes, 1);
  assert.equal(selectBudgets(budgets, undefined), budgets);
  assert.throws(() => selectBudgets(budgets, "nightly"), /Unknown reliability budget profile/u);
});
