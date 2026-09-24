#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createServer, createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';

const FAULT_MODES = ['drop', 'blackhole', 'alternate'];

/**
 * TCP relay that injects network faults between ope-term and an SSH server.
 *
 * - `drop` closes live links (a reset or a vanished route: `network` cause).
 * - `blackhole` keeps sockets open but silently discards bytes both ways, so
 *   only keepalive / inactivity timers can notice (`timeout` cause). The link
 *   is destroyed after `blackholeMs` if the client never gave up on it.
 * - `alternate` switches between the two on every fault.
 */
export async function startFaultProxy(options) {
  const faultMode = options.faultMode ?? 'drop';
  if (!FAULT_MODES.includes(faultMode)) throw new Error(`Unknown fault mode: ${faultMode}`);
  const blackholeMs = options.blackholeMs ?? 120_000;
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
    faultMode,
    acceptedConnections: 0,
    upstreamConnections: 0,
    faultEvents: 0,
    droppedConnections: 0,
    blackholedConnections: 0,
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
    const pair = { client, upstream, closed: false, blackholed: false, blackholeTimer: undefined };
    pairs.add(pair);
    upstream.once('connect', () => { report.upstreamConnections += 1; });
    // Bytes swallowed by a blackhole never reached the other side, so they are not counted.
    client.on('data', (chunk) => { if (!pair.blackholed) report.clientToUpstreamBytes += chunk.length; });
    upstream.on('data', (chunk) => { if (!pair.blackholed) report.upstreamToClientBytes += chunk.length; });
    client.on('error', (error) => recordUnexpectedError(report, 'client', error));
    upstream.on('error', (error) => recordUnexpectedError(report, 'upstream', error));
    const closePair = () => {
      if (pair.closed) return;
      pair.closed = true;
      pairs.delete(pair);
      if (pair.blackholeTimer) clearTimeout(pair.blackholeTimer);
      client.destroy();
      upstream.destroy();
    };
    pair.close = closePair;
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

  let nextAlternate = 'drop';
  const injectFault = (mode) => {
    const live = [...pairs].filter((pair) => !pair.blackholed);
    if (live.length === 0) return 0;
    let kind = mode ?? faultMode;
    if (kind === 'alternate') {
      kind = nextAlternate;
      nextAlternate = nextAlternate === 'drop' ? 'blackhole' : 'drop';
    }
    report.faultEvents += 1;
    if (kind === 'blackhole') {
      report.blackholedConnections += live.length;
      for (const pair of live) blackhole(pair);
      return live.length;
    }
    report.droppedConnections += live.length;
    for (const pair of live) {
      pair.closed = true;
      pairs.delete(pair);
      pair.client.destroy();
      pair.upstream.destroy();
    }
    return live.length;
  };

  function blackhole(pair) {
    pair.blackholed = true;
    pair.client.unpipe(pair.upstream);
    pair.upstream.unpipe(pair.client);
    // Keep reading so a FIN from either side is still observed and closes the
    // pair, but deliver nothing: the path looks alive yet stays silent.
    pair.client.resume();
    pair.upstream.resume();
    pair.blackholeTimer = setTimeout(() => pair.close?.(), blackholeMs);
  }

  // Scheduled faults stop after `quietAfterMs` so the last one can recover
  // (a blackhole needs the client's keepalive budget) before the soak ends.
  const faultTimer = options.faultEveryMs > 0
    ? setInterval(() => {
        if (options.quietAfterMs !== undefined && Date.now() - startedAt.getTime() >= options.quietAfterMs) return;
        injectFault();
      }, options.faultEveryMs)
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
    faultMode: 'drop',
    blackholeMs: 120_000,
    quietAfterMs: undefined,
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
    else if (flag === '--fault-mode') {
      if (!FAULT_MODES.includes(value)) throw new Error(`--fault-mode must be one of ${FAULT_MODES.join(', ')}`);
      values.faultMode = value;
    } else if (flag === '--blackhole-seconds') values.blackholeMs = positiveInteger(value, flag) * 1000;
    else if (flag === '--quiet-after-seconds') values.quietAfterMs = positiveInteger(value, flag) * 1000;
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (!values.upstreamHost) {
    throw new Error('Usage: node scripts/fault-proxy.mjs --upstream-host <host> [--upstream-port 22] [--listen-port 2222] [--duration-seconds 86400] [--fault-every-seconds 900] [--fault-mode drop|blackhole|alternate] [--blackhole-seconds 120] [--quiet-after-seconds N] [--report path]');
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
  console.log(`Injecting a ${options.faultMode} fault every ${options.faultEveryMs / 1000}s for ${options.durationMs / 1000}s`);
  const stop = () => { void proxy.stop(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const report = await proxy.done;
  console.log(JSON.stringify(report, null, 2));
}
