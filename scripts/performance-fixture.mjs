#!/usr/bin/env node

const DEFAULT_BYTES = 100 * 1024 * 1024;
const requestedBytes = Number.parseInt(process.argv[2] ?? String(DEFAULT_BYTES), 10);
if (!Number.isSafeInteger(requestedBytes) || requestedBytes <= 0) {
  console.error('Usage: node scripts/performance-fixture.mjs [positive-byte-count]');
  process.exit(2);
}

const line = Buffer.from('0123456789abcdef'.repeat(255) + '\n');
let remaining = requestedBytes;

function write() {
  while (remaining > 0) {
    const chunk = remaining >= line.length ? line : line.subarray(0, remaining);
    remaining -= chunk.length;
    if (!process.stdout.write(chunk)) {
      process.stdout.once('drain', write);
      return;
    }
  }
}

process.stdout.on('error', (error) => {
  if (error.code !== 'EPIPE') throw error;
});
write();
