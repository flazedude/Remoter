import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocketServer, createWebSocketStream } from 'ws';
import { EngineClient, parseInvitation, type Invitation } from '../src/index.js';
import { relayURL } from '../src/invitation.js';

const certificate = await readFile(new URL('./fixtures/host-cert.fixture', import.meta.url), 'utf8');
const key = await readFile(new URL('./fixtures/host-key.fixture', import.meta.url), 'utf8');
const otherCertificate = await readFile(new URL('./fixtures/other-cert.fixture', import.meta.url), 'utf8');
const otherKey = await readFile(new URL('./fixtures/other-key.fixture', import.meta.url), 'utf8');
const token = 'a_secure_test_token_012345678901234567890123456789';

async function listen(server: net.Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as net.AddressInfo).port;
}

async function host(useOtherCertificate = false) {
  const events: unknown[] = [];
  let requests = 0;
  const server = https.createServer({ cert: useOtherCertificate ? otherCertificate : certificate, key: useOtherCertificate ? otherKey : key, minVersion: 'TLSv1.3' }, (request, response) => {
    requests++;
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
    if (request.url === '/v1/info') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ name: 'Test host', os: 'test', version: '0.1', capabilities: { capture: true, input: true }, displays: [{ id: 0, name: 'Main', width: 1920, height: 1080, x: 0, y: 0 }] }));
    } else if (request.url?.startsWith('/v1/frame?')) {
      response.setHeader('Content-Type', 'image/jpeg'); response.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    } else if (request.url === '/v1/input') {
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('end', () => { events.push(JSON.parse(Buffer.concat(chunks).toString())); response.writeHead(204).end(); });
    } else response.writeHead(404).end();
  });
  server.on('tlsClientError', () => {});
  const port = await listen(server);
  const invitation: Invitation = { version: 1, name: 'Test host', endpoint: `https://127.0.0.1:${port}`, certificate, token };
  return { server, port, invitation, events, get requests() { return requests; }, close() { server.closeAllConnections(); server.close(); } };
}

function encode(invitation: Invitation): string { return Buffer.from(JSON.stringify(invitation)).toString('base64url'); }

test('invitation decoding validates identity, routes, and format', () => {
  const invitation: Invitation = { version: 1, name: 'Test', endpoint: 'https://127.0.0.1:8787', certificate, token };
  assert.equal(parseInvitation(encode(invitation)).name, 'Test');
  assert.throws(() => parseInvitation('not an invitation'), /complete/);
  assert.throws(() => parseInvitation(encode({ ...invitation, endpoint: 'http://127.0.0.1' })), /HTTPS/);
  assert.throws(() => parseInvitation(encode({ ...invitation, endpoint: 'https://user:password@example.com' })), /HTTPS/);
  assert.throws(() => parseInvitation(encode({ ...invitation, certificate: 'invalid' })), /certificate/);
  assert.throws(() => parseInvitation(encode({ ...invitation, token: 'short' })), /Invalid/);
  assert.throws(() => relayURL('ws://public.example.com'), /WSS/);
  assert.equal(relayURL('ws://127.0.0.1:8788').pathname, '/v1/tunnel');
});

test('direct pinned TLS supports info, frames, input and closes cleanly', async () => {
  const target = await host();
  const client = new EngineClient(target.invitation);
  try {
    assert.equal((await client.info()).name, 'Test host');
    assert.deepEqual(await client.frame(), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    await client.input({ type: 'move', displayId: 0, x: 80, y: 120 });
    assert.deepEqual(target.events, [{ type: 'move', displayId: 0, x: 80, y: 120 }]);
    await assert.rejects(client.input({ type: 'move', displayId: 0, x: Infinity, y: 0 }), /pointer/);
    client.close();
    await assert.rejects(client.info(), /closed/);
  } finally { client.close(); target.close(); }
});

test('incorrect host certificate and bearer token are rejected', async () => {
  const wrongHost = await host(true);
  const wrongIdentity = new EngineClient(wrongHost.invitation);
  try { await assert.rejects(wrongIdentity.info()); assert.equal(wrongHost.requests, 0); }
  finally { wrongIdentity.close(); wrongHost.close(); }
  const target = await host();
  const wrongToken = new EngineClient({ ...target.invitation, token: 'another_token_012345678901234567890123456789' });
  try { await assert.rejects(wrongToken.info(), /rejected this invitation/); }
  finally { wrongToken.close(); target.close(); }
});

test('Tailscale requires a tailnet endpoint and cannot silently use a proxy', () => {
  const invitation: Invitation = { version: 1, name: 'Test', endpoint: 'https://192.168.1.20:8787', certificate, token };
  assert.throws(() => new EngineClient(invitation, { mode: 'tailscale' }), /tailnet/);
  assert.throws(() => new EngineClient(invitation, { mode: 'tailscale', endpoint: 'https://100.64.0.1:8787', proxy: { host: '127.0.0.1', port: 1080 } }), /system service/);
  for (const endpoint of ['https://100.64.0.1:8787', 'https://100.127.255.254:8787', 'https://workstation.test.ts.net:8787', 'https://[fd7a:115c:a1e0::42]:8787']) {
    new EngineClient(invitation, { mode: 'tailscale', endpoint }).close();
  }
});

test('SOCKS5 resolves the target remotely and never falls back to direct', async () => {
  const target = await host();
  const destinations: string[] = [];
  const authentications: string[] = [];
  const sockets = new Set<net.Socket>();
  const proxy = net.createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    let data = Buffer.alloc(0);
    let state = 0;
    const consume = (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (state === 0) {
        if (data.length < 2 || data.length < 2 + data[1]) return;
        data = data.subarray(2 + data[1]); state = 1; socket.write(Buffer.from([5, 2]));
      }
      if (state === 1) {
        if (data.length < 2 || data.length < 3 + data[1]) return;
        const usernameLength = data[1];
        const passwordLength = data[2 + usernameLength];
        if (data.length < 3 + usernameLength + passwordLength) return;
        authentications.push(`${data.subarray(2, 2 + usernameLength)}:${data.subarray(3 + usernameLength, 3 + usernameLength + passwordLength)}`);
        data = data.subarray(3 + usernameLength + passwordLength);
        state = 2; socket.write(Buffer.from([1, 0]));
      }
      if (state === 2) {
        if (data.length < 5) return;
        assert.equal(data[3], 3, 'destination must be a domain, not locally resolved');
        const length = data[4];
        if (data.length < 7 + length) return;
        destinations.push(data.subarray(5, 5 + length).toString());
        const remaining = data.subarray(7 + length);
        state = 3; socket.removeListener('data', consume);
        const upstream = net.connect(target.port, '127.0.0.1');
        sockets.add(upstream); upstream.once('close', () => sockets.delete(upstream));
        upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
        upstream.once('connect', () => {
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          if (remaining.length) upstream.write(remaining);
          socket.pipe(upstream).pipe(socket);
        });
      }
    };
    socket.on('data', consume);
  });
  const proxyPort = await listen(proxy);
  const proxied = new EngineClient({ ...target.invitation, endpoint: `https://cannot-resolve.invalid:${target.port}` }, { mode: 'direct', proxy: { host: '127.0.0.1', port: proxyPort, username: 'operator', password: 'test-password' } });
  try { assert.equal((await proxied.info()).name, 'Test host'); assert.deepEqual(destinations, ['cannot-resolve.invalid']); assert.deepEqual(authentications, ['operator:test-password']); }
  finally { proxied.close(); for (const socket of sockets) socket.destroy(); proxy.close(); }
  const requestsBefore = target.requests;
  const failed = new EngineClient(target.invitation, { mode: 'direct', proxy: { host: '127.0.0.1', port: proxyPort } });
  try { await assert.rejects(failed.info(), /Direct fallback is disabled/); assert.equal(target.requests, requestsBefore); }
  finally { failed.close(); target.close(); }
});

test('relay transports the pinned inner TLS connection as opaque binary bytes', async () => {
  const target = await host();
  const outer = http.createServer();
  const websocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const streams: net.Socket[] = [];
  const observed: Buffer[] = [];
  outer.on('upgrade', (request, socket, head) => {
    if (request.headers.authorization !== `Bearer ${token}`) { socket.destroy(); return; }
    websocketServer.handleUpgrade(request, socket, head, websocket => {
      const stream = createWebSocketStream(websocket);
      const upstream = net.connect(target.port, '127.0.0.1');
      streams.push(upstream);
      stream.on('data', chunk => observed.push(Buffer.from(chunk)));
      stream.on('error', () => upstream.destroy()); upstream.on('error', () => stream.destroy());
      stream.pipe(upstream).pipe(stream);
    });
  });
  const port = await listen(outer);
  const client = new EngineClient(target.invitation, { mode: 'relay', relay: { url: `ws://127.0.0.1:${port}`, deviceId: 'test', token } });
  try {
    assert.equal((await client.info()).name, 'Test host');
    assert.equal(Buffer.concat(observed).includes(Buffer.from(token)), false, 'inner bearer token must remain encrypted');
  } finally {
    client.close();
    for (const socket of streams) socket.destroy();
    for (const websocket of websocketServer.clients) websocket.terminate();
    websocketServer.close(); outer.closeAllConnections(); outer.close(); target.close();
  }
});
