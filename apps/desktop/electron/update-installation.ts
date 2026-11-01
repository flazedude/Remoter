import type { RemoterAPI } from '../src/types.js';

export type HostOptions = Parameters<RemoterAPI['startHost']>[0];
export interface UpdateResume {
  version: string;
  createdAt: number;
  host?: HostOptions;
  lanToken?: string;
  deviceId?: string;
}

// An update handoff is one-use and expires. Ordinary launches never resume sharing.
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
export function windowsUpdateScript(pid: number, installer: string, executable: string): string {
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  return `$ErrorActionPreference = 'Stop'
try {
  $remoterParent = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
  if ($remoterParent -and -not $remoterParent.WaitForExit(30000)) { exit 1 }
  $remoterSetup = Start-Process -FilePath ${literal(installer)} -ArgumentList '/S', '--updated', '--force-run' -WindowStyle Hidden -PassThru -Wait
  if ($remoterSetup.ExitCode -ne 0) { throw 'Update setup failed' }
} catch {
  Start-Process -FilePath ${literal(executable)} -ArgumentList '--remoter-update-failed' -WindowStyle Hidden
  exit 1
}`;
}
