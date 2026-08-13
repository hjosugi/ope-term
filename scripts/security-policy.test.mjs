import assert from "node:assert/strict";
import test from "node:test";

import {
  auditActionPins,
  auditCheckoutCredentials,
  auditCsp,
  verifySecurityPolicy,
} from "./security-policy.mjs";

const expected = {
  "default-src": ["'self'"],
  "object-src": ["'none'"],
};

test("accepts an exact CSP and the repository security policy", async () => {
  assert.deepEqual(auditCsp("default-src 'self'; object-src 'none'", expected, "test"), []);
  assert.deepEqual(await verifySecurityPolicy(), []);
});

test("rejects duplicate CSP directives even when the final value is exact", () => {
  const failures = auditCsp(
    "default-src https:; default-src 'self'; object-src 'none'",
    expected,
    "test",
  );
  assert(failures.some((failure) => failure.includes("must not repeat default-src")));
  assert(failures.some((failure) => failure.includes("default-src must be exactly")));
});

test("rejects missing, extra, and loosened CSP directives", () => {
  const failures = auditCsp("default-src *; img-src data:", expected, "test");
  assert(failures.some((failure) => failure.includes("must contain only")));
  assert(failures.some((failure) => failure.includes("default-src must be exactly")));
  assert(failures.some((failure) => failure.includes("object-src must be exactly")));
});

test("requires every checkout step to discard its Git credential", () => {
  assert.deepEqual(auditCheckoutCredentials(`
steps:
  - uses: actions/checkout@v7
    with:
      persist-credentials: false
`, "safe.yml"), []);
  assert.match(
    auditCheckoutCredentials("steps:\n  - uses: actions/checkout@v7\n", "unsafe.yml")[0],
    /0\/1/u,
  );
});

test("requires third-party actions to use immutable commit SHAs", () => {
  assert.deepEqual(auditActionPins(`
steps:
  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
  - uses: ./local-action
`, "safe.yml"), []);
  assert.match(
    auditActionPins("steps:\n  - uses: actions/checkout@v7\n", "unsafe.yml")[0],
    /full commit SHA/u,
  );
});
