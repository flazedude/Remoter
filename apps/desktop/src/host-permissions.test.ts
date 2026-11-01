import assert from 'node:assert/strict';
import test from 'node:test';
import { assertHostPermissions, parseHostPermissions, permissionSettingsURL } from '../electron/host-permissions.js';

test('Mac sharing requires screen permission and input permission only for control', () => {
  assert.throws(() => assertHostPermissions({ screen: false, input: true }, false), /Screen Recording/);
  assert.throws(() => assertHostPermissions({ screen: true, input: false }, true), /Accessibility/);
  assert.doesNotThrow(() => assertHostPermissions({ screen: true, input: false }, false));
  assert.doesNotThrow(() => assertHostPermissions({ screen: true, input: true }, true));
});

test('native permission response rejects missing, invalid, and coerced status', () => {
  assert.deepEqual(parseHostPermissions('{"capture":true,"input":false}\n'), { screen: true, input: false });
  for (const value of ['{}', 'null', '{"capture":"false","input":true}', '{"capture":true}', 'invalid']) {
    assert.throws(() => parseHostPermissions(value));
  }
});

test('renderer permission action can open only the two supported Settings panes', () => {
  assert.match(permissionSettingsURL('screen'), /Privacy_ScreenCapture$/);
  assert.match(permissionSettingsURL('input'), /Privacy_Accessibility$/);
  for (const value of [undefined, null, {}, 'https://example.com', 'camera']) assert.throws(() => permissionSettingsURL(value), /Unknown/);
});
