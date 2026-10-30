import assert from 'node:assert/strict';
import test from 'node:test';
import { updateNetworkField } from './network-settings';
import type { NetworkSettings } from './types';

const settings: NetworkSettings = {
  mode: 'direct', proxyEnabled: true, proxyHost: 'proxy.example.com', proxyPort: 1080,
  proxyUsername: 'alice', proxyPassword: 'edited-secret', proxyPasswordSaved: true,
  relayUrl: 'wss://relay.example.com', relayDeviceId: 'machine-a', relayToken: 'edited-token', relayTokenSaved: true,
};

test('changing proxy endpoint or account never carries its old password forward', () => {
  for (const next of [updateNetworkField(settings, 'proxyHost', 'other.example.com'), updateNetworkField(settings, 'proxyPort', 1081), updateNetworkField(settings, 'proxyUsername', 'bob')]) {
    assert.equal(next.proxyPassword, '');
    assert.equal(next.proxyPasswordSaved, false);
  }
  assert.equal(settings.proxyPassword, 'edited-secret');
});

test('changing relay identity drops the saved and edited relay token', () => {
  for (const next of [updateNetworkField(settings, 'relayUrl', 'wss://other.example.com'), updateNetworkField(settings, 'relayDeviceId', 'machine-b')]) {
    assert.equal(next.relayToken, '');
    assert.equal(next.relayTokenSaved, false);
  }
});

test('unrelated edits preserve credentials and Tailscale disables the app proxy', () => {
  const sameHost = updateNetworkField(settings, 'proxyHost', settings.proxyHost);
  assert.equal(sameHost.proxyPasswordSaved, true);
  assert.equal(updateNetworkField(settings, 'mode', 'relay').proxyPasswordSaved, true);
  assert.equal(updateNetworkField(settings, 'mode', 'tailscale').proxyEnabled, false);
});
