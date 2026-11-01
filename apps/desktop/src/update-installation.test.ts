import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { launchWindowsUpdate, UpdateInstallation, updateResume, windowsUpdateScript, type UpdateResume } from '../electron/update-installation.js';

test('installation waits for in-flight starts, saves handoff, launches, then quits; duplicate clicks are rejected', async () => {
  const events: string[] = [];
  let ready!: () => void;
  const start = new Promise<void>(resolve => { ready = resolve; });
  const installation = new UpdateInstallation({
    installer: async () => { events.push('verify'); return 'verified.exe'; },
    settleStarts: async () => { await start; events.push('settled'); },
    saveResume: async () => { events.push('save sharing and session'); },
    clearResume: async () => { events.push('clear'); },
    launch: async installer => { assert.equal(installer, 'verified.exe'); events.push('launch'); },
    quit: () => { events.push('quit'); }
  });
  const pending = installation.install();
  await assert.rejects(installation.install(), /already starting/);
  assert.deepEqual(events, ['verify']);
  ready(); await pending;
  assert.deepEqual(events, ['verify', 'settled', 'save sharing and session', 'launch', 'quit']);
});

test('verification, persistence, and launch failures leave the running app available and allow retry', async () => {
  for (const failure of ['verify', 'save', 'launch']) {
    let quit = false, resume = false;
    const step = async (name: string) => { if (failure === name) throw new Error(name); };
    const installation = new UpdateInstallation({
      installer: async () => { await step('verify'); return 'verified.exe'; },
      settleStarts: async () => {},
      saveResume: async () => { resume = true; await step('save'); },
      clearResume: async () => { resume = false; },
      launch: async () => step('launch'),
      quit: () => { quit = true; }
    });
    await assert.rejects(installation.install(), new RegExp(failure));
    assert.equal(quit, false); assert.equal(resume, false); assert.equal(installation.active, false);
    await assert.rejects(installation.install(), new RegExp(failure));
  }
});

test('handoff restores only the intended update or failed installer, and rejects stale or ordinary launches', () => {
  const now = Date.now();
  const resume: UpdateResume = { version: '0.1.0-alpha.4', createdAt: now, host: { listen: '127.0.0.1:45780', advertise: '', allowInput: false, allowAudio: false }, deviceId: 'paired-device' };
  assert.equal(updateResume(resume, resume.version, ['--updated'], now), resume);
  assert.equal(updateResume(resume, 'old', ['--remoter-update-failed'], now), resume);
  for (const args of [[], ['--force-run'], ['--updated']]) assert.equal(updateResume(resume, 'old', args, now), undefined);
  assert.equal(updateResume(resume, resume.version, [], now), undefined);
  assert.equal(updateResume(resume, resume.version, ['--updated'], now + 3600001), undefined);
  assert.equal(updateResume(resume, resume.version, ['--updated'], now - 1), undefined);
  assert.equal(updateResume(undefined, resume.version, ['--updated'], now), undefined);
});

test('Windows helper waits for the parent, silently installs into the existing directory and explicitly restarts, including quoted paths', { skip: process.platform !== 'win32' }, async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "remoter update's [test]-"));
  const installer = path.join(folder, 'setup.cmd');
  const output = path.join(folder, 'installed.txt');
  const executable = path.join(folder, 'remoter.cmd');
  await writeFile(installer, '@echo off\r\n> "%~dp0installed.txt" echo %*\r\nexit /b 0\r\n');
  await writeFile(executable, '@echo off\r\n> "%~dp0restarted.txt" echo %*\r\n');
  const parent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2500)'], { windowsHide: true, stdio: 'ignore' });
  const powershell = path.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = windowsUpdateScript(parent.pid!, installer, executable);
  const helper = spawn(powershell, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'pipe' });
  let diagnostics = ''; helper.stderr.on('data', data => { diagnostics += data; });
  const finished = new Promise<number | null>((resolve, reject) => { helper.once('exit', resolve); helper.once('error', reject); });
  try {
    await new Promise(resolve => setTimeout(resolve, 500));
    await assert.rejects(access(output), { code: 'ENOENT' });
    assert.equal(await finished, 0, diagnostics);
    assert.equal((await readFile(output, 'utf8')).trim(), `/S --updated /D=${folder}`);
    await waitForFile(path.join(folder, 'restarted.txt'), '--updated');
  } finally { parent.kill(); helper.kill(); }
});

async function waitForFile(filename: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await readFile(filename, 'utf8')).trim() === expected) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal((await readFile(filename, 'utf8')).trim(), expected);
}

test('launcher waits for helper readiness and keeps the app alive on preflight failure', { skip: process.platform !== 'win32' }, async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'remoter-handshake-'));
  await assert.rejects(launchWindowsUpdate(process.pid, path.join(folder, 'missing.exe'), process.execPath), /installer is missing/);
  const installer = path.join(folder, 'setup.cmd'), executable = path.join(folder, 'app.cmd');
  const logFile = path.join(folder, 'installation.log');
  await writeFile(installer, '@echo off\r\n> "%~dp0installed.txt" echo %*\r\nexit /b 0\r\n');
  await writeFile(executable, '@echo off\r\n> "%~dp0restarted.txt" echo %*\r\n');
  const parent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { windowsHide: true, stdio: 'ignore' });
  try {
    await launchWindowsUpdate(parent.pid!, installer, executable, { logFile });
    assert.match(await readFile(logFile, 'utf8'), /Helper ready/);
    await assert.rejects(access(path.join(folder, 'installed.txt')), { code: 'ENOENT' });
    parent.kill();
    await waitForFile(path.join(folder, 'restarted.txt'), '--updated');
    assert.match(await readFile(logFile, 'utf8'), /Setup completed successfully/);
  } finally { parent.kill(); }
});

test('the Windows update helper survives the launching app exiting', { skip: process.platform !== 'win32' }, async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'remoter-helper-lifetime-'));
  const installer = path.join(folder, 'setup.cmd'), executable = path.join(folder, 'app.cmd');
  await writeFile(installer, '@echo off\r\n> "%~dp0installed.txt" echo %*\r\nexit /b 0\r\n');
  await writeFile(executable, '@echo off\r\n> "%~dp0restarted.txt" echo %*\r\n');
  const launcher = path.join(folder, 'launch.mjs');
  const moduleURL = pathToFileURL(path.resolve('apps/desktop/electron/update-installation.ts')).href;
  await writeFile(launcher, `import { launchWindowsUpdate } from ${JSON.stringify(moduleURL)};\nawait launchWindowsUpdate(process.pid, ${JSON.stringify(installer)}, ${JSON.stringify(executable)}, { logFile: ${JSON.stringify(path.join(folder, 'installation.log'))} });\n`);
  const child = spawn(process.execPath, ['--import', pathToFileURL(path.resolve('node_modules/tsx/dist/loader.mjs')).href, launcher], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  child.stderr.on('data', data => { diagnostics += data; });
  const timer = setTimeout(() => child.kill(), 20000);
  try {
    assert.equal(await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); }), 0, diagnostics);
    await waitForFile(path.join(folder, 'restarted.txt'), '--updated');
  } finally { clearTimeout(timer); child.kill(); }
});

test('portable upgrades request NSIS restart into its installed location', () => {
  const script = windowsUpdateScript(123, 'C:\\cache\\setup.exe', 'D:\\portable\\Remoter.exe', { portable: true });
  assert.match(script, /\/S --updated --force-run/);
  assert.doesNotMatch(script, /-ArgumentList '--updated'/);
});

test('Windows helper reopens the previous executable with a failure marker when setup fails', { skip: process.platform !== 'win32' }, async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'remoter-update-failure-'));
  const installer = path.join(folder, 'setup.cmd'), previous = path.join(folder, 'previous.cmd');
  await writeFile(installer, '@echo off\r\nexit /b 17\r\n');
  await writeFile(previous, '@echo off\r\n> "%~dp0reopened.txt" echo %*\r\n');
  const powershell = path.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = windowsUpdateScript(2147483647, installer, previous);
  const helper = spawn(powershell, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore' });
  assert.equal(await new Promise((resolve, reject) => { helper.once('exit', resolve); helper.once('error', reject); }), 1);
  let reopened = '';
  for (let attempt = 0; attempt < 20; attempt++) {
    try { reopened = await readFile(path.join(folder, 'reopened.txt'), 'utf8'); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.equal(reopened.trim(), '--remoter-update-failed');
});
