import assert from "node:assert/strict";
import test from "node:test";

import { evaluateReliabilityReport } from "./reliability-gate.mjs";

const budgets = {
  schemaVersion: 1,
  minimumDurationSeconds: 86_400,
  minimumFaultEvents: 10,
  minimumTransferredBytes: 1,
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
