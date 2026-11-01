import test from 'node:test';
import assert from 'node:assert/strict';
import { clipboardTransfer } from '../electron/clipboard-sync.js';

test('paste preserves a fresh host copy over an unchanged local invitation', () => {
  const local = 'old-invitation-' + 'abc123'.repeat(1000);
  assert.equal(clipboardTransfer('paste', local, 'new host copy', { local, remote: 'old host copy' }), 'receive');
});

test('paste sends local text copied before enabling sync as well as later copies', () => {
  assert.equal(clipboardTransfer('both', 'local copy', 'host copy'), undefined);
  assert.equal(clipboardTransfer('paste', 'local copy', 'host copy'), 'send');
  assert.equal(clipboardTransfer('paste', 'local copy', 'host copy', { local: 'local copy', remote: 'host copy' }), 'send');
  assert.equal(clipboardTransfer('paste', 'new local copy', 'host copy', { local: 'old local copy', remote: 'host copy' }), 'send');
});

test('polling reconciles changed text and explicit transfer buttons keep their direction', () => {
  const previous = { local: 'local copy', remote: 'host copy' };
  assert.equal(clipboardTransfer('both', 'new local copy', 'host copy', previous), 'send');
  assert.equal(clipboardTransfer('both', 'local copy', 'new host copy', previous), 'receive');
  assert.equal(clipboardTransfer('both', 'local copy', 'host copy', previous), undefined);
  assert.equal(clipboardTransfer('send', 'local copy', 'new host copy', previous), 'send');
  assert.equal(clipboardTransfer('receive', 'new local copy', 'host copy', previous), 'receive');
  assert.equal(clipboardTransfer('paste', 'same', 'same', previous), undefined);
});

test('paste honors clipboard clears and keeps local-copy priority for simultaneous changes', () => {
  const previous = { local: 'local copy', remote: 'host copy' };
  assert.equal(clipboardTransfer('paste', '', 'host copy', previous), 'send');
  assert.equal(clipboardTransfer('paste', 'local copy', '', previous), 'receive');
  assert.equal(clipboardTransfer('paste', 'new local copy', 'new host copy', previous), 'send');
});

test('an explicit remote Copy or Cut receives host text even when the local clipboard also changed', () => {
  assert.equal(clipboardTransfer('copy', 'older local copy', 'fresh remote copy', { local: 'old local', remote: 'old host' }), 'receive');
  assert.equal(clipboardTransfer('copy', 'old local', '', { local: 'old local', remote: 'old host' }), 'receive');
});
