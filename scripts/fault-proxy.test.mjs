import assert from 'node:assert/strict';
import { createConnection, createServer } from 'node:net';
import { test } from 'node:test';
import { startFaultProxy } from './fault-proxy.mjs';

test('fault proxy forwards bytes, drops a live link, and accepts a reconnect', async () => {
  const upstream = createServer((socket) => socket.pipe(socket));
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamAddress = upstream.address();
  assert(upstreamAddress && typeof upstreamAddress !== 'string');
  const proxy = await startFaultProxy({
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstreamHost: '127.0.0.1',
    upstreamPort: upstreamAddress.port,
    durationMs: 0,
    faultEveryMs: 0,
  });

  const first = await connect(proxy.address.port);
  assert.equal(await roundTrip(first, 'first'), 'first');
  assert.equal(proxy.injectFault(), 1);
  await new Promise((resolve) => first.once('close', resolve));

  const second = await connect(proxy.address.port);
  assert.equal(await roundTrip(second, 'second'), 'second');
  second.destroy();
  const report = await proxy.stop();
  await new Promise((resolve) => upstream.close(resolve));

  assert.equal(report.acceptedConnections, 2);
  assert.equal(report.upstreamConnections, 2);
  assert.equal(report.faultEvents, 1);
  assert.equal(report.droppedConnections, 1);
  assert.equal(report.clientToUpstreamBytes, 11);
  assert.equal(report.upstreamToClientBytes, 11);
  assert.deepEqual(report.unexpectedErrors, []);
});

test('fault proxy blackholes a live link until the client gives up, then accepts a reconnect', async () => {
  const upstream = createServer((socket) => socket.pipe(socket));
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamAddress = upstream.address();
  assert(upstreamAddress && typeof upstreamAddress !== 'string');
  const proxy = await startFaultProxy({
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstreamHost: '127.0.0.1',
    upstreamPort: upstreamAddress.port,
    durationMs: 0,
    faultEveryMs: 0,
    faultMode: 'alternate',
    blackholeMs: 60_000,
  });

  const first = await connect(proxy.address.port);
  assert.equal(await roundTrip(first, 'live'), 'live');
  assert.equal(proxy.injectFault(), 1, 'alternate starts with a drop');
  await new Promise((resolve) => first.once('close', resolve));

  const second = await connect(proxy.address.port);
  assert.equal(await roundTrip(second, 'again'), 'again');
  assert.equal(proxy.injectFault(), 1, 'then a blackhole');
  let echoed = false;
  second.on('data', () => { echoed = true; });
  second.write('swallowed');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(echoed, false, 'a blackholed link delivers nothing');
  assert.equal(proxy.injectFault(), 0, 'a silent link is not faulted twice');
  // The client's keepalive gives up and closes; the proxy sees it and cleans up.
  second.end();
  await new Promise((resolve) => second.once('close', resolve));

  const third = await connect(proxy.address.port);
  assert.equal(await roundTrip(third, 'recovered'), 'recovered');
  third.destroy();
  const report = await proxy.stop();
  await new Promise((resolve) => upstream.close(resolve));

  assert.equal(report.faultMode, 'alternate');
  assert.equal(report.faultEvents, 2);
  assert.equal(report.droppedConnections, 1);
  assert.equal(report.blackholedConnections, 1);
  assert.equal(report.acceptedConnections, 3);
  assert.deepEqual(report.unexpectedErrors, []);
});

test('fault proxy stops scheduled faults after the quiet point', async () => {
  const upstream = createServer((socket) => socket.pipe(socket));
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamAddress = upstream.address();
  assert(upstreamAddress && typeof upstreamAddress !== 'string');
  const proxy = await startFaultProxy({
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstreamHost: '127.0.0.1',
    upstreamPort: upstreamAddress.port,
    durationMs: 0,
    faultEveryMs: 20,
    quietAfterMs: 1,
  });
  const socket = await connect(proxy.address.port);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(await roundTrip(socket, 'still-live'), 'still-live');
  socket.destroy();
  const report = await proxy.stop();
  await new Promise((resolve) => upstream.close(resolve));
  assert.equal(report.faultEvents, 0);
});

test('fault proxy rejects an unknown fault mode', async () => {
  await assert.rejects(
    startFaultProxy({ listenHost: '127.0.0.1', listenPort: 0, upstreamHost: '127.0.0.1', upstreamPort: 1, durationMs: 0, faultEveryMs: 0, faultMode: 'chaos' }),
    /Unknown fault mode/,
  );
});

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function roundTrip(socket, message) {
  return new Promise((resolve, reject) => {
    socket.once('data', (data) => resolve(data.toString('utf8')));
    socket.once('error', reject);
    socket.write(message);
  });
}
