import { _electron as electron } from 'playwright';
import path from 'node:path';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
const mac = process.platform === 'darwin';
const macDirectory = process.arch === 'arm64' ? 'mac-arm64' : 'mac';
const executablePath = path.resolve(mac ? `release/${macDirectory}/Remoter.app/Contents/MacOS/Remoter` : 'release/win-unpacked/Remoter.exe');
const env: NodeJS.ProcessEnv = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
mkdirSync('test-results', { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), 'remoter-package-'));
const application = await electron.launch({ executablePath, args: [`--user-data-dir=${profile}`], env: env as Record<string, string> });
try {
  const page = await application.firstWindow();
  await page.getByRole('heading', { name: 'Devices', exact: true }).waitFor();
  const state = await page.evaluate(() => window.remoter!.getState());
  assert.equal(typeof state.hostRunning, 'boolean');
  const environment = await application.evaluate(({ app }) => ({ packaged: app.isPackaged, resources: process.resourcesPath }));
  assert.equal(environment.packaged, true);
  assert.ok(existsSync(path.join(environment.resources, 'native', mac ? 'remoter-host' : 'remoter-host.exe')));
  if (mac) {
    const plist = path.resolve(`release/${macDirectory}/Remoter.app/Contents/Info.plist`);
    assert.match(execFileSync('plutil', ['-extract', 'NSLocalNetworkUsageDescription', 'raw', plist], { encoding: 'utf8' }), /local network/i);
    const uuid = (file: string) => execFileSync('dwarfdump', ['--uuid', file], { encoding: 'utf8' }).match(/UUID: ([A-F0-9-]+)/)?.[1];
    const stock = path.resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
    assert.ok(uuid(executablePath), 'Packaged Mac main executable must have a build UUID');
    assert.notEqual(uuid(executablePath), uuid(stock), 'Remoter must not inherit the shared Electron UUID');
    execFileSync('codesign', ['--verify', executablePath]);
    assert.equal(state.platform, 'darwin');
    await page.getByRole('button', { name: 'Add device', exact: true }).click();
    await page.getByRole('button', { name: 'Open Local Network settings', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.getByRole('button', { name: 'Set up sharing', exact: true }).click();
    const permissions = page.getByRole('region', { name: 'Mac permissions', exact: true });
    await permissions.waitFor();
    await page.waitForFunction(() => !document.querySelector('.mac-permissions')?.textContent?.includes('Not checked'));
    const status = await page.evaluate(() => window.remoter!.getHostPermissions());
    assert.equal(typeof status.screen, 'boolean');
    assert.equal(typeof status.input, 'boolean');
    await assert.rejects(page.evaluate(() => window.remoter!.requestHostPermission('camera' as 'screen')), /Unknown macOS permission/);
    assert.equal(await page.getByLabel('Allow two-way text clipboard (Windows host)', { exact: true }).isDisabled(), true);
    assert.equal(await page.getByLabel('Allow system audio (Windows host)', { exact: true }).isDisabled(), true);
    if (!status.screen || !status.input) {
      await assert.rejects(page.evaluate(() => window.remoter!.startHost({ allowInput: true, listen: '127.0.0.1:0', advertise: '' })), /Screen Recording|Accessibility/);
      assert.equal((await page.evaluate(() => window.remoter!.getState())).hostRunning, false);
    }
    await permissions.scrollIntoViewIfNeeded();
    await permissions.screenshot({ path: path.resolve('test-results/packaged-mac-permissions.png') });
  }
  await page.screenshot({ path: path.resolve('test-results/packaged-desktop.png') });
  console.log(`PASS packaged ${mac ? 'Mac' : 'Windows'} app: renderer, isolated IPC, bundled host${mac ? ', permission onboarding and preflight' : ''}. No sharing started.`);
} finally { await application.close(); }
