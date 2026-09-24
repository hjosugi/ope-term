import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseArguments, shellQuote } from './performance-autorun.mjs';

test('parses the autorun runner options with safe defaults', () => {
  const options = parseArguments(['--app', 'bin/ope-term', '--output', 'out', '--profile', 'ci-linux-xvfb']);
  assert.match(options.app, /bin\/ope-term$/u);
  assert.deepEqual(options.renderers, ['fallback', 'webgl']);
  assert.equal(options.profile, 'ci-linux-xvfb');
  assert.equal(options.timeoutSeconds, 900);
  assert.deepEqual(parseArguments(['--app', 'a', '--output', 'o', '--renderers', 'webgl']).renderers, ['webgl']);
});

test('rejects unknown renderers, options, and missing paths', () => {
  assert.throws(() => parseArguments(['--app', 'a']), /Usage/u);
  assert.throws(() => parseArguments(['--app', 'a', '--output', 'o', '--renderers', 'canvas']), /webgl and fallback/u);
  assert.throws(() => parseArguments(['--app', 'a', '--output', 'o', '--bogus', 'x']), /Unknown option/u);
  assert.throws(() => parseArguments(['--app', 'a', '--output', 'o', '--timeout-seconds', '0']), /positive/u);
});

test('quotes fixture paths for the shell the app types into', () => {
  assert.equal(shellQuote('/usr/bin/node'), '"/usr/bin/node"');
  assert.equal(shellQuote('/tmp/a "b" $HOME `x`'), '"/tmp/a \\"b\\" \\$HOME \\`x\\`"');
});
