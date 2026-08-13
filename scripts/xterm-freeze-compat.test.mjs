import assert from "node:assert/strict";
import test from "node:test";

import { transformXtermForFrozenPrototype } from "./xterm-freeze-compat.mjs";

const xtermId = "/workspace/node_modules/@xterm/xterm/lib/xterm.mjs";

test("ignores modules outside xterm", () => {
  assert.equal(transformXtermForFrozenPrototype("o.toString=s;", "/workspace/src/main.ts"), null);
});

test("defines the xterm key-code toString as an own property", () => {
  const transformed = transformXtermForFrozenPrototype(
    'var Qn;(o=>{function s(){return "key"}o.toString=s;})(Qn||={});',
    `${xtermId}?v=1`,
  );

  assert.match(transformed.code, /Object\.defineProperty\(o,"toString"/u);
  assert.doesNotMatch(transformed.code, /o\.toString=s/u);

  const prototype = Object.freeze({ toString: Object.prototype.toString });
  const target = Object.create(prototype);
  const toString = () => "key";
  Object.defineProperty(target, "toString", {
    value: toString,
    configurable: true,
    writable: true,
  });
  assert.equal(target.toString(), "key");
});

test("fails closed when an xterm upgrade changes the targeted code", () => {
  assert.throws(
    () => transformXtermForFrozenPrototype("export const changed = true;", xtermId),
    /expected one key-code assignment, found 0/u,
  );
  assert.throws(
    () => transformXtermForFrozenPrototype("o.toString=s;o.toString=s;", xtermId),
    /expected one key-code assignment, found 2/u,
  );
});
