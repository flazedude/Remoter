import type { NetworkSettings } from './types';

/** A saved secret belongs to its original endpoint and account. */
export function updateNetworkField<K extends keyof NetworkSettings>(settings: NetworkSettings, key: K, value: NetworkSettings[K]): NetworkSettings {
  const next = { ...settings, [key]: value };
  if (settings[key] === value) return next;
  if (key === 'proxyHost' || key === 'proxyPort' || key === 'proxyUsername') {
    next.proxyPassword = '';
    next.proxyPasswordSaved = false;
  }
  if (key === 'relayUrl' || key === 'relayDeviceId') {
    next.relayToken = '';
    next.relayTokenSaved = false;
  }
  if (key === 'mode' && value === 'tailscale') next.proxyEnabled = false;
  return next;
}
