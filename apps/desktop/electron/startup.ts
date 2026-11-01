import type { HostOptions } from './update-installation.js';

export interface StartupSharing { host: HostOptions; lanToken?: string }
export interface StartupStore { launchOnBoot?: boolean; startupSharing?: StartupSharing }

export async function setStartup(store: StartupStore, enabled: boolean, sharing: StartupSharing | undefined, steps: {
  register(enabled: boolean): void;
  persist(): Promise<void>;
}): Promise<void> {
  if (enabled && !sharing) throw new Error('Start sharing first to save this PC’s startup permissions.');
  const previous = { launchOnBoot: store.launchOnBoot, startupSharing: store.startupSharing };
  steps.register(enabled);
  store.launchOnBoot = enabled;
  store.startupSharing = enabled ? sharing : undefined;
  try { await steps.persist(); }
  catch (error) {
    Object.assign(store, previous);
    steps.register(previous.launchOnBoot === true);
    throw error;
  }
}

export function startupSharing(store: StartupStore, args: string[]): StartupSharing | undefined {
  return store.launchOnBoot && args.includes('--remoter-startup') ? store.startupSharing : undefined;
}
