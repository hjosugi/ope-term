import assert from "node:assert/strict";
import test from "node:test";

import { verifyReleasePolicy } from "./release-policy.mjs";

test("release config contains portable square icons and the complete artifact pipeline", async () => {
  const result = await verifyReleasePolicy();
  assert.deepEqual(result.pngSizes, [32, 128, 256]);
  assert.equal(result.iconCount, 5);
});
