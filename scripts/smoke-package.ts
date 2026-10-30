import { _electron as electron } from 'playwright';
import path from 'node:path';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
const executablePath = path.resolve('release/win-unpacked/Remoter.exe');
const env: NodeJS.ProcessEnv = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const application = await electron.launch({ executablePath, args: [], env: env as Record<string, string> });
try {
  const page = await application.firstWindow();
  await page.getByRole('heading', { name: 'Your devices', exact: true }).waitFor();
  const state = await page.evaluate(() => window.remoter!.getState());
  assert.equal(typeof state.hostRunning, 'boolean');
  const environment = await application.evaluate(({ app }) => ({ packaged: app.isPackaged, resources: process.resourcesPath }));
  assert.equal(environment.packaged, true);
  assert.ok(existsSync(path.join(environment.resources, 'native', 'remoter-host.exe')));
  await page.screenshot({ path: path.resolve('test-results/packaged-desktop.png') });
  console.log('PASS packaged Windows app: renderer, isolated IPC, and bundled host path. No sharing started.');
} finally { await application.close(); }
