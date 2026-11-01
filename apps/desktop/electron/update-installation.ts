import type { RemoterAPI } from '../src/types.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type HostOptions = Parameters<RemoterAPI['startHost']>[0];
export interface UpdateResume {
  version: string;
  createdAt: number;
  host?: HostOptions;
  lanToken?: string;
  deviceId?: string;
}

// An update handoff is one-use and expires. Boot sharing is a separate opt-in.
export function updateResume(value: UpdateResume | undefined, version: string, args: string[], now = Date.now()): UpdateResume | undefined {
  if (!value || now < value.createdAt || now - value.createdAt > 60 * 60 * 1000) return;
  if (args.includes('--remoter-update-failed') || (args.includes('--updated') && value.version === version)) return value;
}

export class UpdateInstallation {
  active = false;
  constructor(private steps: {
    installer(): Promise<string>;
    settleStarts(): Promise<void>;
    saveResume(): Promise<void>;
    clearResume(): Promise<void>;
    launch(installer: string): Promise<void>;
    quit(): void;
  }) {}

  async install(): Promise<void> {
    if (this.active) throw new Error('The update installer is already starting.');
    this.active = true;
    try {
      const installer = await this.steps.installer();
      await this.steps.settleStarts();
      await this.steps.saveResume();
      await this.steps.launch(installer);
    } catch (error) {
      try { await this.steps.clearResume(); } finally { this.active = false; }
      throw error;
    }
    this.steps.quit();
  }
}

// Wait for this exact process to exit so setup never races session/input cleanup.
// Paths are PowerShell single-quoted literals, not shell commands supplied by a feed.
export function windowsUpdateScript(pid: number, installer: string, executable: string, options: { logFile?: string; portable?: boolean; readyFile?: string } = {}): string {
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  // The helper owns the installed app's restart. NSIS's shortcut-based restart
  // can silently fail; portable installs still let NSIS locate the new app.
  const arguments_ = options.portable ? '/S --updated --force-run' : `/S --updated /D=${path.win32.dirname(executable)}`;
  return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$remoterExited = $false
$remoterReady = $false
function Write-UpdateLog([string]$message) {
  ${options.logFile ? `try { [IO.File]::AppendAllText(${literal(options.logFile)}, [DateTimeOffset]::UtcNow.ToString('o') + ' ' + $message + [Environment]::NewLine) } catch {}` : '# No log requested.'}
}
try {
  if (!(Test-Path -LiteralPath ${literal(installer)} -PathType Leaf)) { throw 'The downloaded installer is missing.' }
  $remoterParent = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
  Write-UpdateLog 'Helper ready; waiting for Remoter to exit.'
  ${options.readyFile ? `[IO.File]::WriteAllText(${literal(options.readyFile)}, 'REMOTER_UPDATE_READY')` : "[Console]::Out.WriteLine('REMOTER_UPDATE_READY')\n  [Console]::Out.Flush()"}
  $remoterReady = $true
  if ($remoterParent -and -not $remoterParent.WaitForExit(30000)) { throw 'Remoter did not exit within 30 seconds.' }
  $remoterExited = $true
  Write-UpdateLog 'Starting the downloaded installer.'
  $remoterSetup = Start-Process -FilePath ${literal(installer)} -ArgumentList ${literal(arguments_)} -WindowStyle Hidden -PassThru -Wait
  if ($remoterSetup.ExitCode -ne 0) { throw ('Update setup failed with exit code ' + $remoterSetup.ExitCode) }
  Write-UpdateLog 'Setup completed successfully.'
  ${options.portable ? '# NSIS starts the newly installed app for portable upgrades.' : `Start-Process -FilePath ${literal(executable)} -ArgumentList '--updated' -WindowStyle Hidden
  Write-UpdateLog 'Restarted Remoter.'`}
} catch {
  Write-UpdateLog ('Update failed: ' + $_.Exception.Message)
  if (!$remoterReady) { ${options.readyFile ? `[IO.File]::WriteAllText(${literal(options.readyFile)}, 'ERROR: ' + $_.Exception.Message)` : '[Console]::Error.WriteLine($_.Exception.Message)'} }
  if ($remoterExited) { Start-Process -FilePath ${literal(executable)} -ArgumentList '--remoter-update-failed' -WindowStyle Hidden }
  exit 1
}`;
}

export async function launchWindowsUpdate(pid: number, installer: string, executable: string, options: { logFile?: string; portable?: boolean; powershell?: string } = {}): Promise<void> {
  const helperPath = path.join(path.dirname(installer), `.remoter-update-${randomUUID()}.ps1`);
  const readyFile = `${helperPath}.ready`;
  // Windows PowerShell 5.1 needs the BOM to read non-ASCII Windows paths.
  await writeFile(helperPath, '\uFEFF' + windowsUpdateScript(pid, installer, executable, { ...options, readyFile }), { mode: 0o600 });
  const powershell = options.powershell ?? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  // Start-Process gives PowerShell its own hidden console. DETACHED_PROCESS
  // makes Windows PowerShell silently skip commands; sharing the app's console
  // lets Windows terminate the helper when that app exits.
  const bootstrap = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $helper = Start-Process -FilePath ${literal(powershell)} -ArgumentList ${literal(`-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${helperPath}"`)} -WindowStyle Hidden -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds(12)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-Path -LiteralPath ${literal(readyFile)}) {
      $status = [IO.File]::ReadAllText(${literal(readyFile)})
      if ($status -eq 'REMOTER_UPDATE_READY') { [Console]::Out.WriteLine($status); exit 0 }
      if ($status.StartsWith('ERROR: ')) { throw $status.Substring(7) }
    }
    if ($helper.HasExited) { throw 'The update helper stopped before it was ready.' }
    Start-Sleep -Milliseconds 100
  }
  throw 'The update helper did not become ready.'
} catch {
  if ($helper -and !$helper.HasExited) { Stop-Process -Id $helper.Id -ErrorAction SilentlyContinue }
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}`;
  const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(bootstrap, 'utf16le').toString('base64')], {
    cwd: path.dirname(installer), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  try { await new Promise<void>((resolve, reject) => {
    let output = '', diagnostics = '';
    const cleanup = () => { clearTimeout(timer); child.removeListener('error', failed); child.removeListener('exit', exited); child.stdout.removeListener('data', data); child.stderr.removeListener('data', stderr); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const exited = () => failed(new Error(diagnostics.trim() || 'The update helper stopped before it was ready. Remoter is still running; try again.'));
    const stderr = (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-4096); };
    const data = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-4096);
      if (output.includes('REMOTER_UPDATE_READY\n') || output.includes('REMOTER_UPDATE_READY\r\n')) { cleanup(); resolve(); }
    };
    const timer = setTimeout(() => { child.kill(); failed(new Error('The update helper did not become ready. Remoter is still running; try again.')); }, 15000);
    child.once('error', failed); child.once('exit', exited); child.stdout.on('data', data); child.stderr.on('data', stderr);
  }); } finally {
    child.stdout.destroy(); child.stderr.destroy(); child.unref();
    // Cleanup cannot invalidate a helper that is already waiting to install.
    await Promise.allSettled([rm(helperPath, { force: true }), rm(readyFile, { force: true })]);
  }
}
