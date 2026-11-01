import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setStartup, startupSharing, type StartupStore } from '../electron/startup';

const sharing = { host: { listen: '192.168.2.76:45780', advertise: '', allowInput: false, discover: true, allowClipboard: false, allowAudio: true }, lanToken: 'test-lan-token' };

test('startup is opt-in and restores exact permissions only on a startup launch', async () => {
  const store: StartupStore = {};
  const registrations: boolean[] = [];
  let persisted = 0;
  const steps = { register: (enabled: boolean) => { registrations.push(enabled); }, persist: async () => { persisted++; } };
  await assert.rejects(setStartup(store, true, undefined, steps), /Start sharing first/);
  assert.deepEqual(registrations, []);
  await setStartup(store, true, sharing, steps);
  assert.equal(persisted, 1);
  assert.deepEqual(startupSharing(store, ['--remoter-startup']), sharing);
  assert.equal(startupSharing(store, []), undefined);
  delete store.startupSharing; // Explicit Stop sharing suppresses automatic sharing.
  assert.equal(startupSharing(store, ['--remoter-startup']), undefined);
  await setStartup(store, false, undefined, steps);
  assert.equal(store.launchOnBoot, false);
  assert.equal(startupSharing(store, ['--remoter-startup']), undefined);
  assert.deepEqual(registrations, [true, false]);
});

test('failed storage rolls the Windows startup entry back', async () => {
  const store: StartupStore = {};
  const registrations: boolean[] = [];
  await assert.rejects(setStartup(store, true, sharing, {
    register: enabled => { registrations.push(enabled); }, persist: async () => { throw new Error('encrypted storage unavailable'); }
  }), /encrypted storage unavailable/);
  assert.equal(store.launchOnBoot, undefined);
  assert.equal(store.startupSharing, undefined);
  assert.deepEqual(registrations, [true, false]);
});

test('failed Windows registration cannot enable automatic sharing', async () => {
  const store: StartupStore = {};
  await assert.rejects(setStartup(store, true, sharing, {
    register: () => { throw new Error('startup denied'); }, persist: async () => { assert.fail('must not persist'); }
  }), /startup denied/);
  assert.equal(store.launchOnBoot, undefined);
});
