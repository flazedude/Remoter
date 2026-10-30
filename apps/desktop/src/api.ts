import type { AppState, NetworkSettings, RemoterAPI } from './types';

export const defaultNetwork: NetworkSettings = {
  mode: 'direct', proxyEnabled: false, proxyHost: '', proxyPort: 1080,
  proxyUsername: '', proxyPassword: '', relayUrl: '', relayDeviceId: '', relayToken: '',
};

export const emptyState: AppState = {
  devices: [], network: defaultNetwork, activity: [], hostRunning: false,
};

export const isBrowserPreview = !window.remoter;
let previewState = structuredClone(emptyState);
const unavailable = async (): Promise<never> => {
  throw new Error('Open the Remoter desktop app to use this feature. This browser is a UI preview.');
};

// The browser preview never invents devices, sessions, or host capabilities.
const previewAPI: RemoterAPI = {
  getState: async () => structuredClone(previewState),
  saveNetwork: async (network) => {
    previewState = { ...previewState, network: { ...network, proxyPassword: '', relayToken: '' } };
    return structuredClone(previewState);
  },
  addDevice: unavailable, removeDevice: unavailable, testDevice: unavailable,
  connect: unavailable, frame: unavailable, input: unavailable, disconnect: unavailable,
  startHost: unavailable, stopHost: unavailable, copy: unavailable,
};

export const api: RemoterAPI = window.remoter ?? previewAPI;

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}
