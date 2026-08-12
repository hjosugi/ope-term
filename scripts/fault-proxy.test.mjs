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
