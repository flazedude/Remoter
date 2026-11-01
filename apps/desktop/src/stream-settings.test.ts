import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultQuality, frameDelay, qualityProfiles } from './stream-settings';

test('LAN headroom defaults only to direct local endpoints without a proxy', () => {
  const direct = { mode: 'direct' as const, proxyEnabled: false };
  for (const host of ['192.168.2.76', '10.0.0.1', '172.16.3.4', '172.31.255.255', '127.0.0.1', 'localhost', 'desktop.local', '[::1]', '[fd12::1]', '[fe80::1]']) {
    assert.equal(defaultQuality(`https://${host}:45780`, direct), 'lan', host);
  }
  for (const endpoint of ['https://172.32.0.1', 'https://100.64.0.1', 'https://example.com', 'https://192.168.2.76.example.com', 'https://[2001:db8::1]', 'invalid']) {
    assert.equal(defaultQuality(endpoint, direct), 'balanced', endpoint);
  }
  assert.equal(defaultQuality('https://192.168.2.76', { ...direct, proxyEnabled: true }), 'balanced');
  assert.equal(defaultQuality('https://192.168.2.76', { ...direct, mode: 'relay' }), 'balanced');
  assert.equal(defaultQuality('https://192.168.2.76', { ...direct, mode: 'tailscale' }), 'balanced');
});

test('frame pacing includes request time and never queues frames to catch up', () => {
  assert.equal(frameDelay(30, 10), 24);
  assert.equal(frameDelay(30, 40), 1);
  assert.equal(frameDelay(15, 20), 47);
  assert.equal(qualityProfiles.lan.fps, 30);
});
