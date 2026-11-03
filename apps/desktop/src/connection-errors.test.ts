import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionError } from '../electron/connection-errors.js';

test('Mac unreachable errors explain Local Network access without asserting the cause', () => {
  for (const code of ['EHOSTUNREACH', 'ENETUNREACH', 'EACCES', 'EPERM']) {
    const original = Object.assign(new Error(`connect ${code} 192.168.2.59:45780`), { code });
    const result = connectionError(original, 'darwin') as Error;
    assert.match(result.message, /Local Network/);
    assert.match(result.message, /firewall/);
    assert.equal(result.cause, original);
    assert.equal(connectionError(original, 'win32'), original);
  }
});

test('certificate, authentication, proxy, and non-network errors keep their meaning', () => {
  for (const message of ['The host certificate does not match the invitation.', 'authentication required', 'SOCKS5 connection failed. Direct fallback is disabled.', 'Invalid request.']) {
    const original = new Error(message);
    assert.equal(connectionError(original, 'darwin'), original);
  }
  assert.equal(connectionError('failure', 'darwin'), 'failure');
});
