import { execFile } from 'node:child_process';
import type { HostPermissions } from '../src/types.js';

export type HostPermission = 'screen' | 'input';

export function permissionSettingsURL(permission: unknown): string {
  if (permission === 'screen') return 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
  if (permission === 'input') return 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
  throw new Error('Unknown macOS permission.');
}

export function parseHostPermissions(output: string): HostPermissions {
  const value = JSON.parse(output);
  if (!value || typeof value.capture !== 'boolean' || typeof value.input !== 'boolean') throw new Error('Invalid native permission response.');
  return { screen: value.capture, input: value.input };
}

export async function hostPermissions(binary: string, request?: HostPermission): Promise<HostPermissions> {
  return new Promise((resolve, reject) => {
    execFile(binary, request ? ['--request-permission', request] : ['--check-permissions'],
      { timeout: request ? 60000 : 10000, maxBuffer: 4096 }, (error, stdout) => {
        if (error) { reject(new Error('Could not check Mac permissions. Build the native host and check System Settings, then try again.')); return; }
        try { resolve(parseHostPermissions(stdout)); } catch (error) { reject(error); }
      });
  });
}

export function assertHostPermissions(permissions: HostPermissions, allowInput: boolean): void {
  if (!permissions.screen) throw new Error('Enable Screen Recording in Mac permissions before starting sharing.');
  if (allowInput && !permissions.input) throw new Error('Enable Accessibility in Mac permissions, or turn off keyboard and mouse control for view-only sharing.');
}
