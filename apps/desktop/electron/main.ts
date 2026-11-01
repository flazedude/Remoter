import { app, BrowserWindow, clipboard, ipcMain, nativeTheme, safeStorage } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { networkInterfaces } from 'node:os';
import { pathToFileURL } from 'node:url';
import { EngineClient, parseInvitation, discoverLAN, pairLANHost, type LANHost, type Invitation, type RouteSettings } from '@remoter/engine';
import type { AppState, Device, NetworkSettings, RemoteInput } from '../src/types.js';
import { InputQueue } from './input-queue.js';
import { UpdateManager } from './update-client.js';
import { UpdateInstallation, updateResume, windowsUpdateScript, type HostOptions, type UpdateResume } from './update-installation.js';

const defaultNetwork: NetworkSettings = { mode: 'direct', proxyEnabled: false, proxyHost: '', proxyPort: 1080, proxyUsername: '', proxyPassword: '', relayUrl: '', relayDeviceId: '', relayToken: '' };
interface SavedDevice extends Device { invitation: Invitation }
interface Store { version: 1; devices: SavedDevice[]; network: NetworkSettings; activity: AppState['activity']; updateResume?: UpdateResume }
let store: Store = { version: 1, devices: [], network: { ...defaultNetwork }, activity: [] };
let window: BrowserWindow | null = null;
let host: ChildProcess | null = null;
let hostInvitation: string | undefined;
let statePath = '';
let writeQueue = Promise.resolve();
const clients = new Map<string, EngineClient>();
const inflightFrames = new Set<string>();
const inflightAudio = new Map<string, { client: EngineClient; pending: ReturnType<EngineClient['audio']> }>();
const discoveredHosts = new Map<string, LANHost>();
let discoveryPending: Promise<LANHost[]> | undefined;
const clipboardStates = new Map<string, { local: string; remote: string }>();
const clipboardQueues = new Map<string, Promise<void>>();
const inputQueues = new Map<string, InputQueue>();
let rendererURL = '';
let updates: UpdateManager;
let updateTimer: ReturnType<typeof setInterval> | undefined;
let installation: UpdateInstallation;
const pendingSessionStarts = new Set<Promise<unknown>>();
let hostOptions: HostOptions | undefined;
let hostLANToken: string | undefined;
let restoredDeviceId: string | undefined;
let updateRestoreError: string | undefined;

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
    activity: store.activity.slice(), hostRunning: !!host, restoredDeviceId, updateRestoreError,
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
async function makeClient(device: SavedDevice) {
  const route = routeFor(device);
  if (device.pairing === 'lan') {
    if (route.mode !== 'direct' || route.proxy) throw new Error('This device uses easy LAN access. Select Direct and turn off SOCKS5, or add its invitation for another route.');
    device.invitation = await pairLANHost(device.invitation);
  }
  return new EngineClient(device.invitation, route);
}
async function disconnect(id: string) {
  const client = clients.get(id);
  if (!client) return;
  // Drop pending input and release immediately after the one in-flight request.
  const queue = inputQueues.get(id);
  await (queue ? queue.send({ type: 'releaseAll' }) : client.input({ type: 'releaseAll' })).catch(() => {});
  queue?.close();
  client.close(); clients.delete(id); inputQueues.delete(id);
  clipboardStates.delete(id); clipboardQueues.delete(id);
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
async function startHost(value: unknown, resumeLANToken?: string): Promise<{ invitation: string }> {
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
  for (const [option, flag] of [['discover', '--discover'], ['easyLAN', '--easy-lan'], ['allowClipboard', '--allow-clipboard'], ['allowAudio', '--allow-audio']] as const) {
    if (options[option] !== undefined && typeof options[option] !== 'boolean') throw new Error('Invalid sharing permission.');
    if (options[option] === true) args.push(flag);
  }
  // Synthetic capture is test-only and never toggled by an untrusted renderer.
  if (!app.isPackaged && process.env.REMOTER_TEST_SYNTHETIC === '1') args.push('--synthetic', '--name', 'Remoter test display');
  const child = spawn(binary, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, REMOTER_UPDATE_LAN_TOKEN: resumeLANToken ?? '' } });
  host = child;
  child.once('exit', () => { if (host === child) { host = null; hostInvitation = undefined; hostOptions = undefined; hostLANToken = undefined; } });
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
            hostLANToken = typeof message.lanToken === 'string' && /^[A-Za-z0-9_-]{43}$/.test(message.lanToken) ? message.lanToken : undefined;
            hostOptions = { listen: typeof message.listen === 'string' ? message.listen : listen, advertise, allowInput: options.allowInput as boolean,
              discover: options.discover === true, easyLAN: options.easyLAN === true, allowClipboard: options.allowClipboard === true, allowAudio: options.allowAudio === true };
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
  const child = host; host = null; hostInvitation = undefined; hostOptions = undefined; hostLANToken = undefined;
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
      if (name === 'connect' || name === 'startHost') {
        if (installation.active) throw new Error('Remoter is restarting to install an update.');
        const pending = Promise.resolve().then(() => handler(...args)).finally(() => { pendingSessionStarts.delete(pending); });
        pendingSessionStarts.add(pending);
        return pending;
      }
      return handler(...args);
    });
  }
  handle('setTheme', theme => {
    if (theme !== 'light' && theme !== 'dark') throw new Error('Invalid theme.');
    nativeTheme.themeSource = theme;
  });
  handle('getState', publicState);
  handle('getUpdates', () => updates.snapshot());
  handle('checkUpdates', () => installation.active ? updates.snapshot() : updates.check());
  handle('installUpdate', () => installation.install());
  handle('addDevice', async raw => {
    const invitation = parseInvitation(text(raw, 'invitation', 16384));
    const id = createHash('sha256').update(invitation.certificate).digest('hex').slice(0, 32);
    const existing = store.devices.find(d => d.id === id);
    if (existing) { await disconnect(id); existing.invitation = invitation; existing.endpoint = invitation.endpoint; existing.name = invitation.name; delete existing.pairing; }
    else store.devices.push({ id, name: invitation.name, endpoint: invitation.endpoint, invitation, addedAt: new Date().toISOString(), status: 'unknown' });
    audit(invitation.name, existing ? 'Pairing updated' : 'Device paired'); await persist(); return publicState();
  });
  handle('discoverLAN', async () => {
    if (store.network.proxyEnabled || store.network.mode !== 'direct') throw new Error('LAN discovery requires Direct mode with SOCKS5 turned off.');
    const testPort = !app.isPackaged && process.env.REMOTER_TEST_SYNTHETIC === '1' && process.env.REMOTER_TEST_DISCOVERY_PORT ? Number(process.env.REMOTER_TEST_DISCOVERY_PORT) : undefined;
    discoveryPending ??= discoverLAN(undefined, testPort).finally(() => { discoveryPending = undefined; });
    const hosts = await discoveryPending;
    discoveredHosts.clear();
    for (const host of hosts) discoveredHosts.set(host.id, host);
    return hosts.map(({ certificate: _certificate, ...host }) => host);
  });
  handle('addLANDevice', async raw => {
    if (store.network.proxyEnabled || store.network.mode !== 'direct') throw new Error('Easy LAN access requires Direct mode with SOCKS5 turned off.');
    const host = discoveredHosts.get(text(raw, 'LAN device ID', 80));
    if (!host || !host.easy) throw new Error('Scan again, or enable easy LAN connections on the host.');
    const existing = store.devices.find(device => device.id === host.id);
    // A manual pairing keeps its durable credentials and configured routes.
    if (existing && existing.pairing !== 'lan') return { state: publicState(), deviceId: existing.id };
    const invitation = await pairLANHost(host);
    await disconnect(host.id);
    if (existing) Object.assign(existing, { invitation, endpoint: host.endpoint, name: host.name });
    else store.devices.push({ id: host.id, name: host.name, endpoint: host.endpoint, invitation, pairing: 'lan', addedAt: new Date().toISOString(), status: 'unknown' });
    audit(host.name, 'Device added through easy LAN access'); await persist();
    return { state: publicState(), deviceId: host.id };
  });
  handle('removeDevice', async raw => { const device = findDevice(raw); await disconnect(device.id); store.devices = store.devices.filter(d => d.id !== device.id); audit(device.name, 'Device removed from this controller'); await persist(); return publicState(); });
  handle('saveNetwork', async raw => { const settings = validateNetwork(raw); updates.setProxyEnabled(settings.proxyEnabled); await disconnectAll(); store.network = settings; audit('This computer', 'Connection settings updated'); await persist(); return publicState(); });
  handle('testDevice', async raw => { const device = findDevice(raw); let client: EngineClient | undefined; try { client = await makeClient(device); const info = await client.info(); device.status = 'ready'; return info; } catch (error) { device.status = 'offline'; throw error; } finally { client?.close(); } });
  handle('connect', async raw => { const device = findDevice(raw); await disconnect(device.id); let client: EngineClient | undefined; try { client = await makeClient(device); const info = await client.info(); clients.set(device.id, client); restoredDeviceId = undefined; device.status = 'ready'; device.lastConnectedAt = new Date().toISOString(); audit(device.name, 'Session started'); await persist(); return info; } catch (error) { client?.close(); clients.delete(device.id); device.status = 'offline'; throw error; } });
  handle('audio', async raw => {
    const options = record(raw), id = findDevice(options.deviceId).id, client = clients.get(id);
    if (!client) throw new Error('Start a session first.');
    const after = integer(options.after, 0, Number.MAX_SAFE_INTEGER);
    const existing = inflightAudio.get(id);
    if (existing?.client === client) return existing.pending;
    const pending = client.audio(after);
    inflightAudio.set(id, { client, pending });
    try { return await pending; } finally { if (inflightAudio.get(id)?.pending === pending) inflightAudio.delete(id); }
  });
  handle('clipboardSync', raw => {
    const options = record(raw), id = findDevice(options.deviceId).id, client = clients.get(id);
    if (!client) throw new Error('Start a session first.');
    if (!['send', 'receive', 'both', 'reset'].includes(String(options.direction))) throw new Error('Invalid clipboard direction.');
    const pending = (clipboardQueues.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (clients.get(id) !== client) return;
      if (options.direction === 'reset') { clipboardStates.delete(id); return; }
      let local = await clipboard.readText(), remote = await client.readClipboard();
      if (clients.get(id) !== client) return;
      if (Buffer.byteLength(local) > 1024 * 1024) throw new Error('Clipboard text exceeds 1 MiB.');
      const previous = clipboardStates.get(id);
      const send = options.direction === 'send' || (options.direction === 'both' && previous && local.length > 0 && local !== previous.local);
      const receive = options.direction === 'receive' || (options.direction === 'both' && previous && remote.length > 0 && remote !== previous.remote);
      if (send && local !== remote) { await client.writeClipboard(local); remote = local; }
      else if (receive && local !== remote) {
        // Do not overwrite text copied locally while the network request ran.
        if (clients.get(id) !== client || await clipboard.readText() !== local) return;
        await clipboard.writeText(remote); local = remote;
      }
      if (clients.get(id) === client) clipboardStates.set(id, { local, remote });
    });
    clipboardQueues.set(id, pending);
    return pending;
  });
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
  handle('disconnect', async raw => { restoredDeviceId = undefined; await disconnect(findDevice(raw).id); await persist(); return publicState(); });
  handle('startHost', value => startHost(value));
  handle('stopHost', stopHost);
  handle('copy', raw => clipboard.writeText(text(raw, 'clipboard text', 16384)));
}

app.whenReady().then(async () => {
  if (process.env.REMOTER_USER_DATA && !app.isPackaged) app.setPath('userData', path.resolve(process.env.REMOTER_USER_DATA));
  statePath = path.join(app.getPath('userData'), 'devices.encrypted');
  updates = new UpdateManager({ currentVersion: app.getVersion(), cacheDirectory: path.join(app.getPath('userData'), 'updates'), enabled: app.isPackaged && process.platform === 'win32' && process.arch === 'x64' });
  await loadStore();
  installation = new UpdateInstallation({
    installer: () => updates.installer(),
    settleStarts: async () => { await Promise.allSettled([...pendingSessionStarts]); },
    saveResume: async () => {
      store.updateResume = { version: updates.snapshot().availableVersion!, createdAt: Date.now(), host: host ? hostOptions : undefined, lanToken: host ? hostLANToken : undefined, deviceId: [...clients.keys()][0] };
      await persist();
    },
    clearResume: async () => { if (store.updateResume) { delete store.updateResume; await persist(); } },
    launch: async installer => {
      const script = windowsUpdateScript(process.pid, installer, process.env.PORTABLE_EXECUTABLE_FILE || process.execPath);
      const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { detached: true, stdio: 'ignore', windowsHide: true });
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
    },
    quit: () => { setTimeout(() => app.quit(), 200); }
  });
  const resume = updateResume(store.updateResume, app.getVersion(), process.argv);
  if (store.updateResume) { delete store.updateResume; await persist(); }
  if (resume) {
    if (resume.host) {
      try { await startHost(resume.host, resume.lanToken); }
      catch { updateRestoreError = 'Sharing could not be restored after the update. Open Devices to start sharing again.'; }
    }
    restoredDeviceId = store.devices.some(device => device.id === resume.deviceId) ? resume.deviceId : undefined;
    if (process.argv.includes('--remoter-update-failed')) updateRestoreError = 'The update installer failed. Your previous version has reopened; try installing again.';
  }
  if (store.network.proxyEnabled) updates.setProxyEnabled(true);
  const indexPath = path.join(__dirname, 'renderer', 'index.html');
  rendererURL = !app.isPackaged && process.env.REMOTER_DEV_URL === 'http://127.0.0.1:5173' ? `${process.env.REMOTER_DEV_URL}/` : pathToFileURL(indexPath).href;
  window = new BrowserWindow({ title: 'Remoter', width: 1120, height: 790, minWidth: 750, minHeight: 560, show: false, backgroundColor: '#f8fafc', autoHideMenuBar: true,
    ...(process.platform === 'win32' ? { titleBarStyle: 'hidden' as const, titleBarOverlay: { height: 51, color: nativeTheme.shouldUseDarkColors ? '#1e1f23' : '#ffffff', symbolColor: nativeTheme.shouldUseDarkColors ? '#eeeff2' : '#24272e' } } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false,
      offscreen: !app.isPackaged && process.env.REMOTER_TEST_HIDE === '1', backgroundThrottling: false } });
  const updateTitleBar = () => { if (process.platform === 'win32' && window && !window.isDestroyed()) window.setTitleBarOverlay({ color: nativeTheme.shouldUseDarkColors ? '#1e1f23' : '#ffffff', symbolColor: nativeTheme.shouldUseDarkColors ? '#eeeff2' : '#24272e' }); };
  nativeTheme.on('updated', updateTitleBar);
  window.on('closed', () => nativeTheme.removeListener('updated', updateTitleBar));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  registerIPC();
  window.once('ready-to-show', () => { if (app.isPackaged || process.env.REMOTER_TEST_HIDE !== '1') window?.show(); });
  await window.loadURL(rendererURL);
  if (app.isPackaged && process.platform === 'win32' && process.arch === 'x64') {
    setTimeout(() => { if (!installation.active) void updates.check(); }, 10000).unref();
    updateTimer = setInterval(() => { if (!installation.active) void updates.check(); }, 30 * 60 * 1000); updateTimer.unref();
  }
  window.on('closed', () => { window = null; });
}).catch(error => { console.error('Remoter startup failed:', error instanceof Error ? error.message : 'Unknown error'); app.quit(); });

app.on('window-all-closed', () => app.quit());
let quitting = false;
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault(); quitting = true;
  clearInterval(updateTimer);
  Promise.race([disconnectAll(), new Promise(resolve => setTimeout(resolve, 1500))]).finally(async () => {
    if (host) await endHost(host); host = null;
    await writeQueue.catch(() => {});
    app.quit();
  });
});
