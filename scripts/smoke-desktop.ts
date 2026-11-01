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
  await page.getByRole('heading', { name: 'Devices', exact: true }).waitFor();
  const themeToggle = page.getByRole('switch', { name: 'Dark mode', exact: true });
  for (const dark of [true, false, true]) {
    if ((await themeToggle.getAttribute('aria-checked')) !== String(dark)) await themeToggle.click();
    await page.waitForFunction(expected => getComputedStyle(document.documentElement).colorScheme === expected, dark ? 'dark' : 'light');
    assert.equal(await application.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors), dark);
    await page.screenshot({ path: path.join(resultDir, `desktop-theme-${dark ? 'dark' : 'light'}.png`) });
  }
  await page.reload();
  await page.getByRole('heading', { name: 'Devices', exact: true }).waitFor();
  assert.equal(await themeToggle.getAttribute('aria-checked'), 'true', 'Theme must survive reload');
  await page.setViewportSize({ width: 750, height: 560 });
  await page.getByRole('button', { name: 'Updates', exact: true }).evaluate(button => {
    const header = document.querySelector('.app-header')!;
    const box = button.getBoundingClientRect();
    const reserved = parseFloat(getComputedStyle(header).paddingRight);
    const toggleBox = document.querySelector('.theme-toggle')!.getBoundingClientRect();
    if (toggleBox.right > innerWidth - reserved || box.right > toggleBox.left) throw new Error('Theme toggle overlaps navigation or window controls.');
    if (box.right > innerWidth - reserved) throw new Error('Navigation overlaps the window controls at minimum width.');
  });
  await page.screenshot({ path: path.join(resultDir, 'desktop-home-small.png') });
  await page.setViewportSize({ width: 1120, height: 790 });
  await page.getByRole('button', { name: 'Set up sharing', exact: true }).click();
  assert.equal(await page.getByLabel('Allow keyboard and mouse control', { exact: true }).isChecked(), true);
  await page.getByRole('button', { name: 'Hide details', exact: true }).click();
  await page.getByRole('button', { name: 'Updates', exact: true }).click();
  await page.getByRole('heading', { name: 'App updates', exact: true }).waitFor();
  await page.getByText('Updates are available in the Windows desktop release.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Check for updates', exact: true }).isDisabled().then(disabled => assert.equal(disabled, true));
  await page.screenshot({ path: path.join(resultDir, 'desktop-updates.png') });
  await page.getByRole('button', { name: 'Devices', exact: true }).click();
  await page.screenshot({ path: path.join(resultDir, 'desktop-home.png') });
  const lanListen = await page.evaluate(async () => (await window.remoter!.getState()).hostSuggestedListen);
  if (lanListen && !lanListen.startsWith('127.')) {
    await page.evaluate(async listen => window.remoter!.startHost({ allowInput: false, discover: true, easyLAN: true, listen: listen.replace(/:\d+$/, ':0'), advertise: '' }), lanListen);
    await page.getByRole('button', { name: 'Add device', exact: true }).click();
    await page.getByRole('button', { name: 'Add & connect', exact: true }).waitFor();
    await page.screenshot({ path: path.join(resultDir, 'desktop-discovered-hosts.png') });
    await page.getByRole('button', { name: 'Add & connect', exact: true }).click();
    await page.getByRole('img', { name: 'Remote display of Remoter test display' }).waitFor();
    assert.equal((await page.evaluate(() => window.remoter!.getState())).devices[0].pairing, 'lan');
    await page.getByRole('button', { name: 'Disconnect and return to devices' }).click();
    await page.getByRole('heading', { name: 'Devices', exact: true }).waitFor();
    await page.evaluate(async () => { const api = window.remoter!; const state = await api.getState(); await api.removeDevice(state.devices[0].id); await api.stopHost(); });
    await page.reload();
    await page.getByRole('heading', { name: 'Devices', exact: true }).waitFor();
  }
  await page.getByRole('button', { name: 'Add device', exact: true }).click();
  await page.getByRole('region', { name: 'Nearby computers' }).waitFor();
  await page.getByRole('button', { name: 'Scan again', exact: true }).waitFor();
  await page.screenshot({ path: path.join(resultDir, 'desktop-discovery.png') });
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  invitation = await page.evaluate(async () => (await window.remoter!.startHost({ allowInput: true, allowAudio: true, listen: '127.0.0.1:0', advertise: '' })).invitation);
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
  const remoteScreen = page.locator('.remote-screen');
  assert.equal(await page.getByRole('button', { name: 'Sync text clipboard', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Hear host sound', exact: true }).click();
  await page.getByRole('button', { name: 'Mute host sound', exact: true }).waitFor();
  await page.waitForTimeout(350);
  await page.getByRole('button', { name: 'Mute host sound', exact: true }).click();
  await page.getByRole('button', { name: 'Hear host sound', exact: true }).waitFor();
  assert.equal(await page.getByRole('alert').filter({ hasText: 'Sound:' }).count(), 0);
  await page.getByRole('button', { name: 'Controlling', exact: true }).waitFor();
  assert.equal(await page.getByRole('combobox', { name: /Picture quality/ }).inputValue(), 'lan');
  assert.equal(await remoteScreen.evaluate(element => getComputedStyle(element).cursor), 'default');
  await page.waitForFunction(() => Number(document.querySelector('.capture-cadence')?.textContent?.match(/^(\d+) FPS/)?.[1]) >= 15, undefined, { timeout: 20000 });
  const cadence = await page.locator('.capture-cadence').innerText();
  await remoteScreen.press('Escape');
  await page.getByRole('button', { name: 'View only', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Controlling', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'View only', exact: true }).click();
  await page.getByRole('button', { name: 'Updates', exact: true }).click();
  await page.getByRole('dialog').getByRole('heading', { name: 'App updates', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Disconnect and return to devices' }).count(), 1);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.getByRole('dialog').getByRole('heading', { name: 'Connection settings', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Save settings', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
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
  await page.getByRole('heading', { name: 'Devices', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Options', exact: true }).click();
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
  await page.getByRole('heading', { name: 'Devices', exact: true }).waitFor();
  const restored = await page.evaluate(() => window.remoter!.getState());
  assert.equal(await page.getByRole('switch', { name: 'Dark mode' }).getAttribute('aria-checked'), 'true', 'Theme must survive restart');
  assert.equal(restored.devices.length, 1, 'Encrypted pairing must survive restart');
  assert.equal(restored.hostRunning, false, 'Sharing must not silently restart');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', capture: 'synthetic only', dimensions, cadence, pairingRestored: true, encryptedStorage: true, credentialScope: true, errors }));
} finally {
  if (application) await application.close();
}
