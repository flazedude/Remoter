import { app, BrowserWindow, clipboard, ipcMain, safeStorage } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { networkInterfaces } from 'node:os';
import { pathToFileURL } from 'node:url';
import { EngineClient, parseInvitation, type Invitation, type RouteSettings } from '@remoter/engine';
import type { AppState, Device, NetworkSettings, RemoteInput } from '../src/types.js';
import { InputQueue } from './input-queue.js';

const defaultNetwork: NetworkSettings = { mode: 'direct', proxyEnabled: false, proxyHost: '', proxyPort: 1080, proxyUsername: '', proxyPassword: '', relayUrl: '', relayDeviceId: '', relayToken: '' };
interface SavedDevice extends Device { invitation: Invitation }
interface Store { version: 1; devices: SavedDevice[]; network: NetworkSettings; activity: AppState['activity'] }
let store: Store = { version: 1, devices: [], network: { ...defaultNetwork }, activity: [] };
let window: BrowserWindow | null = null;
let host: ChildProcess | null = null;
let hostInvitation: string | undefined;
let statePath = '';
let writeQueue = Promise.resolve();
const clients = new Map<string, EngineClient>();
const inflightFrames = new Set<string>();
const inputQueues = new Map<string, InputQueue>();
let rendererURL = '';

function text(value: unknown, name: string, max = 2048): string {
  if (typeof value !== 'string' || value.length > max) throw new Error(`Invalid ${name}.`);
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid request.');
  return value as Record<string, unknown>;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error('Invalid numeric setting.');
  return value;
}
function publicState(): AppState {
  const addresses = Object.values(networkInterfaces()).flat().filter(item => item && !item.internal && item.family === 'IPv4').map(item => item!.address);
  const lan = addresses.find(ip => /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(ip));
  const tailnet = addresses.find(ip => { const parts = ip.split('.').map(Number); return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127; });
  const suggested = `${lan || tailnet || '127.0.0.1'}:45780`;
  return {
    devices: store.devices.map(({ invitation: _secret, ...device }) => ({ ...device })),
    network: { ...store.network, proxyPassword: '', proxyPasswordSaved: !!store.network.proxyPassword, relayToken: '', relayTokenSaved: !!store.network.relayToken },
    activity: store.activity.slice(), hostRunning: !!host,
    hostSuggestedListen: suggested, hostSuggestedEndpoint: `https://${suggested}`,
    ...(hostInvitation ? { hostInvitation } : {})
  };
}
function audit(deviceName: string, action: string) {
  store.activity.unshift({ id: randomUUID(), at: new Date().toISOString(), deviceName, action });
  store.activity = store.activity.slice(0, 250);
}
async function persist() {
  const snapshot = JSON.stringify(store);
  const pending = writeQueue.catch(() => {}).then(async () => {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('OS credential storage is unavailable. Remoter will not save credentials unencrypted.');
    const encrypted = await safeStorage.encryptStringAsync(snapshot);
    const temporary = `${statePath}.tmp`;
    await writeFile(temporary, encrypted, { mode: 0o600 });
    await rename(temporary, statePath);
  });
  writeQueue = pending;
  return pending;
}
async function loadStore() {
  await mkdir(path.dirname(statePath), { recursive: true });
  if (!existsSync(statePath)) return;
  if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('OS credential storage is unavailable.');
  const bytes = await readFile(statePath);
  const decrypted = await safeStorage.decryptStringAsync(bytes);
  const decoded = JSON.parse(decrypted.result) as Store;
  if (decoded.version !== 1 || !Array.isArray(decoded.devices) || !Array.isArray(decoded.activity) || !decoded.network) throw new Error('Unsupported or damaged device store.');
  store = decoded;
  for (const device of store.devices) device.status = 'unknown';
  if (decrypted.shouldReEncrypt) await persist();
}
function findDevice(id: unknown) {
  const device = store.devices.find(d => d.id === text(id, 'device ID', 80));
  if (!device) throw new Error('This device is no longer paired.');
  return device;
}
function routeFor(device: SavedDevice): RouteSettings {
  const settings = store.network;
  const route: RouteSettings = { mode: settings.mode };
  if (settings.proxyEnabled) route.proxy = { host: settings.proxyHost, port: settings.proxyPort, username: settings.proxyUsername || undefined, password: settings.proxyPassword || undefined };
  if (settings.mode === 'relay') {
    const relay = device.invitation.relay;
    const url = settings.relayUrl || relay?.url || '';
    const deviceId = settings.relayDeviceId || relay?.deviceId || '';
    const canonical = (value: string) => { const parsed = new URL(value); parsed.pathname = '/v1/tunnel'; return parsed.href; };
    const sameDestination = !!relay && !!url && canonical(url) === canonical(relay.url) && deviceId === relay.deviceId;
    const token = settings.relayToken || (sameDestination ? relay?.token : '') || '';
    if (!token) throw new Error('Enter an access token for this relay destination. Pairing credentials are never reused for a different relay.');
    route.relay = { url, deviceId, token };
  }
  return route;
}
function makeClient(device: SavedDevice) { return new EngineClient(device.invitation, routeFor(device)); }
async function disconnect(id: string) {
  const client = clients.get(id);
  if (!client) return;
  // Drop pending input and release immediately after the one in-flight request.
  const queue = inputQueues.get(id);
  await (queue ? queue.send({ type: 'releaseAll' }) : client.input({ type: 'releaseAll' })).catch(() => {});
  queue?.close();
  client.close(); clients.delete(id); inputQueues.delete(id);
  const device = findDevice(id);
  audit(device.name, 'Session ended');
}
async function disconnectAll() { await Promise.all([...clients.keys()].map(disconnect)); }
function validateInput(value: unknown): RemoteInput {
  const e = record(value);
  switch (e.type) {
    case 'move': return { type: 'move', displayId: integer(e.displayId, 0, 64), x: integer(e.x, 0, 65535), y: integer(e.y, 0, 65535) };
    case 'button': if (!['left', 'middle', 'right'].includes(String(e.button)) || typeof e.down !== 'boolean') throw new Error('Invalid mouse button.'); return { type: 'button', button: e.button as 'left', down: e.down };
    case 'key': if (typeof e.down !== 'boolean') throw new Error('Invalid key state.'); return { type: 'key', code: text(e.code, 'key code', 40), down: e.down };
    case 'scroll': return { type: 'scroll', deltaX: integer(e.deltaX, -1200, 1200), deltaY: integer(e.deltaY, -1200, 1200) };
    case 'releaseAll': return { type: 'releaseAll' };
    default: throw new Error('Unknown input event.');
  }
}
function validateNetwork(value: unknown): NetworkSettings {
  const n = record(value);
  if (!['direct', 'tailscale', 'relay'].includes(String(n.mode)) || typeof n.proxyEnabled !== 'boolean') throw new Error('Invalid connection mode.');
  const settings: NetworkSettings = {
    mode: n.mode as NetworkSettings['mode'], proxyEnabled: n.proxyEnabled,
    proxyHost: text(n.proxyHost, 'proxy host', 253).trim(), proxyPort: integer(n.proxyPort, 1, 65535),
    proxyUsername: text(n.proxyUsername, 'proxy username', 255), proxyPassword: text(n.proxyPassword, 'proxy password', 255),
    relayUrl: text(n.relayUrl, 'relay URL').trim(), relayDeviceId: text(n.relayDeviceId, 'relay device ID', 128).trim(), relayToken: text(n.relayToken, 'relay token')
  };
  if (!settings.proxyPassword && n.proxyPasswordSaved === true && settings.proxyHost === store.network.proxyHost && settings.proxyPort === store.network.proxyPort && settings.proxyUsername === store.network.proxyUsername) settings.proxyPassword = store.network.proxyPassword;
  if (!settings.relayToken && n.relayTokenSaved === true && settings.relayUrl === store.network.relayUrl && settings.relayDeviceId === store.network.relayDeviceId) settings.relayToken = store.network.relayToken;
  if (settings.proxyEnabled && (!settings.proxyHost || /[\s/@]/.test(settings.proxyHost))) throw new Error('Enter a valid SOCKS5 host.');
  if (settings.mode === 'tailscale' && settings.proxyEnabled) throw new Error('Tailscale uses its own network service. Choose direct or relay for an explicit SOCKS5 route.');
  if (settings.relayUrl) {
    const url = new URL(settings.relayUrl);
    if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Relay URLs must use wss://, except loopback development.');
    if (url.username || url.password) throw new Error('Put relay credentials in the token field.');
  }
  return settings;
}
function hostBinary() {
  const filename = `remoter-host${process.platform === 'win32' ? '.exe' : ''}`;
  return app.isPackaged ? path.join(process.resourcesPath, 'native', filename) : path.join(app.getAppPath(), 'native', 'bin', filename);
}
async function startHost(value: unknown): Promise<{ invitation: string }> {
  if (host) throw new Error('Sharing is already running.');
  const options = record(value);
  const listen = text(options.listen, 'listen address', 280).trim();
  const advertise = text(options.advertise, 'advertised address', 2048).trim();
  if (typeof options.allowInput !== 'boolean') throw new Error('Choose whether remote input is allowed.');
  if (!/^(?:[a-zA-Z0-9.\-]+|\[[a-fA-F0-9:]+\]):\d{1,5}$/.test(listen)) throw new Error('Use a listen address such as 127.0.0.1:45780 or 0.0.0.0:45780.');
  if (advertise && new URL(advertise).protocol !== 'https:') throw new Error('The advertised address must use https://.');
  const binary = hostBinary();
  if (!existsSync(binary)) throw new Error('Build the native host first: npm run build:native');
  const args = ['--listen', listen, '--state-dir', path.join(app.getPath('userData'), 'host'), '--exit-on-stdin-close'];
  if (advertise) args.push('--advertise', advertise);
  if (options.allowInput) args.push('--allow-input');
  // Synthetic capture is test-only and never toggled by an untrusted renderer.
  if (!app.isPackaged && process.env.REMOTER_TEST_SYNTHETIC === '1') args.push('--synthetic', '--name', 'Remoter test display');
  const child = spawn(binary, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  host = child;
  child.once('exit', () => { if (host === child) { host = null; hostInvitation = undefined; } });
  return new Promise((resolve, reject) => {
    let output = '', errorOutput = '', settled = false;
    const timeout = setTimeout(() => fail(new Error('Host startup timed out. Check OS capture permissions.')), 20000);
    const fail = (error: Error) => { if (settled) return; settled = true; clearTimeout(timeout); child.kill(); if (host === child) host = null; reject(error); };
    child.on('error', fail);
    child.stderr?.on('data', chunk => { errorOutput = (errorOutput + chunk.toString()).slice(-2000); });
    child.on('exit', code => { if (!settled) fail(new Error(`Host exited (${code ?? 'signal'}). ${errorOutput}`)); });
    child.stdout?.on('data', chunk => {
      output += chunk.toString();
      if (output.length > 65536) return fail(new Error('Invalid host startup response.'));
      let newline: number;
      while ((newline = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, newline).trim(); output = output.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (!settled && message.event === 'ready' && typeof message.invitation === 'string') {
            parseInvitation(message.invitation);
            settled = true; clearTimeout(timeout); hostInvitation = message.invitation;
            audit('This computer', options.allowInput ? 'Sharing started with input enabled' : 'View-only sharing started');
            void persist().catch(() => {});
            resolve({ invitation: message.invitation });
          }
        } catch { /* Ignore ordinary stdout lines; never echo invitation secrets. */ }
      }
    });
  });
}
async function stopHost() {
  const child = host; host = null; hostInvitation = undefined;
  if (!child) return;
  await endHost(child); audit('This computer', 'Sharing stopped'); await persist();
}
function endHost(child: ChildProcess): Promise<void> {
  return new Promise(resolve => {
    if (child.exitCode !== null) { resolve(); return; }
    const timer = setTimeout(() => { child.kill(); resolve(); }, 2500);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.stdin?.end();
  });
}
function registerIPC() {
  function handle(name: string, handler: (...args: unknown[]) => unknown) {
    ipcMain.handle(`remoter:${name}`, (event, ...args: unknown[]) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== rendererURL) throw new Error('Untrusted application frame.');
      return handler(...args);
    });
  }
  handle('getState', publicState);
  handle('addDevice', async raw => {
    const invitation = parseInvitation(text(raw, 'invitation', 16384));
    const id = createHash('sha256').update(invitation.certificate).digest('hex').slice(0, 32);
    const existing = store.devices.find(d => d.id === id);
    if (existing) { await disconnect(id); existing.invitation = invitation; existing.endpoint = invitation.endpoint; existing.name = invitation.name; }
    else store.devices.push({ id, name: invitation.name, endpoint: invitation.endpoint, invitation, addedAt: new Date().toISOString(), status: 'unknown' });
    audit(invitation.name, existing ? 'Pairing updated' : 'Device paired'); await persist(); return publicState();
  });
  handle('removeDevice', async raw => { const device = findDevice(raw); await disconnect(device.id); store.devices = store.devices.filter(d => d.id !== device.id); audit(device.name, 'Device removed from this controller'); await persist(); return publicState(); });
  handle('saveNetwork', async raw => { const settings = validateNetwork(raw); await disconnectAll(); store.network = settings; audit('This computer', 'Connection settings updated'); await persist(); return publicState(); });
  handle('testDevice', async raw => { const device = findDevice(raw), client = makeClient(device); try { const info = await client.info(); device.status = 'ready'; return info; } catch (error) { device.status = 'offline'; throw error; } finally { client.close(); } });
  handle('connect', async raw => { const device = findDevice(raw); await disconnect(device.id); const client = makeClient(device); try { const info = await client.info(); clients.set(device.id, client); device.status = 'ready'; device.lastConnectedAt = new Date().toISOString(); audit(device.name, 'Session started'); await persist(); return info; } catch (error) { client.close(); clients.delete(device.id); device.status = 'offline'; throw error; } });
  handle('frame', async raw => {
    const options = record(raw), id = findDevice(options.deviceId).id, client = clients.get(id);
    if (!client) throw new Error('Start a session first.');
    if (inflightFrames.has(id)) throw new Error('A frame is already in flight.');
    inflightFrames.add(id);
    try { const bytes = await client.frame({ display: integer(options.displayId, 0, 64), quality: integer(options.quality, 20, 90), width: integer(options.width, 320, 3840) }); return `data:image/jpeg;base64,${bytes.toString('base64')}`; }
    finally { inflightFrames.delete(id); }
  });
  handle('input', async raw => {
    const options = record(raw), id = findDevice(options.deviceId).id, client = clients.get(id);
    if (!client) throw new Error('Start a session first.');
    const event = validateInput(options.event);
    let queue = inputQueues.get(id);
    if (!queue) { queue = new InputQueue(input => client.input(input)); inputQueues.set(id, queue); }
    return queue.send(event);
  });
  handle('disconnect', async raw => { await disconnect(findDevice(raw).id); await persist(); return publicState(); });
  handle('startHost', startHost);
  handle('stopHost', stopHost);
  handle('copy', raw => { clipboard.writeText(text(raw, 'clipboard text', 16384)); });
}

app.whenReady().then(async () => {
  if (process.env.REMOTER_USER_DATA && !app.isPackaged) app.setPath('userData', path.resolve(process.env.REMOTER_USER_DATA));
  statePath = path.join(app.getPath('userData'), 'devices.encrypted');
  await loadStore();
  const indexPath = path.join(__dirname, 'renderer', 'index.html');
  rendererURL = !app.isPackaged && process.env.REMOTER_DEV_URL === 'http://127.0.0.1:5173' ? `${process.env.REMOTER_DEV_URL}/` : pathToFileURL(indexPath).href;
  window = new BrowserWindow({ title: 'Remoter', width: 1120, height: 790, minWidth: 750, minHeight: 560, show: false, backgroundColor: '#f8fafc', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false,
      offscreen: !app.isPackaged && process.env.REMOTER_TEST_HIDE === '1', backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  registerIPC();
  window.once('ready-to-show', () => { if (app.isPackaged || process.env.REMOTER_TEST_HIDE !== '1') window?.show(); });
  await window.loadURL(rendererURL);
  window.on('closed', () => { window = null; });
}).catch(error => { console.error('Remoter startup failed:', error instanceof Error ? error.message : 'Unknown error'); app.quit(); });

app.on('window-all-closed', () => app.quit());
let quitting = false;
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault(); quitting = true;
  Promise.race([disconnectAll(), new Promise(resolve => setTimeout(resolve, 1500))]).finally(async () => {
    if (host) await endHost(host); host = null; app.quit();
  });
});
