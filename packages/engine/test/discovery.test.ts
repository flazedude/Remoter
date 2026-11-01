import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseLANHost } from '../src/discovery.js';

const certificate = await readFile(new URL('./fixtures/host-cert.fixture', import.meta.url), 'utf8');
test('discovery accepts correlated local identities and rejects redirects, stale replies and malformed hosts', () => {
  const nonce = 'a'.repeat(32);
  const host = { service: 'remoter-host-v1', nonce, name: 'Nearby PC', endpoint: 'https://192.168.1.5:45780', certificate, easy: true };
  const parse = (changes: Record<string, unknown> = {}, source = '192.168.1.5') => parseLANHost(Buffer.from(JSON.stringify({ ...host, ...changes })), nonce, source);
  assert.equal(parse()?.name, 'Nearby PC');
  assert.equal(parse()?.easy, true);
  assert.equal(parse({ easy: false })?.easy, false);
  for (const changes of [{ nonce: 'b'.repeat(32) }, { certificate: 'invalid' }, { name: '<bad>\nname' }, { endpoint: 'https://elsewhere.example' }, { endpoint: 'https://192.168.1.6' }, { easy: 'yes' }, { endpoint: 'http://192.168.1.5' }]) assert.equal(parse(changes), undefined);
  assert.equal(parseLANHost(Buffer.alloc(24001), nonce, '192.168.1.5'), undefined);
});
