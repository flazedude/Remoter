/** Actual Go-host/Go-relay/Node-engine integration. Never touches a real desktop. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineClient, parseInvitation, type Invitation } from '@remoter/engine';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extension = process.platform === 'win32' ? '.exe' : '';
const hostBinary = path.join(root, 'native', 'bin', `remoter-host${extension}`);
const relayBinary = path.join(root, 'native', 'bin', `remoter-relay${extension}`);
const children: ChildProcessWithoutNullStreams[] = [];
const clients: EngineClient[] = [];
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function launch(executable: string, args: string[], env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  const child = spawn(executable, args, { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  // Consume diagnostics without echoing potentially secret-bearing subprocess output.
  child.stderr.on('data', () => {});
  child.on('error', () => {});
  return child;
}

function ready(child: ChildProcessWithoutNullStreams): Promise<Invitation> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => finish(new Error('Synthetic host did not become ready within 10 seconds.')), 10_000);
    function finish(error?: Error, invitation?: Invitation) {
      clearTimeout(timer);
      child.stdout.removeListener('data', onData);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      if (error) reject(error); else resolve(invitation!);
    }
    function onExit() { finish(new Error('Synthetic host exited before becoming ready.')); }
    function onError() { finish(new Error('Synthetic host could not be started.')); }
    function onData(chunk: Buffer) {
      buffer += chunk.toString('utf8');
      if (buffer.length > 65536) { finish(new Error('Synthetic host produced an oversized ready response.')); return; }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const event: unknown = JSON.parse(line);
          if (event && typeof event === 'object' && 'event' in event && event.event === 'ready' && 'invitation' in event && typeof event.invitation === 'string') {
            finish(undefined, parseInvitation(event.invitation));
            return;
          }
        } catch { finish(new Error('Synthetic host returned an invalid ready response.')); return; }
      }
    }
    child.stdout.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function relayReady(port: number, child: ChildProcessWithoutNullStreams): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Relay exited before becoming ready.');
    const healthy = await new Promise<boolean>(resolve => {
      const request = http.get(`http://127.0.0.1:${port}/healthz`, response => { response.resume(); resolve(response.statusCode === 200); });
      request.setTimeout(500, () => request.destroy());
      request.on('error', () => resolve(false));
    });
    if (healthy) return;
    await delay(100);
  }
  throw new Error('Relay did not become ready within 10 seconds.');
}

async function exercise(client: EngineClient): Promise<number> {
  const info = await client.info();
  assert.equal(info.capabilities.capture, true);
  assert.equal(info.capabilities.input, true);
  assert.ok(info.displays.length > 0);
  const display = info.displays[0];
  const frame = await client.frame({ display: display.id, quality: 65, width: 640 });
  assert.ok(frame.length > 1024, 'expected a real encoded synthetic JPEG');
  assert.equal(frame.readUInt16BE(0), 0xffd8);
  assert.equal(frame.readUInt16BE(frame.length - 2), 0xffd9);
  try {
    await client.input({ type: 'move', displayId: display.id, x: Math.min(80, display.width - 1), y: Math.min(90, display.height - 1) });
    await client.input({ type: 'button', button: 'left', down: true });
    await client.input({ type: 'button', button: 'left', down: false });
    await client.input({ type: 'key', code: 'KeyA', down: true });
    await client.input({ type: 'key', code: 'KeyA', down: false });
    await client.input({ type: 'scroll', deltaX: 0, deltaY: 120 });
  } finally {
    await client.input({ type: 'releaseAll' });
  }
  return frame.length;
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  // Hosts opt into graceful shutdown on stdin EOF. The relay exits on SIGTERM.
  child.stdin.end();
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  for (let i = 0; i < 20 && !exited(); i++) await delay(100);
  if (!exited()) child.kill('SIGTERM');
  for (let i = 0; i < 20 && !exited(); i++) await delay(100);
  if (!exited()) child.kill('SIGKILL');
}

try {
  try { await Promise.all([access(hostBinary), access(relayBinary)]); }
  catch { throw new Error('Build native binaries first with npm run build:native.'); }
  const results = path.join(root, 'test-results');
  await mkdir(results, { recursive: true });
  const runDir = await mkdtemp(path.join(results, 'engine-smoke-'));
  const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(cleanEnv)) if (key.startsWith('REMOTER_RELAY_')) delete cleanEnv[key];

  const directHost = launch(hostBinary, ['--synthetic', '--allow-input', '--exit-on-stdin-close', '--listen', '127.0.0.1:0', '--state-dir', path.join(runDir, 'direct'), '--name', 'Synthetic integration host'], cleanEnv);
  const directInvitation = await ready(directHost);
  const direct = new EngineClient(directInvitation);
  clients.push(direct);
  const directBytes = await exercise(direct);
  direct.close();
  await stop(directHost);
  console.log(`PASS direct: Go synthetic host → pinned TLS 1.3 → Node engine; JPEG ${directBytes} bytes; input/release verified.`);

  const port = await freePort();
  const deviceId = 'smoke-' + randomBytes(6).toString('hex');
  const hostToken = randomBytes(32).toString('base64url');
  const viewerToken = randomBytes(32).toString('base64url');
  const relay = launch(relayBinary, ['-listen', `127.0.0.1:${port}`], { ...cleanEnv, REMOTER_RELAY_DEVICES: JSON.stringify({ [deviceId]: { hostToken, viewerToken } }) });
  relay.stdout.resume();
  await relayReady(port, relay);
  const reverseHost = launch(hostBinary, ['--synthetic', '--allow-input', '--exit-on-stdin-close', '--listen', '127.0.0.1:0', '--state-dir', path.join(runDir, 'relay'), '--name', 'Synthetic relay host'], {
    ...cleanEnv,
    REMOTER_RELAY_URL: `ws://127.0.0.1:${port}`,
    REMOTER_RELAY_DEVICE: deviceId,
    REMOTER_RELAY_TOKEN: hostToken,
    REMOTER_RELAY_VIEWER_TOKEN: viewerToken,
  });
  const reverseInvitation = await ready(reverseHost);
  assert.ok(reverseInvitation.relay, 'host must embed its configured relay route');
  // An intentionally unreachable direct endpoint proves this path cannot be
  // accidentally satisfied by the host's direct HTTPS listener.
  const reversed = new EngineClient({ ...reverseInvitation, endpoint: 'https://cannot-resolve.invalid:1' }, { mode: 'relay' });
  clients.push(reversed);
  let connected = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { await reversed.info(); connected = true; break; }
    catch (error) {
      if (!(error instanceof Error) || !/no available relay connection/.test(error.message)) throw error;
      await delay(150);
    }
  }
  assert.ok(connected, 'host reverse-tunnel pool did not become available');
  const relayBytes = await exercise(reversed);
  reversed.close();
  console.log(`PASS relay: Go synthetic host → real Go relay → pinned inner TLS 1.3 → Node engine; JPEG ${relayBytes} bytes; input/release verified.`);
} catch (error) {
  // Errors from this test do not include raw invitations or subprocess output.
  console.error(`Integration test failed: ${error instanceof Error ? error.message : 'unknown failure'}`);
  process.exitCode = 1;
} finally {
  for (const client of clients) client.close();
  await Promise.all(children.map(stop));
}
