import { _electron as electron, type ElectronApplication } from 'playwright';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { EngineClient, parseInvitation } from '../packages/engine/src/index.js';
import type { RemoterAPI } from '../apps/desktop/src/types.js';
import { electronPath } from './electron-path.js';

// This test never captures a real desktop or injects native input.
const resultDir = path.resolve('test-results');
await mkdir(resultDir, { recursive: true });
const profile = await mkdtemp(path.join(resultDir, 'desktop-profile-'));
const env: NodeJS.ProcessEnv = { ...process.env, REMOTER_TEST_HIDE: '1', REMOTER_TEST_SYNTHETIC: '1', REMOTER_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.REMOTER_DEV_URL;
let application: ElectronApplication | undefined;
let invitation = '';
const errors: string[] = [];
const executablePath = await electronPath();
try {
  application = await electron.launch({ executablePath, args: ['.'], cwd: process.cwd(), env: env as Record<string, string> });
  let page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: 'Your devices', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Updates', exact: true }).click();
  await page.getByRole('heading', { name: 'App updates', exact: true }).waitFor();
  await page.getByText('Updates are available in the Windows desktop release.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Check for updates', exact: true }).isDisabled().then(disabled => assert.equal(disabled, true));
  await page.screenshot({ path: path.join(resultDir, 'desktop-updates.png') });
  await page.getByRole('button', { name: 'Devices', exact: true }).click();
  await page.screenshot({ path: path.join(resultDir, 'desktop-home.png') });
  invitation = await page.evaluate(async () => (await window.remoter!.startHost({ allowInput: true, listen: '127.0.0.1:0', advertise: '' })).invitation);
  await assert.rejects(page.evaluate(() => window.remoter!.installUpdate()), /Stop sharing and disconnect/);
  await page.getByRole('button', { name: 'Add device', exact: true }).click();
  await page.getByLabel('Device invitation').fill(invitation);
  await page.getByRole('dialog').getByRole('button', { name: 'Add device', exact: true }).click();
  const probe = await page.evaluate(async () => {
    const api = window.remoter!; const state = await api.getState();
    try { const info = await api.testDevice(state.devices[0].id); return { ready: true, name: info.name }; }
    catch (error) { return { ready: false, error: error instanceof Error ? error.message : String(error) }; }
  });
  assert.equal(probe.ready, true, probe.error);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  const display = page.getByRole('img', { name: 'Remote display of Remoter test display' });
  try { await display.waitFor({ timeout: 20000 }); }
  catch (error) { console.error((await page.locator('body').innerText()).slice(0, 5000)); await page.screenshot({ path: path.join(resultDir, 'desktop-failure.png') }); throw error; }
  await page.getByText('Synthetic test display', { exact: false }).waitFor();
  const dimensions = await display.evaluate((image: HTMLImageElement) => ({ width: image.naturalWidth, height: image.naturalHeight }));
  assert.ok(dimensions.width >= 320 && dimensions.height >= 180);
  await page.evaluate(async () => {
    const api: RemoterAPI = window.remoter!;
    const { devices } = await api.getState();
    const deviceId = devices[0].id;
    await api.input({ deviceId, event: { type: 'move', displayId: 0, x: 80, y: 90 } });
    await api.input({ deviceId, event: { type: 'key', code: 'KeyA', down: true } });
    await api.input({ deviceId, event: { type: 'releaseAll' } });
  });
  await page.screenshot({ path: path.join(resultDir, 'desktop-session.png') });
  await page.getByRole('button', { name: 'Disconnect and return to devices' }).click();
  await page.getByRole('heading', { name: 'Your devices', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Network', exact: true }).click();
  await page.screenshot({ path: path.join(resultDir, 'desktop-network.png') });
  const state = await page.evaluate(async () => {
    const api = window.remoter!;
    const state = await api.getState();
    const first = await api.saveNetwork({ ...state.network, proxyEnabled: false, proxyHost: 'proxy.example.test', proxyUsername: 'test', proxyPassword: 'test-only-secret' });
    if (!first.network.proxyPasswordSaved || first.network.proxyPassword !== '') throw new Error('Credential was not redacted.');
    const second = await api.saveNetwork({ ...first.network, proxyHost: 'different.example.test' });
    if (second.network.proxyPasswordSaved) throw new Error('Credential leaked across proxy destinations.');
    await api.stopHost();
    return api.getState();
  });
  assert.equal(state.devices.length, 1);
  assert.equal(state.hostRunning, false);
  const encrypted = await readFile(path.join(profile, 'devices.encrypted'));
  const parsed = parseInvitation(invitation);
  assert.equal(encrypted.includes(Buffer.from(parsed.token)), false, 'Stored host token must be encrypted');
  await application.close(); application = undefined;
  const client = new EngineClient(parsed);
  await assert.rejects(client.info());
  client.close();
  application = await electron.launch({ executablePath, args: ['.'], cwd: process.cwd(), env: env as Record<string, string> });
  page = await application.firstWindow();
  await page.getByRole('heading', { name: 'Your devices', exact: true }).waitFor();
  const restored = await page.evaluate(() => window.remoter!.getState());
  assert.equal(restored.devices.length, 1, 'Encrypted pairing must survive restart');
  assert.equal(restored.hostRunning, false, 'Sharing must not silently restart');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', capture: 'synthetic only', dimensions, pairingRestored: true, encryptedStorage: true, credentialScope: true, errors }));
} finally {
  if (application) await application.close();
}
