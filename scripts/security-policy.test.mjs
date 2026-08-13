import assert from "node:assert/strict";
import test from "node:test";

import { auditCsp, verifySecurityPolicy } from "./security-policy.mjs";

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
