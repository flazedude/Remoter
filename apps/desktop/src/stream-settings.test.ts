import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultQuality, nextFrameAt, qualityProfiles, StreamResolution } from './stream-settings';

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
  assert.equal(nextFrameAt(0, 30, 10) - 10, 24);
  assert.equal(nextFrameAt(0, 30, 40) - 40, 0);
  assert.equal(nextFrameAt(0, 15, 20) - 20, 47);
  assert.equal(qualityProfiles.lan.fps, 30);
});

test('late Windows timers do not accumulate a delay on every frame', () => {
  assert.equal(nextFrameAt(0, 30, 45), 45, 'capture already behind must request immediately');
  assert.equal(nextFrameAt(100, 30, 125), 134);
  assert.equal(nextFrameAt(0, 30, 1000), 1000, 'no burst of queued catch-up frames');
});

test('smooth LAN backs off sustained slow capture and recovers conservatively', () => {
  const resolution = new StreamResolution();
  assert.equal(resolution.width, 1920);
  resolution.sample(100);
  assert.equal(resolution.width, 1920, 'one slow frame must not lower resolution');
  for (let i = 0; i < 29; i++) resolution.sample(70);
  assert.equal(resolution.width, 1600);
  for (let i = 0; i < 60; i++) resolution.sample(70);
  assert.equal(resolution.width, 960);
  for (let i = 0; i < 300; i++) resolution.sample(70);
  assert.equal(resolution.width, 960, 'bounded minimum');
  for (let i = 0; i < 149; i++) resolution.sample(10);
  assert.equal(resolution.width, 960);
  resolution.sample(10);
  assert.equal(resolution.width, 1280);
  for (let i = 0; i < 600; i++) resolution.sample(10);
  assert.equal(resolution.width, 1920, 'bounded maximum');
  assert.equal(qualityProfiles.original.width, 3840, 'full-resolution quality stays selectable');
});
