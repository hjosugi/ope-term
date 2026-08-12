#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createServer, createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';

export async function startFaultProxy(options) {
  const startedAt = new Date();
  const pairs = new Set();
  const report = {
    schemaVersion: 1,
    startedAt: startedAt.toISOString(),
    endedAt: '',
    durationSeconds: 0,
    listen: `${options.listenHost}:${options.listenPort}`,
    upstream: `${options.upstreamHost}:${options.upstreamPort}`,
    faultEverySeconds: options.faultEveryMs / 1000,
    acceptedConnections: 0,
    upstreamConnections: 0,
    faultEvents: 0,
    droppedConnections: 0,
    clientToUpstreamBytes: 0,
    upstreamToClientBytes: 0,
    unexpectedErrors: [],
  };
  let stopped = false;
  let resolveDone;
  const done = new Promise((resolveDonePromise) => { resolveDone = resolveDonePromise; });

  const server = createServer((client) => {
    report.acceptedConnections += 1;
    client.setNoDelay(true);
    const upstream = createConnection({ host: options.upstreamHost, port: options.upstreamPort });
    upstream.setNoDelay(true);
    const pair = { client, upstream, closed: false };
    pairs.add(pair);
    upstream.once('connect', () => { report.upstreamConnections += 1; });
    client.on('data', (chunk) => { report.clientToUpstreamBytes += chunk.length; });
    upstream.on('data', (chunk) => { report.upstreamToClientBytes += chunk.length; });
    client.on('error', (error) => recordUnexpectedError(report, 'client', error));
    upstream.on('error', (error) => recordUnexpectedError(report, 'upstream', error));
    const closePair = () => {
      if (pair.closed) return;
      pair.closed = true;
      pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    client.once('close', closePair);
    upstream.once('close', closePair);
    client.pipe(upstream);
    upstream.pipe(client);
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(options.listenPort, options.listenHost, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });

  const injectFault = () => {
    if (pairs.size === 0) return 0;
    report.faultEvents += 1;
    report.droppedConnections += pairs.size;
    const dropped = pairs.size;
    for (const pair of [...pairs]) {
      pair.closed = true;
      pairs.delete(pair);
      pair.client.destroy();
      pair.upstream.destroy();
    }
    return dropped;
  };

  const faultTimer = options.faultEveryMs > 0
    ? setInterval(injectFault, options.faultEveryMs)
    : undefined;
  const durationTimer = options.durationMs > 0
    ? setTimeout(() => { void stop(); }, options.durationMs)
    : undefined;

  async function stop() {
    if (stopped) return report;
    stopped = true;
    if (faultTimer) clearInterval(faultTimer);
    if (durationTimer) clearTimeout(durationTimer);
    for (const pair of [...pairs]) {
      pair.client.destroy();
      pair.upstream.destroy();
    }
    pairs.clear();
    await new Promise((resolveClose) => server.close(resolveClose));
    const endedAt = new Date();
    report.endedAt = endedAt.toISOString();
    report.durationSeconds = (endedAt.getTime() - startedAt.getTime()) / 1000;
    if (options.reportPath) {
      await mkdir(dirname(options.reportPath), { recursive: true });
      await writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
    resolveDone(report);
    return report;
  }

  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fault proxy did not bind a TCP address');
  return { address, done, injectFault, report, stop };
}

function recordUnexpectedError(report, side, error) {
  if (['ECONNRESET', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error.code)) return;
  report.unexpectedErrors.push({ side, code: error.code ?? 'UNKNOWN', message: error.message });
}

function parseArguments(args) {
  const values = {
    listenHost: '127.0.0.1',
    listenPort: 2222,
    upstreamHost: '',
    upstreamPort: 22,
    durationMs: 24 * 60 * 60 * 1000,
    faultEveryMs: 15 * 60 * 1000,
    reportPath: resolve('artifacts/reliability/soak.json'),
  };
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`Missing value for ${flag}`);
    if (flag === '--listen-host') values.listenHost = value;
    else if (flag === '--listen-port') values.listenPort = positiveInteger(value, flag);
    else if (flag === '--upstream-host') values.upstreamHost = value;
    else if (flag === '--upstream-port') values.upstreamPort = positiveInteger(value, flag);
    else if (flag === '--duration-seconds') values.durationMs = positiveInteger(value, flag) * 1000;
    else if (flag === '--fault-every-seconds') values.faultEveryMs = positiveInteger(value, flag) * 1000;
    else if (flag === '--report') values.reportPath = resolve(value);
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (!values.upstreamHost) {
    throw new Error('Usage: node scripts/fault-proxy.mjs --upstream-host <host> [--upstream-port 22] [--listen-port 2222] [--duration-seconds 86400] [--fault-every-seconds 900] [--report path]');
  }
  return values;
}

function positiveInteger(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const options = parseArguments(process.argv.slice(2));
  const proxy = await startFaultProxy(options);
  console.log(`Fault proxy listening on ${options.listenHost}:${proxy.address.port} -> ${options.upstreamHost}:${options.upstreamPort}`);
  console.log(`Injecting a disconnect every ${options.faultEveryMs / 1000}s for ${options.durationMs / 1000}s`);
  const stop = () => { void proxy.stop(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const report = await proxy.done;
  console.log(JSON.stringify(report, null, 2));
}
